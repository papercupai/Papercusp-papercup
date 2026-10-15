/** Candidate tsserver plugin for WI-41095. Production readiness does not use it.
 * The population must be declared independently before the request, including
 * libraries/config files; a loaded-project census is never the declaration. */
import { isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const SEMANTIC_COMPLETION_COMMAND = 'papercusp/semanticReferences';
export const SEMANTIC_COMPLETION_SCHEMA = 'papercusp-semantic-completion-v1';
export const SEMANTIC_COMPLETION_TYPESCRIPT_VERSION = '6.0.3';

export interface SemanticProjectPopulation {
  projectName: string;
  anchorFile: string;
  files: string[];
}
export interface SemanticCompletionRequest {
  file: string;
  line: number;
  offset: number;
  population: SemanticProjectPopulation[];
}
/** Internal, independently declared package; never inferred from a loaded plugin. */
export interface SemanticCompletionPluginDeclaration {
  name: string;
  location: string;
  files: Readonly<Record<string, string>>;
}
export interface SemanticCompletionContext {
  population: SemanticProjectPopulation[];
  plugin: SemanticCompletionPluginDeclaration;
}
/** Reuse the maintained wrapper's plugin/probe-path initialization contract. */
export function semanticCompletionPlugins(plugin: SemanticCompletionPluginDeclaration): { name: string; location: string }[] {
  if (!plugin || !/^(?:@[a-z0-9_-]+\/)?[a-z0-9_-]+$/.test(plugin.name) || !isAbsolute(plugin.location))
    refuse('invalid-plugin-declaration');
  const packageRoot = join(plugin.location, 'node_modules', plugin.name);
  const manifest = join(packageRoot, 'package.json');
  const metadata = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; main?: string };
  if (metadata.name !== plugin.name || typeof metadata.main !== 'string') refuse('invalid-plugin-package');
  const entry = resolve(packageRoot, metadata.main);
  if (!entry.startsWith(packageRoot + '/') || !entry.endsWith('.cjs')) refuse('invalid-plugin-entry');
  for (const file of [manifest, entry]) {
    if (!plugin.files?.[file] || createHash('sha256').update(readFileSync(file)).digest('hex') !== plugin.files[file])
      refuse('plugin-byte-mismatch');
  }
  return [{ name: plugin.name, location: plugin.location }];
}
export interface NativeReference {
  file: string;
  start: { line: number; offset: number };
  end: { line: number; offset: number };
}
export interface SemanticCompletionBody {
  schemaVersion: typeof SEMANTIC_COMPLETION_SCHEMA;
  typescriptVersion: typeof SEMANTIC_COMPLETION_TYPESCRIPT_VERSION;
  population: SemanticProjectPopulation[];
  refs: NativeReference[];
}
interface NativeProject {
  getProjectName(): string;
  getFileNames(excludeExternalLibraries: boolean, excludeConfigFiles: boolean): string[];
  isOrphan(): boolean;
  languageServiceEnabled: boolean;
}
/** Private-method bridge is deliberately version-bound and checked at registration. */
export interface NativeSemanticSession {
  cancellationToken: { isCancellationRequested(): boolean };
  projectService: { forEachProject(callback: (project: NativeProject) => void): void };
  getCanonicalFileName(file: string): string;
  getProjectInfoWorker(file: string, project: string, names: boolean,
    defaultInfo: boolean, excludeConfigs: boolean): unknown;
  getReferences(args: { file: string; line: number; offset: number }, simplified: boolean): unknown;
  addProtocolHandler(command: string, handler: (request: { arguments?: unknown }) =>
    { response: SemanticCompletionBody; responseRequired: true }): void;
}

function refuse(reason: string): never {
  throw new Error(`semantic completion refused: ${reason}`);
}
function cancellationCheck(token: { isCancellationRequested(): boolean }): void {
  if (token.isCancellationRequested()) refuse('cancelled');
}
function exactPopulation(population: SemanticProjectPopulation[], canonical: (file: string) => string): SemanticProjectPopulation[] {
  if (!Array.isArray(population) || !population.length) refuse('undeclared-population');
  const names = new Set<string>();
  return population.map(project => {
    if (!project || typeof project.projectName !== 'string' || !isAbsolute(project.projectName) ||
        typeof project.anchorFile !== 'string' || !isAbsolute(project.anchorFile) ||
        !Array.isArray(project.files) || !project.files.length ||
        project.files.some(file => typeof file !== 'string' || !isAbsolute(file))) refuse('invalid-population');
    const projectName = canonical(project.projectName);
    const files = project.files.map(canonical).sort();
    if (names.has(projectName) || new Set(files).size !== files.length) refuse('duplicate-population');
    names.add(projectName);
    const anchorFile = canonical(project.anchorFile);
    if (!files.includes(anchorFile)) refuse('undeclared-anchor');
    return { projectName, anchorFile, files };
  }).sort((a, b) => a.projectName.localeCompare(b.projectName));
}

/** Freeze caller-owned arrays before the RPC; a later mutation cannot author its proof. */
export function snapshotSemanticCompletionRequest(request: SemanticCompletionRequest): SemanticCompletionRequest {
  if (!request || typeof request.file !== 'string' || !isAbsolute(request.file) ||
      !Number.isSafeInteger(request.line) || request.line < 1 ||
      !Number.isSafeInteger(request.offset) || request.offset < 1) refuse('invalid-query');
  const population = exactPopulation(request.population, file => file);
  if (!population.some(project => project.files.includes(request.file))) refuse('undeclared-query-file');
  return { ...request, population };
}

function observedPopulation(session: NativeSemanticSession, declared: SemanticProjectPopulation[]): SemanticProjectPopulation[] {
  const observed: SemanticProjectPopulation[] = [];
  session.projectService.forEachProject(project => {
    cancellationCheck(session.cancellationToken);
    if (!project.languageServiceEnabled) refuse('disabled-project');
    if (project.isOrphan()) refuse('orphan-project');
    const projectName = session.getCanonicalFileName(project.getProjectName());
    const expected = declared.find(entry => entry.projectName === projectName);
    if (!expected) refuse('extra-project');
    observed.push({ projectName, anchorFile: expected.anchorFile,
      files: project.getFileNames(false, false).map(file => session.getCanonicalFileName(file)).sort() });
  });
  observed.sort((a, b) => a.projectName.localeCompare(b.projectName));
  if (JSON.stringify(observed) !== JSON.stringify(declared)) {
    // Diagnose the refusal without learning a replacement declaration from the
    // subject. Counts remain exact; samples are bounded for large project graphs.
    const differences = declared.map(expected => {
      const actual = observed.find(project => project.projectName === expected.projectName);
      const expectedFiles = new Set(expected.files); const actualFiles = new Set(actual?.files ?? []);
      const missing = expected.files.filter(file => !actualFiles.has(file));
      const extra = (actual?.files ?? []).filter(file => !expectedFiles.has(file));
      return { projectName: expected.projectName.slice(0, 512), missingProject: !actual,
        missingCount: missing.length, extraCount: extra.length,
        missingFiles: missing.slice(0, 8).map(file => file.slice(0, 512)),
        extraFiles: extra.slice(0, 8).map(file => file.slice(0, 512)) };
    }).filter(project => project.missingProject || project.missingCount || project.extraCount);
    refuse(`project-or-file-population-mismatch:${JSON.stringify({ projectCount: differences.length,
      projects: differences.slice(0, 8) })}`);
  }
  return observed;
}

export function registerNativeSemanticCompletion(session: NativeSemanticSession, version: string): void {
  if (version !== SEMANTIC_COMPLETION_TYPESCRIPT_VERSION ||
      typeof session?.addProtocolHandler !== 'function' ||
      typeof session?.getProjectInfoWorker !== 'function' ||
      typeof session?.getReferences !== 'function' ||
      typeof session?.getCanonicalFileName !== 'function' ||
      typeof session?.projectService?.forEachProject !== 'function' ||
      typeof session?.cancellationToken?.isCancellationRequested !== 'function') refuse('unsupported-native-bridge');
  session.addProtocolHandler(SEMANTIC_COMPLETION_COMMAND, request => {
    cancellationCheck(session.cancellationToken);
    const args = request.arguments as SemanticCompletionRequest | undefined;
    if (!args || typeof args.file !== 'string' || !isAbsolute(args.file) ||
        !Number.isSafeInteger(args.line) || args.line < 1 ||
        !Number.isSafeInteger(args.offset) || args.offset < 1) refuse('invalid-query');
    const declared = exactPopulation(args.population, file => session.getCanonicalFileName(file));
    if (!declared.some(project => project.files.includes(session.getCanonicalFileName(args.file)))) refuse('undeclared-query-file');
    const checkPopulation = () => {
      // Load/update every DECLARED graph, including projects not yet loaded.
      // No observed census is allowed to manufacture a missing declaration.
      for (const project of declared) {
        cancellationCheck(session.cancellationToken);
        session.getProjectInfoWorker(project.anchorFile, project.projectName, true, false, false);
        cancellationCheck(session.cancellationToken);
      }
      return observedPopulation(session, declared);
    };
    checkPopulation();
    cancellationCheck(session.cancellationToken);
    const result = session.getReferences({ file: args.file, line: args.line, offset: args.offset }, true) as
      { refs?: NativeReference[]; canceled?: boolean } | undefined;
    // Native traversal can break on cancellation and RETURN partial refs.
    cancellationCheck(session.cancellationToken);
    if (!result || result.canceled || !Array.isArray(result.refs)) refuse('incomplete-native-result');
    const population = checkPopulation();
    cancellationCheck(session.cancellationToken);
    return { responseRequired: true, response: { schemaVersion: SEMANTIC_COMPLETION_SCHEMA,
      typescriptVersion: SEMANTIC_COMPLETION_TYPESCRIPT_VERSION, population, refs: result.refs } };
  });
}

/** The wrapper's custom-command route drops its outer cancellation token.
 * Refuse before/after the RPC independently, including success/body.canceled. */
export async function requestSemanticCompletion(
  request: SemanticCompletionRequest,
  token: { readonly isCancellationRequested: boolean },
  send: (command: string, args: SemanticCompletionRequest) => Promise<unknown>,
): Promise<SemanticCompletionBody> {
  if (token.isCancellationRequested) refuse('outer-cancelled');
  const frozen = snapshotSemanticCompletionRequest(request);
  const declared = exactPopulation(frozen.population, file => file);
  const raw = await send(SEMANTIC_COMPLETION_COMMAND, frozen) as
    { type?: string; success?: boolean; body?: SemanticCompletionBody & { canceled?: boolean } } | undefined;
  if (token.isCancellationRequested) refuse('outer-cancelled');
  if (raw?.type !== 'response' || raw.success !== true || raw.body?.canceled ||
      raw.body?.schemaVersion !== SEMANTIC_COMPLETION_SCHEMA ||
      raw.body.typescriptVersion !== SEMANTIC_COMPLETION_TYPESCRIPT_VERSION || !Array.isArray(raw.body.refs)) refuse('incomplete-native-response');
  const observed = exactPopulation(raw.body.population, file => file);
  if (JSON.stringify(declared) !== JSON.stringify(observed)) refuse('response-population-mismatch');
  const files = new Set(declared.flatMap(project => project.files));
  const position = (value: NativeReference['start']) => value && Number.isSafeInteger(value.line) && value.line > 0 &&
    Number.isSafeInteger(value.offset) && value.offset > 0;
  if (raw.body.refs.some(ref => !ref || !files.has(ref.file) || !position(ref.start) || !position(ref.end) ||
      ref.end.line < ref.start.line || (ref.end.line === ref.start.line && ref.end.offset < ref.start.offset)))
    refuse('invalid-native-reference');
  return raw.body;
}

// TypeScript creates a plugin factory for each project, while protocol handlers
// belong to the shared session. Keep successful registration across factories.
const installedSessions = new WeakSet<NativeSemanticSession>();

/** Build as CommonJS for the maintained tsserver plugin/probe-path mechanism. */
export default function semanticCompletionPlugin(modules: { typescript: { version: string } }): {
  create(info: { session?: NativeSemanticSession; languageService: unknown }): unknown;
} {
  return { create(info) {
    if (!info.session) refuse('missing-native-session');
    if (!installedSessions.has(info.session)) {
      registerNativeSemanticCompletion(info.session, modules.typescript.version);
      installedSessions.add(info.session);
    }
    return info.languageService;
  } };
}

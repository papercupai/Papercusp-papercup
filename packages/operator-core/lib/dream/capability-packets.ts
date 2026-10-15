import { open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PgL2Store } from '../cache/pg-l2-store';
import { lspFacade } from '../code-intelligence/lsp-facade';
import { LSP_VENDOR_DIR } from '../code-intelligence/lsp-adapter';
import { gitnexusFacade } from '../code-intelligence/gitnexus-facade';
import { firstPartyCallersOffthread } from '../code-intelligence/first-party-callers-offthread';
import { packerFacade, type PackerResult } from '../code-intelligence/packer-facade';
import type { CodeIntelAnswer } from '../code-intelligence/contracts';
import {
  CapabilityPacketSchema,
  CapabilityPacketGraphSchema,
  CapabilityPathSchema,
  CapabilityUnitSchema,
  capabilityHash,
  capabilityUnitHash,
  type CapabilityPacket,
  type CapabilitySource,
  type CapabilityUnit,
  type CapabilityPacketGraph,
} from './capability-contracts';

export const CAPABILITY_EXTRACTION_RECIPE = 'scanned-anchors-and-cited-context-v4';
export const CAPABILITY_SUMMARY_PROMPT = 'manifest-facets-v1';
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const CACHE_TTL_MS = 24 * 60 * 60_000;

export interface CapabilityPacketDeps {
  cache: {
    get: (workspaceId: string, key: string) => Promise<{ value: unknown } | undefined>;
    set: (
      workspaceId: string,
      key: string,
      value: CapabilityPacket,
      opts: { hardTtlMs: number; tags: string[] },
    ) => Promise<void>;
  };
  pack: (root: string, paths: string[]) => Promise<PackerResult>;
  lookup: (root: string, file: string, line1: number, character: number) => Promise<CodeIntelAnswer>;
  resolveSymbol: (root: string, file: string, line1: number, character: number) => Promise<CodeIntelAnswer>;
  neighbors: (direction: 'callers' | 'callees', repositoryId: string, name: string) => Promise<CodeIntelAnswer>;
  graph?: (root: string, repositoryId: string, name: string, file: string, paths: string[]) => Promise<CodeIntelAnswer>;
  readArtifact: (path: string) => Promise<string>;
  now: () => number;
}

async function readBounded(file: string, maxBytes: number): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Evidence is not a regular file');
    if (info.size > maxBytes) throw new Error('Evidence exceeds the source byte budget');
    const buffer = Buffer.alloc(info.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > info.size) throw new Error('Evidence grew during its bounded read');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, total));
  } finally {
    await handle.close();
  }
}

async function withinRoot(root: string, path: string): Promise<string> {
  const file = await realpath(resolve(root, path));
  const rel = relative(root, file);
  if (!rel || rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel))
    throw new Error('Evidence escapes repository scope');
  return file;
}

/** Same canonical scope and source byte budget for independently retrieved code priors. */
export async function readCapabilitySource(rootPath: string, path: string): Promise<string> {
  const root = await realpath(rootPath);
  return readBounded(await withinRoot(root, path), MAX_SOURCE_BYTES);
}

/** Compiler context over the exact cited files, under the packet's fixed deadline. */
export const queryCapabilityGraph: NonNullable<CapabilityPacketDeps['graph']> =
  (root, repositoryId, name, filePath, paths) => firstPartyCallersOffthread({ root, repositoryId,
    vendorDir: LSP_VENDOR_DIR, name, filePath, paths, op: 'context', contextScope: 'cited-files', limit: 12 }, { budgetMs: 6_000 });

const defaultDeps: CapabilityPacketDeps = {
  cache: new PgL2Store(),
  pack: (rootPath, include) => packerFacade('pack', { rootPath, include, format: 'xml', compress: false }),
  lookup: (rootPath, file, line1, character) =>
    lspFacade('references', { rootPath, file, line1, character, limit: 12 }),
  resolveSymbol: (rootPath, file, line1, character) =>
    lspFacade('symbol', { rootPath, file, line1, character, limit: 4 }),
  neighbors: (direction, repositoryId, name) => gitnexusFacade(direction, { repo: repositoryId, name, limit: 12 }),
  graph: queryCapabilityGraph,
  readArtifact: async (path) => {
    const root = await realpath(join(homedir(), '.papercusp', 'scratch', 'packs'));
    const artifact = await withinRoot(root, path);
    return readBounded(artifact, MAX_ARTIFACT_BYTES);
  },
  now: Date.now,
};

export interface BuildCapabilityPacketInput {
  rootPath: string;
  scope: CapabilityPacket['scope'];
  unit: CapabilityUnit;
  manifestRevision: string;
  maxPacketChars?: number;
  excerptLines?: number;
  recipeVersion?: string;
  promptVersion?: string;
}

export type CapabilityPacketBuild =
  | { status: 'ready'; packet: CapabilityPacket; cacheHit: boolean; costUsd: number; durationMs: number }
  | { status: 'unavailable'; reason: string; costUsd: number; durationMs: number; graphMismatch?: CapabilityGraphMismatch };

/** Bounded graph projections, not compiler bodies or a replay of the failed query. */
export interface CapabilityGraphMismatch {
  unitId: string;
  sourceFingerprint: string;
  expectedHash: string;
  actualHash: string;
  differingFields: Array<keyof CapabilityPacketGraph>;
  expected: CapabilityPacketGraph;
  actual: CapabilityPacketGraph;
}

async function readUnitFiles(root: string, unit: CapabilityUnit): Promise<Map<string, string>> {
  const paths = [...new Set(unit.evidence.map((ref) => ref.path))];
  return new Map(
    await Promise.all(
      paths.map(async (path) => [path, await readBounded(await withinRoot(root, path), MAX_SOURCE_BYTES)] as const),
    ),
  );
}

function extract(unit: CapabilityUnit, files: Map<string, string>, excerptLines: number): CapabilitySource[] {
  return unit.evidence.map((ref) => {
    const contents = files.get(ref.path)!;
    const offset = contents.indexOf(ref.anchor);
    if (offset < 0 || contents.indexOf(ref.anchor, offset + 1) >= 0)
      throw new Error('Missing or ambiguous evidence anchor: ' + ref.id);
    const lines = contents.split('\n');
    const anchorLine = contents.slice(0, offset).split('\n').length - 1;
    const start = Math.max(0, anchorLine - 3);
    const end = Math.min(lines.length, start + excerptLines);
    const excerpt = lines.slice(start, end).join('\n');
    return {
      ...ref,
      sourceHash: capabilityHash(contents),
      excerptHash: capabilityHash(excerpt),
      startLine: start + 1,
      endLine: end,
      excerpt,
    };
  });
}

export async function verifyCapabilityPacket(
  value: unknown,
  input: BuildCapabilityPacketInput,
  deps: Pick<CapabilityPacketDeps, 'readArtifact' | 'graph'> = defaultDeps,
): Promise<{ fresh: true } | { fresh: false; reason: string; graphMismatch?: CapabilityGraphMismatch }> {
  const parsed = CapabilityPacketSchema.safeParse(value);
  if (!parsed.success) return { fresh: false, reason: 'Invalid packet evidence contract' };
  const expectedUnit = CapabilityUnitSchema.safeParse(input.unit);
  if (!expectedUnit.success) return { fresh: false, reason: 'Invalid current capability contract' };
  const packet = parsed.data;
  if (
    packet.scope.workspaceId !== input.scope.workspaceId ||
    packet.scope.potSlug !== input.scope.potSlug ||
    packet.scope.repositoryId !== input.scope.repositoryId ||
    packet.unitHash !== capabilityUnitHash(expectedUnit.data) ||
    packet.manifestRevision !== input.manifestRevision ||
    packet.extraction.recipeVersion !== (input.recipeVersion ?? CAPABILITY_EXTRACTION_RECIPE) ||
    packet.extraction.promptVersion !== (input.promptVersion ?? CAPABILITY_SUMMARY_PROMPT)
  ) {
    return { fresh: false, reason: 'Packet scope or manifest changed' };
  }
  const maxPacketChars = input.maxPacketChars ?? 32_000;
  const excerptLines = input.excerptLines ?? 40;
  if (
    !Number.isInteger(maxPacketChars) ||
    maxPacketChars < 1_000 ||
    maxPacketChars > 64_000 ||
    !Number.isInteger(excerptLines) ||
    excerptLines < 4 ||
    excerptLines > 100 ||
    JSON.stringify(packet).length > maxPacketChars ||
    packet.sources.some((source) => source.endLine - source.startLine + 1 > excerptLines)
  ) {
    return { fresh: false, reason: 'Packet exceeds current extraction budget' };
  }
  if (packet.coverage.truncated || packet.coverage.unresolved.length > 0)
    return { fresh: false, reason: 'Required packet evidence is incomplete' };
  try {
    const root = await realpath(input.rootPath);
    const files = await readUnitFiles(root, input.unit);
    if (packet.graph) {
      const fingerprint = capabilityHash(JSON.stringify(packet.sources.map(source => [source.id, source.path, source.sourceHash])));
      if (packet.graph.sourceFingerprint !== fingerprint) return { fresh: false, reason: 'Graph source fingerprint differs' };
      const sites = [...packet.graph.candidates, ...packet.graph.relationships.flatMap(edge => [edge.source, edge.target])];
      for (const site of sites) {
        if (site.line1 > (files.get(site.path)?.split('\n').length ?? 0))
          return { fresh: false, reason: 'Graph location differs from cited source' };
      }
      for (const candidate of packet.graph.candidates) {
        const source = packet.sources.find(source => source.id === candidate.evidenceId)!;
        const declaration = /\b(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(source.anchor);
        const contents = files.get(source.path)!;
        const anchorLine = contents.slice(0, contents.indexOf(source.anchor)).split('\n').length;
        const declarationLine = anchorLine + source.anchor.slice(0, declaration?.index ?? 0).split('\n').length - 1;
        if (declaration?.[1] !== candidate.symbol || declarationLine !== candidate.line1)
          return { fresh: false, reason: 'Graph boundary differs from cited declaration' };
      }
    }
    for (const source of packet.sources) {
      const current = files.get(source.path);
      if (current === undefined || capabilityHash(current) !== source.sourceHash)
        return { fresh: false, reason: 'Source changed: ' + source.path };
      const lines = current.split('\n');
      const actualExcerpt = lines.slice(source.startLine - 1, source.endLine).join('\n');
      if (source.endLine > lines.length || actualExcerpt !== source.excerpt) {
        return { fresh: false, reason: 'Excerpt differs from cited source lines: ' + source.id };
      }
      const anchorOffset = current.indexOf(source.anchor);
      if (anchorOffset < 0 || current.indexOf(source.anchor, anchorOffset + 1) >= 0) {
        return { fresh: false, reason: 'Missing or ambiguous evidence anchor: ' + source.id };
      }
    }
    const artifact = await deps.readArtifact(packet.extraction.artifactRef);
    if (capabilityHash(artifact) !== packet.extraction.artifactHash)
      return { fresh: false, reason: 'Packed artifact changed' };
    if (packet.graph?.status === 'measured') {
      if (!deps.graph) return { fresh: false, reason: 'Compiler graph verification unavailable' };
      const currentGraph = await inspectCapabilityGraph(root, packet.scope.repositoryId, packet.sources, deps.graph);
      const actual = CapabilityPacketGraphSchema.parse(currentGraph);
      const expectedText = JSON.stringify(packet.graph), actualText = JSON.stringify(actual);
      if (actualText !== expectedText)
        return { fresh: false, reason: 'Compiler graph differs from current cited source', graphMismatch: {
          unitId: packet.unit.id, sourceFingerprint: packet.graph.sourceFingerprint,
          expectedHash: capabilityHash(expectedText), actualHash: capabilityHash(actualText),
          differingFields: (Object.keys(actual) as Array<keyof CapabilityPacketGraph>)
            .filter(key => JSON.stringify(actual[key]) !== JSON.stringify(packet.graph![key])),
          expected: packet.graph, actual,
        } };
    }
    return { fresh: true };
  } catch (error) {
    return {
      fresh: false,
      reason: 'Source verification unavailable: ' + (error instanceof Error ? error.message : String(error)),
    };
  }
}

/** Extend the existing source packet, without promoting function boundaries into capabilities. */
async function inspectCapabilityGraph(root: string, repositoryId: string, sources: CapabilitySource[],
  graph: CapabilityPacketDeps['graph']): Promise<CapabilityPacketGraph> {
  const result: CapabilityPacketGraph = { status: 'unknown', repositoryId,
    sourceFingerprint: capabilityHash(JSON.stringify(sources.map(source => [source.id, source.path, source.sourceHash]))),
    candidates: [], relationships: [], unmapped: [], claimValidation: 'manifest-evidence-only' };
  const implementations = sources.filter(source => source.kind === 'implementation');
  if (implementations.length > 4) result.unmapped.push('Additional implementation boundaries omitted by the four-symbol budget.');
  if (!graph) { result.unmapped.push('Compiler graph discovery is unavailable; only manifest source evidence was inspected.'); return result; }
  const paths = [...new Set(sources.map(source => source.path))];
  for (const source of implementations.slice(0, 4)) {
    const declaration = /\b(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(source.anchor);
    if (!declaration) { result.unmapped.push('No declared symbol at implementation anchor ' + source.id); continue; }
    let answer: CodeIntelAnswer;
    try { answer = await graph(root, repositoryId, declaration[1]!, source.path, paths); }
    catch (error) {
      result.unmapped.push('Compiler discovery unavailable for ' + source.id + ': '
        + (error instanceof Error ? error.message.slice(0, 400) : 'unknown failure'));
      continue;
    }
    const evidence = answer.evidence;
    if (answer.error || evidence?.graphScope.basis !== 'compiler-project'
      || evidence.sourceScope.repositoryId !== repositoryId || !evidence.sourceScope.sourceFingerprint) {
      result.unmapped.push('Current scoped compiler evidence unavailable for ' + source.id
        + (answer.error ? ': ' + answer.error.slice(0, 400) : ': source scope or compiler evidence did not match'));
      continue;
    }
    for (const limitation of evidence.graphScope.limitations)
      if (!result.unmapped.includes(limitation)) result.unmapped.push(limitation);
    const supported = (site: { site: { path: string; line1: number | null }; contentHash: string }) =>
      site.site.line1 !== null && sources.some(cited => cited.path === site.site.path && cited.sourceHash === site.contentHash)
      && evidence.sourceScope.supportingFiles.some(file => file.path === site.site.path
        && file.contentHash === site.contentHash && file.representation === 'full-source');
    // The compiler's declaration site may omit its display name. Bind its
    // definition relationship, measured location and identity hash instead.
    const anchorOffset = source.excerpt.indexOf(source.anchor) + declaration.index;
    const declarationLine = source.startLine + source.excerpt.slice(0, anchorOffset).split('\n').length - 1;
    const capturedSite = (index: number) => {
      const site = answer.sites[index];
      const identity = evidence.siteIdentities.find(row => row.siteIndex === index && row.sourcePath === site?.path);
      return site && identity?.contentHash ? { site, contentHash: identity.contentHash } : null;
    };
    const boundary = evidence.relationships.filter(edge => edge.kind === 'definition'
      && edge.origin === 'compiler' && edge.knowledge === 'observed').map(edge => capturedSite(edge.siteIndex))
      .find(site => site?.site.path === source.path && site.site.line1 === declarationLine
        && site.contentHash === source.sourceHash && supported(site));
    if (!boundary) { result.unmapped.push('Compiler did not resolve the cited boundary for ' + source.id); continue; }
    result.candidates.push({ evidenceId: source.id, symbol: declaration[1]!, path: source.path,
      line1: boundary.site.line1!, sourceHash: source.sourceHash, capabilityStatus: 'candidate-only' });
    for (const edge of evidence.relationships) {
      if (edge.kind === 'definition') continue;
      const from = edge.source ?? capturedSite(edge.siteIndex);
      if (edge.origin !== 'compiler' || edge.knowledge !== 'observed' || !from || !edge.target
        || !['callers', 'callees', 'imports', 'impact'].includes(edge.kind) || !supported(from) || !supported(edge.target)) {
        if (!result.unmapped.includes('Relationships outside current cited source remain unverified.'))
          result.unmapped.push('Relationships outside current cited source remain unverified.');
        continue;
      }
      const site = (value: NonNullable<typeof from>) => ({ path: value.site.path, line1: value.site.line1!, sourceHash: value.contentHash });
      const candidate = { kind: edge.kind as CapabilityPacketGraph['relationships'][number]['kind'],
        source: site(from), target: site(edge.target), origin: 'compiler' as const, runtimeExecution: 'unknown' as const };
      if (!result.relationships.some(existing => JSON.stringify(existing) === JSON.stringify(candidate))) {
        if (result.relationships.length < 12) result.relationships.push(candidate);
        else if (!result.unmapped.includes('Additional relationships omitted by the twelve-edge budget.'))
          result.unmapped.push('Additional relationships omitted by the twelve-edge budget.');
      }
    }
    if (answer.truncation.truncated) result.unmapped.push('Compiler discovery was bounded for ' + source.id + '; no absence claim is valid.');
  }
  if (result.candidates.length) result.status = 'measured';
  return result;
}

async function inspectCodeContext(
  root: string,
  repositoryId: string,
  sources: CapabilitySource[],
  deps: CapabilityPacketDeps,
): Promise<{ indexCurrent: boolean; excluded: string[] }> {
  const excluded: string[] = [];
  const implementation = sources.filter((source) => source.kind === 'implementation');
  // Text only identifies a candidate cursor. A current compiler definition must
  // resolve it in the cited file before the name can drive a topology lookup.
  const candidates = implementation.slice(0, 4);
  if (implementation.length > candidates.length)
    excluded.push('Additional symbol discovery omitted by the four-symbol packet budget.');
  const read = async (call: () => Promise<CodeIntelAnswer>) => {
    try {
      return { answer: await call(), error: null };
    } catch (error) {
      return { answer: null, error: error instanceof Error ? error.message.slice(0, 300) : 'Backend failed' };
    }
  };
  const current = (answer: CodeIntelAnswer | null) =>
    Boolean(answer && !answer.error && answer.freshness.health === 'healthy' && answer.freshness.staleVsDisk === false);
  const results = await Promise.all(
    candidates.map(async (source) => {
      const notes: string[] = [];
      const declaration = /\b(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(
        source.anchor,
      );
      if (!declaration)
        return {
          current: false,
          notes: ['Enclosing symbol is unresolved for ' + source.id + '; only its exact source anchor is verified.'],
        };
      const name = declaration[1]!;
      const cursor = source.excerpt.indexOf(source.anchor) + declaration.index + declaration[0].lastIndexOf(name);
      const before = source.excerpt.slice(0, cursor);
      const line1 = source.startLine + before.split('\n').length - 1;
      const character = before.length - before.lastIndexOf('\n') - 1;
      const [definition, references] = await Promise.all([
        read(() => deps.resolveSymbol(root, resolve(root, source.path), line1, character)),
        read(() => deps.lookup(root, resolve(root, source.path), line1, character)),
      ]);
      const resolved =
        current(definition.answer) &&
        definition.answer!.sites.some((site) => site.path === source.path && site.line1 === line1);
      const refsCurrent = current(references.answer);
      notes.push(
        'Symbol ' +
          name +
          ': definition ' +
          (resolved ? 'verified at cited location' : 'unknown') +
          '; references ' +
          (refsCurrent ? 'current' : 'unknown') +
          (references.answer?.truncation?.truncated ? ', result truncated' : '') +
          '. Neighbor bodies are outside the selected evidence; no absence-of-edge conclusion is valid.',
      );
      for (const result of [definition, references]) {
        const reason = result.error ?? result.answer?.error;
        if (reason) notes.push('Code lookup unavailable: ' + reason.slice(0, 300));
      }
      if (resolved) {
        const directions = ['callers', 'callees'] as const;
        const graph = await Promise.all(
          directions.map((direction) => read(() => deps.neighbors(direction, repositoryId, name))),
        );
        for (let i = 0; i < directions.length; i++) {
          const result = graph[i]!;
          const direction = directions[i]!;
          const answer = result.answer;
          const sites = (answer?.sites ?? []).filter((site) => CapabilityPathSchema.safeParse(site.path).success);
          const locations = sites.slice(0, 2).map((site) => site.path + (site.line1 === null ? '' : ':' + site.line1));
          notes.push(
            'One-hop ' +
              direction +
              ' for ' +
              name +
              ': ' +
              (current(answer) ? 'index current' : 'index unknown or stale') +
              (answer?.truncation?.truncated || sites.length > 2 ? '; context budget truncated' : '') +
              '; reported locations are unexamined: ' +
              (locations.join(', ') || 'none resolved') +
              '. This is discovery context, not verified integration evidence.',
          );
          const reason = result.error ?? answer?.error;
          if (reason) notes.push('Topology lookup unavailable: ' + reason.slice(0, 300));
        }
      } else
        notes.push('Caller/callee discovery unavailable without a verified symbol identity for ' + source.id + '.');
      return { current: resolved && refsCurrent, notes };
    }),
  );
  return {
    indexCurrent: results.length > 0 && results.every((result) => result.current),
    excluded: [...excluded, ...results.flatMap((result) => result.notes)],
  };
}

/** Cache addresses include actual file bytes; a commit label never stands in for dirty content. */
export async function buildCapabilityPacket(
  input: BuildCapabilityPacketInput,
  deps: CapabilityPacketDeps = defaultDeps,
): Promise<CapabilityPacketBuild> {
  const started = deps.now();
  const durationMs = () => Math.max(0, deps.now() - started);
  try {
    const unit = CapabilityUnitSchema.parse(input.unit);
    const root = await realpath(input.rootPath);
    if (!(await stat(root)).isDirectory()) throw new Error('Repository root is not a directory');
    const maxPacketChars = input.maxPacketChars ?? 32_000;
    const excerptLines = input.excerptLines ?? 40;
    if (
      !Number.isInteger(maxPacketChars) ||
      maxPacketChars < 1_000 ||
      maxPacketChars > 64_000 ||
      !Number.isInteger(excerptLines) ||
      excerptLines < 4 ||
      excerptLines > 100
    )
      throw new Error('Invalid extraction budget');
    const files = await readUnitFiles(root, unit);
    const sources = extract(unit, files, excerptLines);
    const recipeVersion = input.recipeVersion ?? CAPABILITY_EXTRACTION_RECIPE;
    const promptVersion = input.promptVersion ?? CAPABILITY_SUMMARY_PROMPT;
    const unitHash = capabilityUnitHash(unit);
    const key =
      'dream:capability:' +
      capabilityHash(
        JSON.stringify({
          root,
          scope: input.scope,
          unitHash,
          manifestRevision: input.manifestRevision,
          sources: sources.map((s) => [s.id, s.sourceHash]),
          recipeVersion,
          promptVersion,
          maxPacketChars,
          excerptLines,
        }),
      );
    const cached = await deps.cache.get(input.scope.workspaceId, key);
    if (cached && (await verifyCapabilityPacket(cached.value, { ...input, unit }, deps)).fresh) {
      const packet = CapabilityPacketSchema.parse(cached.value);
      if (JSON.stringify(packet).length <= maxPacketChars)
        return { status: 'ready', packet, cacheHit: true, costUsd: 0, durationMs: durationMs() };
    }
    const packed = await deps.pack(root, [...files.keys()]);
    const artifact = packed.artifact;
    if (
      packed.answer.error ||
      packed.answer.truncation.truncated ||
      !artifact?.path ||
      artifact.provenance.engine !== 'repomix' ||
      artifact.provenance.securityScan !== 'secretlint+deny-set'
    ) {
      throw new Error('Required secret-scanned pack is unavailable or incomplete');
    }
    const packedBody = await deps.readArtifact(artifact.path);
    const selected = new Set(packed.answer.sites.map((site) => site.path));
    for (const [path, contents] of files) {
      // The pinned XML pack format embeds trimmed raw source. Reject configuration
      // transforms or secret exclusions rather than relabeling unscanned local bytes.
      const exactFile = '<file path="' + path + '">\n' + contents.trim() + '\n</file>';
      if (!selected.has(path) || !packedBody.includes(exactFile))
        throw new Error('Packed source differs or is excluded: ' + path);
    }
    const context = await inspectCodeContext(root, input.scope.repositoryId, sources, deps);
    const graph = await inspectCapabilityGraph(root, input.scope.repositoryId, sources, deps.graph);
    const indexCurrent = context.indexCurrent;
    const packet = CapabilityPacketSchema.parse({
      schemaVersion: 'dream-capability-packet-v1',
      scope: input.scope,
      unit,
      unitHash,
      manifestRevision: input.manifestRevision,
      sources,
      graph,
      extraction: {
        recipeVersion,
        promptVersion,
        capturedAt: new Date(deps.now()).toISOString(),
        sourceCommit: artifact.provenance.commit,
        dirty: artifact.provenance.dirty,
        backend: indexCurrent ? 'lsp' : 'text',
        indexHealth: indexCurrent ? 'current' : 'unknown',
        artifactRef: artifact.path,
        artifactHash: capabilityHash(packedBody),
        durationMs: durationMs(),
        securityScan: 'passed',
        costUsd: 0,
      },
      coverage: {
        status: 'partial',
        includedPaths: [...files.keys()],
        truncated: false,
        unresolved: [],
        excluded: context.excluded,
        note: indexCurrent
          ? 'Bounded manifest anchors, compiler symbol/reference checks and one-hop caller/callee discovery; neighboring bodies and behavior remain unexamined.'
          : 'Verified exact text anchors; index health is unknown. No missing-edge or global novelty claim is made.',
      },
    });
    if (JSON.stringify(packet).length > maxPacketChars)
      throw new Error('Packet exceeds budget; required contracts were retained, so it is not admitted');
    const verified = await verifyCapabilityPacket(packet, { ...input, unit }, deps);
    if (!verified.fresh) return { status: 'unavailable', reason: verified.reason, costUsd: 0,
      durationMs: durationMs(), ...(verified.graphMismatch ? { graphMismatch: verified.graphMismatch } : {}) };
    await deps.cache.set(input.scope.workspaceId, key, packet, {
      hardTtlMs: CACHE_TTL_MS,
      tags: ['dream:capability:' + input.scope.potSlug],
    });
    return { status: 'ready', packet, cacheHit: false, costUsd: 0, durationMs: durationMs() };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
      costUsd: 0,
      durationMs: durationMs(),
    };
  }
}

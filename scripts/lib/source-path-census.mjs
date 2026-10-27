/** Static preparation only. Sites are syntax evidence, never runtime/callee closure. */
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
const hash = text => createHash('sha256').update(text).digest('hex');
const functions = node => ts.isFunctionLike(node) && !!node.body;
const unwrap = node => ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)
  ? unwrap(node.expression) : node;
const label = node => {
  if (node.name) return node.name.getText();
  if (ts.isVariableDeclaration(node.parent) || ts.isPropertyAssignment(node.parent)) return node.parent.name.getText();
  if (ts.isCallExpression(node.parent)) return node.parent.expression.getText() + '.callback';
  return '<anonymous>';
};

/** Retain every call/import occurrence, its source span, function and predicate context. */
export function censusSites(path, text) {
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  if (ast.parseDiagnostics.length) throw new Error('Source parse failed: ' + path);
  const sites = [], bindings = new Map();
  const span = node => {
    const start = node.getStart(ast), end = node.end;
    const point = ast.getLineAndCharacterOfPosition(start);
    return { start, end, byteStart: Buffer.byteLength(text.slice(0, start)),
      byteEnd: Buffer.byteLength(text.slice(0, end)), line: point.line + 1, column: point.character + 1 };
  };
  const bind = (pattern, expression) => {
    if (!pattern || !expression) return;
    expression = unwrap(expression);
    if (ts.isArrayBindingPattern(pattern) && ts.isCallExpression(expression)
        && expression.expression.getText() === 'Promise.all' && ts.isArrayLiteralExpression(expression.arguments[0])) {
      pattern.elements.forEach((element, i) => {
        if (ts.isBindingElement(element)) bind(element.name, expression.arguments[0].elements[i]);
      });
      return;
    }
    if (!ts.isObjectBindingPattern(pattern)) return;
    const imports = [];
    const find = node => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          && ts.isStringLiteralLike(node.arguments[0])) imports.push(node.arguments[0].text);
      ts.forEachChild(node, find);
    };
    find(expression);
    for (const element of pattern.elements) if (ts.isIdentifier(element.name)) {
      const entry = { imported: (element.propertyName ?? element.name).getText(), specifiers: [...new Set(imports)] };
      // A second lexical binding is ambiguous; never silently pick one scope.
      bindings.set(element.name.text, bindings.has(element.name.text) ? null : entry);
    }
  };
  const visit = (node, context = [], predicates = []) => {
    if (ts.isVariableDeclaration(node)) bind(node.name, node.initializer);
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings
        && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const element of node.importClause.namedBindings.elements) {
        const entry = { imported: (element.propertyName ?? element.name).text, specifiers: [node.moduleSpecifier.text] };
        bindings.set(element.name.text, bindings.has(element.name.text) ? null : entry);
      }
    }
    const isImport = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier;
    const isCall = ts.isCallExpression(node) || ts.isNewExpression(node);
    if (isImport || isCall) {
      const dynamicImport = isCall && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText() === 'require');
      const literal = isImport ? node.moduleSpecifier : dynamicImport ? node.arguments?.[0] : null;
      const kind = isImport ? 'import' : dynamicImport ? 'dynamic-import' : 'call';
      const typeOnly = !!(isImport && (node.isTypeOnly || node.importClause?.isTypeOnly));
      sites.push({ path, ...span(node), kind, typeOnly,
        expression: isImport ? 'import' : node.expression.getText(),
        specifier: literal && ts.isStringLiteralLike(literal) ? literal.text : null,
        source: node.getText(ast), enclosingFunctions: context, predicates,
        initialization: context.length === 0, node });
    }
    const nextContext = functions(node) ? [...context, label(node)] : context;
    if (ts.isIfStatement(node)) {
      visit(node.expression, nextContext, predicates);
      visit(node.thenStatement, nextContext, [...predicates, { condition: node.expression.getText(), side: true, ...span(node) }]);
      if (node.elseStatement) visit(node.elseStatement, nextContext, [...predicates, { condition: node.expression.getText(), side: false, ...span(node) }]);
    } else ts.forEachChild(node, child => visit(child, nextContext, predicates));
  };
  visit(ast);
  const occurrences = new Map();
  for (const site of sites) {
    const base = JSON.stringify([site.kind, site.enclosingFunctions, site.predicates.map(p => [p.condition, p.side]), site.source]);
    const occurrence = (occurrences.get(base) ?? 0) + 1; occurrences.set(base, occurrence);
    site.fingerprint = hash(base + '\0' + occurrence);
    site.binding = bindings.get(site.expression) ?? null;
    site.calleeCoverage = site.kind === 'call' ? 'UNKNOWN' : null;
  }
  return { path, sha256: hash(text), ast, sites, span };
}

export function changedSites(before, after) {
  const old = new Set(before.sites.map(site => site.fingerprint));
  const current = new Set(after.sites.map(site => site.fingerprint));
  return { addedOrChanged: after.sites.filter(site => !old.has(site.fingerprint)),
    removedOrChanged: before.sites.filter(site => !current.has(site.fingerprint)) };
}

const terminal = node => ts.isReturnStatement(node) || ts.isThrowStatement(node)
  || ts.isBlock(node) && node.statements.length > 0 && terminal(node.statements[node.statements.length - 1]);

/** Select a declared source path. Only exact predicates and unconditional terminal blocks exclude sites. */
export function selectSourcePath(unit, { functionName, containerName, branchValues = {} }) {
  const cutoffs = [];
  const containers = [];
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText() === containerName) containers.push(unit.span(node));
    if (ts.isBlock(node)) for (const statement of node.statements) {
      if (!ts.isIfStatement(statement)) continue;
      const condition = statement.expression.getText();
      if (!Object.hasOwn(branchValues, condition)) continue;
      const branch = branchValues[condition] ? statement.thenStatement : statement.elseStatement;
      if (branch && terminal(branch)) cutoffs.push({ after: statement.end, until: node.end,
        condition, value: branchValues[condition], terminalBranch: unit.span(branch) });
    }
    ts.forEachChild(node, visit);
  };
  visit(unit.ast);
  const selected = [], excluded = [];
  for (const site of unit.sites) {
    if (site.typeOnly) continue;
    if (!site.initialization && !site.enclosingFunctions.includes(functionName)) continue;
    if (!site.initialization && containerName && !containers.some(c => site.start >= c.start && site.end <= c.end)) continue;
    const mismatch = site.predicates.find(p => Object.hasOwn(branchValues, p.condition) && branchValues[p.condition] !== p.side);
    const cutoff = cutoffs.find(c => site.start > c.after && site.end <= c.until
      && !site.predicates.some(p => Object.hasOwn(branchValues, p.condition) && branchValues[p.condition] !== p.side));
    if (mismatch || cutoff) excluded.push({ site, reason: mismatch ? 'declared-predicate-excludes-branch' : 'selected-branch-terminates-before-site', proof: mismatch ?? cutoff });
    else selected.push(site);
  }
  return { selected, excluded };
}

/** One bound over a union, including seeds supplied by earlier preparation. Never reset per root. */
export function boundedFrontier(edges, { baseline = [], priorAdditions = [], bound = 60 } = {}) {
  const retained = new Set(baseline), additions = new Set(priorAdditions), frontier = [];
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    if (!edge.path || retained.has(edge.path) || additions.has(edge.path)) continue;
    if (additions.size >= bound) return { status: 'STOPPED-bound', bound, additions: [...additions],
      frontier, refusedEdge: edge, pending: edges.slice(i), complete: false };
    additions.add(edge.path); frontier.push(edge);
  }
  return { status: 'PARTIAL-seeded-frontier', bound, additions: [...additions], frontier, complete: false };
}

const canonicalInput = path => typeof path === 'string' && path.length > 0
  && !path.includes('\\') && !path.includes('\0') && !path.startsWith('/')
  && path.split('/').every(part => part && part !== '.' && part !== '..');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const copy = value => structuredClone(value);

/** Prospective preparation accounting only; this does not authorize a census or execution.
 * The controller must persist snapshots and retain the same attempt/clock identity on resume.
 * readChunk is a trusted bounded byte-reader; stat must return metadata without reading payload.
 */
export function createPreparationLedger(options, { now = () => Number(process.hrtime.bigint() / 1000000n), snapshot, persist } = {}) {
  const { attemptId, candidate, clockId, baseline = [], priorAdditions = [], bound = 60,
    maxInputs = baseline.length + bound, maxBytes = 64 * 1024 * 1024,
    maxInputBytes = 16 * 1024 * 1024, maxElapsedMs = 120000, sourceBinding } = copy(options);
  if (![attemptId, candidate, clockId].every(value => typeof value === 'string' && value.length > 0)
      || ![bound, maxInputs, maxBytes, maxInputBytes, maxElapsedMs].every(integer)
      || ![...baseline, ...priorAdditions].every(canonicalInput)
      || new Set([...baseline, ...priorAdditions]).size !== baseline.length + priorAdditions.length
      || priorAdditions.length > bound || baseline.length + priorAdditions.length > maxInputs
      || sourceBinding && (typeof sourceBinding.root !== 'string' || !isAbsolute(sourceBinding.root)
        || !/^[a-f0-9]{64}$/.test(sourceBinding.inputsSha256))) {
    throw new Error('Invalid preparation identity, prefix or limits');
  }
  const config = copy({ attemptId, candidate, clockId, baseline, priorAdditions, bound,
    maxInputs, maxBytes, maxInputBytes, maxElapsedMs, ...(sourceBinding ? { sourceBinding } : {}) });
  const configHash = hash(JSON.stringify(config)), start = now();
  if (!Number.isFinite(start)) throw new Error('Invalid monotonic clock');
  let state = { version: 1, configHash, startedAtMs: start, lastAtMs: start,
    additions: [...priorAdditions], bytesRead: 0, reads: [], digests: {}, pending: null,
    status: 'PARTIAL-source-preparation', reason: null, byteAccounting: 'known' };
  if (snapshot) {
    const { checksum, ...saved } = snapshot;
    if (checksum !== hash(JSON.stringify(saved)) || saved.version !== 1 || saved.configHash !== configHash
        || !Array.isArray(saved.additions) || !saved.additions.every(canonicalInput)
        || saved.additions.slice(0, priorAdditions.length).join('\0') !== priorAdditions.join('\0')
        || new Set([...baseline, ...saved.additions]).size !== baseline.length + saved.additions.length
        || saved.additions.length > bound || baseline.length + saved.additions.length > maxInputs
        || !integer(saved.bytesRead) || !Array.isArray(saved.reads)
        || saved.reads.some(row => !integer(row.bytes))
        || saved.reads.reduce((sum, row) => sum + row.bytes, 0) !== saved.bytesRead
        || !Number.isFinite(saved.startedAtMs) || !Number.isFinite(saved.lastAtMs)
        || saved.lastAtMs < saved.startedAtMs
        || !['PARTIAL-source-preparation', 'STOPPED'].includes(saved.status)) {
      throw new Error('Preparation snapshot/configuration mismatch');
    }
    state = copy(saved);
    if (state.pending) { state.status = 'STOPPED'; state.reason = 'interrupted-read'; state.byteAccounting = 'unknown'; }
  }
  const stop = reason => { state.status = 'STOPPED'; state.reason ??= reason; };
  const checkTime = () => {
    if (state.status === 'STOPPED') throw new Error(state.reason);
    const at = now();
    if (!Number.isFinite(at) || at < state.lastAtMs) stop('clock-identity-or-order');
    else { state.lastAtMs = at; if (at - state.startedAtMs >= maxElapsedMs) stop('elapsed-limit'); }
    if (state.status === 'STOPPED') throw new Error(state.reason);
  };
  const ledger = {
    snapshot() { const saved = copy(state); return { ...saved, checksum: hash(JSON.stringify(saved)) }; },
    report() { return { ...ledger.snapshot(), receipt: false, fullClosureQualified: false, executionAdmitted: false }; },
    async read(path, io) {
      let frontier;
      try {
        checkTime();
        if (state.pending) { stop('overlapping-read'); throw new Error(state.reason); }
        if (!canonicalInput(path)) { stop('noncanonical-input'); throw new Error(state.reason); }
        frontier = boundedFrontier([{ path }], { baseline, priorAdditions: state.additions, bound });
        if (frontier.refusedEdge || baseline.length + frontier.additions.length > maxInputs) {
          stop('input-limit'); throw new Error(state.reason);
        }
      } catch (error) {
        // A refusal is terminal even when no metadata/read callback was reached.
        if (persist) await persist(ledger.snapshot());
        throw error;
      }
      state.additions = frontier.additions;
      state.pending = { path, bytes: 0 };
      const chunks = [], digest = createHash('sha256');
      try {
        if (persist) { await persist(ledger.snapshot()); checkTime(); }
        if (io.candidate !== undefined && io.candidate !== candidate) throw new Error('candidate-drift');
        const before = await io.stat(); checkTime();
        if (!before || !integer(before.size) || typeof before.identity !== 'string' || !before.identity
            || before.canonicalPath !== path) throw new Error('unbound-input-metadata');
        if (before.size > maxInputBytes || before.size > maxBytes - state.bytesRead) throw new Error('byte-limit');
        let offset = 0;
        while (offset < before.size) {
          checkTime();
          if (persist) { await persist(ledger.snapshot()); checkTime(); }
          const length = Math.min(65536, before.size - offset);
          const chunk = await io.readChunk({ offset, length });
          if (!(chunk instanceof Uint8Array)) { state.byteAccounting = 'unknown'; throw new Error('unmeasured-read'); }
          state.bytesRead += chunk.byteLength;
          state.pending.bytes += chunk.byteLength;
          state.reads.push({ path, offset, bytes: chunk.byteLength });
          if (chunk.byteLength === 0 || chunk.byteLength > length || state.bytesRead > maxBytes) throw new Error('bounded-read-violation');
          // Copy before another awaited callback can mutate a returned buffer.
          const bytes = Buffer.from(chunk); chunks.push(bytes); digest.update(bytes); offset += bytes.length;
          checkTime();
        }
        const after = await io.stat(); checkTime();
        if (after?.canonicalPath !== path || before.identity !== after.identity || before.size !== after.size) throw new Error('input-drift');
        const sha256 = digest.digest('hex');
        if (Object.hasOwn(state.digests, path) && state.digests[path] !== sha256
            || io.expectedSha256 && io.expectedSha256 !== sha256) throw new Error('input-digest-drift');
        Object.defineProperty(state.digests, path, { value: sha256, writable: true, enumerable: true, configurable: true });
        return { path, sha256, data: Buffer.concat(chunks), receipt: false, fullClosureQualified: false };
      } catch (error) {
        // An I/O exception cannot establish whether the failing reader consumed bytes.
        if (!['byte-limit', 'unbound-input-metadata', 'input-drift', 'input-digest-drift',
          'bounded-read-violation', 'elapsed-limit', 'clock-identity-or-order', 'candidate-drift',
          'candidate-input-unbound', 'input-path-alias', 'input-not-regular'].includes(error.message)) state.byteAccounting = 'unknown';
        stop(error.message); throw error;
      } finally {
        try {
          if (io.close) await io.close();
        } catch (error) {
          stop('input-close-failed'); throw error;
        } finally {
          state.pending = null;
          if (persist) {
            await persist(ledger.snapshot());
            if (state.status !== 'STOPPED') checkTime();
          }
        }
      }
    },
  };
  return ledger;
}

/** Actual prospective readers must use a durable store's atomic compare-and-swap seam.
 * Reuse the existing artifact/checkpoint store; this helper creates no storage surface.
 * Pure createPreparationLedger remains useful for replay and synthetic control verification.
 */
export async function openPreparationLedger(options, { store, now } = {}) {
  if (!store || typeof store.load !== 'function' || typeof store.compareAndSwap !== 'function') {
    throw new Error('Durable attempt store required');
  }
  const saved = await store.load(options.attemptId);
  let revision = saved?.revision ?? null;
  const persist = async snapshot => {
    const result = await store.compareAndSwap(options.attemptId, revision, snapshot);
    if (!result?.ok || !integer(result.revision) || result.revision <= (revision ?? -1)) {
      throw new Error('attempt-state-conflict');
    }
    revision = result.revision;
  };
  const ledger = createPreparationLedger(options, { now, snapshot: saved?.snapshot, persist });
  // Create-if-absent is also atomic: two first openers cannot both reset an attempt.
  if (!saved) await persist(ledger.snapshot());
  return ledger;
}

/** Bind revisions to one existing PG text artifact, using its atomic content CAS. */
export function createArtifactPreparationStore({ slug, relPath, loadTextArtifact, compareAndSwapTextArtifact }) {
  if (typeof slug !== 'string' || !slug || !canonicalInput(relPath)
      || typeof loadTextArtifact !== 'function' || typeof compareAndSwapTextArtifact !== 'function') {
    throw new Error('Canonical artifact store binding required');
  }
  const decode = (text, attemptId) => {
    if (text === null) return null;
    const row = JSON.parse(text);
    if (row?.version !== 1 || row.attemptId !== attemptId || !integer(row.revision) || !row.snapshot) {
      throw new Error('attempt-artifact-binding');
    }
    return row;
  };
  return {
    async load(attemptId) {
      const row = decode(await loadTextArtifact(slug, relPath), attemptId);
      return row ? { revision: row.revision, snapshot: row.snapshot } : null;
    },
    async compareAndSwap(attemptId, expectedRevision, snapshot) {
      const current = await loadTextArtifact(slug, relPath), row = decode(current, attemptId);
      if ((row?.revision ?? null) !== expectedRevision) return { ok: false, revision: row?.revision ?? 0 };
      const revision = (expectedRevision ?? -1) + 1;
      const next = JSON.stringify({ version: 1, attemptId, revision, snapshot });
      return { ok: await compareAndSwapTextArtifact(slug, relPath, current, next), revision };
    },
  };
}

/** Source preparation only. No reads occur at construction. Each file is opened
 * after the ledger's durable pre-read guard, pinned to one descriptor and digest.
 * Root/ordered input bindings are part of the same immutable attempt config.
 */
export async function openBoundPreparationLedger(options, { store, root, manifest, now } = {}) {
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root
      || !manifest || manifest.candidate !== options.candidate || !manifest.inputs
      || typeof manifest.inputs !== 'object' || Array.isArray(manifest.inputs)) {
    throw new Error('candidate-source-binding');
  }
  const entries = Object.entries(copy(manifest.inputs));
  if (entries.some(([path, digest]) => !canonicalInput(path) || !/^[a-f0-9]{64}$/.test(digest))) {
    throw new Error('candidate-input-binding');
  }
  const inputs = new Map(entries), candidate = manifest.candidate;
  const ledger = await openPreparationLedger({ ...options,
    sourceBinding: { root, inputsSha256: hash(JSON.stringify(entries)) } }, { store, now });
  return {
    snapshot: () => ledger.snapshot(), report: () => ledger.report(),
    async read(path) {
      let handle;
      const file = canonicalInput(path) ? resolve(root, path) : root;
      const io = {
        candidate, expectedSha256: inputs.get(path),
        async stat() {
          if (!inputs.has(path)) throw new Error('candidate-input-unbound');
          if (await realpath(root) !== root || await realpath(file) !== file) throw new Error('input-path-alias');
          handle ??= await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const opened = await realpath(process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : file);
          const stat = await handle.stat({ bigint: true }), current = await lstat(file, { bigint: true });
          if (opened !== file || !current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino) {
            throw new Error('input-path-alias');
          }
          if (!stat.isFile()) throw new Error('input-not-regular');
          return { canonicalPath: path, size: Number(stat.size),
            identity: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') };
        },
        async readChunk({ offset, length }) {
          if (!handle || !integer(offset) || !integer(length) || length < 1 || length > 65536) {
            throw new Error('bounded-read-violation');
          }
          const bytes = Buffer.alloc(length);
          const result = await handle.read(bytes, 0, length, offset);
          return bytes.subarray(0, result.bytesRead);
        },
        async close() { if (handle) await handle.close(); },
      };
      return ledger.read(path, io);
    },
  };
}

/** A citation must identify an actual call in the pinned source, not a nearby journal span. */
export function verifyPreparationCitation(unit, { candidate, expectedCandidate, sourceSha256,
  start, end, expression, functionName }) {
  return candidate === expectedCandidate && typeof candidate === 'string' && candidate.length > 0
    && unit.sha256 === sourceSha256 && !!unit.sites.find(site => site.kind === 'call'
      && site.start === start && site.end === end && site.expression === expression
      && site.enclosingFunctions.includes(functionName));
}

/** Static evidence never grants original runtime, custody, budget or process-control admission. */
export function preparationDisposition({ candidate, expectedCandidate, targetCandidates, unresolved = [],
  actualArtifactSha256, expectedArtifactSha256, custodyVerified = false, sourceCurrent = false }) {
  const residue = [...unresolved];
  if (!candidate || candidate !== expectedCandidate) residue.push('candidate-unbound');
  if (!Array.isArray(targetCandidates) || targetCandidates.length !== 1) residue.push('target-ambiguous');
  if (!/^[a-f0-9]{64}$/.test(actualArtifactSha256 ?? '')
      || actualArtifactSha256 !== expectedArtifactSha256) residue.push('actual-artifact-unbound');
  if (!custodyVerified) residue.push('custody-unverified');
  if (!sourceCurrent) residue.push('source-not-current');
  return { status: residue.length ? 'BLOCKED' : 'PARTIAL-source-preparation',
    targetCandidates: copy(targetCandidates ?? []), residue, receipt: false,
    fullClosureQualified: false, currentGuardPassed: false, executionAdmitted: false };
}

/** Remove parser nodes/functions before persistence; the complete source is separately hash-bound. */
export function siteEvidence(site) {
  const { node, ...evidence } = site;
  return { ...evidence, sourceSha256: hash(site.source), source: site.source.slice(0, 500),
    sourceTruncated: site.source.length > 500 };
}

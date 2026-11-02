import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { withFsMutex } from "./fs-mutex.mjs";
// EI-21442389733525112: `task-exit-class.mjs` is dependency-free by design, so importing it
// here cannot reintroduce the coupling its own header warns about — and it is the one module
// that owns the refusal marker's grammar, for both the emitter below and the reader in
// `bash_output.ts`. A refusal that does not carry this marker is indistinguishable from a
// red test suite at every caller.
import { formatTaskBudgetRefusal } from "./task-exit-class.mjs";
import { scriptCommandWords } from "./executed-source-map.mjs";
import { readTaskCgroupLimit, readTaskCgroupMemoryMaxMb } from "./task-cgroup-limits.mjs";
export { readTaskCgroupMemoryMaxMb } from "./task-cgroup-limits.mjs";
import { readTaskDeadlineEpochMs, formatTaskDeadlineRefusal, admitTaskDeadline } from './task-deadline.mjs';
export { TASK_DEADLINE_EPOCH_MS_ENV, TASK_DEADLINE_REFUSAL_MARKER,
  readTaskDeadlineEpochMs, formatTaskDeadlineRefusal, isTaskDeadlineRefusal } from './task-deadline.mjs';

export const DURATION_HISTORY_VERSION = 1;

const comparisonHash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const comparisonDigest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const comparisonPath = (value) => typeof value === "string" && value.length > 0 &&
  !value.startsWith("/") && !value.includes("\\") &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
function freezeComparison(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeComparison(child);
    Object.freeze(value);
  }
  return value;
}

// A pathname size check does not bound a later read. Keep the descriptor open,
// cap even the growth probe by the caller's remaining IO budget, and reject
// replacement of either the leaf or its directory during capture.
export function readNativeArtifactBytes(file, byteLength, byteLimit, recordRead = () => {}) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 ||
      !Number.isSafeInteger(byteLimit) || byteLimit < byteLength)
    throw new Error('native artifact byte limit');
  return withNativeArtifactFile(file, byteLength, fd => {
    const buffer = Buffer.alloc(Math.min(byteLength + 1, byteLimit));
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, Math.min(64 * 1024, buffer.length - length), null);
      if (!count) break;
      length += count;
      recordRead(count); // Rejected captures consume the same IO budget.
    }
    if (length !== byteLength) throw new Error('native artifact changed during capture');
    return buffer.subarray(0, length);
  });
}

function withNativeArtifactFile(file, byteLength, consume) {
  const directory = dirname(file), root = lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(directory) !== resolve(directory))
    throw new Error('redirected native artifact directory');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== byteLength)
      throw new Error('native artifact length or file type mismatch');
    const result = consume(fd);
    const after = fstatSync(fd), current = lstatSync(file), rootAfter = lstatSync(directory);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs || !current.isFile() || current.isSymbolicLink() ||
        current.dev !== stat.dev || current.ino !== stat.ino ||
        !rootAfter.isDirectory() || rootAfter.isSymbolicLink() ||
        rootAfter.dev !== root.dev || rootAfter.ino !== root.ino ||
        realpathSync(directory) !== resolve(directory))
      throw new Error('native artifact changed during capture');
    return result;
  } finally { closeSync(fd); }
}

/** Read the existing native OUT event protocol with the receipt writer's bounds.
 * A truncated census is useful diagnostically but cannot establish custody.
 */
export function readNativeProcessTraceArtifacts(out, startedAtMs = 0, finishedAtMs = Number.MAX_SAFE_INTEGER) {
  const path = `${out}.native-processes`;
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink() || realpathSync(path) !== resolve(path))
    throw new Error("redirected native process trace");
  const sourceRoot = realpathSync(path), rows = [];
  const population = { artifactLimit: 16384, artifactsVisited: 0,
    eventByteLimit: 64 * 1024 * 1024, eventBytesRead: 0, complete: false, truncatedBy: null };
  const directory = opendirSync(sourceRoot);
  try {
    for (let entry; (entry = directory.readSync()) !== null;) {
      if (population.artifactsVisited === population.artifactLimit) {
        population.truncatedBy = "artifact-count";
        break;
      }
      population.artifactsVisited++;
      const name = entry.name;
      if (!/^[a-f0-9]{64}\.(json|stream|source)$/.test(name)) throw new Error("unexpected native process artifact");
      if (!name.endsWith(".json")) continue;
      const file = join(sourceRoot, name), stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024)
        throw new Error("redirected or oversized native process artifact");
      if (population.eventBytesRead + stat.size > population.eventByteLimit) {
        population.truncatedBy = "event-bytes";
        break;
      }
      const bytes = readNativeArtifactBytes(file, stat.size, population.eventByteLimit - population.eventBytesRead,
        count => { population.eventBytesRead += count; });
      if (createHash("sha256").update(bytes).digest("hex") !== name.slice(0, 64))
        throw new Error("native process artifact hash mismatch");
      const row = JSON.parse(bytes.toString("utf8"));
      if (row.schemaVersion !== 1 || row.kind !== "native-node-process-event" ||
          !Number.isSafeInteger(row.pid) || !Number.isSafeInteger(row.ppid) ||
          !Number.isSafeInteger(row.atMs) || typeof row.processIdentity !== "string")
        throw new Error("malformed native process event");
      if (row.atMs >= startedAtMs && row.atMs <= finishedAtMs) rows.push({ row, bytes });
    }
    population.complete = population.truncatedBy === null;
  } finally { directory.closeSync(); }
  return { sourceRoot, rows, population };
}

// Retain only bytes referenced by the process-bound reporter protocol. This is
// an archive of stated observations, never an enumeration of runtime inputs.
export function retainReporterEvaluatorArtifacts(payload, out, persist) {
  const result = { scope: "referenced-evaluator-code", status: "unobserved",
    referenceLimit: 4096, artifactByteLimit: 16 * 1024 * 1024,
    totalByteLimit: 64 * 1024 * 1024, referencesVisited: 0,
    bytesRead: 0, bytesRetained: 0, entries: [], gaps: [] };
  const gaps = new Set(), retained = new Map();
  const gap = reason => gaps.add(reason);
  const modules = `${out}.modules`;
  let observed = false;
  const observe = (location, observation) => {
    observed = true;
    if (observation?.schemaVersion !== "vitest-evaluator-inputs-v1" ||
        observation.scope !== "vitest-inlined-evaluator-inputs" ||
        observation.basis !== "before-evaluator-call") {
      gap("evaluator-protocol-unsupported"); return;
    }
    for (const role of ["entries", "vmInputs"]) {
      if (role === "vmInputs" && observation[role] === undefined) continue;
      const pins = observation[role];
      if (!Array.isArray(pins)) { gap("evaluator-reference-population-malformed"); continue; }
      for (let i = 0; i < pins.length; i++) {
        if (result.referencesVisited === result.referenceLimit) {
          gap("evaluator-reference-limit"); break;
        }
        result.referencesVisited++;
        const pin = pins[i];
        try {
          if (!pin || typeof pin.id !== "string" || !comparisonDigest(pin.sha256) ||
              !Number.isSafeInteger(pin.byteLength) || pin.byteLength < 0 ||
              pin.byteLength > result.artifactByteLimit || typeof pin.codeRef !== "string")
            throw new Error("malformed-or-oversized-reference");
          const directory = lstatSync(modules);
          if (!directory.isDirectory() || directory.isSymbolicLink() ||
              realpathSync(modules) !== resolve(modules) ||
              pin.codeRef !== join(resolve(modules), `${pin.sha256}.js`))
            throw new Error("redirected-reference");
          let artifact = retained.get(pin.sha256);
          if (artifact && artifact.byteLength !== pin.byteLength)
            throw new Error("length-mismatch");
          if (!artifact) {
            if (result.bytesRead + pin.byteLength > result.totalByteLimit)
              throw new Error("total-byte-limit");
            const fd = openSync(pin.codeRef, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            let bytes;
            try {
              const stat = fstatSync(fd);
              if (!stat.isFile() || stat.size !== pin.byteLength) throw new Error("length-or-file-type-mismatch");
              const buffer = Buffer.alloc(Math.min(pin.byteLength + 1, result.totalByteLimit - result.bytesRead));
              let length = 0, count;
              while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null)) > 0) {
                length += count;
                result.bytesRead += count; // Rejected bytes consume the same IO budget as retained bytes.
              }
              const after = fstatSync(fd), current = lstatSync(pin.codeRef), rootAfter = lstatSync(modules);
              if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs ||
                  after.ctimeMs !== stat.ctimeMs || current.isSymbolicLink() ||
                  current.dev !== stat.dev || current.ino !== stat.ino ||
                  rootAfter.dev !== directory.dev || rootAfter.ino !== directory.ino ||
                  realpathSync(modules) !== resolve(modules))
                throw new Error("changed-during-capture");
              bytes = buffer.subarray(0, length);
            } finally { closeSync(fd); }
            if (createHash("sha256").update(bytes).digest("hex") !== pin.sha256)
              throw new Error("digest-mismatch");
            artifact = persist(bytes, "evaluator.js");
            retained.set(pin.sha256, artifact);
            result.bytesRetained += bytes.length; // Unique archived artifacts, not reference occurrences.
          }
          result.entries.push({ location: `${location}/${role}/${i}`, id: pin.id, artifact });
        } catch (error) {
          gap(`evaluator-sidecar-rejected:${error?.code ?? error?.message ?? "unknown"}`);
        }
      }
    }
  };
  const scan = (rows, location, getObservation, suffix) => {
    if (rows === undefined) return;
    if (!Array.isArray(rows)) { gap("evaluator-observation-population-malformed"); return; }
    if (rows.length > result.referenceLimit) gap("evaluator-observation-limit");
    for (let i = 0; i < Math.min(rows.length, result.referenceLimit); i++) {
      const observation = getObservation(rows[i]);
      if (observation !== undefined) observe(`${location}/${i}/${suffix}`, observation);
    }
  };
  for (const key of ["rows", "diagnostics"])
    scan(payload[key], `/${key}`, row => row?.moduleEvaluations, "moduleEvaluations");
  scan(payload.nativeRun?.files, "/nativeRun/files", row => row?.proof?.inputs?.moduleEvaluations,
    "proof/inputs/moduleEvaluations");
  if (!observed) gap("evaluator-observations-unobserved");
  else if (!result.referencesVisited) gap("evaluator-references-unobserved");
  result.gaps = [...gaps];
  result.status = result.gaps.length ? (observed ? "partial" : "unobserved") : "retained";
  return result;
}

/** OUT diagnostics at the existing affected-test child boundary. This records
 * the real parent invocation and raw streams; it cannot certify unobserved npm
 * lifecycle/shell steps, executable resolution or runtime dependency closure.
 * Call before the finished pulse so a killed aggregate cannot lose this receipt. */
export function syncBudgetedTaskNativeExecutionReceipt(saved) {
  const sync = file => {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  };
  const retained = (value, depth = 0) => {
    if (depth > 24) throw new Error('native-artifact-nesting-invalid');
    if (!value || typeof value !== 'object') return;
    for (const [key, pin] of Object.entries(value)) {
      if (key === 'artifact' && pin !== null) {
        if (!pin || basename(pin.ref ?? '') !== pin.ref || !comparisonDigest(pin.sha256))
          throw new Error('native-artifact-reference-invalid');
        const bytes = readNativeArtifactBytes(join(saved.root, pin.ref), pin.byteLength, 64 * 1024 * 1024);
        if (createHash('sha256').update(bytes).digest('hex') !== pin.sha256) throw new Error('native-artifact-digest-mismatch');
        sync(join(saved.root, pin.ref));
      } else retained(pin, depth + 1);
    }
  };
  retained(saved.observation);
  for (const pin of [saved.receipt, saved.logs.stdout, saved.logs.stderr]) sync(join(saved.root, pin.ref));
  sync(saved.root);
  sync(dirname(saved.root));
  sync(dirname(dirname(saved.root)));
}

/** Exact-byte custody shared with historical proof retention. Archiving an
 * observation does not mint an execution receipt or qualify its verdict. */
export function createNativeArtifactPersister(evidenceRoot) {
  mkdirSync(evidenceRoot, { recursive: true });
  if (!lstatSync(evidenceRoot).isDirectory() || lstatSync(evidenceRoot).isSymbolicLink()) {
    throw new Error("NATIVE_TASK_RECEIPT_REFUSAL redirected artifact root");
  }
  const root = realpathSync(evidenceRoot);
  const persist = (bytes, suffix) => {
    if (!Buffer.isBuffer(bytes) || !/^[a-z][a-z0-9.-]*$/.test(suffix))
      throw new Error("NATIVE_TASK_RECEIPT_REFUSAL invalid artifact bytes or suffix");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const ref = `${sha256}.${suffix}`, path = join(root, ref);
    try { writeFileSync(path, bytes, { flag: "wx", mode: 0o600 }); } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    try {
      if (!readNativeArtifactBytes(path, bytes.length, bytes.length + 1).equals(bytes))
        throw new Error('different bytes');
    } catch {
      throw new Error("NATIVE_TASK_RECEIPT_REFUSAL artifact bytes differ or are redirected");
    }
    return { ref, sha256, byteLength: bytes.length };
  };
  return { root, persist };
}

// P002: custody is a byte archive, not a prospective execution receipt. The
// expected groups are supplied by the router before launch; observations may
// never silently replace that population with the subset which finished.
const custodyHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const legacyCustodyLimits = Object.freeze({ objects: 16384, bytes: 64 * 1024 * 1024, objectBytes: 16 * 1024 * 1024 });
const custodyFamilies = Object.freeze({
  A: Object.freeze({ objects: 4096, bytes: 16 * 1024 * 1024 }),
  B: Object.freeze({ objects: 8192, bytes: 24 * 1024 * 1024 }),
  C: Object.freeze({ objects: 2048, bytes: 12 * 1024 * 1024 }),
  D: Object.freeze({ objects: 1024, bytes: 4 * 1024 * 1024 }),
  auxiliary: Object.freeze({ objects: 1024, bytes: 8 * 1024 * 1024 }),
});
const custodyLimits = Object.freeze({ ...legacyCustodyLimits, referenceOccurrences: 65536, families: custodyFamilies });
// v3 keeps each segment under the existing IO/family limits. The archive has
// an independent finite population bound; rollover never admits a larger object.
// Oversized OUT files use multiple ordinary objects, with one sealed logical entry.
const custodyArchiveLimits = Object.freeze({ segments: 64, objects: custodyLimits.objects });
// Control metadata has the same finite aggregate read budget as before. Large
// reference inventories need ordinary bounded objects too, not a larger IO cap.
const custodyMetadataChunkBytes = 8 * 1024 * 1024;
const custodyMetadataParts = Math.ceil(custodyLimits.bytes / custodyMetadataChunkBytes);
const custodyFamilyKeys = ['A', 'B', 'C', 'D', 'auxiliary'];
function custodyProcessSourcesRequested(expected) {
  // Older independent contracts required all four families unconditionally.
  if (expected.processSources === undefined) return true;
  const { preload, workspace, root } = expected.processSources;
  // Producer: executed-config-load-capture.ts install() and termination hook.
  return preload === '1' && Boolean(workspace && expected.out && root && isAbsolute(root));
}
function custodyAccounting(budget) {
  return { bytesRead: budget.bytes, objectsRead: budget.objects,
    bytesReadByFamily: { ...budget.bytesByFamily }, objectsReadByFamily: { ...budget.objectsByFamily } };
}
function custodyBudget() {
  return { objects: 0, bytes: 0, objectsByFamily: { A: 0, B: 0, C: 0, D: 0, auxiliary: 0 },
    bytesByFamily: { A: 0, B: 0, C: 0, D: 0, auxiliary: 0 } };
}
function custodyDirectory(path, privateMode = false) {
  const full = resolve(path);
  for (let part = full;; part = dirname(part)) {
    const stat = lstatSync(part);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('custody redirected ancestor');
    if (part === dirname(part)) break;
  }
  const stat = lstatSync(full);
  if (realpathSync(full) !== full || privateMode && (stat.mode & 0o777) !== 0o700)
    throw new Error('custody nonprivate or redirected root');
  return full;
}
function custodyRead(path, budget, family = null, limits = custodyLimits) {
  custodyDirectory(dirname(path));
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (budget.private && (stat.mode & 0o777) !== 0o600))
    throw new Error('custody nonregular or nonprivate artifact');
  const familyLimit = family ? limits.families?.[family] : null;
  if (familyLimit && budget.objectsByFamily[family] + 1 > familyLimit.objects)
    throw new Error('custody ' + family + ' object limit');
  if (budget.objects + 1 > limits.objects) throw new Error('custody total object limit');
  if (stat.size > limits.objectBytes) throw new Error('custody object byte limit');
  if (familyLimit && budget.bytesByFamily[family] + stat.size + 1 > familyLimit.bytes)
    throw new Error('custody ' + family + ' byte limit');
  if (budget.bytes + stat.size + 1 > limits.bytes) throw new Error('custody total byte limit');
  budget.objects++;
  if (family) budget.objectsByFamily[family]++;
  const byteLimit = Math.min(limits.bytes - budget.bytes,
    familyLimit ? familyLimit.bytes - budget.bytesByFamily[family] : limits.bytes - budget.bytes);
  return readNativeArtifactBytes(path, stat.size, byteLimit, count => {
    budget.bytes += count;
    if (family) budget.bytesByFamily[family] += count;
  });
}
function custodyInventory(directory, objectLimit = custodyLimits.objects) {
  custodyDirectory(directory);
  const stat = lstatSync(directory), names = [];
  const handle = opendirSync(directory);
  try {
    for (let entry; (entry = handle.readSync()) !== null;) {
      if (names.length === objectLimit) throw new Error('custody inventory limit');
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('custody inventory nonregular entry');
      names.push(entry.name);
    }
  } finally { handle.closeSync(); }
  const after = lstatSync(directory);
  if (stat.dev !== after.dev || stat.ino !== after.ino || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs)
    throw new Error('custody inventory changed');
  return names.sort();
}
function custodyReferences(payload) {
  const occurrences = [], artifacts = new Map(), gaps = new Set();
  const scan = (rows, prefix, observation) => {
    if (rows === undefined) return;
    if (!Array.isArray(rows) || rows.length > 4096) throw new Error('custody observation population');
    rows.forEach((row, index) => {
      const value = observation(row);
      if (value === undefined) return;
      if (value?.schemaVersion !== 'vitest-evaluator-inputs-v1' ||
          value.scope !== 'vitest-inlined-evaluator-inputs' || value.basis !== 'before-evaluator-call')
        throw new Error('custody evaluator protocol');
      for (const role of ['entries', 'vmInputs']) {
        const pins = value[role] ?? (role === 'vmInputs' ? [] : null);
        if (!Array.isArray(pins)) throw new Error('custody evaluator population');
        pins.forEach((pin, i) => {
          if (occurrences.length === custodyLimits.referenceOccurrences) {
            gaps.add('evaluator-occurrence-limit');
            return;
          }
          if (!comparisonDigest(pin?.sha256) ||
              !Number.isSafeInteger(pin.byteLength) || pin.byteLength < 0 || typeof pin.codeRef !== 'string')
            throw new Error('custody evaluator reference malformed');
          const artifact = { codeRef: pin.codeRef, sha256: pin.sha256, byteLength: pin.byteLength };
          const known = artifacts.get(pin.codeRef);
          if (known && (known.sha256 !== artifact.sha256 || known.byteLength !== artifact.byteLength))
            throw new Error('custody evaluator reference conflict');
          if (!known) {
            if (artifacts.size === custodyLimits.families.B.objects) gaps.add('evaluator-artifact-limit');
            else artifacts.set(pin.codeRef, artifact);
          }
          occurrences.push({ location: `${prefix}/${index}/${role}/${i}`, ...pin });
        });
      }
    });
  };
  scan(payload.rows, '/rows', row => row?.moduleEvaluations);
  scan(payload.diagnostics, '/diagnostics', row => row?.moduleEvaluations);
  scan(payload.nativeRun?.files, '/nativeRun/files', row => row?.proof?.inputs?.moduleEvaluations);
  return { occurrences, artifacts: [...artifacts.values()], gaps: [...gaps] };
}
function custodyIdentity(identity) {
  if (!identity || !['workspace', 'harness', 'runId'].every(key => typeof identity[key] === 'string' && identity[key]))
    throw new Error('custody identity missing');
}
function custodyPopulation(expected) {
  if (!Array.isArray(expected) || !expected.length || expected.length > 4096 ||
      expected.some(group => !group || typeof group.id !== 'string' || !group.id ||
        !['primary', 'detail'].includes(group.attempt) || !Array.isArray(group.selected) ||
        !group.selected.length || !Array.isArray(group.auxiliary) ||
        !['vitest', 'node', 'unsupported'].includes(group.runner) || typeof group.armed !== 'boolean') ||
      new Set(expected.map(group => group.id)).size !== expected.length) throw new Error('custody expected population missing');
}

function custodyOutBytes(entry, read, allowPartial = false) {
  if (!entry.chunked) return read(entry.artifact);
  const { byteLength, sha256, complete, parts } = entry.chunked;
  if (!Number.isSafeInteger(byteLength) || byteLength < custodyFamilies.A.bytes ||
      byteLength > custodyFamilies.A.bytes * custodyArchiveLimits.segments ||
      !comparisonDigest(sha256) || typeof complete !== 'boolean' || !complete && !allowPartial ||
      !Array.isArray(parts) || !parts.length || parts.length > custodyArchiveLimits.objects ||
      JSON.stringify(entry.artifact) !== JSON.stringify(parts[0]?.artifact))
    throw new Error('custody OUT chunk population mismatch');
  let offset = 0;
  const hash = createHash('sha256'), chunks = [];
  for (const part of parts) {
    if (part.offset !== offset || !Number.isSafeInteger(part.artifact?.byteLength) ||
        part.artifact.byteLength <= 0 || part.artifact.byteLength > custodyLimits.objectBytes ||
        offset + part.artifact.byteLength > byteLength)
      throw new Error('custody OUT chunk offset or length mismatch');
    const bytes = read(part.artifact);
    if (bytes.length !== part.artifact.byteLength) throw new Error('custody OUT chunk length mismatch');
    offset += bytes.length; hash.update(bytes); chunks.push(bytes);
  }
  if (complete && offset !== byteLength || hash.digest('hex') !== sha256)
    throw new Error('custody OUT reassembly mismatch');
  return Buffer.concat(chunks, offset);
}

function persistCustodyManifest(store, manifest) {
  const bytes = Buffer.from(JSON.stringify(manifest));
  if (bytes.length <= custodyLimits.objectBytes) return store.persist(bytes, 'native-proof.json');
  if (bytes.length > custodyLimits.bytes) throw new Error('custody metadata byte limit');
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += custodyMetadataChunkBytes) {
    parts.push({ offset, artifact: store.persist(bytes.subarray(offset,
      offset + custodyMetadataChunkBytes), 'native-metadata-chunk') });
  }
  const index = Buffer.from(JSON.stringify({ schemaVersion: 'native-proof-index-v1',
    byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), parts }));
  // Reads charge the index, every part and each EOF sentinel to ONE budget.
  if (index.length + bytes.length + parts.length + 1 > custodyLimits.bytes)
    throw new Error('custody metadata byte limit');
  return store.persist(index, 'native-proof.json');
}

function readCustodyManifest(pin, read) {
  const budget = { objects: 0, bytes: 0, private: true };
  const value = JSON.parse(read(pin, budget).toString('utf8'));
  if (value.schemaVersion !== 'native-proof-index-v1') return value;
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength <= custodyLimits.objectBytes ||
      value.byteLength > custodyLimits.bytes || !comparisonDigest(value.sha256) ||
      !Array.isArray(value.parts) || !value.parts.length || value.parts.length > custodyMetadataParts)
    throw new Error('custody metadata index mismatch');
  const chunks = [], hash = createHash('sha256');
  let offset = 0;
  for (const part of value.parts) {
    if (part.offset !== offset || !Number.isSafeInteger(part.artifact?.byteLength) ||
        part.artifact.byteLength <= 0 || part.artifact.byteLength > custodyMetadataChunkBytes ||
        offset + part.artifact.byteLength > value.byteLength)
      throw new Error('custody metadata chunk mismatch');
    const bytes = read(part.artifact, budget);
    chunks.push(bytes); hash.update(bytes); offset += bytes.length;
  }
  if (offset !== value.byteLength || hash.digest('hex') !== value.sha256)
    throw new Error('custody metadata reassembly mismatch');
  return JSON.parse(Buffer.concat(chunks, offset).toString('utf8'));
}

/** Publish an immutable edition; failures preserve useful bytes and explicit gaps.
 * `expected` is the independent routing contract, including conditional objects.
 * Every auxiliary object needs a role and a producer-backed applicability state. */
export function retainNativeProofPacket(directory, input) {
  custodyIdentity(input.identity); custodyPopulation(input.expected);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const root = custodyDirectory(directory, true);
  const objectRoot = join(root, 'objects');
  mkdirSync(objectRoot, { mode: 0o700, recursive: true });
  custodyDirectory(objectRoot, true);
  const store = createNativeArtifactPersister(objectRoot), budget = custodyBudget(), gaps = [];
  const segments = [];
  const capture = (path, suffix = 'bytes', family = null, source = null) => {
    const size = source?.byteLength ?? lstatSync(path).size, limit = custodyLimits.families[family];
    if (size > custodyLimits.objectBytes) throw new Error('custody object byte limit');
    if (size + 1 > limit.bytes) throw new Error('custody ' + family + ' byte limit');
    if (budget.objects === custodyArchiveLimits.objects) throw new Error('custody archive object limit');
    let segment = segments.at(-1);
    if (!segment || segment.budget.bytes + size + 1 > custodyLimits.bytes ||
        segment.budget.objects + 1 > custodyLimits.objects ||
        segment.budget.bytesByFamily[family] + size + 1 > limit.bytes ||
        segment.budget.objectsByFamily[family] + 1 > limit.objects) {
      if (segments.length === custodyArchiveLimits.segments) throw new Error('custody archive segment limit');
      segment = { index: segments.length, budget: custodyBudget(), entries: [] };
      segments.push(segment);
    }
    const before = custodyAccounting(segment.budget);
    try {
      const bytes = source ? source.read(segment.budget) : custodyRead(path, segment.budget, family);
      const pin = { ...store.persist(bytes, suffix), segment: segment.index };
      segment.entries.push({ family, artifact: pin });
      return pin;
    } finally {
      budget.bytes += segment.budget.bytes - before.bytesRead;
      budget.objects += segment.budget.objects - before.objectsRead;
      for (const key of custodyFamilyKeys) {
        budget.bytesByFamily[key] += segment.budget.bytesByFamily[key] - before.bytesReadByFamily[key];
        budget.objectsByFamily[key] += segment.budget.objectsByFamily[key] - before.objectsReadByFamily[key];
      }
    }
  };
  const captureOut = (path, entry) => {
    const size = lstatSync(path).size;
    if (size <= custodyLimits.objectBytes && size + 1 <= custodyFamilies.A.bytes) {
      entry.entries.push({ original: path, artifact: capture(path, 'out.json', 'A') });
      return;
    }
    if (!Number.isSafeInteger(size) || size > custodyFamilies.A.bytes * custodyArchiveLimits.segments)
      throw new Error('custody OUT archive byte limit');
    const chunked = { byteLength: size, sha256: '', complete: false, parts: [] };
    const hash = createHash('sha256');
    try {
      withNativeArtifactFile(path, size, fd => {
        for (let offset = 0; offset < size;) {
          const byteLength = Math.min(8 * 1024 * 1024 - 1, size - offset);
          let retainedBytes;
          const artifact = capture(path, 'out-chunk', 'A', { byteLength, read(budget) {
            budget.objects++; budget.objectsByFamily.A++;
            const bytes = Buffer.alloc(byteLength);
            let length = 0;
            while (length < byteLength) {
              const count = readSync(fd, bytes, length, Math.min(64 * 1024, byteLength - length), null);
              budget.bytes += count; budget.bytesByFamily.A += count;
              if (!count) throw new Error('native artifact changed during capture');
              length += count;
            }
            retainedBytes = bytes;
            return bytes;
          } });
          // Keep successfully retained prefixes visible even if a later chunk fails.
          hash.update(retainedBytes);
          chunked.parts.push({ offset, artifact });
          if (chunked.parts.length === 1) entry.entries.push({ original: path, artifact, chunked });
          offset += byteLength;
        }
      });
      chunked.complete = true;
    } finally { chunked.sha256 = hash.digest('hex'); }
  };
  const observations = input.observations ?? [];
  if (observations.length !== input.expected.length || new Set(observations.map(row => row.id)).size !== observations.length)
    gaps.push('group-population-mismatch');
  const groups = input.expected.map(expected => {
    const observed = observations.find(row => row.id === expected.id);
    const group = { id: expected.id, attempt: expected.attempt, families: [], references: [],
      referenceArtifacts: [], referenceGaps: [], auxiliary: [],
      captureComplete: observed?.captureComplete ?? null };
    if (!observed || observed.out !== expected.out) gaps.push(`${expected.id}:group-binding-missing`);
    if (observed?.captureComplete === false) gaps.push(`${expected.id}:child-stream-capture-incomplete`);
    for (const [family, suffix] of [['A', ''], ['B', '.modules'], ['C', '.native-processes'], ['D', '.processes']]) {
      const entry = { family, state: 'unavailable', producer: expected.id, entries: [] };
      group.families.push(entry);
      if (!expected.armed || expected.runner !== 'vitest') {
        entry.state = expected.runner === 'vitest' ? 'not-requested' : 'not-applicable';
        entry.reason = expected.runner === 'vitest' ? 'reporter-not-armed' : `runner:${expected.runner}`;
        continue;
      }
      if (family === 'D' && !custodyProcessSourcesRequested(expected)) {
        entry.state = 'not-requested';
        entry.reason = 'process-source-preload-not-requested';
        continue;
      }
      try {
        if (!observed || !expected.out || !isAbsolute(expected.out)) throw new Error('producer-unavailable');
        const path = expected.out + suffix;
        if (family === 'A') {
          captureOut(path, entry);
          const payload = JSON.parse(custodyOutBytes(entry.entries[0], artifact =>
            readNativeArtifactBytes(join(objectRoot, artifact.ref), artifact.byteLength,
              custodyLimits.objectBytes)).toString('utf8'));
          const refs = custodyReferences(payload);
          group.references = refs.occurrences;
          group.referenceArtifacts = refs.artifacts;
          group.referenceGaps = refs.gaps;
          for (const reason of refs.gaps) gaps.push(expected.id + ':A:' + reason);
          for (const ref of group.referenceArtifacts)
            if (ref.codeRef !== join(resolve(`${expected.out}.modules`), `${ref.sha256}.js`))
              throw new Error('foreign-evaluator-reference');
          // These are observations only. Even a terminal reporter is not a
          // runtime closure or an acceptance decision.
          group.protocol = { checkpoint: payload.completionCheckpoint ?? null,
            nativeRun: { state: payload.nativeRun?.state ?? null, reason: payload.nativeRun?.reason ?? null,
              modulePopulationMatched: payload.nativeRun?.modulePopulationMatched ?? null }, status: 'unqualified' };
        } else {
          const names = custodyInventory(path);
          if (family === 'D' && names.length === 0) throw new Error('process-source-receipts-missing');
          for (const name of names) {
            const original = join(path, name), artifact = capture(original, 'bytes', family);
            // Retain even semantically rejected bytes; partial custody must
            // still reconcile with the segment's exact capture inventory.
            entry.entries.push({ original, artifact });
            if (family === 'C' && /^[a-f0-9]{64}\.(json|source|stream)$/.test(name) &&
                artifact.sha256 !== name.slice(0, 64)) throw new Error('native-artifact-digest');
            if (family === 'D' && name.endsWith('.pending')) gaps.push(`${expected.id}:process-writer-pending`);
          }
          if (JSON.stringify(custodyInventory(path)) !== JSON.stringify(names)) throw new Error('inventory-changed');
          if (family === 'B') for (const ref of group.referenceArtifacts) {
            const retained = entry.entries.find(row => row.original === ref.codeRef)?.artifact;
            if (!retained || retained.sha256 !== ref.sha256 || retained.byteLength !== ref.byteLength)
              throw new Error('referenced-evaluator-unavailable');
          }
        }
        entry.state = 'produced';
      } catch (error) {
        entry.reason = String(error?.code ?? error?.message ?? error);
        entry.state = entry.entries.length ? 'partial' : 'unavailable';
        gaps.push(expected.id + ':' + family + ':' + entry.reason);
      }
    }
    for (const spec of expected.auxiliary) {
      const entry = { ...spec };
      group.auxiliary.push(entry);
      try {
        if (!spec.role || !['produced', 'not-requested', 'not-produced', 'not-applicable', 'unavailable'].includes(spec.state))
          throw new Error('auxiliary-declaration-missing');
        if (spec.state === 'produced') entry.artifact = capture(spec.path, 'bytes', 'auxiliary');
        else if (!spec.reason || spec.state === 'unavailable' || spec.state === 'not-produced')
          throw new Error('auxiliary-unavailable-or-unsupported-absence');
      } catch (error) {
        entry.captureError = String(error?.code ?? error?.message ?? error);
        gaps.push(expected.id + ':' + spec.role + ':' + entry.captureError);
      }
    }
    return group;
  });
  const retainedSegments = segments.map(segment => ({ index: segment.index, ...custodyAccounting(segment.budget),
    artifact: store.persist(Buffer.from(JSON.stringify({ schemaVersion: 'native-proof-segment-v1',
      index: segment.index, entries: segment.entries })), 'native-segment.json') }));
  const manifest = { schemaVersion: 'native-proof-custody-v3', identity: input.identity,
    expected: input.expected, expectedHash: custodyHash(input.expected), groups, limits: custodyLimits,
    bytesRead: budget.bytes, bytesReadByFamily: budget.bytesByFamily,
    objectsRead: budget.objects, objectsReadByFamily: budget.objectsByFamily,
    segments: retainedSegments, archiveLimits: custodyArchiveLimits,
    gaps, predecessor: input.predecessor ?? null,
    verdicts: { custody: gaps.length ? 'partial' : 'complete', execution: input.execution ?? 'unknown',
      protocol: 'unqualified', producerRetirement: 'not-performed', cleanup: input.cleanup ?? 'unknown',
      nativeProof: 'unqualified', acceptance: 'unmeasured' } };
  const manifestPin = persistCustodyManifest(store, manifest);
  // Segment/manifest metadata is separately object-bounded, not capture content.
  for (const name of custodyInventory(objectRoot,
    custodyLimits.objects + custodyArchiveLimits.segments + custodyMetadataParts + 1)) {
    const fd = openSync(join(objectRoot, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  for (const path of [objectRoot, root, dirname(root)]) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  // Keep the producer's observed inventory and partial states in the original
  // locator. A newly sealed manifest cannot redefine which objects were captured.
  const locator = { manifest: manifestPin, identity: input.identity, expectedHash: manifest.expectedHash,
    inventoryHash: custodyHash({ groups, gaps, segments: retainedSegments }) };
  const verified = verifyNativeProofPacket(root, locator, { identity: input.identity, expected: input.expected });
  return { directory: root, locator, ...verified };
}

/** Consumer reads only retained objects. Callers MUST provide independently
 * expected identity/population; the manifest cannot declare its own success. */
export function verifyNativeProofPacket(directory, locator, contract) {
  custodyIdentity(contract?.identity); custodyPopulation(contract?.expected);
  const root = custodyDirectory(directory, true), objects = custodyDirectory(join(root, 'objects'), true);
  const budget = Object.assign(custodyBudget(), { private: true });
  const segmentBudgets = [], segmentEntries = [], consumedEntries = [];
  let segmented = false;
  let readLimits = custodyLimits;
  const read = (pin, readBudget = budget, family = null) => {
    if (!pin || !comparisonDigest(pin.sha256) || !Number.isSafeInteger(pin.byteLength) ||
        pin.byteLength < 0 || basename(pin.ref ?? '') !== pin.ref || !pin.ref.startsWith(`${pin.sha256}.`))
      throw new Error('custody invalid retained pin');
    if (segmented && family !== null) {
      if (!Number.isSafeInteger(pin.segment) || !segmentBudgets[pin.segment])
        throw new Error('custody retained segment missing');
      readBudget = segmentBudgets[pin.segment];
      consumedEntries[pin.segment].push({ family, artifact: pin });
    }
    const bytes = custodyRead(join(objects, pin.ref), readBudget, family, readLimits);
    if (bytes.length !== pin.byteLength || createHash('sha256').update(bytes).digest('hex') !== pin.sha256)
      throw new Error('custody retained bytes differ');
    return bytes;
  };
  // The producer's content budget excludes the manifest it writes afterward.
  // Apply the same accounting when consuming a partial packet at that limit;
  // Metadata parts share one bounded read budget; every object retains its
  // ordinary single-object bound. Legacy single-object manifests still work.
  const manifest = readCustodyManifest(locator.manifest, read);
  const legacy = manifest.schemaVersion === 'native-proof-custody-v1';
  segmented = manifest.schemaVersion === 'native-proof-custody-v3';
  const current = manifest.schemaVersion === 'native-proof-custody-v2' || segmented;
  readLimits = legacy ? legacyCustodyLimits : custodyLimits;
  if ((!legacy && !current) || JSON.stringify(manifest.limits) !== JSON.stringify(readLimits) ||
      JSON.stringify(manifest.identity) !== JSON.stringify(contract.identity) ||
      JSON.stringify(locator.identity) !== JSON.stringify(contract.identity) ||
      locator.expectedHash !== custodyHash(contract.expected) || manifest.expectedHash !== locator.expectedHash ||
      JSON.stringify(manifest.expected) !== JSON.stringify(contract.expected) ||
      !Array.isArray(manifest.groups) || manifest.groups.length !== contract.expected.length)
    throw new Error('custody identity or expected population mismatch');
  if (current) {
    const familyKeys = custodyFamilyKeys;
    const byteTotal = familyKeys.reduce((sum, key) => sum + manifest.bytesReadByFamily?.[key], 0);
    const objectTotal = familyKeys.reduce((sum, key) => sum + manifest.objectsReadByFamily?.[key], 0);
    if (familyKeys.some(key => !Number.isSafeInteger(manifest.bytesReadByFamily?.[key]) ||
        manifest.bytesReadByFamily[key] < 0 || manifest.bytesReadByFamily[key] > custodyLimits.families[key].bytes * (segmented ? custodyArchiveLimits.segments : 1) ||
        !Number.isSafeInteger(manifest.objectsReadByFamily?.[key]) ||
        manifest.objectsReadByFamily[key] < 0 || manifest.objectsReadByFamily[key] > custodyLimits.families[key].objects * (segmented ? custodyArchiveLimits.segments : 1)) ||
        byteTotal !== manifest.bytesRead || objectTotal !== manifest.objectsRead)
      throw new Error('custody family budget accounting mismatch');
  }
  if (segmented) {
    if (JSON.stringify(manifest.archiveLimits) !== JSON.stringify(custodyArchiveLimits) ||
        !Array.isArray(manifest.segments) || manifest.segments.length > custodyArchiveLimits.segments ||
        !Number.isSafeInteger(manifest.objectsRead) || manifest.objectsRead > custodyArchiveLimits.objects)
      throw new Error('custody archive population mismatch');
    const sums = custodyBudget();
    for (const [index, segment] of manifest.segments.entries()) {
      if (segment.index !== index || !Number.isSafeInteger(segment.bytesRead) || segment.bytesRead < 0 ||
          segment.bytesRead > custodyLimits.bytes || !Number.isSafeInteger(segment.objectsRead) ||
          segment.objectsRead < 0 || segment.objectsRead > custodyLimits.objects)
        throw new Error('custody segment budget mismatch');
      let bytes = 0, objects = 0;
      for (const key of custodyFamilyKeys) {
        const nbytes = segment.bytesReadByFamily?.[key], nobjects = segment.objectsReadByFamily?.[key];
        if (!Number.isSafeInteger(nbytes) || nbytes < 0 || nbytes > custodyFamilies[key].bytes ||
            !Number.isSafeInteger(nobjects) || nobjects < 0 || nobjects > custodyFamilies[key].objects)
          throw new Error('custody segment family budget mismatch');
        bytes += nbytes; objects += nobjects;
        sums.bytesByFamily[key] += nbytes; sums.objectsByFamily[key] += nobjects;
      }
      if (bytes !== segment.bytesRead || objects !== segment.objectsRead)
        throw new Error('custody segment accounting mismatch');
      sums.bytes += bytes; sums.objects += objects;
      const metadata = JSON.parse(read(segment.artifact, { objects: 0, bytes: 0, private: true }).toString('utf8'));
      if (metadata.schemaVersion !== 'native-proof-segment-v1' || metadata.index !== index ||
          !Array.isArray(metadata.entries) || metadata.entries.length > custodyLimits.objects)
        throw new Error('custody segment inventory mismatch');
      segmentBudgets.push(Object.assign(custodyBudget(), { private: true }));
      segmentEntries.push(metadata.entries); consumedEntries.push([]);
    }
    if (JSON.stringify(custodyAccounting(sums)) !== JSON.stringify({ bytesRead: manifest.bytesRead,
      objectsRead: manifest.objectsRead, bytesReadByFamily: manifest.bytesReadByFamily,
      objectsReadByFamily: manifest.objectsReadByFamily })) throw new Error('custody archive accounting mismatch');
  }
  if (!comparisonDigest(locator.inventoryHash) ||
      custodyHash({ groups: manifest.groups, gaps: manifest.gaps,
        ...(segmented ? { segments: manifest.segments } : {}) }) !== locator.inventoryHash)
    throw new Error('custody captured inventory mismatch');
  for (const expected of contract.expected) {
    const group = manifest.groups.find(row => row.id === expected.id);
    if (!group || group.attempt !== expected.attempt || group.families.length !== 4 ||
        new Set(group.families.map(row => row.family)).size !== 4 ||
        !['A', 'B', 'C', 'D'].every(family => group.families.some(row => row.family === family)) ||
        group.auxiliary.length !== expected.auxiliary.length) throw new Error('custody missing group or family');
    const groupGap = manifest.gaps.includes(expected.id + ':child-stream-capture-incomplete');
    const familyGap = family => manifest.gaps.some(gap => gap.startsWith(expected.id + ':' + family + ':'));
    if (group.captureComplete === false && !groupGap) throw new Error('custody incomplete child capture');
    let reporter;
    for (const family of group.families) {
      if (!Array.isArray(family.entries)) throw new Error('custody inventory missing');
      if (family.family === 'A' && family.state === 'produced' &&
          (family.entries.length !== 1 || typeof expected.out !== 'string' || !isAbsolute(expected.out) ||
           family.entries[0]?.original !== expected.out))
        throw new Error('custody produced OUT inventory mismatch');
      for (const [index, entry] of family.entries.entries()) {
        if (entry.chunked && (!segmented || family.family !== 'A' || index !== 0 || family.entries.length !== 1))
          throw new Error('custody unsupported chunked entry');
        const bytes = entry.chunked
          ? custodyOutBytes(entry, pin => read(pin, budget, family.family), family.state !== 'produced')
          : read(entry.artifact, budget, family.family);
        if (family.family === 'A' && index === 0) reporter = bytes;
      }
      const processNotRequested = segmented && expected.armed && expected.runner === 'vitest' &&
        family.family === 'D' && !custodyProcessSourcesRequested(expected);
      if (processNotRequested && (family.state !== 'not-requested' || family.entries.length ||
          family.reason !== 'process-source-preload-not-requested')) throw new Error('custody process applicability mismatch');
      if (family.state !== 'produced' && !processNotRequested && expected.armed && expected.runner === 'vitest' &&
          !familyGap(family.family) && !groupGap)
        throw new Error('custody unsupported family absence');
    }
    const out = group.families.find(row => row.family === 'A').entries[0];
    if (out && group.families.find(row => row.family === 'A').state === 'produced') {
      // Validate the exact bytes already read above; charging another read can
      // reject a correctly retained packet near the bounded capture limit.
      const refs = custodyReferences(JSON.parse(reporter.toString('utf8')));
      if (JSON.stringify(refs.occurrences) !== JSON.stringify(group.references))
        throw new Error('custody reference occurrences missing');
      if (current && (JSON.stringify(refs.artifacts) !== JSON.stringify(group.referenceArtifacts) ||
          JSON.stringify(refs.gaps) !== JSON.stringify(group.referenceGaps)))
        throw new Error('custody reference artifact population missing');
      const retainedByOriginal = new Map(group.families.find(row => row.family === 'B').entries
        .map(row => [row.original, row.artifact]));
      for (const ref of refs.artifacts) {
        const pin = retainedByOriginal.get(ref.codeRef);
        if (!pin || pin.sha256 !== ref.sha256 || pin.byteLength !== ref.byteLength) {
          if (!familyGap('B')) throw new Error('custody evaluator mapping missing');
        }
      }
    }
    expected.auxiliary.forEach((spec, index) => {
      const entry = group.auxiliary[index];
      if (JSON.stringify(spec) !== JSON.stringify(Object.fromEntries(Object.entries(entry)
        .filter(([key]) => key !== 'artifact' && key !== 'captureError'))))
        throw new Error('custody auxiliary declaration mismatch');
      if (entry.artifact) read(entry.artifact, budget, 'auxiliary');
      else if (spec.state === 'produced' && !familyGap(spec.role))
        throw new Error('custody auxiliary bytes missing');
    });
  }
  if (segmented) for (let index = 0; index < segmentEntries.length; index++) {
    if (JSON.stringify(segmentEntries[index]) !== JSON.stringify(consumedEntries[index]))
      throw new Error('custody segment captured inventory mismatch');
    const actual = custodyAccounting(segmentBudgets[index]), declared = manifest.segments[index];
    if (actual.bytesRead > declared.bytesRead || actual.objectsRead > declared.objectsRead ||
        custodyFamilyKeys.some(key => actual.bytesReadByFamily[key] > declared.bytesReadByFamily[key] ||
          actual.objectsReadByFamily[key] > declared.objectsReadByFamily[key]))
      throw new Error('custody segment capture accounting understated');
  }
  if (manifest.verdicts.nativeProof !== 'unqualified' || manifest.verdicts.acceptance !== 'unmeasured' ||
      manifest.verdicts.protocol !== 'unqualified' || manifest.verdicts.custody !== (manifest.gaps.length ? 'partial' : 'complete'))
    throw new Error('custody verdict conflation');
  return { status: manifest.verdicts.custody, verified: true, manifest };
}

export function writeBudgetedTaskNativeExecutionReceipt(evidenceRoot, input) {
  if (!input || typeof input.task !== "string" || !input.task ||
      typeof input.attempt !== "string" || !input.attempt ||
      typeof input.cwd !== "string" || !isAbsolute(input.cwd) ||
      !Array.isArray(input.command) || !input.command.length || !input.command[0] ||
      !input.command.every(word => typeof word === "string") ||
      !(input.originalCommand == null || typeof input.originalCommand === "string") ||
      !(input.invocation === undefined || input.invocation &&
        Array.isArray(input.invocation.command) && input.invocation.command.length > 0 &&
        input.invocation.command.every(word => typeof word === "string") &&
        /^[a-f0-9]{64}$/.test(input.invocation.environmentSha256)) ||
      !Number.isSafeInteger(input.startedAtMs) || !Number.isSafeInteger(input.finishedAtMs) ||
      input.finishedAtMs < input.startedAtMs ||
      !(input.exitCode === null || Number.isSafeInteger(input.exitCode)) ||
      !(input.signal === null || typeof input.signal === "string") ||
      !(input.error === null || typeof input.error === "string") ||
      typeof input.captureComplete !== "boolean" ||
      !Buffer.isBuffer(input.stdout) || !Buffer.isBuffer(input.stderr)) {
    throw new Error("NATIVE_TASK_RECEIPT_REFUSAL malformed native child observation");
  }
  const { root, persist } = createNativeArtifactPersister(evidenceRoot);
  const validInputs = rows => Array.isArray(rows) && rows.length > 0 &&
    rows.every(row => row && comparisonPath(row.path) && comparisonDigest(row.sha256)) &&
    new Set(rows.map(row => row.path)).size === rows.length;
  const before = validInputs(input.before) ? structuredClone(input.before) : null;
  const after = validInputs(input.after) ? structuredClone(input.after) : null;
  const canonical = rows => rows?.slice().sort((a, b) => a.path.localeCompare(b.path));
  const sourceInputsUnchanged = before !== null && after !== null &&
    JSON.stringify(canonical(before)) === JSON.stringify(canonical(after));
  const logs = { stdout: persist(input.stdout, "stdout"), stderr: persist(input.stderr, "stderr") };
  // Bind prospective process events to this actual child pid and time interval.
  // Preserve all matching invocations; never turn the observed subset into an
  // original ordered-chain qualification or silently infer shell-only steps.
  const processTrace = { scope: "partial-node-processes", events: [], streams: [], population: null, gaps: [
    "shell-builtins-and-non-node-entries-unobserved", "private-or-sync-spawns-unobserved",
    "direct-fd-native-and-inherited-stream-writes-unobserved", "runtime-inputs-unobserved",
    "signal-exits-may-lack-node-exit",
  ] };
  if (input.processTrace && Number.isSafeInteger(input.processTrace.rootPid) &&
      input.processTrace.rootPid > 0 && typeof input.processTrace.out === "string") {
    try {
      // A shared OUT directory can contain many processes' diagnostics. Keep
      // the original artifact ceiling without allocating the whole directory
      // or erasing a useful authenticated subset when the population is larger.
      // Directory order is not chronology: truncated observations certify only
      // the retained events, never the unseen suffix or an ordered chain.
      const { sourceRoot, rows, population } = readNativeProcessTraceArtifacts(input.processTrace.out,
        input.startedAtMs, input.finishedAtMs);
      processTrace.population = population;
      if (!population.complete)
        processTrace.gaps.push(`native-process-population-truncated:${population.truncatedBy}`);
      const pids = new Set([input.processTrace.rootPid]);
      for (let changed = true; changed;) {
        changed = false;
        for (const { row } of rows) {
          const pid = row.event === "node-entry" && pids.has(row.ppid) ? row.pid :
            row.event === "child-spawn" && pids.has(row.pid) ? row.childPid : null;
          if (Number.isSafeInteger(pid) && pid > 0 && !pids.has(pid)) { pids.add(pid); changed = true; }
        }
      }
      const selected = rows.filter(({ row }) => pids.has(row.pid))
        .sort((a, b) => a.row.atMs - b.row.atMs || a.bytes.compare(b.bytes));
      if (!selected.some(({ row }) => row.event === "node-entry" && row.pid === input.processTrace.rootPid)) {
        if (population.complete) throw new Error("native process root entry absent");
        processTrace.gaps.push("native-process-root-entry-unobserved");
      }
      processTrace.events = selected.map(({ row, bytes }) => ({ ...row,
        artifact: persist(bytes, "process-event.json") }));
      let streamBytesRead = 0;
      for (const { row } of selected.filter(({ row }) => row.event === "node-exit")) {
        if (row.exitListenersComplete !== true)
          processTrace.gaps.push(`native-exit-listeners-unverified:${row.processIdentity}`);
        for (const role of ["stdout", "stderr"]) {
          const pin = row.streams?.[role];
          if (!pin || pin.artifactUnavailable) {
            processTrace.gaps.push(`native-stream-unobserved:${row.processIdentity}:${role}`);
            continue;
          }
          if (pin.scope !== "node-writable-call-inputs" || !comparisonDigest(pin.sha256) ||
              pin.ref !== `${pin.sha256}.stream` || !Number.isSafeInteger(pin.byteLength) ||
              pin.byteLength < 0 || pin.byteLength > 16 * 1024 * 1024 ||
              !Number.isSafeInteger(pin.observedByteLength) || pin.observedByteLength < pin.byteLength ||
              typeof pin.captureComplete !== "boolean" ||
              pin.captureComplete && pin.observedByteLength !== pin.byteLength)
            throw new Error("malformed native stream artifact pin");
          const file = join(sourceRoot, pin.ref);
          const remaining = 64 * 1024 * 1024 - streamBytesRead;
          if (pin.byteLength > remaining)
            throw new Error("redirected, oversized or incomplete native stream artifact");
          const bytes = readNativeArtifactBytes(file, pin.byteLength, remaining,
            count => { streamBytesRead += count; });
          if (createHash("sha256").update(bytes).digest("hex") !== pin.sha256)
            throw new Error("native stream artifact hash mismatch");
          processTrace.streams.push({ processIdentity: row.processIdentity, pid: row.pid, role,
            scope: pin.scope, observedByteLength: pin.observedByteLength,
            captureComplete: pin.captureComplete, artifact: persist(bytes, "native-stream") });
          if (!pin.captureComplete)
            processTrace.gaps.push(`native-stream-truncated:${row.processIdentity}:${role}`);
        }
      }
      const exits = new Set(selected.filter(({ row }) => row.event === "node-exit")
        .map(({ row }) => JSON.stringify([row.pid, row.processIdentity])));
      for (const { row } of selected.filter(({ row }) => row.event === "node-entry")) {
        if (!exits.has(JSON.stringify([row.pid, row.processIdentity])))
          processTrace.gaps.push(`native-stream-terminal-unobserved:${row.processIdentity}`);
      }
      if (selected.some(({ row }) => ["trace-limit", "trace-event-too-large"].includes(row.event)))
        processTrace.gaps.push("native-process-observation-truncated");
    } catch (error) {
      processTrace.events = [];
      processTrace.streams = [];
      processTrace.gaps.push(`native-process-trace-unreadable:${String(error?.message ?? error)}`);
    }
  } else processTrace.gaps.push("native-process-trace-unobserved");
  // Retain only references on already selected process/load observations. A
  // rejected sidecar leaves that authenticated diagnostic trace available.
  const loaderSources = processTrace.loaderSources = { scope: 'referenced-loader-source',
    status: 'unobserved', referenceLimit: 4096, artifactByteLimit: 16 * 1024 * 1024,
    totalByteLimit: 64 * 1024 * 1024, referencesVisited: 0, bytesRead: 0,
    bytesRetained: 0, entries: [], gaps: [] };
  const loads = processTrace.events.filter(row => row.event === 'module-load-return');
  const sourceGaps = new Set(), retainedSources = new Map();
  if (!loads.length) sourceGaps.add('native-loader-source-observations-unobserved');
  if (loads.length > loaderSources.referenceLimit) sourceGaps.add('native-loader-source-reference-limit');
  for (const row of loads.slice(0, loaderSources.referenceLimit)) {
    loaderSources.referencesVisited++;
    try {
      const pin = row.source;
      if (!pin || pin.status !== 'hashed' || pin.artifactUnavailable || !pin.ref)
        throw new Error('source-unobserved-or-unavailable');
      if (pin.scope !== 'node-loader-returned-source' || !comparisonDigest(pin.sha256) ||
          pin.ref !== `${pin.sha256}.source` || !Number.isSafeInteger(pin.byteLength) ||
          pin.byteLength < 0 || pin.byteLength > loaderSources.artifactByteLimit ||
          !Number.isSafeInteger(row.loadId) || row.loadId < 1 ||
          typeof row.url !== 'string' || !row.url.startsWith('file:'))
        throw new Error('malformed-or-oversized-reference');
      let artifact = retainedSources.get(pin.sha256);
      if (artifact && artifact.byteLength !== pin.byteLength) throw new Error('length-mismatch');
      if (!artifact) {
        const remaining = loaderSources.totalByteLimit - loaderSources.bytesRead;
        if (pin.byteLength > remaining) throw new Error('total-byte-limit');
        const path = `${input.processTrace.out}.native-processes`, directory = lstatSync(path);
        if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('redirected-directory');
        const sourceRoot = realpathSync(path), file = join(sourceRoot, pin.ref);
        const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let bytes;
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.size !== pin.byteLength) throw new Error('length-or-file-type-mismatch');
          const buffer = Buffer.alloc(Math.min(pin.byteLength + 1, remaining));
          let length = 0, count;
          while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null)) > 0) {
            length += count;
            loaderSources.bytesRead += count; // Rejected bytes consume the same IO budget.
          }
          const after = fstatSync(fd), current = lstatSync(file), rootAfter = lstatSync(path);
          if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs ||
              after.ctimeMs !== stat.ctimeMs || current.isSymbolicLink() ||
              current.dev !== stat.dev || current.ino !== stat.ino ||
              rootAfter.isSymbolicLink() || rootAfter.dev !== directory.dev || rootAfter.ino !== directory.ino ||
              realpathSync(path) !== sourceRoot)
            throw new Error('changed-during-capture');
          bytes = buffer.subarray(0, length);
        } finally { closeSync(fd); }
        if (createHash('sha256').update(bytes).digest('hex') !== pin.sha256) throw new Error('digest-mismatch');
        artifact = persist(bytes, 'loader-source');
        retainedSources.set(pin.sha256, artifact);
        loaderSources.bytesRetained += bytes.length;
      }
      loaderSources.entries.push({ processIdentity: row.processIdentity, pid: row.pid,
        loadId: row.loadId, url: row.url, artifact });
    } catch (error) { sourceGaps.add(`native-loader-source-rejected:${error?.code ?? error?.message ?? 'unknown'}`); }
  }
  loaderSources.gaps = [...sourceGaps];
  loaderSources.status = loads.length ? (sourceGaps.size ? 'partial' : 'retained') : 'unobserved';
  if (sourceGaps.size) processTrace.gaps.push('native-loader-sources-incomplete');
  // Derive only the root npm process's direct exported spawn/close spans. A
  // descendant inherits npm's lifecycle labels too; those labels alone cannot
  // identify a lifecycle shell or turn its inherited output into step logs.
  const npmLifecycle = processTrace.npmLifecycle = { scope: "direct-root-npm-spawn-close",
    status: "unknown", root: null, spans: [], gaps: ["lifecycle-population-unqualified",
      "lifecycle-shell-streams-unobserved", "lifecycle-step-reports-unobserved"] };
  try {
    const npmName = word => typeof word === "string" && ["npm", "npm-cli.js"].includes(basename(word));
    if (input.command.length !== 3 || !npmName(input.command[0]) ||
        !["run", "run-script"].includes(input.command[1]) || !input.command[2])
      throw new Error("unsupported original npm invocation");
    const events = processTrace.events;
    const entries = events.filter(row => row.event === "node-entry" && row.pid === input.processTrace?.rootPid);
    if (entries.length !== 1) throw new Error("root npm entry absent or ambiguous");
    const entry = entries[0], script = input.command[2];
    if (!entry.processIdentity || entry.cwd !== input.cwd || !Array.isArray(entry.argv) ||
        entry.argv.length !== 4 || !npmName(entry.argv[1]) ||
        entry.argv[2] !== input.command[1] || entry.argv[3] !== script ||
        !Number.isSafeInteger(entry.atMs)) throw new Error("root npm invocation differs");
    npmLifecycle.root = { pid: entry.pid, processIdentity: entry.processIdentity, entry: entry.artifact };
    if (processTrace.population?.complete !== true) npmLifecycle.gaps.push("root-observation-population-incomplete");
    const direct = events.filter(row => row.event === "child-spawn" && row.pid === entry.pid);
    const key = row => JSON.stringify([row.processIdentity, row.pid, row.childIdentity, row.childPid]);
    const spawns = new Map(), closes = new Map(), phases = new Map();
    for (const row of direct) {
      spawns.set(key(row), (spawns.get(key(row)) ?? 0) + 1);
      const phase = row.lifecycle?.event;
      phases.set(phase, (phases.get(phase) ?? 0) + 1);
    }
    for (const row of events.filter(row => row.event === "child-close" && row.pid === entry.pid)) {
      const matches = closes.get(key(row)) ?? [];
      matches.push(row); closes.set(key(row), matches);
    }
    const candidates = [];
    for (const spawn of direct) {
      const close = closes.get(key(spawn)) ?? [];
      if (spawn.processIdentity !== entry.processIdentity || typeof spawn.childIdentity !== "string" ||
          !spawn.childIdentity || !Number.isSafeInteger(spawn.childPid) || spawn.childPid <= 0 ||
          typeof spawn.command !== "string" || !spawn.command || !Array.isArray(spawn.argv) ||
          !spawn.argv.every(word => typeof word === "string") ||
          typeof spawn.cwd !== "string" || !isAbsolute(spawn.cwd) ||
          !["boolean", "string"].includes(typeof spawn.shell) ||
          typeof spawn.stdioAccessible?.stdout !== "boolean" ||
          typeof spawn.stdioAccessible?.stderr !== "boolean" ||
          ![`pre${script}`, script, `post${script}`].includes(spawn.lifecycle?.event) ||
          typeof spawn.lifecycle?.script !== "string" || !spawn.lifecycle.script ||
          spawn.argv.length !== 2 || spawn.argv[0] !== "-c" || spawn.argv[1] !== spawn.lifecycle.script ||
          !Number.isSafeInteger(spawn.atMs) || spawn.atMs < entry.atMs) {
        npmLifecycle.gaps.push("malformed-or-unbound-direct-lifecycle-spawn"); continue;
      }
      if (spawns.get(key(spawn)) !== 1 || phases.get(spawn.lifecycle.event) !== 1 || close.length !== 1) {
        npmLifecycle.gaps.push("absent-or-ambiguous-direct-lifecycle-pair"); continue;
      }
      const end = close[0];
      if (!Number.isSafeInteger(end.atMs) || end.atMs < spawn.atMs ||
          !(end.code === null || Number.isSafeInteger(end.code) && end.code >= 0) ||
          !(end.signal === null || typeof end.signal === "string" && end.signal.length > 0) ||
          end.code === null && end.signal === null) {
        npmLifecycle.gaps.push("malformed-direct-lifecycle-close"); continue;
      }
      candidates.push({ event: spawn.lifecycle.event, script: spawn.lifecycle.script,
        observerPid: entry.pid, observerProcessIdentity: entry.processIdentity,
        childPid: spawn.childPid, childIdentity: spawn.childIdentity,
        command: spawn.command, argv: spawn.argv.slice(), cwd: spawn.cwd, shell: spawn.shell,
        stdioAccessible: { ...spawn.stdioAccessible }, startedAtMs: spawn.atMs, closedAtMs: end.atMs,
        exitCode: end.code, signal: end.signal, spawn: spawn.artifact, close: end.artifact });
    }
    for (const [identity] of closes) if (!spawns.has(identity)) npmLifecycle.gaps.push("unpaired-direct-lifecycle-close");
    npmLifecycle.spans = candidates.filter((row, index) => {
      const overlap = candidates.some((other, otherIndex) => otherIndex !== index &&
        row.startedAtMs < other.closedAtMs && other.startedAtMs < row.closedAtMs);
      if (overlap) npmLifecycle.gaps.push("overlapping-direct-lifecycle-spans");
      return !overlap;
    });
    if (npmLifecycle.spans.length) npmLifecycle.status = "observed";
    else npmLifecycle.gaps.push("direct-lifecycle-spans-unobserved");
  } catch (error) {
    npmLifecycle.gaps.push(`native-npm-lifecycle-unbound:${String(error?.message ?? error)}`);
  }
  npmLifecycle.gaps = [...new Set(npmLifecycle.gaps)];
  // OUT is a reporter callback artifact, not a standalone receipt or pass token.
  // The ordered reader may qualify it only after binding it to the observed npm
  // lifecycle, the reporter process, complete stream artifacts and source census.
  // Keep its failures independent from otherwise useful process observations.
  const reporter = processTrace.reporter = { status: "unknown", artifact: null, process: null,
    gaps: ["reporter-evaluator-sidecars-not-retained"] };
  try {
    if (!input.processTrace || typeof input.processTrace.out !== "string")
      throw new Error("output path unobserved");
    const path = input.processTrace.out;
    if (realpathSync(dirname(path)) !== resolve(dirname(path)))
      throw new Error("redirected output directory");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes;
    try {
      const stat = fstatSync(fd), limit = 16 * 1024 * 1024;
      if (!stat.isFile() || stat.size > limit) throw new Error("non-file or oversized output");
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0, count;
      while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null)) > 0)
        length += count;
      const after = fstatSync(fd), current = lstatSync(path);
      if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs ||
          after.ctimeMs !== stat.ctimeMs || current.isSymbolicLink() ||
          current.dev !== stat.dev || current.ino !== stat.ino)
        throw new Error("output changed or redirected during capture");
      bytes = buffer.subarray(0, length);
    } finally { closeSync(fd); }
    const payload = JSON.parse(bytes.toString("utf8")), run = payload?.nativeRun;
    if (!run || run.schemaVersion !== "native-vitest-run-v1" || run.scope !== "vitest-reporter-callbacks" ||
        !Number.isSafeInteger(run.pid) || run.pid <= 0 || !Number.isSafeInteger(run.ppid) || run.ppid <= 0 ||
        !Number.isSafeInteger(run.startedAtMs) || !Number.isSafeInteger(run.finishedAtMs) ||
        run.startedAtMs < input.startedAtMs || run.finishedAtMs < run.startedAtMs ||
        run.finishedAtMs > input.finishedAtMs || !Array.isArray(run.files) ||
        !["onTestRunEnd", "onExit"].includes(run.terminalHook) ||
        ![null, "passed", "failed", "interrupted"].includes(run.reason))
      throw new Error("malformed or out-of-interval reporter observation");
    const events = processTrace.events;
    const entries = events.filter(row => row.event === "node-entry" && row.pid === run.pid);
    if (entries.length !== 1 || entries[0].ppid !== run.ppid || entries[0].atMs > run.startedAtMs)
      throw new Error("reporter process entry absent, unrelated or ambiguous");
    const entry = entries[0];
    const exits = events.filter(row => row.event === "node-exit" && row.pid === run.pid &&
      row.processIdentity === entry.processIdentity);
    if (exits.length > 1 || exits.some(row => row.atMs < run.finishedAtMs))
      throw new Error("reporter interval outside observed process lifetime");
    let lifecycle = null;
    if (run.pid !== input.processTrace.rootPid) {
      const spans = [];
      for (const spawn of events.filter(row => row.event === "child-spawn" &&
        (row.childPid === run.pid && row.pid === run.ppid || row.childPid === run.ppid))) {
        const closes = events.filter(row => row.event === "child-close" &&
          row.pid === spawn.pid && row.processIdentity === spawn.processIdentity &&
          row.childPid === spawn.childPid && row.childIdentity === spawn.childIdentity);
        if (closes.length === 1 && spawn.atMs <= entry.atMs && closes[0].atMs >= run.finishedAtMs)
          spans.push({ spawn: spawn.artifact, close: closes[0].artifact,
            childPid: spawn.childPid, childIdentity: spawn.childIdentity });
      }
      if (spans.length !== 1) throw new Error("reporter lifecycle span absent or ambiguous");
      lifecycle = spans[0];
    }
    reporter.artifact = persist(bytes, "native-vitest-out.json");
    reporter.process = { pid: run.pid, ppid: run.ppid, processIdentity: entry.processIdentity,
      entry: entry.artifact, exit: exits[0]?.artifact ?? null, lifecycle,
      startedAtMs: run.startedAtMs, finishedAtMs: run.finishedAtMs };
    reporter.status = "bound";
    if (!exits.length) reporter.gaps.push("reporter-process-terminal-unobserved");
    reporter.evaluatorArtifacts = retainReporterEvaluatorArtifacts(payload, path, persist);
    if (reporter.evaluatorArtifacts.status !== "unobserved") {
      reporter.gaps = reporter.gaps.filter(gap => gap !== "reporter-evaluator-sidecars-not-retained");
      if (reporter.evaluatorArtifacts.status === "partial") reporter.gaps.push("reporter-evaluator-sidecars-partial");
    }
  } catch (error) {
    reporter.gaps.push(`native-vitest-out-unbound:${String(error?.message ?? error)}`);
  }
  const receipt = { schemaVersion: 1, kind: "affected-task-native-execution", task: input.task,
    attempt: input.attempt, originalCommand: input.originalCommand ?? null,
    ...(input.currentExecution ? { currentExecution: structuredClone(input.currentExecution) } : {}),
    execution: { command: input.command.slice(), cwd: input.cwd,
      ...(input.invocation ? { invocation: { command: input.invocation.command.slice(),
        environmentSha256: input.invocation.environmentSha256 } } : {}),
      startedAtMs: input.startedAtMs, finishedAtMs: input.finishedAtMs,
      childWallMs: input.finishedAtMs - input.startedAtMs,
      exitCode: input.exitCode, signal: input.signal, error: input.error,
      captureComplete: input.captureComplete, logs },
    before: { inputs: before }, after: { inputs: after }, sourceInputsUnchanged,
    processTrace, steps: [], orderedChainQualified: false, runtimeClosure: "unmeasured",
    gaps: ["original-step-boundaries-unobserved", "executable-resolution-unobserved",
      "installed-dependency-runtime-closure-unobserved",
      ...(!sourceInputsUnchanged ? ["wrapper-inputs-unknown-or-changed"] : []),
      ...(!input.captureComplete ? ["raw-stream-capture-incomplete"] : [])],
    operationalAcceptance: false };
  const pin = persist(Buffer.from(JSON.stringify(receipt)), "receipt.json");
  return freezeComparison({ root, receipt: pin, logs, observation: receipt });
}

/**
 * R12 preparation only: pin one ORIGINAL, fully enumerated gate selection and the
 * same source/dependencies/task partition for both sides. Never discovers a population
 * from a 32-file calibration, admits a cohort, or changes the gate's default policy.
 * Selection/source/dependency refs must be resolved by the native producer before
 * these inputs can become operational evidence. The pure checker cannot attest IO.
 */
export function prepareBudgetedTaskComparison(input) {
  const data = structuredClone(input);
  const { selection, source, tasks, baseline, candidate, envelope, estimates } = data;
  const require = (condition, message) => {
    if (!condition) throw new Error(`COMPARISON_INPUT_REFUSAL ${message}`);
  };
  require(selection?.kind === "full-gate" && selection.coverage === "complete" &&
    Array.isArray(selection.unenumerated) && selection.unenumerated.length === 0 &&
    typeof selection.originalRef === "string" && selection.originalRef.trim() &&
    comparisonDigest(selection.originalSha256), "original complete full-gate selection required");
  // File-only comparison receipts cannot certify source guards, lifecycle checks
  // or shell aggregates. Preserve their original obligations until a native
  // command-receipt contract qualifies them; never silently project them away.
  const noCommandObligations = value => value === undefined ||
    (Array.isArray(value) && value.length === 0);
  const fileOnlyTask = task => noCommandObligations(task.commandObligations) &&
    noCommandObligations(task.lifecycleCommands);
  require(noCommandObligations(selection.commandObligations) &&
    (!Array.isArray(selection.tasks) || selection.tasks.every(fileOnlyTask)) &&
    (!Array.isArray(tasks) || tasks.every(fileOnlyTask)),
  "native original command-obligation receipts required");
  // This reader still certifies one file execution per task. Ordered repeated
  // checks/runs require independently measured step receipts, even when their
  // union looks exactly like the legacy partition. Keep native occurrence
  // metadata when it is a one-to-one file-only population; never deduplicate it.
  const fileOnlyOccurrences = rows => rows === undefined || (Array.isArray(rows) &&
    rows.every(row => row && row.kind === 'test-file' && comparisonPath(row.file) &&
      typeof row.task === 'string' && typeof row.command === 'string' && row.command.trim() &&
      (row.step === null || Number.isSafeInteger(row.step) && row.step >= 0)) &&
    new Set(rows.map(row => row.file)).size === rows.length &&
    JSON.stringify(rows.map(row => row.file).sort()) === JSON.stringify(selection.files?.slice().sort()) &&
    rows.every(row => tasks?.some(task => task.id === row.task && task.files?.includes(row.file))));
  require(fileOnlyOccurrences(selection.fileOccurrences),
    "native original command-step occurrence receipts required");
  require(/^[a-f0-9]{40}$/.test(source?.commit ?? "") &&
    comparisonDigest(source.receiptSha256) && comparisonDigest(source.dependencySha256) &&
    comparisonDigest(source.runtimeClosureSha256), "immutable source/dependency/runtime closure required");
  require(Array.isArray(selection.files) && selection.files.length > 0 &&
    selection.files.every(comparisonPath) && new Set(selection.files).size === selection.files.length,
  "full file population must be nonempty, unique and repository-relative");
  selection.files.sort();
  require(Array.isArray(source.files) && source.files.length > 0 &&
    source.files.every((row) => comparisonPath(row.path) && comparisonDigest(row.sha256)) &&
    new Set(source.files.map((row) => row.path)).size === source.files.length &&
    selection.files.every((file) => source.files.some((row) => row.path === file)),
  "source receipt must contain every selected file without duplicate paths");
  source.files.sort((a, b) => a.path.localeCompare(b.path));
  require(Array.isArray(tasks) && tasks.length > 1 &&
    tasks.every((task) => typeof task.id === "string" && task.id.trim() &&
      Array.isArray(task.files) && task.files.length > 0 && task.files.every(comparisonPath)) &&
    new Set(tasks.map((task) => task.id)).size === tasks.length,
  "distinct nonempty tasks required");
  const partition = tasks.flatMap((task) => task.files).sort();
  require(JSON.stringify(partition) === JSON.stringify(selection.files),
    "task partition must equal the full selection exactly once");
  require(Array.isArray(estimates) && estimates.length === tasks.length &&
    new Set(estimates.map((row) => row.task)).size === tasks.length &&
    tasks.every((task) => estimates.some((row) => row.task === task.id &&
      Number.isFinite(row.ms) && row.ms > 0 && comparisonDigest(row.originalSha256) &&
      typeof row.originalRef === "string" && row.originalRef.trim())),
  "original total-child-wall estimates required for every task");
  require(envelope && ["hardMemoryMb", "pidsMax", "heapMb"].every((key) =>
    Number.isSafeInteger(envelope[key]) && envelope[key] > 0), "finite hard envelope required");
  require(baseline && candidate && JSON.stringify(Object.keys(baseline).sort()) ===
    JSON.stringify(Object.keys(candidate).sort()) &&
    Object.keys(baseline).filter((key) => key !== "maxConcurrentTasks").every((key) =>
      JSON.stringify(baseline[key]) === JSON.stringify(candidate[key])) &&
    candidate.maxConcurrentTasks > baseline.maxConcurrentTasks,
  "only the explicit task ceiling may differ between sides");
  for (const policy of [baseline, candidate]) {
    const resolved = resolveTaskBudget(policy);
    require(resolved.maxConcurrentTasks === policy.maxConcurrentTasks &&
      resolved.effectiveWorkerBudget === policy.workerBudget &&
      policy.workerMemoryMb >= envelope.heapMb && policy.memoryBudgetMb < envelope.hardMemoryMb &&
      policy.taskCgroupPidsMax === envelope.pidsMax,
    "policy exceeds measured memory/worker/PID envelope");
  }
  const payload = { schemaVersion: 1, kind: "budgeted-task-comparison", selection, source,
    tasks, baseline, candidate, envelope, estimates,
    order: ["baseline:1", "candidate:1", "candidate:2", "baseline:2"],
    fileSetSha256: comparisonHash(selection.files) };
  return freezeComparison({ ...payload, manifestSha256: comparisonHash(payload) });
}

/**
 * Read-only qualification of the complete four original cohort receipts. Readers
 * must independently resolve all refs/hashes and raw child/cgroup observations;
 * passing this PURE function alone is never a native operational receipt.
 * Queue waits are excluded only after validating every acquired wait. Incomplete,
 * skipped, substituted, OOM, drifted or unknown-runtime runs cannot be a baseline.
 */
export function evaluateBudgetedTaskComparison(manifest, cohorts) {
  try { return evaluateResolvedBudgetedTaskComparison(manifest, cohorts); }
  catch (error) {
    return { assertions: [
      "immutable-full-gate-comparison-inputs", "complete-original-abba-cohort-population",
      "unchanged-contained-no-skip-paired-headroom-longest-first-cohorts",
      "full-identical-file-set-at-most-half-baseline-wall",
    ].map((name) => ({ name, passed: false })), baselineWallMs: null, candidateWallMs: null,
    ratio: null, operationalAcceptance: false, fileSetSha256: null,
    qualificationError: error instanceof Error ? error.message : String(error) };
  }
}

function evaluateResolvedBudgetedTaskComparison(manifest, cohorts) {
  const assertions = [];
  const check = (name, passed) => assertions.push({ name, passed: Boolean(passed) });
  const { manifestSha256, ...payload } = manifest ?? {};
  let prepared = null;
  try { prepared = prepareBudgetedTaskComparison(payload); } catch { /* fail closed */ }
  const pinned = prepared && comparisonDigest(manifestSha256) &&
    comparisonHash(payload) === manifestSha256 && prepared.manifestSha256 === manifestSha256;
  check("immutable-full-gate-comparison-inputs", pinned);
  const rows = Array.isArray(cohorts) ? cohorts : [];
  const complete = pinned && rows.length === 4 &&
    rows.every((row, index) => `${row.side}:${row.repeat}` === prepared.order[index]) &&
    new Set(rows.map((row) => row.runId)).size === 4 &&
    rows.every((row) => typeof row.runId === "string" && row.runId.trim() &&
      typeof row.originalRef === "string" && row.originalRef.trim() && comparisonDigest(row.originalSha256));
  check("complete-original-abba-cohort-population", complete);
  let qualified = Boolean(complete);
  const executionWalls = [];
  const observedMaxTasksBySide = { baseline: [], candidate: [] };
  for (const row of rows) {
    if (!pinned) { qualified = false; break; }
    const policy = row.side === "baseline" ? prepared.baseline : prepared.candidate;
    const children = Array.isArray(row.children) ? row.children : [];
    const waits = Array.isArray(row.acquiredWaitsMs) ? row.acquiredWaitsMs : [];
    const queuedMs = waits.reduce((sum, wait) => sum + wait, 0);
    let valid = row.manifestSha256 === manifestSha256 && row.sourceUnchanged === true &&
      row.sourceReceiptSha256 === prepared.source.receiptSha256 &&
      row.dependencySha256 === prepared.source.dependencySha256 &&
      row.runtimeClosureSha256 === prepared.source.runtimeClosureSha256 &&
      JSON.stringify(row.policy) === JSON.stringify(policy) &&
      JSON.stringify(row.envelope) === JSON.stringify(prepared.envelope) &&
      Number.isSafeInteger(row.wallMs) && row.wallMs > 0 &&
      Array.isArray(row.acquiredWaitsMs) && waits.length > 0 &&
      waits.every((wait) => Number.isSafeInteger(wait) && wait >= 0) &&
      Number.isSafeInteger(queuedMs) && queuedMs < row.wallMs &&
      row.executionWallMs === row.wallMs - queuedMs &&
      Number.isSafeInteger(row.memory?.pairedSamples) && row.memory.pairedSamples > 0 &&
      Number.isFinite(row.memory?.maxAnonPerAllocatedWorkerMb) && row.memory.maxAnonPerAllocatedWorkerMb > 0 &&
      row.memory.maxAnonPerAllocatedWorkerMb <= policy.workerMemoryMb &&
      row.memory.oomKills === 0 && row.stats?.memoryReadings > 0 &&
      Number.isFinite(row.stats?.lastMemAvailableMb) && row.stats.lastMemAvailableMb > 0 &&
      row.stats.observedMaxWorkers <= policy.workerBudget && row.stats.observedMaxWorkers > 0 &&
      row.stats.observedMaxTasks <= policy.maxConcurrentTasks && row.stats.observedMaxTasks > 0 &&
      Number.isFinite(row.stats.observedMaxMemoryMb) && row.stats.observedMaxMemoryMb > 0 &&
      row.stats.observedMaxMemoryMb <= policy.memoryBudgetMb &&
      children.length === prepared.tasks.length &&
      new Set(children.map((child) => child.task)).size === prepared.tasks.length;
    const remaining = new Map(prepared.tasks.map((task) => [task.id,
      prepared.estimates.find((estimate) => estimate.task === task.id).ms]));
    for (const child of children) {
      const task = prepared.tasks.find((task) => task.id === child.task);
      const observations = Array.isArray(child.cgroupObservations) ? child.cgroupObservations : [];
      const tokens = Object.fromEntries([...(child.resultLine ?? "").matchAll(/([A-Za-z]+)=([^\s]+)/g)]
        .map((match) => [match[1], match[2]]));
      const allowed = child.lane === "primary" ? Math.max(...remaining.values()) :
        child.lane === "reserved" ? Math.min(...remaining.values()) : null;
      valid &&= Boolean(task && remaining.has(child.task) && remaining.get(child.task) === allowed &&
        JSON.stringify(child.files?.slice().sort()) === JSON.stringify(task.files.slice().sort()) &&
        child.code === 0 && child.signal === null && Number.isSafeInteger(child.childWallMs) && child.childWallMs > 0 &&
        comparisonDigest(child.originalSha256) && typeof child.originalRef === "string" && child.originalRef.trim() &&
        tokens.status === "passed" && Number(tokens.requested) === task.files.length &&
        Number(tokens.executed) === task.files.length && Number(tokens.matched) === task.files.length &&
        tokens.skippedTests === "0" && tokens.childSubstituted === "0" &&
        typeof child.expectedCgroup === "string" && child.expectedCgroup.trim() &&
        typeof child.runGroup === "string" && child.runGroup.trim() &&
        Number.isSafeInteger(child.deadlineEpochMs) && child.deadlineEpochMs > 0 &&
        observations.length > 0 && observations.some((observation) => observation.vitestFork === true && observation.phase === "preload") &&
        observations.every((observation) => Number.isSafeInteger(observation.pid) && observation.pid > 0 &&
          observation.cgroupPath === child.expectedCgroup && observation.runGroup === child.runGroup &&
          Number(observation.deadlineEpochMs) === child.deadlineEpochMs));
      remaining.delete(child.task);
    }
    qualified &&= valid;
    if (row.side in observedMaxTasksBySide)
      observedMaxTasksBySide[row.side].push(row.stats?.observedMaxTasks);
    executionWalls.push(row.wallMs - queuedMs);
  }
  // R12's measured concurrency clause is distinct from the configured ceiling: a receipt that
  // merely repeats a larger candidate maxConcurrentTasks can still hide a serial scheduler. The
  // candidate must demonstrate a higher observed task concurrency than the baseline population;
  // otherwise the longest-first and ratio checks do not prove raised headroom was exercised.
  const baselineObservedMaxTasks = Math.max(...observedMaxTasksBySide.baseline.map(Number));
  const measuredHeadroom = Boolean(complete) &&
    observedMaxTasksBySide.baseline.every(Number.isSafeInteger) &&
    observedMaxTasksBySide.candidate.every(observed => Number.isSafeInteger(observed) &&
      observed > baselineObservedMaxTasks && observed <= prepared.candidate.maxConcurrentTasks);
  qualified &&= measuredHeadroom;
  check("unchanged-contained-no-skip-paired-headroom-longest-first-cohorts", qualified);
  const baselineWallMs = qualified ? executionWalls[0] + executionWalls[3] : null;
  const candidateWallMs = qualified ? executionWalls[1] + executionWalls[2] : null;
  const ratio = qualified ? candidateWallMs / baselineWallMs : null;
  const repeatRatios = qualified ? [executionWalls[1] / executionWalls[0], executionWalls[2] / executionWalls[3]] : [];
  // Preserve each repeat instead of hiding one slow candidate in an aggregate.
  // The final rubric's statistical semantics still require outside-lineage review.
  check("full-identical-file-set-at-most-half-baseline-wall", ratio !== null && ratio <= 0.5 &&
    repeatRatios.every((value) => value <= 0.5));
  return { assertions, baselineWallMs, candidateWallMs, ratio,
    repeatRatios, operationalAcceptance: false, fileSetSha256: pinned ? prepared.fileSetSha256 : null };
}

// Bound actual IO and allocation, including rejected inputs. Read only the size
// observed on one regular descriptor, then reject mutation or path replacement.
async function readBoundedComparisonFile(path) {
  const byteLimit = 64 * 1024 * 1024;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("Comparison input must be a regular file");
    if (before.size > BigInt(byteLimit)) throw new Error("Original artifact exceeded read budget");
    const bytes = Buffer.alloc(Number(before.size));
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, Math.min(64 * 1024, bytes.length - length), null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (length !== bytes.length || after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs ||
        !current.isFile() || current.dev !== before.dev || current.ino !== before.ino ||
        current.size !== before.size || current.mtimeNs !== before.mtimeNs ||
        current.ctimeNs !== before.ctimeNs || await realpath(path) !== path)
      throw new Error("Comparison input changed during read");
    return bytes;
  } finally { await handle.close(); }
}

/** Resolve pinned ORIGINAL files before evaluation; never accepts caller-loaded receipts. */
export async function readBudgetedTaskComparisonArtifacts(evidenceRoot, pins) {
  const root = await realpath(evidenceRoot);
  const readPinned = async (ref, sha256, json = true) => {
    if (!comparisonPath(ref) || !comparisonDigest(sha256)) throw new Error("Invalid original artifact pin");
    const path = await realpath(join(root, ref));
    const within = relative(root, path);
    if (!within || isAbsolute(within) || within === ".." || within.startsWith("../"))
      throw new Error("Original artifact escaped evidence root");
    const bytes = await readBoundedComparisonFile(path);
    if (createHash("sha256").update(bytes).digest("hex") !== sha256)
      throw new Error(`Original artifact hash mismatch: ${ref}`);
    return json ? JSON.parse(bytes.toString("utf8")) : bytes;
  };
  if (pins.mode === "command-preparation")
    return readOriginalCommandPreparation(readPinned, pins, root);
  const manifest = await readPinned(pins.manifest.ref, pins.manifest.sha256);
  // Check structural identity before following refs supplied by an invalid manifest.
  const prepared = prepareBudgetedTaskComparison(manifest);
  if (prepared.manifestSha256 !== manifest.manifestSha256)
    throw new Error("Comparison manifest identity mismatch");
  const selection = await readPinned(manifest.selection.originalRef, manifest.selection.originalSha256);
  if ((selection.commandObligations !== undefined &&
       (!Array.isArray(selection.commandObligations) || selection.commandObligations.length)) ||
      (Array.isArray(selection.tasks) && selection.tasks.some(task =>
        ['commandObligations', 'lifecycleCommands'].some(key => task[key] !== undefined &&
          (!Array.isArray(task[key]) || task[key].length)))))
    throw new Error("Original command obligations were omitted from comparison receipts");
  if (JSON.stringify(selection.fileOccurrences) !== JSON.stringify(manifest.selection.fileOccurrences))
    throw new Error("Original command-step file occurrences were omitted or changed");
  // Legacy original artifacts may lack fileOccurrences but still retain steps.
  // Even distinct files do not prove those commands ran in their original order.
  if (Array.isArray(selection.tasks) && selection.tasks.some(task =>
    Array.isArray(task.steps) && task.steps.length > 1))
    throw new Error("Original ordered command-step population requires native step receipts");
  if (selection.kind !== "full-gate" || selection.coverage !== "complete" ||
    !Array.isArray(selection.unenumerated) || selection.unenumerated.length !== 0 ||
    JSON.stringify(selection.files?.slice().sort()) !== JSON.stringify(manifest.selection.files))
    throw new Error("Original full-gate selection differs from comparison manifest");
  const source = await readPinned(pins.source.ref, manifest.source.receiptSha256);
  if (source.schemaVersion !== "verifier-source-v1" || source.sourceCommit !== manifest.source.commit ||
    JSON.stringify(source.files?.map((row) => ({ path: row.path, sha256: row.sha256 }))
      .sort((a, b) => a.path.localeCompare(b.path))) !== JSON.stringify(manifest.source.files))
    throw new Error("Original source census differs from comparison manifest");
  await readPinned(pins.dependencies.ref, manifest.source.dependencySha256, false);
  const closure = await readPinned(pins.runtimeClosure.ref, manifest.source.runtimeClosureSha256);
  if (closure.status !== "complete" || closure.sourceCommit !== manifest.source.commit ||
    JSON.stringify(closure.files?.slice().sort()) !== JSON.stringify(manifest.selection.files))
    throw new Error("Original runtime closure is incomplete or mismatched");
  for (const estimate of manifest.estimates) {
    const original = await readPinned(estimate.originalRef, estimate.originalSha256);
    if (original.task !== estimate.task || original.childWallMs !== estimate.ms)
      throw new Error("Original total child wall differs from frozen estimate");
  }
  if (!Array.isArray(pins.cohorts) || pins.cohorts.length !== 4)
    throw new Error("Four original cohort pins required");
  const cohorts = [];
  for (const pin of pins.cohorts) {
    const cohort = await readPinned(pin.ref, pin.sha256);
    // The file's own hash/ref is injected from measured bytes, not self-referential JSON.
    cohort.originalRef = pin.ref; cohort.originalSha256 = pin.sha256;
    for (const child of cohort.children ?? []) {
      const original = await readPinned(child.originalRef, child.originalSha256);
      const { originalRef, originalSha256, ...fields } = child;
      // Object key order is serialization detail; compare the actual projected fields.
      if (Object.keys(original).length !== Object.keys(fields).length ||
        Object.entries(fields).some(([key, value]) => JSON.stringify(original[key]) !== JSON.stringify(value)))
        throw new Error("Original child receipt differs from cohort projection");
    }
    cohorts.push(cohort);
  }
  return { manifest, cohorts, originalArtifactsResolved: true,
    populationSha256: comparisonHash({ manifest, cohorts }) };
}

// Standalone command-local preparation is deliberately a separate branch of the
// existing IO reader. It never turns a partial selection into a comparison
// manifest, admits a cohort, or attests installed dependencies/runtime closure.
async function readOriginalCommandPreparation(readPinned, pins, evidenceRoot) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const require = (ok, message) => {
    if (!ok) throw new Error(`COMMAND_PREPARATION_REFUSAL ${message}`);
  };
  const marker = (bytes, prefix) => {
    const lines = bytes.toString("utf8").split(/\r?\n/).filter(line => line.startsWith(prefix));
    require(lines.length === 1, `exactly one ${prefix} marker required`);
    return JSON.parse(lines[0].slice(prefix.length));
  };
  const selectionBytes = await readPinned(pins.selection.ref, pins.selection.sha256, false);
  const selection = marker(selectionBytes, "AFFECTED_TESTS_SELECTION=");
  require(selection.schemaVersion === 1 && selection.kind === "full-gate" &&
    Array.isArray(selection.commandObligations) && Array.isArray(selection.tasks) &&
    Array.isArray(selection.fileOccurrences), "original native selection required");
  require(Array.isArray(pins.commands) && (pins.commands.length > 0 || pins.chains?.length > 0) &&
    pins.commands.length <= 64,
    "bounded original command pins required");
  const sourceRoot = await realpath(pins.repositoryRoot);
  const readCurrentInput = async input => {
    const path = await realpath(join(sourceRoot, input.path));
    const within = relative(sourceRoot, path);
    require(within && !isAbsolute(within) && within !== ".." && !within.startsWith("../"),
      "command source escaped repository root");
    const bytes = await readBoundedComparisonFile(path);
    require(createHash("sha256").update(bytes).digest("hex") === input.sha256,
      `current command input differs: ${input.path}`);
    return bytes;
  };
  const matchCurrentInputs = async inputs => {
    for (const input of inputs) await readCurrentInput(input);
  };
  const qualified = [];
  const identities = new Set();
  for (const pin of pins.commands) {
    require(typeof pin.task === "string" && (pin.step === null ||
      Number.isSafeInteger(pin.step) && pin.step >= 0), "explicit original task and step required");
    const identity = JSON.stringify([pin.task, pin.step]);
    require(!identities.has(identity), "duplicate original command step");
    identities.add(identity);
    const originals = selection.commandObligations.filter(row => row.task === pin.task &&
      (row.step ?? null) === pin.step);
    require(originals.length === 1, "exact original command obligation required");
    const obligation = originals[0];
    // Add another maintained native format only when its raw execution and
    // diagnostics have an independently measured contract. Unknown formats fail.
    const desktop = obligation.kind === "command-check" && obligation.check === "desktop-selftest-aggregate";
    const fixture = obligation.kind === "npm-lifecycle" && obligation.script === "pretest" &&
      obligation.command === "node scripts/build.mjs";
    const astro = obligation.kind === "command-check" && obligation.check === "astro-check" &&
      obligation.command === "astro check";
    const voice = obligation.kind === "command-check" && obligation.check === "el-tools-drift" &&
      obligation.command === "node scripts/el-tools-check.mjs";
    const nested = fixture || astro;
    require(desktop || fixture || astro || voice,
      "unsupported native command receipt format");
    const tasks = selection.tasks.filter(task => task.id === pin.task);
    require(tasks.length === 1, "exact original task required");
    const task = tasks[0];
    const step = pin.step === null ? task : task.steps?.[pin.step];
    require(step && (fixture ? task.lifecycleCommands?.some(row => row.script === obligation.script &&
      row.command === obligation.command) : step.command === obligation.command),
    "original ordered command differs");
    const occurrences = selection.fileOccurrences.filter(row => row.task === pin.task &&
      (row.step ?? null) === pin.step && row.command === obligation.command);
    const inputs = obligation.inputs;
    require(Array.isArray(inputs) && inputs.length > 0 && inputs.every(row =>
      comparisonPath(row.path) && comparisonDigest(row.sha256)) &&
      new Set(inputs.map(row => row.path)).size === inputs.length &&
      (fixture || voice ? occurrences.length === 0 : occurrences.length > 0) &&
      new Set(occurrences.map(row => row.file)).size === occurrences.length &&
      occurrences.every(row => row.kind === (astro ? "check-input" : "test-file") && row.command === obligation.command &&
        inputs.some(input => input.path === row.file)), "original input occurrences differ");
    if (voice) {
      // This historical native command has a Codex CommandExecution event,
      // not a standalone receipt. Resolve the original JSONL event itself;
      // an agent-authored projection is insufficient execution evidence.
      require(pin.nativeEvent && typeof pin.nativeEvent.sessionId === "string" &&
        typeof pin.nativeEvent.eventId === "string", "original native voice event pin required");
      const transcript = await readPinned(pin.receipt.ref, pin.receipt.sha256, false);
      const events = transcript.toString("utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
        .filter(row => row.type === "event_msg" && row.payload?.type === "item_completed" &&
          row.payload.item?.type === "CommandExecution" && row.payload.item.id === pin.nativeEvent.eventId);
      require(events.length === 1, "exact original native voice execution event required");
      const { payload } = events[0], item = payload.item;
      const logs = {}, paths = {};
      for (const role of ["stdout", "stderr", "beforeStdout", "afterStdout"]) {
        const log = pin.logs?.[role];
        require(log && /^[A-Za-z0-9_./-]+$/.test(join(evidenceRoot, log.ref)),
          "original voice log path required");
        paths[role] = join(evidenceRoot, log.ref);
        logs[role] = await readPinned(log.ref, log.sha256, false);
      }
      require(Object.keys(pin.logs).length === 4 && new Set(Object.values(paths)).size === 4,
        "four distinct original voice logs required");
      const shell = [
        `${obligation.command} --print-selection > ${paths.beforeStdout}`,
        `${obligation.command} > ${paths.stdout} 2> ${paths.stderr}`,
        "voice_status=$?",
        `${obligation.command} --print-selection > ${paths.afterStdout}`,
        "selection_status=$?",
        "printf 'voice_exit=%s selection_exit=%s\\n' \"$voice_status\" \"$selection_status\"",
        "exit \"$voice_status\"",
      ].join("\n");
      const nativeExecutionWallMs = payload.completed_at_ms - payload.started_at_ms;
      require(payload.thread_id === pin.nativeEvent.sessionId &&
        item.cwd === pathToFileURL(join(sourceRoot, task.dir)).href &&
        same(item.command, ["/bin/bash", "-lc", shell]) && item.source === "unified_exec_startup" &&
        item.status === "completed" && item.exit_code === 0 &&
        item.aggregated_output === "voice_exit=0 selection_exit=0\n" &&
        Number.isSafeInteger(payload.started_at_ms) && Number.isSafeInteger(payload.completed_at_ms) &&
        nativeExecutionWallMs > 0, "successful original native voice command and ordering required");
      const before = marker(logs.beforeStdout, "COMMAND_CHECK_SELECTION=");
      const after = marker(logs.afterStdout, "COMMAND_CHECK_SELECTION=");
      require(same(before, after) && before.schemaVersion === 1 && before.kind === "command-check-inputs" &&
        before.check === obligation.check && same(before.files, []) && same(before.inputs, inputs) &&
        before.executed === false && before.runtimeClosure === "unmeasured" &&
        before.operationalAcceptance === false, "unchanged original voice input census required");
      const result = logs.stdout.toString("utf8").match(
        /^\[el-tools-check\] ✓ aligned — ([1-9]\d*) client tools, all backed by registry defs\.\r?\n$/);
      require(result && logs.stderr.length === 0, "complete original aligned voice result required");
      await matchCurrentInputs(inputs);
      qualified.push({ task: pin.task, step: pin.step, kind: obligation.kind, check: obligation.check,
        command: obligation.command, inputs, fileOccurrences: occurrences, receipt: pin.receipt,
        startedAtMs: payload.started_at_ms, finishedAtMs: payload.completed_at_ms,
        nativeEvent: pin.nativeEvent, childWallMs: null, nativeExecutionWallMs,
        durationScope: "discovery-and-command", scriptsExecuted: 0, scriptOrder: [],
        voiceResult: { clientTools: Number(result[1]) } });
      continue;
    }
    require(!pin.nativeEvent, "native event pin does not match receipt format");
    const receipt = await readPinned(pin.receipt.ref, pin.receipt.sha256);
    const execution = nested ? receipt.execution : receipt;
    const finishedAt = nested ? execution?.completedAt : receipt.finishedAt;
    const childWallMs = nested ? Date.parse(finishedAt) - Date.parse(execution?.startedAt) : receipt.childWallMs;
    require((nested ? receipt.kind === "original-native-command-execution" :
      receipt.schemaVersion === 1 && receipt.kind === "original-command-execution") &&
      receipt.cwd === task.dir && same(execution?.command, fixture ? ["node", "scripts/build.mjs"] :
        astro ? ["npm", "run", "check"] : ["bash", "bin/lib/run-selftests.sh"]) &&
      (astro ? same(receipt.originalCommand, ["astro", "check"]) &&
        same(receipt.wrapperCommand, execution.command) && execution.signal === null && execution.error === null :
        obligation.command === execution.command.join(" ")) && execution.exitCode === 0 &&
      Number.isFinite(childWallMs) && childWallMs > 0 &&
      Number.isFinite(Date.parse(execution.startedAt)) &&
      Date.parse(finishedAt) > Date.parse(execution.startedAt),
    "successful original native command identity required");
    require(nested || Array.isArray(receipt.logs) && receipt.logs.length === 6 &&
      new Set(receipt.logs.map(row => row.path)).size === 6, "six original command logs required");
    const logs = {};
    for (const role of ["stdout", "stderr", "beforeStdout", "beforeStderr", "afterStdout", "afterStderr"]) {
      const log = pin.logs?.[role];
      const phase = role.startsWith("before") ? receipt.before : role.startsWith("after") ? receipt.after : execution;
      const stagePath = nested ? phase?.[role.toLowerCase().endsWith("stdout") ? "stdout" : "stderr"] : null;
      require(log && (nested ? typeof stagePath === "string" &&
        ((stagePath.startsWith("~/") ? stagePath.slice(2) : stagePath) === log.ref ||
          stagePath === join(evidenceRoot, log.ref)) :
        receipt.logs.some(row => (row.path.startsWith("~/") ? row.path.slice(2) : row.path) ===
          log.ref && row.sha256 === log.sha256)), "log pin absent from original receipt");
      logs[role] = await readPinned(log.ref, log.sha256, false);
    }
    require(new Set(Object.values(pin.logs).map(log => log.ref)).size === 6,
      "command log roles must be distinct");
    const census = bytes => {
      if (!astro) return marker(bytes, "COMMAND_CHECK_SELECTION=");
      const result = marker(bytes, "PC_VITEST_CONFIG_CONTRACTS=").results;
      require(Array.isArray(result) && result.length === 1 && result[0].ok === true &&
        result[0].enumerated === true && result[0].config?.runner === "astro-check" &&
        result[0].sync?.status === "completed" && result[0].sync?.beforePopulation === true &&
        result[0].executed === false && result[0].runtimeClosure === "unmeasured" &&
        result[0].operationalAcceptance === false, "completed original Astro input discovery required");
      // Discovery timing is diagnostic data, not population identity.
      const { diagnostics, ...population } = result[0];
      return population;
    };
    const before = census(logs.beforeStdout);
    const after = census(logs.afterStdout);
    require(astro ? same(before, after) && logs.beforeStderr.equals(logs.afterStderr) &&
      same(before.inputs, inputs) && same(before.config, obligation.discovery?.config) &&
      same(before.repositoryFiles, obligation.discovery?.repositoryFiles) &&
      same(occurrences.map(row => row.file).sort(), before.repositoryFiles?.slice().sort()) :
      logs.beforeStderr.length === 0 && logs.afterStderr.length === 0 &&
      same(before, after) && (fixture || same(before, receipt.before) && same(after, receipt.after)) &&
      before.schemaVersion === 1 && before.kind === "command-check-inputs" &&
      before.check === (fixture ? "fixture-build" : obligation.check) &&
      same(before.inputs, inputs), "unchanged original command census required");
    if (nested) {
      const discoveryCommand = astro ? receipt.before?.command :
        ["node", "scripts/build.mjs", "--print-selection", "--repository-root", sourceRoot];
      require(!astro || Array.isArray(discoveryCommand) && discoveryCommand.length === 3 &&
        typeof discoveryCommand[0] === "string" && isAbsolute(discoveryCommand[0]) &&
        /\/node$/.test(discoveryCommand[0]) && discoveryCommand[1] === "scripts/resolve-vitest-config-contracts.mjs" &&
        discoveryCommand[2] === "--astro-selection-child" &&
        [receipt.before, receipt.after].every(phase => phase.signal === null && phase.error === null),
      "original Astro discovery command required");
      require(same(receipt.before.command, discoveryCommand) && same(receipt.after.command, discoveryCommand) &&
        receipt.before.exitCode === 0 && receipt.after.exitCode === 0 &&
        Date.parse(receipt.before.startedAt) <= Date.parse(receipt.before.completedAt) &&
        Date.parse(receipt.before.completedAt) <= Date.parse(execution.startedAt) &&
        Date.parse(finishedAt) <= Date.parse(receipt.after.startedAt) &&
        Date.parse(receipt.after.startedAt) <= Date.parse(receipt.after.completedAt) &&
        (astro || same(before.files, [])), "original discovery/execution ordering required");
    }
    await matchCurrentInputs(inputs);
    let diagnostics;
    if (astro) {
      const packagePath = `${task.dir}/package.json`;
      require(inputs.some(input => input.path === packagePath), "pinned original Astro wrapper script required");
      const pkg = JSON.parse((await readCurrentInput(inputs.find(input => input.path === packagePath))).toString("utf8"));
      require(pkg.scripts?.check === obligation.command, "original npm check wrapper mapping differs");
      const stdout = logs.stdout.toString("utf8");
      const summaries = [...stdout.matchAll(/^Result \((\d+) files\):[ \t]*\r?$/gm)];
      const counters = name => [...stdout.matchAll(new RegExp(`^- (\\d+) ${name}\\r?$`, "gm"))];
      const errors = counters("errors"), warnings = counters("warnings"), hints = counters("hints");
      require(stdout.split(/\r?\n/).filter(line => line === "> astro check").length === 1 &&
        summaries.length === 1 && Number(summaries[0][1]) === before.repositoryFiles.length &&
        errors.length === 1 && warnings.length === 1 && hints.length === 1 && Number(errors[0][1]) === 0 &&
        summaries[0].index < errors[0].index && errors[0].index < warnings[0].index && warnings[0].index < hints[0].index,
      "complete original Astro diagnostics required");
      diagnostics = { filesChecked: Number(summaries[0][1]), errors: 0,
        warnings: Number(warnings[0][1]), hints: Number(hints[0][1]) };
    }
    const verdicts = [...logs.stdout.toString("utf8").matchAll(/^--- ([^\r\n]+): (PASS|FAIL|SKIP)$/gm)]
      .map(match => ({ script: match[1], verdict: match[2] }));
    require(astro || (fixture ? logs.stdout.toString("utf8").split(/\r?\n/).filter(line =>
      /^Fixture built: [a-f0-9]{64}$/.test(line)).length === 1 :
      Array.isArray(before.listed) && before.listed.length > 0 &&
      new Set(before.listed).size === before.listed.length &&
      same(before.files, before.listed.map(script => `${receipt.cwd}/bin/lib/${script}`)) &&
      same(occurrences.map(row => row.file).sort(), before.files.slice().sort()) &&
      same(verdicts.map(row => row.script), before.listed) &&
      verdicts.every(row => row.verdict === "PASS") &&
      logs.stdout.toString("utf8").split(/\r?\n/).filter(line =>
        line === `PASS — all ${before.listed.length} papercusp-desktop selftests green`).length === 1),
    "complete original native command result required");
    qualified.push({ task: pin.task, step: pin.step, kind: obligation.kind,
      ...(fixture ? { script: obligation.script } : { check: obligation.check }),
      command: obligation.command, inputs, fileOccurrences: occurrences,
      startedAtMs: Date.parse(execution.startedAt), finishedAtMs: Date.parse(finishedAt),
      receipt: pin.receipt, childWallMs, scriptsExecuted: verdicts.length,
      scriptOrder: verdicts.map(row => row.script), ...(astro ? { diagnostics } : {}) });
  }
  // Extend this same reader with native ordered occurrences. A list of successful
  // standalone runs is not a chain: require the original parent to bind every
  // child receipt and to contain their non-overlapping execution intervals.
  const chainPopulation = selection.tasks.filter(task =>
    Array.isArray(task.steps) && task.steps.length > 0 || task.lifecycleCommands?.length > 0)
    .map(task => task.id);
  require(new Set(chainPopulation).size === chainPopulation.length,
    "unique original ordered task population required");
  const chainPins = pins.chains ?? [];
  require(Array.isArray(chainPins) && chainPins.length <= 64 &&
    new Set(chainPins.map(chain => chain.task)).size === chainPins.length,
  "bounded distinct original chain pins required");
  const chains = [];
  const usedArtifacts = new Set();
  const uniqueArtifact = async pin => {
    require(pin && comparisonPath(pin.ref), "original chain artifact pin required");
    const path = await realpath(join(evidenceRoot, pin.ref));
    require(!usedArtifacts.has(path), "original chain artifact reused across roles or steps");
    usedArtifacts.add(path);
  };
  const samePin = (a, b) => Boolean(a && b && a.ref === b.ref && a.sha256 === b.sha256);
  const readProcessEvent = async (trace, pin, event) => {
    require(pin && comparisonPath(pin.ref) && comparisonDigest(pin.sha256),
      `original native ${event} artifact pin required`);
    const rows = trace.events.filter(row => row.event === event && samePin(row.artifact, pin));
    require(rows.length === 1, `unique original native ${event} event required`);
    const { artifact, ...projected } = rows[0];
    const bytes = await readPinned(pin.ref, pin.sha256, false);
    let observed;
    try { observed = JSON.parse(bytes.toString("utf8")); }
    catch { require(false, `malformed original native ${event} event`); }
    require(same(observed, projected) && observed.kind === "native-node-process-event",
      `original native ${event} event differs from its pinned artifact`);
    return observed;
  };
  for (const chainPin of chainPins) {
    const tasks = selection.tasks.filter(task => task.id === chainPin.task);
    require(tasks.length === 1 && chainPopulation.includes(chainPin.task), "exact original ordered task required");
    const task = tasks[0];
    const lifecycle = task.lifecycleCommands ?? [];
    require(Array.isArray(lifecycle) && lifecycle.every(row =>
      row.script === `pre${task.script}` || row.script === `post${task.script}`) &&
      new Set(lifecycle.map(row => row.script)).size === lifecycle.length,
    "original lifecycle order must be explicit");
    const expected = [
      ...lifecycle.filter(row => row.script === `pre${task.script}`).map(row =>
        ({ phase: "pre", step: null, command: row.command, script: row.script })),
      ...(task.steps ?? [task]).map((step, index) =>
        ({ phase: "test", step: task.steps ? index : null, command: step.command, script: step.script })),
      ...lifecycle.filter(row => row.script === `post${task.script}`).map(row =>
        ({ phase: "post", step: null, command: row.command, script: row.script })),
    ];
    require(expected.length > 0 && expected.length <= 64 && Array.isArray(chainPin.steps) &&
      chainPin.steps.length === expected.length, "every original ordered occurrence required");
    await uniqueArtifact(chainPin.receipt);
    const parent = await readPinned(chainPin.receipt.ref, chainPin.receipt.sha256);
    const execution = parent.execution;
    const parentStart = execution?.startedAtMs, parentEnd = execution?.finishedAtMs;
    const trace = parent.processTrace;
    const npmLifecycle = trace?.npmLifecycle;
    const root = npmLifecycle?.root;
    const allowedLifecycleGaps = new Set(["lifecycle-population-unqualified",
      "lifecycle-shell-streams-unobserved", "lifecycle-step-reports-unobserved"]);
    require(parent.kind === "affected-task-native-execution" && parent.task === task.id &&
      parent.originalCommand === task.command && execution?.cwd === resolve(sourceRoot, task.dir) &&
      same(execution?.command, ["npm", "run", task.script]) &&
      execution.exitCode === 0 && execution.signal === null && execution.error === null &&
      execution.captureComplete === true && parent.sourceInputsUnchanged === true &&
      Number.isSafeInteger(parentStart) && Number.isSafeInteger(parentEnd) && parentEnd > parentStart &&
      Array.isArray(trace?.events) && trace.population?.complete === true &&
      npmLifecycle?.scope === "direct-root-npm-spawn-close" && npmLifecycle.status === "observed" &&
      Array.isArray(npmLifecycle.spans) && npmLifecycle.spans.length === expected.length &&
      Array.isArray(npmLifecycle.gaps) && npmLifecycle.gaps.every(gap => allowedLifecycleGaps.has(gap)) &&
      root && Number.isSafeInteger(root.pid) && typeof root.processIdentity === "string" && root.processIdentity &&
      Array.isArray(parent.before?.inputs) && Array.isArray(parent.after?.inputs) &&
      same(parent.before.inputs, parent.after.inputs),
    "complete native npm parent and process trace required for ordered evidence");
    const rootEntry = await readProcessEvent(trace, root.entry, "node-entry");
    require(rootEntry.pid === root.pid && rootEntry.processIdentity === root.processIdentity &&
      rootEntry.cwd === execution.cwd && Array.isArray(rootEntry.argv) && rootEntry.argv.length === 4 &&
      ["npm", "npm-cli.js"].includes(basename(rootEntry.argv[1] ?? "")) &&
      rootEntry.argv[2] === "run" && rootEntry.argv[3] === task.script &&
      Number.isSafeInteger(rootEntry.atMs) && rootEntry.atMs >= parentStart && rootEntry.atMs <= parentEnd,
    "original npm root process entry differs");
    let lastLifecycleEnd = parentStart;
    for (let index = 0; index < expected.length; index++) {
      const original = expected[index], span = npmLifecycle.spans[index];
      require(span.event === original.script && span.script === original.command &&
        typeof span.command === "string" && span.command.length > 0 &&
        Array.isArray(span.argv) && same(span.argv, ["-c", original.command]) &&
        span.cwd === execution.cwd && span.observerPid === root.pid &&
        span.observerProcessIdentity === root.processIdentity && span.exitCode === 0 && span.signal === null &&
        Number.isSafeInteger(span.startedAtMs) && Number.isSafeInteger(span.closedAtMs) &&
        span.startedAtMs >= lastLifecycleEnd && span.closedAtMs >= span.startedAtMs &&
        span.closedAtMs <= parentEnd && Number.isSafeInteger(span.childPid) && span.childPid > 0 &&
        typeof span.childIdentity === "string" && span.childIdentity,
      "observed npm lifecycle command differs from original order");
      const spawn = await readProcessEvent(trace, span.spawn, "child-spawn");
      const close = await readProcessEvent(trace, span.close, "child-close");
      require(spawn.pid === root.pid && spawn.processIdentity === root.processIdentity &&
        spawn.childPid === span.childPid && spawn.childIdentity === span.childIdentity &&
        spawn.command === span.command && same(spawn.argv, span.argv) && spawn.cwd === span.cwd &&
        spawn.lifecycle?.event === span.event && spawn.lifecycle?.script === span.script &&
        spawn.atMs === span.startedAtMs && close.pid === root.pid &&
        close.processIdentity === root.processIdentity && close.childPid === span.childPid &&
        close.childIdentity === span.childIdentity && close.code === span.exitCode &&
        close.signal === span.signal && close.atMs === span.closedAtMs,
      "npm lifecycle summary differs from native spawn/close artifacts");
      lastLifecycleEnd = span.closedAtMs;
    }
    require(chainPin.logs && Object.keys(chainPin.logs).length === 2, "two original parent logs required");
    for (const role of ["stdout", "stderr"]) {
      const log = chainPin.logs[role];
      await uniqueArtifact(log);
      require(samePin(log, execution.logs?.[role]),
        "parent log absent from original execution");
      await readPinned(log.ref, log.sha256, false);
    }
    // Pin the actual npm entry point, including pre/post mappings, rather than
    // accepting a parent with an unrelated script which happened to be green.
    const packagePath = `${task.dir}/package.json`;
    const parentInputs = parent.before.inputs;
    require(parentInputs.some(row => row.path === packagePath) &&
      parentInputs.every(row => comparisonPath(row.path) && comparisonDigest(row.sha256)) &&
      new Set(parentInputs.map(row => row.path)).size === parentInputs.length,
    "original parent wrapper inputs required");
    await matchCurrentInputs(parentInputs);
    const pkg = JSON.parse((await readCurrentInput(parentInputs.find(input => input.path === packagePath))).toString("utf8"));
    require(pkg.scripts?.[task.script] === task.command &&
      lifecycle.every(row => pkg.scripts?.[row.script] === row.command) &&
      ["pre", "post"].every(phase => !pkg.scripts?.[`${phase}${task.script}`] ||
        lifecycle.some(row => row.script === `${phase}${task.script}`)) &&
      expected.every(row => row.phase !== "test" || !row.script || row.script === task.script ||
        pkg.scripts?.[row.script] === row.command), "original npm chain mapping differs");
    const steps = [];
    let previousEnd = parentStart;
    for (let index = 0; index < expected.length; index++) {
      const original = expected[index], pin = chainPin.steps[index];
      require(pin.phase === original.phase && pin.step === original.step,
        "original chain phase or step order differs");
      await uniqueArtifact(pin.receipt);
      const prepared = qualified.filter(row => row.task === task.id && row.step === original.step &&
        row.command === original.command && (original.phase === "test" ? row.kind === "command-check" :
          row.kind === "npm-lifecycle" && row.script === original.script));
      let step;
      if (prepared.length) {
        require(prepared.length === 1 && pin.format === "command-preparation" &&
          same(pin.receipt, prepared[0].receipt), "exact qualified original command step required");
        step = { ...prepared[0], phase: original.phase };
      } else {
        require(original.phase === "test" && pin.format === "vitest-native-run" &&
          expected.filter(row => row.phase === "test").length === 1,
        "one original Vitest reporter run is required per native parent");
        const occurrences = selection.fileOccurrences.filter(row => row.task === task.id &&
          (row.step ?? null) === original.step);
        const originalStep = task.steps ? task.steps[original.step] : task;
        require(occurrences.length > 0 && occurrences.every(row => row.kind === "test-file" &&
          row.command === original.command && comparisonPath(row.file)) &&
          new Set(occurrences.map(row => row.file)).size === occurrences.length &&
          same(occurrences.map(row => row.file).sort(), originalStep.files?.slice().sort()) &&
          !selection.commandObligations.some(row => row.task === task.id &&
            (row.step ?? null) === original.step && row.kind === "command-check"),
        "complete original test-step occurrence population required");
        const reporter = trace.reporter;
        const reporterProcess = reporter?.process;
        const testSpan = npmLifecycle.spans.find(row => row.event === original.script &&
          row.script === original.command);
        require(reporter?.status === "bound" && reporterProcess && testSpan &&
          samePin(pin.receipt, reporter.artifact) && reporterProcess.lifecycle &&
          samePin(reporterProcess.lifecycle.spawn, testSpan.spawn) &&
          samePin(reporterProcess.lifecycle.close, testSpan.close) &&
          reporterProcess.lifecycle.childPid === testSpan.childPid &&
          reporterProcess.lifecycle.childIdentity === testSpan.childIdentity,
        "Vitest reporter must be bound to the observed original npm test lifecycle");
        const reporterEntry = await readProcessEvent(trace, reporterProcess.entry, "node-entry");
        const reporterExit = await readProcessEvent(trace, reporterProcess.exit, "node-exit");
        require(reporterEntry.pid === reporterProcess.pid && reporterEntry.ppid === reporterProcess.ppid &&
          reporterEntry.processIdentity === reporterProcess.processIdentity &&
          reporterEntry.cwd === execution.cwd,
        "native Vitest process entry identity differs");
        require(reporterExit.pid === reporterProcess.pid && reporterExit.ppid === reporterProcess.ppid &&
          reporterExit.processIdentity === reporterProcess.processIdentity && reporterExit.code === 0 &&
          reporterExit.exitListenersComplete === true,
        "native Vitest process did not exit cleanly with complete listeners");
        require(Array.isArray(reporterEntry.argv) && basename(reporterEntry.argv[1] ?? "") === "vitest.mjs" &&
          reporterEntry.argv[2] === "run",
        "native reporter process did not execute the original Vitest runner command");
        const reportBytes = await readPinned(pin.receipt.ref, pin.receipt.sha256, false);
        let reportEnvelope;
        try { reportEnvelope = JSON.parse(reportBytes.toString("utf8")); }
        catch { require(false, "malformed native Vitest reporter artifact"); }
        const report = reportEnvelope?.nativeRun;
        const testFiles = occurrences.map(row => row.file).sort();
        require(report?.schemaVersion === "native-vitest-run-v1" &&
          report.scope === "vitest-reporter-callbacks" && report.pid === reporterProcess.pid &&
          report.ppid === reporterProcess.ppid && report.terminalHook === "onTestRunEnd" &&
          report.reason === "passed" && report.unhandledErrorCount === 0 &&
          report.modulePopulationMatched === true && Array.isArray(report.gaps) && report.gaps.length === 0 &&
          Number.isSafeInteger(report.startedAtMs) && Number.isSafeInteger(report.finishedAtMs) &&
          report.startedAtMs >= testSpan.startedAtMs && report.finishedAtMs <= testSpan.closedAtMs &&
          Array.isArray(report.selectedManifest?.specifications) &&
          same(report.selectedManifest.specifications.map(row => row.testFile).sort(), testFiles) &&
          Array.isArray(report.reportedModulePaths) &&
          same(report.reportedModulePaths.slice().sort(), testFiles) &&
          Array.isArray(report.files) && report.files.length === occurrences.length,
        "complete native Vitest reporter population required");
        const sourceRowsByPath = new Map();
        let testsPassed = 0;
        for (const file of report.files) {
          const sourceEvidence = file.proof?.sourceEvidence;
          const exactSource = sourceEvidence?.sources?.filter(source =>
            source.path === file.testFile && source.basis === "vite-pre-transform") ?? [];
          require(file.state === "passed" && file.firstAttemptVerdict === "pass" &&
            file.execution?.passed > 0 && file.execution.failed === 0 && file.execution.skipped === 0 &&
            file.execution.collectionFailed === false && Array.isArray(file.cases) && file.cases.length > 0 &&
            file.cases.every(test => test.status === "pass") &&
            sourceEvidence?.schemaVersion === "vite-collected-source-evidence-v1" &&
            sourceEvidence.scope === "repository-worker-vite-original-sources" &&
            sourceEvidence.status === "stable" && Array.isArray(sourceEvidence.reasons) &&
            sourceEvidence.reasons.length === 0 && exactSource.length === 1 &&
            comparisonDigest(exactSource[0].sha256) && exactSource[0].currentSha256 === exactSource[0].sha256,
          "Vitest step must have complete no-skip cases and stable original source evidence");
          for (const source of sourceEvidence.sources) {
            const prior = sourceRowsByPath.get(source.path);
            require(!prior || prior.sha256 === source.sha256,
              `conflicting native source evidence: ${source.path}`);
            sourceRowsByPath.set(source.path, { path: source.path, sha256: source.sha256 });
          }
          testsPassed += file.execution.passed;
        }
        require(same(report.files.map(file => file.testFile).sort(), testFiles) &&
          sourceRowsByPath.size > 0,
        "native Vitest source population differs from selected files");
        const sourceRows = [...sourceRowsByPath.values()];
        await matchCurrentInputs(sourceRows);
        const logs = {};
        require(pin.logs && Object.keys(pin.logs).length === 3, "three original test-step logs required");
        for (const role of ["stdout", "stderr", "report"]) {
          const log = pin.logs[role];
          if (role === "report") {
            require(samePin(log, reporter.artifact), "native reporter report pin differs");
            logs[role] = reportEnvelope;
          } else {
            await uniqueArtifact(log);
            const rows = trace.streams.filter(row => row.processIdentity === reporterProcess.processIdentity &&
              row.pid === reporterProcess.pid && row.role === role);
            const pin = rows[0]?.artifact;
            const exitPin = reporterExit.streams?.[role];
            require(rows.length === 1 && rows[0].scope === "node-writable-call-inputs" &&
              rows[0].captureComplete === true && Number.isSafeInteger(rows[0].observedByteLength) &&
              rows[0].observedByteLength === pin?.byteLength &&
              exitPin?.scope === rows[0].scope && exitPin.captureComplete === true &&
              exitPin.sha256 === pin?.sha256 && exitPin.byteLength === pin?.byteLength &&
              samePin(log, pin), `complete native Vitest ${role} stream required`);
            logs[role] = await readPinned(log.ref, log.sha256, false);
          }
        }
        step = { task: task.id, phase: original.phase, step: original.step, command: original.command,
          receipt: pin.receipt, fileOccurrences: occurrences, inputs: sourceRows,
          startedAtMs: report.startedAtMs, finishedAtMs: report.finishedAtMs,
          childWallMs: report.finishedAtMs - report.startedAtMs, testsPassed, format: pin.format };
      }
      require(step.startedAtMs >= previousEnd && step.finishedAtMs <= parentEnd,
        "native chain step intervals overlap, reverse, or escape original parent");
      previousEnd = step.finishedAtMs;
      steps.push(step);
    }
    const occurrenceIdentity = rows => rows.map(row => JSON.stringify(row)).sort();
    require(same(occurrenceIdentity(steps.flatMap(step => step.fileOccurrences)),
      occurrenceIdentity(selection.fileOccurrences.filter(row => row.task === task.id))),
    "original chain contains unqualified file occurrences");
    chains.push({ task: task.id, receipt: chainPin.receipt, steps,
      startedAtMs: parentStart, finishedAtMs: parentEnd, orderedOccurrencesQualified: true });
  }
  const missingChains = chainPopulation.filter(task => !chains.some(chain => chain.task === task));
  return freezeComparison({ mode: "command-preparation", selection, commands: qualified, chains,
    originalArtifactsResolved: true, currentDeclaredInputsMatched: true,
    orderedChainQualified: chainPopulation.length > 0 && missingChains.length === 0,
    orderedChainCoverage: { population: chainPopulation, qualified: chains.map(chain => chain.task), missing: missingChains },
    runtimeClosure: "unmeasured", operationalAcceptance: false,
    populationSha256: comparisonHash({ selection: pins.selection, commands: qualified, chains }) });
}
// EI-21669294176320490: the scheduler's worker/task counters are local to one
// Node invocation.  A fleet of concurrent `test:affected` processes could
// therefore each admit its own "bounded" pool and multiply Vitest workers and
// Postgres clients until the host's acquire queues starved.  Reuse the proven
// filesystem mutex so the admission boundary is shared across invocations.
//
// Keep the stale window longer than the largest bounded test-process timeout:
// `withFsMutex` also confirms a same-host dead owner with kill(pid, 0), so a
// crashed holder is still reclaimed immediately without allowing a live,
// long-running test to be mistaken for an abandoned lock.
const SHARED_TEST_PROCESS_ADMISSION_MUTEX = "papercusp-test-process-admission";
// WI-1746759: the release gate's OWN admission lane.
//
// `runBudgetedTasks` takes this mutex ONCE PER SHARD (see the run-budget note below), so on
// the shared lane the gate does not queue once — it re-queues per shard, and every re-entry
// lands at the BACK of the FIFO queue behind whoever arrived meanwhile. Measured on the
// 2026-08-31T12:23:04Z run: `shards=17`, 46 `AFFECTED_TESTS_ADMISSION_QUEUED` notices, ZERO
// acquisitions in 45 minutes, and the run then died on the run budget having executed no
// tests at all (`tasks=130 failed=0 undeterminedTasks=130`). That is a NON-VERDICT, not a
// red — the gate learned nothing about the code and still consumed its hourly slot.
//
// `scripts/pc-heavy.sh` already exempts the gate from the OUTER semaphore and states the
// policy in as many words — "this exempts it from ADMISSION, never from PRIORITY" — keeping
// it deferential via `nice 10 + ionice 7` (EI-78) rather than by queueing. That exemption
// stopped short of this inner mutex, which is the layer that actually serializes. A separate
// lane restores the stated policy instead of inventing a new one: the gate's shards contend
// only with EACH OTHER, so it still runs one test process at a time and neither the gate nor
// the fleet is starved by the other.
//
// ⚠ DERIVED from the shared name, never hand-written. `isSharedAdmissionTimeout` below
// classifies a timeout by `message.includes(SHARED_TEST_PROCESS_ADMISSION_MUTEX)`, so
// EXTENDING the base name is what keeps a gate timeout classified as admission-starved.
// Give this lane an unrelated name and that check returns false for the gate: the error
// re-throws instead of becoming `status=refused reason=admission-starved`, no
// AFFECTED_TESTS_RESULT line is emitted, and green-checkpoint records a lost run — the exact
// failure WI-1490656 exists to prevent, landing only on the one caller nobody watches live.
const RELEASE_GATE_ADMISSION_MUTEX = `${SHARED_TEST_PROCESS_ADMISSION_MUTEX}-release-gate`;
const SHARED_TEST_PROCESS_ADMISSION_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const SHARED_TEST_PROCESS_ADMISSION_STALE_MS = 2 * 60 * 60 * 1_000;
const SHARED_TEST_PROCESS_ADMISSION_RETRY_MS = 250;
// WI-1490656: how often a still-queued caller re-announces itself. One notice at t≈0 is
// invisible to any observer who attaches later, which is how a queued run gets
// misdiagnosed as a wedge.
const SHARED_TEST_PROCESS_ADMISSION_NOTICE_INTERVAL_MS = 60 * 1_000;
// The whole-invocation queue budget. `SHARED_TEST_PROCESS_ADMISSION_TIMEOUT_MS` bounds ONE
// `withFsMutex` acquisition, and a sharded run acquires once PER SHARD — so the bound
// everyone believes is 4h is really shards × 4h (measured: a 126-task near-tree-wide gate
// run plans 16 shards ⇒ a 64h worst case). The green-checkpoint holds its singleton run
// lock for that entire time, so every later fire records `skipped-locked` and the gate
// stops producing verdicts at all. Bound the SUM instead, well inside the gate's own
// hourly cadence, so a starved run fails loudly and frees the lock for the next fire.
export const SHARED_TEST_PROCESS_ADMISSION_RUN_BUDGET_MS = 45 * 60 * 1_000;

/**
 * WI-1746759: which admission lane THIS process belongs in.
 *
 * ⚠ Keyed on `PC_HEAVY_RELEASE_GATE` ONLY — deliberately NOT `GREEN_CHECKPOINT`, and the two
 * are not interchangeable here even though the gate's environment carries both. `pc-heavy.sh`
 * records why, from an incident: GREEN_CHECKPOINT is double-duty (it also drives
 * `describe.skipIf` in load-/network-sensitive tests), so agents legitimately export it BY
 * HAND to reproduce the gate's skip-set — and keying admission off it once meant
 * `GREEN_CHECKPOINT=1 npm run test:affected` bypassed that semaphore at nice 0, "re-opening
 * the very hole this wrapper closes". Keying a private admission LANE off it would repeat
 * that a layer down: any agent exporting the marker would leave the queue its peers wait in.
 * `PC_HEAVY_RELEASE_GATE` is the dedicated key, set by `buildGreenCheckpointEnv` and
 * inherited by the whole child tree, which is why it is the only safe discriminator.
 *
 * Matches pc-heavy.sh's own test (`[ "${PC_HEAVY_RELEASE_GATE:-}" = "1" ]`): the literal "1",
 * not truthiness, so an empty or absent value stays on the shared lane.
 */
export function admissionMutexName(env = process.env) {
  return env?.PC_HEAVY_RELEASE_GATE === "1"
    ? RELEASE_GATE_ADMISSION_MUTEX
    : SHARED_TEST_PROCESS_ADMISSION_MUTEX;
}

/**
 * Does this error mean "we never got admitted", as opposed to a real test failure?
 *
 * Lives HERE, beside the acquisition that produces it, so the producer and the classifier
 * cannot drift apart. A caller that misclassifies this exits with no verdict, which the
 * green-checkpoint records as a LOST RUN — the failure WI-1490656 is about — so the
 * coupling is pinned by a test that feeds this a REAL `withFsMutex` timeout rather than a
 * hand-written lookalike string.
 */
export function isSharedAdmissionTimeout(error) {
  const message = String(error?.message ?? error ?? "");
  return (
    /Timed out after \d+ms waiting for fs-mutex/.test(message) &&
    message.includes(SHARED_TEST_PROCESS_ADMISSION_MUTEX)
  );
}

/** A release-gate waiter deferred before spending its queue budget behind an aged holder. */
export function isSharedAdmissionDeferral(error) {
  const message = String(error?.message ?? error ?? "");
  return error?.code === "EADMISSIONDEFERRED" &&
    message.includes(SHARED_TEST_PROCESS_ADMISSION_MUTEX);
}

// WI-1639265: the caller's WALL CLOCK, published by the launcher as absolute epoch ms.
//
// Everything above this line is an INTERNAL budget: the queue budget is a fixed constant,
// the per-acquisition timeout is a fixed constant, and neither has ever known how long the
// caller is actually allowed to live. The launcher does know — it sets `RuntimeMaxSec` on
// the unit — but systemd enforces that property against the manager, not against us, so the
// first this process hears of its own deadline is SIGKILL. A run killed that way exits with
// no `AFFECTED_TESTS_RESULT` line at all, which the green-checkpoint records as a LOST RUN
// and every liveness probe reads as a hang.
//
// Keep the name byte-identical to `TASK_DEADLINE_EPOCH_MS_ENV` in
// `packages/operator-core/lib/systemd-scope.ts` (the producer). The pairing is pinned by
// `affected-tests-deadline-admission.test.ts`, which reads BOTH sources, so a rename on
// either side fails there rather than silently reverting this to the pre-fix behaviour —
// an absent variable is indistinguishable from "no deadline was set" by design.
// Reader, refusal grammar and classifier are re-exported above from the
// bootstrap-safe contract also used by the native verifier.
// EI-21437241652128498 / EI-21437837415175286: one stateful test task first
// reached 1,517 cgroup tasks, then exhausted a 2,048-task capability scope while
// it was still progressing. A later operator-core pure lane reached 4,096 tasks
// and STILL produced a complete 2,840-file verdict, proving that 4,096 is valid
// child workload rather than shell headroom. Size one admitted task to that
// writer-owned measurement and keep a separate shell/scheduler reserve. An
// 8,192-task capability envelope therefore admits ONE high-fanout task, not two
// whose individually legitimate peaks can collide at the hard fork boundary.
// This is the cgroup that actually enforces fork(); a host-wide process count is
// not the relevant limit.
export const PIDS_PER_CONCURRENT_TASK = 4_096;
export const PIDS_RESERVE = 1_024;

const positiveInteger = (value, name) => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${name} must be a positive integer; received ${String(value)}`,
    );
  }
  return parsed;
};

const nonNegativeInteger = (value, name) => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(
      `${name} must be a non-negative integer; received ${String(value)}`,
    );
  }
  return parsed;
};

/** Read the hard pids.max of THIS task's cgroup. `max`/unreadable means unbounded. */
export function readTaskCgroupPidsMax(options = {}) {
  try {
    const raw = readTaskCgroupLimit("pids.max", options);
    if (raw == null) return null;
    const pids = BigInt(raw);
    if (pids < 0n || pids > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(pids);
  } catch {
    return null;
  }
}

/**
 * Read the cgroup pids controller's cumulative refused-fork counter for THIS task.
 * A null result means the controller/file is unavailable; zero is a real measurement.
 */
export function readTaskCgroupPidsEventMax(options = {}) {
  try {
    const raw = readTaskCgroupLimit("pids.events", options);
    if (raw == null) return null;
    const line = raw
      .split(/\r?\n/)
      .map((entry) => entry.trim().split(/\s+/))
      .find(([key]) => key === "max");
    if (!line || line.length !== 2) return null;
    const count = BigInt(line[1]);
    if (count < 0n || count > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(count);
  } catch {
    return null;
  }
}

const BYTES_PER_MB = 1024n * 1024n;

function keyedCgroupCounter(raw, key) {
  const line = String(raw)
    .split(/\r?\n/)
    .map((entry) => entry.trim().split(/\s+/))
    .find(([name]) => name === key);
  if (!line || line.length !== 2 || !/^\d+$/.test(line[1])) return null;
  const value = BigInt(line[1]);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? null : value;
}

/**
 * Read what THIS task's cgroup is actually using: `anonMb` (memory.stat `anon`, the
 * non-reclaimable demand a worker fork really makes), `peakMb` (memory.peak, the cumulative
 * high-water mark INCLUDING reclaimable page cache, so it overstates demand) and `oomKills`
 * (memory.events `oom_kill`). Each field is independently null when unreadable; the whole
 * result is null only when nothing could be read.
 *
 * WI-10007629 (P-006): the scheduler sizes each worker as the 4 GiB fork heap CEILING, so
 * the reserved gate profile admits 7 workers in its 30 GiB budget. No run had ever recorded
 * how much of that ceiling forks really use, so the cap could not be raised on evidence.
 * This reading is that evidence.
 */
export function readTaskCgroupMemoryUsage(options = {}) {
  const anon = (() => {
    const raw = readTaskCgroupLimit("memory.stat", options);
    return raw == null ? null : keyedCgroupCounter(raw, "anon");
  })();
  const peak = (() => {
    const raw = readTaskCgroupLimit("memory.peak", options);
    return raw != null && /^\d+$/.test(raw) ? BigInt(raw) : null;
  })();
  const oomKills = (() => {
    const raw = readTaskCgroupLimit("memory.events", options);
    return raw == null ? null : keyedCgroupCounter(raw, "oom_kill");
  })();
  if (anon == null && peak == null && oomKills == null) return null;
  return {
    anonMb: anon == null ? null : Number(anon / BYTES_PER_MB),
    peakMb: peak == null ? null : Number(peak / BYTES_PER_MB),
    oomKills: oomKills == null ? null : Number(oomKills),
  };
}

/**
 * Track the cgroup's maximum `anon` across a run. Call `sample()` on every task progress
 * beat (a few small /sys reads) and once more at the end. `anon` is sampled, so its maximum
 * is a LOWER bound on the true anon peak; `memory.peak` (cumulative, kernel-kept) is the
 * upper bound. A sizing decision should sit between the two, never on either alone.
 */
export function createCgroupMemoryObserver({
  read = readTaskCgroupMemoryUsage,
} = {}) {
  let samples = 0;
  let maxAnonMb = null;
  let peakMb = null;
  let oomKillsStart;
  let oomKillsLast = null;
  let activeWorkers = 0;
  let pairedSamples = 0;
  let maxAnonPerAllocatedWorkerMb = null;
  const observer = {
    /** Scope the existing scheduler grant to its task lifetime, including rejection. */
    async withWorkers(workers, run) {
      if (!Number.isInteger(workers) || workers < 1) throw new Error('workers must be a positive integer');
      activeWorkers += workers;
      try { return await run(); }
      finally {
        observer.sample();
        activeWorkers -= workers;
      }
    },
    sample() {
      let usage;
      try { usage = read(); } catch { return; } // Diagnostic failure is unknown, never a test verdict.
      if (!usage) return;
      samples++;
      if (usage.anonMb != null) {
        maxAnonMb = Math.max(maxAnonMb ?? 0, usage.anonMb);
        if (activeWorkers > 0) {
          pairedSamples++;
          maxAnonPerAllocatedWorkerMb = Math.max(maxAnonPerAllocatedWorkerMb ?? 0,
            Math.ceil(usage.anonMb / activeWorkers));
        }
      }
      if (usage.peakMb != null) peakMb = Math.max(peakMb ?? 0, usage.peakMb);
      if (usage.oomKills != null) {
        if (oomKillsStart === undefined) oomKillsStart = usage.oomKills;
        oomKillsLast = usage.oomKills;
      }
    },
    summary() {
      return {
        samples,
        maxAnonMb,
        peakMb,
        // A DELTA over this run: the cgroup may outlive the run and carry older kills.
        oomKills:
          oomKillsLast == null || oomKillsStart === undefined
            ? null
            : oomKillsLast - oomKillsStart,
        pairedSamples,
        maxAnonPerAllocatedWorkerMb,
      };
    },
  };
  return observer;
}

/**
 * One greppable line beside AFFECTED_TESTS_SCHEDULER_OBSERVED. Deliberately a SEPARATE marker:
 * green-checkpoint consumes the OBSERVED line by prefix and its field set stays unchanged.
 * `anonPerWorkerMb` is the largest sampled anon / contemporaneous granted-worker ratio.
 * These are ALLOCATIONS, not a count of resident forks. Sampling is a lower bound on the
 * true peak and includes parent overhead; calibration still needs a margin and the hard
 * envelope. Never divide two independent peaks: that can understate one-worker demand.
 * Legacy unpaired observations remain unknown rather than inventing a sizing signal.
 */
export function formatCgroupMemoryObservedMarker(summary, { observedMaxWorkers } = {}) {
  const field = (value) => (value == null ? "unknown" : String(value));
  const perWorker =
    Number(summary.pairedSamples) > 0 && summary.maxAnonPerAllocatedWorkerMb != null
      ? String(summary.maxAnonPerAllocatedWorkerMb)
      : "unknown";
  return (
    `AFFECTED_TESTS_CGROUP_MEMORY_OBSERVED samples=${summary.samples} ` +
    `anonMaxMb=${field(summary.maxAnonMb)} peakMb=${field(summary.peakMb)} ` +
    `oomKills=${field(summary.oomKills)} maxWorkers=${field(observedMaxWorkers)} ` +
    `anonPerWorkerMb=${perWorker} workerBasis=paired-allocation pairedSamples=${summary.pairedSamples ?? 0}`
  );
}

/** Return the refused-fork delta that invalidates a red run; green runs stay authoritative. */
export function pidsEventRefusalDelta({ start, end, hasFailures }) {
  if (!hasFailures || start == null || end == null) return 0;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return 0;
  return Math.max(0, end - start);
}

const ROOT_NEAR_TREE_WIDE = [
  /^package(?:-lock)?\.json$/,
  /^tsconfig(?:\.[^.]+)*\.json$/,
  /^(?:vitest|vite|eslint|prettier|turbo|nx)(?:\.[^.]+)*\.(?:[cm]?[jt]s|json)$/,
];

/** Classify path blast radius before any child process is launched. */
export function classifyAffectedBlastRadius({
  changedPaths = [],
  runAll = false,
  derivationDegraded = false,
} = {}) {
  if (runAll)
    return {
      kind: "near-tree-wide",
      reason: "all-requested",
      triggerPaths: [],
    };
  if (derivationDegraded) {
    return {
      kind: "near-tree-wide",
      reason: "derivation-degraded",
      triggerPaths: [],
    };
  }
  const triggerPaths = [...new Set(changedPaths)]
    .filter((path) => ROOT_NEAR_TREE_WIDE.some((pattern) => pattern.test(path)))
    .sort();
  return triggerPaths.length
    ? {
        kind: "near-tree-wide",
        reason: "root-manifest-or-config",
        triggerPaths,
      }
    : { kind: "scoped", reason: "path-closure", triggerPaths: [] };
}

/** Deterministically partition a finalized task set; duplicates fail before launch. */
export function planAffectedTaskShards(
  tasks,
  {
    blastRadius = { kind: "scoped", reason: "path-closure", triggerPaths: [] },
    maxTasksPerShard = 8,
    taskKey = (_task, index) => String(index),
  } = {},
) {
  if (!Array.isArray(tasks)) throw new Error("tasks must be an array");
  const identities = tasks.map((task, index) => String(taskKey(task, index)));
  const seen = new Set();
  for (const identity of identities) {
    if (seen.has(identity))
      throw new Error(`duplicate affected task before sharding: ${identity}`);
    seen.add(identity);
  }
  const bounded = positiveInteger(maxTasksPerShard, "maxTasksPerShard");
  const shardSize =
    blastRadius.kind === "near-tree-wide" ? bounded : Math.max(tasks.length, 1);
  const shards = [];
  for (let offset = 0; offset < tasks.length; offset += shardSize) {
    shards.push({
      index: shards.length,
      tasks: tasks.slice(offset, offset + shardSize),
      taskKeys: identities.slice(offset, offset + shardSize),
    });
  }
  return {
    blastRadius,
    maxTasksPerShard: shardSize,
    taskCount: tasks.length,
    shards,
  };
}

export function formatAffectedTaskShardMarker(
  plan,
  taskCgroupMemoryMaxMb = null,
) {
  const cgroup =
    taskCgroupMemoryMaxMb == null
      ? ""
      : ` taskCgroupMemoryMaxMb=${taskCgroupMemoryMaxMb}`;
  return (
    `AFFECTED_TASK_SHARDS class=${plan.blastRadius.kind} reason=${plan.blastRadius.reason} ` +
    `tasks=${plan.taskCount} shards=${plan.shards.length} maxTasksPerShard=${plan.maxTasksPerShard}${cgroup}`
  );
}

/**
 * Collapse every inherited/test-runner worker spelling into one global ceiling.
 *
 * Vitest 4 reads VITEST_MAX_WORKERS, while older/config-specific paths still set
 * VITEST_MAX_FORKS or VITEST_MAX_THREADS. The green checkpoint deliberately exports only the
 * latter two as its two-fork safety rail. Taking the minimum keeps any pre-set ceiling binding;
 * an affected-tests-specific value may tighten that rail but can never silently widen it.
 */
export function resolveGlobalWorkerBudget({
  affectedWorkerBudget,
  vitestMaxWorkers,
  vitestMaxForks,
  vitestMaxThreads,
  fallback,
}) {
  const candidates = [
    ["AFFECTED_GLOBAL_WORKER_BUDGET", affectedWorkerBudget],
    ["VITEST_MAX_WORKERS", vitestMaxWorkers],
    ["VITEST_MAX_FORKS", vitestMaxForks],
    ["VITEST_MAX_THREADS", vitestMaxThreads],
  ].flatMap(([name, value]) =>
    value == null || value === "" ? [] : [positiveInteger(value, name)],
  );
  if (candidates.length === 0) return positiveInteger(fallback, "fallback");
  return Math.min(...candidates);
}

/**
 * Size one scheduler memory token from the largest CREDIBLE per-worker ceiling.
 *
 * The child inherits NODE_OPTIONS, so a V8 old-space pin is part of its possible footprint even
 * when AFFECTED_WORKER_MEMORY_MB is unset. Treat the explicit estimate and the inherited heap as
 * lower bounds rather than alternatives: an override may add native/RSS headroom, but it must not
 * make a 4 GiB heap look like a 1 GiB worker to the global admission budget.
 *
 * WI-10002092 (a RECURRENCE of EI-23242580927683488, which was closed as a stale-runtime report
 * with no source edit): "credible" is the load-bearing word, and a bare `Math.max` over every
 * inherited heap made it a lie. `--max-old-space-size` is a heap CEILING — the most V8 may grow
 * to before it OOMs — never a reservation. Agent shells here carry an ambient
 * `--max-old-space-size=131072` (128 GiB) for the ordinary reason anyone sets one: to avoid
 * spurious OOMs. Read as a per-worker DEMAND it made {@link resolveMemoryBudgetMb} refuse before
 * launch in every ~6 GiB agent task cgroup, so `test:affected` — the command CLAUDE.md prescribes
 * after every edit — ran ZERO tasks for every agent invoking it from its own shell.
 *
 * The discriminator is whether the envelope could ever pay for the number. A ceiling that FITS is
 * a credible deliberate sizing and still raises the token, so the gate's 4 GiB fork pin is
 * honoured exactly as before. A ceiling the envelope could never satisfy is not a claim about
 * footprint at all — no admission decision could meet it — so it carries no information and is
 * DISREGARDED, leaving the explicit estimate (or the caller's fallback) to size the token. The
 * honest refusal survives for the case it was actually built for: a cgroup too small to pay for
 * even one estimated worker still throws in {@link resolveMemoryBudgetMb}.
 *
 * Pass `taskCgroupMemoryMaxMb` to arm the credibility test. Omit it — or pass the `null` that
 * {@link readTaskCgroupMemoryMaxMb} returns for an unbounded/unreadable cgroup — and there is no
 * envelope to judge against, so every heap candidate stands and the prior behaviour is exact.
 * `cgroupReserveFraction` deliberately shares {@link MEMORY_RESERVE_FRACTION} and the reserve
 * arithmetic with `resolveMemoryBudgetMb`: the two rails must agree on what one task can pay for,
 * or this function credits a ceiling the admission check then refuses.
 *
 * Disregarding a candidate can only ever LOWER the resolved token, never widen it — the same
 * one-directional property `resolveMemoryBudgetMb` claims for itself.
 */
export function resolveWorkerMemoryMb({
  affectedWorkerMemoryMb,
  nodeOptions,
  fallback,
  taskCgroupMemoryMaxMb,
  cgroupReserveFraction = MEMORY_RESERVE_FRACTION,
  onNotice,
}) {
  const candidates = [positiveInteger(fallback, "fallback")];
  if (affectedWorkerMemoryMb != null && affectedWorkerMemoryMb !== "") {
    candidates.push(
      positiveInteger(affectedWorkerMemoryMb, "AFFECTED_WORKER_MEMORY_MB"),
    );
  }
  // Validated even when no cgroup is supplied: silently ignoring a nonsensical fraction is what
  // lets a caller believe a credibility test is armed when it is not.
  if (!(cgroupReserveFraction >= 0 && cgroupReserveFraction < 1)) {
    throw new Error(
      `cgroupReserveFraction must be in [0, 1); received ${String(cgroupReserveFraction)}`,
    );
  }
  const credibleCeilingMb =
    taskCgroupMemoryMaxMb == null || taskCgroupMemoryMaxMb === ""
      ? null
      : Math.floor(
          nonNegativeInteger(taskCgroupMemoryMaxMb, "taskCgroupMemoryMaxMb") *
            (1 - cgroupReserveFraction),
        );
  const heapPattern =
    /(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s+)(\d+)(?=\s|$)/g;
  for (const match of String(nodeOptions ?? "").matchAll(heapPattern)) {
    const heapMb = positiveInteger(match[1], "NODE_OPTIONS max-old-space-size");
    if (credibleCeilingMb != null && heapMb > credibleCeilingMb) {
      // Announced, never silent: a disregarded candidate changes the admitted concurrency, and an
      // unexplained change there is indistinguishable from the budget rail being broken again.
      onNotice?.(
        `NODE_OPTIONS --max-old-space-size=${heapMb}MB exceeds the ${credibleCeilingMb}MB this ` +
          `task cgroup can pay for (memory.max=${taskCgroupMemoryMaxMb}MB); treating it as a ` +
          `heap ceiling, not a per-worker reservation (WI-10002092)`,
      );
      continue;
    }
    candidates.push(heapMb);
  }
  return Math.max(...candidates);
}

/**
 * Headroom held back from MemAvailable before any worker token is paid for.
 *
 * EI-20801764054303492 route (a): the STARTUP budget ({@link resolveMemoryBudgetMb}) and the
 * PER-ADMISSION re-check ({@link admissibleWorkersForMemory}) must reserve the same slice, or the
 * two rails disagree about what "available" means and the run oscillates between them. Exported
 * as one constant so a future tuning change cannot move one and leave the other behind.
 *
 * It is also the ONLY thing standing in for memory a just-admitted child has not yet allocated:
 * a worker's 4 GiB heap materialises over its first minutes, so a reading taken right after an
 * admission still reports that memory as available. See the conservatism note on
 * {@link admissibleWorkersForMemory}.
 */
export const MEMORY_RESERVE_FRACTION = 0.25;

/**
 * Resolve the memory envelope that worker tokens are admitted against.
 *
 * WI-39472: the caller's default used to be `workerBudget * workerMemoryMb`, which made
 * `memoryWorkerBudget` identically equal to `workerBudget` — so the `Math.min` in
 * {@link resolveTaskBudget} could never bind and the memory rail was INERT. Nothing failed
 * loudly; the gate simply had no memory-awareness at all, which is why its concurrency had to
 * be pinned at a hardcoded worst-case 2 (green-checkpoint.ts:4588-4610 records the 8 -> 4 -> 2
 * walk, each step taken after a real OOM). A live clamp is the precondition for ever raising
 * that ceiling again: with it, a quiet box runs wide and a loaded box is throttled instead of
 * OOM-killed.
 *
 * MemAvailable, never MemFree/os.freemem(): free memory excludes reclaimable page cache and
 * reads catastrophically low on any box that has been up for a while, which would throttle the
 * scheduler to a single worker for no reason.
 *
 * SAFETY: the result is `min(ceiling, usable)`, so this can only ever LOWER the admitted budget
 * relative to the previous behaviour — it can never widen it. The floor of one worker's worth
 * keeps `memoryWorkerBudget >= 1`, so a memory-starved host still makes progress serially
 * rather than tripping the "cannot admit one token" throw.
 */
export function resolveMemoryBudgetMb({
  affectedGlobalMemoryMb,
  memAvailableMb,
  taskCgroupMemoryMaxMb,
  workerBudget,
  workerMemoryMb,
  reserveFraction = MEMORY_RESERVE_FRACTION,
  cgroupReserveFraction = MEMORY_RESERVE_FRACTION,
}) {
  const perWorker = positiveInteger(workerMemoryMb, "workerMemoryMb");
  const ceiling = positiveInteger(workerBudget, "workerBudget") * perWorker;
  const configured =
    affectedGlobalMemoryMb != null && affectedGlobalMemoryMb !== ""
      ? positiveInteger(affectedGlobalMemoryMb, "AFFECTED_GLOBAL_MEMORY_MB")
      : ceiling;
  // WI-41206: the MemAvailable reading no longer reduces the envelope. An explicit
  // AFFECTED_GLOBAL_MEMORY_MB override (handled above) is still honoured — that is an operator
  // deliberately setting a budget, which is the opposite of the machine imposing one.
  //
  // reserveFraction is still VALIDATED even though it no longer narrows anything: it is a public
  // argument, and silently ignoring a nonsensical value is exactly the failure mode that lets a
  // caller believe a budget is in force when it is not.
  if (!(reserveFraction >= 0 && reserveFraction < 1)) {
    throw new Error(
      `reserveFraction must be in [0, 1); received ${String(reserveFraction)}`,
    );
  }
  if (!(cgroupReserveFraction >= 0 && cgroupReserveFraction < 1)) {
    throw new Error(
      `cgroupReserveFraction must be in [0, 1); received ${String(cgroupReserveFraction)}`,
    );
  }
  void memAvailableMb;
  if (taskCgroupMemoryMaxMb == null || taskCgroupMemoryMaxMb === "")
    return configured;
  const cgroupMax = nonNegativeInteger(
    taskCgroupMemoryMaxMb,
    "taskCgroupMemoryMaxMb",
  );
  const cgroupBudget = Math.floor(cgroupMax * (1 - cgroupReserveFraction));
  if (cgroupBudget < perWorker) {
    throw new Error(
      `task cgroup memory.max=${cgroupMax}MB leaves ${cgroupBudget}MB after reserve, ` +
        `below one workerMemoryMb=${perWorker}MB token; refusing before launch ` +
        formatTaskBudgetRefusal({
          kind: "memory",
          unit: "mb",
          limit: cgroupMax,
          reserve: cgroupMax - cgroupBudget,
          requiredPerTask: perWorker,
        }),
    );
  }
  return Math.min(configured, cgroupBudget);
}

/**
 * Resolve the single resource envelope shared by every concurrently-running task.
 * Memory is represented as tokens per worker: the scheduler never admits more worker
 * tokens than either the worker ceiling OR the memory ceiling can pay for.
 */
export function resolveTaskBudget({
  workerBudget,
  memoryBudgetMb,
  memoryBudgetScope,
  sharedMemoryBudgetMb,
  workerMemoryMb,
  maxConcurrentTasks = 2,
  reserveWorkers = 1,
  taskCgroupPidsMax = null,
  pidsPerConcurrentTask = PIDS_PER_CONCURRENT_TASK,
  pidsReserve = PIDS_RESERVE,
}) {
  const configuredWorkerBudget = positiveInteger(workerBudget, "workerBudget");
  const configuredMemoryBudgetMb = positiveInteger(
    memoryBudgetMb,
    "memoryBudgetMb",
  );
  if (memoryBudgetScope !== undefined || sharedMemoryBudgetMb !== undefined) {
    if (typeof memoryBudgetScope !== 'string' || !memoryBudgetScope.trim() || memoryBudgetScope.length > 500 ||
        !Number.isSafeInteger(sharedMemoryBudgetMb) || sharedMemoryBudgetMb < 1)
      throw new Error('Scoped admission requires a shared memory budget and non-empty scope');
  }
  const configuredWorkerMemoryMb = positiveInteger(
    workerMemoryMb,
    "workerMemoryMb",
  );
  const configuredMaxConcurrentTasks = positiveInteger(
    maxConcurrentTasks,
    "maxConcurrentTasks",
  );
  const configuredReserveWorkers = positiveInteger(
    reserveWorkers,
    "reserveWorkers",
  );
  const configuredPidsPerConcurrentTask = positiveInteger(
    pidsPerConcurrentTask,
    "pidsPerConcurrentTask",
  );
  const configuredPidsReserve = nonNegativeInteger(pidsReserve, "pidsReserve");
  const configuredTaskCgroupPidsMax =
    taskCgroupPidsMax == null || taskCgroupPidsMax === ""
      ? null
      : nonNegativeInteger(taskCgroupPidsMax, "taskCgroupPidsMax");
  const memoryWorkerBudget = Math.floor(
    configuredMemoryBudgetMb / configuredWorkerMemoryMb,
  );
  if (memoryWorkerBudget < 1) {
    throw new Error(
      `memoryBudgetMb=${configuredMemoryBudgetMb} cannot admit one ` +
        `workerMemoryMb=${configuredWorkerMemoryMb} token`,
    );
  }
  const effectiveWorkerBudget = Math.min(
    configuredWorkerBudget,
    memoryWorkerBudget,
  );
  let pidsMaxConcurrentTasks = null;
  let effectivePidsPerConcurrentTask = configuredPidsPerConcurrentTask;
  let effectivePidsReserve = configuredPidsReserve;
  let pidsBudgetAdapted = false;
  if (configuredTaskCgroupPidsMax != null) {
    // A confined capability task can receive fewer pids than the conservative host-wide
    // envelope (for example pids.max=512 versus the default 4096-per-task + 1024 reserve).
    // That is a narrower scheduling budget, not proof that no test can run. Scale the two
    // configured terms together so one serial task still has a fitting envelope. Keep a true
    // refusal only for a cgroup that cannot contain even one process (pids.max=0).
    if (configuredTaskCgroupPidsMax === 0) {
      const usablePids = configuredTaskCgroupPidsMax - configuredPidsReserve;
      throw new Error(
        `task cgroup pids.max=${configuredTaskCgroupPidsMax} leaves ${Math.max(0, usablePids)} ` +
          `after pidsReserve=${configuredPidsReserve}, below one ` +
          `pidsPerConcurrentTask=${configuredPidsPerConcurrentTask} envelope; refusing before launch ` +
          formatTaskBudgetRefusal({
            kind: "pids",
            unit: "tasks",
            limit: configuredTaskCgroupPidsMax,
            reserve: configuredPidsReserve,
            requiredPerTask: configuredPidsPerConcurrentTask,
          }),
      );
    }
    const configuredPidsEnvelope =
      configuredPidsReserve + configuredPidsPerConcurrentTask;
    if (configuredTaskCgroupPidsMax < configuredPidsEnvelope) {
      // Preserve the configured reserve/envelope ratio while rounding to integral pids. The
      // per-task term gets the remainder, so effectiveReserve + effectivePerTask always fits.
      effectivePidsReserve = Math.min(
        configuredPidsReserve,
        Math.floor(
          (configuredTaskCgroupPidsMax * configuredPidsReserve) /
            configuredPidsEnvelope,
        ),
      );
      effectivePidsPerConcurrentTask = Math.min(
        configuredPidsPerConcurrentTask,
        configuredTaskCgroupPidsMax - effectivePidsReserve,
      );
      pidsBudgetAdapted = true;
    }
    const usablePids = configuredTaskCgroupPidsMax - effectivePidsReserve;
    pidsMaxConcurrentTasks = Math.floor(
      usablePids / effectivePidsPerConcurrentTask,
    );
    if (pidsMaxConcurrentTasks < 1) {
      throw new Error(
        `task cgroup pids.max=${configuredTaskCgroupPidsMax} leaves ${Math.max(0, usablePids)} ` +
          `after pidsReserve=${effectivePidsReserve}, below one ` +
          `pidsPerConcurrentTask=${effectivePidsPerConcurrentTask} envelope; refusing before launch ` +
          formatTaskBudgetRefusal({
            kind: "pids",
            unit: "tasks",
            limit: configuredTaskCgroupPidsMax,
            reserve: effectivePidsReserve,
            requiredPerTask: effectivePidsPerConcurrentTask,
          }),
      );
    }
  }
  const effectiveMaxConcurrentTasks = Math.min(
    configuredMaxConcurrentTasks,
    pidsMaxConcurrentTasks ?? configuredMaxConcurrentTasks,
  );
  const parallel =
    effectiveWorkerBudget > configuredReserveWorkers &&
    effectiveMaxConcurrentTasks > 1;

  return {
    workerBudget: configuredWorkerBudget,
    memoryBudgetMb: configuredMemoryBudgetMb,
    ...(memoryBudgetScope ? { memoryBudgetScope, sharedMemoryBudgetMb } : {}),
    workerMemoryMb: configuredWorkerMemoryMb,
    memoryWorkerBudget,
    // EI-20801764054303492: WHICH term bound the budget. Without this, a gate log records the
    // resolved concurrency but not the reason for it, so the next incident has to re-derive the
    // whole chain from source to learn whether the memory rail engaged at all — which is exactly
    // how the rail stayed INERT unnoticed long enough to force the 8 -> 4 -> 2 fork walk.
    // 'memory' means the host measurement is what held concurrency down (raising the ceiling
    // would change nothing); 'ceiling' means the configured ceiling is binding and memory had
    // headroom to spare. Read this BEFORE proposing a ceiling change.
    boundBy: memoryWorkerBudget < configuredWorkerBudget ? "memory" : "ceiling",
    effectiveWorkerBudget,
    maxConcurrentTasks: effectiveMaxConcurrentTasks,
    configuredMaxConcurrentTasks,
    pidsMaxConcurrentTasks,
    taskCgroupPidsMax: configuredTaskCgroupPidsMax,
    pidsPerConcurrentTask: effectivePidsPerConcurrentTask,
    pidsReserve: effectivePidsReserve,
    configuredPidsPerConcurrentTask,
    configuredPidsReserve,
    pidsBudgetAdapted,
    taskBoundBy:
      pidsBudgetAdapted ||
      effectiveMaxConcurrentTasks < configuredMaxConcurrentTasks
        ? "pids"
        : "ceiling",
    reserveWorkers: configuredReserveWorkers,
    mode: parallel ? "parallel" : "serial",
    primaryWorkers: parallel
      ? effectiveWorkerBudget - configuredReserveWorkers
      : effectiveWorkerBudget,
    reserveLaneWorkers: parallel ? configuredReserveWorkers : 0,
  };
}

/**
 * How many worker tokens the host can pay for RIGHT NOW, from a fresh MemAvailable reading.
 *
 * EI-20801764054303492 route (a). The startup budget is resolved from a SINGLE reading taken
 * before any child exists, and a gate run lasts ~55 minutes on a box shared with a large agent
 * fleet — so by the time the tenth task is admitted, the reading the whole run's concurrency
 * rests on can be an hour stale and describe a machine that no longer exists. Re-measuring at
 * each admission is what makes "a quiet box runs wide, a loaded box throttles" actually TRUE,
 * rather than "the box was quiet once, so we run wide regardless".
 *
 * SAFETY — this can only ever LOWER admission, never widen it: the result is clamped by the
 * lane's configured width, which was itself already clamped by the startup budget. A missing or
 * unreadable measurement returns the lane width unchanged, so a non-Linux host or a /proc read
 * failure degrades to exactly the previous behaviour instead of throttling to one worker.
 *
 * FLOOR of one: a host that cannot pay for a single token still makes progress serially. The
 * alternative — refusing admission — would deadlock a run that is already under memory pressure,
 * which is the worst possible moment to stop making forward progress.
 *
 * ⚠ KNOWN CONSERVATISM GAP: a child's heap materialises over its first minutes, so a reading
 * taken moments after an admission still counts that memory as available. {@link
 * MEMORY_RESERVE_FRACTION} is the headroom standing in for it. Modelling the unrealised
 * remainder would need a per-child ramp estimate this scheduler does not have, and guessing it
 * wrong throttles a healthy box — so the gap is documented rather than approximated.
 */
export function admissibleWorkersForMemory({
  laneWorkers,
  workerMemoryMb,
  memAvailableMb,
  reserveFraction = MEMORY_RESERVE_FRACTION,
}) {
  const configuredLaneWorkers = positiveInteger(laneWorkers, "laneWorkers");
  // WI-41206 / remove-memory-derived-work-refusals-2026-08-24: memory NO LONGER narrows the
  // lane. This function used to return min(configured, floor(usable / perWorker)).
  //
  // The reasoning that survives: a reading is an OBSERVATION, not a configuration value, and
  // this scheduler was already the best-behaved memory consumer in the tree — it PACED rather
  // than refusing, precisely because "refusing admission would deadlock a run that is already
  // under memory pressure". The owner's call is that the same argument extends one step: a
  // host driven into paging should get SLOWER on its own, from actual contention, rather than
  // from us pre-emptively narrowing the lane on a snapshot that is stale the moment it is read.
  //
  // The arguments are retained (call sites unchanged) and the measurement is still logged via
  // `memAvailableMb=` in the stats line, so the concurrency decision stays auditable.
  // reserveFraction stays VALIDATED for the same reason as in resolveMemoryBudgetMb: silently
  // ignoring a nonsensical public argument lets a caller believe a limit is in force.
  if (!(reserveFraction >= 0 && reserveFraction < 1)) {
    throw new Error(
      `reserveFraction must be in [0, 1); received ${String(reserveFraction)}`,
    );
  }
  void memAvailableMb;
  void workerMemoryMb;
  return configuredLaneWorkers;
}

const finiteEstimate = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

function pendingTask(task, index, estimateMs) {
  return { task, index, estimateMs: finiteEstimate(estimateMs) };
}

/** Pick the longest KNOWN task. Unknowns retain declaration order. */
function takeLongest(pending) {
  let chosen = 0;
  let best = -1;
  for (let i = 0; i < pending.length; i++) {
    const estimate = pending[i].estimateMs;
    if (estimate != null && estimate > best) {
      best = estimate;
      chosen = i;
    }
  }
  return pending.splice(chosen, 1)[0];
}

/** Pick the shortest KNOWN task for the reserved lane. Unknowns retain declaration order. */
function takeShortest(pending) {
  let chosen = -1;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < pending.length; i++) {
    const estimate = pending[i].estimateMs;
    if (estimate != null && estimate < best) {
      best = estimate;
      chosen = i;
    }
  }
  if (chosen < 0) chosen = 0;
  return pending.splice(chosen, 1)[0];
}

/**
 * Project elapsed wall time for a planned run using the scheduler's actual lane policy.
 *
 * Historical durations are useful for a prognosis, but they are not a proof about the next
 * run: a task can be faster or slower than its history, and an unknown task contributes no
 * duration at all. Keep those facts explicit in the result. In particular, do not sum task
 * durations and call that a wall-time lower bound — the parallel lanes make that sum serial-
 * equivalent work, not elapsed time.
 *
 * The simulation mirrors an uncontended admission turn: primary lanes take the
 * longest known pending tasks, the reserved lane takes the shortest known pending task, and the
 * next task on each lane starts when that lane becomes free. Shards are summed because
 * `runBudgetedTaskShards` runs them sequentially.
 */
export function estimateBudgetedTaskWallMs(plan, options) {
  if (!plan?.shards?.length) {
    return {
      projectedWallMs: 0,
      knownWorkMs: 0,
      knownTasks: 0,
      unknownTasks: 0,
      mode: "serial",
      maxConcurrentTasks: 0,
    };
  }

  const budget = resolveTaskBudget(options);
  const estimateFor =
    typeof options?.estimateMs === "function" ? options.estimateMs : () => null;
  let projectedWallMs = 0;
  let knownWorkMs = 0;
  let knownTasks = 0;
  let unknownTasks = 0;

  for (const shard of plan.shards) {
    const pending = shard.tasks.map((task, index) => {
      const estimateMs = finiteEstimate(estimateFor(task, index));
      if (estimateMs == null) unknownTasks += 1;
      else {
        knownTasks += 1;
        knownWorkMs += estimateMs;
      }
      return { task, index, estimateMs };
    });

    if (pending.length === 0) continue;
    if (budget.mode !== "parallel" || pending.length <= 1) {
      projectedWallMs += pending.reduce(
        (total, entry) => total + (entry.estimateMs ?? 0),
        0,
      );
      continue;
    }

    const lanes = taskLanes(budget).map((lane) => ({ ...lane, readyAt: 0 }));
    while (pending.length > 0) {
      // Keep ties in launch order, as in the real runner's concurrent first wave.
      const lane = lanes.reduce((first, candidate) =>
        candidate.readyAt < first.readyAt ? candidate : first,
      );
      const entry = lane.take(pending);
      lane.readyAt += entry.estimateMs ?? 0;
    }
    projectedWallMs += Math.max(...lanes.map(({ readyAt }) => readyAt));
  }

  return {
    projectedWallMs,
    knownWorkMs,
    knownTasks,
    unknownTasks,
    mode: budget.mode,
    maxConcurrentTasks: budget.maxConcurrentTasks,
  };
}

/**
 * A narrowed suite is never projected below this: process start, transform and collection
 * cost the same whether one file runs or ten (D-030 measurement, 2026-10-20).
 */
export const NARROWED_TASK_FLOOR_MS = 30_000;

/**
 * Projected wall time of a planned radius, for callers that must decide BEFORE running it
 * whether it fits a budget (green-main-ratchet-convergence-2026-10-17#D-030: the sync-batch
 * delta check admits by time, not by task count).
 *
 * The lane simulation is `estimateBudgetedTaskWallMs`, the same one the run's admission
 * intent uses. The only difference is the per-task estimate: a `--related` run executes a
 * narrowed suite, so a task with a narrowed share in (0, 1) is scaled by that share, floored
 * at NARROWED_TASK_FLOOR_MS and never above its full history. That is a prognosis, not a
 * bound: the history is an EWMA over full AND narrowed runs, and a lane's share of the
 * selected files is approximated by the workspace's share.
 *
 * @param plan        a planAffectedTaskShards plan (shards run sequentially, as in the run)
 * @param options     TaskBudgetInput plus
 *   estimateMs(task)   full-suite history estimate in ms, or null when unknown
 *   narrowedShare(task) fraction of the suite a narrowed run executes, or null when not narrowed
 *   taskKey(task)      the history key, used to name the heaviest task
 */
export function projectAffectedRunEta(plan, options) {
  const { estimateMs, narrowedShare, taskKey, ...budgetInput } = options ?? {};
  const estimateFull = typeof estimateMs === "function" ? estimateMs : () => null;
  const shareOf = typeof narrowedShare === "function" ? narrowedShare : () => null;
  const keyOf = typeof taskKey === "function" ? taskKey : (_task, index) => String(index);
  let narrowedTasks = 0;
  let heaviest = null;
  let tasks = 0;
  const scaled = (task, index) => {
    const full = finiteEstimate(estimateFull(task, index));
    if (full == null) return null;
    const share = shareOf(task, index);
    let ms = full;
    if (typeof share === "number" && Number.isFinite(share) && share >= 0 && share < 1) {
      narrowedTasks += 1;
      ms = Math.min(full, Math.max(full * share, NARROWED_TASK_FLOOR_MS));
    }
    if (!heaviest || ms > heaviest.ms) heaviest = { key: String(keyOf(task, index)), ms };
    return ms;
  };
  for (const shard of plan?.shards ?? []) tasks += shard.tasks.length;
  const projection = estimateBudgetedTaskWallMs(plan, { ...budgetInput, estimateMs: scaled });
  return {
    projectedSec: Math.round(projection.projectedWallMs / 1000),
    workSec: Math.round(projection.knownWorkMs / 1000),
    knownTasks: projection.knownTasks,
    tasks,
    unknownTasks: projection.unknownTasks,
    concurrency: projection.maxConcurrentTasks,
    narrowedTasks,
    heaviest: heaviest ? { key: heaviest.key, sec: Math.round(heaviest.ms / 1000) } : null,
  };
}

/**
 * One greppable print-mode line. Every field is a space-free token so a consumer can split on
 * whitespace; the heaviest task's history key loses its " :: " spacing for the same reason.
 */
export function formatAffectedEtaLine(eta) {
  if (!eta || eta.error) {
    const reason = String(eta?.error ?? "no-projection").replace(/\s+/g, "_").slice(0, 200);
    return `AFFECTED_ETA status=unavailable reason=${reason}`;
  }
  const heaviest = eta.heaviest
    ? ` heaviestSec=${eta.heaviest.sec} heaviestTask=${eta.heaviest.key.replace(/\s+/g, "")}`
    : "";
  return (
    `AFFECTED_ETA status=projected projectedSec=${eta.projectedSec} workSec=${eta.workSec} ` +
    `knownTasks=${eta.knownTasks} tasks=${eta.tasks} unknownTasks=${eta.unknownTasks} ` +
    `concurrency=${eta.concurrency} narrowedTasks=${eta.narrowedTasks}${heaviest}`
  );
}

/** Reuse one allocation policy for execution and its wall-clock projection. */
function taskLanes(budget) {
  if (budget.mode !== "parallel") {
    return [{ lane: "serial", workers: budget.effectiveWorkerBudget, take: takeLongest }];
  }
  // Preserve the default primary + reserved split. Raising the existing task ceiling
  // adds primary lanes, dividing the SAME worker/memory budget rather than multiplying it.
  const count = Math.min(budget.maxConcurrentTasks - 1, budget.primaryWorkers);
  const width = Math.floor(budget.primaryWorkers / count);
  const remainder = budget.primaryWorkers % count;
  return [
    ...Array.from({ length: count }, (_, index) => ({
      lane: "primary", workers: width + (index < remainder ? 1 : 0), take: takeLongest,
    })),
    { lane: "reserved", workers: budget.reserveLaneWorkers, take: takeShortest },
  ];
}

/**
 * Run tasks under one global worker+memory envelope.
 *
 * In parallel mode primary lanes divide all but the reserved worker tokens and
 * select longest-first. The reserved lane consumes the remaining tokens and selects
 * shortest-first. This overlaps fixed per-leg overhead and short guards without ever
 * multiplying a per-workspace cap. A one-worker/memory-token budget collapses to serial.
 * Results are returned in declaration order regardless of completion order.
 */
function createBudgetedTaskRun(tasks, options) {
  const budget = resolveTaskBudget(options);
  const lanes = taskLanes(budget);
  const estimateMs = options.estimateMs ?? (() => null);
  const runTask = options.runTask;
  if (typeof runTask !== "function")
    throw new Error("runTask must be a function");
  const onTaskSettled = options.onTaskSettled;
  if (onTaskSettled != null && typeof onTaskSettled !== "function") {
    throw new Error("onTaskSettled must be a function when provided");
  }
  // EI-20801764054303492 route (a): an OPT-IN live reading. Absent ⇒ every allocation below is
  // byte-identical to the pre-clamp scheduler, which is the back-compat contract every existing
  // caller and test relies on. Present ⇒ admission re-checks memory and may only ever admit LESS.
  const readMemAvailableMb =
    typeof options.readMemAvailableMb === "function"
      ? options.readMemAvailableMb
      : null;

  const pending = tasks.map((task, index) =>
    pendingTask(task, index, estimateMs(task, index)),
  );
  const results = new Array(tasks.length);
  let activeWorkers = 0;
  let activeTasks = 0;
  let observedMaxWorkers = 0;
  let observedMaxMemoryMb = 0;
  let observedMaxTasks = 0;
  let firstError = null;
  let admissions = 0;
  // null (not 0) when no reader was supplied: "nobody measured" and "measured zero times" are
  // different facts, and the marker below distinguishes them by exactly this null.
  let memoryReadings = readMemAvailableMb ? 0 : null;
  let admissionClamps = 0;
  let minAdmittedWorkers = null;
  let lastMemAvailableMb = null;

  const clampByMemory = (laneWorkers) => {
    let reading;
    try {
      reading = readMemAvailableMb();
    } catch {
      // A THROWING instrument is a broken instrument, never a report of "no memory left". Admit
      // the unclamped lane width: a probe bug must not throttle a healthy box to one worker.
      return laneWorkers;
    }
    memoryReadings += 1;
    const measured = reading == null ? Number.NaN : Number(reading);
    lastMemAvailableMb = Number.isFinite(measured) ? measured : null;
    const admitted = admissibleWorkersForMemory({
      laneWorkers,
      workerMemoryMb: budget.workerMemoryMb,
      memAvailableMb: reading,
    });
    if (admitted < laneWorkers) admissionClamps += 1;
    return admitted;
  };

  // Re-measure before every admission EXCEPT the run's first: the startup reading that sized the
  // budget is still fresh at that point, so re-reading it there would add noise without adding
  // information. Every later admission is racing children whose heaps have grown since it.
  //
  // ⚠ LOAD-BEARING COMPOSITION — the first admission is UNMEASURED, so on its own this clamp does
  // NOT protect it: at an 8-worker/4GiB config that admission is 32GiB, the exact shape
  // green-checkpoint records as OOM-killing this box. It is safe ONLY because the STARTUP budget
  // is itself sized from a fresh reading (resolveMemoryBudgetMb, wired in affected-tests.mjs and
  // source-pinned by the WI-39472 guards), so a box that is already short on memory never reaches
  // admission #0 with a wide budget. Weaken that startup sizing and you silently unprotect the
  // first admission — the two halves only work together (EI-20801764054303492).
  const admitWorkersFor = (laneWorkers) => {
    if (!readMemAvailableMb) return laneWorkers;
    const admitted =
      admissions === 0 ? laneWorkers : clampByMemory(laneWorkers);
    minAdmittedWorkers =
      minAdmittedWorkers == null
        ? admitted
        : Math.min(minAdmittedWorkers, admitted);
    return admitted;
  };

  const runOne = async (entry, lane, requestedWorkers) => {
    const execute = async (workers) => {
    if (firstError) throw firstError;
    const memoryMb = workers * budget.workerMemoryMb;
    admissions += 1;
    activeWorkers += workers;
    activeTasks += 1;
    observedMaxWorkers = Math.max(observedMaxWorkers, activeWorkers);
    observedMaxMemoryMb = Math.max(
      observedMaxMemoryMb,
      activeWorkers * budget.workerMemoryMb,
    );
    observedMaxTasks = Math.max(observedMaxTasks, activeTasks);
    if (
      activeWorkers > budget.effectiveWorkerBudget ||
      activeWorkers * budget.workerMemoryMb > budget.memoryBudgetMb ||
      activeTasks > budget.maxConcurrentTasks
    ) {
      throw new Error(
        "budgeted task scheduler admitted work beyond its configured ceiling",
      );
    }
    const allocation = { lane, workers, memoryMb };
    try {
      const value = await runTask(entry.task, allocation, entry.index);
      const scheduled = {
        task: entry.task,
        index: entry.index,
        allocation,
        value,
      };
      results[entry.index] = scheduled;
      // Settlement is the durable-observation seam: callers that need to retain a completed
      // task before a long sibling (or the parent process) disappears can do so here, while
      // declaration-order result replay remains unchanged. Await the callback so a following
      // admission never outruns that persistence.
      if (onTaskSettled) await onTaskSettled(scheduled);
    } catch (error) {
      firstError ??= error;
      throw error;
    } finally {
      activeWorkers -= workers;
      activeTasks -= 1;
    }
    };
    try {
      return options.admitTask
        ? await options.admitTask(entry.task, requestedWorkers, execute, entry.index)
        : await execute(requestedWorkers);
    } catch (error) { firstError ??= error; throw error; }
  };

  const runLane = async (lane, workers, take, turn) => {
    while (pending.length > 0 && firstError == null && !turn.yielded) {
      // Let the initial concurrent wave start, then stop refilling when a peer
      // is queued. Both lanes drain before the holder releases its FIFO slot.
      if (
        admissions - turn.startedAdmissions >= lanes.length &&
        turn.hasWaiters && await turn.hasWaiters()
      ) turn.yielded = true;
      // The other lane may have settled or taken the final task during the read.
      if (turn.yielded || firstError != null || pending.length === 0) break;
      const entry = take(pending);
      await runOne(entry, lane, admitWorkersFor(workers));
    }
  };

  return async (hasWaiters) => {
    const turn = { startedAdmissions: admissions, yielded: false, hasWaiters };
    if (budget.mode === "parallel" && pending.length > 1) {
      // Promise.all rejects before its siblings settle. Stop new admissions and
      // drain the surviving child and its persistence before releasing the slot.
      const outcomes = await Promise.allSettled(
        lanes.map(({ lane, workers, take }) => runLane(lane, workers, take, turn)),
      );
      const rejected = outcomes.find((lane) => lane.status === "rejected");
      if (rejected) throw rejected.reason;
    } else {
      await runLane("serial", budget.effectiveWorkerBudget, takeLongest, turn);
    }

    return {
      results,
      pendingTasks: pending.length,
      stats: {
        ...budget,
        observedMaxWorkers,
        observedMaxMemoryMb,
        observedMaxTasks,
        memoryReadings,
        admissionClamps,
        minAdmittedWorkers,
        lastMemAvailableMb,
      },
    };
  };
}

/**
 * Run one scheduler invocation behind the shared test-process admission gate.
 *
 * The lock covers all active children, not just the synchronous
 * launch call: the child process and all of its Vitest descendants remain the
 * admitted resident workload until `runTask` settles.  `withFsMutex` releases
 * in a finally block and reclaims a stale/dead owner, so a failed or crashed
 * runner cannot leave later verification permanently wedged. A queued peer
 * stops lane refill after the initial wave; pending tasks resume through a
 * fresh FIFO ticket after all active work drains. State and queue spending
 * remain scoped to the complete invocation, rather than restarting per turn.
 *
 * EI-21921867787033533: under heavy fleet-wide load this mutex is a real,
 * intentional serialization point — most concurrent `test:affected` callers
 * are correctly BLOCKED here, one at a time, for as long as ~4h
 * (SHARED_TEST_PROCESS_ADMISSION_TIMEOUT_MS). Every liveness probe (systemd
 * ActiveState, process state, CPU%) reads a queued caller as "alive but doing
 * nothing", indistinguishable from a genuine wedge. `withFsMutex` already
 * supports an `onWaiting` callback for exactly this — fired once, the first
 * time a caller actually has to wait — but nothing wired it up here, so a
 * queued `test:affected` produced zero diagnostic output for however long it
 * queued. Wiring it in costs nothing on the (usual) uncontended path and
 * turns a silent multi-hour queue wait into one attributable stderr line the
 * moment it starts waiting.
 */
/**
 * Render a holder's owner record as ONE decision-shaped line.
 *
 * EI-21917992245424964: the notice previously interpolated the raw owner file, so every
 * re-announcement emitted eight lines of pretty-printed JSON whose four fields were all
 * about IDENTITY (pid/host/startedAt/name) and none about whether waiting was worth it.
 * Repeated on a 60s cadence for as long as the queue lasts, that is a lot of bytes saying
 * nothing a waiter can act on.
 *
 * `intent=undeclared` is emitted deliberately rather than omitted: a waiter must be able to
 * tell "the holder did not say" from "the holder said it is cheap". Silently dropping the
 * field makes those two read identically, which is the failure this whole change exists to
 * remove — one more confident-looking absence.
 *
 * Fails open to the raw text on any parse problem. This is a diagnostic printed while
 * something is already blocked; it must never be the thing that throws.
 */
export function formatAdmissionHolder(ownerText, now = Date.now()) {
  const raw = String(ownerText ?? "").trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw;

  const bits = [];
  if (parsed.pid != null) bits.push(`pid=${parsed.pid}`);
  if (parsed.ownerId) bits.push(`owner=${parsed.ownerId}`);
  if (parsed.taskId) bits.push(`task=${parsed.taskId}`);
  if (parsed.admission) {
    for (const key of ['resource', 'workers', 'workerMemoryMb', 'workerBudget', 'memoryBudgetMb', 'memoryBudgetScope', 'sharedMemoryBudgetMb', 'maxConcurrentTasks'])
      if (parsed.admission[key] != null) bits.push(`${key}=${parsed.admission[key]}`);
  }
  const acquiredAtMs = parsed.acquiredAt ? Date.parse(parsed.acquiredAt) : NaN;
  if (Number.isFinite(acquiredAtMs)) {
    const heldMs = now - acquiredAtMs;
    if (heldMs >= 0) bits.push(`held=${Math.round(heldMs / 1000)}s`);
  }
  const intent =
    parsed.intent && typeof parsed.intent === "object" && !Array.isArray(parsed.intent)
      ? parsed.intent
      : null;
  if (intent) {
    for (const [key, value] of Object.entries(intent)) bits.push(`${key}=${value}`);
  } else {
    bits.push("intent=undeclared");
  }
  const wait = parsed.admissionWait;
  if (wait && typeof wait === 'object') {
    bits.push(`constraints=${(Array.isArray(wait.constraints) ? wait.constraints : []).join(',') || 'none'}`);
    for (const key of ['availableWorkers', 'availableMemoryMb', 'activeTasks', 'taskCap'])
      if (wait[key] != null) bits.push(`${key}=${wait[key]}`);
    if (Array.isArray(wait.readers)) bits.push(`readers=${wait.readerCount}[${wait.readers.filter(reader => reader && typeof reader === 'object').map(reader =>
      `pid=${reader.pid ?? 'unknown'} owner=${reader.ownerId ?? 'unknown'} task=${reader.taskId ?? 'unknown'} resource=${reader.admission?.resource ?? 'unknown'}`).join('; ')}]`);
    if (wait.predecessor) bits.push(`predecessorPid=${wait.predecessor.pid ?? 'unknown'} predecessorResource=${wait.predecessor.admission?.resource ?? 'unknown'}`);
  }
  return bits.length > 0 ? bits.join(" ") : raw;
}

/**
 * WI-2142172: tell the WAITER whether it can plausibly be admitted before its own budget
 * runs out — the one thing the queued notice never said.
 *
 * The measured failure: a 4-path run queued behind a 36-task holder whose declared projected
 * wait nearly filled the waiter's 2700s budget. Every input needed to see that was ALREADY on
 * the notice — the holder's projection, the waiter's elapsed, the waiter's budget — but nobody
 * did the arithmetic, so the line read as ordinary serialization for ~40 minutes and the run
 * ended `refused` with 28/28 undetermined and zero tasks measured. Nothing was broken; the
 * reader simply had no prognosis.
 *
 * The projection is deliberately NOT a proof: historical durations can be wrong and the
 * scheduler overlaps tasks. `etaProjectedSec` is a concurrency-aware estimate over the tasks
 * with history; `etaWorkSec` retains the serial-equivalent sum for diagnosis, not wall time.
 * Hence the warning text says projection and never claims starvation is proven. Two graded
 * warning bands remain useful: PROJECTED TO STARVE once the projection does not fit, ADMISSION
 * AT RISK once most of the remaining budget is committed to waiting, and silence below that.
 *
 * `etaFromTasks=0/n` is reported as an explicit unknown rather than silently skipped, for
 * the same reason `intent=undeclared` is: "the holder could not estimate" and "the holder
 * is nearly done" must never read alike. Legacy holders that only publish `etaMinSec` are
 * also treated as unknown because their serial sum cannot be converted to wall time here.
 *
 * Fails open to "". It is a diagnostic printed while something is already blocked; it must
 * never be the thing that throws.
 */
export function formatAdmissionProspect(ownerText, waiter, now = Date.now()) {
  try {
    const elapsedMs = Number(waiter?.elapsedMs);
    const budgetMs = Number(waiter?.budgetMs);
    if (
      !Number.isFinite(elapsedMs) ||
      !Number.isFinite(budgetMs) ||
      budgetMs <= 0
    )
      return "";

    const parsed = JSON.parse(String(ownerText ?? "").trim());
    const intent =
      parsed?.intent &&
      typeof parsed.intent === "object" &&
      !Array.isArray(parsed.intent)
        ? parsed.intent
        : null;
    if (!intent) return "";

    // A ratio whose numerator is 0 means the projection saw no duration history at all, so the
    // displayed estimate is really zero information wearing a number's clothes. Say so.
    const covered = /^(\d+)\s*\/\s*(\d+)$/.exec(
      String(intent.etaFromTasks ?? ""),
    );
    if (covered && Number(covered[1]) === 0) {
      return (
        ` — PROSPECT UNKNOWN: the holder's projection covers ${intent.etaFromTasks} of its ` +
        `tasks, so it carries no information about when you will be admitted.`
      );
    }

    const etaProjectedSec = Number(intent.etaProjectedSec);
    if (!Number.isFinite(etaProjectedSec) || etaProjectedSec <= 0) {
      const legacyEtaSec = Number(intent.etaMinSec);
      return Number.isFinite(legacyEtaSec) && legacyEtaSec > 0
        ? ` — PROSPECT UNKNOWN: the holder reports legacy etaMinSec=${legacyEtaSec} ` +
            `as serial-equivalent work, not a concurrency-aware wall-time projection.`
        : "";
    }

    const acquiredAtMs = parsed.acquiredAt
      ? Date.parse(parsed.acquiredAt)
      : NaN;
    const heldSec = Number.isFinite(acquiredAtMs)
      ? Math.max(0, (now - acquiredAtMs) / 1000)
      : 0;
    const holderRemainingSec = Math.max(0, etaProjectedSec - heldSec);
    const budgetRemainingSec = Math.max(0, (budgetMs - elapsedMs) / 1000);
    if (budgetRemainingSec <= 0) return "";

    // THE BAND MATTERS. Warn in two graded bands, both honest about uncertainty: at >=1.0 the
    // history-based projection exceeds the remaining budget; at >=0.5 most of the remaining
    // budget is committed to waiting. Below that, stay silent rather than manufacturing
    // reassurance from an estimate.
    const ratio = holderRemainingSec / budgetRemainingSec;
    if (ratio < 0.5) return "";

    const unknownTasks = Number(intent.etaUnknownTasks);
    const shared =
      `about ${Math.round(holderRemainingSec)}s of projected wall time remains for the holder ` +
      `(etaProjectedSec=${etaProjectedSec}` +
      `${intent.etaWorkSec != null ? `, etaWorkSec=${intent.etaWorkSec}` : ""}` +
      `${intent.etaMode ? `, mode=${intent.etaMode}` : ""}` +
      `${intent.etaConcurrency != null ? `, concurrency=${intent.etaConcurrency}` : ""}` +
      `${intent.etaFromTasks ? ` over ${intent.etaFromTasks} tasks` : ""}, held=` +
      `${Math.round(heldSec)}s); only ${Math.round(budgetRemainingSec)}s of your budget ` +
      `remains. This is a history-based projection, not a guarantee.` +
      (Number.isFinite(unknownTasks) && unknownTasks > 0
        ? ` ${Math.round(unknownTasks)} task(s) have no duration history.`
        : "");

    return ratio >= 1
      ? ` — ⚠ PROJECTED TO STARVE: ${shared} The projection exceeds your remaining budget; ` +
          `fall back to narrower verification NOW rather than discovering this at the budget wall.`
      : ` — ⚠ ADMISSION AT RISK: ${shared} Roughly ${Math.round(ratio * 100)}% of your ` +
          `remaining budget is already committed to waiting; consider falling back to ` +
          `narrower verification now.`;
  } catch {
    return "";
  }
}

export async function runBudgetedTasks(tasks, options) {
  // WI-1490656: `console.error` cannot reach the affected-tests RUN LOG — that file is
  // written by the runner's own `logLine`/`errSync`, so the queued notice landed only on
  // stderr and was absent from all 993 run logs on this box. The run log is the artifact
  // the runner itself tells a triager to grep, so a queued caller looked silent in exactly
  // the place it was supposed to explain itself. Callers inject a sink that writes BOTH.
  const notify = options?.onAdmissionNotice ?? ((line) => console.error(line));
  const timeoutMs =
    Number(options?.admissionTimeoutMs) > 0
      ? Number(options.admissionTimeoutMs)
      : SHARED_TEST_PROCESS_ADMISSION_TIMEOUT_MS;
  if (typeof options.taskAdmissionKey === 'function') {
    // Native artifact readers also import this module without running tasks.
    // Resolve the new admission API only at its execution boundary.
    const { withFsMutexBudget } = await import('./fs-mutex.mjs');
    const budget = resolveTaskBudget(options);
    // Charge the union of idle queue intervals, never concurrent waits or
    // time when this invocation is already executing/persisting a task.
    const waiting = new Set();
    let queuedMs = 0, waitingSince = null, reportedMs = 0, resident = 0;
    const spend = () => queuedMs + (waitingSince === null ? 0 : Date.now() - waitingSince);
    const updateClock = () => {
      const shouldRun = waiting.size > 0 && resident === 0;
      if (shouldRun && waitingSince === null) waitingSince = Date.now();
      if (!shouldRun && waitingSince !== null) {
        queuedMs += Date.now() - waitingSince; waitingSince = null;
      }
    };
    const leave = token => {
      waiting.delete(token);
      updateClock();
    };
    const run = createBudgetedTaskRun(tasks, { ...options,
      admitTask: async (task, workers, execute, index) => {
        const token = {};
        waiting.add(token);
        updateClock();
        try {
          return await withFsMutexBudget(admissionMutexName(), async granted => {
            leave(token);
            const deadline = options.deadlineEpochMs === undefined ? readTaskDeadlineEpochMs() : options.deadlineEpochMs;
            if (deadline != null) {
              const estimate = options.estimateMs?.(task, index);
              const known = Number.isFinite(estimate) && estimate >= 0;
              admitTaskDeadline({ env: { PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(deadline) },
                knownEstimateMs: known ? Math.ceil(estimate) : 0, knownTasks: known ? 1 : 0, unknownTasks: known ? 0 : 1 });
            }
            resident++; updateClock();
            try { return await execute(granted); }
            finally { resident--; updateClock(); }
          }, { workers, workerMemoryMb: budget.workerMemoryMb,
            workerBudget: budget.effectiveWorkerBudget, memoryBudgetMb: budget.memoryBudgetMb,
            memoryBudgetScope: budget.memoryBudgetScope, sharedMemoryBudgetMb: budget.sharedMemoryBudgetMb,
            maxConcurrentTasks: budget.maxConcurrentTasks,
            resource: options.taskAdmissionKey(task) || '*',
            intent: { ...options.admissionIntent, taskIndex: index },
            timeoutMs, remainingMs: () => timeoutMs - spend(),
            onWaiting: ({ owner, elapsedMs }) => notify(
              `AFFECTED_TESTS_ADMISSION_QUEUED task-sized lease waiting ${elapsedMs}ms; holder: ${formatAdmissionHolder(owner)}`,
              { kind: 'queued', elapsedMs, budgetMs: Math.max(0, timeoutMs - spend()) }),
            onAcquired: ({ waitedMs }) => {
              const total = spend(), queueChargeMs = total - reportedMs;
              reportedMs = total;
              options.onAdmissionAcquired?.({ waitedMs, queueChargeMs, budgetMs: timeoutMs });
            },
          });
        } finally { leave(token); }
      },
    });
    const result = await run();
    return { results: result.results, stats: result.stats };
  }
  const runTurn = createBudgetedTaskRun(tasks, options);
  let queuedMs = 0;
  let run;
  do {
    const remainingQueueMs = Math.max(1, timeoutMs - queuedMs);
    // EI-25482105942475587: lease age is subtracted from this ETA by waiters.
    // The whole-plan projection includes other shards that release the mutex in
    // between, and a resumed wave has already settled some of this shard's work.
    // Project only the tasks covered by THIS lease, retaining original indices
    // for index-based history and leaving the caller's other declarations intact.
    let admissionIntent = options?.admissionIntent;
    if (admissionIntent && typeof admissionIntent === "object" && !Array.isArray(admissionIntent)) {
      const remaining = tasks.map((task, index) => ({ task, index }))
        .filter(({ index }) => run?.results[index] == null);
      const projection = estimateBudgetedTaskWallMs({ shards: [{ tasks: remaining }] }, {
        ...options,
        estimateMs: ({ task, index }) => options.estimateMs?.(task, index),
      });
      admissionIntent = {
        ...admissionIntent,
        tasks: remaining.length,
        etaProjectedSec: Math.round(projection.projectedWallMs / 1000),
        etaWorkSec: Math.round(projection.knownWorkMs / 1000),
        etaFromTasks: `${projection.knownTasks}/${remaining.length}`,
        etaUnknownTasks: projection.unknownTasks,
        etaMode: projection.mode,
        etaConcurrency: projection.maxConcurrentTasks,
      };
    }
    run = await withFsMutex(
    // WI-1746759: the release gate rides its own lane; everyone else shares one.
    admissionMutexName(),
    ({ hasWaiters } = {}) => runTurn(hasWaiters),
    {
      timeoutMs: remainingQueueMs,
      staleMs: SHARED_TEST_PROCESS_ADMISSION_STALE_MS,
      retryMs: SHARED_TEST_PROCESS_ADMISSION_RETRY_MS,
      deferAfterHolderAgeMs: options?.deferWhenHolderOlderThanBudget ? remainingQueueMs : undefined,
      waitingNoticeIntervalMs: SHARED_TEST_PROCESS_ADMISSION_NOTICE_INTERVAL_MS,
      // EI-21917992245424964: what this run IS, carried in the owner record so a blocked
      // peer can judge it without waking anyone. The caller owns scope/purpose;
      // the scheduler derives task coverage and ETA for the actual lease.
      intent: admissionIntent,
      onWaiting: ({ owner, elapsedMs }) => {
        // WI-2142172: the base sentence stays (starvation is genuinely not a hang), but it
        // is no longer the LAST word. When the holder's declared lower bound already
        // exceeds this waiter's remaining budget, the prospect clause says so outright, so
        // "normal serialization" can never again be the only thing a reader is told while
        // the run is in fact projected to measure nothing at all.
        notify(
          `AFFECTED_TESTS_ADMISSION_QUEUED waiting on the shared test-process ` +
            `admission mutex (${Math.round(elapsedMs / 1000)}s so far, budget ` +
            `${Math.round(remainingQueueMs / 1000)}s) — this is normal serialization under ` +
            `fleet load, not a hang; holder: ${formatAdmissionHolder(owner)}` +
            formatAdmissionProspect(owner, { elapsedMs, budgetMs: remainingQueueMs }),
          { kind: "queued", elapsedMs, budgetMs: remainingQueueMs },
        );
      },
      onAcquired: ({ waitedMs }) => {
        queuedMs += waitedMs;
        // `budgetMs` is the bound THIS acquisition was actually given. Reporting it is what
        // lets a caller (and a test) see the whole-run budget spending down across shards
        // instead of silently restarting at full value on every one.
        if (options?.onAdmissionAcquired)
          options.onAdmissionAcquired({ waitedMs, budgetMs: remainingQueueMs });
        if (waitedMs >= SHARED_TEST_PROCESS_ADMISSION_NOTICE_INTERVAL_MS) {
          notify(
            `AFFECTED_TESTS_ADMISSION_GRANTED after ${Math.round(waitedMs / 1000)}s queued`,
            { kind: "granted", waitedMs, budgetMs: remainingQueueMs },
          );
        }
      },
    },
  );
    if (run.pendingTasks > 0) notify(
      `AFFECTED_TESTS_ADMISSION_YIELD completedTasks=${tasks.length - run.pendingTasks} ` +
        `remainingTasks=${run.pendingTasks} — active children drained; rejoining the FIFO queue`,
      { kind: "yielded", budgetMs: Math.max(0, timeoutMs - queuedMs) },
    );
  } while (run.pendingTasks > 0);
  return { results: run.results, stats: run.stats };
}

/** Run deterministic shards sequentially while preserving declaration-order results. */
export async function runBudgetedTaskShards(plan, options) {
  if (!plan?.shards?.length) {
    throw new Error(
      "runBudgetedTaskShards requires at least one planned shard",
    );
  }
  const results = [];
  let aggregate = null;
  const shardStats = [];
  // WI-1490656: carry ONE queue budget across every shard. Each shard is its own
  // `withFsMutex` acquisition whose `timeoutMs` restarts at zero, so without this the run's
  // real admission bound is shards × per-acquisition timeout. Spend the budget down as
  // shards actually queue; time spent RUNNING tests is not queue time and never counts
  // against it, because `withFsMutex` stops measuring the moment it grants.
  const runBudgetMs =
    Number(options?.admissionRunBudgetMs) > 0
      ? Number(options.admissionRunBudgetMs)
      : SHARED_TEST_PROCESS_ADMISSION_RUN_BUDGET_MS;

  // WI-1639265: admission can now see the caller's wall clock.
  //
  // `runBudgetMs` above bounds QUEUE time only, and it is a fixed internal constant. Nothing
  // compared it against how long this process is actually allowed to live, so a run launched
  // with a short `RuntimeMaxSec` could spend its entire life queued — perfectly within budget
  // — and be SIGKILLed the moment it finally got to work. The inversion worth naming: the
  // dangerous caller is the CONSERVATIVE-looking one. A generous timeout sits well above the
  // queue budget and is never squeezed; it is the caller who passes a modest timeout, trying
  // to be tidy, who buys a run that cannot fit.
  //
  // `options.deadlineEpochMs === undefined` reads the launcher's env; an explicit `null`
  // disables the check (tests, and any caller that genuinely has no deadline).
  const deadlineEpochMs =
    options?.deadlineEpochMs === undefined
      ? readTaskDeadlineEpochMs()
      : options.deadlineEpochMs;
  const deadlineNotify =
    options?.onAdmissionNotice ?? ((line) => console.error(line));
  // Reuse the same concurrent-lane projection as admission ETA. Summed task durations
  // describe serial-equivalent work and can falsely refuse a run that fits in parallel.
  const projectedKnownWork = (taskPlan) => {
    const { projectedWallMs, knownTasks, unknownTasks } =
      estimateBudgetedTaskWallMs(taskPlan, options);
    return { knownEstimateMs: projectedWallMs, knownTasks, unknownTasks };
  };

  if (deadlineEpochMs != null) {
    const remainingMs = deadlineEpochMs - Date.now();
    if (remainingMs <= runBudgetMs) {
      deadlineNotify(
        `AFFECTED_TESTS_DEADLINE_TIGHT remainingMs=${Math.round(remainingMs)} ` +
          `queueBudgetMs=${runBudgetMs} — the shared-admission QUEUE budget alone can consume ` +
          `this run's entire wall clock, so a fully-queued run would be killed before it ran a ` +
          `single test. Raise the launching timeout above ` +
          `${Math.ceil(runBudgetMs / 60_000)}min, or lower admissionRunBudgetMs to match it.`,
        { kind: "deadline-tight", remainingMs, budgetMs: runBudgetMs },
      );
    }
    // PRE-FLIGHT ONLY, over the whole plan. Refusing here costs nothing — nothing has run —
    // and turns "killed with no verdict" into an attributable refusal. Deliberately NOT
    // re-raised between shards: by then earlier shards hold real results, and throwing them
    // away to report a deadline would trade a measured verdict for a predicted one.
    const preflight = projectedKnownWork(plan);
    if (remainingMs <= 0 || preflight.knownEstimateMs > remainingMs) {
      throw new Error(formatTaskDeadlineRefusal({ remainingMs, ...preflight }));
    }
  }

  let queuedSoFarMs = 0;
  for (const shard of plan.shards) {
    if (deadlineEpochMs != null) {
      const remainingMs = deadlineEpochMs - Date.now();
      const upcoming = projectedKnownWork({ ...plan, shards: [shard] });
      if (upcoming.knownEstimateMs > remainingMs) {
        deadlineNotify(
          `AFFECTED_TESTS_DEADLINE_SHORTFALL shard=${shard.index} ` +
            `remainingMs=${Math.round(remainingMs)} ` +
            `knownEstimateMs=${Math.round(upcoming.knownEstimateMs)} ` +
            `knownTasks=${upcoming.knownTasks} unknownTasks=${upcoming.unknownTasks} — this ` +
            `shard is expected to outlive the run's deadline, so a kill part-way through it is ` +
            `likely. Results already settled by earlier shards remain valid.`,
          { kind: "deadline-shortfall", shard: shard.index, remainingMs },
        );
      }
    }
    const run = await runBudgetedTasks(shard.tasks, {
      ...options,
      admissionTimeoutMs: Math.max(1, runBudgetMs - queuedSoFarMs),
      onAdmissionAcquired: ({ waitedMs, budgetMs, queueChargeMs }) => {
        queuedSoFarMs += queueChargeMs ?? waitedMs;
        if (options?.onAdmissionAcquired) options.onAdmissionAcquired({ waitedMs, budgetMs, queueChargeMs });
      },
    });
    shardStats.push({
      index: shard.index,
      taskCount: shard.tasks.length,
      ...run.stats,
    });
    for (const entry of run.results)
      results.push({ ...entry, index: results.length });
    if (!aggregate) {
      aggregate = { ...run.stats };
      continue;
    }
    aggregate.observedMaxWorkers = Math.max(
      aggregate.observedMaxWorkers,
      run.stats.observedMaxWorkers,
    );
    aggregate.observedMaxMemoryMb = Math.max(
      aggregate.observedMaxMemoryMb,
      run.stats.observedMaxMemoryMb,
    );
    aggregate.observedMaxTasks = Math.max(
      aggregate.observedMaxTasks,
      run.stats.observedMaxTasks,
    );
    aggregate.admissionClamps += run.stats.admissionClamps;
    aggregate.memoryReadings =
      aggregate.memoryReadings == null || run.stats.memoryReadings == null
        ? null
        : aggregate.memoryReadings + run.stats.memoryReadings;
    aggregate.minAdmittedWorkers =
      aggregate.minAdmittedWorkers == null
        ? run.stats.minAdmittedWorkers
        : run.stats.minAdmittedWorkers == null
          ? aggregate.minAdmittedWorkers
          : Math.min(
              aggregate.minAdmittedWorkers,
              run.stats.minAdmittedWorkers,
            );
    aggregate.lastMemAvailableMb = run.stats.lastMemAvailableMb;
  }
  return { results, stats: aggregate, shardStats, shardPlan: plan };
}

export function emptyDurationHistory() {
  return { version: DURATION_HISTORY_VERSION, tasks: {} };
}

export function readDurationHistory(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed?.version !== DURATION_HISTORY_VERSION ||
      !parsed.tasks ||
      typeof parsed.tasks !== "object"
    ) {
      // EI-20806073740910935: a silent discard here is indistinguishable from
      // "first run, no history yet" — and it disarms every watchdog bound for
      // the whole run. Say WHY the history was thrown away.
      process.stderr.write(
        `[budgeted-task-scheduler] duration history at ${path} DISCARDED: ` +
          `version=${JSON.stringify(parsed?.version)} (want ${DURATION_HISTORY_VERSION}), ` +
          `tasks=${parsed?.tasks ? typeof parsed.tasks : "missing"} — starting empty\n`,
      );
      return emptyDurationHistory();
    }
    return parsed;
  } catch (err) {
    // ENOENT is the expected first-run case and stays quiet. ANYTHING else
    // (EMFILE/EIO/EACCES/parse error on a present file) silently disarmed the
    // watchdog estimator for an entire gate run on 2026-08-18 (run 10, all 36
    // progress lines durationEstimateMs=unknown while the file was valid) —
    // EI-20806073740910935. A single loud line makes the next occurrence
    // self-diagnosing.
    if (err?.code !== "ENOENT") {
      process.stderr.write(
        `[budgeted-task-scheduler] duration history READ FAILED at ${path}: ` +
          `${err?.code ?? err?.name ?? "error"} ${err?.message ?? ""} — starting empty ` +
          `(EI-20806073740910935: all duration estimates will print unknown this run)\n`,
      );
    }
    return emptyDurationHistory();
  }
}

export function durationEstimate(history, key) {
  return finiteEstimate(history?.tasks?.[key]?.durationMs);
}

/**
 * The estimate the WATCHDOG BOUND must use — never the bare EWMA.
 *
 * EI-20803703725014949: operator-core::test:lane-stateful is BIMODAL (~7min vs
 * ~45min, both honest completions). An EWMA of a bimodal distribution settles
 * between the modes and describes neither, so a mostly-fast history collapses
 * the batch timeout to its floor and a legitimate slow-mode finish then races
 * a timer set at exactly its own duration — the "coin flip" the policy comment
 * in affected-tests.mjs explicitly forbids. Worse, a SIGKILLed leg records
 * elapsed≈timeout into the EWMA, so the estimate oscillates around the
 * coin-flip regime instead of ever escaping it (measured ~50% kill rate).
 *
 * A watchdog cares about the honest WORST case, not the typical case: take the
 * max of the EWMA and the decayed peak. Ordering keeps using durationEstimate
 * (the EWMA) — typical cost is the right input for scheduling.
 */
export function timeoutDurationEstimate(history, key) {
  const entry = history?.tasks?.[key];
  const ewma = finiteEstimate(entry?.durationMs);
  const peak = finiteEstimate(entry?.peakMs);
  if (ewma == null && peak == null) return null;
  return Math.max(ewma ?? 0, peak ?? 0);
}

/**
 * Per-run decay for the recorded peak: slow enough that one honest slow-mode
 * completion protects roughly the next dozen runs (0.9^12 ≈ 0.28), fast enough
 * that a one-off pathological outlier does not pin the timeout forever.
 */
const PEAK_DECAY_PER_RUN = 0.9;

/** Keep a small EWMA so one loaded run informs ordering without pinning it forever. */
export function mergeDurationHistory(
  history,
  observations,
  now = new Date().toISOString(),
) {
  const next = {
    version: DURATION_HISTORY_VERSION,
    tasks: { ...(history?.tasks ?? {}) },
  };
  for (const observation of observations) {
    const durationMs = finiteEstimate(observation?.durationMs);
    const key = typeof observation?.key === "string" ? observation.key : "";
    if (!key || durationMs == null) continue;
    const prior = next.tasks[key];
    const samples =
      Number.isSafeInteger(prior?.samples) && prior.samples > 0
        ? prior.samples
        : 0;
    // A legacy entry has no peakMs; seed the decay base from its EWMA rather
    // than 0 so an upgrade never *lowers* an existing task's effective bound.
    const priorPeak =
      finiteEstimate(prior?.peakMs) ?? finiteEstimate(prior?.durationMs) ?? 0;
    next.tasks[key] = {
      durationMs:
        samples > 0
          ? Math.round(prior.durationMs * 0.75 + durationMs * 0.25)
          : Math.round(durationMs),
      peakMs: Math.max(
        Math.round(durationMs),
        Math.round(priorPeak * PEAK_DECAY_PER_RUN),
      ),
      samples: samples + 1,
      updatedAt: now,
    };
  }
  return next;
}

/** Write via same-directory rename: readers see either the old complete JSON or the new one. */
export function writeDurationHistoryAtomic(
  path,
  history,
  nonce = `${process.pid}-${Date.now()}`,
) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${nonce}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(history, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function formatTaskBudgetMarker(
  stats,
  prefix = "AFFECTED_TESTS_SCHEDULER",
) {
  // EI-20801764054303492 step 3: report the memory term and WHICH term bound, so a gate run's
  // concurrency decision is readable from its own log instead of re-derived from source. Both are
  // derived defensively rather than required, so a hand-built stats object (tests, older callers)
  // still formats. `memAvailableMb` is appended only when the caller measured it — its absence is
  // meaningful ("no measurement"), so it is omitted rather than printed as 0 or null.
  const boundBy =
    stats.boundBy ??
    (stats.memoryWorkerBudget < stats.workerBudget ? "memory" : "ceiling");
  const measured =
    stats.memAvailableMb == null
      ? ""
      : ` memAvailableMb=${stats.memAvailableMb}`;
  const cgroup =
    stats.taskCgroupMemoryMaxMb == null
      ? ""
      : ` taskCgroupMemoryMaxMb=${stats.taskCgroupMemoryMaxMb}`;
  const pids =
    stats.taskCgroupPidsMax == null
      ? ""
      : ` configuredMaxTasks=${stats.configuredMaxConcurrentTasks ?? stats.maxConcurrentTasks}` +
        ` pidsMaxTasks=${stats.pidsMaxConcurrentTasks ?? stats.maxConcurrentTasks}` +
        ` taskBoundBy=${stats.taskBoundBy ?? "ceiling"}` +
        ` taskCgroupPidsMax=${stats.taskCgroupPidsMax}` +
        ` pidsPerTask=${stats.pidsPerConcurrentTask ?? PIDS_PER_CONCURRENT_TASK}` +
        ` pidsReserve=${stats.pidsReserve ?? PIDS_RESERVE}` +
        (stats.pidsBudgetAdapted
          ? ` pidsBudgetAdapted=1 configuredPidsPerTask=${stats.configuredPidsPerConcurrentTask ?? PIDS_PER_CONCURRENT_TASK}` +
            ` configuredPidsReserve=${stats.configuredPidsReserve ?? PIDS_RESERVE}`
          : "");
  return (
    `${prefix} mode=${stats.mode} workerBudget=${stats.workerBudget} ` +
    `memoryBudgetMb=${stats.memoryBudgetMb} workerMemoryMb=${stats.workerMemoryMb} ` +
    `effectiveWorkers=${stats.effectiveWorkerBudget} maxTasks=${stats.maxConcurrentTasks} ` +
    `reserveWorkers=${stats.reserveWorkers} memoryWorkers=${stats.memoryWorkerBudget} ` +
    `boundBy=${boundBy}${measured}${cgroup}${pids}`
  );
}

export function formatTaskBudgetObservedMarker(stats) {
  // EI-20801764054303492 route (a): the per-admission clamp is only trustworthy if a run can say
  // whether it actually measured anything and whether that measurement ever bit. Appended ONLY
  // when a reader was wired (memoryReadings != null) — a hand-built stats object, and every
  // caller that passes no reader, keeps the exact legacy string.
  const admission =
    stats.memoryReadings == null
      ? ""
      : ` memReadings=${stats.memoryReadings} clamps=${stats.admissionClamps} ` +
        `minAdmittedWorkers=${stats.minAdmittedWorkers}`;
  return (
    `AFFECTED_TESTS_SCHEDULER_OBSERVED maxWorkers=${stats.observedMaxWorkers} ` +
    `maxMemoryMb=${stats.observedMaxMemoryMb} maxTasks=${stats.observedMaxTasks}${admission}`
  );
}

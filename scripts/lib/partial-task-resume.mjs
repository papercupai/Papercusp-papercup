// Durable, fail-closed checkpoints for a task that reached the parent watchdog
// before its complete test-file set finished. This is deliberately separate from
// passing-task reuse: a partial run is never a pass proof and never enters the
// passing-verdict cache.

import { createHash } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { selectReusablePasses } from "./test-pass-reuse.mjs";
import { expandSelectionCommands } from "./related-tests.mjs";
import { scriptUsesPassWithNoTests, scriptSupportsPassReuse } from "./empty-suite-guard.mjs";
import { readNativeArtifactBytes, readNativeProcessTraceArtifacts } from "./budgeted-task-scheduler.mjs";
import { jsonSha256, readCompletionJsonSync } from "./completion-snapshot.mjs";

export const PARTIAL_TASK_CHECKPOINT_SCHEMA = 1;
export const PARTIAL_TASK_SKIP_LIST_SCHEMA = 1;

// These capabilities exist only for an independently authenticated artifact read.
// JSON round trips, stored receipt fields and caller-supplied run ids cannot mint
// them. A composer must reread artifacts under its current physical runner fence.
// Public scope labels describe authority; only this WeakMap grants it. In a plan,
// declare separately whether acceptance needs this execution's outcome or permission
// to skip work in a replacement execution. Unknown reusable closure stays unknown.
const currentOutcomeEvidence = new WeakMap();
const currentIdentityKeys = ["root", "taskKey", "attemptId", "candidate", "repairHead",
  "sourceCommit", "runContext", "runnerIdentity", "runId", "runnerId", "pidIdentity"];
function currentIdentity(expected) {
  if (currentIdentityKeys.some(key => key === "repairHead"
    ? expected?.[key] !== null && !validIdentity(expected?.[key]) : !validIdentity(expected?.[key]))) return null;
  const manifest = continuationManifest(expected.manifest);
  return manifest ? { ...Object.fromEntries(currentIdentityKeys.map(key => [key, expected[key]])), manifest } : null;
}
function currentCapability(receipt, expected) {
  const identity = currentIdentity(expected);
  if (!identity) return null;
  const capability = Object.freeze({ scope: "current-execution" });
  currentOutcomeEvidence.set(capability, { identity, receipt: structuredClone(receipt) });
  return capability;
}

/** Bind a native execution capture to the complete logical/physical identity.
 * This fingerprint is provenance, never authority without authenticated artifacts.
 */
export function partialCurrentExecutionFingerprint(expected) {
  const identity = currentIdentity(expected);
  return identity ? createHash("sha256").update(JSON.stringify(identity)).digest("hex") : null;
}

const normalizePath = (value, cwd) => {
  if (typeof value !== "string") return null;
  let file = value.replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (!file) return null;
  if ((file.startsWith('"') && file.endsWith('"')) || (file.startsWith("'") && file.endsWith("'"))) {
    file = file.slice(1, -1);
  }
  const absolute = isAbsolute(file) ? file : resolve(cwd, file);
  const rel = relative(cwd, absolute).split(/[/\\]/).join("/").replace(/^\.\//, "");
  if (!rel || rel === "." || rel.startsWith("../") || rel === ".." || isAbsolute(rel)) return null;
  return rel;
};

export function normalizePartialFiles(files, cwd) {
  return [...new Set((files ?? []).map((file) => normalizePath(file, cwd)).filter(Boolean))].sort();
}

function validIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function validFileList(files) {
  return Array.isArray(files) && files.every((file) => typeof file === "string" && file.length > 0);
}

export function partialTaskCheckpointPath(cacheDir, root, taskKey) {
  const scope = createHash("sha256").update(`${root}\0${taskKey}`).digest("hex").slice(0, 24);
  return `${cacheDir}/papercusp-affected-partial-v${PARTIAL_TASK_CHECKPOINT_SCHEMA}-${scope}.json`;
}

export function readPartialTaskCheckpoint(file, expected) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || parsed.schemaVersion !== PARTIAL_TASK_CHECKPOINT_SCHEMA) return null;
  if (parsed.continuation !== undefined) {
    const { checkpointIntegrity, ...body } = parsed;
    if (checkpointIntegrity?.schemaVersion !== 1 ||
        checkpointIntegrity.sha256 !== createHash("sha256").update(JSON.stringify(body)).digest("hex")) return null;
  }
  if (!validIdentity(parsed.root) || !validIdentity(parsed.taskKey) ||
      !validIdentity(parsed.sourceCommit) || !validIdentity(parsed.sourceDigest)) return null;
  if (!validFileList(parsed.selectedFiles) || !validFileList(parsed.passedFiles)) return null;
  if (parsed.state !== "partial" && parsed.state !== "complete") return null;
  if (expected && (parsed.root !== expected.root || parsed.taskKey !== expected.taskKey ||
      parsed.sourceCommit !== expected.sourceCommit || parsed.sourceDigest !== expected.sourceDigest ||
      (expected.runnerIdentity !== undefined && (!validIdentity(expected.runnerIdentity) ||
        parsed.runnerIdentity !== expected.runnerIdentity)))) {
    return null;
  }
  const selectedFiles = [...new Set(parsed.selectedFiles)].sort();
  const selected = new Set(selectedFiles);
  const passedFiles = [...new Set(parsed.passedFiles)].filter((file) => selected.has(file)).sort();
  return { ...parsed, selectedFiles, passedFiles };
}

export function writePartialTaskCheckpointAtomic(file, checkpoint) {
  const value = {
    schemaVersion: PARTIAL_TASK_CHECKPOINT_SCHEMA,
    root: checkpoint.root,
    taskKey: checkpoint.taskKey,
    sourceCommit: checkpoint.sourceCommit,
    sourceDigest: checkpoint.sourceDigest,
    ...(checkpoint.runnerIdentity === undefined ? {} : { runnerIdentity: checkpoint.runnerIdentity }),
    selectedFiles: [...new Set(checkpoint.selectedFiles ?? [])].sort(),
    passedFiles: [...new Set(checkpoint.passedFiles ?? [])].sort(),
    state: checkpoint.state === "complete" ? "complete" : "partial",
    updatedAt: checkpoint.updatedAt ?? new Date().toISOString(),
    ...(checkpoint.continuation === undefined ? {} : { continuation: checkpoint.continuation }),
    ...(checkpoint.physicalExecution === undefined ? {} : { physicalExecution: checkpoint.physicalExecution }),
  };
  if (checkpoint.continuation !== undefined) {
    value.checkpointIntegrity = { schemaVersion: 1,
      sha256: createHash("sha256").update(JSON.stringify(value)).digest("hex") };
  }
  const body = JSON.stringify(value);
  mkdirSync(file.replace(/\/[^/]*$/, ""), { recursive: true });
  const temp = `${file}.${process.pid}-${Date.now()}.tmp`;
  writeFileSync(temp, `${body}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

export function partialTaskSkipListPath(dir, checkpoint) {
  const body = JSON.stringify({
    schema: PARTIAL_TASK_SKIP_LIST_SCHEMA,
    taskKey: checkpoint.taskKey,
    sourceCommit: checkpoint.sourceCommit,
    sourceDigest: checkpoint.sourceDigest,
    ...(checkpoint.runnerIdentity === undefined ? {} : { runnerIdentity: checkpoint.runnerIdentity }),
    files: [...new Set(checkpoint.passedFiles ?? [])].sort(),
  });
  const digest = createHash("sha256").update(body).digest("hex").slice(0, 16);
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/partial-skip-${digest}.json`;
  try {
    writeFileSync(file, `${body}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return { path: file, digest, count: checkpoint.passedFiles?.length ?? 0 };
}

const UNIT_KINDS = new Set(["test", "guard", "post-suite"]);
const repoPath = value => typeof value === "string" && value.length > 0 &&
  !isAbsolute(value) && !value.includes("\\") &&
  value.split("/").every(part => part !== "" && part !== "." && part !== "..");

function validNativeProducer(value) {
  if (value?.schemaVersion !== 1 || value.kind !== "qualification-native-producer" ||
      ![value.attemptId, value.runGroupId, value.root, value.taskKey, value.workspaceName,
        value.sourceCommit, value.outPath].every(validIdentity) || !isAbsolute(value.root) || !isAbsolute(value.outPath) ||
      !Number.isSafeInteger(value.registeredAtMs) || value.registeredAtMs <= 0 ||
      !isAbsolute(value.command?.cwd ?? "") || !validIdentity(value.command?.cmd) ||
      !Array.isArray(value.command?.argv) || !value.command.argv.every(arg => typeof arg === "string") ||
      !/^[a-f0-9]{64}$/.test(value.environmentDigest)) return false;
  if (value.nativeChannel !== undefined) {
    const channel = value.nativeChannel;
    if (!isAbsolute(channel?.traceOut ?? "") || !validIdentity(channel.script) || !validIdentity(channel.command) ||
        !Number.isSafeInteger(channel.step) || channel.step < 0 || channel.step >= 64 ||
        value.outPath !== `${channel.traceOut}.step-${channel.step}`) return false;
  }
  return validNativeSpecifications(value.selectedSpecifications);
}

function validNativeSpecifications(specifications) {
  if (!Array.isArray(specifications) || !specifications.length) return false;
  const files = new Set();
  for (const spec of specifications) {
    if (!repoPath(spec?.testFile) || files.has(spec.testFile) || !validIdentity(spec.pool) ||
        (spec.projectName !== null && typeof spec.projectName !== "string") ||
        (spec.testNamePattern !== null && typeof spec.testNamePattern !== "string") ||
        ![spec.testIds, spec.testTagsFilter].every(list => list === null ||
          (Array.isArray(list) && list.every(item => typeof item === "string"))) ||
        !(spec.testLines === null || (Array.isArray(spec.testLines) && spec.testLines.every(Number.isSafeInteger)))) return false;
    files.add(spec.testFile);
  }
  return true;
}

/** Select one native producer without treating pending npm hooks as test-selection
 * gaps. Hooks remain independent command obligations; this grants no pass or custody.
 * Ordered multi-run scripts still require distinct native output channels.
 */
export function preparePartialNativeProducerSelection(selection, task, root) {
  const refused = reason => ({ status: "refused", reason, selectedSpecifications: null });
  if (selection?.schemaVersion !== 1 || selection.kind !== "full-gate" ||
      selection.phase !== "selection-preparation" || selection.executed !== false ||
      !Array.isArray(selection.tasks) || selection.tasks.length !== 1 ||
      !Array.isArray(selection.unenumerated) || !Array.isArray(selection.commandObligations) ||
      !Array.isArray(selection.overlaps) || selection.overlaps.length)
    return refused("native-producer-selection-unmeasured");
  const entry = selection.tasks[0];
  if (!validIdentity(task?.id) || entry?.id !== task.id || entry.dir !== task.dir ||
      entry.command !== task.command || entry.runner !== "vitest" ||
      !validNativeSpecifications(entry.selectedSpecifications) ||
      !Array.isArray(entry.files) || new Set(entry.files).size !== entry.files.length ||
      entry.selectedSpecifications.length !== entry.files.length ||
      entry.selectedSpecifications.some(spec => !entry.files.includes(spec.testFile)) ||
      !isDeepStrictEqual(selection.files, entry.files))
    return refused("native-producer-selection-mismatch");
  const hooks = entry.lifecycleCommands;
  const commands = entry.commandObligations ?? [];
  if (!Array.isArray(hooks) || !Array.isArray(commands) || commands.length !== hooks.length ||
      selection.commandObligations.some(value => !value || typeof value !== "object") ||
      !isDeepStrictEqual(commands, selection.commandObligations.map(({ task: id, ...command }) =>
        id === task.id ? command : null)) ||
      selection.unenumerated.some(value => value?.task !== task.id ||
        value.reason !== "unexecuted-lifecycle-command") ||
      (selection.unenumerated.length > 0 && hooks.length === 0))
    return refused("native-producer-command-population-unmeasured");
  for (const [index, command] of commands.entries()) {
    const inputs = command?.inputs, discovery = command?.discovery;
    const files = discovery?.repositoryFiles ?? discovery?.files;
    if (command?.kind !== "npm-lifecycle" || command.executed !== false ||
        command.script !== hooks[index]?.script || command.command !== hooks[index]?.command ||
        !validIdentity(command.script) || !validIdentity(command.command) ||
        !isAbsolute(root ?? "") || !Array.isArray(inputs) || !inputs.length ||
        new Set(inputs.map(input => input?.path)).size !== inputs.length ||
        inputs.some(input => !repoPath(input?.path) || !/^[a-f0-9]{64}$/.test(input.sha256)) ||
        discovery?.executed !== false || discovery.runtimeClosure !== "unmeasured" ||
        discovery.operationalAcceptance !== false || !isDeepStrictEqual(discovery.inputs, inputs) ||
        !Array.isArray(files) || new Set(files).size !== files.length ||
        files.some(file => !repoPath(file) || !inputs.some(input => input.path === file)))
      return refused("native-producer-command-inputs-unmeasured");
    try {
      if (inputs.some(input => createHash("sha256").update(readFileSync(resolve(root, input.path)))
        .digest("hex") !== input.sha256)) return refused("native-producer-command-inputs-changed");
    } catch { return refused("native-producer-command-inputs-unreadable"); }
  }
  return { status: "ready", reason: null, selectedSpecifications: structuredClone(entry.selectedSpecifications) };
}

/** Prepare disjoint native output channels from the ORIGINAL npm task inventory.
 * The independently selected manifest validates source mappings before any channel
 * is offered. This does not replace npm with leaf commands, enroll a producer, or
 * settle command/post-suite work. The caller must bind each channel to its actual
 * native process before using its outcomes.
 * `remainingFiles` narrows enrollment only, after the full source population is
 * validated. A banked empty step still runs its original command and hooks; it
 * supplies no producer or completion, and must already tolerate an empty suite.
 * @param {{selection: any, task: any, root: string, outPath: string, postSuite: any, remainingFiles?: string[], observedSelection?: any}} input
 */
export function preparePartialNativeProducerChannels({ selection, task, root, outPath, postSuite, remainingFiles, observedSelection }) {
  const refused = reason => ({ status: "refused", reason, channels: [], manifest: null,
    commandUnitIds: [], postSuiteUnitIds: [], operationalAcceptance: false });
  if (!isAbsolute(root ?? "") || !isAbsolute(outPath ?? "") ||
      !Array.isArray(selection?.tasks) || selection.tasks.length !== 1 ||
      !Array.isArray(selection.overlaps) || selection.overlaps.length)
    return refused("native-channel-selection-unmeasured");
  const prepared = preparePartialContinuationManifest({ tasks: [task], selection, root, postSuite });
  if (prepared.status !== "ready") return refused(`native-channel-${prepared.reason}`);
  const entry = selection.tasks[0];
  if (remainingFiles !== undefined && (!Array.isArray(remainingFiles) ||
      new Set(remainingFiles).size !== remainingFiles.length ||
      remainingFiles.some(file => !entry.files.includes(file))))
    return refused("native-channel-remaining-population-mismatch");
  const channels = [];
  const add = (leaf, step, script, command, commands, residues) => {
    const taskKey = step === null ? task.id : `${task.id}:step:${step}`;
    const local = { ...leaf, id: taskKey, dir: task.dir, command,
      lifecycleCommands: leaf.lifecycleCommands ?? [], commandObligations: commands };
    const native = preparePartialNativeProducerSelection({ ...selection, tasks: [local], files: local.files,
      commandObligations: commands.map(value => ({ ...value, task: taskKey })),
      unenumerated: residues.map(value => ({ ...value, task: taskKey })) }, local, root);
    if (native.status !== "ready") return native.reason;
    const selected = native.selectedSpecifications.filter(spec =>
      remainingFiles === undefined || remainingFiles.includes(spec.testFile));
    if (!selected.length && !(scriptUsesPassWithNoTests(command) && scriptSupportsPassReuse(command)))
      return "native-empty-selection-with-command-work";
    channels.push({ taskKey, sourceTask: task.id, step, script, command,
      outPath: step === null ? outPath : `${outPath}.step-${step}`,
      selectedSpecifications: selected,
      ...(selected.length ? {} : { bankedSpecifications: native.selectedSpecifications }) });
    return null;
  };
  if (entry.runner === "vitest") {
    const reason = add(entry, null, entry.script ?? null, task.command, entry.commandObligations ?? [],
      selection.unenumerated.map(({ task: _task, ...value }) => value));
    if (reason) return refused(reason);
  } else if (entry.runner === "command-chain") {
    if (entry.steps.length > 64) return refused("native-channel-step-limit");
    for (const [index, step] of entry.steps.entries()) {
      if (step.lifecycle === true) continue;
      const leaf = step.discovery[0];
      if (["command-check", "astro-check"].includes(leaf.runner)) continue;
      if (leaf.runner !== "vitest") return refused("native-channel-runner-unsupported");
      const reason = add(leaf, index, step.script, step.command,
        step.commandObligations.map(({ task: _task, ...value }) => value),
        step.unenumerated.map(({ task: _task, ...value }) => value));
      if (reason) return refused(reason);
    }
  } else if (!["command-check", "astro-check", "lifecycle-command"].includes(entry.runner)) {
    return refused("native-channel-runner-unsupported");
  }
  if (observedSelection !== undefined) {
    const actual = observedSelection?.tasks;
    if (!Array.isArray(actual) || actual.length !== 1 || actual[0]?.id !== task.id ||
        actual[0]?.command !== entry.command || actual[0]?.runner !== entry.runner)
      return refused("native-channel-remaining-selection-unmeasured");
    for (const channel of channels) {
      const leaf = channel.step === null ? actual[0] : actual[0].steps?.[channel.step]?.discovery?.[0];
      if (!isDeepStrictEqual(leaf?.selectedSpecifications, channel.selectedSpecifications))
        return refused("native-channel-remaining-selection-mismatch");
    }
  }
  return { status: "ready", reason: null, channels, manifest: prepared.manifest,
    commandUnitIds: prepared.manifest.units.filter(unit => unit.kind === "guard").map(unit => unit.id),
    postSuiteUnitIds: prepared.manifest.units.filter(unit => unit.kind === "post-suite").map(unit => unit.id),
    operationalAcceptance: false };
}

/** Enroll the independent selection and actual command before its native child can start.
 * Extends the existing OUT artifact; the environment is stored only as a digest.
 * Enrollment is immutable and does not authorize reuse or establish runner custody.
 */
export function registerPartialNativeProducer(outPath, registration, environment) {
  const value = { schemaVersion: 1, kind: "qualification-native-producer", ...registration, outPath,
    environmentDigest: createHash("sha256").update(JSON.stringify(Object.entries(environment)
      .filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)))).digest("hex") };
  if (!validNativeProducer(value)) throw new Error("native-producer-registration-invalid");
  const path = `${outPath}.producer.json`;
  writeNativeEnrollment(path, value);
  return { path, producer: value };
}

/** Enroll disjoint original-npm channels before the original command starts.
 * This is routing preparation only; native spawn/close events must still bind
 * each enrollment to its actual process before any completion can be accepted.
 */
export function registerPartialNativeProducerChannels(outPath, prepared, registration, environment) {
  if (!isAbsolute(outPath ?? "") || prepared?.status !== "ready" ||
      !Array.isArray(prepared.channels) || !prepared.channels.length || prepared.channels.length > 64 ||
      new Set(prepared.channels.map(channel => channel.outPath)).size !== prepared.channels.length ||
      prepared.channels.some(channel => !validIdentity(channel.script) || !validIdentity(channel.command) ||
        !Number.isSafeInteger(channel.step) || channel.step < 0 ||
        channel.outPath !== `${outPath}.step-${channel.step}` ||
        !(validNativeSpecifications(channel.selectedSpecifications) ||
          (Array.isArray(channel.selectedSpecifications) && channel.selectedSpecifications.length === 0 &&
            validNativeSpecifications(channel.bankedSpecifications) &&
            scriptUsesPassWithNoTests(channel.command) && scriptSupportsPassReuse(channel.command)))))
    throw new Error("native-channel-registration-invalid");
  const producers = prepared.channels.filter(channel => channel.selectedSpecifications.length)
    .map(channel => registerPartialNativeProducer(channel.outPath, {
    ...registration, taskKey: channel.taskKey, selectedSpecifications: channel.selectedSpecifications,
    nativeChannel: { traceOut: outPath, script: channel.script, command: channel.command, step: channel.step },
  }, environment));
  const plan = { schemaVersion: 1, kind: "qualification-native-channels", outPath,
    cwd: registration.command.cwd, channels: prepared.channels.map(channel => ({
      outPath: channel.outPath, script: channel.script, command: channel.command, step: channel.step,
    })) };
  const path = `${outPath}.native-channels.json`;
  writeNativeEnrollment(path, plan);
  return { path, producers, operationalAcceptance: false };
}

function writeNativeEnrollment(path, value) {
  const body = JSON.stringify(value);
  const sealed = JSON.stringify({ ...value, integrity: { schemaVersion: 1,
    sha256: createHash("sha256").update(body).digest("hex") } });
  if (Buffer.byteLength(sealed) > 128 * 1024) throw new Error("native-enrollment-byte-limit");
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}-${Date.now()}.tmp`;
  let fd;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, `${sealed}\n`);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    // Unlike rename, link cannot replace another producer's enrollment.
    linkSync(temp, path);
    fd = openSync(dirname(path), "r");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch { /* a failed open created no temporary file */ }
  }
}

export function readPartialNativeProducer(path, expected) {
  try {
    const { integrity, ...value } = JSON.parse(readFileSync(path, "utf8"));
    if (!validNativeProducer(value) || integrity?.schemaVersion !== 1 ||
        integrity.sha256 !== createHash("sha256").update(JSON.stringify(value)).digest("hex")) return null;
    for (const key of ["attemptId", "runGroupId", "root", "taskKey", "workspaceName", "sourceCommit", "outPath", "environmentDigest"])
      if (expected?.[key] !== undefined && value[key] !== expected[key]) return null;
    if (expected?.command !== undefined && !isDeepStrictEqual(value.command, expected.command)) return null;
    return value;
  } catch { return null; }
}

/** Bind a channel to the actual original npm tree, lifecycle and reporter PID.
 * Interrupted prefixes still need dead-run custody from the qualification host;
 * this reader never turns a missing terminal observation into a passed run.
 */
export function readPartialNativeChannelCustody(producer, native, { allowInterrupted = false } = {}) {
  const refused = reason => ({ status: "refused", reason, custody: null });
  if (!validNativeProducer(producer) || !producer.nativeChannel) return refused("native-channel-producer-invalid");
  const channel = producer.nativeChannel;
  try {
    const bindingPath = `${producer.outPath}.binding.json`, stat = lstatSync(bindingPath);
    if (stat.size > 16 * 1024) return refused("native-channel-binding-invalid");
    const binding = JSON.parse(readNativeArtifactBytes(bindingPath, stat.size, 16 * 1024).toString("utf8"));
    if (binding.schemaVersion !== 1 || binding.kind !== "native-channel-binding" ||
        binding.traceOut !== channel.traceOut || binding.outPath !== producer.outPath ||
        binding.script !== channel.script || binding.command !== channel.command || binding.step !== channel.step ||
        !Number.isSafeInteger(binding.parentPid) || binding.parentPid <= 0 ||
        !validIdentity(binding.processIdentity) || !validIdentity(binding.childIdentity))
      return refused("native-channel-binding-invalid");
    const { rows, sourceRoot, population } = readNativeProcessTraceArtifacts(channel.traceOut);
    if (!population.complete) return refused("native-channel-trace-incomplete");
    const observations = rows.map(value => value.row);
    if (observations.some(row => ["trace-limit", "trace-event-too-large", "native-channel-unavailable"].includes(row.event)))
      return refused("native-channel-trace-gap");
    // Worker preloads share a PID with the reporter. Keep their source evidence,
    // but use only the main thread to establish OS-process ancestry and custody.
    const events = observations.filter(row => row.threadId === undefined || row.threadId === 0);
    const one = predicate => {
      const matches = events.filter(predicate);
      if (matches.length !== 1) throw new Error("native-channel-process-ambiguous");
      return matches[0];
    };
    const entryFor = pid => one(row => row.event === "node-entry" && row.pid === pid);
    const npmEntry = row => row.cwd === producer.command.cwd && Array.isArray(row.argv) &&
      ["npm-cli.js", "npm"].includes(basename(row.argv[1] ?? ""));
    if (!["npm", "npm.cmd"].includes(basename(producer.command.cmd))) return refused("native-channel-original-command-invalid");
    const root = one(row => row.event === "node-entry" && npmEntry(row) &&
      row.reporterOut === channel.traceOut && row.atMs >= producer.registeredAtMs &&
      isDeepStrictEqual(row.argv.slice(2), producer.command.argv));
    const observer = entryFor(binding.parentPid);
    if (!npmEntry(observer) || observer.processIdentity !== binding.processIdentity || observer.atMs < root.atMs)
      return refused("native-channel-observer-mismatch");
    const spawn = one(row => row.event === "child-spawn" && row.pid === binding.parentPid &&
      row.processIdentity === binding.processIdentity && row.childIdentity === binding.childIdentity);
    if (!isDeepStrictEqual(spawn.nativeChannel, binding) || !Number.isSafeInteger(spawn.childPid) || spawn.childPid <= 0 ||
        !["sh", "/bin/sh"].includes(spawn.command) || spawn.shell !== false ||
        !isDeepStrictEqual(spawn.argv, ["-c", channel.command]) || spawn.cwd !== producer.command.cwd ||
        spawn.lifecycle?.event !== channel.script || spawn.lifecycle?.script !== channel.command || spawn.atMs < observer.atMs)
      return refused("native-channel-spawn-mismatch");
    const closeFor = start => one(row => row.event === "child-close" && row.pid === start.pid &&
      row.processIdentity === start.processIdentity && row.childIdentity === start.childIdentity && row.childPid === start.childPid);
    const close = closeFor(spawn);
    const interrupted = allowInterrupted && native?.finishedAtMs === null && native.terminalHook === null &&
      native.reason === null && native.unhandledErrorCount === null && native.modulePopulationMatched === false &&
      Array.isArray(native.files) && native.files.length > 0 && Array.isArray(native.gaps) && native.gaps.length === 0;
    const endAtMs = interrupted ? Math.max(...native.files.map(file => file.observedAtMs)) : native?.finishedAtMs;
    if (native?.schemaVersion !== "native-vitest-run-v1" || native.scope !== "vitest-reporter-callbacks" ||
        !Number.isSafeInteger(native.pid) || !Number.isSafeInteger(native.ppid) ||
        !Number.isSafeInteger(native.startedAtMs) || native.startedAtMs < spawn.atMs ||
        !Number.isSafeInteger(endAtMs) || endAtMs < native.startedAtMs || endAtMs > close.atMs ||
        close.atMs < spawn.atMs || !(close.code === null || Number.isSafeInteger(close.code) && close.code >= 0) ||
        !(close.signal === null || validIdentity(close.signal)) || close.code === null && close.signal === null ||
        !interrupted && (close.code !== 0 || close.signal !== null))
      return refused("native-channel-close-mismatch");
    const reporter = entryFor(native.pid);
    if (reporter.ppid !== native.ppid || reporter.reporterOut !== producer.outPath ||
        reporter.cwd !== producer.command.cwd || reporter.lifecycle?.event !== channel.script ||
        reporter.lifecycle?.script !== channel.command || reporter.atMs < spawn.atMs || reporter.atMs > native.startedAtMs ||
        !(reporter.pid === spawn.childPid || reporter.ppid === spawn.childPid))
      return refused("native-channel-reporter-mismatch");
    // Walk observed shell/Node parent links back to the enrolled original npm.
    // Each hop needs its own single native spawn/close pair; PID proximity alone
    // cannot attach a foreign npm invocation to this run.
    const visited = new Set();
    for (let child = observer; child.processIdentity !== root.processIdentity;) {
      if (visited.has(child.pid)) return refused("native-channel-ancestry-cycle");
      visited.add(child.pid);
      const parentSpawn = one(row => row.event === "child-spawn" &&
        (row.childPid === child.pid || row.childPid === child.ppid) && row.atMs <= child.atMs &&
        row.atMs >= root.atMs);
      const parentClose = closeFor(parentSpawn), parent = entryFor(parentSpawn.pid);
      if (parent.processIdentity !== parentSpawn.processIdentity || parent.atMs > parentSpawn.atMs ||
          parentClose.atMs < close.atMs || parentClose.atMs < parentSpawn.atMs)
        return refused("native-channel-ancestry-mismatch");
      child = parent;
    }
    const exits = events.filter(row => row.event === "node-exit" && row.pid === reporter.pid &&
      row.processIdentity === reporter.processIdentity);
    if (exits.length > 1 || !interrupted && exits.length !== 1) return refused("native-channel-reporter-exit-unmeasured");
    if (!interrupted) {
      const exit = exits[0];
      if (exit.ppid !== reporter.ppid || exit.code !== 0 || exit.exitListenersComplete !== true ||
          exit.atMs < endAtMs || exit.atMs > close.atMs) return refused("native-channel-reporter-exit-mismatch");
      for (const role of ["stdout", "stderr"]) {
        const pin = exit.streams?.[role];
        if (pin?.scope !== "node-writable-call-inputs" || pin.captureComplete !== true || pin.artifactUnavailable ||
            !/^[a-f0-9]{64}$/.test(pin.sha256) || pin.ref !== `${pin.sha256}.stream` ||
            !Number.isSafeInteger(pin.byteLength) || pin.byteLength < 0 || pin.byteLength > 16 * 1024 * 1024 ||
            pin.observedByteLength !== pin.byteLength) return refused("native-channel-reporter-stream-unmeasured");
        const bytes = readNativeArtifactBytes(join(sourceRoot, pin.ref), pin.byteLength, 16 * 1024 * 1024);
        if (createHash("sha256").update(bytes).digest("hex") !== pin.sha256)
          return refused("native-channel-reporter-stream-mismatch");
      }
    }
    return { status: "bound", reason: null, custody: { rootPid: root.pid,
      reporterPid: reporter.pid, reporterProcessIdentity: reporter.processIdentity,
      observerPid: observer.pid, childPid: spawn.childPid, childIdentity: spawn.childIdentity,
      startedAtMs: spawn.atMs, closedAtMs: close.atMs, terminal: !interrupted } };
  } catch (error) { return refused(`native-channel-custody-unreadable:${error?.message ?? "unknown"}`); }
}

/**
 * Read the reporter's existing atomic OUT channel, including a snapshot written before
 * onTestRunEnd. Selection comes from the caller, never from the observed result sample.
 * classifyReadPaths is the reporter's maintained tracked/untracked-input classifier;
 * absent classification keeps the outcome but cannot establish a reusable pass.
 */
export function readPartialNativeCompletion(file, expected, options = {}) {
  const refused = reason => ({ status: "refused", reason, receipts: [], currentEvidence: [] });
  let snapshot;
  try { snapshot = readCompletionJsonSync(file); }
  catch { return refused("snapshot-unreadable"); }
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return refused("snapshot-invalid");
  const { completionIntegrity, ...body } = snapshot;
  if (completionIntegrity?.schemaVersion !== 1 ||
      completionIntegrity.sha256 !== jsonSha256(body))
    return refused("snapshot-integrity-invalid");
  const context = snapshot.completionCheckpoint, native = snapshot.nativeRun;
  if (!validIdentity(expected?.attemptId) || context?.schemaVersion !== 1 ||
      context.qualificationAttemptId !== expected.attemptId ||
      snapshot.workspaceName !== expected.workspaceName || !validIdentity(expected.root) ||
      !validIdentity(snapshot.recordedSha) || !validIdentity(context.runContext) || !validIdentity(context.runnerIdentity))
    return refused("snapshot-identity-mismatch");
  let producer;
  if (expected.producerPath !== undefined) {
    producer = readPartialNativeProducer(expected.producerPath, { ...expected,
      outPath: file, runGroupId: context.runGroupId, sourceCommit: snapshot.recordedSha });
    if (!producer || !Number.isSafeInteger(native?.startedAtMs) || native.startedAtMs < producer.registeredAtMs ||
        !isDeepStrictEqual(producer.selectedSpecifications, expected.selectedSpecifications))
      return refused("native-producer-mismatch");
  }
  if (native?.schemaVersion !== "native-vitest-run-v1" || !Array.isArray(native.files) ||
      !Array.isArray(native.gaps) || !Array.isArray(snapshot.rows)) return refused("native-population-unmeasured");
  const specifications = expected.selectedSpecifications;
  if (!Array.isArray(specifications) || !specifications.length ||
      !Array.isArray(native.selectedManifest?.specifications)) return refused("native-selection-unmeasured");
  const canonical = values => JSON.stringify([...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  // JSONB may reorder object keys in the independently frozen selection. Compare
  // values structurally, but check the native digest in its writer's own format.
  const byFile = values => [...values].sort((a, b) => String(a?.testFile).localeCompare(String(b?.testFile)));
  if (!isDeepStrictEqual(byFile(specifications), byFile(native.selectedManifest.specifications)) ||
      native.selectedManifest.sha256 !== createHash("sha256").update(canonical(native.selectedManifest.specifications)).digest("hex"))
    return refused("native-selection-mismatch");
  const units = continuationManifest(expected.manifest);
  if (!units) return refused("manifest-mismatch");
  const byPath = new Map();
  for (const unit of units.filter(unit => unit.kind === "test" && !unit.exclusion)) {
    if (byPath.has(unit.path)) return refused("ambiguous-test-path");
    byPath.set(unit.path, unit);
  }
  const selectedPaths = new Set();
  for (const spec of specifications) {
    if (!repoPath(spec?.testFile) || selectedPaths.has(spec.testFile) || !byPath.has(spec.testFile))
      return refused("native-selection-invalid");
    selectedPaths.add(spec.testFile);
  }
  // A dead producer may contribute its acknowledged prefix, never a terminal
  // verdict. The host must establish dead custody and a later clean successor.
  // In particular onExit, failed terminal hooks and unknown/mixed tail fields
  // cannot be relabeled as an interrupted prefix.
  const terminalPassed = Number.isSafeInteger(native.finishedAtMs) && native.finishedAtMs >= native.startedAtMs &&
    native.reason === "passed" && native.unhandledErrorCount === 0 && native.modulePopulationMatched === true &&
    native.files.length === selectedPaths.size && native.gaps.length === 0;
  const interrupted = native.finishedAtMs === null && native.terminalHook === null && native.reason === null &&
    native.unhandledErrorCount === null && native.modulePopulationMatched === false &&
    native.gaps.length === 0 && native.files.length > 0;
  let physicalCustody;
  if (producer?.nativeChannel) {
    const custody = readPartialNativeChannelCustody(producer, native, {
      allowInterrupted: options.allowInterrupted === true && interrupted,
    });
    if (custody.status !== "bound") return refused(custody.reason);
    physicalCustody = custody.custody;
  }
  if (options.requireTerminal === true && !terminalPassed && !(options.allowInterrupted === true && interrupted))
    return refused("native-terminal-verdict-unmeasured");
  const rows = new Map();
  for (const row of snapshot.rows) {
    if (!selectedPaths.has(row?.testFile) || rows.has(row.testFile)) return refused("native-proof-population-invalid");
    rows.set(row.testFile, row);
  }
  const seenFiles = new Set(), seenCompletions = new Set(), receipts = [], currentEvidence = [];
  const currentPhysical = currentIdentity(expected) && physicalCustody?.terminal === true && terminalPassed &&
    native.terminalHook === "onTestRunEnd" &&
    context.runGroupId === expected.runId && snapshot.recordedSha === expected.sourceCommit &&
    snapshot.recordedSha === expected.candidate && context.runContext === expected.runContext &&
    context.runnerIdentity === expected.runnerIdentity && snapshot.worktreeDirty === false &&
    snapshot.configSources?.status === "unchanged" && Number.isSafeInteger(expected.runnerReservedAtMs) &&
    producer.registeredAtMs >= expected.runnerReservedAtMs &&
    Number.isSafeInteger(expected.nowMs) && physicalCustody.closedAtMs <= expected.nowMs;
  for (const file of native.files) {
    if (!selectedPaths.has(file?.testFile) || seenFiles.has(file.testFile) ||
        !validIdentity(file.completionId) || seenCompletions.has(file.completionId) ||
        !Number.isSafeInteger(file.observedAtMs) || file.observedAtMs <= 0 ||
        !["passed", "failed", "skipped", "pending", "error"].includes(file.state))
      return refused("native-receipt-population-invalid");
    seenFiles.add(file.testFile);
    seenCompletions.add(file.completionId);
    const row = rows.get(file.testFile);
    let classified;
    try { if (row) classified = options.classifyReadPaths?.(row.readPaths, expected.root); }
    catch { /* An unavailable tracked-input census never authorizes reuse. */ }
    const inputMeasured = Array.isArray(classified?.readPaths) && classified.readPaths.every(repoPath) &&
      Array.isArray(classified?.opaqueReasons) && classified.opaqueReasons.every(reason => typeof reason === "string");
    const source = file.proof?.sourceEvidence;
    const cleanSource = source?.schemaVersion === "vite-collected-source-evidence-v1" &&
      source.status === "stable" && Array.isArray(source.sources) && source.sources.length > 0 &&
      source.sources.every(value => repoPath(value.path) && /^[a-f0-9]{64}$/.test(value.sha256) && value.sha256 === value.currentSha256) &&
      Array.isArray(source.reasons) && source.reasons.length === 0;
    const cases = file.cases;
    const measuredCases = Array.isArray(cases) && cases.length > 0 && cases.every(value => value.status === "pass");
    const runClean = interrupted || terminalPassed;
    const opaqueReasons = Array.isArray(row?.opaqueReasons) ? [...row.opaqueReasons] : ["proof-unmeasured"];
    if (!inputMeasured) opaqueReasons.push("input-classification-unmeasured");
    else opaqueReasons.push(...classified.opaqueReasons);
    if (!cleanSource) opaqueReasons.push("native-source-unmeasured");
    if (!measuredCases) opaqueReasons.push("native-cases-incomplete");
    if (!runClean) opaqueReasons.push("native-run-incomplete-or-errored");
    if (snapshot.configSources?.status !== "unchanged") opaqueReasons.push("config-source-unmeasured");
    const executedModules = row?.executedModules;
    if (!Array.isArray(executedModules) || !executedModules.length || !executedModules.every(repoPath))
      opaqueReasons.push("execution-closure-unmeasured");
    const receipt = { unitId: byPath.get(file.testFile).id, completionId: file.completionId,
      observedAtMs: file.observedAtMs, state: file.state === "passed" ? "pass" : file.state === "failed" ? "fail" : "infra",
      worktreeDirty: snapshot.worktreeDirty !== false, firstAttemptVerdict: file.firstAttemptVerdict,
      observedCount: measuredCases ? cases.length : 0,
      proof: { recordedSha: snapshot.recordedSha, runContext: context.runContext,
        runnerIdentity: context.runnerIdentity, executedModules: executedModules ?? [],
        inputsCaptured: row?.inputsCaptured === true && inputMeasured,
        readPaths: inputMeasured ? classified.readPaths : [], opaqueReasons } };
    receipts.push(receipt);
    // Runtime-input closure remains unmeasured. Current evidence independently
    // requires source/config, full collection, clean first attempt and native
    // command/process/artifact custody; an opaque reuse proof grants nothing.
    if (currentPhysical && cleanSource && measuredCases && file.state === "passed" &&
        file.firstAttemptVerdict === "pass" && file.observedAtMs >= native.startedAtMs &&
        file.observedAtMs <= native.finishedAtMs) {
      const capability = currentCapability(receipt, { ...expected,
        taskKey: expected.continuationTaskKey ?? expected.taskKey });
      if (capability) currentEvidence.push(capability);
    }
  }
  return { status: "ready", reason: null, receipts, currentEvidence, origin: {
    terminal: terminalPassed ? "passed" : interrupted ? "interrupted" : "unmeasured",
    runGroupId: validIdentity(context.runGroupId) ? context.runGroupId : null,
    startedAtMs: Number.isSafeInteger(native.startedAtMs) && native.startedAtMs > 0 ? native.startedAtMs : null,
    sourceCommit: snapshot.recordedSha,
  } };
}

/** Authenticate a current command's ORIGINAL pinned output, independently of
 * retained-pass eligibility. Definitions must come from the frozen source-owned
 * command inventory, not the receipt's observed sample. No runtime closure is
 * inferred; only a complete current physical outcome can mint a capability.
 */
export function readPartialCurrentCommandCompletion(receipt, expected, definition) {
  const refused = reason => ({ status: "refused", reason, currentEvidence: [] });
  const identity = partialCurrentExecutionFingerprint(expected);
  const unit = continuationManifest(expected?.manifest)?.find(unit => unit.id === receipt?.unitId);
  if (!identity || !unit || unit.kind === "test" || unit.exclusion || receipt.state !== "pass" ||
      !Array.isArray(definition?.commands) || !definition.commands.length ||
      new Set(definition.commands.map(command => command?.id)).size !== definition.commands.length ||
      receipt.observedCount !== definition.commands.length || !Number.isSafeInteger(expected.runnerReservedAtMs) ||
      !Number.isSafeInteger(expected.nowMs)) return refused("current-command-identity-unmeasured");
  const outcomes = receipt.proof?.commandOutcomes;
  if (!Array.isArray(outcomes) || outcomes.length !== definition.commands.length ||
      new Set(outcomes.map(row => row?.command)).size !== outcomes.length)
    return refused("current-command-population-mismatch");
  let bytesRead = 0, latest = 0;
  const readPin = (root, pin) => {
    if (!isAbsolute(root ?? "") || root !== definition.evidenceRoot || !pin ||
        !repoPath(pin.ref) || basename(pin.ref) !== pin.ref || !/^[a-f0-9]{64}$/.test(pin.sha256) ||
        !Number.isSafeInteger(pin.byteLength) || pin.byteLength < 0)
      throw new Error("artifact-reference-invalid");
    const bytes = readNativeArtifactBytes(join(root, pin.ref), pin.byteLength,
      64 * 1024 * 1024 - bytesRead, count => { bytesRead += count; });
    if (createHash("sha256").update(bytes).digest("hex") !== pin.sha256) throw new Error("artifact-digest-mismatch");
    return bytes;
  };
  const retainedArtifacts = (root, value, depth = 0) => {
    if (depth > 20) throw new Error("artifact-nesting-invalid");
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      // Non-test commands legitimately have no Vitest reporter artifact. Null
      // diagnostics grant no evidence; every concrete referenced pin is checked.
      if (key === "artifact" && child !== null) readPin(root, child);
      else retainedArtifacts(root, child, depth + 1);
    }
  };
  try {
    for (const command of definition.commands) {
      const outcome = outcomes.find(row => row?.command === command?.id);
      if (!outcome || !validIdentity(command.id) || !validIdentity(command.task) ||
          !Array.isArray(command.argv) || !command.argv.length || !command.argv.every(validIdentity) ||
          !isAbsolute(command.cwd ?? "") || !Array.isArray(command.inputs) || !command.inputs.length ||
          command.inputs.some(pin => !repoPath(pin?.path) || !/^[a-f0-9]{64}$/.test(pin.sha256)) ||
          new Set(command.inputs.map(pin => pin.path)).size !== command.inputs.length)
        return refused("current-command-definition-invalid");
      const native = JSON.parse(readPin(outcome.root, outcome.receipt).toString("utf8"));
      retainedArtifacts(outcome.root, native);
      const execution = native.execution, origin = native.currentExecution;
      if (native.schemaVersion !== 1 || native.kind !== "affected-task-native-execution" ||
          native.task !== command.task || native.attempt !== expected.runId ||
          origin?.schemaVersion !== 1 || origin.fingerprint !== identity ||
          origin.sourceBefore?.commit !== expected.candidate || origin.sourceBefore?.clean !== true ||
          origin.sourceAfter?.commit !== expected.candidate || origin.sourceAfter?.clean !== true ||
          !Number.isSafeInteger(origin.childPid) || origin.childPid <= 0 || !validIdentity(origin.childIdentity) ||
          execution?.cwd !== command.cwd || execution.captureComplete !== true || execution.signal !== null ||
          execution.error !== null || !Number.isSafeInteger(execution.startedAtMs) ||
          execution.startedAtMs < expected.runnerReservedAtMs || !Number.isSafeInteger(execution.finishedAtMs) ||
          execution.finishedAtMs < execution.startedAtMs || execution.finishedAtMs > expected.nowMs ||
          !isDeepStrictEqual(execution.invocation?.command, command.argv) ||
          !/^[a-f0-9]{64}$/.test(execution.invocation?.environmentSha256) ||
          !(isDeepStrictEqual(execution.command, command.argv) ||
            validIdentity(definition.wrapper) && isDeepStrictEqual(execution.command, [definition.wrapper, ...command.argv])) ||
          native.originalCommand !== command.originalCommand || native.sourceInputsUnchanged !== true ||
          !isDeepStrictEqual(native.before?.inputs, command.inputs) || !isDeepStrictEqual(native.after?.inputs, command.inputs))
        return refused("current-command-origin-mismatch");
      for (const pin of command.inputs) {
        const absolute = resolve(expected.root, pin.path), stat = lstatSync(absolute);
        if (createHash("sha256").update(readNativeArtifactBytes(absolute, stat.size, 16 * 1024 * 1024))
          .digest("hex") !== pin.sha256) return refused("current-command-source-changed");
      }
      const stdout = readPin(outcome.root, execution.logs?.stdout).toString("utf8");
      readPin(outcome.root, execution.logs?.stderr);
      if (!Array.isArray(command.exitCodes) || !command.exitCodes.includes(execution.exitCode) ||
          command.emptyStdout === true && stdout.trim()) return refused("current-command-outcome-not-pass");
      // Native commands require the measured complete process census and the
      // matching original Node/npm entry and clean terminal event. Shell and
      // non-Node executable closure stays explicitly outside this observation.
      if (["npm", "npm.cmd", "node", "node.exe"].includes(basename(command.argv[0]))) {
        const trace = native.processTrace;
        if (trace?.population?.complete !== true || !Array.isArray(trace.events))
          return refused("current-command-process-unmeasured");
        const entries = trace.events.filter(row => row.event === "node-entry" &&
          (row.pid === origin.childPid || row.ppid === origin.childPid) && row.cwd === command.cwd &&
          Array.isArray(row.argv) && isDeepStrictEqual(row.argv.slice(basename(command.argv[0]).startsWith("npm") ? 2 : 1),
            command.argv.slice(1)));
        if (entries.length !== 1) return refused("current-command-process-mismatch");
        const entry = entries[0];
        const exits = trace.events.filter(row => row.event === "node-exit" && row.pid === entry.pid &&
          row.processIdentity === entry.processIdentity && row.code === execution.exitCode && row.exitListenersComplete === true &&
          row.atMs >= entry.atMs && row.atMs <= execution.finishedAtMs);
        if (exits.length !== 1) return refused("current-command-terminal-unmeasured");
      }
      latest = Math.max(latest, execution.finishedAtMs);
    }
    if (receipt.observedAtMs !== latest) return refused("current-command-completion-time-mismatch");
    const capability = currentCapability(receipt, expected);
    return capability ? { status: "ready", reason: null, currentEvidence: [capability] }
      : refused("current-command-identity-unmeasured");
  } catch (error) { return refused(`current-command-artifact-unreadable:${error?.message ?? "unknown"}`); }
}

/** Source census for an original affected-task npm invocation. This is wrapper
 * provenance, not runtime-input closure or permission to reuse a later result. */
export function partialTaskCommandInputs(root, dir) {
  if (!isAbsolute(root ?? "") || (dir !== "." && !repoPath(dir))) return null;
  try {
    const files = ["package.json", "package-lock.json", "npm-shrinkwrap.json", ".npmrc",
      ...(dir === "." ? [] : [`${dir}/package.json`, `${dir}/.npmrc`])];
    const inputs = [];
    for (const file of files) {
      let stat;
      try { stat = lstatSync(resolve(root, file)); }
      catch (error) {
        if (error?.code === "ENOENT" && !file.endsWith("package.json")) continue;
        throw error;
      }
      const bytes = readNativeArtifactBytes(resolve(root, file), stat.size, 16 * 1024 * 1024);
      inputs.push({ path: file, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    return inputs;
  } catch { return null; }
}

/** Map the independently selected full guard population to ORIGINAL npm tasks.
 * Invocations must come from the host's maintained selector, before execution;
 * receipt samples never choose a command or its owed units. A whole task is the
 * atomic guard chunk, including source-validated npm hooks and ordered chains.
 * @param {{root: string, selection: any, postSuite: any, evidenceRoot: string, invocations: any[]}} input
 */
export function preparePartialTaskCommandDefinitions({ root, selection, postSuite, evidenceRoot, invocations }) {
  const refused = reason => ({ status: "refused", reason, definitions: [], operationalAcceptance: false });
  if (!isAbsolute(evidenceRoot ?? "") || !Array.isArray(invocations) ||
      new Set(invocations.map(row => row?.task)).size !== invocations.length)
    return refused("task-command-invocations-unmeasured");
  const prepared = preparePartialContinuationManifest({ root, tasks: selection?.taskInventory, selection, postSuite });
  if (prepared.status !== "ready") return refused(`task-command-${prepared.reason}`);
  const definitions = [];
  for (const task of selection.taskInventory) {
    const entry = selection.tasks.find(row => row.id === task.id);
    const part = preparePartialContinuationManifest({ root, tasks: [task], postSuite,
      selection: { ...selection, tasks: entry ? [entry] : [],
        unenumerated: selection.unenumerated.filter(row => row.task === task.id),
        commandObligations: selection.commandObligations.filter(row => row.task === task.id) } });
    if (part.status !== "ready") return refused(`task-command-${part.reason}`);
    const unitIds = part.manifest.units.filter(unit => unit.kind === "guard").map(unit => unit.id);
    if (!unitIds.length) continue;
    const invocation = invocations.find(row => row?.task === task.id);
    const script = task.id.slice(task.id.lastIndexOf(" :: ") + 4);
    const argv = invocation?.argv;
    const cwd = invocation?.cwd;
    const prefix = cwd === root && argv?.[3] === "--workspace" ? ["npm", "run", script, "--workspace", task.dir] :
      cwd === resolve(root, task.dir) ? ["npm", "run", script] : null;
    const inputs = partialTaskCommandInputs(root, task.dir);
    if (!prefix || !Array.isArray(argv) || !argv.every(validIdentity) ||
        !isDeepStrictEqual(argv.slice(0, prefix.length), prefix) ||
        (argv.length > prefix.length && argv[prefix.length] !== "--") || !inputs)
      return refused("task-command-invocation-mismatch");
    const forwardedArgs = argv.length > prefix.length ? argv.slice(prefix.length + 1) : [];
    // npm appends these arguments to the main script through sh -c. Keep the
    // measured, unambiguous subset; opaque shell quoting cannot grant a pass.
    if (forwardedArgs.some(arg => !/^[\w@%+=:,./-]+$/.test(arg)))
      return refused("task-command-forwarded-arguments-unsupported");
    let sourceLifecycle;
    try {
      const bytes = readNativeArtifactBytes(resolve(root, task.dir, "package.json"),
        lstatSync(resolve(root, task.dir, "package.json")).size, 16 * 1024 * 1024);
      const source = JSON.parse(bytes.toString("utf8"));
      if (source.scripts?.[script] !== task.command || `${source.name} :: ${script}` !== task.id)
        return refused("task-command-source-mismatch");
      sourceLifecycle = expandSelectionCommands(source.scripts, script);
    } catch { return refused("task-command-source-unreadable"); }
    definitions.push({ task: task.id, unitIds, evidenceRoot, sourceLifecycle, forwardedArgs,
      lifecycleCwd: resolve(root, task.dir), commands: [{
      id: task.id, task: task.id, argv: [...argv], cwd, originalCommand: task.command,
      inputs, exitCodes: [0],
    }] });
  }
  if (invocations.some(row => !selection.taskInventory.some(task => task.id === row?.task)))
    return refused("task-command-outside-selection");
  return { status: "ready", reason: null, definitions, operationalAcceptance: false };
}

/** Recover one durable whole-task outcome against the source-owned guard list.
 * Every guard is authenticated before any update is returned. Current capabilities
 * stay ephemeral; the resulting receipts cannot authorize a replacement to skip.
 */
export function readPartialTaskCommandCompletion(observation, expected, definition) {
  const refused = reason => ({ status: "refused", reason, receipts: [], currentEvidence: [] });
  const pin = observation?.receipt;
  if (observation?.root !== definition?.evidenceRoot || !isAbsolute(observation?.root ?? "") ||
      !Array.isArray(definition?.unitIds) || !definition.unitIds.length ||
      new Set(definition.unitIds).size !== definition.unitIds.length ||
      !Array.isArray(definition.commands) || definition.commands.length !== 1 ||
      !Array.isArray(definition.sourceLifecycle) || !definition.sourceLifecycle.length ||
      definition.sourceLifecycle.some(step => !validIdentity(step?.script) || !validIdentity(step?.command)) ||
      !isAbsolute(definition.lifecycleCwd ?? "") ||
      !pin || !repoPath(pin.ref) || basename(pin.ref) !== pin.ref || !/^[a-f0-9]{64}$/.test(pin.sha256) ||
      !Number.isSafeInteger(pin.byteLength) || pin.byteLength < 0)
    return refused("task-command-artifact-reference-invalid");
  try {
    const bytes = readNativeArtifactBytes(join(observation.root, pin.ref), pin.byteLength, 64 * 1024 * 1024);
    if (createHash("sha256").update(bytes).digest("hex") !== pin.sha256)
      return refused("task-command-artifact-digest-mismatch");
    const native = JSON.parse(bytes.toString("utf8"));
    // A zero npm exit does not prove its source-owned hooks ran: ignore-scripts
    // can omit them. Require each expanded source step's actual npm-owned shell
    // spawn/clean close, including repeated nested aliases, in execution order.
    const events = native.processTrace?.events;
    if (native.processTrace?.population?.complete !== true || !Array.isArray(events))
      return refused("task-command-lifecycle-unmeasured");
    const starts = events.filter(row => row.event === "child-spawn" &&
      ["sh", "/bin/sh"].includes(row.command) && row.shell === false &&
      row.cwd === definition.lifecycleCwd && Array.isArray(row.argv) && row.argv.length === 2 &&
      row.argv[0] === "-c" &&
      definition.sourceLifecycle.some(step => step.script === row.lifecycle?.event && step.command === row.lifecycle?.script))
      .sort((a, b) => a.atMs - b.atMs);
    if (starts.length !== definition.sourceLifecycle.length) return refused("task-command-lifecycle-population-mismatch");
    const lastMainStep = definition.sourceLifecycle.findLastIndex(step => step.lifecycle !== true);
    const forwarded = definition.forwardedArgs ?? [];
    if (!Array.isArray(forwarded) || forwarded.some(arg => typeof arg !== 'string' || !/^[\w@%+=:,./-]+$/.test(arg)))
      return refused("task-command-forwarded-arguments-unsupported");
    let previousEnd = native.execution?.startedAtMs;
    for (const [index, step] of definition.sourceLifecycle.entries()) {
      const start = starts[index];
      const observers = events.filter(row => row.event === "node-entry" && row.pid === start.pid &&
        row.processIdentity === start.processIdentity && Array.isArray(row.argv) &&
        ["npm", "npm-cli.js"].includes(basename(row.argv[1] ?? "")) &&
        ["run", "run-script"].includes(row.argv[2]));
      const closes = events.filter(row => row.event === "child-close" && row.pid === start.pid &&
        row.processIdentity === start.processIdentity && row.childPid === start.childPid && row.childIdentity === start.childIdentity);
      const close = closes[0];
      if (start.lifecycle.event !== step.script || start.lifecycle.script !== step.command ||
          start.argv[1] !== step.command + (index === lastMainStep && forwarded.length ? ` ${forwarded.join(' ')}` : '') ||
          observers.length !== 1 || closes.length !== 1 || close.code !== 0 || close.signal !== null ||
          !Number.isSafeInteger(start.atMs) || start.atMs < previousEnd ||
          !Number.isSafeInteger(close.atMs) || close.atMs < start.atMs || close.atMs > native.execution?.finishedAtMs)
        return refused("task-command-lifecycle-mismatch");
      previousEnd = close.atMs;
    }
    const receipts = [], currentEvidence = [];
    for (const unitId of definition.unitIds) {
      if (expected.manifest?.units?.find(unit => unit.id === unitId)?.kind !== "guard")
        return refused("task-command-unit-outside-selection");
      const receipt = { unitId, completionId: `${pin.sha256}:${unitId}`,
        observedAtMs: native.execution?.finishedAtMs, state: /** @type {"pass"} */ ("pass"), observedCount: 1,
        proof: { commandOutcomes: [{ command: definition.task, root: observation.root, receipt: pin }],
          opaqueReasons: ["task-command-runtime-inputs-unmeasured"] } };
      receipts.push(receipt);
    }
    // All units name the same original command/artifacts. Authenticate that IO
    // once, after checking the entire guard population, then mint per-unit
    // capabilities in this module. A long chain cannot multiply the IO budget.
    const authenticated = readPartialCurrentCommandCompletion(receipts[0], expected, definition);
    if (authenticated.status !== "ready") return refused(authenticated.reason);
    for (const receipt of receipts) {
      const capability = currentCapability(receipt, expected);
      if (!capability) return refused("task-command-identity-unmeasured");
      currentEvidence.push(capability);
    }
    return { status: "ready", reason: null, receipts, currentEvidence };
  } catch (error) { return refused(`task-command-artifact-unreadable:${error?.message ?? "unknown"}`); }
}

function continuationManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.units) || !manifest.units.length) return null;
  const seen = new Set();
  const units = [];
  for (const unit of manifest.units) {
    if (!validIdentity(unit?.id) || seen.has(unit.id) || !UNIT_KINDS.has(unit.kind) || !repoPath(unit.path)) return null;
    seen.add(unit.id);
    let exclusion;
    if (unit.exclusion !== undefined) {
      if (!validIdentity(unit.exclusion?.reason) || !validIdentity(unit.exclusion?.policyRef)) return null;
      exclusion = { reason: unit.exclusion.reason, policyRef: unit.exclusion.policyRef };
    }
    units.push({ id: unit.id, kind: unit.kind, path: unit.path, ...(exclusion ? { exclusion } : {}) });
  }
  return units.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Freeze the qualification population from the maintained selector and its original
 * task inventory, before any outcome is observed. Command guards remain obligations
 * even when they have no native test files. Post-suite selection is mandatory and
 * supplied independently by the gate; observed post-suite results cannot define it.
 * This is preparation only: it neither enrolls a producer nor authorizes execution.
 * @param {{tasks: any, selection: any, postSuite: any, exclusions?: any[], root?: string}} input
 */
export function preparePartialContinuationManifest({ tasks, selection, postSuite, exclusions = [], root }) {
  const refused = reason => ({ status: "refused", reason, manifest: null, operationalAcceptance: false });
  if (!Array.isArray(tasks) || !tasks.length || selection?.schemaVersion !== 1 ||
      selection.kind !== "full-gate" || selection.phase !== "selection-preparation" ||
      selection.executed !== false || !Array.isArray(selection.tasks) ||
      !Array.isArray(selection.unenumerated) || !Array.isArray(selection.commandObligations) ||
      [...selection.unenumerated, ...selection.commandObligations].some(value => !validIdentity(value?.task)))
    return refused("task-population-unmeasured");
  if (postSuite?.schemaVersion !== 1 || postSuite.coverage !== "complete" ||
      !Array.isArray(postSuite.units) || !postSuite.units.length)
    return refused("post-suite-population-unmeasured");
  const units = [], ids = new Set(), testPaths = new Set(), entries = new Map();
  for (const entry of selection.tasks) {
    if (!validIdentity(entry?.id) || entries.has(entry.id)) return refused("task-population-invalid");
    entries.set(entry.id, entry);
  }
  for (const task of tasks) {
    const id = task?.id;
    if (!validIdentity(id) || ids.has(id) || !validIdentity(task.command) ||
        typeof task.dir !== "string" || (task.dir !== "." && !repoPath(task.dir)))
      return refused("task-population-invalid");
    ids.add(id);
    const entry = entries.get(id);
    if (entry && (entry.command !== task.command || entry.dir !== task.dir))
      return refused("task-selection-mismatch");
    if (task.isInvariantGuard === true) {
      units.push({ id: `guard:${id}`, kind: "guard",
        path: task.dir === "." ? "package.json" : `${task.dir}/package.json` });
      continue;
    }
    if (entry?.runner === "command-chain") {
      // Reconstruct the ordered inventory from the actual npm scripts before
      // trusting the prepared leaves. A file union cannot reveal an omitted or
      // reordered hook. Keep a separate whole-chain execution obligation too:
      // individual leaf passes do not prove that npm ran the original chain.
      if (!isAbsolute(root ?? "") || !Array.isArray(entry.steps) || entry.steps.length < 2 ||
          entry.steps.some(step => !step || !validIdentity(step.script) || !validIdentity(step.command) ||
            !Array.isArray(step.files) || !Array.isArray(step.commandObligations) || !Array.isArray(step.unenumerated)) ||
          !validIdentity(entry.script) || !validIdentity(entry.workspace) ||
          id !== `${entry.workspace} :: ${entry.script}`)
        return refused("chain-population-unmeasured");
      let sourceSteps;
      try {
        const scripts = JSON.parse(readFileSync(resolve(root, task.dir, "package.json"), "utf8")).scripts;
        if (scripts?.[entry.script] !== task.command) return refused("chain-source-changed");
        sourceSteps = expandSelectionCommands(scripts, entry.script);
      } catch { return refused("chain-source-unmeasured"); }
      if (!isDeepStrictEqual(sourceSteps, entry.steps.map(step => ({ script: step?.script,
          command: step?.command, ...(step?.lifecycle === true ? { lifecycle: true } : {}) }))))
        return refused("chain-population-mismatch");
      const chainCommands = entry.steps.flatMap((step, index) =>
        (Array.isArray(step.commandObligations) ? step.commandObligations : [])
          .map(command => ({ ...command, step: index })));
      const declared = selection.commandObligations.filter(value => value.task === id)
        .map(({ task: _task, ...value }) => value);
      // Leaf selector envelopes carry their local task id. The top-level
      // envelope replaces it with the original chain id.
      if (!isDeepStrictEqual(chainCommands, entry.commandObligations) ||
          !isDeepStrictEqual(chainCommands.map(({ task: _task, ...command }) => command), declared))
        return refused("command-population-mismatch");
      const chainFiles = [], chainResidues = [];
      const leafUnits = [];
      for (const [index, step] of entry.steps.entries()) {
        if (!Array.isArray(step.files) || !Array.isArray(step.commandObligations) ||
            !Array.isArray(step.unenumerated)) return refused("chain-population-unmeasured");
        const leafId = `${id}:step:${index}`;
        let leaf;
        if (step.lifecycle === true) {
          if (step.files.length || step.commandObligations.length !== 1 ||
              step.commandObligations[0]?.kind !== "npm-lifecycle")
            return refused("chain-population-mismatch");
          leaf = { runner: "lifecycle-command", files: [],
            lifecycleCommands: [{ script: step.script, command: step.command }] };
        } else {
          if (!Array.isArray(step.discovery) || step.discovery.length !== 1 ||
              step.discovery[0]?.runner === "command-chain" ||
              step.discovery[0]?.command !== step.command ||
              !isDeepStrictEqual(step.discovery[0]?.files, step.files))
            return refused("chain-population-mismatch");
          leaf = step.discovery[0];
        }
        const commands = step.commandObligations.map(({ task: _task, ...command }) => command);
        if (!step.lifecycle && !isDeepStrictEqual(commands, leaf.commandObligations ?? []))
          return refused("command-population-mismatch");
        const residues = step.unenumerated.map(({ task: _task, ...value }) => value);
        chainResidues.push(...residues.map(value => ({ task: id, step: index,
          command: step.command, reason: value.reason })));
        const prepared = preparePartialContinuationManifest({ root, postSuite,
          tasks: [{ id: leafId, dir: task.dir, command: step.command }], selection: {
            schemaVersion: 1, kind: "full-gate", phase: "selection-preparation", executed: false,
            tasks: [{ ...leaf, id: leafId, dir: task.dir, command: step.command, commandObligations: commands }],
            commandObligations: commands.map(command => ({ ...command, task: leafId })),
            unenumerated: residues.map(value => ({ ...value, task: leafId })),
          } });
        if (prepared.status !== "ready") return refused(prepared.reason);
        leafUnits.push(...prepared.manifest.units.filter(unit => unit.kind !== "post-suite"));
        chainFiles.push(...step.files);
      }
      if (!Array.isArray(entry.files) ||
          !isDeepStrictEqual([...new Set(chainFiles)].sort(), entry.files.slice().sort()) ||
          !isDeepStrictEqual(chainResidues, selection.unenumerated.filter(value => value.task === id)))
        return refused("chain-population-mismatch");
      for (const unit of leafUnits) {
        if (unit.kind === "test") {
          if (testPaths.has(unit.path)) return refused("test-population-overlapping-or-invalid");
          testPaths.add(unit.path);
        }
        units.push(unit);
      }
      units.push({ id: `chain:${id}`, kind: "guard",
        path: task.dir === "." ? "package.json" : `${task.dir}/package.json` });
      continue;
    }
    if (!entry || !Array.isArray(entry.files) || (!entry.files.length &&
        !["command-check", "lifecycle-command"].includes(entry.runner)) ||
        !["vitest", "node-test", "astro-check", "command-check", "lifecycle-command"].includes(entry.runner) ||
        entry.files.some(file => !repoPath(file)) || new Set(entry.files).size !== entry.files.length)
      return refused("task-selection-unmeasured");
    // Discovery is not execution. Keep each explicit command as a separate required
    // guard, including lifecycle hooks around a native test task. Unknown commands,
    // missing input censuses and discovery that moved since selection still refuse.
    const commands = entry.commandObligations ?? [];
    if (!Array.isArray(commands) || commands.some(command => !command || typeof command !== "object"))
      return refused("command-population-invalid");
    const declared = selection.commandObligations.filter(value => value.task === id)
      .map(({ task: _task, ...value }) => value);
    if (!isDeepStrictEqual(commands, declared)) return refused("command-population-mismatch");
    const residues = selection.unenumerated.filter(value => value.task === id);
    if (residues.some(value =>
      !(value.reason === "unexecuted-command-obligations" && commands.some(command => command.kind === "command-check")) &&
      !(value.reason === "unexecuted-lifecycle-command" && commands.some(command => command.kind === "npm-lifecycle"))))
      return refused("task-selection-unmeasured");
    if (["astro-check", "command-check"].includes(entry.runner) &&
        !commands.some(command => command.kind === "command-check")) return refused("command-population-unmeasured");
    if (entry.runner === "lifecycle-command" && (commands.length !== 1 ||
        commands[0]?.kind !== "npm-lifecycle" || commands[0]?.command !== task.command))
      return refused("command-population-unmeasured");
    if (entry.lifecycleCommands !== undefined && (!Array.isArray(entry.lifecycleCommands) ||
        entry.lifecycleCommands.some(step => !step || commands.filter(command => command.kind === "npm-lifecycle" &&
          command.script === step.script && command.command === step.command).length !== 1)))
      return refused("command-population-unmeasured");
    for (const [index, command] of commands.entries()) {
      const discovery = command?.discovery;
      const discoveryFiles = discovery?.repositoryFiles ?? discovery?.files;
      if (!["command-check", "npm-lifecycle"].includes(command?.kind) || !validIdentity(command.command) ||
          command.executed !== false || !isAbsolute(root ?? "") ||
          !Array.isArray(command.inputs) || !command.inputs.length ||
          new Set(command.inputs.map(input => input?.path)).size !== command.inputs.length ||
          command.inputs.some(input => !repoPath(input?.path) || !/^[a-f0-9]{64}$/.test(input.sha256)) ||
          discovery?.executed !== false || discovery.runtimeClosure !== "unmeasured" ||
          discovery.operationalAcceptance !== false || !isDeepStrictEqual(discovery.inputs, command.inputs) ||
          !Array.isArray(discoveryFiles) || discoveryFiles.some(file => !repoPath(file)) ||
          new Set(discoveryFiles).size !== discoveryFiles.length ||
          discoveryFiles.some(file => !command.inputs.some(input => input.path === file)) ||
          (discovery.files !== undefined && discovery.repositoryFiles !== undefined &&
            !isDeepStrictEqual(discovery.files, discovery.repositoryFiles)))
        return refused("command-inputs-unmeasured");
      if (command.kind === "command-check" &&
          (command.command !== (entry.resolvedCommand ?? entry.command) ||
          !isDeepStrictEqual([...discoveryFiles].sort(), [...entry.files].sort())))
        return refused("command-selection-mismatch");
      if (command.kind === "npm-lifecycle" && (!Array.isArray(entry.lifecycleCommands) ||
          !entry.lifecycleCommands.some(step => step.script === command.script && step.command === command.command)))
        return refused("command-selection-mismatch");
      try {
        if (command.inputs.some(input => createHash("sha256").update(readFileSync(resolve(root, input.path)))
          .digest("hex") !== input.sha256)) return refused("command-inputs-changed");
      } catch { return refused("command-inputs-unreadable"); }
      units.push({ id: `command:${id}:${index}`, kind: "guard",
        path: task.dir === "." ? "package.json" : `${task.dir}/package.json` });
    }
    if (entry.runner === "vitest" && (!validNativeSpecifications(entry.selectedSpecifications) ||
        entry.selectedSpecifications.length !== entry.files.length ||
        new Set(entry.selectedSpecifications.map(value => value?.testFile)).size !== entry.files.length ||
        entry.selectedSpecifications.some(value => !entry.files.includes(value?.testFile))))
      return refused("native-specifications-unmeasured");
    // Astro's file census names check inputs. It must never become a population
    // of native tests or overlap a Vitest task that executes those same sources.
    for (const file of entry.runner === "astro-check" ? [] : entry.files) {
      if (!repoPath(file) || testPaths.has(file)) return refused("test-population-overlapping-or-invalid");
      testPaths.add(file);
      units.push({ id: `test:${file}`, kind: "test", path: file });
    }
  }
  if ([...entries.keys(), ...selection.unenumerated.map(value => value.task),
    ...selection.commandObligations.map(value => value.task)].some(id => !ids.has(id)))
    return refused("foreign-task-selection");
  for (const unit of postSuite.units) {
    if (!validIdentity(unit?.id) || !repoPath(unit.path) || unit.kind !== "post-suite" ||
        unit.exclusion !== undefined) return refused("post-suite-population-invalid");
    units.push({ id: unit.id, kind: "post-suite", path: unit.path });
  }
  if (!Array.isArray(exclusions)) return refused("exclusion-population-invalid");
  const excluded = new Set();
  for (const exclusion of exclusions) {
    const unit = units.find(value => value.id === exclusion?.unitId);
    if (!unit || excluded.has(unit.id) || !validIdentity(exclusion.reason) || !validIdentity(exclusion.policyRef))
      return refused("exclusion-population-invalid");
    excluded.add(unit.id);
    unit.exclusion = { reason: exclusion.reason, policyRef: exclusion.policyRef };
  }
  const manifest = continuationManifest({ schemaVersion: 1, units });
  if (!manifest) return refused("manifest-population-invalid");
  return { status: "ready", reason: null, manifest: { schemaVersion: 1, units: manifest }, operationalAcceptance: false };
}

/**
 * Grade the existing checkpoint's full, independently selected population. The caller
 * must own the existing qualification runner before executing `run`; this pure read
 * neither acquires custody nor authorizes a stale runner to write a checkpoint.
 *
 * Native receipts are retained even when they cannot establish a reusable pass. Reuse
 * delegates to the maintained source/input/context/runner validator. A retained failure
 * is never silently retried: the qualification's explicit retry policy must admit it.
 *
 * Evidence contract: `current` counts only within the independently authenticated
 * physical execution, even when runtime read closure is unmeasured. `reused` may
 * skip a unit in a replacement execution only after complete reuse validation.
 * `evidenceScopes` exposes that distinction per counted unit; its labels are not
 * capabilities, cannot be replayed, and never change the receipt's closure proof.
 */
export function evaluatePartialTaskContinuation(checkpoint, expected, options = {}) {
  const refused = reason => ({ status: "refused", reason, verdict: "incomplete", run: [], reused: [], current: [], evidenceScopes: [],
    excluded: [], retainedFailures: [], infrastructure: [], invalidated: [] });
  const stored = checkpoint?.continuation;
  if (stored?.schemaVersion !== 1) return refused("continuation-unmeasured");
  for (const key of ["attemptId", "candidate", "repairHead"]) {
    if ((key !== "repairHead" && !validIdentity(expected?.[key])) ||
        (key === "repairHead" && expected?.[key] !== null && !validIdentity(expected?.[key])) ||
        stored[key] !== expected[key]) return refused(`${key}-mismatch`);
  }
  if (checkpoint.root !== expected.root || checkpoint.taskKey !== expected.taskKey)
    return refused("task-identity-mismatch");
  if (![expected.sourceCommit, expected.runContext, expected.runnerIdentity].every(validIdentity))
    return refused("execution-identity-unmeasured");
  const units = continuationManifest(expected.manifest);
  const prior = continuationManifest(stored.manifest);
  if (!units || !prior || JSON.stringify(units) !== JSON.stringify(prior)) return refused("manifest-mismatch");
  if (!Array.isArray(stored.receipts)) return refused("receipts-unmeasured");
  const selected = new Map(units.map(unit => [unit.id, unit]));
  const receipts = new Map();
  const completionIds = new Set();
  for (const receipt of stored.receipts) {
    if (!selected.has(receipt?.unitId) || receipts.has(receipt.unitId) ||
        !validIdentity(receipt.completionId) || completionIds.has(receipt.completionId) ||
        !Number.isSafeInteger(receipt.observedAtMs) ||
        receipt.observedAtMs <= 0 || !["pass", "fail", "infra"].includes(receipt.state))
      return refused("receipt-population-invalid");
    receipts.set(receipt.unitId, receipt);
    completionIds.add(receipt.completionId);
  }
  const run = [], reused = [], current = [], excluded = [], retainedFailures = [], infrastructure = [], invalidated = [];
  const identity = currentIdentity(expected);
  const authenticated = new Map();
  for (const capability of Array.isArray(options.currentEvidence) ? options.currentEvidence : []) {
    const evidence = capability && typeof capability === "object" ? currentOutcomeEvidence.get(capability) : undefined;
    if (evidence && identity && isDeepStrictEqual(evidence.identity, identity))
      authenticated.set(evidence.receipt.unitId, evidence.receipt);
  }
  if (expected.retryStates !== undefined && !Array.isArray(expected.retryStates)) return refused("retry-policy-invalid");
  const retries = new Set(expected.retryStates ?? []);
  if ([...retries].some(state => !["fail", "infra"].includes(state))) return refused("retry-policy-invalid");
  for (const unit of units) {
    if (unit.exclusion) { excluded.push(unit.id); continue; }
    const receipt = receipts.get(unit.id);
    if (!receipt) { run.push(unit.id); continue; }
    if (receipt.state !== "pass") {
      (receipt.state === "fail" ? retainedFailures : infrastructure).push(unit.id);
      if (retries.has(receipt.state)) run.push(unit.id);
      continue;
    }
    // Authenticate current outcomes BEFORE and independently of reuse. Never
    // reinterpret a rejected retained proof as evidence of current execution.
    if (isDeepStrictEqual(authenticated.get(unit.id), receipt)) {
      current.push(unit.id);
      continue;
    }
    let selection;
    if (receipt.worktreeDirty === false && Number.isSafeInteger(receipt.observedCount) && receipt.observedCount > 0 &&
        (unit.kind !== "test" || receipt.firstAttemptVerdict === "pass")) {
      try {
        selection = selectReusablePasses({ ...options, auditRate: 0,
          candidates: [unit.path], proofs: new Map([[unit.path, receipt.proof]]),
          judgedSha: expected.sourceCommit, runContext: expected.runContext,
          runnerIdentity: expected.runnerIdentity });
      } catch { /* Missing drift/input evidence never permits a skip. */ }
    }
    if (selection?.skip.includes(unit.path)) reused.push(unit.id);
    else {
      run.push(unit.id);
      invalidated.push({ id: unit.id, reason: "pass-proof-invalid-or-unmeasured" });
    }
  }
  const required = units.length - excluded.length;
  const verdict = retainedFailures.length ? "red" :
    required > 0 && reused.length + current.length === required ? "green" : "incomplete";
  return { status: "ready", reason: null, verdict, run, reused, current, excluded,
    evidenceScopes: [
      ...current.map(unitId => ({ unitId, scope: "current-execution" })),
      ...reused.map(unitId => ({ unitId, scope: "reusable" })),
    ],
    retainedFailures, infrastructure, invalidated,
    counts: { selected: units.length, required, excluded: excluded.length,
      passed: reused.length + current.length, failed: retainedFailures.length, infrastructure: infrastructure.length,
      pending: run.filter(id => !retainedFailures.includes(id) && !infrastructure.includes(id)).length } };
}

/** Project eligible work onto the ORIGINAL task inventory. Rebuild the full manifest
 * before narrowing; neither saved outcomes nor the narrowed native producer selects
 * the required population. Atomic commands are never split into synthetic leaf runs.
 * This grants no custody, records no completion and cannot establish a green verdict.
 */
export function preparePartialRemainingSelection(checkpoint, expected, { selection, postSuite }, options = {}) {
  const refused = reason => ({ status: "refused", reason, tasks: [], omitted: [], evaluation: null });
  const prepared = preparePartialContinuationManifest({ root: expected.root,
    tasks: selection?.taskInventory, selection, postSuite,
    exclusions: expected.manifest?.units?.filter(unit => unit.exclusion)
      .map(unit => ({ unitId: unit.id, ...unit.exclusion })) });
  if (prepared.status !== "ready") return refused(`selection-${prepared.reason}`);
  if (!isDeepStrictEqual(prepared.manifest, expected.manifest)) return refused("selection-manifest-mismatch");
  // Selection is permission to omit execution in a new invocation. Current-only
  // evidence must never travel through this retained-work skip path.
  const evaluation = evaluatePartialTaskContinuation(checkpoint, expected, { ...options, currentEvidence: [] });
  if (evaluation.status !== "ready") return refused(`eligibility-${evaluation.reason}`);
  const run = new Set(evaluation.run);
  if ([...evaluation.retainedFailures, ...evaluation.infrastructure].some(id => !run.has(id)))
    return refused("retained-terminal-outcome");
  const tasks = [], omitted = [];
  for (const task of selection.taskInventory) {
    const entry = selection.tasks.find(entry => entry.id === task.id);
    const part = preparePartialContinuationManifest({ root: expected.root, tasks: [task], postSuite,
      selection: { ...selection, tasks: entry ? [entry] : [],
        unenumerated: selection.unenumerated.filter(row => row.task === task.id),
        commandObligations: selection.commandObligations.filter(row => row.task === task.id) } });
    if (part.status !== "ready") return refused(`task-${part.reason}`);
    const units = part.manifest.units.filter(unit => unit.kind !== "post-suite");
    const remaining = units.filter(unit => run.has(unit.id));
    if (!remaining.length) { omitted.push(task.id); continue; }
    if (entry?.runner === "vitest") {
      // npm hooks are inseparable from the original npm invocation. Never replay
      // a banked hook just to get to another file, or silently drop an owed hook.
      if (units.some(unit => unit.kind !== "test" && !run.has(unit.id)))
        return refused("atomic-command-partially-complete");
      const files = entry.files.filter(file => run.has(`test:${file}`));
      if (!files.length && !(scriptUsesPassWithNoTests(entry.command) && scriptSupportsPassReuse(entry.command)))
        return refused("native-empty-selection-with-command-work");
      const selectedSpecifications = entry.selectedSpecifications.filter(spec => files.includes(spec.testFile));
      tasks.push({ ...structuredClone(entry), files, selectedSpecifications });
    } else if (entry?.runner === "command-chain" && remaining.length !== units.length) {
      // Keep npm's original command and every unbanked command/lifecycle guard.
      // Empty steps retain their original command. Only scripts that already
      // tolerate an empty suite can execute without re-running banked files.
      if (units.some(unit => unit.kind !== "test" && !run.has(unit.id)))
        return refused("atomic-command-partially-complete");
      const narrowed = structuredClone(entry);
      for (const step of narrowed.steps) {
        if (step.lifecycle === true) continue;
        const leaf = step.discovery[0];
        if (leaf.runner !== "vitest") {
          if (step.files.some(file => !run.has(`test:${file}`)))
            return refused("atomic-task-partially-complete");
          continue;
        }
        const files = step.files.filter(file => run.has(`test:${file}`));
        if (!files.length && !(scriptUsesPassWithNoTests(step.command) && scriptSupportsPassReuse(step.command)))
          return refused("native-empty-selection-with-command-work");
        step.files = files;
        leaf.files = files.slice();
        leaf.selectedSpecifications = leaf.selectedSpecifications.filter(spec => files.includes(spec.testFile));
      }
      narrowed.files = entry.files.filter(file => run.has(`test:${file}`));
      tasks.push(narrowed);
    } else {
      if (remaining.length !== units.length) return refused("atomic-task-partially-complete");
      tasks.push(structuredClone(entry ?? { ...task, files: [] }));
    }
  }
  return { status: "ready", reason: null, tasks, omitted, evaluation };
}

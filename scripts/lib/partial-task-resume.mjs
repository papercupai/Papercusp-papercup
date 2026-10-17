// Durable, fail-closed checkpoints for a task that reached the parent watchdog
// before its complete test-file set finished. This is deliberately separate from
// passing-task reuse: a partial run is never a pass proof and never enters the
// passing-verdict cache.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export const PARTIAL_TASK_CHECKPOINT_SCHEMA = 1;
export const PARTIAL_TASK_SKIP_LIST_SCHEMA = 1;

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
  if (!validIdentity(parsed.root) || !validIdentity(parsed.taskKey) ||
      !validIdentity(parsed.sourceCommit) || !validIdentity(parsed.sourceDigest)) return null;
  if (!validFileList(parsed.selectedFiles) || !validFileList(parsed.passedFiles)) return null;
  if (parsed.state !== "partial" && parsed.state !== "complete") return null;
  if (expected && (parsed.root !== expected.root || parsed.taskKey !== expected.taskKey ||
      parsed.sourceCommit !== expected.sourceCommit || parsed.sourceDigest !== expected.sourceDigest)) {
    return null;
  }
  const selectedFiles = [...new Set(parsed.selectedFiles)].sort();
  const selected = new Set(selectedFiles);
  const passedFiles = [...new Set(parsed.passedFiles)].filter((file) => selected.has(file)).sort();
  return { ...parsed, selectedFiles, passedFiles };
}

export function writePartialTaskCheckpointAtomic(file, checkpoint) {
  const body = JSON.stringify({
    schemaVersion: PARTIAL_TASK_CHECKPOINT_SCHEMA,
    root: checkpoint.root,
    taskKey: checkpoint.taskKey,
    sourceCommit: checkpoint.sourceCommit,
    sourceDigest: checkpoint.sourceDigest,
    selectedFiles: [...new Set(checkpoint.selectedFiles ?? [])].sort(),
    passedFiles: [...new Set(checkpoint.passedFiles ?? [])].sort(),
    state: checkpoint.state === "complete" ? "complete" : "partial",
    updatedAt: checkpoint.updatedAt ?? new Date().toISOString(),
  });
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

import { chmodSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createControlPlaneTempDirWithFile } from '../control-plane-temp.mjs';

// Free-form first-turn transport only; managed session-port files keep their
// separate authority/hash protocol. Share this plain ESM seam with the Node PSU.
export const KICKOFF_PROMPT_FILE_ENV = 'PAPERCUSP_KICKOFF_PROMPT_FILE';
export const INLINE_KICKOFF_MAX_BYTES = 16 * 1024;
const PREFIX = 'papercusp-kickoff-transport-';
const FILENAME = 'prompt.txt';
const CLEANUP_MS = 10 * 60 * 1000;
const cleanupTimers = new Map();

/** Keep large prompts out of both the shell argv and its inherited environment. */
export function prepareKickoffEnvironment(env) {
  const text = env?.PAPERCUSP_KICKOFF_PROMPT;
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') <= INLINE_KICKOFF_MAX_BYTES) return env;
  const directory = realpathSync(createControlPlaneTempDirWithFile(PREFIX, FILENAME, text, 'payload'));
  const path = join(directory, FILENAME);
  try {
    chmodSync(directory, 0o700);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  // The consumer removes it immediately. Bound debris from a launch that never
  // reaches PSU without racing the launcher's admission/boot window.
  const timer = setTimeout(() => {
    cleanupTimers.delete(directory);
    try { rmSync(directory, { recursive: true, force: true }); }
    catch (error) { console.warn('kickoff transport cleanup failed:', error); }
  }, CLEANUP_MS);
  timer.unref?.();
  cleanupTimers.set(directory, timer);
  const next = { ...env, [KICKOFF_PROMPT_FILE_ENV]: path };
  delete next.PAPERCUSP_KICKOFF_PROMPT;
  return next;
}

/** Consume only our private regular-file envelope; a missing file fails loudly. */
export function consumeKickoffPromptFile(path) {
  if (typeof path !== 'string' || !path) return null;
  const absolute = resolve(path);
  const directory = dirname(absolute);
  const file = lstatSync(absolute);
  const parent = lstatSync(directory);
  if (basename(absolute) !== FILENAME || !basename(directory).startsWith(PREFIX) ||
      file.isSymbolicLink() || !file.isFile() || parent.isSymbolicLink() || !parent.isDirectory() ||
      realpathSync(absolute) !== absolute || (file.mode & 0o077) !== 0 || (parent.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && (file.uid !== process.getuid() || parent.uid !== process.getuid()))) {
    throw new Error('Invalid private kickoff prompt transport file');
  }
  const text = readFileSync(absolute, 'utf8');
  const cleanupTimer = cleanupTimers.get(directory);
  if (cleanupTimer) {
    clearTimeout(cleanupTimer);
    cleanupTimers.delete(directory);
  }
  rmSync(directory, { recursive: true, force: true });
  return text;
}

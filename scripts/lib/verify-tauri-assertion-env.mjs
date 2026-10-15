#!/usr/bin/env node
// Pure preflight for a file-backed verifier assertion. Read its declared
// assignments; never source the assertion before the owned Tauri rig exists.
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const [assertionPath, manifestPath] = process.argv.slice(2);
const fail = (reason) => {
  console.error(`VERIFY_TAURI_ASSERTION_ENV_INVALID ${reason}`);
  process.exit(2);
};

// File-backed assertions can declare inherited prerequisites without sourcing
// shell code or embedding credentials in an immutable diagnostic manifest.
// Inspect command arguments too: `node --import tsx driver.mts` is not a shell
// assertion, but its prerequisites must be checked before native preparation.
if (assertionPath === '--command') {
  const required = new Set();
  for (const argument of process.argv.slice(3)) {
    let header;
    let descriptor;
    try {
      if (!statSync(argument).isFile()) continue;
      // Commands include executables and data files; read only a bounded header.
      descriptor = openSync(argument, 'r');
      const bytes = Buffer.alloc(8192);
      const length = readSync(descriptor, bytes, 0, bytes.length, 0);
      header = bytes.subarray(0, length).toString('utf8').split(/\r?\n/).slice(0, 12);
    } catch { continue; }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
    for (const line of header) {
      const declaration = line.match(/^(?:#|\/\/) VERIFY_TAURI_ASSERTION_REQUIRED_ENV=(.*)$/);
      if (!declaration) continue;
      for (const key of declaration[1].split(',')) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(key)) fail('invalid required environment name');
        if (!process.env[key]?.trim()) fail(`${key} is required before verifier preparation`);
        required.add(key);
      }
    }
  }
  if (required.size) console.log(`VERIFY_TAURI_ASSERTION_ENV_OK ${required.size} prerequisite(s)`);
  process.exit(0);
}

if (!assertionPath || !manifestPath) fail('assertion and manifest paths are required');
let source;
let manifest;
try {
  source = readFileSync(assertionPath, 'utf8');
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch {
  fail('assertion or manifest could not be read');
}

const expected = manifest?.diagnosticEnv;
if (!expected || typeof expected !== 'object' || Array.isArray(expected) ||
    Object.keys(expected).length === 0) fail('manifest diagnosticEnv is missing');
if (typeof manifest.assertionSha256 !== 'string' ||
    createHash('sha256').update(source).digest('hex') !== manifest.assertionSha256) {
  fail('assertion bytes disagree with manifest assertionSha256');
}

// Heredoc bodies belong to the command they feed, not to the shell's own
// environment. In particular, a Python `D=Path(...)` must not replace a
// preceding shell `D=/...` used by a manifest binding.
const assignments = new Map();
const heredocs = [];
for (const line of source.split(/\r?\n/)) {
  if (heredocs.length > 0) {
    const next = heredocs[0];
    if ((next.stripTabs ? line.replace(/^\t+/, '') : line) === next.delimiter) {
      heredocs.shift();
    }
    continue;
  }
  const match = line.match(/^(?:export[ \t]+)?([A-Z][A-Z0-9_]*)=(.*)$/);
  if (match) {
    const [, key, value] = match;
    if (assignments.has(key) && Object.hasOwn(expected, key)) fail(`${key} is assigned more than once`);
    assignments.set(key, value);
  }
  for (const opener of line.matchAll(/(?:^|[ \t])<<(-?)(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/g)) {
    heredocs.push({ stripTabs: opener[1] === '-', delimiter: opener[2] ?? opener[3] ?? opener[4] });
  }
}

const visiting = new Set();
const resolved = new Map();
function resolve(key) {
  if (resolved.has(key)) return resolved.get(key);
  if (!assignments.has(key)) fail(`${key} is not assigned by the assertion`);
  if (visiting.has(key)) fail(`${key} has a circular assignment`);
  visiting.add(key);
  const raw = assignments.get(key);
  let value;
  if (/^'[^']*'$/.test(raw)) {
    value = raw.slice(1, -1);
  } else if (/^"[^"`\\]*"$/.test(raw)) {
    value = raw.slice(1, -1).replace(/\$(?:\{([A-Z][A-Z0-9_]*)\}|([A-Z][A-Z0-9_]*))/g,
      (_, braced, plain) => resolve(braced ?? plain));
    if (value.includes('$')) fail(`${key} uses an unsupported shell expression`);
  } else if (/^[A-Za-z0-9_./:,%+@=-]*$/.test(raw)) {
    value = raw;
  } else {
    fail(`${key} uses an unsupported shell expression`);
  }
  visiting.delete(key);
  resolved.set(key, value);
  return value;
}

for (const [key, claimed] of Object.entries(expected)) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof claimed !== 'string') {
    fail('manifest diagnosticEnv must contain string environment entries');
  }
  if (resolve(key) !== claimed) fail(`${key} differs from manifest diagnosticEnv`);
}
if (Object.hasOwn(expected, 'GST_DEBUG_FILE') && manifest.diagnosticLogRoot &&
    dirname(expected.GST_DEBUG_FILE) !== manifest.diagnosticLogRoot) {
  fail('GST_DEBUG_FILE parent differs from manifest diagnosticLogRoot');
}
console.log(`VERIFY_TAURI_ASSERTION_ENV_OK ${Object.keys(expected).length} binding(s)`);

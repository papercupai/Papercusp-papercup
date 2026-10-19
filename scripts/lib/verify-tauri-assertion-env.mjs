#!/usr/bin/env node
// Pure preflight for a file-backed verifier assertion. Read its declared
// assignments; never source the assertion before the owned Tauri rig exists.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, dirname, posix, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const args = process.argv.slice(3);
  const shellCommandIndex = ['bash', 'sh', 'dash'].includes(basename(args[0] ?? ''))
    ? args.findIndex((arg, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(arg)) : -1;
  const shell = shellCommandIndex > 0;
  const command = shell ? args[shellCommandIndex + 1] ?? '' : args.join(' ');
  const sourceFailure = () => fail('Playwright assertions must use the effective owned OPERATOR_SOURCE_ROOT: use bash -c with cd "$OPERATOR_SOURCE_ROOT/apps/operator" and an owned --config; only literal cd commands joined by && are supported before playwright test');
  // Recognize alternate CLI spellings before applying the supported grammar.
  // Otherwise an absolute executable, package alias/version, or node cli.js
  // silently bypasses the source check instead of being refused before boot.
  const isPlaywrightCli = word => typeof word === 'string' && (
    /^(?:playwright(?:-core)?|@playwright\/test)(?:@[^/]+)?$/.test(word) ||
    /\/(?:playwright(?:-core)?)(?:\.cmd)?$/.test(word) ||
    /(?:^|\/)(?:playwright(?:-core)?|@playwright\/test)\/cli\.[cm]?js$/.test(word));
  const hasPlaywrightTest = words => words.some((word, i) => isPlaywrightCli(word) && words[i + 1] === 'test');
  if (!shell) {
    if (hasPlaywrightTest(args)) sourceFailure();
  } else {
    // shell-quote treats a comment as lasting to the end of its input. Do not
    // let a leading comment hide a later unsupported multiline invocation.
    if (/[\r\n]/.test(command) && /\bplaywright\b/.test(command)) sourceFailure();
    // Parse quoting without executing shell code or expanding the real root
    // before boot. A fresh marker distinguishes expansion from literal text.
    const ownedRoot = `/__verify_owned_source_${randomUUID()}`;
    let tokens;
    try {
      const { default: parse } = await import('shell-quote/parse.js');
      tokens = parse(command, key => key === 'OPERATOR_SOURCE_ROOT' ? ownedRoot : { unresolved: key })
        .filter(token => !(token && typeof token === 'object' && 'comment' in token));
    } catch {
      fail('OPERATOR_SOURCE_ROOT command preflight requires an installed shell-quote parser and valid shell quoting');
    }
    if (hasPlaywrightTest(tokens)) {
      // This is a deliberately small, verifiable command grammar. Branches,
      // substitutions and arbitrary shell builtins can change cwd or the root.
      if (/[\r\n`]|\$\(/.test(command)) sourceFailure();
      const commands = [[]];
      for (const token of tokens) {
        if (typeof token === 'string') commands.at(-1).push(token);
        else if (token.op === '&&') commands.push([]);
        else sourceFailure();
      }
      let cwd = null;
      const resolvePath = path => posix.isAbsolute(path) ? posix.normalize(path)
        : cwd === null ? null : posix.resolve(cwd, path);
      const isOwned = path => path !== null && (path === ownedRoot || path.startsWith(`${ownedRoot}/`));
      for (const words of commands) {
        if (words[0] === 'cd') {
          const path = words[1] === '--' && words.length === 3 ? words[2]
            : words.length === 2 ? words[1] : null;
          if (path === null || path === '-') sourceFailure();
          cwd = resolvePath(path);
          continue;
        }
        const start = words[0] === 'playwright' ? 0
          : words[0] === 'npx' ? 1
            : ['npm', 'pnpm'].includes(words[0]) && words[1] === 'exec' ? 2 : -1;
        if (start < 0 || words[start] !== 'playwright' || words[start + 1] !== 'test') sourceFailure();
        const configs = [];
        for (let i = start + 2; i < words.length; i++) {
          const word = words[i];
          if (word === '--config' || word === '-c') {
            if (!words[i + 1] || words[i + 1].startsWith('-')) sourceFailure();
            configs.push(words[++i]);
          } else if (word.startsWith('--config=')) configs.push(word.slice('--config='.length));
          else if (word.startsWith('-c') && !word.startsWith('--')) configs.push(word.slice(2).replace(/^=/, ''));
        }
        // Every explicit config must resolve inside the owned tree, even when
        // an earlier cd was pinned. Without a config the effective cwd decides.
        if (configs.length ? configs.some(path => !path || !isOwned(resolvePath(path))) : !isOwned(cwd)) sourceFailure();
      }
    }
  }
  const required = new Set();
  // The live profile is already the runtime config's prerequisite contract.
  // Check it before copying dependencies/building the native app, rather than
  // discovering a missing caller identity only when Vitest collects tests.
  if (process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE) {
    let profile;
    try {
      const root = process.env.PAPERCUSP_REPO_DIR ?? fileURLToPath(new URL('../..', import.meta.url));
      profile = JSON.parse(readFileSync(resolvePath(root,
        process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE), 'utf8'));
    } catch { fail('live profile could not be read'); }
    const names = value => {
      if (!Array.isArray(value) || value.some(name => typeof name !== 'string'
        || !/^[A-Z][A-Z0-9_]*$/.test(name))) fail('live profile has invalid required environment names');
      return value;
    };
    const selected = [...names(profile?.requiredEnv ?? [])];
    const conditional = profile?.requiredEnvWhen ?? [];
    if (!Array.isArray(conditional)) fail('live profile has invalid conditional environment rules');
    for (const rule of conditional) {
      if (!rule || typeof rule !== 'object' || typeof rule.equals !== 'string')
        fail('live profile has invalid conditional environment rules');
      const [flag] = names([rule.env]);
      const dependent = names(rule.requiredEnv);
      if (process.env[flag] === rule.equals) selected.push(...dependent);
    }
    // These values are generated and exported by the maintained isolated-DB
    // verifier before assertion execution. Caller identity/ledger inputs still
    // have to exist now; a ledger workspace cannot replace the app workspace.
    const generated = process.env.VERIFY_TAURI_ISOLATED_DB === '1' ? new Set([
      'PAPERCUSP_HOME', 'PAPERCUSP_SU_CODEX_HOMES_DIR', 'PAPERCUSP_WORKSPACE',
      'PAPERCUSP_WORKSPACE_ID', 'PAPERCUSP_WORKSPACES_ROOT', 'HARNESS_ADMIN_DATABASE_URL',
      'HARNESS_DATABASE_URL', 'PAPERCUSP_PG_PORT', 'PAPERCUSP_SKIP_PG_DISCOVERY',
      'PAPERCUSP_VERIFY_TAURI_ISOLATED',
    ]) : new Set();
    for (const key of new Set(selected)) {
      if (generated.has(key)) continue;
      if (!process.env[key]?.trim()) fail(`${key} is required before verifier preparation (live profile)`);
      required.add(key);
    }
  }
  for (const argument of args) {
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

/**
 * WI-10006617 — CLASS guard: no in-process code may build the superuser-token
 * path by hand. The operator VALIDATES bearers against
 * `$PAPERCUSP_HOME/superuser-token` (superuser-token.ts); a reader that
 * hard-codes `homedir()/.papercusp/superuser-token` presents a different
 * bearer whenever a scoped home is set (an isolated verify-tauri-headless
 * sidecar), and its spawned agent gets `superuser_invalid_bearer`.
 *
 * WI-10004357 fixed two such readers by hand and left no guard; 12 more were
 * still in the tree. Read the token with `readSuperuserToken()` and name the
 * path with `superuserTokenPath()`, both from `./superuser-token`.
 *
 * Subject = the SOURCE TREE (every non-test .ts under packages/operator-core/lib).
 * Comments are stripped before matching (prose may name the path); string
 * literals are KEPT, because the offending path lives inside them.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripCommentsOnly } from '../../../scripts/lib/strip-comments-and-strings.mjs';

const LIB_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(LIB_ROOT, '..', '..', '..');

/** `join(…, '.papercusp', 'superuser-token')` or a literal `…/.papercusp/superuser-token`. */
const HAND_BUILT_TOKEN_PATH = [
  /['"`]\.papercusp['"`]\s*,\s*['"`]superuser-token['"`]/,
  /\.papercusp\/superuser-token/,
];

/** Files that legitimately carry the literal — each must STILL match (stale entries fail). */
const ALLOWLIST: Record<string, string> = {
  'packages/operator-core/lib/p2p/sandbox/os-user-isolation.ts':
    'a sandbox DENY-list naming the real-home path to block, not a reader of the token',
};

export function handBuiltTokenPathHits(source: string, fileName: string): number[] {
  const code = stripCommentsOnly(source, fileName) as string;
  const lines = code.split('\n');
  const hits: number[] = [];
  lines.forEach((line, i) => {
    if (HAND_BUILT_TOKEN_PATH.some((re) => re.test(line))) hits.push(i + 1);
  });
  return hits;
}

function sourceFiles(): string[] {
  return (readdirSync(LIB_ROOT, { recursive: true }) as string[])
    .filter((p) => /\.(ts|mts|tsx)$/.test(p))
    .filter((p) => !/(^|\/)(node_modules|\.vitest-tmp|dist|__tests__)\//.test(p))
    .filter((p) => !/\.(test|spec)\.(ts|mts|tsx)$/.test(p))
    .map((p) => join(LIB_ROOT, p));
}

describe('detector calibration (in-memory, so the controls cannot rot)', () => {
  it('flags a hard-coded join and a hard-coded template path', () => {
    expect(handBuiltTokenPathHits("const p = join(homedir(), '.papercusp', 'superuser-token');", 'x.ts')).toEqual([1]);
    expect(handBuiltTokenPathHits('const p = `${os.homedir()}/.papercusp/superuser-token`;', 'x.ts')).toEqual([1]);
  });

  it('does not flag the resolver shape or prose in a comment', () => {
    const resolver = "return join(process.env.PAPERCUSP_HOME || join(homedir(), '.papercusp'), 'superuser-token');";
    expect(handBuiltTokenPathHits(resolver, 'x.ts')).toEqual([]);
    expect(handBuiltTokenPathHits('// reads ~/.papercusp/superuser-token\nconst a = 1;', 'x.ts')).toEqual([]);
  });
});

describe('no hand-built superuser-token path in packages/operator-core/lib', () => {
  const files = sourceFiles();

  it('scans the real tree (positive control on the population)', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain(join(LIB_ROOT, 'superuser-token.ts'));
  });

  it('every reader goes through superuser-token.ts', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(REPO_ROOT, file);
      if (rel in ALLOWLIST) continue;
      for (const line of handBuiltTokenPathHits(readFileSync(file, 'utf8'), file)) {
        offenders.push(`${rel}:${line}`);
      }
    }
    expect(
      offenders,
      'Hand-built superuser-token path(s). Use readSuperuserToken() / superuserTokenPath() from ' +
        'packages/operator-core/lib/superuser-token.ts so PAPERCUSP_HOME is honoured (WI-10006617).',
    ).toEqual([]);
  });

  it('every allowlist entry still matches (no stale exemptions)', () => {
    for (const rel of Object.keys(ALLOWLIST)) {
      const hits = handBuiltTokenPathHits(readFileSync(join(REPO_ROOT, rel), 'utf8'), rel);
      expect(hits.length, `${rel} no longer carries the literal; drop it from ALLOWLIST`).toBeGreaterThan(0);
    }
  });
});

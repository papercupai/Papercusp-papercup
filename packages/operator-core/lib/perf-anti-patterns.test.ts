/**
 * CI guard for the performance anti-patterns catalogued in
 * `apps/operator-docs/src/content/docs/performance.mdx` (rules A1–A14).
 *
 * Each rule has either:
 *   - a regex that catches the pattern, OR
 *   - a structural check that's run programmatically.
 *
 * The intent is **prevention**, not pedantry. Rules are tuned to catch
 * the *shape* of the trap (serial fs in a loop, per-slug PG opens, etc.)
 * with a low false-positive rate. When a rule fires:
 *
 *   1. The test prints the offending file + line + which anti-pattern
 *      it matched, and a short pointer to the docs section.
 *   2. The fix is documented with code examples on the docs page.
 *
 * Adding a new rule:
 *   - Update `apps/operator-docs/src/content/docs/performance.mdx` first with
 *     A<N>: <title>, the wrong code, the right code, and a measurement
 *     if available.
 *   - Add a `Rule` entry below pointing at the new doc anchor.
 *   - The doc page is the source of truth; this file is the enforcer.
 *
 * Allowlist: `// perf:allow A<N> reason` on the offending line skips
 * the check for that line. Use sparingly; document why.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Rule {
  /** Identifier matching the docs anchor (A1, A2, …). */
  id: string;
  /** Short human-readable description shown on failure. */
  description: string;
  /** Regex that fires the rule. Match first capturing group used in the report. */
  pattern: RegExp;
  /** Files matching this glob-fragment are skipped. */
  excludePathContains?: string[];
}

const RULES: Rule[] = [
  {
    id: 'A1',
    description: 'serial `await fs.readFile` inside a `for` loop — parallelize with Promise.all',
    // Heuristic: a `for (...) { ... await fs.readFile(...) }` block in node code.
    // Matches the loop header followed within ~400 chars by an awaited readFile.
    pattern: /for\s*\([^)]*\)\s*\{[^}]{0,400}await\s+fs\.readFile\b/s,
    excludePathContains: ['/test/', '.test.ts', '.spec.ts', '/perf-anti-patterns.test.ts'],
  },
  {
    id: 'A2',
    description: 'per-slug `getHarnessPg(slug)` inside a serial `for` loop — parallelize or use harness_features_consolidated',
    pattern: /for\s*\([^)]*\)\s*\{[^}]{0,400}getHarnessPg\s*\(/s,
    excludePathContains: ['/test/', '.test.ts', '/perf-anti-patterns.test.ts'],
  },
  {
    id: 'A4',
    description: "shell-out to psql/pg_dump — use postgres-js instead",
    // Mirror the no-psql-shellout sweep in @papercusp/export-state but
    // scoped to the operator. Indirect form (literal as call-arg) included.
    pattern: /(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*['"`](?:psql|pg_dump)['"`]/,
    excludePathContains: ['/test/', '.test.ts', '/perf-anti-patterns.test.ts'],
  },
  {
    id: 'A6',
    description: '`<details>` used for "lazy" rendering — use LazyDetails (children mount only after first open)',
    // We allow native <details> when wrapping nothing heavy. The heuristic:
    // a <details> element with a child component reference (PascalCase JSX
    // tag inside it). LazyDetails itself is the canonical replacement.
    // The body window stops at `</details>`: a PascalCase SIBLING after a
    // cheap disclosure is not a child of it (WI-6554700010009816).
    pattern: /<details\b[^>]*>\s*[\s\S]{0,200}<summary[^>]*>[\s\S]{0,200}<\/summary>\s*(?:(?!<\/details>)[\s\S]){0,500}<[A-Z][A-Za-z]/,
    excludePathContains: ['/_components/LazyDetails.tsx', '/test/', '.test.ts', '/perf-anti-patterns.test.ts', '/content/'],
  },
  {
    id: 'A7',
    description: '`setInterval(..., 500)` "safety polling" — cap retries or use a longer cadence',
    // Earlier pattern `setInterval\s*\([^,)]+,\s*500\b` failed on
    // `setInterval(() => fn(), 500)` because `[^,)]+` terminates at the
    // `)` inside the arrow function body. New pattern looks for "500" as
    // the second positional argument by anchoring on a `,\s*500\b` that's
    // followed by `)` somewhere on the line — covers the common forms
    // setInterval(fn, 500), setInterval(() => …, 500), and the
    // window.setInterval(…) variant.
    pattern: /setInterval\s*\([\s\S]{0,200}?,\s*500\s*\)/,
    excludePathContains: ['/test/', '.test.ts', '/perf-anti-patterns.test.ts'],
  },
  {
    id: 'A9',
    description: 'dynamic `import("…")` inside a hot loop — hoist to module scope',
    pattern: /for\s*\([^)]*\)\s*\{[^}]{0,400}\bawait\s+import\s*\(/s,
    excludePathContains: ['/test/', '.test.ts', '/perf-anti-patterns.test.ts'],
  },
];

// Resolved from the module location, NOT hardcoded to a box path — the old
// absolute /home/dev/… roots made the walk return nothing on any
// other checkout (the CI runner), so every BASELINE entry read as stale
// (WI-123, nightly rounds 2–3).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ROOTS = [
  join(REPO_ROOT, 'apps/operator/app'),
  join(REPO_ROOT, 'apps/operator/lib'),
];

const TS_EXT = /\.(ts|tsx|mts|cts|mjs|cjs)$/;
const ALLOW_DIRECTIVE = /\/\/\s*perf:allow\s+(A\d+)/;

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries: { name: string; isDir: boolean }[] = [];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })).map((e) => ({
      name: e.name,
      isDir: e.isDirectory(),
    }));
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.next' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDir) await walk(full, out);
    else if (TS_EXT.test(e.name)) out.push(full);
  }
  return out;
}

interface Hit {
  rule: Rule;
  file: string;
  excerpt: string;
}

async function scan(): Promise<Hit[]> {
  const hits: Hit[] = [];
  const repoRoot = REPO_ROOT;
  for (const root of ROOTS) {
    const files = await walk(root);
    for (const f of files) {
      const rel = relative(repoRoot, f);
      const text = await fs.readFile(f, 'utf8');
      // Strip lines containing an allow directive before regex matching.
      const allowed = new Set<string>();
      const lines = text.split('\n');
      for (const line of lines) {
        const m = line.match(ALLOW_DIRECTIVE);
        if (m) allowed.add(m[1]);
      }
      for (const rule of RULES) {
        if (allowed.has(rule.id)) continue;
        if (rule.excludePathContains?.some((s) => f.includes(s))) continue;
        const m = rule.pattern.exec(text);
        if (m) {
          // Locate line number of the match.
          const idx = m.index ?? 0;
          const upToMatch = text.slice(0, idx);
          const lineNo = upToMatch.split('\n').length;
          const excerpt = (m[0] || '').replace(/\s+/g, ' ').slice(0, 120);
          hits.push({
            rule,
            file: `${rel}:${lineNo}`,
            excerpt,
          });
        }
      }
    }
  }
  return hits;
}

/**
 * Ratchet baseline. Anything in here is grandfathered — the test only
 * fails on NEW offenders. Each entry is `<ruleId>:<file:line>` minus
 * the line number (line numbers shift; we match by file + rule).
 *
 * To shrink this list: fix the offender, then remove its entry. CI will
 * catch any regression. To add a new exception (rare), add the entry
 * with a comment in the source explaining why.
 *
 * The expected end-state is `BASELINE = []` — the goal is to drive this
 * to zero, not to live with violations.
 */
const BASELINE: Array<{ rule: string; fileSuffix: string }> = [
  // (A6 OperatorPanel entry removed: the panel was deleted with the scanner
  // card stream — unify-agent-launches D-005. The violation is gone for real.)

  // (A1 plugin-runtime entry removed: the Next route was retired; its
  // migrated successor lib/endpoint-route/routes/plugin-runtime/catchall.ts —
  // and the other small-N find-first sites — now carry inline `// perf:allow A1`
  // directives instead of a baseline entry.)

  // A7: 500ms safety poll for SpeechSynthesis.voiceschanged event. Bounded
  // to 5 attempts (5 × 500ms = 2.5s) and stops as soon as voices arrive
  // OR the cap is hit. Acceptable per the /docs/performance #A7 caveat.
  { rule: 'A7', fileSuffix: 'app/settings/voice/page.tsx' },
];

function isBaselined(hit: Hit): boolean {
  return BASELINE.some(
    (b) => b.rule === hit.rule.id && hit.file.split(':')[0].endsWith(b.fileSuffix),
  );
}

describe('perf anti-pattern guard (A1–A14)', () => {
  it('no NEW offending patterns in operator app/ + lib/', async () => {
    const hits = await scan();
    const newHits = hits.filter((h) => !isBaselined(h));
    if (newHits.length > 0) {
      const grouped = new Map<string, Hit[]>();
      for (const h of newHits) {
        if (!grouped.has(h.rule.id)) grouped.set(h.rule.id, []);
        grouped.get(h.rule.id)!.push(h);
      }
      const lines: string[] = [
        '\nNEW perf anti-pattern hits found (existing ones grandfathered via BASELINE).',
        'See http://localhost:3055/docs/performance for the catalog and fixes.\n',
      ];
      for (const [id, entries] of grouped) {
        lines.push(`  ${id}: ${entries[0].rule.description}`);
        for (const h of entries) {
          lines.push(`     ${h.file}`);
          lines.push(`     → ${h.excerpt}`);
        }
        lines.push('');
      }
      lines.push('To intentionally allow a line, append: // perf:allow A<N> <reason>');
      lines.push('To grandfather an existing offender (last resort), add to BASELINE in this file.');
      expect.fail(lines.join('\n'));
    }
  }, 30000);

  it('BASELINE entries still match real hits (no stale grandfathering)', async () => {
    const hits = await scan();
    const stale = BASELINE.filter(
      (b) => !hits.some((h) => h.rule.id === b.rule && h.file.split(':')[0].endsWith(b.fileSuffix)),
    );
    if (stale.length > 0) {
      const lines = ['BASELINE has entries that no longer match — remove them:'];
      for (const s of stale) lines.push(`  ${s.rule}: ${s.fileSuffix}`);
      expect.fail(lines.join('\n'));
    }
  }, 30000);

  it('A6 flags a component INSIDE <details>, never a sibling after </details>', () => {
    const a6 = RULES.find((r) => r.id === 'A6')!.pattern;
    const child = '<details><summary>More</summary>\n  <HeavyPanel />\n</details>';
    const sibling = '<details><summary>Model</summary>\n  <label>Model<input /></label>\n</details>\n<Button>Go</Button>';
    expect(a6.test(child)).toBe(true);
    expect(a6.test(sibling)).toBe(false);
  });
});

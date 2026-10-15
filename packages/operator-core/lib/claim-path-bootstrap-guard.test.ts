/**
 * WI-10005130 recurrence guard — every hand-built claim-path integration fixture must
 * apply the shared claim-path read dependencies.
 *
 * Each claim door (claimNextWorkItem, claimIssue, getNextWorkItem, …) reads relations
 * beyond the base work-item tables: the trust list, the dependency table, the operation
 * worker claim binding (`adv_sessions`, which fails CLOSED when absent: every claim is
 * refused with "operation claim authority unavailable"), the event-await substrate and
 * the Scout idea ledger. Each was added to the claim path at a different time, and each
 * time every fixture that built its schema by hand went red. Integration files sit outside
 * the gate's affected radius, so nothing noticed until a sweep ran them.
 *
 * `applyClaimPathReadDeps` (test/_work-items-schema.ts) is the single list. This guard
 * fails an integration test under lib/ that calls a claim or delegated-task lifecycle
 * door AND builds its schema by hand (inline `CREATE TABLE` or the
 * `_work-items-schema` fixture) without calling it. Delegated creation/resolution
 * also emit/retire awaited events and seal their notifications against the privacy
 * ledger, so a base work-item table alone is insufficient.
 * Files that apply the real migration chain get the full schema and are exempt.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  stripCommentsAndStrings,
  stripCommentsOnly,
} from '../../../scripts/lib/strip-comments-and-strings.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);

const CLAIM_DOOR_RE =
  /\b(?:claimNextWorkItem|claimWorkItem|claimIssue|claimNextIssueWorkItem|getNextWorkItem|getNextForBee)\s*\(/;
const DELEGATED_LIFECYCLE_DOOR_RE = /\b(?:createDelegatedTask|resolveDelegatedTask)\s*\(/;
const HELPER_CALL_RE = /\bapplyClaimPathReadDeps\s*\(/;
const DISCLOSURE_LEDGER_HELPER_RE = /\bapplyDisclosureLedgerForTest\s*\(/;
const REAL_MIGRATIONS_RE = /\bapplyMigrationsForTest\s*\(/;
const INLINE_DDL_RE = /\bCREATE\s+TABLE\b/i;
const SCHEMA_FIXTURE_IMPORT_RE = /from\s+['"][^'"]*test\/_work-items-schema['"]/;

/**
 * Agent-tool modules whose handler calls a claim door. A test that imports one and calls
 * `tool.handler(...)` reaches the claim path without naming a door in its own source
 * (WI-10005225). Matched by RESOLVED path, not by specifier text: `./claim` also names
 * unrelated modules (harness/routines/claim, the pot-wake claim), so a bare specifier
 * match would over-flag.
 */
const CLAIM_TOOL_MODULES = [
  'agent-tools/work_items/claim',
  'agent-tools/work_items/claim_next',
  'agent-tools/plan-items/claim',
];
const STATIC_IMPORT_RE = /\bimport\s+(type\s+)?[^;'"]*?\bfrom\s*(['"])([^'"\n]+)\2/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;

/**
 * True when `commentless` (comments removed, strings kept, since specifiers are string
 * literals) imports a claim-tool module by value. Exported for the self-check below.
 */
export function importsClaimTool(commentless: string, fileName: string): boolean {
  const specifiers: string[] = [];
  for (const m of commentless.matchAll(STATIC_IMPORT_RE)) if (!m[1]) specifiers.push(m[3]);
  for (const m of commentless.matchAll(DYNAMIC_IMPORT_RE)) specifiers.push(m[2]);
  const dir = path.dirname(fileName);
  return specifiers.some((spec) => {
    if (!spec.startsWith('.')) return false;
    const resolved = path
      .resolve(dir, spec)
      .replace(/\.(?:[cm]?[jt]s)$/, '')
      .split(path.sep)
      .join('/');
    return CLAIM_TOOL_MODULES.some((mod) => resolved.endsWith(`/${mod}`));
  });
}

/**
 * Files that call a claim door with a hand-built schema but are known not to reach a
 * claim-path read dependency. Each entry needs a reason; remove it once the file calls
 * applyClaimPathReadDeps.
 */
const ALLOW: ReadonlyMap<string, string> = new Map<string, string>([]);

export type Classification =
  | { kind: 'not-claim-path' }
  | { kind: 'real-migrations' }
  | { kind: 'ok' }
  | { kind: 'violation' };

/** Classify one integration test source. Exported for the self-check below. */
export function classify(raw: string, fileName: string): Classification {
  // Calls and helper use: strings AND comments removed, so prose or a SQL literal that
  // names a door cannot count as a call.
  const code = stripCommentsAndStrings(raw, fileName) as string;
  // Schema building and import specifiers live inside string literals, so for those
  // only comments are removed.
  const commentless = stripCommentsOnly(raw, fileName) as string;
  const delegatedLifecycle = DELEGATED_LIFECYCLE_DOOR_RE.test(code);
  if (!CLAIM_DOOR_RE.test(code) && !delegatedLifecycle
    && !importsClaimTool(commentless, fileName)) {
    return { kind: 'not-claim-path' };
  }
  if (REAL_MIGRATIONS_RE.test(code)) return { kind: 'real-migrations' };
  if (HELPER_CALL_RE.test(code)
    && (!delegatedLifecycle || DISCLOSURE_LEDGER_HELPER_RE.test(code))) return { kind: 'ok' };
  const handBuilt = INLINE_DDL_RE.test(commentless) || SCHEMA_FIXTURE_IMPORT_RE.test(commentless);
  return handBuilt ? { kind: 'violation' } : { kind: 'not-claim-path' };
}

/** A release fixture that registers real awaits also executes the inbox pump. */
export function releaseWakeFixtureGaps(raw: string, fileName: string): string[] {
  const code = stripCommentsAndStrings(raw, fileName) as string;
  const commentless = stripCommentsOnly(raw, fileName) as string;
  if (!/\breleaseWorkItem\s*\(/.test(code) || !/\bregisterAwait\s*\(/.test(code)
    || /\bcreateOrgTestDb\s*\(/.test(code)) return [];
  const gaps: string[] = [];
  if (!/\bapplyEventSubstrateMigrationsForTest\s*\(/.test(code)) gaps.push('event substrate');
  if (!DISCLOSURE_LEDGER_HELPER_RE.test(code)) gaps.push('disclosure ledger');
  if (!/\bapplyMigrationForTest\s*\(/.test(code)
    || !/['"][^'"\n]*038-operator-settings\.sql['"]/.test(commentless)) gaps.push('wake settings');
  return gaps;
}

function integrationTests(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) integrationTests(full, out);
    else if (entry.name.endsWith('.integration.test.ts')) out.push(full);
  }
  return out;
}

describe('claim-path fixture bootstrap guard (WI-10005130)', () => {
  const files = integrationTests(HERE);
  const results = files.map((full) => {
    const rel = path.relative(HERE, full);
    const raw = readFileSync(full, 'utf8');
    return {
      rel,
      verdict: classify(raw, full),
      releaseWakeGaps: releaseWakeFixtureGaps(raw, full),
      viaTool: importsClaimTool(stripCommentsOnly(raw, full) as string, full),
    };
  });

  it('scans a real population of claim-path fixtures (positive control)', () => {
    const covered = results.filter((r) => r.verdict.kind === 'ok').length;
    // The sweep that introduced the helper converted ~38 files. A detector that silently
    // stops matching (a renamed door, a broken strip) would drop this to zero and pass.
    expect(covered).toBeGreaterThanOrEqual(30);
  });

  it('recognises tests that reach a claim door through a claim tool (positive control)', () => {
    // work_items and plan-items tool suites import ./claim by path. If a tool module moves,
    // this falls to zero and the tool-handler leg would pass vacuously.
    const viaTool = results.filter((r) => r.viaTool).map((r) => r.rel);
    expect(viaTool).toEqual(
      expect.arrayContaining([
        'agent-tools/work_items/work-items-tools.integration.test.ts',
        'agent-tools/plan-items/claim-auto-convert.integration.test.ts',
      ]),
    );
    // harness/routines has its own unrelated ./claim module; it must not count.
    expect(viaTool.filter((rel) => rel.startsWith('harness/'))).toEqual([]);
  });

  it('every hand-built claim-path fixture calls applyClaimPathReadDeps', () => {
    const violations = results
      .filter((r) => r.verdict.kind === 'violation' && !ALLOW.has(r.rel))
      .map((r) => r.rel)
      .sort();
    expect(
      violations,
      'These integration tests call a claim or delegated lifecycle door on a hand-built schema without ' +
        'applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple()) from test/_work-items-schema. ' +
        'Add the call after the base schema; every statement is IF NOT EXISTS. ' +
        'Delegated lifecycle fixtures also need applyDisclosureLedgerForTest(db.sql) from test/_pg-helpers.',
    ).toEqual([]);
  });

  it('includes the real delegated lifecycle fixture in the protected population', () => {
    expect(results.find((r) => r.rel === 'delegated-tasks.integration.test.ts')?.verdict.kind).toBe('ok');
  });

  it('protects real release-await fixtures from missing inbox-pump schemas', () => {
    expect(results.find((r) => r.rel === 'work-items-release-request.integration.test.ts')?.releaseWakeGaps).toEqual([]);
    expect(results.filter((r) => r.releaseWakeGaps.length).map((r) => ({ file: r.rel, gaps: r.releaseWakeGaps }))).toEqual([]);
  });

  it('detects removal of each release-await substrate without accepting comments as provisioning', () => {
    const file = path.join(HERE, 'work-items-release-request.integration.test.ts');
    const raw = readFileSync(file, 'utf8');
    for (const [call, gap] of [
      ['applyEventSubstrateMigrationsForTest', 'event substrate'],
      ['applyDisclosureLedgerForTest', 'disclosure ledger'],
      ['applyMigrationForTest', 'wake settings'],
    ]) {
      const mutated = raw.replace(new RegExp(`\\b${call}\\s*\\(`, 'g'), `omitted_${call}(`);
      expect(releaseWakeFixtureGaps(`${mutated}\n// ${call}(db.sql);`, file)).toContain(gap);
    }
    expect(releaseWakeFixtureGaps(raw.replace('038-operator-settings.sql', 'missing-settings.sql'), file)).toContain('wake settings');
  });

  it('allowlist entries still exist and still need the exemption', () => {
    for (const rel of ALLOW.keys()) {
      const hit = results.find((r) => r.rel === rel);
      expect(hit, `${rel} is allowlisted but no longer exists`).toBeDefined();
      expect(hit?.verdict.kind, `${rel} no longer needs its allowlist entry`).toBe('violation');
    }
  });

  describe('detector self-check', () => {
    const door = ['claim', 'NextWorkItem'].join('');
    const helper = ['applyClaim', 'PathReadDeps'].join('');
    const ddl = 'CREATE TABLE harness_shared.work_items (id text);';

    it('flags a claim door on a hand-built schema without the helper', () => {
      const src = `await db.sql.unsafe(\`${ddl}\`);\nconst r = await ${door}({ harness: 'h' });\n`;
      expect(classify(src, 'fixture.ts').kind).toBe('violation');
    });

    it('passes the same fixture once it calls the helper', () => {
      const src =
        `await db.sql.unsafe(\`${ddl}\`);\nawait ${helper}((d) => db.sql.unsafe(d).simple());\n` +
        `const r = await ${door}({ harness: 'h' });\n`;
      expect(classify(src, 'fixture.ts').kind).toBe('ok');
    });

    it('ignores a claim door named only in a comment or a string', () => {
      const src = `// calls ${door}( in prose\nconst s = '${door}(';\nawait db.sql.unsafe(\`${ddl}\`);\n`;
      expect(classify(src, 'fixture.ts').kind).toBe('not-claim-path');
    });

    it('does not count a helper named only in a comment', () => {
      const src = `// ${helper}( is applied elsewhere\nawait db.sql.unsafe(\`${ddl}\`);\nawait ${door}({});\n`;
      expect(classify(src, 'fixture.ts').kind).toBe('violation');
    });

    it.each(['createDelegatedTask', 'resolveDelegatedTask'])(
      'requires the shared event substrate for %s on a hand-built schema', (lifecycleDoor) => {
        const src = `await db.sql.unsafe(\`${ddl}\`);\nawait dt.${lifecycleDoor}({});\n`;
        expect(classify(src, 'fixture.ts').kind).toBe('violation');
        const withEvents = `${src}await ${helper}((d) => db.sql.unsafe(d).simple());\n`;
        expect(classify(withEvents, 'fixture.ts').kind).toBe('violation');
        expect(classify(`${withEvents}await applyDisclosureLedgerForTest(db.sql);\n`, 'fixture.ts').kind).toBe('ok');
      },
    );

    it('does not accept a disclosure-ledger helper mentioned only in a comment', () => {
      const src = `await db.sql.unsafe(\`${ddl}\`);\nawait dt.resolveDelegatedTask({});\n` +
        `await ${helper}((d) => db.sql.unsafe(d).simple());\n// applyDisclosureLedgerForTest(db.sql);\n`;
      expect(classify(src, 'fixture.ts').kind).toBe('violation');
    });

    it('does not classify delegated lifecycle names quoted only in prose as calls', () => {
      const src = `// dt.createDelegatedTask({})\nconst example = 'dt.resolveDelegatedTask({})';\n` +
        `await db.sql.unsafe(\`${ddl}\`);\n`;
      expect(classify(src, 'fixture.ts').kind).toBe('not-claim-path');
    });

    // Tool-handler leg (WI-10005225): the door is reached through tool.handler, so the
    // file names no door. Fixture paths place the source where the real suites live.
    const toolDir = (sub: string) => path.join(HERE, sub, 'fixture.integration.test.ts');
    const toolSrc = (spec: string) =>
      `const { default: tool } = await import('${spec}');\n` +
      `await db.sql.unsafe(\`${ddl}\`);\nawait tool.handler({ id: 'x' });\n`;

    it('flags a claim-tool handler test on a hand-built schema without the helper', () => {
      expect(classify(toolSrc('./claim'), toolDir('agent-tools/work_items')).kind).toBe('violation');
      expect(classify(toolSrc('./claim_next.ts'), toolDir('agent-tools/work_items')).kind).toBe('violation');
      expect(classify(toolSrc('./claim'), toolDir('agent-tools/plan-items')).kind).toBe('violation');
    });

    it('resolves a claim-tool specifier written from another directory', () => {
      const src = `import tool from './agent-tools/plan-items/claim';\nawait db.sql.unsafe(\`${ddl}\`);\n`;
      expect(classify(src, toolDir('.')).kind).toBe('violation');
    });

    it('passes a claim-tool handler test that calls the helper', () => {
      const src = `${toolSrc('./claim')}await ${helper}((d) => db.sql.unsafe(d).simple());\n`;
      expect(classify(src, toolDir('agent-tools/work_items')).kind).toBe('ok');
    });

    it('ignores an unrelated ./claim, a type-only import and an import in a comment', () => {
      expect(classify(toolSrc('./claim'), toolDir('harness/routines')).kind).toBe('not-claim-path');
      const typeOnly = `import type { X } from './claim';\nawait db.sql.unsafe(\`${ddl}\`);\n`;
      expect(classify(typeOnly, toolDir('agent-tools/work_items')).kind).toBe('not-claim-path');
      const commented = `// await import('./claim')\nawait db.sql.unsafe(\`${ddl}\`);\n`;
      expect(classify(commented, toolDir('agent-tools/work_items')).kind).toBe('not-claim-path');
    });
  });
});

import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const fixture = JSON.parse(readFileSync(new URL(
  '../../code-intelligence/__fixtures__/clone-remediation-seeders-20261024.json', import.meta.url,
), 'utf8')) as { members: { path: string; source: string; sha256: string }[] };
const helper = readFileSync(new URL('./seed-routine-main.ts', import.meta.url), 'utf8');
const compile = (source: string) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

type Fragment = { parts: readonly string[]; values: unknown[]; then: (done: () => unknown, fail?: (error: Error) => unknown) => unknown };
type Observation = { row: Record<string, unknown>; updates: string[] };

// Capture the real SQL template composition without a database, process exit or
// action registration. The independent oracle is the frozen, unmodified CLI.
async function observe(source: string, options: { argv: string[]; env?: Record<string, string>; fail?: boolean }) {
  const events: unknown[][] = [];
  const statements: Observation[] = [];
  function render(fragment: Fragment, parameters: unknown[]): string {
    return fragment.parts.reduce((text, part, index) => {
      if (index === fragment.values.length) return text + part;
      const value = fragment.values[index];
      return text + part + (value && typeof value === 'object' && 'parts' in value
        ? render(value as Fragment, parameters)
        : `__parameter${parameters.push(value) - 1}__`);
    }, '');
  }
  const sql = Object.assign((parts: TemplateStringsArray, ...values: unknown[]): Fragment => ({
    parts: [...parts], values,
    then(done, fail) {
      if (options.fail) return fail?.(new Error('controlled seed failure'));
      const parameters: unknown[] = [];
      const query = render(this, parameters).replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
      const columns = query.match(/routines\s*\(([^)]+)\)/)?.[1].split(',').map(x => x.trim());
      const cells = query.match(/VALUES\s*\(([\s\S]+?)\)\s*ON CONFLICT/)?.[1].split(',').map(x => x.trim());
      if (!columns || !cells || columns.length !== cells.length) throw new Error(`Unparsed seed SQL: ${query}`);
      const row = Object.fromEntries(columns.map((column, i) => {
        const cell = cells[i];
        const parameter = cell.match(/^__parameter(\d+)__/);
        const value = parameter ? parameters[Number(parameter[1])]
          : cell.replace(/::(?:text|jsonb)(?=::|$)/g, '').replace(/^'|'$/g, '');
        return [column, value];
      }));
      const updates = query.split('DO UPDATE SET')[1].split(',').map(x => x.trim()).sort();
      statements.push({ row, updates });
      events.push(['sql']);
      return done();
    },
  }), { end: async (q: unknown) => { events.push(['end', q]); } });
  const dependencies: Record<string, unknown> = {
    getOrgPg: () => ({ sql }), activeWorkspaceId: () => 'fixture-workspace',
    operatorHomeHarnessSlug: () => 'fixture-home',
    BULK_RUN_WATCHDOG_INTERVAL_SEC: 43,
    COMPLETION_CLAIM_RECHECK: 'completion-claim-recheck', DEAD_CITATION_SWEEP: 'dead-citation-sweep',
    DURABLE_ESCALATION_ORPHAN_SWEEP: 'durable-escalation-orphan-sweep',
    DEFAULT_EPISODE_SCOPED_OPERATIONAL_RECONCILE_CAP: 31,
    EPISODE_SCOPED_OPERATIONAL_RECONCILE: 'episode-scoped-operational-reconcile',
    episodeScopedOperationalReconcileCap: (value: unknown) => Math.max(1, Math.min(500, Number(value))),
    INBOX_BULK_RESOLVE: 'inbox-bulk-resolve', INBOX_BULK_RESOLVE_CAP: 37,
    INTAKE_TRIAGE_DRAIN: 'intake-triage-drain', INTAKE_TRIAGE_DRAIN_CAP: 41,
    DEFAULT_LEGACY_NEEDS_HUMAN_RECONCILE_CAP: 47,
    LEGACY_NEEDS_HUMAN_RECONCILE: 'legacy-needs-human-reconcile',
    legacyNeedsHumanReconcileCap: (value: unknown) => Math.max(1, Math.min(1000, Number(value))),
    PLAN_CLEANUP_SWEEP: 'plan-cleanup-sweep', MAX_RUN_PLANS: 53,
    announceRoutineSeeded: (...args: unknown[]) => { events.push(['announce', ...args]); },
  };
  const fakeProcess = { argv: ['node', 'seed.ts', ...options.argv], env: options.env ?? {},
    exit: (code: number) => { events.push(['exit', code]); } };
  const fakeConsole = { log: (...args: unknown[]) => { events.push(['log', ...args]); },
    error: (...args: unknown[]) => { events.push(['error', ...args]); } };
  function load(text: string) {
    const exports = {};
    const context: Record<string, unknown> = { exports, Error, process: fakeProcess, console: fakeConsole,
      require: (specifier: string) => {
        if (specifier === './seed-routine-main') return load(helper).exports;
        if (specifier === '@papercusp/db-org' || specifier.startsWith('../') || specifier.startsWith('./')) {
          return new Proxy(dependencies, { get(target, key: string) {
            if (!(key in target)) throw new Error(`Undeclared fixture import ${specifier}:${key}`);
            return target[key];
          } });
        }
        throw new Error(`Unexpected fixture import: ${specifier}`);
      } };
    runInNewContext(compile(text), context, { timeout: 1000 });
    return { exports, completion: context.__completion as Promise<void> | undefined };
  }
  const runnable = source.includes('void runRoutineSeed(')
    ? source.replace('void runRoutineSeed(', 'globalThis.__completion = runRoutineSeed(')
    : source.replace(/(?:void )?main\(\)(?=\s*(?:;|\.then))/, 'globalThis.__completion = main()');
  const result = load(runnable);
  if (!result.completion) throw new Error('The actual seed CLI did not publish a completion');
  await result.completion;
  return JSON.parse(JSON.stringify({ statements, events })) as { statements: Observation[]; events: unknown[][] };
}

const variants = [
  { name: 'defaults', argv: [] },
  { name: 'inactive', argv: ['--inactive'] },
  { name: 'active preview', argv: ['--active', '--dry-run'] },
  { name: 'explicit numeric limits', argv: ['--max-filings', '3', '--cap', '5', '--retention-days', '7',
    '--ttl-hours', '11', '--max-per-run', '13', '--candidate-cap', '17', '--batch-size', '19'] },
  { name: 'invalid numeric limits', argv: ['--cap', 'bad', '--retention-days', '0', '--max-per-run', '-1'] },
];

for (const member of fixture.members) describe(`P020 actual seed CLI ${basename(member.path)}`, () => {
  const current = readFileSync(resolve(root, member.path), 'utf8');
  it.each(variants)('preserves frozen SQL, conflict policy and output: $name', async variant => {
    const before = await observe(member.source, variant);
    const after = await observe(current, variant);
    expect(before.statements).toHaveLength(1);
    expect(after).toEqual(before);
  });
  it('preserves environment-selected harness identity', async () => {
    const keys = [...member.source.matchAll(/process\.env\.([A-Z_]+)/g)].map(match => match[1]);
    const variant = { argv: ['--active'], env: Object.fromEntries(keys.map(key => [key, 'Fixture-Pot/Two'])) };
    expect(await observe(current, variant)).toEqual(await observe(member.source, variant));
  });
  if (!member.source.includes('void main();')) {
    it('preserves CLI failure output and the failure exit', async () => {
      const variant = { argv: [], fail: true };
      const before = await observe(member.source, variant);
      expect(await observe(current, variant)).toEqual(before);
      expect(before.events.at(-1)).toEqual(['exit', 1]);
      expect(before.statements).toEqual([]);
    });
  }
});

/**
 * The intake-triage drain is a REGISTERED, SCHEDULED executor (P-008 / D-020 §2):
 * its action is imported by production registration, its durable single-flight
 * cron is seeded and guarded, and it is classified as model-spending.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BESPOKE_ACTIVE_SEEDS } from './bespoke-active-seeds-check';

const HERE = __dirname;
const ACTION = join(HERE, 'intake-triage-drain-action.ts');
const SEED = join(HERE, 'seed-intake-triage-drain-routine.ts');
const REGISTER = join(HERE, 'register-system-actions.ts');
const read = (path: string) => readFileSync(path, 'utf8');

describe('scheduled intake-triage drain wiring', () => {
  it('has a registered action and a matching production import', () => {
    expect(existsSync(ACTION)).toBe(true);
    expect(read(ACTION)).toContain('registerSystemAction(INTAKE_TRIAGE_DRAIN');
    expect(read(REGISTER)).toContain("import './intake-triage-drain-action';");
  });

  it('seeds an active durable single-flight cron with the bounded cap, never re-activating on conflict', () => {
    const src = read(SEED);
    expect(src).toContain('const TARGET_ROLE = `system:${NAME}`');
    expect(src).toContain('const NAME = INTAKE_TRIAGE_DRAIN');
    expect(src).toContain("'durable'");
    expect(src).toContain("'skip', 'skip-old'");
    expect(src).toContain("const active = !process.argv.includes('--inactive')");
    expect(src).toContain('INTAKE_TRIAGE_DRAIN_CAP');
    expect(src).toContain('active intentionally NOT re-applied on conflict');
  });

  it('guards the seed and classifies the drain as model-spending', async () => {
    expect(BESPOKE_ACTIVE_SEEDS).toContainEqual({
      name: 'intake-triage-drain',
      seedScript: 'seed-intake-triage-drain-routine.ts',
    });
    const { TARGET_ROLE_SPEND } = await import('../../automation/routine-classification');
    expect(TARGET_ROLE_SPEND['system:intake-triage-drain']).toMatchObject({ spend: 'llm' });
  });

  it('seeds its own run kind and selects through the shared awaiting predicate, never claiming work', () => {
    const src = read(ACTION);
    expect(src).toContain("INTAKE_TRIAGE_RUN_KIND = 'intake-triage'");
    expect(src).toContain('runKind: INTAKE_TRIAGE_RUN_KIND');
    expect(src).toContain('intakeTriageStateSql(');
    expect(src).toContain('getRunningRun');
    expect(src).not.toContain('getActiveRun(');
    expect(src).not.toMatch(/work_items:claim|claimWorkItem|assign_to/);
  });
});

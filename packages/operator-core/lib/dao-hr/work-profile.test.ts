/**
 * Unit layer for R-1 (dao-hr-people-2026-10-11 P-002): the work-profile write path validates
 * the work facts — engagement type (D-003), pay terms (D-005), start date, jurisdiction —
 * BEFORE it touches the database. The real round-trip against Postgres lives in
 * work-profile.integration.test.ts; this file pins the input contract with no database.
 *
 * The `sql` dependency is a recording stub: any call is logged and throws `DB_TOUCHED`. A
 * refused input must fail with a WorkProfileError('invalid_input') and an EMPTY call log; a
 * valid input must get past validation, which the stub proves by being called. The valid
 * cases are the positive control that keeps the refusals from passing vacuously.
 */
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  ENGAGEMENT_TYPES,
  PAY_CADENCES,
  WorkProfileError,
  saveWorkProfile,
  type SaveWorkProfileInput,
} from './work-profile';

const DB_TOUCHED = 'DB_TOUCHED';

function recordingSql(): { sql: Sql; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const touch = (...args: unknown[]): never => {
    calls.push(args);
    throw new Error(DB_TOUCHED);
  };
  const sql = Object.assign(touch, { unsafe: touch }) as unknown as Sql;
  return { sql, calls };
}

const BASE: SaveWorkProfileInput = {
  workspaceId: 'ws-unit',
  daoSlug: 'dao-unit',
  personId: 'PER-unit-1',
  title: 'Protocol engineer',
  engagementType: 'employee',
  jurisdiction: 'US-CA',
  startDate: '2026-11-02',
  pay: { amount: '9500.00', currency: 'USD', cadence: 'monthly' },
};

async function refusal(input: SaveWorkProfileInput): Promise<{ code: string | null; calls: number }> {
  const { sql, calls } = recordingSql();
  try {
    await saveWorkProfile(input, { sql });
  } catch (error) {
    return { code: error instanceof WorkProfileError ? error.code : `other:${(error as Error).message}`, calls: calls.length };
  }
  return { code: null, calls: calls.length };
}

describe('R-1 unit — engagement type is employee or contractor (D-003)', () => {
  it('declares exactly the two engagement types', () => {
    expect([...ENGAGEMENT_TYPES]).toEqual(['employee', 'contractor']);
  });

  it('refuses any other engagement type before touching the database', async () => {
    const result = await refusal({ ...BASE, engagementType: 'freelancer' as SaveWorkProfileInput['engagementType'] });
    expect(result).toEqual({ code: 'invalid_input', calls: 0 });
  });

  it.each(['employee', 'contractor'] as const)('accepts %s and proceeds to the person-record lookup', async (engagementType) => {
    const result = await refusal({ ...BASE, engagementType });
    expect(result).toEqual({ code: `other:${DB_TOUCHED}`, calls: 1 });
  });
});

describe('R-1 unit — regular pay terms are exact and well-formed (D-005)', () => {
  it('supports per-milestone pay for contractors', () => {
    expect(PAY_CADENCES).toContain('per-milestone');
  });

  it('accepts contractor pay per milestone with no team', async () => {
    const result = await refusal({
      ...BASE,
      engagementType: 'contractor',
      team: null,
      pay: { amount: '1200', currency: 'EUR', cadence: 'per-milestone' },
    });
    expect(result).toEqual({ code: `other:${DB_TOUCHED}`, calls: 1 });
  });

  it.each([
    ['a float amount', { amount: 9500.5 as unknown as string, currency: 'USD', cadence: 'monthly' }],
    ['three decimal places', { amount: '10.005', currency: 'USD', cadence: 'monthly' }],
    ['a negative amount', { amount: '-5', currency: 'USD', cadence: 'monthly' }],
    ['a lowercase currency', { amount: '10', currency: 'usd', cadence: 'monthly' }],
    ['an unknown cadence', { amount: '10', currency: 'USD', cadence: 'fortnightly' }],
  ])('refuses pay with %s before touching the database', async (_label, pay) => {
    const result = await refusal({ ...BASE, pay: pay as SaveWorkProfileInput['pay'] });
    expect(result).toEqual({ code: 'invalid_input', calls: 0 });
  });
});

describe('R-1 unit — the remaining work facts are validated', () => {
  it.each([
    ['a missing title', { title: '   ' }],
    ['a one-letter jurisdiction', { jurisdiction: 'U' }],
    ['a start date that is not a calendar date', { startDate: '2026-02-30' }],
    ['a start date in the wrong format', { startDate: '02/11/2026' }],
  ])('refuses %s before touching the database', async (_label, patch) => {
    const result = await refusal({ ...BASE, ...patch } as SaveWorkProfileInput);
    expect(result).toEqual({ code: 'invalid_input', calls: 0 });
  });
});

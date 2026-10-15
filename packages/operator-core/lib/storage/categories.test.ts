import { describe, it, expect } from 'vitest';
import {
  STORAGE_CATEGORIES,
  getStorageCategory,
  isTrimmable,
  isPgCategory,
  registryFederationClass,
} from './categories';

describe('storage categories taxonomy', () => {
  it('has unique ids', () => {
    const ids = STORAGE_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('isTrimmable iff not federated', () => {
    for (const c of STORAGE_CATEGORIES) {
      expect(isTrimmable(c)).toBe(c.federation !== 'federated');
    }
  });

  it("each PG category's federation class agrees with the live table registry", () => {
    for (const c of STORAGE_CATEGORIES) {
      if (!isPgCategory(c)) continue;
      const registryClass = registryFederationClass(c.table);
      if (c.federation === 'federated') {
        expect(registryClass, `${c.table} should be federated`).toBe('federated');
      } else {
        // local-diagnostic + bloat-queue are both sync:'none' (local).
        expect(registryClass, `${c.table} should be local`).toBe('local');
      }
    }
  });

  it('trimmable PG categories carry an age column + type; federated ones do not', () => {
    for (const c of STORAGE_CATEGORIES) {
      if (!isPgCategory(c)) continue;
      if (c.federation === 'federated') {
        expect(c.ageColumn, `${c.id} federated → no age column`).toBeUndefined();
      } else {
        expect(c.ageColumn, `${c.id} needs an age column`).toBeTruthy();
        expect(c.ageColumnType, `${c.id} needs an age column type`).toBeTruthy();
      }
    }
  });

  it('bloat-queue categories set bloats; substrate-outbox guards on drained', () => {
    const substrate = getStorageCategory('substrate-outbox');
    expect(substrate && isPgCategory(substrate) && substrate.bloats).toBe(true);
    expect(substrate && isPgCategory(substrate) && substrate.drainedGuard).toBe(true);
    expect(substrate?.federation).toBe('bloat-queue');
  });

  it('disk categories are local + trimmable', () => {
    for (const c of STORAGE_CATEGORIES) {
      if (c.kind !== 'disk') continue;
      expect(c.federation).toBe('local-diagnostic');
      expect(isTrimmable(c)).toBe(true);
    }
  });

  it('includes the audit\'s big diagnostic tables + the federated read-only set', () => {
    const ids = new Set(STORAGE_CATEGORIES.map((c) => c.id));
    for (const id of ['route-invocations', 'tool-invocations', 'decision-ledger', 'agent-activity', 'substrate-outbox']) {
      expect(ids.has(id), `expected trimmable ${id}`).toBe(true);
    }
    const plans = getStorageCategory('plans');
    expect(plans?.federation).toBe('federated');
    expect(isTrimmable(plans!)).toBe(false);

    const presence = getStorageCategory('shared-presence');
    expect(presence && isPgCategory(presence) && presence.table).toBe('shared_presence');
    expect(presence?.federation).toBe('federated');
    expect(isTrimmable(presence!)).toBe(false);
  });

  it('harness_run_output is a local-diagnostic epoch_ms category (wired into the P-010 retention policy)', () => {
    const c = getStorageCategory('harness-run-output');
    expect(c && isPgCategory(c) && c.table).toBe('harness_run_output');
    expect(c && isPgCategory(c) && c.ageColumn).toBe('ended_at');
    expect(c && isPgCategory(c) && c.ageColumnType).toBe('epoch_ms');
    expect(registryFederationClass('harness_run_output')).toBe('local');
    expect(isTrimmable(c!)).toBe(true);
  });

  it('perf-tarballs is a safe glob-files disk store (prefix+suffix, never the whole root)', () => {
    const c = getStorageCategory('perf-tarballs');
    expect(c?.kind).toBe('disk');
    expect(c && c.kind === 'disk' && c.store).toBe('glob-files');
    expect(c && c.kind === 'disk' && c.glob?.prefix).toBe('p2p-perf-runtime-');
    expect(c && c.kind === 'disk' && c.glob?.suffix).toBe('.tgz');
    expect(isTrimmable(c!)).toBe(true);
  });
});

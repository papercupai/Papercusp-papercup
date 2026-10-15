/**
 * Smoke test: registry imports cleanly + every domain is well-shaped.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-002 verification.
 */

import { describe, expect, it } from 'vitest';
import './_loads-registry'; // side-effect import to populate the registry
import { listTestDomains, universalDomains } from '../testing-domains';
import { papercuspRegistry, adminRegistry } from '../testing-domains-registry';
import { remainderToRegex } from '../testing-domain-glob';

describe('testing-domains-registry', () => {
  const domains = listTestDomains();

  it('registers a stable set of domains (≥ core, no duplicate ids)', () => {
    // Was `toBe(29)` — a brittle exact-count that flapped red repeatedly on
    // 2026-06-04 as concurrent agents added domains (operator-ui-lib, etc.).
    // The real protection is the no-duplicate-id invariant + the per-domain
    // membership checks below; a lower bound just guards against the registry
    // collapsing. (Fleet note: su-adfa2834 / su-a6146 — prefer ≥N + membership.)
    expect(domains.length).toBeGreaterThanOrEqual(30);
    const ids = domains.map((d) => d.id);
    expect(new Set(ids).size, 'no duplicate domain ids').toBe(ids.length);
  });

  it('registers the `dogfood` domain with its collaborative-substrate sections', () => {
    const dogfood = papercuspRegistry.find((d) => d.id === 'dogfood');
    expect(dogfood, 'dogfood domain must be registered (surfaces the shared-harness suite in the Tests tab)').toBeTruthy();
    const sectionIds = (dogfood!.sections ?? []).map((s) => s.id).sort();
    expect(sectionIds).toEqual(
      [
        'substrate', 'identity-binding', 'federation', 'claim', 'pr-lifecycle',
        'completion-ref', 'reactivity', 'revocation', 'cupboard', 'ui', 'routes',
      ].sort(),
    );
    // every section carries a glob or runner so the shell can resolve it
    for (const s of dogfood!.sections ?? []) {
      expect(Boolean(s.globs?.length) || Boolean(s.runners?.length), `section ${s.id} needs globs/runners`).toBe(true);
    }
  });

  it('every tier appears at least once', () => {
    const tiers = new Set(domains.map((d) => d.tier));
    expect(tiers.has('quick')).toBe(true);
    expect(tiers.has('domain')).toBe(true);
    expect(tiers.has('surface')).toBe(true);
  });

  it('surfaces TypeScript and native ESM Playwright specs in the existing E2E section', () => {
    const e2e = domains.find((d) => d.id === 'operator-core')!.sections.find((s) => s.id === 'e2e')!;
    const matches = (path: string) => e2e.globs!.some((glob) => remainderToRegex(glob).test(path));
    expect(matches('apps/operator/e2e/backups.spec.ts')).toBe(true);
    expect(matches('apps/operator/e2e/ongoing-work-native-collection.spec.mts')).toBe(true);
    expect(matches('apps/operator/e2e/helper.test.ts')).toBe(false);
  });

  it('papercusp-su has the four sections from the spec', () => {
    const su = domains.find((d) => d.id === 'papercusp-su');
    expect(su).toBeDefined();
    const ids = su!.sections.map((s) => s.id);
    expect(ids).toEqual(['coordination', 'file-locking', 'identity', 'tools']);
  });

  it('every section declares globs or runners', () => {
    for (const d of domains) {
      for (const s of d.sections) {
        const hasGlobs = (s.globs?.length ?? 0) > 0;
        const hasRunners = (s.runners?.length ?? 0) > 0;
        expect(hasGlobs || hasRunners, `${d.id}/${s.id}`).toBe(true);
      }
    }
  });

  it('every domain id is kebab-lowercase', () => {
    for (const d of domains) {
      expect(d.id, d.label).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('ui suite exposes the desktop stability regression tests in the Tests tab', () => {
    const plans = domains.find((d) => d.id === 'plans');
    expect(plans).toBeDefined();
    const ui = plans!.sections.find((s) => s.id === 'ui');
    expect(ui).toBeDefined();
    // The desktop-stability regression tests moved from apps/operator/lib/__tests__
    // → packages/operator-core/lib/__tests__ in the SP1 C4 carve (2026-06-04).
    // arrayContaining is a subset assertion, so registry additions (ChromeShellNav,
    // admin/plans, …) don't break this — only an accidental drop of a core test does.
    expect(ui!.globs).toEqual(expect.arrayContaining([
      'packages/operator-core/lib/__tests__/client-navigation.test.ts',
      'packages/operator-core/lib/__tests__/desktop-static-host.test.ts',
      'packages/operator-core/lib/__tests__/desktop-ui-intents.test.ts',
      'packages/operator-core/lib/__tests__/lazy-with-retry.test.ts',
      'apps/operator/app/admin/testing/_lib/recorder-start-params.test.ts',
      'apps/operator/app/_components/__tests__/SupportChatButton.test.tsx',
      'apps/operator/app/_components/__tests__/ChatwootWidget.test.tsx',
      'apps/operator/app/_components/__tests__/OperatorChatSidebar.test.ts',
      'apps/operator/app/_components/__tests__/UiPresenceProvider.test.tsx',
      'apps/operator/app/_components/__tests__/UserPicker.test.tsx',
      'packages/operator-core/lib/__tests__/workspaces-tauri.test.ts',
      'apps/operator/app/_components/__tests__/routePending.test.ts',
      'apps/operator/app/_components/__tests__/RouteLink.test.ts',
    ]));
  });
});

describe('Phase 1 — universal vs Papercusp split (testing-shell-cross-project D-007)', () => {
  it('universalDomains is the portable set [routes], all tier "universal"', () => {
    expect(universalDomains.map((d) => d.id).sort()).toEqual(['routes']);
    expect(universalDomains.every((d) => d.tier === 'universal')).toBe(true);
  });

  it('papercuspRegistry is the Papercusp-only domains, none universal', () => {
    // Was `toBe(28)` — brittle exact-count. Lower bound + the disjointness
    // invariant below carry the real signal (domains added concurrently 2026-06-04).
    expect(papercuspRegistry.length).toBeGreaterThanOrEqual(29);
    expect(papercuspRegistry.some((d) => d.tier === 'universal')).toBe(false);
    // the universal domains are NOT in the Papercusp set
    const papercuspIds = new Set(papercuspRegistry.map((d) => d.id));
    for (const g of universalDomains) expect(papercuspIds.has(g.id)).toBe(false);
  });

  it('the Papercusp-runtime-bound domains moved out of the lib into the operator', () => {
    const papercuspIds = new Set(papercuspRegistry.map((d) => d.id));
    for (const id of ['test-runs', 'vitals', 'chaos-desktop', 'ai-explore']) expect(papercuspIds.has(id)).toBe(true);
  });

  it('surfaces the defined Scout domain in both Papercusp and admin registries', () => {
    const scout = papercuspRegistry.find((d) => d.id === 'scout');
    expect(scout).toMatchObject({
      id: 'scout',
      sections: [{ id: 'lib', globs: ['packages/operator-core/lib/scout/**/*.test.ts'] }],
    });
    expect(adminRegistry.some((d) => d.id === 'scout')).toBe(true);
  });

  it('adminRegistry composes universal + Papercusp domains', () => {
    // The composition invariant is the real assertion; the absolute count was
    // brittle (was `toBe(29)`, now ≥30 and growing).
    expect(adminRegistry.length).toBe(universalDomains.length + papercuspRegistry.length);
    expect(adminRegistry.length).toBeGreaterThanOrEqual(30);
  });

  it('the universal domains registered into the shared Map (admin getTestDomain sees them)', () => {
    const ids = new Set(listTestDomains().map((d) => d.id));
    for (const g of universalDomains) expect(ids.has(g.id)).toBe(true);
  });
});

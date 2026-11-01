/**
 * tool-delivery-drift-guard — the guard for P-005 / AUTO-BAR-R-5 of
 * deterministic-tool-definition-delivery-2026-09-21.
 *
 * R-5: "The generated artifact cannot diverge from its inputs without failing the
 * build, and re-measuring demand produces a committed diff a reviewer can read
 * rather than an invisible re-measure at build time."
 *
 * Until this file existed, that claim rested on an inline `current === built.text`
 * comparison buried inside gen-tool-delivery's main(). No test could reach it:
 * exercising it meant spawning the CLI, and exercising its FAILING branch meant
 * mutating the real committed artifact — which races the git-sync sweep that commits
 * the whole tree every few minutes, so a probe that mutates it can be committed even
 * when nothing goes wrong. The result was a guard that had only ever been observed
 * to PASS, which is not evidence that it can fail.
 *
 * Extracting `toolDeliveryDriftVerdict` makes both branches reachable as pure data,
 * so the controls below mutate nothing on disk at all.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { toolDeliveryCheckVerdict, toolDeliveryDriftVerdict } from '../../../../scripts/gen-tool-delivery';
import { dryTasks, HOST_WORKSPACE } from '../__tests__/affected-tests-repo-wide-invariant-guards.shared';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ARTIFACT = 'apps/operator/scripts/tool-delivery.generated.mjs';

describe('toolDeliveryDriftVerdict — the drift guard can actually FAIL', () => {
  // CALIBRATION FIRST. Without this, every control below could be passing because
  // the function returns `ok:false` unconditionally, which would make the guard
  // useless in the opposite direction while every "it catches X" case still passed.
  it('CALIBRATION: identical text is CURRENT, so the controls are not vacuous', () => {
    const text = 'export const TOOL_DELIVERY = {};\n';
    expect(toolDeliveryDriftVerdict(text, text)).toEqual({ ok: true, reason: 'current' });
  });

  it('CATCHES a stale artifact — the committed text no longer matches a fresh derivation', () => {
    const verdict = toolDeliveryDriftVerdict('export const A = 1;\n', 'export const A = 2;\n');
    expect(verdict).toEqual({ ok: false, reason: 'stale' });
  });

  it('CATCHES a missing artifact, and reports it as MISSING rather than STALE', () => {
    // The two failures have different repairs (regenerate vs. investigate why the
    // file vanished), which is why the verdict distinguishes them at all.
    expect(toolDeliveryDriftVerdict(null, 'export const A = 1;\n')).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('reports an EMPTY artifact as stale, not missing — an empty file is present', () => {
    expect(toolDeliveryDriftVerdict('', 'export const A = 1;\n')).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  // The next two pin BYTE-EXACTNESS. A later "tidy-up" that compares trimmed or
  // whitespace-normalized text would keep every case above green while letting real
  // drift through, so the guard would look tested and silently stop guarding.
  it('is byte-exact: a trailing-newline difference is STALE', () => {
    expect(toolDeliveryDriftVerdict('export const A = 1;', 'export const A = 1;\n')).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it('is byte-exact: an interior whitespace difference is STALE', () => {
    expect(toolDeliveryDriftVerdict('export const  A = 1;\n', 'export const A = 1;\n')).toEqual({
      ok: false,
      reason: 'stale',
    });
  });
});

describe('toolDeliveryCheckVerdict — mandatory floor bytes are checked before artifact freshness', () => {
  it('rejects an over-budget floor even when the generated artifact is current', () => {
    const text = 'export const TOOL_DELIVERY = {};\n';
    expect(
      toolDeliveryCheckVerdict(text, text, {
        claude: {
          budgetBytes: 100,
          floors: ['tools:find'],
          rows: [
            { name: 'tools:find', compactBytes: 101 },
            { name: 'capability:read', compactBytes: 900 },
          ],
        },
      }),
    ).toMatchObject({
      ok: false,
      reason: 'floor-overrun',
      agentKind: 'claude',
      headroom: { floorBytes: 101, headroomBytes: -1, status: 'overrun' },
    });
  });

  it('accepts an in-budget floor and then checks artifact freshness', () => {
    const text = 'export const TOOL_DELIVERY = {};\n';
    expect(
      toolDeliveryCheckVerdict(text, text, {
        claude: {
          budgetBytes: 100,
          floors: ['tools:find'],
          rows: [
            { name: 'tools:find', compactBytes: 100 },
            { name: 'capability:read', compactBytes: 900 },
          ],
        },
      }),
    ).toEqual({ ok: true, reason: 'current' });
  });
});

describe('the drift guard is wired into the build, not merely runnable locally', () => {
  // R-5's falsifier names this explicitly: "the check runs only locally and is not
  // wired into the build". A guard nobody invokes cannot make drift impossible.
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };

  it('exposes gen:tool-delivery:check, and it really passes --check', () => {
    const script = pkg.scripts?.['gen:tool-delivery:check'];
    expect(script, 'gen:tool-delivery:check is missing from package.json').toBeTruthy();
    expect(script).toContain('scripts/gen-tool-delivery.ts');
    expect(script).toContain('--check');
  });

  it.each([
    'libs/generic/tooldef/src/compact-schema.ts',
    'apps/operator/scripts/tool-delivery.generated.mjs',
    'packages/operator-core/lib/agent-tools/tool-demand-snapshot.json',
    'packages/operator-core/lib/agent-tools/events/await.ts',
    'packages/operator-core/lib/agent-tools/facts/assert.ts',
    'packages/operator-core/lib/agent-tools/testing/run.ts',
  ])('the actual affected-tests router attaches the guard for %s', (changedPath) => {
    expect(dryTasks(changedPath)).toContain(`${HOST_WORKSPACE} :: gen:tool-delivery:check`);
  });

  it('CALIBRATION: the router excludes test-only edits from this generated-input guard', () => {
    expect(dryTasks('libs/generic/tooldef/src/compact-schema.test.ts'))
      .not.toContain(`${HOST_WORKSPACE} :: gen:tool-delivery:check`);
  });

  it('resolves the guard through its actual workspace script', () => {
    const workspace = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8'));
    expect(workspace.scripts?.['gen:tool-delivery:check'])
      .toBe('tsx ../../scripts/gen-tool-delivery.ts --check');
  });

  it('the committed artifact exists and is not a stub', () => {
    const text = readFileSync(resolve(REPO_ROOT, ARTIFACT), 'utf8');
    expect(text.length).toBeGreaterThan(1000);
    expect(text).toContain('TOOL_DELIVERY');
  });
});

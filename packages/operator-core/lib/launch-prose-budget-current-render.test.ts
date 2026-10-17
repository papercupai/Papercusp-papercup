/** R3 detector preparation. P-030's final teaching render remains a separate owed control. */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { measureLaunchProseSurfaces, readBaseline } from '../../../scripts/check-launch-prose-budget';
import { compareProseBudget, type ProseBudgetBaseline } from './launch-prose-budget';
import { renderSuPlaybook } from './desktop-install/papercusp-files';
import { renderCodexOutputGuidance } from './result-door-prompt';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
// The unchanged ceilings named by R3, not a new budget or a sum of independent limits.
const LIMITS = new Map([['su-base:power', 76_000], ['su-client-overlays:all', 27_000]]);

function ceilingsUnraised(baseline: ProseBudgetBaseline): boolean {
  return [...LIMITS].every(([surface, limit]) => {
    const row = baseline.ceilings.find((c) => c.surface === surface);
    return Boolean(row && row.ceilingBytes <= limit);
  });
}

describe('R3 current launch-prose render integration', () => {
  it('measures the governed source files under the unchanged ceilings and rejects raised/collapsed controls', async () => {
    const baseline = await readBaseline();
    const governed = { ...baseline, ceilings: baseline.ceilings.filter((c) => LIMITS.has(c.surface)) };
    const measured = (await measureLaunchProseSurfaces()).filter((m) => LIMITS.has(m.surface));
    expect(measured).toHaveLength(2);
    expect(ceilingsUnraised(governed)).toBe(true);
    expect(compareProseBudget(measured, governed).ok).toBe(true);
    const raised = { ...governed, ceilings: governed.ceilings.map((c) => ({ ...c, ceilingBytes: c.ceilingBytes + 100_000 })) };
    expect(ceilingsUnraised(raised)).toBe(false);
    expect(compareProseBudget(measured.map((m) => ({ ...m, bytes: 0 })), governed).ok).toBe(false);
    expect(compareProseBudget(measured.map((m) => ({ ...m, bytes: 1_000_000 })), governed).ok).toBe(false);
    console.info('R3_CURRENT_SOURCE_BYTES', JSON.stringify({ measured, ceilings: governed.ceilings.map(({ surface, ceilingBytes }) => ({ surface, ceilingBytes })) }));
  }, 30_000);

  it('records actual before/after R4 guidance bytes in the real Codex power render', async () => {
    const common = { agent: 'codex' as const, profile: 'power' as const, tier: 'full' as const,
      operatorAppRoot: join(ROOT, 'apps/operator'), renderWireSchemas: () => '' };
    const before = await renderSuPlaybook({ ...common, nativeToolPolicy: { deniedNames: ['exec'] } });
    const after = await renderSuPlaybook({ ...common, nativeToolPolicy: { deniedNames: [] } });
    const guidance = renderCodexOutputGuidance({ deniedNames: [] });
    expect(before.text).not.toContain('## Codex native tool output (until exec cutover)');
    expect(after.text).toContain(guidance);
    const beforeBytes = Buffer.byteLength(before.text), afterBytes = Buffer.byteLength(after.text);
    expect(afterBytes - beforeBytes).toBe(Buffer.byteLength(guidance) + 2);
    console.info('R3_GUIDANCE_RENDER_BYTES', JSON.stringify({ beforeBytes, afterBytes, guidanceBytes: Buffer.byteLength(guidance),
      scope: 'R4 guidance on current source; final cutover P-030 teaching text is not yet authored or certified' }));
  }, 30_000);
});

/**
 * Acceptance for the fundraise-pipeline trigger pack
 * (fundraise-automation-2026-08-23 P-004..P-008).
 *
 * The starter-pack suite next door is parameterized over three one-target packs and asserts a
 * rigid single-binding shape. This pack is the first multi-target, edge-stitched one, so it gets
 * its own acceptance rather than loosening that suite's shape assertions — which are load-bearing
 * for the packs they cover.
 *
 * The pack must never send mail. The scopes are NOT what guarantees that: Google's
 * `gmail.compose` scope itself permits sending drafts and messages. The enforced guard is the
 * host's: `mail:reply { planRunId }` refuses `mode:"send"` from a triggered run while the
 * owner-authority flag papercusp-gmail-auto-send is OFF (capability-verbs/mail-run-reply.test.ts).
 * The tests here keep the pack itself from asking for more: no wider send scope in the manifest,
 * and no plan text that names a send verb or send mode.
 */
import { describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { loadPluginFromDir } from './index';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PACK_DIR = resolve(REPO_ROOT, 'libs/papercusp/plugins/fundraise-pipeline');

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function loadPack() {
  const result = await loadPluginFromDir(PACK_DIR, 'global');
  expect('error' in result ? result.error : null).toBeNull();
  expect('skipped' in result ? result.skipped : null).toBeNull();
  if (!('plugin' in result)) throw new Error('pack failed to load');
  return result;
}

describe('fundraise-pipeline trigger pack', () => {
  it('loads as a manifest-only plugin with the declared graph', async () => {
    const result = await loadPack();
    expect((result.plugin as unknown as { __runtime?: string }).__runtime).toBe('manifest-only');

    const pack = result.triggerPack;
    expect(pack).toBeTruthy();
    expect(pack?.targets.map((t) => t.id).sort()).toEqual([
      'classify-and-draft-reply',
      'first-touch-draft',
      'fund-research-brief',
      'investor-meeting-prep',
      'no-reply-follow-up',
      'post-meeting-followup',
      'weekly-pipeline-review',
    ]);
    expect(pack?.bindings.map((b) => b.id).sort()).toEqual([
      'first-touch-outreach',
      'follow-up-ladder',
      'investor-reply-to-pipeline',
      'meeting-to-investor-prep',
      'meeting-to-post-followup',
      'research-enrichment',
      'weekly-review',
    ]);
  });

  it('cannot send mail: no send scope is requested anywhere in the manifest', async () => {
    const result = await loadPack();
    const declared = result.plugin.oauth?.flatMap((entry) => entry.scopes ?? []) ?? [];
    const inline = Object.values(object(object(result.plugin.configSchema).properties))
      .flatMap((field) => {
        const scopes = object(object(field).oauth).scopes;
        return Array.isArray(scopes) ? (scopes as string[]) : [];
      });

    expect(declared.length).toBeGreaterThan(0);
    for (const scope of [...declared, ...inline]) {
      expect(scope).not.toContain('gmail.send');
      expect(scope).not.toContain('mail.google.com');
    }
    // compose is what makes drafting possible. It also permits sending, which is why the
    // host-side run-send gate, not this scope list, is the actual no-send guarantee.
    expect(declared).toContain('https://www.googleapis.com/auth/gmail.compose');
  });

  it('every plan ends at a draft, never a send', () => {
    const planFiles = [
      'plan-classify-reply.md',
      'plan-follow-up.md',
      'plan-meeting-prep.md',
      'plan-post-meeting.md',
      'plan-fund-research.md',
      'plan-first-touch.md',
      'plan-weekly-review.md',
    ];
    for (const file of planFiles) {
      const path = resolve(PACK_DIR, file);
      expect(existsSync(path), `${file} is declared by the manifest and must exist`).toBe(true);
      const body = readFileSync(path, 'utf8');
      expect(body).not.toMatch(/gmail:send|gmail:send-message|sendMessage\(|mail:send/);
      // `mode:"send"` may appear only as the explicit prohibition "never `mode:"send"`".
      const sendModes = body.match(/[^\n]{0,24}mode:\s*["']send["']/g) ?? [];
      for (const mention of sendModes) expect(mention, file).toMatch(/never\s*`?$|never\s*`?mode/i);
    }
  });

  it('every outbound step names a provider-neutral mail verb, not the retired gmail:create-draft', () => {
    for (const file of ['plan-classify-reply.md', 'plan-follow-up.md', 'plan-post-meeting.md', 'plan-first-touch.md']) {
      const body = readFileSync(resolve(PACK_DIR, file), 'utf8');
      expect(body, file).not.toContain('gmail:create-draft');
      expect(body, file).toMatch(/mail:reply|mail:draft/);
    }
  });

  it('declares every plan target path on disk as a safe relative .md file', async () => {
    const result = await loadPack();
    for (const target of result.triggerPack?.targets ?? []) {
      expect(target.kind).toBe('plan');
      if (target.kind !== 'plan') continue;
      expect(target.path).toMatch(/^[a-z0-9-]+\.md$/);
      expect(existsSync(resolve(PACK_DIR, target.path))).toBe(true);
    }
  });

  it('uses no schedule-source binding, which has no runtime consumer', async () => {
    const result = await loadPack();
    for (const binding of result.triggerPack?.bindings ?? []) {
      expect(binding.source.kind).not.toBe('schedule');
    }
  });

  it('gives every internal binding an incoming correlation-preserving edge', async () => {
    const result = await loadPack();
    const pack = result.triggerPack;
    const internal = (pack?.bindings ?? []).filter((b) => b.source.kind === 'internal');
    expect(internal.length).toBeGreaterThan(0);
    for (const binding of internal) {
      const incoming = (pack?.edges ?? []).filter((e) => e.to === binding.id);
      expect(incoming.length).toBeGreaterThan(0);
      for (const edge of incoming) {
        expect(edge.correlation).toBe('inherit');
        expect(edge.event).toBe(
          (binding.source as { kind: 'internal'; event: string }).event,
        );
      }
    }
  });

  it('binds plan targets to canonical registry datatypes rather than pack-local shapes', async () => {
    const result = await loadPack();
    const seen = new Set<string>();
    for (const target of result.triggerPack?.targets ?? []) {
      if (target.kind !== 'plan') continue;
      const props = object(target.inputSchema.properties);
      const trigger = object(object(props.trigger).properties);
      const payloadDatatype = object(trigger.payload).datatype;
      if (typeof payloadDatatype === 'string') seen.add(payloadDatatype);
      const dealDatatype = object(props.deal).datatype;
      if (typeof dealDatatype === 'string') seen.add(dealDatatype);
    }
    expect([...seen].sort()).toEqual(['calendar-event', 'email-message', 'pipeline-deal']);
  });

  it('bounds the follow-up ladder so outreach cannot become unbounded', async () => {
    const result = await loadPack();
    const inputs = object(result.triggerPack?.inputs);
    const maxFollowUps = object(object(inputs.properties).maxFollowUps);
    expect(maxFollowUps.maximum).toBe(4);
    expect(maxFollowUps.default).toBe(2);

    const target = result.triggerPack?.targets.find((t) => t.id === 'no-reply-follow-up');
    expect(target?.kind).toBe('plan');
    if (target?.kind !== 'plan') return;
    const ladder = object(object(target.inputSchema.properties).maxFollowUps);
    expect(ladder.maximum).toBe(4);
  });

  it('declares a storm policy on the pack and on the broad inbound-mail binding', async () => {
    const result = await loadPack();
    expect(Number(result.triggerPack?.defaultStormPolicy?.maxRuns)).toBeGreaterThan(0);
    expect(Number(result.triggerPack?.defaultStormPolicy?.windowSeconds)).toBeGreaterThan(0);
    const inbound = result.triggerPack?.bindings.find(
      (b) => b.id === 'investor-reply-to-pipeline',
    );
    expect(Number(inbound?.stormPolicy?.maxRuns)).toBeGreaterThan(0);
  });

  it('never lets the agent grant its own approval', () => {
    // The first-touch plan is the only template that writes `outreachApproval`. It must REQUEST
    // approval and must carry the explicit prohibition on granting it, because an agent that can
    // write `approved` makes the send-approval gate decorative.
    //
    // Newlines are flattened before matching: these templates are hard-wrapped prose, and a
    // line-oriented match cannot see a phrase split across a wrap.
    const flat = readFileSync(resolve(PACK_DIR, 'plan-first-touch.md'), 'utf8').replace(/\s+/g, ' ');
    expect(flat).toContain("state: 'pending'");
    expect(flat).toMatch(/Never write .?state: 'approved'/);
    expect(flat).toContain('approval is a human act');

    // The weekly review reports on the pending queue and must not resolve it itself.
    const review = readFileSync(resolve(PACK_DIR, 'plan-weekly-review.md'), 'utf8').replace(/\s+/g, ' ');
    expect(review).toContain('The review reports; it never approves');
    expect(review).toContain('Do not mutate any deal from this plan');
  });

  it('routes deliberate outreach through manual bindings, never an external trigger', async () => {
    const result = await loadPack();
    const manualIds = (result.triggerPack?.bindings ?? [])
      .filter((b) => b.source.kind === 'manual')
      .map((b) => b.id)
      .sort();
    // A first touch and a weekly review are always deliberate acts, never event-driven ones.
    expect(manualIds).toContain('first-touch-outreach');
    expect(manualIds).toContain('weekly-review');
  });

  it('ships every binding disarmed', async () => {
    const result = await loadPack();
    expect(result.triggerPack?.bindings.every((b) => !('armed' in b))).toBe(true);
  });
});

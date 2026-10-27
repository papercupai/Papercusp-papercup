/**
 * coord:presence argument discoverability contract (EI-20231966513487176).
 *
 * `plan` and `include_stale` were removed intentionally; `ownerId` remains as a
 * compatibility alias for the canonical singular `owner` selector. Plan-scoped
 * reads belong to the claims lens, and the full stale-roster dump was a payload
 * and liveness footgun. The live tool must say that plainly and point callers at
 * the bounded replacement lenses, otherwise callers reconstruct the removed shape
 * and spend a failed round-trip learning the replacement.
 *
 * `ownerIds` MOVED from removed to alias (2026-08-30, presence.ts +28/-4): it is
 * now the documented compatibility alias for the bounded `owners` selector, the
 * exact parallel of `ownerId` -> `owner`, with mutual-exclusion validation and
 * normalization to the canonical selector before lookup. This file pinned the
 * older removal decision and was not updated with that change, so the two halves
 * disagreed: the schema assertion below failed while the guidance assertion above
 * PASSED FOR THE WRONG REASON — it only requires the description to mention the
 * key, which a sentence introducing it as a valid alias satisfies just as well as
 * one naming it removed. Both are re-pinned to the alias contract here, so the
 * guard cannot be satisfied by a bare mention again.
 */
import { describe, expect, it } from 'vitest';
import tool from './presence';

/**
 * The surface a CALLER actually reads: the description, the guidance, AND the per-arg
 * descriptions.
 *
 * 2026-09-02 (5ef04d2b48): the description was COMPRESSED for the prompt-weight gate and
 * several facts this file pins moved onto the args where they belong — `owner` is singular
 * became "`owner`/`ownerId` targets one agent", and the alias sentences moved onto `ownerId`
 * and `ownerIds` themselves. Nothing was lost to the caller (an arg description is projected
 * in the schema and printed in the rejection), but this guard concatenated only description +
 * guidance, so it reported the move as a removal. That is a guard measuring the wrong surface,
 * not a regression — widening it here keeps the assertions strict while letting a fact be
 * documented wherever it is most useful, which is what the weight gate will keep forcing.
 */
function callerVisibleSurface(): string {
  // WI-6554700010029664: args is a preprocess pipe (ownerId/ownerIds fold); `out` is the object.
  const shape = (tool as { args: { out: { shape: Record<string, { description?: string }> } } }).args.out.shape;
  const argText = Object.entries(shape)
    .map(([key, field]) => `${key}: ${field?.description ?? ''}`)
    .join('\n');
  return `${tool.description}\n${JSON.stringify(tool.guidance ?? {})}\n${argText}`;
}

describe('coord:presence argument discoverability (EI-20231966513487176)', () => {
  it('documents the singular owner lookup and the bounded multi-owner lens', () => {
    const guidance = callerVisibleSurface();

    // Both halves of the singular-vs-bounded contract, asserted separately so a wording
    // change cannot satisfy one while silently dropping the other.
    expect(guidance).toMatch(/`owner`(?:\/`ownerId`)? targets one agent/i);
    expect(guidance).toMatch(/`owners`(?:\/`ownerIds`)? a bounded set/i);
    expect(guidance).toMatch(/coord:roster \{ view:'live', project:'ids' \}/i);
    expect(guidance).toMatch(/plan-scoped.*coord:roster \{ view:'claims', plan \}.*fleet:assignments \{ plan \}/i);
    expect(guidance).toMatch(/scope\/pot/i);
    expect(guidance).toMatch(/(?:explicit scope|widen)/i);
    expect(guidance).toMatch(/legacy/i);
    // WI-6554700010029664: ownerId/ownerIds are folded before parse (accepted, no longer
    // advertised), so pin the BEHAVIOUR instead of their old field descriptions.
    expect((tool as { args: { parse(v: unknown): unknown } }).args.parse({ ownerId: 'su-a' })).toEqual({ owner: 'su-a' });
    expect((tool as { args: { parse(v: unknown): unknown } }).args.parse({ ownerIds: ['su-a'] })).toEqual({ owners: ['su-a'] });
    for (const removed of ['harness', 'plan', 'includeStale', 'include_stale']) {
      expect(guidance, `guidance must name removed ${removed}`).toContain(removed);
    }
    expect(guidance).toMatch(/(?:do not pass|invalid)/i);
  });

  it('keeps removed legacy filters out of the declared schema', () => {
    const keys = Object.keys((tool as { args: { out: { shape: Record<string, unknown> } } }).args.out.shape);

    expect(keys).toContain('owner');
    expect(keys).toContain('owners');
    // WI-6554700010029664: the compatibility aliases are folded before parse instead of
    // declared (tool-alias-contract FOLDED_ARG_ALIASES pins that they stay accepted).
    expect(keys).not.toContain('ownerId');
    expect(keys).not.toContain('ownerIds');
    expect(keys).toContain('probe_coupling_reader');
    for (const removed of ['harness', 'plan', 'includeStale', 'include_stale']) {
      expect(keys, `${removed} must remain removed`).not.toContain(removed);
    }
  });

  it('discloses the hive-scoped workspace clamp and targeted-owner alternative', () => {
    const guidance = callerVisibleSurface();

    expect(guidance).toContain("scope:'workspace'");
    expect(guidance).toMatch(/hive-scoped SU session.*hive_forbidden/i);
    // Split from one cross-sentence regex into the two facts it was really asserting: the
    // description states the redirect, and `scope`'s own arg description names the target.
    // A single `.*` chain could not survive them landing on different lines.
    expect(guidance).toMatch(/use targeted owner/i);
    expect(guidance).toMatch(/use owner for one workspace peer/i);
    // Order-independent: the compression flipped this clause to "workspace-wide browsing
    // needs an unscoped/admin session", which an ordered `.*` chain reported as missing.
    expect(guidance).toMatch(/workspace-wide browsing needs an unscoped\/admin session/i);
  });

  it('documents the private, superuser-only relation-reader probe', () => {
    expect(callerVisibleSurface()).toMatch(/probe_coupling_reader[^\n]*SUPERUSER-only/i);
    expect(callerVisibleSurface()).toMatch(/per-stage timings in private invocation metadata/i);
    expect(callerVisibleSurface()).toMatch(/Returns no peer data/i);
  });
});

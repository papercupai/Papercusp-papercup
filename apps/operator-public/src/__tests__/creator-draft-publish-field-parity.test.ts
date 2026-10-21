/**
 * THE SECOND PUBLISH PATH (WI-10001747, class fix).
 *
 * WHY THIS FILE EXISTS — read before changing it.
 *
 * `harnesses` rows are created by TWO routes, not one:
 *
 *   1. POST /listings            — the operator's direct publish (listings.ts)
 *   2. POST /admin/creator-drafts/:id/review {decision:'approve'}
 *                                — the reviewed creator-draft publish
 *                                  (creator-drafts.ts)
 *
 * Route 1 is heavily tested. Route 2 hand-maps the draft manifest into
 * `insertHarness` field by field, and a field nobody remembers to add there is
 * dropped in SILENCE: the publish succeeds, the row is created, the column is
 * just NULL. It typechecks, because every manifest field is optional.
 *
 * That is exactly what happened to `uses_tools`. The original WI-10001747 defect
 * (operator sent `provides_tools` for kind='recipe'; the Worker refused it) was
 * fixed on route 1 and verified end-to-end by a real publish — while route 2
 * still had no `uses_tools` mapping at all. Same root cause, second instance,
 * invisible for the same reason: nothing compared the two paths.
 *
 * So this file guards the CLASS, not the instance:
 *
 *   - `carries uses_tools` drives the REAL route-2 lifecycle and asserts the
 *     column survives approval. That is the instance.
 *   - `every listings column is decided for drafts` compares the two call sites
 *     at source level. A column added to route 1 must be either mapped by
 *     route 2 or named in DRAFTS_DO_NOT_CARRY with a reason. Silence fails.
 *     That is the class, and it is the half that catches the NEXT field.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildApi } from '../routes/index.ts';
import { makeEnv, stubGithub } from './fake-d1.ts';

const ROUTES = new URL('../routes/', import.meta.url);

/**
 * Columns route 1 writes that route 2 deliberately does NOT. Each is a
 * capability a reviewed creator draft genuinely lacks — not an oversight.
 * Adding a name here is a DECISION; the point of the guard is that the decision
 * has to be made explicitly instead of by forgetting.
 */
const DRAFTS_DO_NOT_CARRY: Record<string, string> = {
  // Channel-2 publisher attestation: bound to the publishing DEVICE at POST
  // time. A draft is reviewed and published by an operator on another machine,
  // so there is no device identity to carry.
  publisher_device_pubkey: 'device-bound at direct-publish time; no draft equivalent',
  publisher_attestation_gist_id: 'device-bound at direct-publish time; no draft equivalent',
  // Catalog/commerce axes (migration 018 / P-008): not offered on the draft
  // surface. A creator draft publishes a public, unpriced listing.
  visibility: 'draft publishes public; no visibility control on the draft surface',
  tenant_id: 'private-visibility scoping only; drafts are public',
  sku_ref: 'commerce axis not offered on the draft surface',
  pricing_model: 'commerce axis not offered on the draft surface',
  price_amount_micros: 'commerce axis not offered on the draft surface',
  price_currency: 'commerce axis not offered on the draft surface',
  compatibility_json: 'compatibility axis not offered on the draft surface',
  required_permissions: 'permission axis not offered on the draft surface',
  // Signed release block (D-045 / identities-v1 D-074): prepared and signed by
  // the publisher's own key during a direct publish. A draft carries an
  // uploaded artifact instead, with its own content-hash validation.
  release_version: 'signed release block belongs to direct publish; drafts upload an artifact',
  release_content_hash: 'signed release block belongs to direct publish; drafts upload an artifact',
  release_manifest_digest: 'signed release block belongs to direct publish; drafts upload an artifact',
  release_signature: 'signed release block belongs to direct publish; drafts upload an artifact',
  release_manifest: 'signed release block belongs to direct publish; drafts upload an artifact',
  release_published_at: 'signed release block belongs to direct publish; drafts upload an artifact',
  // Content pins (migration 028): resolved from the GitHub tree at direct-publish
  // time. A draft's identity is its uploaded artifact hash, not a repo pin.
  pinned_commit_sha: 'repo pin resolved at direct-publish time; a draft pins its artifact hash',
  pinned_tree_digest: 'repo pin resolved at direct-publish time; a draft pins its artifact hash',
  pinned_at: 'repo pin resolved at direct-publish time; a draft pins its artifact hash',
  // (migration 038 / P-008's approved_commit_sha / approved_tree_digest /
  // approved_at are deliberately NOT listed: they are written ONLY by the
  // operator review approve path, so NEITHER publish path's INSERT names them
  // — the class guard below flags a name here the direct publish never writes.)
  // Worker-computed recipe authority (migration 039 / P-007): derived by the
  // Worker's static analysis of the PINNED repo content (the recipe script
  // inside the resolved commit tree) at direct-publish time. A draft publishes
  // an uploaded artifact whose identity is its content hash and which has no
  // repo tree to analyse, so the honest value is NULL = "not analyzed by the
  // Worker" — never a fabricated verdict. A draft's authority claim (if any)
  // stays the publisher's own and is NOT upgraded to a Worker-verified one.
  authority_unresolved: 'Worker-computed from the pinned repo tree; a draft has no repo pin, NULL = not analyzed',
  authority_unresolved_cause: 'Worker-computed from the pinned repo tree; a draft has no repo pin, NULL = not analyzed',
  // Optional provenance badge (migration 041 / P-010): set from a Sigstore attestation bound
  // to the PINNED repo tree at direct-publish time. A draft publishes an uploaded artifact
  // with no repo pin to attest, so it takes the column default 'worker' (the Worker's own
  // pin + scan is the only verification) — never a fabricated 'attestation'.
  verified_by: 'Worker-resolved from a Sigstore attestation over the pinned tree; a draft has no pin to attest, so it keeps the default worker',
  // Identity facet (migration 035 / portable-identity-packages P-016): the
  // declared surface is DERIVED from the signed release closure at direct
  // publish. A draft has no signed closure, so creator-drafts refuses
  // blueprint_kind 'identity' outright rather than landing one without it.
  identity_surface: 'derived from the signed release closure; drafts refuse blueprint_kind identity',
  // Type-pack declarations (migration 049 / plan-item-types-registry-cupboard P-006, D-008):
  // derived from the pack manifest's typePack block, or the plan template's type: frontmatter,
  // in the repo tree a direct publish pins. A type pack installs only from that content pin, so
  // a draft (an uploaded artifact with no repo pin) cannot publish one: its columns stay NULL,
  // and the installer refuses a pack whose manifest carries types its listing does not declare.
  provides_item_types: 'derived from the pinned repo manifest; type packs install from a content pin a draft lacks',
  provides_plan_types: 'derived from the pinned repo manifest; type packs install from a content pin a draft lacks',
  requires_plan_type: 'derived from the template type: frontmatter at direct publish; a draft template requires no plan type',
};

/**
 * The column names a route passes to `insertHarness`, read from the real call
 * site. Re-typing either list here is what would let the two drift apart again:
 * the guard has to MEASURE both sides, not agree with them by assumption.
 */
function insertHarnessColumns(file: string): Set<string> {
  const src = readFileSync(new URL(file, ROUTES), 'utf8');
  const call = src.indexOf('insertHarness(');
  if (call < 0) {
    throw new Error(
      `${file} no longer calls insertHarness. This is the SOURCE half of a two-path ` +
        `parity guard — repair the extractor to find the new write site rather than ` +
        `deleting this test, or the second publish path becomes invisible again ` +
        `(WI-10001747).`,
    );
  }
  const start = src.indexOf('{', call);
  let depth = 0;
  let end = -1;
  for (let p = start; p < src.length; p++) {
    if (src[p] === '{') depth++;
    else if (src[p] === '}' && --depth === 0) {
      end = p;
      break;
    }
  }
  if (end < 0) throw new Error(`${file}: unbalanced insertHarness object literal`);
  const body = src.slice(start, end + 1);
  const cols = new Set<string>();
  for (const m of body.matchAll(/^\s{6,8}([a-z_][a-z0-9_]*)\s*:/gm)) cols.add(m[1]);
  return cols;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return `sha256:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const USES_TOOLS = ['rubrics:get', 'scorecards:list'];

describe('creator-draft publish ↔ direct publish: column parity', () => {
  // Positive control for the instrument. Both extractors must return a
  // plausible column set; a silently-empty one would make the parity assertion
  // below pass vacuously, which is the failure mode this whole file is about.
  it('reads a column set out of BOTH publish call sites', () => {
    const listings = insertHarnessColumns('listings.ts');
    const drafts = insertHarnessColumns('creator-drafts.ts');
    expect(listings.size).toBeGreaterThan(20);
    expect(drafts.size).toBeGreaterThan(20);
    for (const anchor of ['listing_kind', 'github_url', 'title', 'provides_tools']) {
      expect(listings.has(anchor), `listings should write ${anchor}`).toBe(true);
      expect(drafts.has(anchor), `creator-drafts should write ${anchor}`).toBe(true);
    }
  });

  it('THE CLASS: every column the direct publish writes is DECIDED for the draft publish', () => {
    const listings = insertHarnessColumns('listings.ts');
    const drafts = insertHarnessColumns('creator-drafts.ts');

    const undecided = [...listings].filter((c) => !drafts.has(c) && !(c in DRAFTS_DO_NOT_CARRY));

    expect(
      undecided,
      `POST /listings writes ${undecided.join(', ')} but the creator-draft approve path does ` +
        `not, and no decision is recorded. A creator-published listing would land with ` +
        `${undecided.length === 1 ? 'that column' : 'those columns'} NULL and nothing would ` +
        `report it. Either map it in creator-drafts.ts, or add it to DRAFTS_DO_NOT_CARRY with ` +
        `the reason a draft cannot carry it. This is WI-10001747's root cause recurring on the ` +
        `second publish path.`,
    ).toEqual([]);

    // The allowlist must not outlive its subject: a name left here after the
    // column is gone (or after drafts started carrying it) reads as a decision
    // when it is really dead text.
    const stale = Object.keys(DRAFTS_DO_NOT_CARRY).filter((c) => !listings.has(c) || drafts.has(c));
    expect(
      stale,
      `DRAFTS_DO_NOT_CARRY names ${stale.join(', ')}, which the direct publish no longer writes ` +
        `(or which creator-drafts now DOES carry). Remove the stale entries.`,
    ).toEqual([]);
  });

  it('THE INSTANCE: a reviewed creator draft carries uses_tools through to the listing', async () => {
    const api = buildApi();
    const { env, store } = makeEnv({ CUPBOARD_OPERATOR_GITHUB_IDS: '2' });
    const bytes = new TextEncoder().encode('recipe artifact');
    const contentHash = await sha256(bytes);
    stubGithub({ user: { id: 1, login: 'alice' } });

    const create = await api.request(
      '/creator-drafts',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manifest: {
            listing_kind: 'recipe',
            listing_ref: 'drafted-recipe',
            github_repository_id: 91,
            github_owner: 'alice',
            github_name: 'drafted-recipe',
            github_url: 'https://github.com/alice/drafted-recipe',
            title: 'Drafted recipe',
            description: 'published via the creator-draft review path',
            uses_tools: USES_TOOLS,
            artifact: {
              content_hash: contentHash,
              size_bytes: bytes.byteLength,
              content_type: 'application/octet-stream',
            },
          },
        }),
      },
      env,
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: string; upload_url: string };

    expect((await api.request(created.upload_url, { method: 'PUT', body: bytes }, env)).status).toBe(200);
    expect(
      (
        await api.request(
          `/creator-drafts/${created.id}/submit`,
          { method: 'POST', headers: { Authorization: 'Bearer owner' } },
          env,
        )
      ).status,
    ).toBe(200);

    stubGithub({ user: { id: 2, login: 'maintainer' } });
    const review = await api.request(
      `/admin/creator-drafts/${created.id}/review`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer maintainer', 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      },
      env,
    );
    expect(review.status).toBe(200);
    expect((await review.json() as { state: string }).state).toBe('published');

    expect(store.tables.harnesses).toHaveLength(1);
    const row = store.tables.harnesses[0];
    // The pre-fix observable was `null` here: publish OK, listing created, tool
    // axis silently gone.
    expect(
      row.uses_tools,
      'the approved draft landed without its uses_tools — the creator-draft publish path ' +
        'dropped the tool axis again (WI-10001747)',
    ).toBe(JSON.stringify(USES_TOOLS));
    // Provision is a different axis and must NOT be filled in by the fix.
    expect(row.provides_tools).toBe(null);
  });
});

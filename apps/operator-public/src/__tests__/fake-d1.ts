/**
 * Shared in-memory D1 + KV + GitHub-fetch fakes for the Cupboard worker tests.
 *
 * The store interprets the exact SQL the db.ts helpers emit — it is not a real
 * SQL engine, it pattern-matches the known statements and consumes their binds
 * positionally. Keep it in sync with db.ts when statements change.
 */

import type { Env } from '../env.ts';

export interface Row {
  [key: string]: unknown;
}

class FakeStmt {
  constructor(
    private sql: string,
    private store: FakeStore,
    private binds: unknown[] = [],
  ) {}
  bind(...values: unknown[]): FakeStmt {
    return new FakeStmt(this.sql, this.store, values);
  }
  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const changes = this.store.execute(this.sql, this.binds);
    return { success: true, meta: { changes } };
  }
  async first<T = Row>(): Promise<T | null> {
    const rows = this.store.query(this.sql, this.binds);
    return (rows[0] as T) ?? null;
  }
  async all<T = Row>(): Promise<{ results: T[]; success: true }> {
    const rows = this.store.query(this.sql, this.binds);
    return { results: rows as T[], success: true };
  }
}

/** A fully-defaulted harness/listing row; override what a test cares about. */
export function makeListingRow(over: Partial<Row> = {}): Row {
  return {
    id: 'seed',
    listing_kind: 'harness',
    project_ref: null,
    listing_ref: null,
    github_repository_id: 1,
    github_owner: 'a',
    github_name: 'b',
    github_url: 'https://github.com/a/b',
    title: 'T',
    description: null,
    topic_hex: 'a'.repeat(64),
    publisher_github_user_id: 1,
    publisher_github_login: 'alice',
    publisher_permission: null,
    publisher_device_pubkey: null,
    publisher_attestation_gist_id: null,
    provides_tools: null,
    uses_tools: null,        // migration 033 (tool axis — consumer half, WI-10001747)
    provides_events: null,   // migration 012 (event dependency axis — provider half)
    requires_events: null,   // migration 013 (event dependency axis — consumer half)
    requires_rubrics: null,  // migration 015 (rubric dependency axis — consumer half)
    provides_item_types: null,  // migration 049 (type packs)
    provides_plan_types: null,  // migration 049 (type packs)
    requires_plan_type: null,   // migration 049 (type packs)
    hive_pubkey: null,
    hive_title: null,
    blueprint_kind: null,
    claim_status: 'unclaimed',
    claimant_github_user_id: null,
    claimant_github_login: null,
    superseded_by: null,
    stars: 0,
    contributor_count: 0,
    last_activity_at: null,
    languages: null,
    stats_refreshed_at: null,
    created_at: 1,
    updated_at: 1,
    unlisted_at: null,
    unlisted_reason: null,
    // migration 008 (knowledge-packs): pre-publication review fields.
    review_status: 'approved',
    reviewed_at: null,
    review_reason: null,
    // migration 014 (cupboard-app-distribution): app-only distribution columns.
    delivery_type: null,
    latest_json_url: null,
    release_repo: null,
    icon_url: null,
    platforms: null,
    // migration 018 (shared-pot-dao-cupboard-v1 P-008): catalog axes.
    // `visibility` mirrors the column's NOT NULL DEFAULT 'public', so a row a
    // test does not opt into stays browsable exactly as it did pre-018.
    visibility: 'public',
    tenant_id: null,
    sku_ref: null,
    pricing_model: null,
    price_amount_micros: null,
    price_currency: null,
    compatibility_json: null,
    required_permissions: null,
    release_version: null,
    release_content_hash: null,
    release_manifest_digest: null,
    release_signature: null,
    identity_surface: null,
    release_published_at: null,
    pinned_commit_sha: null,
    pinned_tree_digest: null,
    pinned_at: null,
    approved_commit_sha: null,
    approved_tree_digest: null,
    approved_at: null,
    authority_unresolved: null,
    authority_unresolved_cause: null,
    // migration 041 (P-010): the optional provenance badge; 'worker' is the NOT NULL default.
    verified_by: 'worker',
    drift: 0,
    yanked_at: null,
    yanked_reason: null,
    revoked_at: null,
    revoked_reason: null,
    ...over,
  };
}

/**
 * Map an `INSERT INTO <table> (cols…) VALUES (…)` statement's binds onto their
 * COLUMN NAMES, by reading the column list out of the SQL itself.
 *
 * This replaces the positional destructure this file used from migration 004 to
 * 017 — the coupling `insert-bind-alignment.test.ts` was written to guard after
 * migration 015 shifted every field past position 20 and silently disabled the
 * publish review gate in every test that exercised it. An arity guard catches a
 * mid-list INSERTION but not a same-arity reorder or rename, and it only fires
 * once the damage is already written. Reading the names from the statement
 * removes the coupling instead of policing it: db.ts can add, reorder, or rename
 * a column and this fake follows automatically (P-008 / the follow-up filed in
 * that test's own header).
 *
 * The VALUES tuple may contain literals as well as placeholders (insertHarness
 * writes `'unclaimed'` inline for claim_status), so the walk consumes a bind
 * only for a `?` and takes the literal otherwise — which is why a naive
 * `columns[i] = binds[i]` zip would be wrong here.
 */
export function mapInsertBindsByName(sql: string, binds: unknown[]): Row {
  const match = /INSERT\s+INTO\s+\w+\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*?)\)\s*$/i.exec(sql.trim());
  if (!match) throw new Error(`fake-d1: unparseable INSERT statement: ${sql.slice(0, 120)}`);
  const columns = match[1].split(',').map((c) => c.trim()).filter(Boolean);
  const values = match[2].split(',').map((v) => v.trim()).filter(Boolean);
  if (columns.length !== values.length) {
    throw new Error(
      `fake-d1: INSERT column/value arity mismatch (${columns.length} columns, ${values.length} values)`,
    );
  }
  const row: Row = {};
  let bindIndex = 0;
  for (let i = 0; i < columns.length; i += 1) {
    const value = values[i];
    if (value === '?') {
      if (bindIndex >= binds.length) {
        throw new Error(`fake-d1: INSERT needs more binds than supplied (${binds.length})`);
      }
      row[columns[i]] = binds[bindIndex++];
    } else if (/^'.*'$/.test(value)) {
      row[columns[i]] = value.slice(1, -1);
    } else if (/^NULL$/i.test(value)) {
      row[columns[i]] = null;
    } else {
      row[columns[i]] = Number.isNaN(Number(value)) ? value : Number(value);
    }
  }
  if (bindIndex !== binds.length) {
    throw new Error(
      `fake-d1: INSERT consumed ${bindIndex} of ${binds.length} binds — placeholder/bind mismatch`,
    );
  }
  return row;
}

/**
 * Apply the migration-018 catalog half of the public list predicate
 * (`appendCatalogPredicate` in db.ts), consuming its binds in the SAME order.
 *
 * Returns the filtered rows and the advanced bind index, because the summary CTE
 * reads one more bind (the matched kind) after this block.
 *
 * ⚠ The narrowing `tenant_ref` and the widening `tenant_scope` both emit
 * `h.tenant_id = ?`, so they are told apart by the OPERATOR that precedes them —
 * `AND h.tenant_id = ?` for the filter, `OR h.tenant_id = ?` inside the
 * visibility-scope disjunction. Confusing the two here would make the fake agree
 * with a tenant leak instead of catching one.
 */
function applyCatalogPredicate(
  upper: string,
  binds: unknown[],
  startIndex: number,
  rows: Row[],
): { rows: Row[]; index: number } {
  let i = startIndex;
  let out = rows;
  if (upper.includes('H.VISIBILITY = ?')) {
    const visibility = binds[i++];
    out = out.filter((r) => r.visibility === visibility);
  }
  if (upper.includes('AND H.TENANT_ID = ?')) {
    const tenant = binds[i++];
    out = out.filter((r) => r.tenant_id === tenant);
  }
  if (upper.includes('H.PRICING_MODEL = ?')) {
    const pricing = binds[i++];
    out = out.filter((r) => r.pricing_model === pricing);
  }
  const priced = (r: Row) =>
    r.sku_ref != null && r.pricing_model != null && r.pricing_model !== 'free';
  if (upper.includes("H.PRICING_MODEL != 'FREE'")) out = out.filter(priced);
  else if (upper.includes("H.PRICING_MODEL = 'FREE'")) out = out.filter((r) => !priced(r));
  if (upper.includes('JSON_EXTRACT(H.COMPATIBILITY_JSON')) {
    const runtime = binds[i++];
    out = out.filter((r) => parseJsonField(r.compatibility_json)?.runtime === runtime);
  }
  if (upper.includes("JSON_EACH(H.COMPATIBILITY_JSON, '$.PLATFORMS')")) {
    const platform = binds[i++];
    out = out.filter((r) => {
      const platforms = parseJsonField(r.compatibility_json)?.platforms;
      return Array.isArray(platforms) && platforms.includes(platform);
    });
  }
  if (upper.includes('JSON_EACH(H.REQUIRED_PERMISSIONS)')) {
    const permission = binds[i++];
    out = out.filter((r) => {
      const perms = parseJsonField(r.required_permissions);
      return Array.isArray(perms) && perms.includes(permission);
    });
  }
  if (upper.includes('OR H.TENANT_ID = ?')) {
    const scope = binds[i++];
    out = out.filter((r) => r.visibility === 'public' || r.tenant_id === scope);
  } else if (upper.includes("H.VISIBILITY = 'PUBLIC'")) {
    out = out.filter((r) => r.visibility === 'public');
  }
  if (upper.includes('H.YANKED_AT IS NULL')) out = out.filter((r) => r.yanked_at == null);
  if (upper.includes('H.REVOKED_AT IS NULL')) out = out.filter((r) => r.revoked_at == null);
  return { rows: out, index: i };
}

/** Tolerant JSON column read: a malformed value filters like an absent one,
 *  matching the `json_valid()` guard the real predicate carries. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseJsonField(raw: unknown): any {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export class FakeStore {
  tables: Record<string, Row[]> = {
    harnesses: [],
    creator_drafts: [],
    reports: [],
    publish_rate_limit: [],
    indexer_runs: [],
    audit: [],
    banned_publisher_pubkeys: [],
  };

  execute(sql: string, binds: unknown[]): number {
    const upper = sql.trim().toUpperCase();
    if (upper.startsWith('INSERT INTO CREATOR_DRAFTS')) {
      const [
        id, owner_github_user_id, owner_github_login, listing_kind, listing_ref,
        title, description, manifest_json, provenance_json, upload_token_hash,
        upload_expires_at, created_at, updated_at,
      ] = binds;
      this.tables.creator_drafts.push({
        id, owner_github_user_id, owner_github_login, listing_kind, listing_ref,
        title, description, manifest_json, provenance_json, state: 'draft',
        artifact_key: null, artifact_content_hash: null, artifact_size_bytes: null,
        artifact_content_type: null, upload_token_hash, upload_expires_at,
        reviewed_at: null, reviewed_by_github_user_id: null, review_reason: null,
        published_listing_id: null, created_at, updated_at,
      });
      return 1;
    }
    if (upper.startsWith('UPDATE CREATOR_DRAFTS') && upper.includes('SET ARTIFACT_KEY')) {
      const [artifact_key, artifact_hash, artifact_size, artifact_type, updated_at, id] = binds;
      const row = this.tables.creator_drafts.find((r) => r.id === id && r.state === 'draft');
      if (!row) return 0;
      Object.assign(row, {
        artifact_key,
        artifact_content_hash: artifact_hash,
        artifact_size_bytes: artifact_size,
        artifact_content_type: artifact_type,
        upload_token_hash: null,
        upload_expires_at: null,
        updated_at,
      });
      return 1;
    }
    if (upper.startsWith('UPDATE CREATOR_DRAFTS') && upper.includes('SET STATE')) {
      const [state, reviewed_at, reviewed_by, review_reason, published_listing_id, updated_at, id, from] = binds;
      const row = this.tables.creator_drafts.find((r) => r.id === id && r.state === from);
      if (!row) return 0;
      row.state = state;
      if (reviewed_at != null) row.reviewed_at = reviewed_at;
      if (reviewed_by != null) row.reviewed_by_github_user_id = reviewed_by;
      if (review_reason != null) row.review_reason = review_reason;
      if (published_listing_id != null) row.published_listing_id = published_listing_id;
      row.updated_at = updated_at;
      return 1;
    }
    if (upper.startsWith('INSERT INTO HARNESSES')) {
      // BY NAME, not by position: the column list is read out of the statement
      // itself (see mapInsertBindsByName). db.ts may add, reorder, or rename a
      // column in insertHarness() and this fake follows — the silent field-shift
      // class that migration 015 hit is structurally gone, not merely guarded.
      const written = mapInsertBindsByName(sql, binds);
      this.tables.harnesses.push(
        makeListingRow({
          ...written,
          // Column defaults the INSERT leaves to the schema.
          listing_kind: written.listing_kind ?? 'harness',
          review_status: written.review_status ?? 'approved',
          visibility: written.visibility ?? 'public',
        }),
      );
      return 1;
    }
    // setReviewStatus (migration 008 / knowledge-packs P-019).
    if (upper.startsWith('UPDATE HARNESSES') && upper.includes('SET REVIEW_STATUS')) {
      const [review_status, reviewed_at, review_reason, updated_at, id] = binds;
      const row = this.tables.harnesses.find((r) => r.id === id);
      if (row) {
        row.review_status = review_status;
        row.reviewed_at = reviewed_at;
        row.review_reason = review_reason;
        row.updated_at = updated_at;
        return 1;
      }
      return 0;
    }
    if (upper.startsWith('UPDATE HARNESSES') && upper.includes("CLAIM_STATUS = 'SUPERSEDED'")) {
      const [successor, unlisted_at, reason, updated_at, id] = binds;
      const row = this.tables.harnesses.find((r) => r.id === id && r.unlisted_at == null);
      if (!row) return 0;
      Object.assign(row, {
        superseded_by: successor,
        claim_status: 'superseded',
        unlisted_at,
        unlisted_reason: reason,
        updated_at,
      });
      return 1;
    }
    if (upper.startsWith('UPDATE HARNESSES') && upper.includes('SET UNLISTED_AT')) {
      const [unlisted_at, unlisted_reason, updated_at, id] = binds;
      const row = this.tables.harnesses.find((r) => r.id === id);
      if (row) {
        row.unlisted_at = unlisted_at;
        row.unlisted_reason = unlisted_reason;
        row.updated_at = updated_at;
        return 1;
      }
      return 0;
    }
    if (upper.includes("CLAIM_STATUS = 'CLAIMED'")) {
      const [claimant_user_id, claimant_login, updated_at, id] = binds;
      const row = this.tables.harnesses.find((r) => r.id === id);
      if (row) {
        row.claim_status = 'claimed';
        row.claimant_github_user_id = claimant_user_id;
        row.claimant_github_login = claimant_login;
        row.updated_at = updated_at;
        return 1;
      }
      return 0;
    }
    if (upper.startsWith('UPDATE HARNESSES') && upper.includes('SET STARS')) {
      const [stars, contributor_count, last_activity_at, languages, refreshed, updated_at, id] = binds;
      const row = this.tables.harnesses.find((r) => r.id === id);
      if (row) {
        row.stars = stars;
        row.contributor_count = contributor_count;
        row.last_activity_at = last_activity_at;
        row.languages = languages;
        row.stats_refreshed_at = refreshed;
        row.updated_at = updated_at;
        return 1;
      }
      return 0;
    }
    if (upper.startsWith('UPDATE HARNESSES') && upper.includes('PUBLISHER_DEVICE_PUBKEY = NULL')) {
      const [updated_at, id] = binds;
      const row = this.tables.harnesses.find((r) => r.id === id);
      if (row) {
        row.publisher_device_pubkey = null;
        row.publisher_attestation_gist_id = null;
        row.updated_at = updated_at;
        return 1;
      }
      return 0;
    }
    if (upper.startsWith('INSERT INTO REPORTS')) {
      const [id, harness_id, reporter_user_id, reporter_login, reason, ip_hash, created_at] = binds;
      this.tables.reports.push({
        id, harness_id, reporter_github_user_id: reporter_user_id,
        reporter_github_login: reporter_login, reason, ip_hash,
        status: 'pending', resolved_at: null,
        resolved_by_operator_note: null, created_at,
      });
      return 1;
    }
    if (upper.startsWith('UPDATE REPORTS')) {
      const [status, resolved_at, note, id] = binds;
      const row = this.tables.reports.find((r) => r.id === id && r.status === 'pending');
      if (row) {
        row.status = status;
        row.resolved_at = resolved_at;
        row.resolved_by_operator_note = note;
        return 1;
      }
      return 0;
    }
    if (upper.startsWith('INSERT INTO PUBLISH_RATE_LIMIT')) {
      const [user_id, window_start] = binds;
      const existing = this.tables.publish_rate_limit.find(
        (r) => r.github_user_id === user_id && r.window_start === window_start,
      );
      if (existing) {
        existing.count = (existing.count as number) + 1;
      } else {
        this.tables.publish_rate_limit.push({ github_user_id: user_id, window_start, count: 1 });
      }
      return 1;
    }
    if (upper.startsWith('INSERT INTO AUDIT')) {
      const [ts, kind, detail] = binds;
      this.tables.audit.push({ ts, kind, detail });
      return 1;
    }
    if (upper.startsWith('INSERT INTO BANNED_PUBLISHER_PUBKEYS')) {
      const [pubkey, reason, added_at, op_id, updated_at] = binds;
      const existing = this.tables.banned_publisher_pubkeys.find((r) => r.pubkey === pubkey);
      if (existing) {
        existing.reason = reason;
        existing.updated_at = updated_at;
      } else {
        this.tables.banned_publisher_pubkeys.push({
          pubkey, reason, added_at, added_by_operator_user_id: op_id ?? null, updated_at,
        });
      }
      return 1;
    }
    if (upper.startsWith('DELETE FROM BANNED_PUBLISHER_PUBKEYS')) {
      const [pubkey] = binds;
      const before = this.tables.banned_publisher_pubkeys.length;
      this.tables.banned_publisher_pubkeys = this.tables.banned_publisher_pubkeys.filter(
        (r) => r.pubkey !== pubkey,
      );
      return before - this.tables.banned_publisher_pubkeys.length;
    }
    return 0;
  }

  query(sql: string, binds: unknown[]): Row[] {
    const upper = sql.trim().toUpperCase();
    if (upper.startsWith('SELECT * FROM CREATOR_DRAFTS WHERE ID =')) {
      const [id] = binds;
      const row = this.tables.creator_drafts.find((r) => r.id === id);
      return row ? [row] : [];
    }
    if (upper.startsWith('SELECT * FROM CREATOR_DRAFTS')) {
      let i = 0;
      const owner = upper.includes('OWNER_GITHUB_USER_ID = ?') ? binds[i++] : undefined;
      const state = upper.includes('STATE = ?') ? binds[i++] : undefined;
      const hasOffset = upper.includes('OFFSET ?');
      const limit = binds[binds.length - (hasOffset ? 2 : 1)] as number;
      const offset = hasOffset ? binds[binds.length - 1] as number : 0;
      return this.tables.creator_drafts
        .filter((r) => owner == null || r.owner_github_user_id === owner)
        .filter((r) => state == null || r.state === state)
        .sort((a, b) => (b.updated_at as number) - (a.updated_at as number) || String(a.id).localeCompare(String(b.id)))
        .slice(offset, offset + limit);
    }
    if (upper.startsWith('SELECT * FROM HARNESSES WHERE ID =')) {
      const [id] = binds;
      const row = this.tables.harnesses.find((r) => r.id === id);
      return row ? [row] : [];
    }
    if (upper.startsWith('SELECT * FROM HARNESSES') && upper.includes('PUBLISHER_GITHUB_USER_ID = ?')) {
      const [publisherId] = binds;
      const limit = binds[1] as number;
      const offset = binds[2] as number;
      return this.tables.harnesses
        .filter((r) => r.publisher_github_user_id === publisherId)
        .sort((a, b) => (b.updated_at as number) - (a.updated_at as number) || String(a.id).localeCompare(String(b.id)))
        .slice(offset, offset + limit);
    }
    // getActiveListingByRefs: repo + kind + listing_ref (must precede the
    // harness-repo branch since both start with GITHUB_REPOSITORY_ID).
    if (upper.includes('AND LISTING_REF =')) {
      const [repoId, kind, ref, pin] = binds;
      const row = this.tables.harnesses.find(
        (r) =>
          r.github_repository_id === repoId &&
          r.listing_kind === kind &&
          r.listing_ref === ref &&
          r.unlisted_at == null &&
          (!upper.includes('PINNED_COMMIT_SHA') ||
            (upper.includes('PINNED_COMMIT_SHA IS NULL') ? r.pinned_commit_sha == null : r.pinned_commit_sha === pin)),
      );
      return row ? [row] : [];
    }
    // getHarnessByGithubRepoId: repo, kind='harness', active-first.
    if (upper.startsWith('SELECT * FROM HARNESSES') && upper.includes("LISTING_KIND = 'HARNESS'")) {
      const [repoId] = binds;
      const matches = this.tables.harnesses
        .filter((r) => r.github_repository_id === repoId && r.listing_kind === 'harness')
        .sort((a, b) => (a.unlisted_at == null ? 0 : 1) - (b.unlisted_at == null ? 0 : 1));
      return matches.length ? [matches[0]] : [];
    }
    // listPendingReview (migration 008): the operator's pending queue. Must
    // precede the generic list matcher (both hit UNLISTED_AT IS NULL).
    if (upper.includes("REVIEW_STATUS = 'PENDING'")) {
      const limit = binds[binds.length - 1] as number;
      return this.tables.harnesses
        .filter((r) => r.review_status === 'pending' && r.unlisted_at == null)
        .sort((a, b) => (a.created_at as number) - (b.created_at as number))
        .slice(0, limit);
    }
    // summarizePublicHarnesses: one CTE supplies exact matched total + kind facets.
    if (upper.startsWith('WITH POPULATION AS')) {
      let i = 0;
      const hasProject = upper.includes('H.PROJECT_REF = ?');
      const project = hasProject ? binds[i++] : undefined;
      const hasSearch = upper.includes('H.TITLE LIKE ?');
      const search = hasSearch ? String(binds[i++] ?? '').replaceAll('%', '').toLowerCase() : '';
      if (hasSearch) i += 3;
      const hasClaim = upper.includes('H.CLAIM_STATUS = ?');
      const claim = hasClaim ? binds[i++] : undefined;
      let rows = this.tables.harnesses.filter((r) => r.unlisted_at == null);
      if (upper.includes("REVIEW_STATUS = 'APPROVED'")) {
        rows = rows.filter((r) => r.review_status === 'approved');
      }
      if (upper.includes('NOT EXISTS (SELECT 1 FROM BANNED_PUBLISHER_PUBKEYS')) {
        const banned = new Set(this.tables.banned_publisher_pubkeys.map((r) => r.pubkey));
        rows = rows.filter((r) => !r.publisher_device_pubkey || !banned.has(r.publisher_device_pubkey));
      }
      if (hasProject) rows = rows.filter((r) => r.project_ref === project);
      if (hasClaim) rows = rows.filter((r) => r.claim_status === claim);
      if (hasSearch) {
        rows = rows.filter((r) =>
          [r.title, r.description, r.github_owner, r.github_name]
            .some((value) => String(value ?? '').toLowerCase().includes(search)),
        );
      }
      // Catalog filters bind AFTER claim and BEFORE the matched-kind bind.
      ({ rows, index: i } = applyCatalogPredicate(upper, binds, i, rows));
      const hasMatchedKind = upper.includes('FROM POPULATION WHERE LISTING_KIND = ?');
      const matchedKind = hasMatchedKind ? binds[i] : undefined;
      const total = hasMatchedKind
        ? rows.filter((r) => r.listing_kind === matchedKind).length
        : rows.length;
      const counts = new Map<unknown, number>();
      for (const row of rows) counts.set(row.listing_kind, (counts.get(row.listing_kind) ?? 0) + 1);
      return [
        { metric: 'total', value: null, n: total },
        ...[...counts.entries()].map(([value, n]) => ({ metric: 'kind', value, n })),
      ];
    }
    // listHarnesses/listPublicHarnessesPage: normalized predicate, stable order,
    // optional composite keyset cursor, and an optional pre-LIMIT publisher ban.
    if (
      (upper.startsWith('SELECT H.* FROM HARNESSES H WHERE') ||
        upper.startsWith('SELECT * FROM HARNESSES WHERE')) &&
      upper.includes('UNLISTED_AT IS NULL')
    ) {
      let i = 0;
      const hasKind = upper.includes('H.LISTING_KIND = ?') || upper.includes(' LISTING_KIND = ?');
      const kind = hasKind ? binds[i++] : undefined;
      // The blueprint facet (migrations 009/035) binds right after the kind.
      const hasBlueprintKind = upper.includes('BLUEPRINT_KIND = ?');
      const blueprintKind = hasBlueprintKind ? binds[i++] : undefined;
      const hasProject = upper.includes('H.PROJECT_REF = ?') || upper.includes(' PROJECT_REF = ?');
      const project = hasProject ? binds[i++] : undefined;
      const compositeCursor = upper.includes('H.LAST_ACTIVITY_AT = ? AND H.ID > ?');
      const nullCursor = upper.includes('H.LAST_ACTIVITY_AT IS NULL AND H.ID > ?');
      const legacyCursor = !compositeCursor && !nullCursor && upper.includes('LAST_ACTIVITY_AT < ?');
      let cursorActivity: number | null | undefined;
      let cursorId: string | undefined;
      if (compositeCursor) {
        cursorActivity = binds[i++] as number;
        i++; // repeated activity bind
        cursorId = binds[i++] as string;
      } else if (nullCursor) {
        cursorActivity = null;
        cursorId = binds[i++] as string;
      } else if (legacyCursor) {
        cursorActivity = binds[i++] as number;
      }
      const hasSearch = upper.includes('TITLE LIKE ?');
      const search = hasSearch ? String(binds[i++] ?? '').replaceAll('%', '').toLowerCase() : '';
      if (hasSearch) i += 3;
      const hasClaim = upper.includes('CLAIM_STATUS = ?');
      const claim = hasClaim ? binds[i++] : undefined;
      const limit = binds[binds.length - 1] as number;
      let rows = this.tables.harnesses.filter((r) => r.unlisted_at == null);
      if (upper.includes("REVIEW_STATUS = 'APPROVED'")) {
        rows = rows.filter((r) => r.review_status === 'approved');
      }
      if (upper.includes('NOT EXISTS (SELECT 1 FROM BANNED_PUBLISHER_PUBKEYS')) {
        const banned = new Set(this.tables.banned_publisher_pubkeys.map((r) => r.pubkey));
        rows = rows.filter((r) => !r.publisher_device_pubkey || !banned.has(r.publisher_device_pubkey));
      }
      if (hasKind) rows = rows.filter((r) => r.listing_kind === kind);
      if (hasBlueprintKind) {
        rows = rows.filter((r) => r.listing_kind === 'blueprint' && r.blueprint_kind === blueprintKind);
      }
      if (hasProject) rows = rows.filter((r) => r.project_ref === project);
      if (hasClaim) rows = rows.filter((r) => r.claim_status === claim);
      if (hasSearch) {
        rows = rows.filter((r) =>
          [r.title, r.description, r.github_owner, r.github_name]
            .some((value) => String(value ?? '').toLowerCase().includes(search)),
        );
      }
      // Catalog filters (migration 018) bind after claim; row-filter order is
      // irrelevant, but the bind index must advance in the emitted order.
      ({ rows, index: i } = applyCatalogPredicate(upper, binds, i, rows));
      if (cursorActivity !== undefined) {
        rows = rows.filter((r) => {
          const activity = r.last_activity_at as number | null;
          if (legacyCursor) return activity == null || activity < (cursorActivity as number);
          if (cursorActivity == null) return activity == null && String(r.id) > String(cursorId);
          return activity == null || activity < cursorActivity ||
            (activity === cursorActivity && String(r.id) > String(cursorId));
        });
      }
      rows.sort((a, b) => {
        const aActivity = a.last_activity_at as number | null;
        const bActivity = b.last_activity_at as number | null;
        if (aActivity == null && bActivity != null) return 1;
        if (aActivity != null && bActivity == null) return -1;
        if (aActivity != null && bActivity != null && aActivity !== bActivity) return bActivity - aActivity;
        return String(a.id).localeCompare(String(b.id));
      });
      return rows.slice(0, limit);
    }
    if (upper.startsWith('SELECT COUNT FROM PUBLISH_RATE_LIMIT')) {
      const [user_id, window_start] = binds;
      const row = this.tables.publish_rate_limit.find(
        (r) => r.github_user_id === user_id && r.window_start === window_start,
      );
      return row ? [{ count: row.count }] : [];
    }
    if (upper.startsWith('SELECT PUBKEY FROM BANNED_PUBLISHER_PUBKEYS')) {
      return this.tables.banned_publisher_pubkeys.map((r) => ({ pubkey: r.pubkey }));
    }
    if (upper.startsWith('SELECT * FROM BANNED_PUBLISHER_PUBKEYS')) {
      return [...this.tables.banned_publisher_pubkeys];
    }
    if (upper.startsWith('SELECT * FROM REPORTS WHERE ID =')) {
      const [id] = binds;
      const row = this.tables.reports.find((r) => r.id === id);
      return row ? [row] : [];
    }
    if (upper.includes('FROM REPORTS')) {
      // listReports join — return reports (optionally filtered by status).
      const filterStatus = upper.includes('WHERE R.STATUS = ?');
      let rows = [...this.tables.reports];
      if (filterStatus) rows = rows.filter((r) => r.status === binds[0]);
      return rows.map((r) => ({
        ...r,
        harness_title: this.tables.harnesses.find((h) => h.id === r.harness_id)?.title ?? null,
        harness_github_url: this.tables.harnesses.find((h) => h.id === r.harness_id)?.github_url ?? null,
        harness_unlisted_at: this.tables.harnesses.find((h) => h.id === r.harness_id)?.unlisted_at ?? null,
      }));
    }
    return [];
  }
}

export function makeDb(): { db: D1Database; store: FakeStore } {
  const store = new FakeStore();
  const db = {
    prepare(sql: string) {
      return new FakeStmt(sql, store) as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
  return { db, store };
}

export class FakeKV {
  data = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.data.get(key) ?? null; }
  async put(key: string, value: string, _opts?: unknown): Promise<void> { this.data.set(key, value); }
  async delete(key: string): Promise<void> { this.data.delete(key); }
}

interface FakeMultipartRecord {
  key: string;
  options: R2MultipartOptions;
  parts: Map<number, { bytes: Uint8Array; etag: string }>;
}

async function fakeR2Bytes(
  value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
): Promise<Uint8Array> {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return new Uint8Array(await new Response(value).arrayBuffer());
}

/**
 * In-memory R2 fake for the snapshot tarball blob store (migration 005). Covers
 * the subset the blobs/listings routes use: head/put/get/delete. `get` returns a
 * streamable body + a no-op writeHttpMetadata, matching the R2ObjectBody shape
 * the GET route consumes.
 */
export class FakeR2 {
  data = new Map<string, Uint8Array>();
  httpMetadata = new Map<string, R2HTTPMetadata>();
  customMetadata = new Map<string, Record<string, string>>();
  etags = new Map<string, string>();
  multipartUploads = new Map<string, FakeMultipartRecord>();
  multipartPartUploadCalls = 0;
  nextMultipartUploadId: string | null = null;
  nextMultipartCompleteReturnOmitsCustomMetadata = false;
  private nextMultipartUpload = 1;

  private object(key: string, withBody: boolean) {
    const v = this.data.get(key);
    if (!v) return null;
    const etag = this.etags.get(key) ?? `fake-${v.byteLength}`;
    const httpMetadata = this.httpMetadata.get(key);
    const customMetadata = this.customMetadata.get(key);
    const base = {
      key,
      version: '1',
      size: v.byteLength,
      etag,
      httpEtag: `"${etag}"`,
      checksums: { toJSON: () => ({}) },
      uploaded: new Date(0),
      httpMetadata,
      customMetadata,
      storageClass: 'Standard',
      writeHttpMetadata(headers: Headers) {
        if (httpMetadata?.contentType) headers.set('content-type', httpMetadata.contentType);
        if (httpMetadata?.cacheControl) headers.set('cache-control', httpMetadata.cacheControl);
        if (httpMetadata?.contentDisposition) headers.set('content-disposition', httpMetadata.contentDisposition);
      },
    };
    if (!withBody) return base;
    const copy = new Uint8Array(v);
    return {
      ...base,
      body: new Response(copy).body as ReadableStream<Uint8Array>,
      bodyUsed: false,
      async arrayBuffer() {
        return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer;
      },
      async bytes() { return new Uint8Array(copy); },
      async text() { return new TextDecoder().decode(copy); },
      async json<T>() { return JSON.parse(new TextDecoder().decode(copy)) as T; },
      async blob() { return new Blob([copy]); },
    };
  }

  async head(key: string): Promise<ReturnType<FakeR2['object']>> {
    return this.object(key, false);
  }

  async put(
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    opts: {
      onlyIf?: { etagDoesNotMatch?: string };
      httpMetadata?: R2HTTPMetadata | Headers;
      customMetadata?: Record<string, string>;
    } = {},
  ): Promise<ReturnType<FakeR2['object']>> {
    if (opts.onlyIf?.etagDoesNotMatch === '*' && this.data.has(key)) return null;
    const bytes =
      typeof value === 'string'
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array
          ? value
          : new Uint8Array(value);
    this.data.set(key, new Uint8Array(bytes));
    const httpMetadata = opts.httpMetadata instanceof Headers
      ? { contentType: opts.httpMetadata.get('content-type') ?? undefined }
      : opts.httpMetadata;
    if (httpMetadata) this.httpMetadata.set(key, httpMetadata);
    else this.httpMetadata.delete(key);
    if (opts.customMetadata) this.customMetadata.set(key, { ...opts.customMetadata });
    else this.customMetadata.delete(key);
    this.etags.set(key, `fake-${this.etags.size + 1}-${bytes.byteLength}`);
    return this.object(key, false);
  }

  async get(key: string): Promise<ReturnType<FakeR2['object']>> {
    return this.object(key, true);
  }

  private multipartHandle(key: string, uploadId: string): R2MultipartUpload {
    return {
      key,
      uploadId,
      uploadPart: async (partNumber, value) => {
        this.multipartPartUploadCalls += 1;
        const record = this.multipartUploads.get(uploadId);
        if (!record || record.key !== key) {
          throw new Error('uploadPart: The specified multipart upload does not exist. (10024)');
        }
        const bytes = await fakeR2Bytes(value);
        let hash = 2166136261;
        for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
        const etag = `fake-part-${partNumber}-${bytes.byteLength}-${hash.toString(16)}`;
        record.parts.set(partNumber, { bytes: new Uint8Array(bytes), etag });
        return { partNumber, etag };
      },
      abort: async () => {
        const record = this.multipartUploads.get(uploadId);
        if (!record || record.key !== key) {
          throw new Error('abort: The specified multipart upload does not exist. (10024)');
        }
        this.multipartUploads.delete(uploadId);
      },
      complete: async (uploadedParts) => {
        const record = this.multipartUploads.get(uploadId);
        if (!record || record.key !== key) {
          throw new Error('complete: The specified multipart upload does not exist. (10024)');
        }
        const selected: Array<{ bytes: Uint8Array; etag: string }> = [];
        for (const part of uploadedParts) {
          const stored = record.parts.get(part.partNumber);
          if (!stored || stored.etag !== part.etag) {
            throw new Error('complete: One or more specified parts could not be found. (10025)');
          }
          selected.push(stored);
        }
        if (selected.length > 1) {
          const regularSize = selected[0].bytes.byteLength;
          if (regularSize < 5 * 1024 * 1024) {
            throw new Error('complete: A multipart part is below the minimum size. (10011)');
          }
          if (selected.slice(0, -1).some((part) => part.bytes.byteLength !== regularSize)) {
            throw new Error('complete: All non-trailing parts must have the same size. (10048)');
          }
          if (selected.at(-1)!.bytes.byteLength > regularSize) {
            throw new Error('complete: The final part exceeds the regular part size. (10048)');
          }
        }
        const totalBytes = selected.reduce((sum, part) => sum + part.bytes.byteLength, 0);
        const combined = new Uint8Array(totalBytes);
        let offset = 0;
        for (const part of selected) {
          combined.set(part.bytes, offset);
          offset += part.bytes.byteLength;
        }
        this.data.set(key, combined);
        const httpMetadata = record.options.httpMetadata instanceof Headers
          ? { contentType: record.options.httpMetadata.get('content-type') ?? undefined }
          : record.options.httpMetadata;
        if (httpMetadata) this.httpMetadata.set(key, httpMetadata);
        else this.httpMetadata.delete(key);
        if (record.options.customMetadata) {
          this.customMetadata.set(key, { ...record.options.customMetadata });
        } else {
          this.customMetadata.delete(key);
        }
        this.etags.set(key, `fake-multipart-${uploadedParts.length}-${totalBytes}`);
        this.multipartUploads.delete(uploadId);
        const completed = this.object(key, false)!;
        if (this.nextMultipartCompleteReturnOmitsCustomMetadata) {
          this.nextMultipartCompleteReturnOmitsCustomMetadata = false;
          return { ...completed, customMetadata: undefined } as unknown as R2Object;
        }
        return completed as unknown as R2Object;
      },
    };
  }

  async createMultipartUpload(
    key: string,
    options: R2MultipartOptions = {},
  ): Promise<R2MultipartUpload> {
    const uploadId = this.nextMultipartUploadId ?? `fake-mpu-${this.nextMultipartUpload++}`;
    this.nextMultipartUploadId = null;
    this.multipartUploads.set(uploadId, { key, options, parts: new Map() });
    return this.multipartHandle(key, uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload {
    return this.multipartHandle(key, uploadId);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
    this.httpMetadata.delete(key);
    this.customMetadata.delete(key);
    this.etags.delete(key);
  }
}

export function makeEnv(overrides: Partial<Env> = {}): { env: Env; store: FakeStore; r2: FakeR2 } {
  const { db, store } = makeDb();
  const r2 = new FakeR2();
  const env = {
    DB: db,
    COUNTERS: new FakeKV() as unknown as KVNamespace,
    ARTIFACTS: r2 as unknown as Env['ARTIFACTS'],
    GITHUB_CLIENT_ID: 'test',
    GITHUB_CLIENT_SECRET: 'test',
    IP_HASH_PEPPER: 'test-pepper',
    ENVIRONMENT: 'test',
    CUPBOARD_HOST: 'cupboard.test',
    CUPBOARD_OPERATOR_GITHUB_IDS: '',
    RATE_PER_USER_PUBLISH_HOURLY: '5',
    RATE_PER_USER_REPORT_HOURLY: '10',
    RATE_PER_IP_LIST_PER_MINUTE: '60',
    INDEXER_BATCH_SIZE: '100',
    ...overrides,
  } as Env;
  return { env, store, r2 };
}

/** A blob in the stubbed recursive tree (P-001 content pin). `type` defaults
 *  to 'blob'; pass 'tree'/'commit' to exercise the non-blob filter. */
export interface GhStubTreeEntry {
  path: string;
  sha: string;
  size?: number;
  type?: 'blob' | 'tree' | 'commit';
}

export interface GhStub {
  user?: { id: number; login: string } | { error: number };
  repo?:
    | { id: number; private: boolean; permissions?: Record<string, boolean>; default_branch?: string }
    | { error: number };
  /** `GET git/ref/heads/<default_branch>` — the head the Worker pins (P-001).
   *  Only a SELF-DESCRIBING publish calls it; a code kind must pass without one. */
  head?: { sha: string } | { error: number };
  /** `GET git/trees/<sha>?recursive=1` — the tree the Worker digests (P-001). */
  tree?: { entries: GhStubTreeEntry[]; truncated?: boolean } | { error: number };
  /** `GET git/blobs/<sha>` — bytes scanned by P-003. */
  blobs?: Record<string, { content: string } | { error: number }>;
}

/** A well-formed 40-hex head sha for stubs — `'a'.repeat(40)` and friends. */
export const STUB_HEAD_SHA = 'a'.repeat(40);

/** Tree entries that satisfy the P-001 pin for `<listingRef>/`: one listing.json
 *  plus one manifest, deterministic blob shas. */
export function stubTreeFor(listingRef: string, manifest = 'listing.json'): GhStubTreeEntry[] {
  return [
    { path: `${listingRef}/listing.json`, sha: '1'.repeat(40), size: 120 },
    { path: `${listingRef}/${manifest === 'listing.json' ? 'README.md' : manifest}`, sha: '2'.repeat(40), size: 64 },
  ];
}

export function stubGithub(stub: GhStub): void {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = url.toString();
    if (u.endsWith('/user')) {
      if (stub.user && 'error' in stub.user) return new Response('', { status: stub.user.error });
      if (stub.user) return new Response(JSON.stringify(stub.user), { status: 200 });
      return new Response('', { status: 401 });
    }
    // Content-pin calls (P-001) — matched BEFORE the generic '/repos/' branch
    // because their URLs contain it too.
    if (u.includes('/git/ref/heads/')) {
      if (stub.head && 'error' in stub.head) return new Response('', { status: stub.head.error });
      if (stub.head) return new Response(JSON.stringify({ ref: 'refs/heads/main', object: { type: 'commit', sha: stub.head.sha } }), { status: 200 });
      return new Response('head not stubbed', { status: 500 });
    }
    if (u.includes('/git/trees/')) {
      if (stub.tree && 'error' in stub.tree) return new Response('', { status: stub.tree.error });
      if (stub.tree) {
        const body = {
          sha: stub.head && !('error' in stub.head) ? stub.head.sha : STUB_HEAD_SHA,
          truncated: stub.tree.truncated === true,
          tree: stub.tree.entries.map((e) => ({
            path: e.path,
            mode: e.type === 'tree' ? '040000' : e.type === 'commit' ? '160000' : '100644',
            type: e.type ?? 'blob',
            sha: e.sha,
            ...(e.type == null || e.type === 'blob' ? { size: e.size ?? 0 } : {}),
          })),
        };
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return new Response('tree not stubbed', { status: 500 });
    }
    if (u.includes('/git/blobs/')) {
      const sha = u.slice(u.lastIndexOf('/') + 1);
      const configured = stub.blobs?.[sha];
      if (configured && 'error' in configured) return new Response('', { status: configured.error });
      if (configured) return new Response(JSON.stringify({ encoding: 'base64', content: configured.content }), { status: 200 });
      // Existing P-001 tests predate P-003 and only care about tree digesting;
      // an empty JSON object is a deterministic clean blob for those fixtures.
      return new Response(JSON.stringify({ encoding: 'base64', content: btoa('{}') }), { status: 200 });
    }
    if (u.includes('/repos/')) {
      if (stub.repo && 'error' in stub.repo) return new Response('', { status: stub.repo.error });
      if (stub.repo) return new Response(JSON.stringify(stub.repo), { status: 200 });
      return new Response('', { status: 404 });
    }
    void init;
    return new Response('not stubbed', { status: 500 });
  }) as typeof fetch;
}

/** Bounded adapters over the existing anchors, plans, proof and test authorities. */
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import type { Sql } from 'postgres';
import type { PlanItemAnchor } from '../plan-items/anchors';
import { resolvePlanItemAnchors } from '../plan-items/anchors';
import { corroboratePushSources, peekPushSnapshot } from './push-snapshot';
import { firstPartyCallersOffthread } from './first-party-callers-offthread';
import { LSP_VENDOR_DIR } from './lsp-adapter';
import { readEngineeringExecution } from '../observability/engineering-execution';
import type { CodeIntelAnswer } from './contracts';
import type { EngineeringEvidenceDeps, EngineeringScope, EngineeringSpec, EngineeringSymbol } from './engineering-evidence';
import type { SpecClauseRevision } from '../agent-tools/plans/spec-clauses-store';

interface StoreOptions {
  sql?: () => Promise<Sql>;
  /** Test seam for the registry, not a replacement identity store. */
  root?: (scope: EngineeringScope) => Promise<string | null>;
  worker?: (scope: EngineeringScope, query: { path: string; name?: string; line1?: number }) => Promise<CodeIntelAnswer>;
}
function specView(value: SpecClauseRevision): EngineeringSpec {
  return { plan: value.planSlug, item: value.planItemId, id: value.specId, revision: value.revision,
    currentRevision: value.currentRevision, fingerprint: value.contentHash, behavior: value.behavior,
    lifecycle: value.lifecycleStatus };
}

export function engineeringEvidenceStore(options: StoreOptions = {}): EngineeringEvidenceDeps {
  const sql = options.sql ?? (async () => (await import('@papercusp/db-org')).getOrgPg().sql);
  const root = options.root ?? (async (scope: EngineeringScope) => {
    const { loadHarnessRegistry } = await import('../harness-registry');
    return (await loadHarnessRegistry(scope.workspaceId)).projects.find(p => p.slug === scope.harness)?.path ?? null;
  });
  const worker = options.worker ?? ((scope, query) => firstPartyCallersOffthread({
    root: scope.root, vendorDir: LSP_VENDOR_DIR, op: 'symbol', name: query.name ?? '',
    filePath: query.path, line1: query.line1, paths: [query.path], authorizedReadRoots: [scope.root], limit: 3,
  }));
  return {
    async authorize(scope) {
      const registered = await root(scope);
      if (!registered) return false;
      try { return await realpath(registered) === await realpath(scope.root); } catch { return false; }
    },
    async symbol(scope, query) {
      const answer = await worker(scope, query);
      // The compiler reports ambiguity as an error WITH captured declaration
      // sites. Keep independently source-backed candidates so the reader can
      // distinguish an ambiguous selector from a missing symbol.
      if (!answer.evidence || (answer.error && answer.sites.length < 2)) return [];
      const sources = answer.evidence.sourceScope.supportingFiles;
      const snapshot = peekPushSnapshot(scope.harness);
      const found: EngineeringSymbol[] = [];
      for (const [index, site] of answer.sites.entries()) {
        // Navigate-to declaration sites omit name. A successful symbol query
        // already checked this exact identifier in the compiler; do not discard
        // its declaration merely because the optional display field is absent.
        const name = site.name ?? query.name;
        if (site.path !== query.path || !name || site.line1 === null
          || (query.name && name !== query.name) || (query.line1 && site.line1 !== query.line1)) continue;
        const identity = answer.evidence.siteIdentities.find(v => v.siteIndex === index);
        const source = sources.find(v => v.path === site.path && v.representation === 'full-source');
        if (!identity?.versionedSymbolId || !source || identity.contentHash !== source.contentHash) continue;
        const candidates = snapshot?.symbols?.get(name)?.filter(v => v.path === site.path && v.line === site.line1) ?? [];
        const narrowed = snapshot && candidates.length === 1
          ? { ...snapshot, symbols: new Map([[name, candidates]]) } : null;
        const [anchor] = narrowed ? await resolvePlanItemAnchors([{ symbol: name }], { root: scope.root, snapshot: narrowed }) : [];
        found.push({ path: site.path, name, line1: site.line1, versionedSymbolId: identity.versionedSymbolId,
          fileFingerprint: source.contentHash, declarationFingerprint: anchor?.resolution === 'resolved' ? anchor.contentHash : null });
      }
      return answer.error && found.length < 2 ? [] : found;
    },
    async sourceCurrent(scope, symbol) {
      try {
        const file = await realpath(join(scope.root, symbol.path));
        const rel = relative(await realpath(scope.root), file);
        if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) return false;
        return await corroboratePushSources(scope.root, [{ path: symbol.path, sha256: symbol.fileFingerprint }], AbortSignal.timeout(1000), 1);
      } catch { return false; }
    },
    async items(scope, query, symbol, limit) {
      const db = await sql();
      // The lateral selection names ONE actual declaration for a symbol request.
      // Item requests recover their full anchor list through the canonical plan reader.
      const rows = await db<Array<{ plan: string; item: string; anchor: PlanItemAnchor | null }>>`
        SELECT i.plan_slug AS plan, i.item_id AS item,
          CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id',a.id::text,'anchorKind',a.anchor_kind,'requested',a.requested,
            'symbolId',a.symbol_id,'symbolName',a.symbol_name,'path',a.path,'line',a.line,
            'contentHash',a.content_hash,'resolution',a.resolution,'freshness',a.freshness,
            'unknownReason',a.unknown_reason,'resolvedCommit',a.resolved_commit) END AS anchor
        FROM harness_shared.plan_items i
        LEFT JOIN LATERAL (
          SELECT a.* FROM harness_shared.plan_item_anchors a
           WHERE a.workspace_id=i.workspace_id AND a.harness_slug=i.harness_slug
             AND a.plan_slug=i.plan_slug AND a.item_id=i.item_id
             AND (${symbol === null}::boolean OR (a.path=${symbol?.path ?? null}
               AND (a.anchor_kind='path' OR a.symbol_name=${symbol?.name ?? null})))
           ORDER BY (a.line IS NOT DISTINCT FROM ${symbol?.line1 ?? null}::int) DESC,
             (a.anchor_kind='symbol') DESC,a.id LIMIT 1
        ) a ON TRUE
        WHERE i.workspace_id=${scope.workspaceId} AND i.harness_slug=${scope.harness}
          AND (${query.item === undefined}::boolean OR (i.plan_slug=${query.item?.plan ?? null} AND i.item_id=${query.item?.id ?? null}))
          AND (${symbol === null}::boolean OR a.id IS NOT NULL)
        ORDER BY i.plan_slug,i.item_id LIMIT ${limit}`;
      return rows.map(row => {
        const anchor = row.anchor ?? undefined;
        const measured = anchor?.anchorKind === 'symbol' ? symbol?.declarationFingerprint : symbol?.fileFingerprint;
        const anchorState = !symbol || !anchor?.contentHash || !measured ? 'unknown' as const
          : anchor.contentHash === measured ? 'current' as const : 'stale' as const;
        return { ...row, workspaceId: scope.workspaceId, harness: scope.harness, anchor, anchorState };
      });
    },
    async specs(scope, item, limit) {
      const { listSpecClauses } = await import('../agent-tools/plans/spec-clauses-store');
      return (await listSpecClauses({ workspaceId: scope.workspaceId, harnessSlug: scope.harness,
        planSlug: item.plan, planItemIds: [item.item], limit })).map(specView);
    },
    async spec(scope, plan, id, revision) {
      const { listSpecClauses } = await import('../agent-tools/plans/spec-clauses-store');
      const [value] = await listSpecClauses({ workspaceId: scope.workspaceId, harnessSlug: scope.harness,
        planSlug: plan, specIds: [id], revision, limit: 1 });
      return value ? specView(value) : null;
    },
    async decisions(scope, item, limit) {
      const db = await sql();
      // This is the same transactional decision projection used by claim briefs.
      // Scope and applicability are filtered before the row/body ceilings.
      const rows = await db<Array<{ plan: string; id: string; title: string; body: string;
        itemRefs: string[]; affects: string[]; bodyTruncated: boolean }>>`
        SELECT d.plan_slug AS plan,d.decision_id AS id,d.title,LEFT(d.body,4096) AS body,
          d.item_refs AS "itemRefs",d.affects,length(d.body)>4096 AS "bodyTruncated"
        FROM harness_shared.plan_decisions d
        WHERE d.workspace_id=${scope.workspaceId} AND d.harness_slug=${scope.harness}
          AND (d.plan_slug=${item.plan} OR ${item.plan}=ANY(d.affects))
        ORDER BY CASE WHEN d.plan_slug=${item.plan} AND ${item.item}=ANY(d.item_refs) THEN 0
          WHEN ${item.plan}=ANY(d.affects) THEN 1 ELSE 2 END,d.seq DESC,d.plan_slug,d.decision_id
        LIMIT ${limit}`;
      return rows;
    },
    async proofs(scope, spec, limit) {
      const { listSpecEvidence } = await import('../agent-tools/plans/spec-evidence-store');
      return (await listSpecEvidence({ workspaceId: scope.workspaceId, harnessSlug: scope.harness,
        planSlugs: [spec.plan], specIds: [spec.id], includeRetracted: true, limit })).map(p => ({
        id: p.id, plan: p.planSlug, spec: p.specId, revision: p.specRevision, workItem: p.workItemId,
        evidenceRef: p.evidenceRef, kind: p.evidenceKind, state: p.currentness.overall,
        withdrawn: Boolean(p.withdrawal), fingerprints: p.fingerprints, runId: p.testRunId,
        reasons: [...p.currentness.staleReasons, ...p.currentness.unknownReasons],
      }));
    },
    async execution(scope, runId) { return readEngineeringExecution(scope, runId, await sql()); },
    async run(scope, runId) {
      const db = await sql();
      const [run] = await db<Array<{ id: string; file: string; status: string; commit: string | null }>>`
        SELECT id::text,file_path AS file,status,commit_sha AS commit FROM harness_shared.test_runs
         WHERE workspace_id=${scope.workspaceId} AND harness_slug=${scope.harness} AND id=${runId} LIMIT 1`;
      return run ? { ...run, id: Number(run.id) } : null;
    },
    async cases(scope, runId, limit) {
      const db = await sql();
      const rows = await db<Array<{ run_id: string; key: string; occurrence: number; status: string }>>`
        SELECT c.test_run_id::text AS run_id,c.case_key AS key,c.occurrence,c.status
          FROM harness_shared.test_case_runs c JOIN harness_shared.test_runs r ON r.id=c.test_run_id
         WHERE r.workspace_id=${scope.workspaceId} AND r.harness_slug=${scope.harness} AND r.id=${runId}
         ORDER BY c.case_index LIMIT ${limit}`;
      return rows.map(row => ({ runId: Number(row.run_id), key: row.key, occurrence: row.occurrence, status: row.status }));
    },
  };
}

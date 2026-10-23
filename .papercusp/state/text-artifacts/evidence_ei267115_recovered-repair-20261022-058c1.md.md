---
rel_path: "evidence/ei267115/recovered-repair-20261022-058c1.md"
updated_at: 1792707208648
_body: "content"
---

# EI-267115 recovered transaction repair, 2026-10-22 22:14Z

Base HEAD: d32eae0110551750ed8698297b5f8851e94fd4e0

File SHA256: {"packages/operator-core/lib/agent-tools/rubrics/amend.test.ts": "26f0d6b2dd3035b0395784cc473e39a3151b15dd7026833319b50e5e2c0b27d0", "packages/operator-core/lib/rubrics.integration.test.ts": "a23749f3447d2772633b33af413ebf9137d24b6b69e7baf2554cb5ff58e308f9", "packages/operator-core/lib/rubrics.ts": "2ff8730f02893e9d69a26950ff497b8930940784e2fe46e2782c23b3855ef7c4"}

Current uncommitted diff (previous committed changes remain in HEAD):
```diff
diff --git a/packages/operator-core/lib/agent-tools/rubrics/amend.test.ts b/packages/operator-core/lib/agent-tools/rubrics/amend.test.ts
index f2680c6e83..4addf24088 100644
--- a/packages/operator-core/lib/agent-tools/rubrics/amend.test.ts
+++ b/packages/operator-core/lib/agent-tools/rubrics/amend.test.ts
@@ -31,7 +31,10 @@ const receiptDb = vi.hoisted(() => {
   type Row = { idempotency_key: string; rubric_ref: string; state: string; started_at: Date; finished_at: Date | null; result_json: Record<string, unknown> | null; error: string | null };
   const rows = new Map<string, Row>();
   const sql = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
+    // postgres' bulk insert helper is called before its tagged statement.
+    if (!Array.isArray(parts) || !('raw' in parts)) return [];
     const query = parts.join('?');
+    if (query.includes('INSERT INTO harness_shared.fallback_observations')) return [];
     if (query.includes('DELETE FROM harness_shared.rubric_amend_receipts')) return [];
     if (query.includes('INSERT INTO harness_shared.rubric_amend_receipts')) {
       const [workspace, rubric, key] = values as string[];
@@ -46,13 +49,13 @@ const receiptDb = vi.hoisted(() => {
       return row ? [row] : [];
     }
     if (query.includes('UPDATE harness_shared.rubric_amend_receipts')) {
-      const success = query.includes('result_json =');
-      const [workspace, rubric, key] = (success ? values.slice(3) : values.slice(1)) as string[];
+      const failed = query.includes("SET state = 'failed'");
+      const [workspace, rubric, key] = values.slice(failed ? 2 : 3) as string[];
       const row = rows.get(`${workspace}:${rubric}:${key}`);
       if (row) {
-        row.state = success ? String(values[0]) : 'failed';
-        row.result_json = success ? JSON.parse(String(values[1])) : null;
-        row.error = success ? values[2] as string | null : String(values[0]);
+        row.state = failed ? 'failed' : String(values[0]);
+        row.result_json = JSON.parse(String(values[1]));
+        row.error = failed ? String(values[0]) : values[2] as string | null;
         row.finished_at = new Date();
       }
       return [];
diff --git a/packages/operator-core/lib/rubrics.integration.test.ts b/packages/operator-core/lib/rubrics.integration.test.ts
index 29f8e6c457..cdb336511d 100644
--- a/packages/operator-core/lib/rubrics.integration.test.ts
+++ b/packages/operator-core/lib/rubrics.integration.test.ts
@@ -28,7 +28,10 @@ import { hashPlanContent } from './agent-tools/plans/content-hash';
 import { listLocalRubrics } from './cupboard/rubric-store';
 import setTemplateDataTool from './agent-tools/plans/set-template-data';
 
-const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
+const h = vi.hoisted(() => ({
+  sql: undefined as unknown as postgres.Sql,
+  shortIdleTimeoutMs: undefined as number | undefined,
+}));
 
 const MAX_BOUNDED_LOCK_BUSY_RETRIES = 2;
 const retryBoundedLockBusy = async <T>(operation: () => Promise<T>): Promise<T> => {
@@ -63,6 +66,9 @@ vi.mock('@papercusp/db-org', async (orig) => {
     withWorkspace: async <T>(ws: string, cb: (tx: postgres.Sql) => Promise<T> | T): Promise<T> =>
       h.sql.begin(async (tx) => {
         await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
+        if (h.shortIdleTimeoutMs !== undefined) {
+          await tx`SELECT set_config('idle_in_transaction_session_timeout', ${`${h.shortIdleTimeoutMs}ms`}, true)`;
+        }
         return cb(tx as unknown as postgres.Sql);
       }) as Promise<T>,
   };
@@ -3660,6 +3666,150 @@ describe('template_data persistence boundary — the set-template-data door', ()
     return { ...seeded, rubric, content, subjectRevision: Number(row!.version) };
   }
 
+  it('EI-267115: reads the contract snapshot before holding either amendment plan lock', async () => {
+    const seeded = await explicitAmendmentSubject('snapshot-outside-amendment-transaction');
+    const snapshots = await import('./acceptance-bar-contract-snapshot');
+    const phases: string[] = [];
+    let lockAvailability: boolean[] = [];
+    const stop = new Error('snapshot-boundary-measured');
+    const reader = vi.spyOn(snapshots, 'readAcceptanceBarContractSnapshot').mockImplementationOnce(async () => {
+      lockAvailability = await db.adminSql.begin(async (tx) => {
+        const availability: boolean[] = [];
+        for (const slug of [seeded.rubricSlug, seeded.subject]) {
+          const [row] = await tx<{ available: boolean }[]>`SELECT pg_try_advisory_xact_lock(
+            hashtext(${PLAN_ADVISORY_LOCK_NAMESPACE}),
+            hashtext(${planAdvisoryLockKey(seeded.workspaceId, 'papercusp', slug)})) AS available`;
+          availability.push(row!.available);
+        }
+        return availability;
+      });
+      throw stop;
+    });
+    try {
+      await expect(rubrics.amendRubric({
+        rubricId: seeded.rubricSlug, actorId: 'snapshot-boundary-author',
+        reason: 'Measure the independent snapshot reader transaction boundary.',
+        expectedRubricRevision: seeded.rubric.revision,
+        expectedSubjectPlanRevision: seeded.subjectRevision,
+        criterion: { key: seeded.rubric.criteria[0]!.key, field: 'method', mode: 'replace',
+          text: 'Run the updated deterministic fixture.' },
+        onPhase: (phase) => phases.push(phase),
+      })).rejects.toThrow(stop);
+      expect(reader).toHaveBeenCalledOnce();
+      expect(phases.at(-1)).toBe('acceptance-contract-snapshot');
+      expect(lockAvailability).toEqual([true, true]);
+    } finally {
+      reader.mockRestore();
+    }
+    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(seeded.rubric.revision);
+  });
+
+  it('EI-267115: survives a real PostgreSQL idle-transaction timeout during independent snapshot reads', async () => {
+    const seeded = await explicitAmendmentSubject('snapshot-idle-timeout');
+    const amendment = {
+      rubricId: seeded.rubricSlug, actorId: 'snapshot-idle-author',
+      reason: 'Keep independent snapshot work outside the guarded amendment transaction.',
+      expectedRubricRevision: seeded.rubric.revision,
+      expectedSubjectPlanRevision: seeded.subjectRevision,
+      criterion: { key: seeded.rubric.criteria[0]!.key, field: 'method' as const, mode: 'replace' as const,
+        text: 'Run the updated deterministic idle-timeout fixture.' },
+    };
+    const approvalRef = await postApproval(amendment);
+    // Calibrate the failure mechanism on the real server, independent of the
+    // amender. This fixture changes only its own transaction-local setting.
+    await expect(db.adminSql.begin(async (tx) => {
+      await tx`SELECT set_config('idle_in_transaction_session_timeout', '1000ms', true)`;
+      await db.adminSql`SELECT pg_sleep(2)`;
+      await tx`SELECT 1`;
+    })).rejects.toThrow(/CONNECTION_CLOSED|idle-in-transaction timeout/i);
+
+    const snapshots = await import('./acceptance-bar-contract-snapshot');
+    const originalRead = snapshots.readAcceptanceBarContractSnapshot;
+    const reader = vi.spyOn(snapshots, 'readAcceptanceBarContractSnapshot').mockImplementationOnce(async (...args) => {
+      try {
+        const snapshot = await originalRead(...args);
+        await db.adminSql`SELECT pg_sleep(2)`;
+        return snapshot;
+      } finally {
+        // With preparation outside the transaction the subsequent write uses
+        // its normal production guard; never widen that guard to pass the test.
+        h.shortIdleTimeoutMs = undefined;
+      }
+    });
+    h.shortIdleTimeoutMs = 1000;
+    try {
+      const after = (await rubrics.amendRubric({ ...amendment, approvalRef }))!;
+      expect(reader).toHaveBeenCalledOnce();
+      expect(after.revision).toBe(seeded.rubric.revision! + 1);
+      expect(after.criteria[0]!.method).toBe(amendment.criterion.text);
+      const [subject] = await db.adminSql<{ version: number }[]>`SELECT version
+        FROM harness_shared.harness_plans WHERE workspace_id=${seeded.workspaceId}
+          AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
+      expect(Number(subject!.version)).toBe(seeded.subjectRevision + 1);
+    } finally {
+      h.shortIdleTimeoutMs = undefined;
+      reader.mockRestore();
+    }
+  });
+
+  it.each(['subject', 'rubric', 'clause', 'item', 'composition'] as const)(
+    'EI-267115: refuses a stale %s source after independent snapshot preparation without amendment writes', async (source) => {
+      const seeded = await explicitAmendmentSubject(`snapshot-race-${source}`);
+      const composition = source === 'composition'
+        ? (await rubrics.proposeRubric({ rubricId: 'snapshot-race-parent', characteristic: 'snapshot-race-parent',
+            title: 'Reusable snapshot parent', criteria: sampleCriteria, by: 'snapshot-parent-author' })).rubricId
+        : undefined;
+      const snapshots = await import('./acceptance-bar-contract-snapshot');
+      const originalRead = snapshots.readAcceptanceBarContractSnapshot;
+      let sourcesAfterRace: unknown;
+      const readPlans = () => db.adminSql`SELECT plan_slug, content, content_hash, version, template_data
+        FROM harness_shared.harness_plans WHERE workspace_id=${seeded.workspaceId}
+          AND harness_slug='papercusp' AND plan_slug=ANY(${[seeded.subject, seeded.rubricSlug]}::text[])
+        ORDER BY plan_slug`;
+      const reader = vi.spyOn(snapshots, 'readAcceptanceBarContractSnapshot').mockImplementationOnce(async (...args) => {
+        const snapshot = await originalRead(...args);
+        if (source === 'subject' || source === 'rubric') {
+          const slug = source === 'subject' ? seeded.subject : seeded.rubricSlug;
+          await db.adminSql`UPDATE harness_shared.harness_plans SET version=version+1
+            WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${slug}`;
+        } else if (source === 'clause') {
+          const { listSpecClauses, setSpecClause } = await import('./agent-tools/plans/spec-clauses-store');
+          const scope = { harnessSlug: 'papercusp', planSlug: seeded.subject };
+          const clause = (await listSpecClauses(scope))[0]!;
+          const changed = await setSpecClause({ ...clause, ...scope, expectedRevision: clause.revision,
+            behavior: `${clause.behavior} Concurrent source change.`, actorId: 'snapshot-race-author' });
+          expect(changed.status).toBe('revised');
+        } else if (source === 'item') {
+          await db.adminSql`UPDATE harness_shared.plan_items SET status='dropped'
+            WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp'
+              AND plan_slug=${seeded.subject} AND item_id='P-001'`;
+        } else {
+          await db.adminSql`UPDATE harness_shared.harness_plans SET version=version+1
+            WHERE workspace_id=${seeded.workspaceId} AND plan_slug=${composition!}`;
+        }
+        sourcesAfterRace = [...await readPlans()];
+        return snapshot;
+      });
+      // A deliberately regressed transaction boundary must fail promptly:
+      // otherwise its independent UPDATE can wait behind its own plan lock
+      // until Vitest times out and strands the following fixture cleanup.
+      h.shortIdleTimeoutMs = 1000;
+      try {
+        await expect(rubrics.amendRubric({ rubricId: seeded.rubricSlug, actorId: 'snapshot-race-author',
+          reason: 'Revalidate every governing source after independent reads.',
+          ...(composition ? { composes: [composition] } : {}),
+          criterion: { key: seeded.rubric.criteria[0]!.key, field: 'method', mode: 'replace',
+            text: 'Run the updated deterministic fixture.' },
+        })).rejects.toThrow('acceptance_bar_amendment_revision_conflict');
+        expect(reader).toHaveBeenCalledOnce();
+      } finally {
+        h.shortIdleTimeoutMs = undefined;
+        reader.mockRestore();
+      }
+      expect([...await readPlans()]).toEqual(sourcesAfterRace);
+    },
+  );
+
   it('EI-261580: persists a provenance-only amendment with its authenticated authority', async () => {
     const seeded = await explicitAmendmentSubject('provenance-only-amendment-subject');
     const before = (await rubrics.getRubric(seeded.rubricSlug))!;
diff --git a/packages/operator-core/lib/rubrics.ts b/packages/operator-core/lib/rubrics.ts
index d435826cf1..3f99549b3f 100644
--- a/packages/operator-core/lib/rubrics.ts
+++ b/packages/operator-core/lib/rubrics.ts
@@ -4935,6 +4935,47 @@ async function amendAcceptanceBarRubric(
     preview,
   );
   if (preLockReplay) return preLockReplay;
+  // Independent-pool and filesystem readers must finish before opening the
+  // amendment transaction. Revalidate their governing sources under the locks;
+  // approval, caller CAS and the writes below remain atomic.
+  const compositionRefs = normalizeRubricCompositionRefs(applyRubricAmendment(rubricHint, input).composes) ?? [];
+  const readPreparationSources = async (sql: AcceptanceBarAmendmentSql) => {
+    const rows = await Promise.all([
+      sql`SELECT harness_slug, plan_slug, content, content_hash, version, status, owner, archived, template_data
+        FROM harness_shared.harness_plans WHERE workspace_id = ${rubricScope.workspaceId}
+          AND ((harness_slug = ${rubricScope.harnessSlug} AND plan_slug = ${input.rubricId})
+            OR (harness_slug = ${subjectScope.harnessSlug} AND plan_slug = ${subjectPlanHint}))
+        ORDER BY harness_slug, plan_slug`,
+      sql`SELECT harness_slug, plan_slug, content, content_hash, version, status, owner, archived, template_data
+        FROM harness_shared.harness_plans WHERE workspace_id = ${rubricScope.workspaceId}
+          AND plan_slug = ANY(${compositionRefs}::text[]) ORDER BY harness_slug, plan_slug`,
+      sql`SELECT item_id, status, deliverable FROM harness_shared.plan_items
+        WHERE workspace_id = ${subjectScope.workspaceId} AND harness_slug = ${subjectScope.harnessSlug}
+          AND plan_slug = ${subjectPlanHint} ORDER BY item_id`,
+      sql`SELECT c.spec_id, c.current_revision, r.content_hash FROM harness_shared.plan_spec_clauses c
+        JOIN harness_shared.plan_spec_clause_revisions r ON r.workspace_id = c.workspace_id
+          AND r.harness_slug = c.harness_slug AND r.plan_slug = c.plan_slug
+          AND r.spec_id = c.spec_id AND r.revision = c.current_revision
+        WHERE c.workspace_id = ${subjectScope.workspaceId} AND c.harness_slug = ${subjectScope.harnessSlug}
+          AND c.plan_slug = ${subjectPlanHint} ORDER BY c.spec_id`,
+    ]);
+    return rows.map((source) => [...source]);
+  };
+  const { sql: preparationSql } = getOrgPg();
+  const preparationSources = await readPreparationSources(preparationSql);
+  input.onPhase?.('acceptance-composition-links');
+  await assertRubricCompositionLinksResolve({ rubricId: input.rubricId, composes: compositionRefs });
+  const {
+    readAcceptanceBarContractSnapshot,
+    diffAcceptanceBarContractSnapshots,
+    predictAmendedBarProofFloor,
+    barRequiresAutomatedProof,
+  } = await import('./acceptance-bar-contract-snapshot');
+  const { evaluateAcceptanceBarLifecycle } = await import('./acceptance-bar-lifecycle-evaluator');
+  input.onPhase?.('acceptance-contract-snapshot');
+  const snapshot = await readAcceptanceBarContractSnapshot(subjectPlanHint, {}, {
+    harnessSlug: subjectScope.harnessSlug,
+  });
   input.onPhase?.('acceptance-transaction-acquire');
   const txResult = await withAcceptanceBarAmendmentTransaction(
     {
@@ -5051,8 +5092,18 @@ async function amendAcceptanceBarRubric(
               ...applyRubricAmendment(stored, { rubricId: input.rubricId, criteria: stored.criteria }),
               criteria: stored.criteria.map(normalizeAcceptanceBarCriterion),
             }).data);
-      input.onPhase?.('acceptance-composition-links');
-      await assertRubricCompositionLinksResolve(amended);
+      input.onPhase?.('acceptance-source-revalidation');
+      if (!isDeepStrictEqual(preparationSources, await readPreparationSources(tx)) ||
+          !isDeepStrictEqual(compositionRefs, normalizeRubricCompositionRefs(amended.composes) ?? []) ||
+          (rubricHint.revision !== undefined && rubricHint.revision !== Number(rubricRow.version)) ||
+          (snapshot.plan && (snapshot.plan.revision !== Number(subjectRow.version) ||
+            snapshot.plan.contentHash !== subjectRow.content_hash)) ||
+          (snapshot.rubric && (snapshot.rubric.rubricId !== input.rubricId ||
+            snapshot.rubric.revision !== Number(rubricRow.version)))) {
+        throw new Error(preview
+          ? 'acceptance_bar_amendment_preview_stale: source plans changed during preparation; re-run dryRun'
+          : 'acceptance_bar_amendment_revision_conflict: governing sources changed during preparation; retry with fresh revisions');
+      }
       // EI-24372605712471072: before the subject plan starts, its BARs may name proof
       // files the plan's own items will write. Those are accepted as planned (and named on
       // the preview); a started plan stays strict, and grading always is.
@@ -5409,17 +5460,6 @@ async function amendAcceptanceBarRubric(
         }
       }
 
-      const {
-        readAcceptanceBarContractSnapshot,
-        diffAcceptanceBarContractSnapshots,
-        predictAmendedBarProofFloor,
-        barRequiresAutomatedProof,
-      } = await import('./acceptance-bar-contract-snapshot');
-      const { evaluateAcceptanceBarLifecycle } = await import('./acceptance-bar-lifecycle-evaluator');
-      input.onPhase?.('acceptance-contract-snapshot');
-      const snapshot = await readAcceptanceBarContractSnapshot(subjectPlanHint, {}, {
-        harnessSlug: subjectScope.harnessSlug,
-      });
       if (
         preview &&
         (snapshot.completeness.truncated ||

```


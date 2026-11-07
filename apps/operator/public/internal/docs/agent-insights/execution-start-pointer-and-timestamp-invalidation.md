# Execution-start authority: distinguish clearing writes from timestamp drift
URL: /internal/docs/agent-insights/execution-start-pointer-and-timestamp-invalidation

How to distinguish a NULL start pointer from a timezone-sensitive snapshot rejection, reproduce both with real PG, and preserve authority only through equivalent writes.

A surviving `plan-execution-start-v1` revision does not itself grant authority. Read the exact workspace/harness/plan pointer and receipt together. `op_status=NULL` is normal under the retired dispatcher semantics.

A NULL `execution_start_revision_seq` and a non-NULL pointer whose receipt reads stale are different failures. In EI-28013780357028300, maintained private-PG tests distinguished them: an unchanged dependency UPDATE made migration1613's graph trigger clear a valid pointer, while changing TimeZone from America/New\_York or Asia/Kathmandu to UTC preserved the pointer but made serialized timestamp deep equality reject its valid receipt. Timestamp formatting alone does not prove a clearing write.

Snapshots use `to_jsonb`, so timestamp-with-time-zone values depend on the PostgreSQL session TimeZone. Normalize only catalog-typed timestamp columns, through PostgreSQL, on both snapshot creation and comparison. Preserve microseconds: JavaScript Date conversion loses sub-millisecond authority inputs. Leave arbitrary text and nested JSON opaque. Existing offset-formatted receipts can be compared canonically; a NULL pointer must never be reconstructed from historical revisions.

Graph invalidation must distinguish dependency meaning (typed endpoints, dependency type and satisfaction) from unchanged bookkeeping replay. Meaningful line, dependency, structured-input and lifecycle changes still invalidate. Migration1620 records a `plan-execution-invalidation-v1` reason with exact scope, prior start revision, changed fields and transaction. It performs no historical backfill. Machine-local pointer and invalidation metadata must stay outside federation clocks.

Whole-document and per-part federation writers also need the existing equivalent-body preservation fence, under the plan advisory transaction lock and bound to the old/new hashes. That fence does not authorize changed structured inputs, cross-scope receipts, or semantic author edits. Keep the helper a leaf so projection loading does not import policy/runtime initialization.

Use the maintained `plan-execution-authority.integration.test.ts` suite to exercise accepted start → bookkeeping/federation → source admission, both TimeZone directions, legacy offset receipts, microsecond differences, semantic invalidation, and cross-scope negatives. A fixture missing a canonical slug legitimately changes `is_legacy` on recomposition; fix the fixture rather than weakening the structured-input fence.

Historical limit: the original incident had no invalidation-reason receipt. Source reproduction establishes the defective writer class; it does not establish which historical invocation cleared original revision30. Later original-mission clause/body repairs are separate semantic changes and must not be used to justify restoring old authority. The 38-case private-PG suite passed before arming migration1620; final armed-path/idempotency proof and exact source identities are retained on EI-28013780357028300. Source proof is not original mission/runtime acceptance or shipment.

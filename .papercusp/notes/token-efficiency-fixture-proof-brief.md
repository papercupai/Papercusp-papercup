# Token-efficiency fixture proof: pending independent verification

Recovery work item: WI-6554700010010681. Plan: token-efficiency-prompts-cache-and-behavior-2026-10-11, revision 72. This is preparation, not an independent verification or a passing acceptance claim.

The current-build evaluator was read through the attributed `scripts/mcp-call.mjs --port 3170` route on 2026-10-14. All five clauses below remain unknown on `fixture-calibration`. The default MCP route used the older release evaluator `d740fc3802`; its weaker results do not clear this blocker.

No verifier was recruited, no self-grade was emitted, and no test or mutation run was repeated while preparing this brief. Preserve the original receipts. The pending verification must satisfy the supported tool's outside-lineage rule and reread current evidence before binding anything.

## Complete binding inventory for these five clauses

This inventory comes from `plans:get-spec-evidence` with a five-clause filter, limit 100, and `truncatedByLimit:false`. The full saved result was read because the displayed result omitted several rows.

| Clause | Revision | Binding | Evidence | Test run |
|---|---:|---:|---|---:|
| SPEC-P-004 | 2 | 44303 | test | 21215988 |
| SPEC-P-004 | 2 | 44302 | mutation | 21216031 |
| AUTO-BAR-R-6-P-004 | 3 | 41961 | size test | 21215988 |
| AUTO-BAR-R-6-P-004 | 3 | 41962 | executable corpus claims test | 21215989 |
| AUTO-BAR-R-6-P-004 | 3 | 41963 | size mutation | 21216031 |
| SPEC-P-015-DEFAULT | 1 | 44312 | test | 21232175 |
| SPEC-P-015-DEFAULT | 1 | 44313 | mutation | 21232189 |
| AUTO-BAR-R-3-P-015 | 4 | 43287 | test | 21232175 |
| AUTO-BAR-R-3-P-015 | 4 | 43288 | default-ON mutation | 21232189 |
| AUTO-BAR-R-3-P-015 | 4 | 39006 | relocation-ON mutation | 21144502 |
| AUTO-BAR-R-3-P-015 | 4 | 39007 | OFF byte-identity mutation | 21144513 |
| AUTO-BAR-R-3-P-015 | 4 | 39008 | environment-precedence mutation | 21144514 |
| AUTO-BAR-R-4-P-015 | 4 | 39010 | relocation preservation test | 21144471 |
| AUTO-BAR-R-4-P-015 | 4 | 39011 | system-authority wrapper mutation | 21144498 |
| AUTO-BAR-R-4-P-015 | 4 | 39014 | real-playbook preservation test | 21144601 |

Every row above was server-measured `current` at the saved read. That is a timestamped currentness observation, not independent fixture-absence certification.

## Inputs and measurement boundaries

- `packages/operator-core/lib/doc-claims/claude-md-size-ceiling.test.ts` reads the actual checkout's `CLAUDE.md` as the subject. Its size assertion and positive lower-bound control use the frozen 108,821-byte baseline. Size bindings measure `CLAUDE.md` as source and this test as test bytes.
- `packages/operator-core/lib/doc-claims/executable-claims.test.ts` checks the executable claims of the actual corpus. Binding 41962 selects the two cases concerning real package scripts and the heavy-command gate. Inspect those selected cases and their dependencies independently; the brief does not certify their fixture use.
- `packages/operator-core/lib/inference-gateway/cache-policy-relocate-tail.real-launch.test.ts` generates the prompt using production `renderSuPlaybook`, `applySuPromptOverlays`, `composeModePromptSection`, and `buildSuInstructionRuntime`; it reads the actual `CLAUDE.md` for message block zero. The request envelope is shaped in the test. The test explicitly declares no stored fixture data. Its calibration case checks the generated production prompt, boundary, per-session tail, and actual guide.
- Default-ON bindings 44312/44313 and 43287/43288 measure `libs/flags/src/types.ts` plus `packages/operator-core/lib/inference-gateway/cache-policy.ts` as source and the real-launch test as test bytes. The retained other relocation mutations measure `cache-policy.ts` as source. Preserve these distinct measurement sets.
- Binding 39014 uses `packages/operator-core/lib/su-persona-render.real-playbook.test.ts` and measures `su-persona-render.ts`. Its selected case checks byte-preserved per-session sections against the boundary-off render.

`fixtureFingerprint:null` and binder metadata `fixtureFree:true` are insufficient under the current evaluator. Production source or the subject guide must not be relabelled as a fixture merely to obtain a passing rating.

## Required verification

Use the supported independent-verification path only when authorized by the applicable pre-grading rules. Read its current schema rather than copying an old payload. The verifier must be outside the implementer's spawn/rebind lineage and inspect the same measured source, test bytes, run, and selected cases as each executable binding.

Re-resolve each binding and its currentness, inspect the selected cases and input construction, and decide whether fixture absence is actually established. Bind the exact implementer binding ID and preserve its measured identity. If fixtures are found, disclose them and supply genuine measured fixture inputs plus calibration evidence; do not attest absence. Re-evaluate the clauses on the current-build route after the supported bindings are recorded.

The inventory includes both test and mutation rows and the supplemental preservation/corpus rows. Verifying only a positive test does not certify all executable evidence at that revision.

## Saved evidence references

- Full five-clause evidence inventory: `/home/marsh-office/.papercusp/scratch/papercusp-workspace/plans:get-spec-evidence/6d7eab80-4d78-43f9-8542-ec02385ecb20/result-door-1792006134042.md`. JSON body starts at byte 2389. These scratch references expire; the binding IDs and test-run ledger remain the recovery authority.
- Current-build five-clause adequacy result: `/home/marsh-office/.papercusp/scratch/papercusp-workspace/plans:evaluate-spec-test-adequacy/38af513d-e6a8-44a0-ba8e-6d5279fe6b07/result-door-1792006034886.md`. Its visible verdict table is sufficient to name the blockers; its omitted evidence prose is not an absence finding.
- Governing source and certification receipts, including clean kernel/authorization audits: WI-6554700010010681; relocation receipts: WI-6554700010008813; kernel receipts: WI-6554700010008814.

This proof gap is separate from the containing-release prerequisite for deployed R7/R8/R9. Neither an item source audit nor a fixture-absence verification starts or satisfies the required deployed measurement windows. The plan remains unshipped.

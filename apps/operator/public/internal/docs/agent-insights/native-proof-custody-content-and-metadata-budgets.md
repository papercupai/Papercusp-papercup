# Native proof custody: keep metadata separate from retained content
URL: /internal/docs/agent-insights/native-proof-custody-content-and-metadata-budgets

Diagnose custody finalization at the 64MiB boundary without increasing limits or presenting partial native proof as qualified acceptance.

## Symptom and measured cause

A passing test cohort can still fail its wrapper during native-proof finalization. In EI-27041330081257644, the producer retained 67,108,225 content bytes under its 64MiB budget and honestly marked later content unavailable. The consumer then charged the manifest and a second reporter read against that same content budget, throwing `custody limit` instead of returning the saved partial verdict. This was consumer accounting, not a failing native fork assertion.

A later custody run exposed a second accounting defect. `custodyReferences` scans evaluator metadata through `rows`, `diagnostics`, and `nativeRun.files`; these can repeat the same artifact reference. The 4,096 limit was applied to occurrence count, so repeated views could exhaust it while referring to very few distinct artifacts. Separately, one byte/object budget was shared by families A-D and auxiliary command, stream, report, and cleanup receipts. A large evaluator or process family could use the shared cap first and make later families look absent.

## Durable boundary

`verifyNativeProofPacket` reads manifest metadata outside the producer content budget and reads each family's reporter bytes once for reference validation. Failed-family content stays unavailable; no limit increase turns missing content into qualified proof.

New packets use `native-proof-custody-v2`. The manifest keeps evaluator occurrences with their locations in `references`, and records the content-addressed unique population separately in `referenceArtifacts`. Repeated references to one `codeRef` count once toward the 8,192-artifact limit; conflicting pins for the same path are rejected. Occurrence locations remain individually verifiable, with a separate 65,536 occurrence ceiling and an explicit gap if that ceiling is reached.

The total read ceilings remain 64MiB and 16MiB per object. Family byte/object budgets partition the total: A 16MiB/4,096 objects, B 24MiB/8,192, C 12MiB/2,048, D 4MiB/1,024, and auxiliary 8MiB/1,024. The partition sums to the existing global ceilings. The manifest records bytes and object reads by family; a family limit produces a family-specific gap and leaves the other families' budgets available. A family with retained entries is marked partial. Verification checks a matching group/family gap, so an unrelated gap cannot excuse a missing receipt. The consumer still accepts v1 packets under their original global limits.

## Verification

Use the maintained `private native proof custody (P002)` cases in `packages/operator-core/lib/__tests__/affected-tests-budgeted-scheduler.test.ts`, including the repeated-reference and family-budget regressions. Focus the current working tree with `testing:run { files: ["packages/operator-core/lib/__tests__/affected-tests-budgeted-scheduler.test.ts"], harness: "papercusp", testNamePattern: "private native proof custody" }`. The focused suite also covers retained-only verification after producer retirement and explicit partial verdicts.

An assertion pass, successful custody verification, complete custody, and qualified operational acceptance are separate verdicts. A partial packet may verify successfully while its native proof stays unqualified and acceptance stays unmeasured.

# Native proof custody: keep metadata separate from retained content
URL: /internal/docs/agent-insights/native-proof-custody-content-and-metadata-budgets

Diagnose custody finalization at the 64MiB boundary without increasing limits or presenting partial native proof as qualified acceptance.

## Symptom and measured cause

A passing test cohort can still fail its wrapper during native-proof finalization. In EI-27041330081257644, the producer retained 67,108,225 content bytes under its 64MiB budget and honestly marked later content unavailable. The consumer then charged the manifest and a second reporter read against that same content budget, throwing `custody limit` instead of returning the saved partial verdict. This was consumer accounting, not a failing native fork assertion.

## Durable boundary

`verifyNativeProofPacket` reads manifest metadata under the existing per-object bound, independently from the producer content budget. It reads each family's reporter bytes once and reuses them for reference validation. Failed-family content stays unavailable. No limit is raised; missing content never becomes qualified proof. `scripts/test-files.mjs` finishes custody before publishing its terminal marker and prints a phase-specific diagnostic with a nonpassing exit when finalization itself fails.

## Verification

Use the maintained `private native proof custody (P002)` cases in `affected-tests-budgeted-scheduler.test.ts`, including the nearly-full-content-budget regression and explicit partial verdict. The router test `settles native proof custody before reporting a measured result and refuses green when it fails` guards detector behavior. Run through `npm run test:file -- <paths> -- --testNamePattern=<selector>`; filters exclude other assertions and are not full-suite proof. Pin acceptance to committed source with `lint:as-committed` and retain durable ledger/source receipts.

## Claim discipline

An assertion pass, successful custody verification, complete custody, and qualified operational acceptance are separate verdicts. A partial packet may verify successfully while its native proof stays unqualified and acceptance stays unmeasured. The original r65 cohort had passing assertion receipts but a failed wrapper and is not successful committed acceptance. Later r71 committed guards pass with explicit partial native custody, not full operational qualification.

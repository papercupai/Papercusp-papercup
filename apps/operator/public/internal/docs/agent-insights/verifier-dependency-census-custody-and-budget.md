# Keep verifier census custody and deadlines intact
URL: /internal/docs/agent-insights/verifier-dependency-census-custody-and-budget

How to diagnose dependency enumeration failures without confusing snapshot populations, and preserve the selected generation after cleanup.

A managed immutable verifier can fail before test collection while enumerating its copied dependencies. Treat its snapshot population separately from a later donor scan. In the 2026-10-29 P001 incident, the failed copy logged 98 published trees; later scans selected 48 donor trees and 46 source-root trees. Those smaller scans did not reproduce the failed copy or prove a resource-pressure cause.

Use the task's archived snapshot.txt, source.json and phases.jsonl to recover the original selected generation, token and first failing phase. The verifier saves the original .papercusp-pinned-deps bytes immediately after deps.snapshot, before census and owned-tree cleanup; archiveVerifierTaskEvidence retains them even when census fails. Older archives can lack this artifact. A surviving input index can reconstruct a selection, but must be labeled reconstruction rather than contemporaneous custody.

The product enumeration still uses dependency\_generation\_enumerate\_node\_modules, including foreign-checkout, ignore and ancestor-lock rules. Its install filter runs once per enumeration and caches parsed locks only within that call. Repeated calls must see equal-length lockfile edits. Malformed ancestor custody keeps a tree visible; it cannot justify omission. Relative roots retain their original output spelling while comparisons use absolute paths.

Managed preparation and postverification enumerate through runVerifierDependencyCommand, which owns cancellation, process-group exit and the caller's cleanup deadline. They share the same installed-byte census as synchronous captureVerifierDependencies; enumeration optimization does not skip content, mode, symlink or population verification. Dependency helper subprocesses pin DEPENDENCY\_GENERATION\_NODE to process.execPath and clear NODE\_OPTIONS/NODE\_PATH, so sanitized compiler PATH values and inherited overrides cannot select another interpreter.

Maintained guards are in source-preview-export.test.ts (installed-byte mutations, census deadline/cancellation, original custody after failed census, shadow PATH/override) and dependency-generation.test.ts (98 candidates, one Node launch, next-call lock invalidation, malformed custody, relative roots, failure propagation). A same-donor comparison measured 28.816s before and 18.587s after with identical 48-tree population; this single comparison does not establish the cause of the historical 61.721s failure.

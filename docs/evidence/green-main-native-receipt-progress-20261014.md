# Native green-main acceptance receipt progress

Status: local verification complete for the receipt fix; the full plan is unshipped and acceptance remains unapproved.

The native operational serializer discarded the maintained producer's command arguments. In particular, an admission history receipt did not retain its install identity in structured execution details. EI-25948814148775899 extends the existing receipt contract with the exact command, snapshots it before execution, preserves it through the shared PostgreSQL writer, and keeps legacy receipts valid without inventing their missing scope. No new ledger, tool or runtime was introduced.

A maintained guard failed on the original serializer's missing command field. After the fix, the complete three-file parser, recorder and real-PostgreSQL verification passed 106 tests (35 + 58 + 13), with zero skips or child substitutions. The selected six-file typecheck passed; the two test-config files were routed to that workspace's successful compile. This is current-local proof at source base 878af7db08, with three dirty test paths. It is not operational Goal or shipment evidence. The saved logs are `~/.papercusp/scratch/c0523-operational-command-{red,green,tsc}.log`.

The machine proposal is `docs/evidence/green-main-native-acceptance-contract-20261014.json`. Its five SQL templates demand exact native receipt IDs, producer/install/window arguments, complete assertion identities, clean source, original-population hashes, and measured runtime observations bracketing execution. The proposed R-11 statement preserves both cap-specific branches in its falsifier. Source-symbol, assertion, atomicity, probe-shape and read-only SQL checks passed. Parameters and live schema revision remain unbound; semantic review is still required. No BAR amendment was applied.

The current subject remains revision 129 and rubric revision 5; activation audit 5 stays recorded. The D-020 owner confirmed that no verified prerequisite receipt exists, so the P-006 hold remains. Full same-file-set performance proof, actual P-028 pickup/cadence, genuine alarm onset/delivery evidence, seven days of live P-018 passes, the single complete outside-lineage review and final D-045/P-031 shipment evidence remain. EI-25932550248841646's historical cause remains unknown.

Source and successor state: `docs/evidence/green-main-acceptance-recovery-20261014.json`, WI-6554700010010682. Existing AUTO/self execution and warm 120-second work loop are preserved.

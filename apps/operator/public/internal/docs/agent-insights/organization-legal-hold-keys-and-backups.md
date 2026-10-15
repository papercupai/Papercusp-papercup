# Organization legal holds, key shred, rotation and backup retention
URL: /internal/docs/agent-insights/organization-legal-hold-keys-and-backups

Legal-hold conflict rules for keys, organization artifacts and guarded host Kopia/dump retention.

## Scope and decision

This is the assumed internal engineering profile of enterprise-readiness D-009/D-010, implemented by P-017e WI-6554700010013233 and decision D-027. It is not evidence of an external customer's retention requirements or assurance certification.

## Organization key shred

An active legal hold wins over a request to crypto-erase the organization. `createOrganizationKeyService().shred` authorizes the actor, checks the confirmation id, and resolves every owned `customer_workspaces.id` plus the explicitly supplied workspace ids. The customer `id` is the data-plane slug; the row's `workspace_id` identifies the hosting control workspace. An empty or incomplete caller scope cannot hide an owned held workspace. Deleted customer-workspace rows remain in the census because their historical content can survive in a backup.

The transaction takes SHARE locks on the customer-workspace mapping and legal-hold tables before its final check. This serializes the check and key destruction against mapping changes and all hold writers, including the low-level `placeLegalHold` writer. The rare destructive transaction performs only local database work while holding these locks; it does not call a KMS. It also locks custody before changing keys.

Any active hold vetoes shred, even if its live retained row counts are zero. Live emptiness cannot prove that a historical backup contains no held content. The refusal commits an `organization.keys.shred_refused` organization audit event containing the workspace and hold identities, source/container and retained counts. Only after that commit does the service throw `OrganizationKeyShredRefusedError` with code `legal-hold-active`, `holdIds` and `auditEventId`. Throwing inside the transaction would roll the refusal audit back, so the transaction returns a refusal and the outer method throws it. Custody, wrapped DEKs and existing backup decryption remain intact. After release the existing confirmed shred path may proceed and its receipt includes the discovered workspace scope.

This guards Papercusp's local key-shred operation. It cannot stop a customer from destroying their KEK directly in their own KMS, or recover such a destroyed external key.

## DEK rotation and held documents

Rotation is allowed: older DEKs become decrypt-only and remain available. The compare-and-swap reseal sweep decrypts the old envelope, preserves its title/text, seals under the new active DEK and rebuilds blind terms. It changes only `sealed_content` and `blind_terms`, so the hold's identity/content protection remains in force. The recurrence test uses a non-chat source document (not a chat-derived exemption), verifies the new envelope opens to the same title/text and that the database still refuses its deletion while the hold remains active.

## Organization backup artifacts

`exportOrganizationBackup` currently produces sealed export streams; this surface has no scheduled artifact store or pruner. `organizationBackupRetentionDecision(scope, activeHolds)` supplies the retention veto that a future artifact pruner must enforce. An artifact with any workspace intersecting an active hold must be kept, including when it may be the only historical copy. This deliberately retains all potentially covered artifacts rather than trying to infer redundancy from live counts. Releasing the last intersecting hold removes only this veto; ordinary age/count retention still decides when to prune.

The caller must obtain fresh `holdConflicts` for the artifact's complete workspace scope immediately before deletion. A cached decision is not a deletion authorization. Host Kopia snapshots and dump rotation use the separate guarded host plane described below (EI-25985604292707665). `lib/storage/retention-policy.ts` describes host disk policy, not organization artifact pruning.

## Host snapshots and raw database dumps

The workspace hook includes the shared data plane in its dump; a snapshot owned by one workspace can contain held data from another. Host retention therefore conservatively checks every active hold in that database, regardless of live retained-row counts. The existing optional `BackupHost.withRetentionLease` seam is wired by the operator to a dedicated admin session. It takes a SHARE table lock before reading holds and retains it through the destructive callback, so the low-level placement and release writers serialize with expiry. Capture stays outside this lease.

Kopia expires snapshots during creation. The guarded workspace engine and the existing host script helper pin the existing manifests before capture and pin the new snapshot on creation. A fresh lease permits removing only `papercusp-legal-hold-retention` and running expiry when there are no active holds. An unreadable hold state or malformed manifest list refuses expiry. Other operator/manual pins survive release. Maintenance reuses the existing capture/migration rendezvous before pinning artifacts, so it cannot remove safety pins during an in-flight capture. Its final expiry uses the same hold lease; success and failure both release the rendezvous.

Pin changes replace Kopia manifest IDs. New and recovered receipts use the stable `rootEntry.obj` content ID; existing receipt IDs are converted before their manifest is pinned. Older manifests without a root retain the legacy fallback. Restore accepts the stable object ID.

The raw dump producers preserve the prior successful bytes before replacement under a hold, including when that dump has never reached Kopia. The workspace gzip producer hardlinks the old file into its `.legal-hold` directory; the directory-format host producer moves the old dump into its adjacent archive. Both archives remain in the snapshotted dump tree. An unheld lease permits cleaning these managed archives on a subsequent successful dump. Capture failures leave the previous successful dump intact.

The embedded Kopia explorer exposes a GET/HEAD-only loopback proxy to a private, password-protected Kopia server. The proxy injects an ephemeral backend credential that the browser never receives. A real isolated test disproved the initial assumption that `--readonly`, even with `--no-control-api`, blocks HTML UI snapshot deletion; those flags are defense in depth, not the authorization boundary. The proxy refuses POST, PUT, PATCH, DELETE and OPTIONS with 403. Tests verify browsing, rejected mutation methods and GET deletion, and restoration of the historical bytes afterward. Kopia's GET-only listing API returns its normal 404 for HEAD. Startup waits for the actual listening socket before returning the explorer URL.

This is a host-wide conservative veto, not organization-selective pruning. Standalone embedders without the optional host seam retain their existing behavior. An external administrator with independent repository credentials, direct filesystem access or customer KMS control remains outside the supported local guard. No live owner backup data, settings or retention policy was mutated during this implementation's verification.

## Recurrence checks

Use the canonical runner:

```bash
npm run test:file -- packages/operator-core/lib/data-governance/organization-keys.integration.test.ts packages/operator-core/lib/data-governance/organization-backup-sealing.test.ts packages/operator-core/lib/data-governance/organization-document-reseal.integration.test.ts
```

The key test omits the held customer slug from caller input, verifies the committed refusal audit and unchanged custody/DEKs, opens a backup through a cold service, then releases the hold and observes both pruning eligibility and successful shred. The backup unit cases cover intersecting/nonintersecting holds and release. The reseal case proves held non-chat content remains readable and deletion stays blocked. Restore/e-discovery stays on P-017d; receipt-on-persistence work P-017f is separate.

Host-plane checks use the same canonical runner:

```bash
npm run test:file -- packages/backup/src/workspace-backup-safety.test.ts packages/backup/src/policy.test.ts packages/backup/src/snapshot-receipt-recovery.test.ts packages/backup/src/server.test.ts packages/backup/src/hook.test.ts packages/operator-core/lib/data-governance/legal-holds.integration.test.ts apps/operator/scripts/__tests__/kopia-cache-bootstrap.test.ts apps/operator/scripts/__tests__/kopia-snapshot-source-order.test.ts apps/operator/scripts/__tests__/kopia-home-snapshot.test.ts
```

The real temporary Kopia repository checks retain and restore historical bytes under aggressive retention, then permit expiry after release while preserving independent pins. The isolated PostgreSQL case proves a direct hold writer waits for the host expiry lease and that holds elsewhere in the dumped database are included. Receipt, dump replacement, unreadable-state and readonly-explorer checks guard the remaining boundaries.

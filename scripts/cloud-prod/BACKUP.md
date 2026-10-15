# Production database backup and restore

This runbook belongs to P-009 of `cloud-portal-public-release-2026-10-13`.
The production source is `papercusp-cloud-prod/pc-cloud-prod-pg`.
It contains `papercusp_hosted`, `portal` and `dbos_system`.
Managed daily backups and seven-day PITR were read back on 2026-10-14.
The nightly logical-export configuration is still a preview; it is not deployed.

## PITR drill

Run from the canonical staging tree with the approved GCP provisioning identity.
Keep credentials outside the repository. The existing P-004 secret references
supply authentication to the temporary SQL Data API window; values do not enter
argv, logs or the receipt.

```bash
npx tsx scripts/cloud-prod/backup-restore-drill.ts plan
npx tsx scripts/cloud-prod/backup-restore-drill.ts drill
```

`plan` reads the recovery window and prints the procedure. `drill` creates a
nonce-named canary schema in the source, commits a row, chooses a database-server
timestamp, then commits a second row. It waits for archived WAL to cover that
timestamp and creates a separate `pc-pitr-drill-<nonce>` instance. It verifies
that the first row is present and the second is absent. A current-state clone
would contain both rows and must fail this check. Success requires a measured
restore time no greater than one hour.

The JSON receipt records source, scratch, schema, restore point, latest recovery
time, measured RPO/RTO, row counts and cleanup outcomes. Preserve the complete
receipt on the work item and in the evidence store. Do not call the drill complete
unless all cleanup fields are true. RPO here is the measured lag of the latest
recoverable WAL timestamp when the clone is submitted, not an advertised SLA.

## Cleanup after interruption or failure

Read the last receipt and the Cloud SQL operation before retrying. A still-running
operation is not a failed clone. Do not reuse a predecessor's numeric shell handle
and do not start a second drill just because a terminal yielded empty output.

1. Describe the exact scratch instance named in the receipt. Confirm it is the
   nonce-owned instance created by this drill, on the production private network.
2. Close its Data API and disable deletion protection on that scratch only.
   Cloud SQL clones inherit deletion protection from production.
3. Delete the scratch and verify that describing it returns `NOT_FOUND`.
4. Remove only the exact nonce-owned canary schema from the source. Close the
   source Data API even if removing the canary fails.
5. Read back source `dataApiAccess=DISALLOW_DATA_API` and deletion protection.
   Record any unresolved cleanup residue with an assigned work item.

The CLI performs these steps automatically on normal completion or caught errors.
After process death, reconciliation must complete them using the recorded nonce
and operation. Never clear deletion protection on the production source.

After cleanup, `verify-receipt` reconciles the saved evidence through read-only
source, scratch and operation descriptions and emits an operational test receipt:

```bash
npx tsx scripts/cloud-prod/backup-restore-drill.ts verify-receipt < saved-evidence.json
```

It preserves the original receipt, including failed cleanup, and rejects a
permission/transport failure as proof that the scratch is absent. The saved
canary-removal observation remains historical: reconciliation does not reopen SQL
or rerun PITR. Register the new committed receipt with `testing:record-run`; retain
the original evidence alongside it.

## Nightly logical exports and age detector

`nightly-backup-plan.ts` builds a preview for cloud-owned exports. Separate backup
storage and workflow/scheduler accounts prevent a hosted runtime credential from
deleting backups. A dedicated backup custodian owns restore/retention access.
The Cloud SQL writer receives object-creation permission on that bucket only.
The workflow identity receives export/get/operation-read permissions. The scheduler
gets only `workflows.executions.create` in the dedicated backup project. Google
Workflows exposes project-level IAM; there is no per-workflow policy API. This
role cannot cancel executions, change workflows or administer storage. Keep the
backup project dedicated to this operation. No long-lived private key is needed.

The workflow exports each database to a unique compressed SQL object, waits for
the Cloud SQL operation to finish successfully, then records a completion metric.
A failed or pending operation must not advance backup health. Each database gets
its own 26-hour completion-absence alarm. The first successful export must seed
each series; verify missing/failed exports trigger the detector and reach the
approved notification channel. An object existing in storage does not prove
freshness or restorability (WI-10000694).

`provisionNightlyBackups` extends this builder and the P-004 gcloud seam. `plan`
reads prerequisites and returns proposed mutations. `up` creates missing resources
and reads each back; repeating it with the same configuration makes no changes.
`verify` refuses any missing resource or drift. Existing drift fails closed rather
than overwriting a bucket, weakening retention or replacing an alert.

Before `up`, select the separately administered backup project, obtain P-011's
retention decision and a storage decision, and verify owner notification channels.
Pass their addressable decision references and a separate human/group backup
administrator in `approval`. The project must be active, under the approved
organization and billing account; recipients must be enabled and verified.
The provisioner checks direct project and bucket grants for the hosted runtime;
an inherited IAM-policy audit remains part of deployment acceptance.

The provisioner leaves schedule creation pending until `activationEvidence`
names both a verified logical export/restore and an alarm delivered through the
approved channel. Restore a logical export in a scratch database and verify
representative rows before recording those references. GCP Cloud Scheduler runs
this production backup outside the dev-box plan/routine engine so a dev-box outage
cannot stop backups. Do not confuse configuration tests with an armed schedule,
a validated GCP workflow or a proven live alert.

The CLI accepts a non-secret JSON configuration through stdin:

```bash
npx tsx scripts/cloud-prod/nightly-backup-plan.ts plan < /secure/backup-input.json
npx tsx scripts/cloud-prod/nightly-backup-plan.ts up < /secure/backup-input.json
npx tsx scripts/cloud-prod/nightly-backup-plan.ts verify < /secure/backup-input.json
```

Use the `BackupPlanOptions` fields plus `approval` described above. Do not use
the test suite's example project, recipient or decision references as live input.
The CLI pins `PROD_SPEC` and rejects any input attempting to replace it.

## Verification

Project-native suites:

- `backup-restore-drill.test.ts`: orchestration, deadline, cleanup and freshness.
- `backup-restore-drill.integration.test.ts`: a real isolated Postgres dump/restore,
  committed-row proof and missing-row counterexample.
- `nightly-backup-plan.test.ts`: separation of identities/storage and completion
  detector configuration. It does not validate a deployed GCP workflow.

Live Cloud SQL PITR supplies the provider-specific recovery evidence. The local
logical-restore test validates the row-check instrument; it is not proof that
Cloud SQL PITR ran. Final shipment still requires the full P-009 acceptance bar,
including the deployed export, detector and restore proofs.

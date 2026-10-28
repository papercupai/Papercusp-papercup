/**
 * AWS identifier patterns for the SSM-SSH connection profile, with no imports at all.
 *
 * They live apart from local-connection-manager.ts, which spawns OpenSSH and therefore imports
 * node:child_process, so that a profile normalizer (apps/operator/scripts/psu-connection-store.mjs)
 * can validate a saved AWS profile without loading a subprocess module. That store is read on a
 * sync-resolver path, which must not reach node:child_process (sync-resolver/no-heavy-io-on-read-path.test.ts,
 * WI-6554700010030748). local-connection-manager.ts re-exports these unchanged.
 */

/** An AWS region code (us-east-2, us-gov-west-1, …); also refuses anything shell-shaped. */
export const AWS_REGION_PATTERN = /^[a-z]{2}(?:-gov|-iso[a-z]*)?-[a-z]+-[0-9]$/;
/** An EC2 instance id, short (8 hex) or long (17 hex) form. */
export const AWS_EC2_INSTANCE_ID_PATTERN = /^i-[0-9a-f]{8}(?:[0-9a-f]{9})?$/;
/** A named AWS CLI profile (`--profile`). */
export const AWS_CLI_PROFILE_PATTERN = /^[A-Za-z0-9_.+-]{1,64}$/;

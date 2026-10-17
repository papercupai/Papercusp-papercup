import { WORKSPACE_HOST_BOOTSTRAP_STATUS_CONSOLE_MARKER } from '@papercusp/deployment-driver';
import {
  AWS_DATA_DEVICE_WAIT_SEC,
  AWS_HOST_BOOTSTRAP_ENCODED_PAYLOAD_MAX_BYTES,
  AWS_HOST_BOOTSTRAP_PUSH_EXECUTION_TIMEOUT_SEC,
  AWS_HOST_BOOTSTRAP_STAGING_DIR,
  AWS_HOST_BOOTSTRAP_UNIT,
  awsEbsNvmeDevicePathCore,
  renderAwsHostBootstrapPushCore,
} from './aws-host-bootstrap-push-core.mjs';

export {
  AWS_DATA_DEVICE_WAIT_SEC,
  AWS_HOST_BOOTSTRAP_ENCODED_PAYLOAD_MAX_BYTES,
  AWS_HOST_BOOTSTRAP_PUSH_EXECUTION_TIMEOUT_SEC,
  AWS_HOST_BOOTSTRAP_STAGING_DIR,
  AWS_HOST_BOOTSTRAP_UNIT,
};

/**
 * Delivery of the controller-rendered host bootstrap to an EC2 workspace host (plan
 * aws-byoc-gcp-parity-2026-10-01 D-013, WI-10005172).
 *
 * WHY NOT USERDATA: the realistic bootstrap is ~52.7 KB raw and ~14.8 KB gzip; EC2 UserData is
 * capped at 16 KiB raw, and the data volume is attached AFTER RunInstances, so a first-boot script
 * could neither carry the bootstrap nor rely on the volume being there. Instead, once the volume is
 * attached, the controller pushes gzip+base64(durable mount + bootstrap) over SSM Run Command
 * (AWS-RunShellScript). The wrapper verifies the payload's sha256, then starts it as a transient
 * systemd unit so it outlives the Run Command invocation.
 */

/** SSM document the push runs through; the instance profile's SSM agent executes it as root. */
export const AWS_HOST_BOOTSTRAP_SSM_DOCUMENT = 'AWS-RunShellScript';

/**
 * The stable device path of an attached EBS volume on a Nitro instance. The NVMe controller's
 * serial is the volume id without its hyphen, and udev publishes it under /dev/disk/by-id. The
 * attach request's `Device` name is NOT the guest's device name on Nitro, so it is never used.
 */
export function awsEbsNvmeDevicePath(volumeId: string): string {
  return awsEbsNvmeDevicePathCore(volumeId);
}

export interface AwsHostBootstrapPush {
  /** The lines passed as AWS-RunShellScript's `commands` parameter. */
  commands: readonly string[];
  /** sha256 of the decoded script the host will run. */
  scriptSha256: string;
  /** Size of the base64 payload carried in `commands`. */
  encodedPayloadBytes: number;
}

/**
 * Render the Run Command lines that install and start the durable mount + host bootstrap for one
 * attached data volume. Refuses a payload over the ceiling here, with the ceiling named, instead of
 * letting SSM reject it with a generic size error mid-provision.
 */
export function renderAwsHostBootstrapPush(input: { volumeId: string; hostBootstrapScript: string; dataMode?: 'fresh' | 'existing'; tenantIdentity?: string; allocation?: { dbGiB: number; workspaceGiB: number } }): AwsHostBootstrapPush {
  return renderAwsHostBootstrapPushCore({
    ...input,
    statusMarker: WORKSPACE_HOST_BOOTSTRAP_STATUS_CONSOLE_MARKER,
  });
}

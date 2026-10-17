export declare const WORKSPACE_HOST_DURABLE_DATA_MOUNT_POINT: string;
export declare const WORKSPACE_HOST_DURABLE_WORKSPACE_ROOT: string;
export declare const AWS_HOST_BOOTSTRAP_ENCODED_PAYLOAD_MAX_BYTES: number;
export declare const AWS_HOST_BOOTSTRAP_UNIT: string;
export declare const AWS_HOST_BOOTSTRAP_STAGING_DIR: string;
export declare const AWS_DATA_DEVICE_WAIT_SEC: number;
export declare const AWS_HOST_BOOTSTRAP_PUSH_EXECUTION_TIMEOUT_SEC: number;

export interface DurableFilesystemScriptCoreInput {
  allocation?: { dbGiB: number; workspaceGiB: number };
  tenantIdentity?: string;
  dataMode?: 'fresh' | 'existing';
  devicePath: string;
  deviceWaitSec: number;
  hostBootstrapScript?: string;
  workspaceDataRoot?: string;
}
export interface AwsHostBootstrapPushCoreInput {
  allocation?: { dbGiB: number; workspaceGiB: number };
  tenantIdentity?: string;
  dataMode?: 'fresh' | 'existing';
  volumeId: string;
  hostBootstrapScript: string;
  statusMarker: string;
  deviceWaitSec?: number;
  workspaceDataRoot?: string;
  stagingDir?: string;
  unit?: string;
}
export interface AwsHostBootstrapPushCore {
  commands: string[];
  scriptSha256: string;
  encodedPayloadBytes: number;
}
export declare function awsEbsNvmeDevicePathCore(volumeId: string): string;
export declare function workspaceHostDurableTenantIdentity(workspaceId: string, customerWorkspaceId: string): string;
export declare function renderDurableTenantGuardCore(tenantIdentity?: string): string[];
export declare function renderDurableDataProbeCore(dataMode?: 'fresh' | 'existing', allocation?: DurableFilesystemScriptCoreInput['allocation']): string[];
export declare function renderDurableToolPrerequisiteCore(): string[];
export declare function validateDurableStorageAllocationCore(allocation?: DurableFilesystemScriptCoreInput['allocation']): void;
export declare function renderDurableStorageQuotaCore(allocation?: DurableFilesystemScriptCoreInput['allocation'], tenantIdentity?: string): string[];
export declare function renderDurableFilesystemScriptCore(input: DurableFilesystemScriptCoreInput): string;
export declare function renderAwsHostBootstrapPushCore(input: AwsHostBootstrapPushCoreInput): AwsHostBootstrapPushCore;

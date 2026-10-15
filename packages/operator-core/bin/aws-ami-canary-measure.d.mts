/** Types for aws-ami-canary-measure.mjs (papercusp-aws-ami-clean-account-canary's pure logic, WI-10005604). */
import type { WorkspaceHostBootstrapReportedStatus } from '@papercusp/deployment-driver';

export declare const AWS_AMI_CANARY_TOOL: 'papercusp-aws-ami-clean-account-canary';
export declare const ATTESTATION_PREFIX: string;
export declare const DEFAULT_CANARY_ROLE_NAME: string;
export declare const CANARY_RUN_TAG: string;
export declare const CANARY_FIXTURE_TAG: string;
export declare const CANARY_DATA_VOLUME_GIB: number;
export declare const CANARY_DATA_VOLUME_TYPE: 'gp3';
export declare const CANARY_DATA_VOLUME_DEVICE: '/dev/sdf';
export declare const DIAGNOSTICS_MAX_CHARS: number;
export declare const DIAGNOSTICS_SECTION_MAX_CHARS: Readonly<{ status: number; startSamples: number; recentLogs: number }>;
export declare const ROOT_VOLUME_INITIALIZATION_RATE_MIBPS: number;
export declare const BOOT_CONSOLE_MAX_CHARS: number;
export declare const BOOT_CONSOLE_POLL_EVERY: number;
/** A boot console reduced to its bounded tail plus the lines naming a failed boot (WI-10006518). */
export interface BootConsoleSummary {
  fatal: boolean;
  note?: string;
  tail: string;
  failureLines: string[];
}
export declare function summarizeBootConsole(raw: string | null | undefined): BootConsoleSummary;
export interface AwsAmiCanaryBudgets {
  ssmDeliveryMs: number;
  runningMs: number;
  ssmOnlineMs: number;
  volumeAvailableMs: number;
  volumeAttachedMs: number;
  bootstrapMs: number;
  bootstrapPushMs: number;
  shortCommandMs: number;
  terminateMs: number;
  volumeDetachMs: number;
  volumeDeleteMs: number;
  pollMs: number;
}
export declare const CANARY_BUDGETS: Readonly<AwsAmiCanaryBudgets>;

export interface AwsAmiCanaryFixture {
  fixtureId: string;
  bootstrapScript: string;
  bootstrapScriptSha256: string;
  serviceName: string;
}
export interface AwsAmiCanaryInput {
  accountId: string;
  region: string;
  subnetId: string;
  instanceProfileArn: string;
  imageId: string;
  releaseVersion: string;
  releaseSha256: string;
  buildManifestIdentity: string;
  fixture: AwsAmiCanaryFixture;
}
export type CanaryEnv = Readonly<Record<string, string | undefined>>;
export interface CanaryTag {
  Key: string;
  Value: string;
}
export interface CanaryInvocation {
  status: string;
  stdout?: string;
  stderr?: string;
  responseCode?: number;
}
export interface AwsAmiCanaryDeps {
  callerAccount(): Promise<string>;
  describeImage(
    imageId: string,
  ): Promise<{ state: string; architecture: string; rootDeviceName?: string; rootEncrypted?: boolean } | null>;
  describeSubnet(subnetId: string): Promise<{ subnetId: string; vpcId?: string; availabilityZone?: string } | null>;
  createDataVolume(input: {
    availabilityZone: string;
    sizeGiB: number;
    volumeType: 'gp3';
    encrypted: true;
    tags: readonly CanaryTag[];
  }): Promise<string>;
  /** Null means the state could not be observed; only state:'deleted' proves deletion. */
  describeVolume(volumeId: string): Promise<{
    state: string;
    attachmentState?: string | null;
    attachedInstanceId?: string | null;
  } | null>;
  attachVolume(input: { instanceId: string; volumeId: string; deviceName: string }): Promise<void>;
  detachVolume(volumeId: string): Promise<void>;
  deleteVolume(volumeId: string): Promise<void>;
  runInstance(input: {
    imageId: string;
    subnetId: string;
    instanceProfileArn: string;
    instanceType: string;
    tags: readonly CanaryTag[];
    /** The AMI's root device; set together with the rate below (WI-10006110). */
    rootDeviceName?: string;
    volumeInitializationRateMiBps?: number;
    /** Encrypt the root at launch with the account's default EBS key (unencrypted AMIs only, WI-10006518). */
    encryptRootVolume?: boolean;
  }): Promise<string>;
  describeInstance(instanceId: string): Promise<{ state: string; publicIpv4?: string | null; stateReason?: string | null }>;
  ssmPingStatus(instanceId: string): Promise<string | null>;
  /** The instance's latest serial console capture, decoded; null when there is none yet. */
  consoleOutput(instanceId: string): Promise<string | null>;
  sendCommand(input: { instanceId: string; commands: readonly string[]; executionTimeoutSec: number }): Promise<string>;
  getInvocation(input: { commandId: string; instanceId: string }): Promise<CanaryInvocation | null>;
  terminate(instanceId: string): Promise<void>;
  censusByRunTag(runId: string): Promise<readonly string[]>;
  now(): number;
  sleep(ms: number): Promise<void>;
  runId(): string;
}
export interface AwsAmiCanaryObservation {
  runId: string;
  instanceId: string | null;
  dataVolumeId: string | null;
  dataVolumeAttached: boolean;
  dataVolumeDeleted: boolean;
  publicIpv4Assigned: boolean;
  ssmOnline: boolean;
  bootstrapStatus: WorkspaceHostBootstrapReportedStatus | null;
  attestation: Record<string, unknown> | null;
  serviceHealthy: boolean;
  terminated: boolean;
  residualResourceIds: string[];
  teardownErrors: string[];
}
export interface AwsAmiCanaryPlan {
  run: string[];
  readAttestation: string[];
  serviceCheck: string[];
  readDiagnostics: string[];
}

export declare function sha256Hex(value: string): string;
export declare function parseAwsAmiCanaryInput(raw: unknown): AwsAmiCanaryInput;
export declare function canaryRoleArn(accountId: string, region: string, env?: CanaryEnv): string;
export declare function instanceTypeFor(architecture: string, env?: CanaryEnv): string;
export declare function canaryTags(input: AwsAmiCanaryInput, runId: string): CanaryTag[];
export declare function canaryDataVolumeTags(input: AwsAmiCanaryInput, runId: string): CanaryTag[];
export declare function ssmScriptPlan(fixture: AwsAmiCanaryFixture, volumeId: string): AwsAmiCanaryPlan;
export declare function extractAttestation(stdout: string): Record<string, unknown>;
export declare function runAwsAmiCleanAccountCanary(
  input: AwsAmiCanaryInput,
  deps: AwsAmiCanaryDeps,
  env?: CanaryEnv,
  budgets?: AwsAmiCanaryBudgets,
): Promise<AwsAmiCanaryObservation>;
export declare function buildAwsAmiCanaryProof(
  input: AwsAmiCanaryInput,
  observed: AwsAmiCanaryObservation,
  observedAt: string,
): {
  evidenceRef: string;
  accountId: string;
  region: string;
  imageId: string;
  buildManifestIdentity: string;
  releaseVersion: string;
  releaseSha256: string;
  ssmOnline: boolean;
  bootstrapAttestationHealthy: boolean;
  serviceHealthy: boolean;
  publicIpv4Assigned: boolean;
  terminated: boolean;
  dataVolumeId: string | null;
  dataVolumeDeleted: boolean;
  residualResourceIds: string[];
  observedAt: string;
  fixtureId: string;
  attestation: Record<string, unknown> | null;
};

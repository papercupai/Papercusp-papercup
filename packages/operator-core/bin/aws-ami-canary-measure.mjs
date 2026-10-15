/**
 * aws-ami-canary-measure — the pure logic of papercusp-aws-ami-clean-account-canary
 * (WI-10005604). Everything that decides what the proof SAYS lives here, with every cloud call
 * injected through `deps`, so the launch → SSM → bootstrap → teardown → residue-census flow
 * (including teardown on every failure path) is unit-tested without an AWS account.
 *
 * TRUST RULE (same as papercusp-gcp-clean-room): every boolean in the proof is an OBSERVED
 * value read back from AWS or from the host's own attestation. `terminated` and
 * `residualResourceIds` come from the teardown's real outcome plus a tag census, so a leaked
 * instance, volume or ENI can never be reported as a clean run.
 */
import { createHash } from 'node:crypto';
import {
  WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_PREFIX,
  WORKSPACE_HOST_BOOTSTRAP_STATUS_CONSOLE_MARKER,
  parseEc2ConsoleBootstrapStatus,
} from '@papercusp/deployment-driver';

import { ToolError, fail } from './gcp-ephemeral.mjs';
import {
  AWS_HOST_BOOTSTRAP_PUSH_EXECUTION_TIMEOUT_SEC,
  AWS_HOST_BOOTSTRAP_UNIT,
  renderAwsHostBootstrapPushCore,
} from '../lib/workspace-host/aws-host-bootstrap-push-core.mjs';

export const AWS_AMI_CANARY_TOOL = 'papercusp-aws-ami-clean-account-canary';
/** Must match WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_PREFIX in @papercusp/deployment-driver. */
export const ATTESTATION_PREFIX = WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_PREFIX;
/** The role AWS Organizations creates in every member account made by CreateAccount. */
export const DEFAULT_CANARY_ROLE_NAME = 'OrganizationAccountAccessRole';
export const CANARY_RUN_TAG = 'papercusp:ami-canary-run';
export const CANARY_FIXTURE_TAG = 'papercusp:ami-canary-fixture';
/** Small, disposable data disk used to exercise the production durable-mount bootstrap path. */
export const CANARY_DATA_VOLUME_GIB = 20;
export const CANARY_DATA_VOLUME_TYPE = 'gp3';
/** EC2 attach hint only; Nitro guest discovery uses the stable NVMe volume-id path. */
export const CANARY_DATA_VOLUME_DEVICE = '/dev/sdf';
/** Bound on the service diagnostics read back after a failed bootstrap (GetCommandInvocation caps stdout at 24,000 chars). */
export const DIAGNOSTICS_MAX_CHARS = 16_000;
/**
 * Sub-budgets inside DIAGNOSTICS_MAX_CHARS for the three bootstrap sections a failed start
 * prints: systemctl status + journal, the start sampler's readings, and recent state logs.
 * The sampler section is printed AFTER the addon inventory, so it reaches neither the run's
 * 3,000-char tail nor the status section (measured on P-012 chain8, WI-10006110).
 */
export const DIAGNOSTICS_SECTION_MAX_CHARS = Object.freeze({ status: 8_000, startSamples: 6_000, recentLogs: 2_000 });
/**
 * EBS VolumeInitializationRate (MiB/s, AWS range 100-300) for the canary's AMI-restored root
 * volume. Without it the volume fetches each block from S3 on first read, and the first service
 * start of a release blocked on those reads (WI-10006110: node in D state on
 * folio_wait_bit_common, ~7s CPU over a 120s health window).
 */
export const ROOT_VOLUME_INITIALIZATION_RATE_MIBPS = 300;
/** Bound on the boot console tail carried when an instance never reaches SSM Online (WI-10006518). */
export const BOOT_CONSOLE_MAX_CHARS = 6_000;
/** While waiting for SSM Online, read the boot console every Nth ping poll (~60 s at pollMs 10 s). */
export const BOOT_CONSOLE_POLL_EVERY = 6;
/**
 * Console lines that only a FAILED boot prints. Seeing one ends the SSM wait at once. Measured on
 * P-012 chain14 (WI-10006518): the release AMI's guest rejected its root XFS log and sat in
 * emergency mode from t=90s. The canary waited the full 900 s SSM budget and then reported only
 * "SSM agent Online did not happen", with nothing that named the failed root mount.
 */
const BOOT_FATAL_PATTERNS = [
  /Failed to mount sysroot/,
  /Entering emergency mode/i,
  /You are in emergency mode/i,
  /Kernel panic - not syncing/,
  /VFS: Unable to mount root fs/,
];
/** The filesystem's own complaint, printed just before a failed root mount. */
const BOOT_CAUSE_PATTERN = /\b(XFS|EXT4-fs|BTRFS)\b.*\b(error|failed|inconsistent|corrupt)/i;
const BOOT_FAILURE_LINES_MAX = 6;
const BOOT_FAILURE_LINE_MAX_CHARS = 200;
export const CANARY_BUDGETS = Object.freeze({
  // Run Command total timeout is delivery allowance + document execution timeout.
  ssmDeliveryMs: 10 * 60_000,
  runningMs: 10 * 60_000,
  ssmOnlineMs: 15 * 60_000,
  volumeAvailableMs: 5 * 60_000,
  volumeAttachedMs: 5 * 60_000,
  bootstrapMs: 25 * 60_000,
  bootstrapPushMs: AWS_HOST_BOOTSTRAP_PUSH_EXECUTION_TIMEOUT_SEC * 1_000,
  shortCommandMs: 3 * 60_000,
  terminateMs: 10 * 60_000,
  volumeDetachMs: 5 * 60_000,
  volumeDeleteMs: 5 * 60_000,
  pollMs: 10_000,
});
const SSM_TERMINAL = new Set(['Success', 'Failed', 'TimedOut', 'Cancelled', 'Undeliverable', 'Terminated']);

const ACCOUNT_RE = /^\d{12}$/;
const REGION_RE = /^[a-z]{2}(-gov|-iso[a-z]?)?-[a-z]+-\d$/;
const SUBNET_RE = /^subnet-[0-9a-f]{8,17}$/;
const AMI_RE = /^ami-[0-9a-f]{8,17}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PROFILE_RE = /^arn:aws(?:-[a-z-]+)?:iam::(\d{12}):instance-profile\/[\w+=,.@/-]+$/;
const ROLE_RE = /^arn:aws(?:-[a-z-]+)?:iam::(\d{12}):role\/[\w+=,.@/-]+$/;
const SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9@._-]*$/;

function text(value, path) {
  if (typeof value !== 'string' || !value.trim()) fail(`${path} must be a non-empty string`);
  return value.trim();
}

function matching(value, re, path) {
  const out = text(value, path);
  if (!re.test(out)) fail(`${path} is malformed: ${out}`);
  return out;
}

export function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Validate and bind the stdin payload. The fixture's script is content-addressed: it must
 * hash to its own advertised digest BEFORE anything is launched, and the fixture must belong
 * to the exact release and manifest the proof will claim.
 */
export function parseAwsAmiCanaryInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('canary input must be a JSON object');
  const accountId = matching(raw.accountId, ACCOUNT_RE, 'accountId');
  const instanceProfileArn = matching(raw.instanceProfileArn, PROFILE_RE, 'instanceProfileArn');
  if (PROFILE_RE.exec(instanceProfileArn)[1] !== accountId) {
    fail('instanceProfileArn must live in the clean account (accountId)');
  }
  const input = {
    accountId,
    region: matching(raw.region, REGION_RE, 'region'),
    subnetId: matching(raw.subnetId, SUBNET_RE, 'subnetId'),
    instanceProfileArn,
    imageId: matching(raw.imageId, AMI_RE, 'imageId'),
    releaseVersion: text(raw.releaseVersion, 'releaseVersion'),
    releaseSha256: matching(raw.releaseSha256, SHA256_RE, 'releaseSha256'),
    buildManifestIdentity: text(raw.buildManifestIdentity, 'buildManifestIdentity'),
  };
  const fixture = raw.fixture;
  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) fail('fixture is required');
  // Exact, never trimmed: the digest is over the script's exact bytes (EI-21748220731961334).
  if (typeof fixture.bootstrapScript !== 'string' || !fixture.bootstrapScript) {
    fail('fixture.bootstrapScript must be a non-empty string');
  }
  const bootstrapScriptSha256 = matching(fixture.bootstrapScriptSha256, SHA256_RE, 'fixture.bootstrapScriptSha256');
  if (sha256Hex(fixture.bootstrapScript) !== bootstrapScriptSha256) {
    fail('fixture.bootstrapScript does not match fixture.bootstrapScriptSha256');
  }
  if (fixture.manifestIdentity !== input.buildManifestIdentity) {
    fail('fixture.manifestIdentity does not match buildManifestIdentity');
  }
  if (fixture.image?.version !== input.releaseVersion) fail('fixture.image.version does not match releaseVersion');
  const service = fixture.bootstrapInput?.service;
  const serviceName = matching(service?.name, SERVICE_RE, 'fixture.bootstrapInput.service.name');
  return {
    ...input,
    fixture: {
      fixtureId: text(fixture.fixtureId, 'fixture.fixtureId'),
      bootstrapScript: fixture.bootstrapScript,
      bootstrapScriptSha256,
      serviceName,
    },
  };
}

function partitionFor(region) {
  if (region.startsWith('us-gov-')) return 'aws-us-gov';
  if (region.startsWith('cn-')) return 'aws-cn';
  return 'aws';
}

/** The role the publisher assumes INTO the clean account; an override must stay in that account. */
export function canaryRoleArn(accountId, region, env = {}) {
  const override = env.PAPERCUSP_AWS_AMI_CANARY_ROLE_ARN?.trim();
  if (override) {
    const match = ROLE_RE.exec(override);
    if (!match) fail(`PAPERCUSP_AWS_AMI_CANARY_ROLE_ARN is malformed: ${override}`);
    if (match[1] !== accountId) fail('PAPERCUSP_AWS_AMI_CANARY_ROLE_ARN must be a role in the clean account');
    return override;
  }
  const name = env.PAPERCUSP_AWS_AMI_CANARY_ROLE_NAME?.trim() || DEFAULT_CANARY_ROLE_NAME;
  if (!/^[\w+=,.@-]+$/.test(name)) fail(`PAPERCUSP_AWS_AMI_CANARY_ROLE_NAME is malformed: ${name}`);
  return `arn:${partitionFor(region)}:iam::${accountId}:role/${name}`;
}

export function instanceTypeFor(architecture, env = {}) {
  const override = env.PAPERCUSP_AWS_AMI_CANARY_INSTANCE_TYPE?.trim();
  if (override) return override;
  if (architecture === 'x86_64') return 't3.medium';
  if (architecture === 'arm64') return 't4g.medium';
  fail(`no default canary instance type for AMI architecture ${String(architecture)}`);
}

export function canaryTags(input, runId) {
  return [
    { Key: 'Name', Value: `pc-ami-canary-${runId}` },
    { Key: CANARY_RUN_TAG, Value: runId },
    { Key: CANARY_FIXTURE_TAG, Value: input.fixture.fixtureId.slice(0, 255) },
  ];
}

export function canaryDataVolumeTags(input, runId) {
  return canaryTags(input, runId).map((tag) =>
    tag.Key === 'Name' ? { ...tag, Value: `pc-ami-canary-data-${runId}` } : tag,
  );
}

/**
 * The canary uses the same gzip/checksum/durable-mount/systemd-run renderer as production. The
 * detached unit reports terminal status on the EC2 console; its journal carries the attestation
 * and failure diagnostics because Run Command returns after the unit starts.
 */
export function ssmScriptPlan(fixture, volumeId) {
  const push = renderAwsHostBootstrapPushCore({
    volumeId,
    hostBootstrapScript: fixture.bootstrapScript,
    statusMarker: WORKSPACE_HOST_BOOTSTRAP_STATUS_CONSOLE_MARKER,
  });
  const unit = `${AWS_HOST_BOOTSTRAP_UNIT}.service`;
  return {
    run: push.commands,
    readAttestation: [
      `journalctl --unit='${unit}' --no-pager --output=cat 2>/dev/null | grep '^${ATTESTATION_PREFIX}' | tail -n 1`,
    ],
    serviceCheck: [`systemctl is-active '${fixture.serviceName}'`],
    readDiagnostics: [
      'set +e',
      "echo '--- bootstrap systemd journal ---'",
      `journalctl --unit='${unit}' --no-pager --output=cat 2>&1 | tail -c ${DIAGNOSTICS_MAX_CHARS}`,
      'exit 0',
    ],
  };
}

/**
 * Read the service's own failure output off the instance BEFORE teardown. The bootstrap run
 * returns only a bounded tail of its log, and the systemctl status + journal that explain WHY
 * the service would not start are printed EARLIER than that tail (the native-addon inventory and
 * load probe come after them). Once the instance is terminated they are gone. Measured on P-012
 * chain5 (2026-10-05): the clean-room report carried only the addon inventory and "workspace
 * service failed to start", never the cause. Never throws: an unreadable diagnostic is reported
 * as such and never replaces the bootstrap failure it accompanies.
 */
async function readBootstrapDiagnostics(deps, instanceId, commands, budgets) {
  try {
    const result = await runSsm(deps, instanceId, commands, budgets.shortCommandMs, budgets.pollMs, 'bootstrap diagnostics', budgets.ssmDeliveryMs);
    const text = String(result.stdout ?? '').slice(-(DIAGNOSTICS_MAX_CHARS + 2_000));
    return result.status === 'Success' ? text : `diagnostics read ended ${result.status}: ${text}`;
  } catch (error) {
    return `diagnostics unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Reduce a raw EC2 console capture to what explains a boot that never reached SSM: the bounded
 * tail, plus the filesystem and initrd lines that name the failure, in console order. `fatal` is
 * true only when a line from BOOT_FATAL_PATTERNS is present, and a healthy boot never prints one.
 */
export function summarizeBootConsole(raw) {
  const text = String(raw ?? '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '');
  const failureLines = [];
  let fatal = false;
  for (const line of text.split('\n')) {
    const isFatal = BOOT_FATAL_PATTERNS.some((re) => re.test(line));
    if (!isFatal && !BOOT_CAUSE_PATTERN.test(line)) continue;
    fatal ||= isFatal;
    const trimmed = line.trim().slice(0, BOOT_FAILURE_LINE_MAX_CHARS);
    if (failureLines.length < BOOT_FAILURE_LINES_MAX && !failureLines.includes(trimmed)) failureLines.push(trimmed);
  }
  // `failureLines` LAST: callers keep the TAIL of the serialized failure payload.
  return { fatal, tail: text.slice(-BOOT_CONSOLE_MAX_CHARS), failureLines };
}

/** Read the boot console. Never throws: an unreadable console is reported, never fatal. */
async function readBootConsole(deps, instanceId) {
  try {
    const raw = await deps.consoleOutput(instanceId);
    if (!raw) return { fatal: false, note: 'console output empty', tail: '', failureLines: [] };
    return summarizeBootConsole(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { fatal: false, note: `console unreadable: ${message}`, tail: '', failureLines: [] };
  }
}

/** Read the bootstrap's terminal report from the EC2 serial console without confusing old output. */
async function readBootstrapStatus(deps, instanceId) {
  try {
    const raw = await deps.consoleOutput(instanceId);
    const text = String(raw ?? '');
    return {
      status: parseEc2ConsoleBootstrapStatus(text),
      tail: text.slice(-BOOT_CONSOLE_MAX_CHARS),
      ...(!text ? { note: 'console output empty' } : {}),
    };
  } catch (error) {
    return {
      status: null,
      tail: '',
      note: `console unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Decode the attestation marker; a missing or undecodable marker is a hard failure. */
export function extractAttestation(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/);
  let encoded;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].startsWith(ATTESTATION_PREFIX)) {
      encoded = lines[index].slice(ATTESTATION_PREFIX.length).trim();
      break;
    }
  }
  if (!encoded) fail('bootstrap produced no attestation marker; the AMI did not self-attest');
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch (error) {
    fail(`bootstrap attestation was not base64 JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('bootstrap attestation is not an object');
  return parsed;
}

async function waitFor(deps, budgetMs, pollMs, label, probe, done) {
  const deadline = deps.now() + budgetMs;
  for (;;) {
    const value = await probe();
    if (done(value)) return value;
    if (deps.now() >= deadline) fail(`${label} did not happen within ${Math.round(budgetMs / 1000)}s`, { last: value ?? null });
    await deps.sleep(pollMs);
  }
}

async function runSsm(deps, instanceId, commands, budgetMs, pollMs, label, deliveryMs = CANARY_BUDGETS.ssmDeliveryMs) {
  const commandId = await deps.sendCommand({ instanceId, commands, executionTimeoutSec: Math.ceil(budgetMs / 1000) });
  let result;
  try {
    result = await waitFor(
      deps,
      deliveryMs + budgetMs + 2 * pollMs,
      pollMs,
      `SSM ${label}`,
      () => deps.getInvocation({ commandId, instanceId }),
      (invocation) => Boolean(invocation && SSM_TERMINAL.has(invocation.status)),
    );
  } catch (error) {
    // Preserve the exact delivery identity before the finally-block deletes the instance.
    if (error instanceof ToolError) {
      error.details = { ...(error.details ?? {}), commandId, phase: label, deliveryBudgetMs: deliveryMs, executionBudgetMs: budgetMs };
    }
    throw error;
  }
  return { commandId, ...result };
}

/** Delete the disposable EBS data disk after the instance has stopped using it. */
async function deleteCanaryDataVolume(deps, volumeId, instanceId, instanceTerminated, budgets) {
  let volume = await deps.describeVolume(volumeId);
  if (volume?.state === 'deleted') return true;
  if (!volume) throw new Error(`canary data volume ${volumeId} state was not observed before cleanup`);
  if (volume.state === 'deleting') {
    const deleted = await waitFor(
      deps,
      budgets.volumeDeleteMs,
      budgets.pollMs,
      'canary data volume deleted',
      () => deps.describeVolume(volumeId),
      (current) => current?.state === 'deleted',
    );
    return deleted.state === 'deleted';
  }
  if (volume.state === 'error') fail(`canary data volume ${volumeId} entered error state`);

  if (volume.state === 'in-use' || ['attaching', 'attached', 'detaching'].includes(volume.attachmentState)) {
    if (volume.attachmentState !== 'detaching') {
      if (!instanceTerminated) {
        throw new Error(`canary data volume ${volumeId} remains attached while instance termination is unconfirmed`);
      }
      if (volume.attachedInstanceId && volume.attachedInstanceId !== instanceId) {
        throw new Error(`canary data volume ${volumeId} is attached to unexpected instance ${volume.attachedInstanceId}`);
      }
      await deps.detachVolume(volumeId);
    }
    volume = await waitFor(
      deps,
      budgets.volumeDetachMs,
      budgets.pollMs,
      'canary data volume detached',
      () => deps.describeVolume(volumeId),
      (current) => {
        if (current?.state === 'error') fail(`canary data volume ${volumeId} entered error state while detaching`);
        return current?.state === 'available' || current?.state === 'deleted';
      },
    );
    if (volume.state === 'deleted') return true;
  }

  if (volume.state !== 'available') {
    volume = await waitFor(
      deps,
      budgets.volumeAvailableMs,
      budgets.pollMs,
      'canary data volume available for deletion',
      () => deps.describeVolume(volumeId),
      (current) => {
        if (current?.state === 'error') fail(`canary data volume ${volumeId} entered error state`);
        return current?.state === 'available' || current?.state === 'deleted';
      },
    );
    if (volume.state === 'deleted') return true;
  }

  await deps.deleteVolume(volumeId);
  const deleted = await waitFor(
    deps,
    budgets.volumeDeleteMs,
    budgets.pollMs,
    'canary data volume deleted',
    () => deps.describeVolume(volumeId),
    (current) => current?.state === 'deleted',
  );
  return deleted.state === 'deleted';
}

function requireSsmSuccess(result, label) {
  if (result.status !== 'Success') {
    fail(`SSM ${label} ended ${result.status}`, {
      commandId: result.commandId,
      responseCode: result.responseCode ?? null,
      stdoutTail: String(result.stdout ?? '').slice(-2000),
      stderrTail: String(result.stderr ?? '').slice(-2000),
    });
  }
  return result;
}

/**
 * Launch the shared AMI privately in the clean account, prove SSM + bootstrap + service, then
 * tear down and census. `deps` (all async unless noted):
 *   callerAccount() → account id of the assumed clean-account identity
 *   describeImage(imageId) → { state, architecture, rootDeviceName?, rootEncrypted? } | null
 *   describeSubnet(subnetId) → { subnetId, vpcId } | null
 *   runInstance({ imageId, subnetId, instanceProfileArn, instanceType, tags, rootDeviceName?, volumeInitializationRateMiBps?, encryptRootVolume? }) → instanceId
 *   consoleOutput(instanceId) → latest serial console text | null
 *   describeInstance(instanceId) → { state, publicIpv4, stateReason } (state 'pending' while unknown)
 *   ssmPingStatus(instanceId) → 'Online' | 'ConnectionLost' | 'Inactive' | null
 *   sendCommand({ instanceId, commands, executionTimeoutSec }) → commandId
 *   getInvocation({ commandId, instanceId }) → { status, stdout, stderr, responseCode } | null
 *   terminate(instanceId)
 *   censusByRunTag(runId) → string[] of non-terminal resources still carrying the run tag
 *   now() → epoch ms (sync); sleep(ms); runId() → short hex (sync)
 */
export async function runAwsAmiCleanAccountCanary(input, deps, env = {}, budgets = CANARY_BUDGETS) {
  const runId = deps.runId();
  const account = await deps.callerAccount();
  if (account !== input.accountId) {
    fail(`assumed identity is in account ${account}, not the clean account ${input.accountId}`);
  }
  const image = await deps.describeImage(input.imageId);
  if (!image) fail(`AMI ${input.imageId} is not visible to the clean account (share missing?)`);
  if (image.state !== 'available') fail(`AMI ${input.imageId} is ${image.state}, not available`);
  const subnet = await deps.describeSubnet(input.subnetId);
  if (!subnet) fail(`subnet ${input.subnetId} is not in the clean account/region`);
  if (!subnet.availabilityZone) fail(`subnet ${input.subnetId} has no availability zone`);
  const instanceType = instanceTypeFor(image.architecture, env);

  const observed = {
    instanceId: null,
    dataVolumeId: null,
    dataVolumeAttached: false,
    dataVolumeDeleted: false,
    publicIpv4Assigned: false,
    ssmOnline: false,
    bootstrapStatus: null,
    attestation: null,
    serviceHealthy: false,
    terminated: false,
    residualResourceIds: [],
    teardownErrors: [],
  };
  let failure = null;
  let bootstrapDiagnostics = null;
  let bootstrapWaitFailed = false;
  let bootConsole = null;
  let plan = null;
  try {
    observed.dataVolumeId = await deps.createDataVolume({
      availabilityZone: subnet.availabilityZone,
      sizeGiB: CANARY_DATA_VOLUME_GIB,
      volumeType: CANARY_DATA_VOLUME_TYPE,
      encrypted: true,
      tags: canaryDataVolumeTags(input, runId),
    });
    await waitFor(
      deps,
      budgets.volumeAvailableMs,
      budgets.pollMs,
      'canary data volume available',
      () => deps.describeVolume(observed.dataVolumeId),
      (volume) => {
        if (volume?.state === 'error') fail(`canary data volume ${observed.dataVolumeId} entered error state`);
        return volume?.state === 'available';
      },
    );
    observed.instanceId = await deps.runInstance({
      imageId: input.imageId,
      subnetId: input.subnetId,
      instanceProfileArn: input.instanceProfileArn,
      instanceType,
      tags: canaryTags(input, runId),
      ...(image.rootDeviceName
        ? {
            rootDeviceName: image.rootDeviceName,
            volumeInitializationRateMiBps: ROOT_VOLUME_INITIALIZATION_RATE_MIBPS,
            // Every launch of a released AMI reads an ENCRYPTED root, and an encrypted volume reads
            // an absent snapshot block as noise rather than zeros. The clean room's transient AMI is
            // unencrypted, so encrypt its root at launch, or it boots a read path no customer gets
            // (WI-10006518: the clean room passed an image every encrypted launch of it failed).
            ...(image.rootEncrypted === false ? { encryptRootVolume: true } : {}),
          }
        : {}),
    });
    const instanceId = observed.instanceId;
    const running = await waitFor(deps, budgets.runningMs, budgets.pollMs, 'instance running', () => deps.describeInstance(instanceId), (i) => {
      if (i && (i.state === 'shutting-down' || i.state === 'terminated' || i.state === 'stopped')) {
        fail(`canary instance ${instanceId} went ${i.state} before running`, { stateReason: i.stateReason ?? null });
      }
      return i?.state === 'running';
    });
    observed.publicIpv4Assigned = Boolean(running.publicIpv4);
    if (observed.publicIpv4Assigned) fail(`canary instance ${instanceId} was assigned public IPv4 ${running.publicIpv4}`);
    await deps.attachVolume({ instanceId, volumeId: observed.dataVolumeId, deviceName: CANARY_DATA_VOLUME_DEVICE });
    await waitFor(
      deps,
      budgets.volumeAttachedMs,
      budgets.pollMs,
      'canary data volume attached',
      () => deps.describeVolume(observed.dataVolumeId),
      (volume) => {
        if (volume?.state === 'error') fail(`canary data volume ${observed.dataVolumeId} entered error state while attaching`);
        if (volume?.attachedInstanceId && volume.attachedInstanceId !== instanceId) {
          fail(`canary data volume ${observed.dataVolumeId} attached to unexpected instance ${volume.attachedInstanceId}`);
        }
        return volume?.state === 'in-use' && volume.attachmentState === 'attached' && volume.attachedInstanceId === instanceId;
      },
    );
    observed.dataVolumeAttached = true;
    let pingPolls = 0;
    await waitFor(
      deps,
      budgets.ssmOnlineMs,
      budgets.pollMs,
      'SSM agent Online',
      async () => {
        const status = await deps.ssmPingStatus(instanceId);
        pingPolls += 1;
        // A guest stuck in emergency mode never reaches SSM. Read its console so a failed boot
        // ends the wait within about a minute and names its cause (WI-10006518).
        if (status !== 'Online' && pingPolls % BOOT_CONSOLE_POLL_EVERY === 0) {
          const read = await readBootConsole(deps, instanceId);
          if (read.fatal) {
            bootConsole = read;
            fail(`canary instance ${instanceId} failed to boot: ${read.failureLines.join(' | ')}`);
          }
        }
        return status;
      },
      (s) => s === 'Online',
    );
    observed.ssmOnline = true;

    plan = ssmScriptPlan(input.fixture, observed.dataVolumeId);
    let bootstrapPush;
    try {
      bootstrapPush = await runSsm(
        deps,
        instanceId,
        plan.run,
        budgets.bootstrapPushMs,
        budgets.pollMs,
        'bootstrap push',
        budgets.ssmDeliveryMs,
      );
    } catch (error) {
      // The Run Command only delivers the detached unit. Preserve unit journal evidence if its
      // delivery invocation itself never becomes terminal.
      bootstrapWaitFailed = true;
      throw error;
    }
    if (bootstrapPush.status !== 'Success') {
      bootstrapDiagnostics = await readBootstrapDiagnostics(deps, instanceId, plan.readDiagnostics, budgets);
    }
    requireSsmSuccess(bootstrapPush, 'bootstrap push');
    let terminal;
    try {
      terminal = await waitFor(
        deps,
        budgets.bootstrapMs,
        budgets.pollMs,
        'EC2 bootstrap terminal status',
        () => readBootstrapStatus(deps, instanceId),
        (read) => read.status?.state === 'succeeded' || read.status?.state === 'failed',
      );
    } catch (error) {
      bootstrapWaitFailed = true;
      throw error;
    }
    observed.bootstrapStatus = terminal.status;
    if (terminal.status.state === 'failed') {
      bootstrapDiagnostics = await readBootstrapDiagnostics(deps, instanceId, plan.readDiagnostics, budgets);
      fail(`EC2 bootstrap failed in ${terminal.status.phase ?? 'unknown phase'}: ${terminal.status.error ?? 'no error reported'}`, {
        bootstrapStatus: terminal.status,
        bootstrapConsoleTail: terminal.tail,
      });
    }
    const marker = requireSsmSuccess(await runSsm(deps, instanceId, plan.readAttestation, budgets.shortCommandMs, budgets.pollMs, 'attestation read', budgets.ssmDeliveryMs), 'attestation read');
    observed.attestation = extractAttestation(marker.stdout);
    const service = await runSsm(deps, instanceId, plan.serviceCheck, budgets.shortCommandMs, budgets.pollMs, 'service check', budgets.ssmDeliveryMs);
    observed.serviceHealthy = service.status === 'Success' && String(service.stdout ?? '').trim() === 'active';
  } catch (error) {
    failure = error;
    if (bootstrapWaitFailed && observed.instanceId && bootstrapDiagnostics === null && plan) {
      bootstrapDiagnostics = await readBootstrapDiagnostics(deps, observed.instanceId, plan.readDiagnostics, budgets);
    }
    // Never reached SSM: the boot console is the only evidence left, and teardown destroys it.
    if (observed.instanceId && !observed.ssmOnline && bootConsole === null) {
      bootConsole = await readBootConsole(deps, observed.instanceId);
    }
  } finally {
    if (observed.instanceId) {
      const instanceId = observed.instanceId;
      try {
        await deps.terminate(instanceId);
        const final = await waitFor(deps, budgets.terminateMs, budgets.pollMs, 'instance terminated', () => deps.describeInstance(instanceId), (i) => i?.state === 'terminated');
        observed.terminated = final.state === 'terminated';
      } catch (error) {
        observed.teardownErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (observed.dataVolumeId) {
      try {
        observed.dataVolumeDeleted = await deleteCanaryDataVolume(
          deps,
          observed.dataVolumeId,
          observed.instanceId,
          observed.terminated,
          budgets,
        );
        if (!observed.dataVolumeDeleted) observed.teardownErrors.push(`canary data volume ${observed.dataVolumeId} was not confirmed deleted`);
      } catch (error) {
        observed.teardownErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    try {
      const leftover = await deps.censusByRunTag(runId);
      observed.residualResourceIds = [...new Set([
        ...(observed.instanceId && !observed.terminated ? [observed.instanceId] : []),
        ...(observed.dataVolumeId && !observed.dataVolumeDeleted ? [observed.dataVolumeId] : []),
        ...leftover,
      ])].sort();
    } catch (error) {
      observed.teardownErrors.push(`residue census failed: ${error instanceof Error ? error.message : String(error)}`);
      // An unmeasured census can never read as zero residue.
      observed.residualResourceIds = [`census-unmeasured:${runId}`];
    }
  }
  if (failure) {
    const details = {
      ...(failure instanceof ToolError && failure.details ? failure.details : {}),
      runId,
      instanceId: observed.instanceId,
      terminated: observed.terminated,
      residualResourceIds: observed.residualResourceIds,
      teardownErrors: observed.teardownErrors,
      // LAST on purpose: callers keep the TAIL of this serialized payload, so the cause of a
      // failed service start must sit at the end to survive that cut.
      ...(bootstrapDiagnostics !== null ? { bootstrapDiagnostics } : {}),
      // Set only when SSM never came Online, so it never competes with bootstrapDiagnostics.
      ...(bootConsole !== null ? { bootConsole } : {}),
    };
    let message = failure instanceof Error ? failure.message : String(failure);
    if (bootConsole?.failureLines.length && !message.includes('failed to boot')) {
      message = `${message}; boot console: ${bootConsole.failureLines.join(' | ')}`;
    }
    throw new ToolError(message, details);
  }
  return { runId, ...observed };
}

/** The AwsAmiCleanAccountLaunchProof (aws-ami-release.ts), bound to the exact request. */
export function buildAwsAmiCanaryProof(input, observed, observedAt) {
  const evidenceRef = `aws-ami-canary:${observed.instanceId}:${sha256Hex(
    `${input.accountId}|${input.region}|${input.imageId}|${input.buildManifestIdentity}|${input.fixture.fixtureId}|${observedAt}`,
  ).slice(0, 32)}`;
  return {
    evidenceRef,
    accountId: input.accountId,
    region: input.region,
    imageId: input.imageId,
    buildManifestIdentity: input.buildManifestIdentity,
    releaseVersion: input.releaseVersion,
    releaseSha256: input.releaseSha256,
    ssmOnline: observed.ssmOnline,
    bootstrapAttestationHealthy: observed.attestation?.status === 'healthy',
    serviceHealthy: observed.serviceHealthy,
    publicIpv4Assigned: observed.publicIpv4Assigned,
    terminated: observed.terminated,
    dataVolumeId: observed.dataVolumeId,
    dataVolumeDeleted: observed.dataVolumeDeleted,
    residualResourceIds: observed.residualResourceIds,
    observedAt,
    fixtureId: input.fixture.fixtureId,
    attestation: observed.attestation,
  };
}

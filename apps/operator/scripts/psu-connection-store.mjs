/**
 * Saved psu connection profiles: their schema, normalizers, and the 0600 JSON store.
 *
 * Split out of psu-connection-front-controller.mjs (WI-6554700010030748) so that reading the
 * store does not load a subprocess module. The sync-resolver reads it on a user-facing panel
 * path, which must not reach node:child_process (sync-resolver/no-heavy-io-on-read-path.test.ts).
 * Keep this module free of node:child_process and of anything that imports it. The front
 * controller re-exports everything here, so its callers are unchanged.
 */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { papercuspHome } from "@papercusp/host-platform/home";
import {
  AWS_CLI_PROFILE_PATTERN,
  AWS_EC2_INSTANCE_ID_PATTERN,
  AWS_REGION_PATTERN,
} from "../../../packages/operator-core/lib/workspace-host/aws-ssm-ssh-patterns.ts";

export const PSU_CONNECTION_STORE_VERSION = "psu-connection-profiles-v1";
export const DEFAULT_REMOTE_OPERATOR_PORT = 3070;
/** The Papercusp cloud portal a bare `psu --connect-login` signs in to. */
export const DEFAULT_HOSTED_PORTAL_ORIGIN = "https://app.papercusp.com";

const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const GCP_RESOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}[A-Za-z0-9]$/;
const GCP_ZONE_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SSH_USER_RE = /^[A-Za-z_][A-Za-z0-9._-]{0,63}$/;
const HOSTED_TOKEN_RE = /^pct_[A-Za-z0-9_-]{43}$/;
const HOSTED_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function requiredValue(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} has an invalid value`);
  }
  return value;
}

/** Normalize the first supported remote profile. GCP deliberately defaults to IAP. */
export function normalizeGcpIapProfile(input) {
  const name = requiredValue(
    input.name,
    "Connection profile name",
    PROFILE_NAME_RE,
  );
  const projectId = requiredValue(
    input.projectId,
    "GCP project id",
    GCP_RESOURCE_RE,
  );
  const zone = requiredValue(input.zone, "GCP zone", GCP_ZONE_RE);
  const instanceName = requiredValue(
    input.instanceName,
    "GCP instance name",
    GCP_RESOURCE_RE,
  );
  const sshUser = requiredValue(
    input.sshUser,
    "OS Login SSH user",
    SSH_USER_RE,
  );
  const query = new URLSearchParams({
    project: projectId,
    zone,
    instance: instanceName,
  });

  return {
    name,
    kind: "gcp-iap-ssh",
    projectId,
    zone,
    instanceName,
    sshUser,
    endpoint: `gcp-iap-ssh://${instanceName}?${query.toString()}`,
    target: `${sshUser}@${instanceName}`,
    remoteOperatorPort: DEFAULT_REMOTE_OPERATOR_PORT,
    supportedClientPlatforms: ["linux", "macos", "windows"],
    features: {
      command: true,
      pty: true,
      tcpForward: true,
      fileTransfer: true,
    },
    prerequisites: [
      "OpenSSH client",
      "Google Cloud CLI",
      "IAP TCP forwarding permission",
      "OS Login permission",
    ],
    constraints: [
      "No public IP",
      "Interactive control transport; bulk transfer requires an explicit alternate path",
      "SSH host keys are verified by the local OpenSSH configuration",
    ],
    reconnect: "recreate",
    audited: true,
  };
}

/**
 * Your own EC2 instance, reached by OpenSSH over an AWS Systems Manager
 * Session Manager tunnel — the AWS twin of the GCP IAP profile
 * (aws-byoc-gcp-parity-2026-10-01 P-009). Like IAP it needs no public IP and
 * no inbound port: the SSH stream rides an SSM session to port 22.
 */
export function normalizeAwsSsmProfile(input) {
  const name = requiredValue(
    input.name,
    "Connection profile name",
    PROFILE_NAME_RE,
  );
  const region = requiredValue(input.region, "AWS region", AWS_REGION_PATTERN);
  const instanceId = requiredValue(
    input.instanceId,
    "EC2 instance id",
    AWS_EC2_INSTANCE_ID_PATTERN,
  );
  const sshUser = requiredValue(input.sshUser, "SSH user", SSH_USER_RE);
  const awsProfile =
    input.awsProfile == null
      ? null
      : requiredValue(input.awsProfile, "AWS CLI profile", AWS_CLI_PROFILE_PATTERN);
  const query = new URLSearchParams({ region, instance: instanceId });
  if (awsProfile) query.set("profile", awsProfile);

  return {
    name,
    kind: "aws-ssm-ssh",
    region,
    instanceId,
    sshUser,
    ...(awsProfile ? { awsProfile } : {}),
    endpoint: `aws-ssm-ssh://${instanceId}?${query.toString()}`,
    target: `${sshUser}@${instanceId}`,
    remoteOperatorPort: DEFAULT_REMOTE_OPERATOR_PORT,
    supportedClientPlatforms: ["linux", "macos", "windows"],
    features: {
      command: true,
      pty: true,
      tcpForward: true,
      fileTransfer: true,
    },
    prerequisites: [
      "OpenSSH client",
      "AWS CLI v2",
      "AWS Session Manager plugin",
      "ssm:StartSession on the instance with the AWS-StartSSHSession document",
      "Your SSH public key authorized for the SSH user on the instance",
    ],
    constraints: [
      "No public IP or inbound SSH port: SSH rides an SSM Session Manager tunnel",
      "Interactive control transport; bulk transfer requires an explicit alternate path",
      "SSH host keys are verified by the local OpenSSH configuration",
    ],
    reconnect: "recreate",
    audited: true,
  };
}

/**
 * A Papercusp cloud portal origin. https only, except a loopback test server;
 * credentials in the URL are refused so a token can never be sent to a
 * look-alike host spelled inside the userinfo part.
 */
export function normalizeHostedPortalOrigin(value) {
  let url;
  try {
    url = new URL(value ?? DEFAULT_HOSTED_PORTAL_ORIGIN);
  } catch {
    throw new Error(
      `The Papercusp portal must be a URL like ${DEFAULT_HOSTED_PORTAL_ORIGIN}`,
    );
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      "The Papercusp portal must use https:// (http:// is accepted only for a loopback test server)",
    );
  }
  if (url.username || url.password)
    throw new Error("The Papercusp portal URL must not carry credentials");
  return url.origin;
}

/** A customer-owned machine reached through their private network or OpenSSH config. */
export function normalizeSshProfile(input) {
  const name = requiredValue(input.name, "Connection profile name", PROFILE_NAME_RE);
  const host = requiredValue(input.host, "SSH host or config alias", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$/);
  const sshUser = input.sshUser == null ? null : requiredValue(input.sshUser, "SSH user", SSH_USER_RE);
  return {
    name, kind: "ssh", host, sshUser,
    endpoint: `ssh://${sshUser ? `${sshUser}@` : ""}${host}`,
    target: sshUser ? `${sshUser}@${host}` : host,
    remoteOperatorPort: DEFAULT_REMOTE_OPERATOR_PORT,
    supportedClientPlatforms: ["linux", "macos", "windows"],
    features: { command: true, pty: true, tcpForward: true, fileTransfer: true },
    prerequisites: ["OpenSSH client", "A reachable private/VPN address or SSH config alias", "Your SSH key authorized on the remote machine", "Papercusp and tmux installed on the remote machine"],
    constraints: ["SSH host keys and identity follow your OpenSSH configuration", "The GUI is forwarded only to 127.0.0.1; keep this command open while using it", "Removing a saved profile forgets it locally; revoke the SSH key on the remote machine to remove access"],
    reconnect: "recreate", audited: true,
  };
}

export function hostedProfileName(origin) {
  return requiredValue(
    new URL(origin).host.replace(/[^A-Za-z0-9._-]/g, "-"),
    "Connection profile name",
    PROFILE_NAME_RE,
  );
}

/**
 * A name for a new cloud sign-in that no saved profile uses. The first sign-in
 * at a portal is named for its host (so existing `--connect=<host>` keeps
 * working); another account or organization at the same portal gets the host
 * plus its organization's name, then the user id if that is still taken.
 */
export function freeHostedProfileName(origin, identity, profiles) {
  const taken = new Set(profiles.map((profile) => profile.name));
  const host = hostedProfileName(origin);
  const fit = (value) =>
    value.slice(0, 64).replace(/[^A-Za-z0-9]+$/, "") || host.slice(0, 64);
  const slug = (value) =>
    String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24);
  const org = slug(identity.organizationName) || slug(identity.organizationId).slice(0, 8);
  const candidates = [
    host,
    fit(`${host}-${org}`),
    fit(`${host}-${org}-${slug(identity.userId).slice(0, 8)}`),
  ];
  for (const candidate of candidates) if (!taken.has(candidate)) return candidate;
  for (let n = 2; ; n += 1) {
    const candidate = fit(`${host}-${org}`.slice(0, 60)) + `-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Same portal, organization and user: the one sign-in a re-login may replace. */
export function sameHostedIdentity(profile, { origin, organizationId, userId }) {
  return (
    profile.kind === "papercusp-hosted" &&
    profile.origin === origin &&
    profile.organizationId === organizationId &&
    profile.userId === userId
  );
}

export function hostedOrganizationName(value) {
  if (typeof value !== "string") return null;
  // A display label only; control characters could rewrite the terminal.
  const name = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120);
  return name || null;
}

/**
 * A Papercusp cloud sign-in (WI-10002874, byoc D-412). One profile per portal
 * + organization + user (WI-10003910), so several accounts or organizations
 * can be signed in side by side; each reaches every hosted workspace that
 * person's organization role allows, through the workspace machine's own
 * outbound connector — the machine accepts no inbound connection, so there is
 * no SSH or IAP leg to configure.
 */
export function normalizeHostedProfile(input) {
  const origin = normalizeHostedPortalOrigin(input.origin);
  const name = requiredValue(
    input.name ?? hostedProfileName(origin),
    "Connection profile name",
    PROFILE_NAME_RE,
  );
  const expiresAt = new Date(input.expiresAt);
  if (Number.isNaN(expiresAt.getTime()))
    throw new Error("Papercusp CLI token expiry has an invalid value");
  const organizationName = hostedOrganizationName(input.organizationName);
  return {
    name,
    kind: "papercusp-hosted",
    origin,
    ...(organizationName ? { organizationName } : {}),
    accessToken: requiredValue(
      input.accessToken,
      "Papercusp CLI token",
      HOSTED_TOKEN_RE,
    ),
    tokenId: requiredValue(input.tokenId, "Papercusp CLI token id", HOSTED_ID_RE),
    organizationId: requiredValue(
      input.organizationId,
      "Papercusp organization id",
      HOSTED_ID_RE,
    ),
    userId: requiredValue(input.userId, "Papercusp user id", HOSTED_ID_RE),
    expiresAt: expiresAt.toISOString(),
    supportedClientPlatforms: ["linux", "macos", "windows"],
    features: {
      command: true,
      pty: true,
      tcpForward: false,
      fileTransfer: false,
    },
    prerequisites: ["A Papercusp cloud sign-in (psu --connect-login)"],
    constraints: [
      "Terminal only: no port forwarding or bulk file transfer",
      "Your organization role decides which workspaces you can open",
    ],
    reconnect: "resume",
    audited: true,
  };
}

function validateStoredProfile(value) {
  if (value?.kind === "gcp-iap-ssh") return normalizeGcpIapProfile(value);
  if (value?.kind === "aws-ssm-ssh") return normalizeAwsSsmProfile(value);
  if (value?.kind === "ssh") return normalizeSshProfile(value);
  if (value?.kind === "papercusp-hosted") return normalizeHostedProfile(value);
  throw new Error(
    `Unsupported saved psu connection kind '${value?.kind ?? "missing"}'`,
  );
}

/** @param {string} [home] */
export function defaultPsuConnectionStorePath(home) {
  // A private runtime home must also isolate saved machine credentials. An
  // explicit home remains the caller's override (tests and profile migration).
  const root = home === undefined ? papercuspHome() : papercuspHome({}, home);
  return join(root, "psu-connections.json");
}

export function loadPsuConnectionStore(path = defaultPsuConnectionStorePath()) {
  if (!existsSync(path))
    return { version: PSU_CONNECTION_STORE_VERSION, profiles: [] };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error(`psu connection store must be a regular file: ${path}`);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error(`psu connection store permissions must be 0600: ${path}`);
  }
  if (stat.size > 1024 * 1024)
    throw new Error("psu connection store exceeds the 1 MiB safety limit");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot parse psu connection store ${path}: ${error?.message ?? error}`,
    );
  }
  if (
    parsed?.version !== PSU_CONNECTION_STORE_VERSION ||
    !Array.isArray(parsed.profiles)
  ) {
    throw new Error(`Unsupported psu connection store version in ${path}`);
  }
  const profiles = parsed.profiles.map(validateStoredProfile);
  if (
    new Set(profiles.map((profile) => profile.name)).size !== profiles.length
  ) {
    throw new Error(`Duplicate profile names in psu connection store ${path}`);
  }
  return { version: PSU_CONNECTION_STORE_VERSION, profiles };
}

export function savePsuConnectionStore(
  store,
  path = defaultPsuConnectionStorePath(),
) {
  const profiles = store.profiles.map(validateStoredProfile);
  if (
    new Set(profiles.map((profile) => profile.name)).size !== profiles.length
  ) {
    throw new Error("Cannot save duplicate psu connection profile names");
  }
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temp,
      `${JSON.stringify({ version: PSU_CONNECTION_STORE_VERSION, profiles }, null, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
    renameSync(temp, path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } finally {
    rmSync(temp, { force: true });
  }
}

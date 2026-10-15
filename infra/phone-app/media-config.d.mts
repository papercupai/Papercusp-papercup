import type { X509Certificate } from 'node:crypto';

type MediaEnvironment = Record<string, string | undefined>;
type TlsReceipt = { hostname: string; address: string; validTo: string };

export const NON_PUBLIC_V4_SUBNETS: ReadonlyArray<readonly [string, number]>;
export function isPublicAddress(address: string): boolean;
export function publicHostname(hostname: string | undefined): string;
export function publicMediaUrl(value: unknown): URL;
export function validateCertificate(
  certPem: string | Buffer, keyPem: string | Buffer, hostname: string, now?: number,
): X509Certificate;
export function mediaConfig(env: MediaEnvironment, hosted?: boolean): {
  turnYaml: string; publicUrl?: string; turnDomain?: string; turnPort?: number;
};
export function publicAddresses(
  hostname: string,
  resolve?: (hostname: string, options: { all: true; verbatim: true }) =>
    Promise<Array<{ address: string; family?: number }>>,
): Promise<string[]>;
export function checkTlsEndpoint(params: {
  hostname: string; address: string; port?: number; timeoutMs?: number; ca?: string | Buffer;
}): Promise<TlsReceipt>;
export function remotePreflight(env: MediaEnvironment): Promise<{
  checks: TlsReceipt[]; audioVerified: false; next: string;
}>;
export function loadTestReceipt(output: string): {
  subscriber: string; track: string; receivedPackets: number; bitrate: string;
  scope: 'single-publisher-to-subscriber';
  publicAudioVerified: false; bidirectionalAudioVerified: false;
};
export function localProbeHealthUrl(value: string): string;
export function localPhoneReadiness(env: MediaEnvironment, probes?: {
  unitState?: (unit: string) => Promise<boolean>;
  httpReady?: (url: string) => Promise<boolean>;
  /** Status of an unauthenticated worker-ingest probe; 401 is the only ready answer. */
  httpStatus?: (url: string) => Promise<number>;
}): Promise<{
  ok: boolean; checks: Array<{ component: string; ready: boolean }>;
  alerts: Array<{ component: string; owner: 'phone-operations'; action: string }>;
  scope: 'local-process-and-http-only';
  publicPhoneVerified: false; turnCertificateVerified: boolean;
  bidirectionalAudioVerified: false; recoveryVerified: false; costPolicyVerified: false;
}>;

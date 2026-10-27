/** Portable declarations shared by standalone cleaners and operator-core. */
export interface RetentionLease {
  file: string; tag: string; version: string | null; expiresNs: bigint; paths: string[];
}
export type LeaseParse = { ok: true; lease: RetentionLease } | { ok: false; file: string; reason: string };
export interface RetentionPin {
  id: string; owner: string; reason: string; createdAt: string; expiresAt: string; paths: string[];
}
export interface RetentionPinProtection { paths: readonly string[]; expiresAt: string }
export interface RetentionPinPredicate {
  (path: string): boolean;
  /** Exact descendant-only allocation coverage from the same validated pin snapshot. */
  readonly coversPath: (path: string) => boolean;
}
export interface PinReadOptions { dir?: string; nowMs?: number; includeExpired?: boolean }
export const RETENTION_SCHEMA: 'papercusp-release-retention/v1';
export function defaultRetentionDir(env?: NodeJS.ProcessEnv): string;
export function versionFromTag(tag: string): string | null;
export function parseRetentionLease(file: string, text: string): LeaseParse;
export function isLeaseLive(lease: RetentionLease, nowMs: number): boolean;
export function readRetentionLeases(dir: string): { leases: RetentionLease[]; errors: string[] };
export function readRetentionPins(options?: PinReadOptions): { pins: RetentionPin[]; errors: string[] };
export function readRetentionPinsAsync(options?: PinReadOptions): Promise<{ pins: RetentionPin[]; errors: string[] }>;
export function retentionPinProtectsPath(path: string, pins: readonly RetentionPinProtection[], nowMs?: number): boolean;
export function pinProtection(pins: readonly RetentionPinProtection[], nowMs?: number, resolvePath?: (path: string) => string): RetentionPinPredicate;
export function withRetentionPinProtection<T>(work: (isPinned: RetentionPinPredicate) => T | Promise<T>, options?: PinReadOptions & { resolvePath?: (path: string) => string; onWaiting?: (info: { owner: string; elapsedMs: number }) => void }): Promise<T>;

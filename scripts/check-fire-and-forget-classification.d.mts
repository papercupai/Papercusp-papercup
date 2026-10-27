export interface NotifySite {
  id: string; path: string; line: number; context: string; expression: string;
  roots: string[]; mode: string;
  declaration?: Omit<NotifyClassification, 'id' | 'path'>;
}
export interface NotifyCensus {
  schemaVersion: number; files: { path: string; sha256: string }[];
  sites: NotifySite[]; gaps: { path: string; kind: string; message?: string }[];
}
export interface NotifyClassification {
  id: string; path: string; classification: string; reason: string;
  durablePath?: string; mandatory?: boolean;
}
export function inScope(path: string): boolean;
export function censusSources(sources: Record<string, string>): NotifyCensus;
export function validateClassifications(census: NotifyCensus, records: NotifyClassification[], seedIds?: string[]): string[];
export function scanRepository(cwd?: string): NotifyCensus & { coverage: unknown; sourceDigest: string };
export const BASELINE_SEED_SHA256: string;
export function inlineClassifications(census: NotifyCensus): NotifyClassification[];
export function validateSeed(registry: { seedIds: string[]; records: NotifyClassification[] }, expectedHash?: string): string[];
export function seedClassifications(census: NotifyCensus & { sourceDigest: string; coverage?: unknown }): {
  schemaVersion: number; policy: string; seedSourceDigest: string; seedCensusDigest: string;
  seedFiles: NotifyCensus['files']; seedCoverage: unknown; seedIds: string[];
  records: (NotifyClassification & { deliveryState: string })[];
};

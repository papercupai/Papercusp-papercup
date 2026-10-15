// Types for write-hook-source-provenance.mjs (WI-6554700010010534). Keep in sync with the
// SourceProvenanceManifest shape in packages/operator-core/lib/desktop-install/install-provenance.ts.

export declare const SOURCE_PROVENANCE_BASENAME: '.source-provenance.json';

export type HookSourceCommit = { sha: string; committedAt: string };

export type HookSourceProvenanceManifest = {
  schemaVersion: 1;
  directory?: HookSourceCommit;
  files: Record<string, HookSourceCommit>;
};

export declare function lastCommitTouching(srcDir: string, rel: string): HookSourceCommit | null;

export declare function buildSourceProvenanceManifest(srcDir: string, dstDir: string): HookSourceProvenanceManifest;

export declare function writeSourceProvenanceManifest(srcDir: string, dstDir: string): HookSourceProvenanceManifest;

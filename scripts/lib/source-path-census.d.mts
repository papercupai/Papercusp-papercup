export type SourceSite = {
    path: string; start: number; end: number; byteStart: number; byteEnd: number;
    line: number; column: number; kind: string; typeOnly: boolean; expression: string;
    specifier: string | null; source: string; enclosingFunctions: string[];
    predicates: Array<{ condition: string; side: boolean; start: number; end: number }>;
    initialization: boolean; fingerprint: string;
    binding: { imported: string; specifiers: string[] } | null;
    calleeCoverage: string | null; node: import('typescript').Node;
};
export type SourceUnit = { path: string; sha256: string; ast: import('typescript').SourceFile;
    sites: SourceSite[]; span: (node: import('typescript').Node) => Record<string, number> };
export function censusSites(path: string, text: string): SourceUnit;
export function changedSites(before: SourceUnit, after: SourceUnit): {
    addedOrChanged: SourceSite[]; removedOrChanged: SourceSite[] };
export function selectSourcePath(unit: SourceUnit, options: { functionName: string; containerName?: string; branchValues?: Record<string, boolean> }): {
    selected: SourceSite[]; excluded: Array<{ site: SourceSite; reason: string; proof: unknown }> };
export function boundedFrontier(edges: Array<{ path?: string; [key: string]: unknown }>, options?: {
    baseline?: string[]; priorAdditions?: string[]; bound?: number }): {
    status: string; bound: number; additions: string[]; frontier: Array<Record<string, unknown>>;
    complete: false; refusedEdge?: Record<string, unknown>; pending?: Array<Record<string, unknown>> };
export function siteEvidence(site: SourceSite): Omit<SourceSite, 'node'> & { sourceSha256: string; sourceTruncated: boolean };
export type PreparationSnapshot = {
    version: number; configHash: string; startedAtMs: number; lastAtMs: number;
    additions: string[]; bytesRead: number; reads: Array<{ path: string; offset: number; bytes: number }>;
    digests: Record<string, string>; pending: { path: string; bytes: number } | null;
    status: string; reason: string | null; byteAccounting: string; checksum: string;
};
export function createPreparationLedger(options: {
    attemptId: string; candidate: string; clockId: string; baseline?: string[]; priorAdditions?: string[];
    bound?: number; maxInputs?: number; maxBytes?: number; maxInputBytes?: number; maxElapsedMs?: number;
    sourceBinding?: { root: string; inputsSha256: string };
}, runtime?: { now?: () => number; snapshot?: PreparationSnapshot; persist?: (snapshot: PreparationSnapshot) => Promise<void> }): {
    snapshot(): PreparationSnapshot;
    report(): PreparationSnapshot & { receipt: false; fullClosureQualified: false; executionAdmitted: false };
    read(path: string, io: {
        stat(): Promise<{ size: number; identity: string; canonicalPath: string }>;
        readChunk(options: { offset: number; length: number }): Promise<Uint8Array>;
        expectedSha256?: string;
        candidate?: string;
        close?(): Promise<void>;
    }): Promise<{ path: string; sha256: string; data: Buffer; receipt: false; fullClosureQualified: false }>;
};
export function openPreparationLedger(options: Parameters<typeof createPreparationLedger>[0], runtime: {
    now?: () => number;
    store: {
        load(attemptId: string): Promise<{ revision: number; snapshot: PreparationSnapshot } | null>;
        compareAndSwap(attemptId: string, expectedRevision: number | null, snapshot: PreparationSnapshot):
            Promise<{ ok: boolean; revision: number }>;
    };
}): Promise<ReturnType<typeof createPreparationLedger>>;
export function createArtifactPreparationStore(binding: {
    slug: string; relPath: string;
    loadTextArtifact(slug: string, relPath: string): Promise<string | null>;
    compareAndSwapTextArtifact(slug: string, relPath: string, expected: string | null, content: string): Promise<boolean>;
}): Parameters<typeof openPreparationLedger>[1]['store'];
export function openBoundPreparationLedger(options: Parameters<typeof createPreparationLedger>[0], runtime: {
    store: Parameters<typeof openPreparationLedger>[1]['store']; root: string;
    manifest: { candidate: string; inputs: Record<string, string> }; now?: () => number;
}): Promise<{
    snapshot(): PreparationSnapshot;
    report(): ReturnType<ReturnType<typeof createPreparationLedger>['report']>;
    read(path: string): ReturnType<ReturnType<typeof createPreparationLedger>['read']>;
}>;
export function verifyPreparationCitation(unit: SourceUnit, binding: {
    candidate: string; expectedCandidate: string; sourceSha256: string;
    start: number; end: number; expression: string; functionName: string;
}): boolean;
export function preparationDisposition(binding: {
    candidate: string; expectedCandidate: string; targetCandidates: string[]; unresolved?: string[];
    actualArtifactSha256?: string; expectedArtifactSha256?: string; custodyVerified?: boolean; sourceCurrent?: boolean;
}): { status: string; targetCandidates: string[]; residue: string[]; receipt: false;
    fullClosureQualified: false; currentGuardPassed: false; executionAdmitted: false };

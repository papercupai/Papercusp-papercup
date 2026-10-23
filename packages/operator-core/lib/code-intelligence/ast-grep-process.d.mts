export const AST_GREP_VENDOR_DIR: string;
export function resolveAstGrepBin(): string | null;
export function assertIsAstGrep(output: string): { ok: true; version: string } | { ok: false; reason: string };
export interface AstGrepIdentity { bin: string; version: string }
export function astGrepIdentity(): Promise<{ ok: true; identity: AstGrepIdentity } | { ok: false; reason: string }>;

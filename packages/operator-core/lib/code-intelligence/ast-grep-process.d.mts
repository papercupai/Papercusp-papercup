export const AST_GREP_VENDOR_DIR: string;
export interface AstGrepResolveOptions {
  env?: Readonly<Record<string, string | undefined>>;
  fallbackHome?: string;
}
export function resolveAstGrepBin(options?: AstGrepResolveOptions): string | null;
export function assertIsAstGrep(output: string): { ok: true; version: string } | { ok: false; reason: string };
export interface AstGrepIdentity { bin: string; version: string }
export function astGrepIdentity(): Promise<{ ok: true; identity: AstGrepIdentity } | { ok: false; reason: string }>;

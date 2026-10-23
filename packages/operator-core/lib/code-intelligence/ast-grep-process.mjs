/** Lightweight process/identity seam shared with the structural facade and native worker. */
import { papercuspPath } from '@papercusp/host-platform/home';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
export const AST_GREP_VENDOR_DIR = papercuspPath('vendor', 'ast-grep');
export function resolveAstGrepBin() {
  const bin = join(AST_GREP_VENDOR_DIR, 'node_modules', '.bin', 'ast-grep');
  return existsSync(bin) ? bin : null;
}
export function assertIsAstGrep(output) {
  const match = /^ast-grep\s+(\d+\.\d+\.\d+)/.exec(output.trim());
  return match ? { ok: true, version: match[1] } : { ok: false,
    reason: `the resolved binary does not identify as ast-grep (it printed ${JSON.stringify(output.trim().slice(0, 80))}). On Linux \`sg\` is shadow-utils' substitute-group command, which exits 0 for --version.` };
}
export async function astGrepIdentity() {
  const bin = resolveAstGrepBin();
  if (!bin) return { ok: false, reason: `pinned ast-grep is not provisioned. Expected it under ${AST_GREP_VENDOR_DIR}. Provision it (P-014) rather than falling back to a PATH lookup — on Linux that resolves shadow-utils' \`sg\`, not ast-grep.` };
  try {
    const { stdout } = await promisify(execFile)(bin, ['--version'], { timeout: 10_000 });
    const verdict = assertIsAstGrep(stdout);
    return verdict.ok ? { ok: true, identity: { bin, version: verdict.version } } : verdict;
  } catch (error) { return { ok: false, reason: String(error) }; }
}

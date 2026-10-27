/** Lightweight process/identity seam shared with the structural facade and native worker. */
import { papercuspHome, papercuspPath } from '@papercusp/host-platform/home';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
export const AST_GREP_VENDOR_DIR = papercuspPath('vendor', 'ast-grep');
// A workspace-scoped PAPERCUSP_HOME can hide the canonical host installation.
// The host path is an explicit, pinned tool asset root: it is never a PATH
// lookup, and ast-grep receives only the facade's read-only argv.
function candidateVendorDirs(env, fallbackHome) {
  const homes = [papercuspHome(env, fallbackHome), papercuspHome({}, fallbackHome)];
  return [...new Set(homes)].map((home) => join(home, 'vendor', 'ast-grep'));
}
export function resolveAstGrepBin({ env = process.env, fallbackHome = homedir() } = {}) {
  for (const vendorDir of candidateVendorDirs(env, fallbackHome)) {
    const bin = join(vendorDir, 'node_modules', '.bin', 'ast-grep');
    if (existsSync(bin)) return bin;
  }
  return null;
}
export function assertIsAstGrep(output) {
  const match = /^ast-grep\s+(\d+\.\d+\.\d+)/.exec(output.trim());
  return match ? { ok: true, version: match[1] } : { ok: false,
    reason: `the resolved binary does not identify as ast-grep (it printed ${JSON.stringify(output.trim().slice(0, 80))}). On Linux \`sg\` is shadow-utils' substitute-group command, which exits 0 for --version.` };
}
export async function astGrepIdentity() {
  const bin = resolveAstGrepBin();
  if (!bin) {
    const expected = candidateVendorDirs(process.env, homedir());
    return { ok: false, reason: `pinned ast-grep is not provisioned. Expected it under ${expected.join(' or ')}. Provision it (P-014) rather than falling back to a PATH lookup — on Linux that resolves shadow-utils' \`sg\`, not ast-grep.` };
  }
  try {
    const { stdout } = await promisify(execFile)(bin, ['--version'], { timeout: 10_000 });
    const verdict = assertIsAstGrep(stdout);
    return verdict.ok ? { ok: true, identity: { bin, version: verdict.version } } : verdict;
  } catch (error) { return { ok: false, reason: String(error) }; }
}

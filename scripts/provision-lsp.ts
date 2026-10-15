/** Install maintained Python/Go servers or the separate local-taint analyzer.
 * Existing LSP pilots were provisioned manually; this command makes the new pins
 * reproducible without changing the TypeScript install or rustup toolchain.
 * Run: node_modules/.bin/tsx scripts/provision-lsp.ts python go semgrep
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GOPLS_VERSION, LSP_VENDOR_DIR, PYRIGHT_VERSION } from '../packages/operator-core/lib/code-intelligence/lsp-adapter.ts';
import { provisionSemgrepRuntime } from '../packages/operator-core/lib/code-intelligence/semgrep-taint-facade.ts';

async function main() {
  for (const language of process.argv.slice(2)) {
    if (language === 'python') {
      const dir = join(LSP_VENDOR_DIR, 'pyright', PYRIGHT_VERSION);
      mkdirSync(dir, { recursive: true });
      execFileSync('npm', ['install', '--prefix', dir, '--save-exact', `pyright@${PYRIGHT_VERSION}`], { stdio: 'inherit' });
    } else if (language === 'go') {
      const goDir = join(homedir(), '.papercusp', 'vendor', 'go', 'go', 'bin');
      const go = existsSync(join(goDir, 'go')) ? join(goDir, 'go') : 'go';
      const bin = join(LSP_VENDOR_DIR, 'gopls', GOPLS_VERSION, 'bin');
      mkdirSync(bin, { recursive: true });
      execFileSync(go, ['install', `golang.org/x/tools/gopls@${GOPLS_VERSION}`], {
        stdio: 'inherit', env: { ...process.env, GOBIN: bin, GOTOOLCHAIN: 'local' },
      });
      execFileSync(join(bin, 'gopls'), ['version'], { stdio: 'inherit' });
    } else if (language === 'semgrep') {
      console.log(JSON.stringify(await provisionSemgrepRuntime()));
    } else {
      throw new Error(`Unsupported provisioning target ${JSON.stringify(language)}; choose python, go or semgrep`);
    }
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });

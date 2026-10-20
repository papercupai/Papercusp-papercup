/** Shared platform installer commands for standalone psu and desktop onboarding. */
import { arch as osArch } from "node:os";

const CODEX_PACKAGE = '@openai/codex';

// oh-my-pi (binary `omp`) has NO live npm package (`oh-my-pi` was unpublished
// 2026-05-21; `@oh-my-pi/cli` never existed — a dead ref there 404s). It ships
// as a prebuilt binary on github.com/can1357/oh-my-pi releases (the SAME asset
// the desktop sidecar bundles), so we install it by downloading that binary
// directly into a PATH+detected location — no Homebrew/npm needed, uniform on
// every OS. ⚠ KEEP OMP_VERSION in sync with the sidecar bundle pin in
// papercusp-desktop/bin/build-desktop-sidecar.sh (OMP_VERSION).
const OMP_VERSION = 'v14.5.14';
const OMP_RELEASE_BASE = `https://github.com/can1357/oh-my-pi/releases/download/${OMP_VERSION}`;

/**
 * The oh-my-pi release asset filename for an OS+arch, or null when upstream ships
 * no build for it. Upstream publishes omp-{darwin,linux}-{x64,arm64} and a single
 * omp-windows-x64.exe. `os` is `process.platform`, `arch` is `os.arch()`. Pure.
 * @param {string} os
 * @param {string} arch
 * @returns {string | null}
 */
export function ompReleaseAsset(os, arch) {
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  if (os === 'darwin') return `omp-darwin-${a}`;
  if (os === 'linux') return `omp-linux-${a}`;
  if (os === 'win32') return 'omp-windows-x64.exe'; // upstream ships x64 only on Windows
  return null;
}

/**
 * Full download URL for the current host's omp asset (null when unsupported). Pure.
 * @param {string} os
 * @param {string} arch
 * @returns {string | null}
 */
export function ompDownloadUrl(os, arch) {
  const asset = ompReleaseAsset(os, arch);
  return asset ? `${OMP_RELEASE_BASE}/${asset}` : null;
}

/** @typedef {{ command: string, args: string[], cwd: string, env: Record<string, string> }} SpawnSpec */

/**
 * Build the install spawn spec for a given OS. Pure — `os` is the value
 * of `process.platform` and `home` is the user's home dir.
 * @param {string} os
 * @param {string} home
 * @returns {SpawnSpec}
 */
export function buildInstallSpec(os, home) {
  if (os === 'win32') {
    const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Write-Host '==> installing Claude Code'
Invoke-WebRequest -UseBasicParsing -Uri https://claude.ai/install.ps1 | Select-Object -ExpandProperty Content | Invoke-Expression
Write-Host '==> bootstrapping runtime'
$runtime = Join-Path $env:USERPROFILE '.papercusp\\runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
@'
{ "name":"papercusp-runtime","version":"0.0.0","private":true,
  "dependencies":{"${CODEX_PACKAGE}":"latest"} }
'@ | Set-Content -Path (Join-Path $runtime 'package.json') -Encoding UTF8
Write-Host '==> installing codex'
npm install --prefix $runtime --no-audit --no-fund
Write-Host '==> done'
`;
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      cwd: home,
      env: {},
    };
  }
  const script = `set -e
echo '==> installing Claude Code'
curl -fsSL https://claude.ai/install.sh | bash
echo '==> bootstrapping runtime'
mkdir -p ~/.papercusp/runtime
cat > ~/.papercusp/runtime/package.json <<JSON
{
  "name": "papercusp-runtime",
  "version": "0.0.0",
  "private": true,
  "dependencies": {
    "${CODEX_PACKAGE}": "latest"
  }
}
JSON
echo '==> installing codex'
npm install --prefix ~/.papercusp/runtime --no-audit --no-fund
echo '==> done'
`;
  return { command: 'bash', args: ['-c', script], cwd: home, env: {} };
}

/**
 * PER-FRAMEWORK install spec (agent-first-onboarding-2026-07-03 P-001) — the
 * onboarding concierge installs ONLY the framework the user picked, unlike the
 * wizard's all-in-one `buildInstallSpec` (kept above for the GUI wizard).
 *
 * Composability: the codex install goes into the SAME `~/.papercusp/runtime`
 * prefix the wizard uses (and detection probes), via incremental
 * `npm install --prefix` — installing one framework never removes another.
 * @param {"claude" | "codex" | "omp"} framework
 * @param {string} os
 * @param {string} home
 * @param {string} [arch]
 * @returns {SpawnSpec}
 */
export function buildFrameworkInstallSpec(framework, os, home, arch = osArch()) {
  const ompUrl = ompDownloadUrl(os, arch);
  if (os === 'win32') {
    const scripts = {
      claude: `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Write-Host '==> installing Claude Code'
Invoke-WebRequest -UseBasicParsing -Uri https://claude.ai/install.ps1 | Select-Object -ExpandProperty Content | Invoke-Expression
Write-Host '==> done'
`,
      codex: `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$runtime = Join-Path $env:USERPROFILE '.papercusp\\runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
if (-not (Test-Path (Join-Path $runtime 'package.json'))) {
  Push-Location $runtime; npm init -y | Out-Null; Pop-Location
}
Write-Host '==> installing codex'
npm install --prefix $runtime --no-audit --no-fund ${CODEX_PACKAGE}@latest
Write-Host '==> done'
`,
      // omp: download the prebuilt binary into %USERPROFILE%\.papercusp\bin and
      // add that dir to the PERSISTENT user PATH (non-destructively) so a future
      // shell resolves a bare `omp`. detectOmp also probes this path directly so
      // the wizard sees it as installed without a shell restart.
      omp: ompUrl
        ? `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Write-Host '==> installing oh-my-pi (omp)'
$dir = Join-Path $env:USERPROFILE '.papercusp\\bin'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$dst = Join-Path $dir 'omp.exe'
Invoke-WebRequest -UseBasicParsing -Uri '${ompUrl}' -OutFile $dst
$userPath = [Environment]::GetEnvironmentVariable('Path','User')
if (-not (($userPath -split ';') -contains $dir)) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $dir), 'User')
  Write-Host '==> added omp to your user PATH (restart your terminal to pick it up)'
}
Write-Host "==> installed omp -> $dst"
Write-Host '==> done'
`
        : `Write-Host 'No oh-my-pi build is published for this platform; see https://github.com/can1357/oh-my-pi'`,
    };
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', scripts[framework]],
      cwd: home,
      env: {},
    };
  }

  const runtimeBootstrap = `mkdir -p ~/.papercusp/runtime
[ -f ~/.papercusp/runtime/package.json ] || (cd ~/.papercusp/runtime && npm init -y >/dev/null)`;
  const scripts = {
    claude: `set -e
echo '==> installing Claude Code'
curl -fsSL https://claude.ai/install.sh | bash
echo '==> done'
`,
    codex: `set -e -o pipefail
echo '==> installing codex'
if command -v npm >/dev/null 2>&1; then
  ${runtimeBootstrap}
  npm install --prefix ~/.papercusp/runtime --no-audit --no-fund ${CODEX_PACKAGE}@latest
else
  # The standalone PUI/PSU release ships Node without requiring system npm.
  # Official installer: https://learn.chatgpt.com/docs/codex/cli
  curl -fsSL https://chatgpt.com/codex/install.sh | sh
fi
echo '==> done'
`,
    // omp: download the prebuilt binary into ~/.local/bin (where the official
    // claude installer also lands, and which detectOmp probes) + chmod +x. If it
    // isn't on PATH, print an actionable hint rather than silently failing later.
    omp: ompUrl
      ? `set -e
echo '==> installing oh-my-pi (omp)'
mkdir -p ~/.local/bin
curl -fsSL '${ompUrl}' -o ~/.local/bin/omp
chmod +x ~/.local/bin/omp
echo '==> installed omp -> ~/.local/bin/omp'
if ! command -v omp >/dev/null 2>&1; then
  echo 'NOTE: ~/.local/bin is not on your PATH — add this to your shell profile so \`omp\` is found: export PATH="$HOME/.local/bin:$PATH"'
fi
echo '==> done'
`
      : `echo 'No oh-my-pi build is published for this platform; see https://github.com/can1357/oh-my-pi'`,
  };
  return { command: 'bash', args: ['-c', scripts[framework]], cwd: home, env: {} };
}


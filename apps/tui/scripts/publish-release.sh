#!/usr/bin/env bash
# Publish one ACCEPTED PUI archive to the existing Papercusp release host.
#
# This is deliberately separate from papercusp-desktop/bin/upload-release.sh:
# the desktop uploader consumes a desktop artifact manifest and writes the
# desktop updater's root latest.json. PUI has neither contract. It publishes
# under <release-host>/pui/ and owns only pui/latest.json + pui/index.html.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: apps/tui/scripts/publish-release.sh --archive <pui-*.tar.gz> [options]

  --acceptance <f>  exact archive acceptance report (default: <archive>.acceptance.json)
  --sums <f>        published digest file (default: SHA256SUMS beside archive)
  --work <dir>      keep generated publication files in this directory
  --previous <f>   previous latest.json (offline preview only; live publication reads R2)

Environment:
  DRY_RUN=1                  validate + render, upload nothing
  PUI_RELEASE_HOST_ENV       release-host env (default ~/.papercusp/release-host.env)
  PUI_R2_ENV                 R2 credential env (default ~/.papercusp/r2.env)
  PUI_PORTAL_LINKS_ENV       durable Portal build env written after publish
  PUI_SKIP_PORTAL_CONFIG=1   do not update the Portal build env
EOF
}

die() { echo "pui-publish: ERROR: $*" >&2; exit 1; }

ARCHIVE=""
ACCEPTANCE=""
SUMS=""
WORK=""
KEEP_WORK=0
PREVIOUS=""
while (($#)); do
  case "$1" in
    --archive) ARCHIVE="${2:?--archive needs a value}"; shift 2 ;;
    --archive=*) ARCHIVE="${1#*=}"; shift ;;
    --acceptance) ACCEPTANCE="${2:?--acceptance needs a value}"; shift 2 ;;
    --acceptance=*) ACCEPTANCE="${1#*=}"; shift ;;
    --sums) SUMS="${2:?--sums needs a value}"; shift 2 ;;
    --sums=*) SUMS="${1#*=}"; shift ;;
    --work) WORK="${2:?--work needs a value}"; KEEP_WORK=1; shift 2 ;;
    --work=*) WORK="${1#*=}"; KEEP_WORK=1; shift ;;
    --previous) PREVIOUS="${2:?--previous needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

[[ -n "$ARCHIVE" ]] || { usage >&2; exit 2; }
for tool in node tar sha256sum; do command -v "$tool" >/dev/null || die "missing required tool: $tool"; done
ARCHIVE="$(realpath "$ARCHIVE")"
[[ -f "$ARCHIVE" ]] || die "archive not found: $ARCHIVE"
ACCEPTANCE="$(realpath "${ACCEPTANCE:-$ARCHIVE.acceptance.json}")"
SUMS="$(realpath "${SUMS:-$(dirname "$ARCHIVE")/SHA256SUMS}")"
[[ -f "$ACCEPTANCE" ]] || die "acceptance report not found: $ACCEPTANCE"
[[ -f "$SUMS" ]] || die "SHA256SUMS not found: $SUMS"

NAME="$(basename "$ARCHIVE")"
if [[ "$NAME" =~ ^pui-(.+)-(linux-x86_64|macos-aarch64|macos-x86_64)\.tar\.gz$ ]]; then
  VERSION="${BASH_REMATCH[1]}"
  TARGET="${BASH_REMATCH[2]}"
else
  die "archive name must be pui-<version>-<supported-target>.tar.gz: $NAME"
fi
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]] || die "invalid release version"

if [[ -z "$WORK" ]]; then
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/pui-publish.XXXXXX")"
fi
mkdir -p "$WORK"
cleanup() { ((KEEP_WORK)) || rm -rf -- "$WORK"; }
trap cleanup EXIT

DIGEST="$(sha256sum "$ARCHIVE" | cut -d' ' -f1)"
LISTED_DIGEST="$(awk -v name="$NAME" '$2 == name { print $1 }' "$SUMS")"
[[ "$LISTED_DIGEST" == "$DIGEST" ]] || die "archive digest does not match SHA256SUMS"

ROOT_ENTRY="$(tar -tzf "$ARCHIVE" | awk 'NR == 1 { sub(/\/$/, ""); first=$0 } END { print first }')"
[[ "$ROOT_ENTRY" == "pui-$VERSION-$TARGET" ]] || die "archive root '$ROOT_ENTRY' does not match its filename"
tar -xOf "$ARCHIVE" "$ROOT_ENTRY/PROVENANCE.json" > "$WORK/PROVENANCE.json" \
  || die "archive has no readable PROVENANCE.json"

PUI_ACCEPTANCE="$ACCEPTANCE" PUI_PROVENANCE="$WORK/PROVENANCE.json" \
PUI_DIGEST="$DIGEST" PUI_VERSION="$VERSION" PUI_TARGET="$TARGET" PUI_WORK="$WORK" PUI_NAME="$NAME" \
node <<'NODE' > "$WORK/validated.json"
const fs = require('node:fs');
const fail = (message) => { console.error(`pui-publish: ERROR: ${message}`); process.exit(1); };
const acceptance = JSON.parse(fs.readFileSync(process.env.PUI_ACCEPTANCE, 'utf8'));
const provenance = JSON.parse(fs.readFileSync(process.env.PUI_PROVENANCE, 'utf8'));
if (acceptance.ok !== true) fail('acceptance report is not green');
if (!Array.isArray(acceptance.refusals) || acceptance.refusals.length) fail('acceptance report lacks an empty refusal list');
if (!/^[a-f0-9]{40}$/.test(provenance.source?.commit ?? '')) fail('invalid source commit');
if (acceptance.candidate?.archiveSha256 !== process.env.PUI_DIGEST) fail('acceptance report belongs to different archive bytes');
if (acceptance.candidate?.sourceSha !== provenance.source?.commit) fail('acceptance source does not match archive provenance');
if (provenance.version !== process.env.PUI_VERSION || provenance.target !== process.env.PUI_TARGET) {
  fail('archive provenance does not match filename version/target');
}
const stock = acceptance.runner?.stockMachines;
if (process.env.PUI_TARGET.startsWith('linux-') && (!Array.isArray(stock)
  || !['ubuntu:24.04', 'debian:stable-slim'].every((image) => stock.some((row) => row.image === image && row.status === 0))
  || stock.some((row) => row.status !== 0))) {
  fail('Linux publication needs passing Ubuntu and Debian stock-machine smoke');
}
if (acceptance.runner?.cloudDeviceStart?.ok !== true) fail('public cloud device-start guard did not pass');
const legs = acceptance.runner?.legs;
const advertise = acceptance.candidate?.advertise;
const targetPlatforms = {
  'linux-x86_64': ['Linux x86_64', 'WSL2'],
  'macos-aarch64': ['macOS Apple Silicon', 'macOS arm64'],
  'macos-x86_64': ['macOS Intel', 'macOS x86_64'],
}[process.env.PUI_TARGET];
if (!Array.isArray(advertise) || advertise.length === 0
  || advertise.some((row) => !targetPlatforms.includes(row.platform)
    || !['Claude', 'Codex', 'OMP'].includes(row.backend))) fail('advertised platform/backend scope is absent or invalid');
if (process.env.PUI_TARGET.startsWith('macos-') && !targetPlatforms.includes(acceptance.runner?.platform)) {
  fail('macOS publication needs installed acceptance on the matching macOS host');
}
if (!Array.isArray(legs) || !legs.some((row) => row.engine === 'scripted' && row.status === 0)
  || !advertise.every((cell) => legs.some((row) => row.engine === cell.backend.toLowerCase() && row.status === 0))
  || legs.some((row) => row.status !== 0)) {
  fail('installed-product acceptance legs are absent or red');
}
const suite = acceptance.runner?.suiteProvenance;
if (!Array.isArray(suite) || suite.length === 0
  || suite.some((row) => !/^[a-f0-9]{40}$/.test(row.candidateBlob ?? '') || row.candidateBlob !== row.runBlob)) {
  fail('acceptance suite provenance is absent or mismatched');
}
// The local report includes paths, terminal output and account metadata. Publish
// only the structured verdict fields needed to identify and assess these bytes.
const publicReport = {
  schemaVersion: 1, kind: 'public-acceptance-summary', ok: true, refusals: [],
  candidate: { sourceSha: provenance.source.commit, artifact: provenance.target,
    archiveSha256: process.env.PUI_DIGEST, advertise },
  runner: {
    stockMachines: (stock ?? []).filter((row) => ['ubuntu:24.04', 'debian:stable-slim'].includes(row.image))
      .map((row) => ({ image: row.image, status: row.status })),
    cloudDeviceStart: { ok: true },
    legs: legs.filter((row) => ['scripted', 'claude', 'codex', 'omp'].includes(row.engine))
      .map((row) => ({ engine: row.engine, status: row.status })),
  },
};
fs.writeFileSync(`${process.env.PUI_WORK}/${process.env.PUI_NAME}.acceptance.json`, JSON.stringify(publicReport, null, 2) + '\n');
fs.writeFileSync(`${process.env.PUI_WORK}/SHA256SUMS`, `${process.env.PUI_DIGEST}  ${process.env.PUI_NAME}\n`);
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  version: provenance.version,
  target: provenance.target,
  sourceSha: provenance.source.commit,
  archiveSha256: process.env.PUI_DIGEST,
}) + '\n');
NODE
ACCEPTANCE="$WORK/$NAME.acceptance.json"
SUMS="$WORK/SHA256SUMS"
# Each target needs its own immutable checksum object: a shared version-level
# SHA256SUMS cannot change when the next platform for that version is published.
SUMS_NAME="$NAME.sha256"
cp "$SUMS" "$WORK/$SUMS_NAME"
SUMS="$WORK/$SUMS_NAME"

RELEASE_HOST_ENV="${PUI_RELEASE_HOST_ENV:-$HOME/.papercusp/release-host.env}"
[[ -f "$RELEASE_HOST_ENV" ]] || die "$RELEASE_HOST_ENV not found — no release host configured"
set -a; . "$RELEASE_HOST_ENV"; set +a
BASE="${PAPERCUSP_UPDATE_BASE_URL:-${PAPERCUSP_RELEASE_HOST:-}}"
[[ -n "$BASE" ]] || die "release-host env has neither PAPERCUSP_UPDATE_BASE_URL nor PAPERCUSP_RELEASE_HOST"
BASE="${BASE%/}"
PUI_BASE_CHECK="$BASE" node <<'NODE'
const base = new URL(process.env.PUI_BASE_CHECK);
if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
  || !/^\/[A-Za-z0-9._~/-]+$/.test(base.pathname)) throw new Error('invalid release-host URL');
NODE
KEY_PREFIX="$(printf '%s' "$BASE" | sed -E 's#^https?://[^/]+/?##; s#/$##')"
[[ -n "$KEY_PREFIX" ]] || die "release host must include its permanent path prefix"
PUI_BASE="$BASE/pui"
# A committed package generation can retain its semantic version. Bind its
# immutable objects to the accepted archive bytes as well, so moving latest
# never requires replacing an earlier generation at the same version.
VERSION_BASE="$PUI_BASE/$VERSION/$DIGEST"

if [[ "${DRY_RUN:-0}" != "1" ]]; then
  [[ -z "$PREVIOUS" ]] || die "--previous is only for offline DRY_RUN previews"
  command -v aws >/dev/null || die "missing required tool: aws"
  R2_ENV="${PUI_R2_ENV:-$HOME/.papercusp/r2.env}"
  [[ -f "$R2_ENV" ]] || die "$R2_ENV not found — R2 credentials are not configured"
  set -a; . "$R2_ENV"; set +a
  : "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID in $R2_ENV}"
  : "${R2_BUCKET:?set R2_BUCKET in $R2_ENV}"
  : "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID in $R2_ENV}"
  : "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY in $R2_ENV}"
  ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  export AWS_REQUEST_CHECKSUM_CALCULATION="${AWS_REQUEST_CHECKSUM_CALCULATION:-when_required}"
  export AWS_RESPONSE_CHECKSUM_VALIDATION="${AWS_RESPONSE_CHECKSUM_VALIDATION:-when_required}"
  if aws s3api get-object --endpoint-url "$ENDPOINT" --bucket "$R2_BUCKET" \
    --key "$KEY_PREFIX/pui/latest.json" "$WORK/previous.json" \
    >"$WORK/previous-output.log" 2>"$WORK/previous-error.log"; then
    PREVIOUS="$WORK/previous.json"
  elif ! rg -q '\(404\)|\(NoSuchKey\)|\(NotFound\)' "$WORK/previous-error.log"; then
    die "previous platform releases could not be read; refusing to erase them"
  fi
fi

PUI_META="$WORK/validated.json" PUI_BASE="$PUI_BASE" PUI_VERSION_BASE="$VERSION_BASE" \
PUI_ARCHIVE_NAME="$NAME" PUI_ACCEPTANCE_NAME="$(basename "$ACCEPTANCE")" PUI_SUMS_NAME="$SUMS_NAME" PUI_PREVIOUS="$PREVIOUS" \
node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const work = path.dirname(process.env.PUI_META);
const meta = JSON.parse(fs.readFileSync(process.env.PUI_META, 'utf8'));
const archiveUrl = `${process.env.PUI_VERSION_BASE}/${process.env.PUI_ARCHIVE_NAME}`;
const acceptanceUrl = `${process.env.PUI_VERSION_BASE}/${process.env.PUI_ACCEPTANCE_NAME}`;
const sumsUrl = `${process.env.PUI_VERSION_BASE}/${process.env.PUI_SUMS_NAME}`;
const current = { ...meta, archiveUrl, acceptanceUrl, sumsUrl, unsigned: true };
const targets = ['linux-x86_64', 'macos-aarch64', 'macos-x86_64'];
let artifacts = {};
if (process.env.PUI_PREVIOUS) {
  const previous = JSON.parse(fs.readFileSync(process.env.PUI_PREVIOUS, 'utf8'));
  artifacts = previous.artifacts ?? { [previous.target]: previous };
  for (const [target, release] of Object.entries(artifacts)) {
    if (!targets.includes(target) || release.target !== target
      || !/^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$/.test(release.version)
      || !/^[a-f0-9]{40}$/.test(release.sourceSha ?? '')
      || !/^[a-f0-9]{64}$/.test(release.archiveSha256 ?? '')) throw new Error('invalid previous platform release');
    const versionBase = `${process.env.PUI_BASE}/${release.version}/`;
    const bases = [versionBase, `${versionBase}${release.archiveSha256}/`];
    const name = `pui-${release.version}-${target}.tar.gz`;
    if (!bases.some((base) => release.archiveUrl === `${base}${name}`
      && release.acceptanceUrl === `${base}${name}.acceptance.json`
      && [`${base}SHA256SUMS`, `${base}${name}.sha256`].includes(release.sumsUrl))) {
      throw new Error('previous platform release URL does not match this release host');
    }
  }
}
artifacts[meta.target] = current;
// Keep the original top-level fields for existing latest.json consumers.
const latest = { ...current, artifacts };
fs.writeFileSync(path.join(work, 'latest.json'), JSON.stringify(latest, null, 2) + '\n');
const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const download = (release, label) => release
  ? `<p><a href="${esc(release.archiveUrl)}">Download ${esc(label)} — PUI ${esc(release.version)} + psu</a></p>
<p>SHA-256: <code>${esc(release.archiveSha256)}</code></p>
<p><a href="${esc(release.sumsUrl)}">SHA-256 checksum file</a> · <a href="${esc(release.acceptanceUrl)}">acceptance report</a></p>`
  : `<p>${esc(label)} download is awaiting release verification.</p>`;
fs.writeFileSync(path.join(work, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Download PUI + psu for Linux, macOS and Windows</title><meta name="robots" content="noindex"><style>
body{font:16px/1.55 system-ui,sans-serif;max-width:48rem;margin:4rem auto;padding:0 1.25rem;color:#e8eef8;background:#07101d}a{color:#72c7ff}code{overflow-wrap:anywhere}.card{padding:1.25rem;margin:1rem 0;border:1px solid #29415f;border-radius:.75rem;background:#0d1a2a}h2{margin-top:0}
</style></head><body><main><h1>Download PUI + psu</h1>
<p>Connect to your Papercusp cloud desktop from your console. Launch PSU, select your cloud desktop and connect Claude, Codex, OMP, or the Papercusp TUI to it.</p>
<p><strong>PSU and PUI are already included in Desktop Server.</strong> If you installed Desktop Server, you do not need this separate download. Use this package to connect from another computer or to a cloud desktop without installing the server.</p>
<p><a href="../index.html#download-psu">All Papercusp downloads</a> · <a href="../index.html#download-gui">Download the desktop app</a></p>
<section class="card"><h2>Linux</h2>${download(artifacts['linux-x86_64'], 'Linux x86_64')}</section>
<section class="card"><h2>macOS</h2>${download(artifacts['macos-aarch64'], 'macOS Apple Silicon')}${download(artifacts['macos-x86_64'], 'macOS Intel')}</section>
<section class="card"><h2>Windows</h2><p><strong>Windows uses the same download as Linux, through WSL2.</strong> Install WSL2 with an x86_64 Linux distribution, open its Linux terminal, and install the Linux package there. There is no separate Windows executable.</p>${download(artifacts['linux-x86_64'], 'Windows via WSL2')}</section>
<h2>Install and connect from your console</h2>
<p>Unpack the archive, enter its directory, and run <code>./install.sh</code>. The installer links both <code>pui</code> and <code>psu</code> into <code>~/.local/bin</code>; add that directory to your PATH if needed.</p>
<ol><li>Run <code>psu</code> in your console.</li><li>In <strong>Where should psu run?</strong>, select your cloud desktop. The first time, choose <strong>Papercusp cloud — sign in to use a hosted workspace</strong>, sign in in your browser, then select your desktop.</li><li>Choose Claude, Codex, OMP, or PUI (the Papercusp TUI) in the launcher, then follow its interactive choices to connect.</li></ol>
<p>To use an installed local server, choose <strong>Local — this computer</strong> instead.</p>
<p>These archives are unsigned. Verify the SHA-256 before installing. Cloud connections run agents on your workspace; for local use, install and start Papercusp Server. The desktop GUI is optional.</p></main></body></html>\n`);
NODE

HOSTNAME_ONLY="$(printf '%s' "$BASE" | sed -E 's#^https?://([^/]+).*#\1#')"
echo "==> release host : https://${HOSTNAME_ONLY}/<secret>/pui/"
echo "==> archive      : $NAME"
echo "==> version      : $VERSION"
echo "==> target       : $TARGET"
echo "==> sha256       : $DIGEST"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "DRY_RUN=1 — validation passed; rendered files are in $WORK; nothing uploaded."
  exit 0
fi

for tool in aws curl cmp; do command -v "$tool" >/dev/null || die "missing required tool: $tool"; done

s3() {
  aws s3 --endpoint-url "$ENDPOINT" "$@" >"$WORK/storage-output.log" 2>"$WORK/storage-error.log" \
    || die "storage write failed (details retained in work directory)"
}
remote_sha() {
  local value
  if value="$(aws s3api head-object --endpoint-url "$ENDPOINT" --bucket "$R2_BUCKET" --key "$1" \
    --query 'Metadata.sha256' --output text 2>"$WORK/head-error.log")"; then
    printf '%s\n' "${value:-metadata-missing}"
  elif rg -q '\(404\)|\(NoSuchKey\)|\(NotFound\)' "$WORK/head-error.log"; then
    printf 'absent\n'
  else
    die "remote object lookup failed; absence was not established"
  fi
}
preflight_versioned() {
  local file="$1" key="$2" existing sha
  sha="$(sha256sum "$file" | cut -d' ' -f1)"
  existing="$(remote_sha "$key")"
  [[ "$existing" == absent || "$existing" == "$sha" ]] && return 0
  if [[ "$existing" == None || "$existing" == metadata-missing ]]; then
    aws s3api get-object --endpoint-url "$ENDPOINT" --bucket "$R2_BUCKET" --key "$key" \
      "$WORK/remote-object" >"$WORK/get-output.log" 2>"$WORK/get-error.log" \
      || die "could not verify an existing object without digest metadata"
    cmp -s "$file" "$WORK/remote-object" && return 0
  fi
  die "refusing to replace different bytes at immutable key ${key##*/}"
}
upload_versioned() {
  local file="$1" key="$2" type="$3" sha existing
  sha="$(sha256sum "$file" | cut -d' ' -f1)"
  existing="$(remote_sha "$key")"
  preflight_versioned "$file" "$key"
  if [[ "$existing" == "$sha" ]]; then
    echo "==> already uploaded and content-bound: ${key##*/}"
    return
  fi
  s3 cp "$file" "s3://${R2_BUCKET}/${key}" --only-show-errors --content-type "$type" \
    --cache-control 'public, max-age=31536000, immutable' --metadata "sha256=$sha"
}

VERSION_PREFIX="$KEY_PREFIX/pui/$VERSION/$DIGEST"
preflight_versioned "$ARCHIVE" "$VERSION_PREFIX/$NAME"
preflight_versioned "$ACCEPTANCE" "$VERSION_PREFIX/$(basename "$ACCEPTANCE")"
preflight_versioned "$SUMS" "$VERSION_PREFIX/$SUMS_NAME"
upload_versioned "$ARCHIVE" "$VERSION_PREFIX/$NAME" 'application/gzip'
upload_versioned "$ACCEPTANCE" "$VERSION_PREFIX/$(basename "$ACCEPTANCE")" 'application/json'
upload_versioned "$SUMS" "$VERSION_PREFIX/$SUMS_NAME" 'text/plain; charset=utf-8'
for pair in "$ARCHIVE|$VERSION_PREFIX/$NAME" "$ACCEPTANCE|$VERSION_PREFIX/$(basename "$ACCEPTANCE")" "$SUMS|$VERSION_PREFIX/$SUMS_NAME"; do
  file="${pair%%|*}"; key="${pair#*|}"; expected="$(sha256sum "$file" | cut -d' ' -f1)"
  [[ "$(remote_sha "$key")" == "$expected" ]] || die "R2 metadata did not bind ${key##*/} to its local SHA-256"
done

VERIFY="$WORK/public-verify"
mkdir -p "$VERIFY"
curl_public() {
  curl -A 'curl/8.0' -fsSL --max-time 120 "$1" -o "$2" 2>"$WORK/public-error.log" \
    || die "public read failed (details retained in work directory)"
}
curl_public "$VERSION_BASE/$NAME" "$VERIFY/$NAME"
curl_public "$VERSION_BASE/$(basename "$ACCEPTANCE")" "$VERIFY/$(basename "$ACCEPTANCE")"
curl_public "$VERSION_BASE/$SUMS_NAME" "$VERIFY/$SUMS_NAME"
[[ "$(sha256sum "$VERIFY/$NAME" | cut -d' ' -f1)" == "$DIGEST" ]] || die "public archive bytes do not match"
cmp -s "$ACCEPTANCE" "$VERIFY/$(basename "$ACCEPTANCE")" || die "public acceptance report differs"
cmp -s "$SUMS" "$VERIFY/$SUMS_NAME" || die "public SHA256SUMS differs"
# Advertise only after verifying every versioned file through its public path.
s3 cp "$WORK/latest.json" "s3://${R2_BUCKET}/${KEY_PREFIX}/pui/latest.json" --only-show-errors \
  --content-type 'application/json' --cache-control 'no-cache, max-age=0'
s3 cp "$WORK/index.html" "s3://${R2_BUCKET}/${KEY_PREFIX}/pui/index.html" --only-show-errors \
  --content-type 'text/html; charset=utf-8' --cache-control 'no-cache, max-age=0'
curl_public "$PUI_BASE/latest.json?v=$DIGEST" "$VERIFY/latest.json"
curl_public "$PUI_BASE/index.html?v=$DIGEST" "$VERIFY/index.html"
cmp -s "$WORK/latest.json" "$VERIFY/latest.json" || die "public latest.json differs"
cmp -s "$WORK/index.html" "$VERIFY/index.html" || die "public index.html differs"

if [[ "${PUI_SKIP_PORTAL_CONFIG:-0}" != "1" ]]; then
  PORTAL_LINKS_ENV="${PUI_PORTAL_LINKS_ENV:-$HOME/.config/papercusp/portal-public-links.env}"
  mkdir -p "$(dirname "$PORTAL_LINKS_ENV")"
  PORTAL_LINKS_TMP="$(mktemp "$(dirname "$PORTAL_LINKS_ENV")/.portal-public-links.XXXXXX")"
  umask 077
  printf 'NEXT_PUBLIC_PORTAL_TUI_DOWNLOAD_URL=%s\nNEXT_PUBLIC_PORTAL_DESKTOP_DOWNLOAD_URL=%s\n' \
    "$PUI_BASE/index.html" "$BASE/index.html" > "$PORTAL_LINKS_TMP"
  chmod 0600 "$PORTAL_LINKS_TMP"
  mv -f "$PORTAL_LINKS_TMP" "$PORTAL_LINKS_ENV"
  echo "==> Portal public-link config updated (URLs masked in output)"
fi

echo "✓ PUI $VERSION published and re-downloaded byte-identically"

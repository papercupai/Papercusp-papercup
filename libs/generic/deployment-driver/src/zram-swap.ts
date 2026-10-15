/**
 * Compressed-RAM swap (zram) for hosted workspace hosts (WI-6554700010012418, owner directive
 * #1879: "use zram").
 *
 * Why it exists. The cloud desktops are `e2-standard-4` (16 GB) hosts with NO swap at all, so a
 * memory spike from a burst of agents ends in the OOM killer. The swap-tier measurement
 * (WI-10005475, report rpt_ad53ed14-b22d-4ab6-91f9-da3940e8ad59, run on the same machine shape)
 * found zram the only swap worth having there: a wake from zram took 0.29 s against 0.19 s from
 * RAM, 16 wakes at once took 3.0 s against 39-40 s from `pd-balanced` disk swap, and it costs no
 * disk. It is a CUSHION, not capacity: idle agent terminals pull most of their pages back within
 * a minute, so it turns a spike into a short slowdown instead of a killed process.
 *
 * Mechanism. `systemd-zram-generator` (the maintained generator Fedora ships by default and
 * Ubuntu 24.04 packages) reads one config file at early boot and creates `/dev/zram0` plus its
 * swap unit, so the swap exists on every boot BEFORE the bootstrap re-runs. This module only
 * writes that config, the one sysctl zram wants, and starts the unit once for the boot that
 * installed it. The GCP Ubuntu kernel carries `zram.ko` in its base modules and `zramctl` ships in
 * util-linux (both measured on avi-test, kernel 7.0.0-1011-gcp, 2026-10-14).
 *
 * Settings, each from the measurement or the generator's own guidance:
 * - `zram-size = ram / 2` — the uncompressed capacity; at the 4.4x compression measured on agent
 *   memory it holds at most about a seventh of RAM in compressed pages.
 * - `compression-algorithm = zstd` — what the measurement used.
 * - `swap-priority = 100` — above any disk swap a customer adds, so zram fills first.
 * - `vm.page-cluster = 0` — no swap-in readahead; readahead buys nothing on a RAM device.
 */

export const ZRAM_GENERATOR_APT_PACKAGE = 'systemd-zram-generator';
export const ZRAM_GENERATOR_BIN = '/usr/lib/systemd/system-generators/zram-generator';
export const ZRAM_GENERATOR_CONFIG = '/etc/systemd/zram-generator.conf';
export const ZRAM_SYSCTL_CONFIG = '/etc/sysctl.d/90-papercusp-zram.conf';
export const ZRAM_SWAP_DEVICE = '/dev/zram0';
/** The swap unit the generator creates for {@link ZRAM_SWAP_DEVICE}. */
export const ZRAM_SWAP_UNIT = 'dev-zram0.swap';
/** The status line prefix the bootstrap log carries, one line per run. */
export const ZRAM_SWAP_STATUS_PREFIX = 'PAPERCUSP_ZRAM_SWAP';

/** The generator config body (after the marker line). */
export function zramGeneratorConfigLines(): readonly string[] {
  return [
    '[zram0]',
    'zram-size = ram / 2',
    'compression-algorithm = zstd',
    'swap-priority = 100',
  ];
}

/** The sysctl drop-in body (after the marker line). */
export function zramSysctlLines(): readonly string[] {
  return ['vm.page-cluster = 0'];
}

/** Name of the bash function `zramSwapShellLines` defines. */
export const ZRAM_SWAP_FUNCTION = 'install_zram_swap';

/**
 * Bash lines that define `install_zram_swap <generator_conf> <sysctl_conf> <generator_bin> <proc_swaps>`.
 * The caller decides whether and when to invoke it (after installing the generator package).
 *
 * - A generator config WITHOUT the marker is left alone unless its checksum matches dpkg's
 *   unchanged packaged conffile. Ubuntu installs that default and activates it during apt.
 * - On the first run (no config of ours yet), a zram swap that is already active belongs to some
 *   other tool (zram-tools, a hand setup), and is left alone rather than fought over `/dev/zram0`.
 * - Without the generator binary it changes nothing.
 *
 * It ALWAYS returns 0 and prints exactly one `PAPERCUSP_ZRAM_SWAP status=…` line: zram is a
 * cushion, so a host that cannot have it still boots, and the line says why. It uses `printf`,
 * not a heredoc, so the lines stay valid however a renderer indents or joins them.
 */
export function zramSwapShellLines(marker: string): readonly string[] {
  if (/['\n]/.test(marker)) throw new Error('zram marker must not contain a single quote or newline');
  if (!marker.startsWith('#')) throw new Error('zram marker must be a comment line (start with #)');
  const quoted = (lines: readonly string[]) => lines.map((line) => `'${line}'`).join(' ');
  const status = (fields: string) => `echo "${ZRAM_SWAP_STATUS_PREFIX} ${fields}"`;
  return [
    `${ZRAM_SWAP_FUNCTION}() {`,
    '  local conf="$1" sysctl_conf="$2" generator="$3" proc_swaps="$4" size_kib packaged_md5 actual_md5 restart_default=0',
    `  local marker='${marker}'`,
    '  if [[ -e "$conf" ]] && ! grep -qF "$marker" "$conf" 2>/dev/null; then',
    // dpkg's recorded conffile checksum distinguishes Ubuntu's freshly installed default from
    // a customer's config. Do not infer ownership merely from a plausible-looking body.
    // Query dpkg's conffile ledger through `--status` rather than embedding its `${Conffiles}`
    // format token: the latter looks like an unassigned shell expansion to bootstrap's static
    // set-u lint even though dpkg, not bash, owns that syntax.
    `    packaged_md5="$(dpkg-query -s ${ZRAM_GENERATOR_APT_PACKAGE} 2>/dev/null | awk -v conf="$conf" '$1 == conf { print $2 }' || true)"`,
    '    actual_md5="$(md5sum -- "$conf" 2>/dev/null | cut -d " " -f 1 || true)"',
    '    if [[ ! "$packaged_md5" =~ ^[a-f0-9]{32}$ || "$actual_md5" != "$packaged_md5" ]]; then',
    `      ${status('status=skipped reason=foreign-generator-config path=$conf')}`,
    '      return 0',
    '    fi',
    '    if grep -q "^/dev/zram0[[:space:]]" "$proc_swaps" 2>/dev/null; then restart_default=1; fi',
    '  fi',
    '  if [[ ! -e "$conf" ]] && grep -q "^/dev/zram" "$proc_swaps" 2>/dev/null; then',
    `    ${status('status=skipped reason=foreign-zram-swap-active')}`,
    '    return 0',
    '  fi',
    '  if [[ ! -x "$generator" ]]; then',
    `    ${status('status=absent reason=generator-missing path=$generator')}`,
    '    return 0',
    '  fi',
    '  install -d -m 0755 -- "$(dirname -- "$conf")" "$(dirname -- "$sysctl_conf")" || true',
    `  if ! printf '%s\\n' "$marker" ${quoted(zramGeneratorConfigLines())} > "$conf.next" || ! mv -f -- "$conf.next" "$conf"; then`,
    '    rm -f -- "$conf.next"',
    `    ${status('status=absent reason=config-write-failed path=$conf')}`,
    '    return 0',
    '  fi',
    `  printf '%s\\n' "$marker" ${quoted(zramSysctlLines())} > "$sysctl_conf" || true`,
    '  sysctl -q -p "$sysctl_conf" >/dev/null 2>&1 || true',
    // Ubuntu's package post-install may already have activated its 4 GiB/kernel-default device.
    // Only that proven unchanged packaged default is restarted to apply our settings; an owned
    // device on ordinary re-runs is merely started, preserving its compressed pages.
    '  if [[ "$restart_default" -eq 1 ]]; then',
    `    { systemctl stop ${ZRAM_SWAP_UNIT} && systemctl stop systemd-zram-setup@zram0.service && systemctl daemon-reload && systemctl start ${ZRAM_SWAP_UNIT}; } >/dev/null 2>&1 || true`,
    '  else',
    `    { systemctl daemon-reload && systemctl start ${ZRAM_SWAP_UNIT}; } >/dev/null 2>&1 || true`,
    '  fi',
    `  size_kib="$(awk '$1 == "${ZRAM_SWAP_DEVICE}" { print $3 }' "$proc_swaps" 2>/dev/null || true)"`,
    '  if [[ -n "$size_kib" ]]; then',
    `    ${status(`status=active device=${ZRAM_SWAP_DEVICE} sizeMiB=$(( size_kib / 1024 ))`)}`,
    '  else',
    `    ${status(`status=absent reason=swap-not-active unit=${ZRAM_SWAP_UNIT}`)}`,
    '  fi',
    '  return 0',
    '}',
  ];
}

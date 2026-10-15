/**
 * EI-20207763368144905 — quote-safe HUD assertions for verify-tauri-headless.
 *
 * A nested `bash -c` can silently concatenate adjacent double-quoted shell
 * fragments. The command still exits successfully, but tauri-agent-tools sees
 * `to: /settings/p2p` instead of the quoted JS string, so the run is invalid.
 * Keep the documented outer-double/single-JS-quote recipe executable here.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');
const COUNT_SURFACES_SCRIPT = resolve(
  __dirname,
  '../../../scripts/verify-count-surfaces-tauri.sh',
);
const countSurfacesSrc = readFileSync(COUNT_SURFACES_SCRIPT, 'utf8');
const EXPRESSION = 'window.__TSR_ROUTER__?.navigate({ to: "/settings/p2p" })';

function fakeCommandDir() {
  const dir = mkdtempSync(join(tmpdir(), 'verify-tauri-quoting-'));
  const evalCapture = join(dir, 'eval.txt');
  const pollCapture = join(dir, 'poll.txt');
  const fakeTool = join(dir, 'tauri-agent-tools');
  const fakePoll = join(dir, 'poll-dom.sh');
  writeFileSync(
    fakeTool,
    `#!/usr/bin/env bash
set -u
[ "$1" = eval ] || exit 20
[ "$2" = --pid ] || exit 21
[ "$3" = 4242 ] || exit 22
printf '%s' "$4" > "$VERIFY_TAURI_EVAL_CAPTURE"
`,
  );
  writeFileSync(
    fakePoll,
    `#!/usr/bin/env bash
set -u
printf '%s\\n' "$@" > "$VERIFY_TAURI_POLL_CAPTURE"
`,
  );
  chmodSync(fakeTool, 0o755);
  chmodSync(fakePoll, 0o755);
  return { dir, evalCapture, pollCapture, fakePoll };
}

const P014_CAPTURE_NAMES = [
  'work-items',
  'learning-observations',
  'learning-improve',
  'learning-retain',
  'git-history',
  'logs',
  'coordination-history',
  'cupboard',
] as const;

function runFakeCountSurfacesAcceptance(
  captureMode: 'duplicate' | 'failure' | 'success',
) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-count-surfaces-'));
  const output = join(dir, 'output');
  const fakeTool = join(dir, 'tauri-agent-tools');
  const fakePoll = join(dir, 'poll-dom.sh');

  writeFileSync(
    fakeTool,
    `#!/usr/bin/env bash
set -euo pipefail
command="$1"
shift
case "$command" in
  page-state|process-tree|eval)
    printf '{}\\n'
    ;;
  check)
    ;;
  list-windows)
    [ "\${DISPLAY:-}" = :91 ] || exit 33
    printf '%s\\n' '[{"windowId":"4242001","pid":4242,"name":"helper","width":10,"height":10,"bridge":{"port":41001,"token":"p014-secret-helper-token"}},{"windowId":"4242002","pid":4242,"name":"Papercusp","width":1280,"height":800,"tauri":true,"bridge":{"port":41002,"token":"p014-secret-bridge-token"},"authorization":"p014-secret-authorization"},{"windowId":"9999","pid":9999,"name":"Papercusp dev (npm run dev)","width":1600,"height":900,"bridge":{"port":49999,"token":"p014-secret-foreign-token"}}]'
    ;;
  capture)
    [ "\${DISPLAY:-}" = :91 ] || exit 33
    capture_output=''
    window_id=''
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --output)
          capture_output="$2"
          shift 2
          ;;
        --window-id)
          window_id="$2"
          shift 2
          ;;
        *)
          shift
          ;;
      esac
    done
    [ -n "$capture_output" ] || exit 30
    [ "$window_id" = 4242002 ] || exit 32
    mkdir -p "$capture_output"
    if [ "\${P014_FAKE_CAPTURE_MODE:-failure}" != failure ]; then
      if [ "\${P014_FAKE_CAPTURE_MODE}" = duplicate ]; then
        printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' | base64 -d > "$capture_output/screenshot.png"
        printf '%s' "$capture_output" >> "$capture_output/screenshot.png"
      else
        case "$(basename "$capture_output")" in
          work-items) color='#e6194b' ;;
          learning-observations) color='#3cb44b' ;;
          learning-improve) color='#ffe119' ;;
          learning-retain) color='#4363d8' ;;
          git-history) color='#f58231' ;;
          logs) color='#911eb4' ;;
          coordination-history) color='#46f0f0' ;;
          cupboard) color='#f032e6' ;;
          *) exit 34 ;;
        esac
        convert -size 2x2 "xc:$color" "$capture_output/screenshot.png"
      fi
      printf '{"errorCount":0,"files":{"screenshot.png":"%s"}}\\n' "$capture_output/screenshot.png"
    else
      printf '{"errorCount":1,"files":{"screenshot.png":"error: xdotool failed"}}\\n'
    fi
    ;;
  *)
    exit 31
    ;;
esac
`,
  );
  writeFileSync(fakePoll, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(fakeTool, 0o755);
  chmodSync(fakePoll, 0o755);

  const result = spawnSync('bash', [COUNT_SURFACES_SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PAPERCUSP_SID: 'p014-regression',
      P014_FAKE_CAPTURE_MODE: captureMode,
      VERIFY_COUNT_SURFACES_OUTPUT: output,
      VERIFY_TAURI_AGENT_TOOLS_BIN: fakeTool,
      VERIFY_TAURI_DISPLAY: ':91',
      VERIFY_TAURI_PID: '4242',
      VERIFY_TAURI_POLL: fakePoll,
    },
  });

  return { output, result };
}

describe('EI-20207763368144905 — nested HUD assertion quoting', () => {
  it('documents the safe outer-double/single-JS-quote recipe', () => {
    expect(src).toContain(`'${EXPRESSION.replaceAll('"', '\\"')}'`);
    expect(src).not.toContain(`"${EXPRESSION}"`);
  });

  it('preserves the JS route and poll arguments through bash -c', () => {
    const { dir, evalCapture, pollCapture, fakePoll } = fakeCommandDir();
    const recipe = [
      'tauri-agent-tools eval --pid "$VERIFY_TAURI_PID" \\',
      `  '${EXPRESSION}'`,
      '"$VERIFY_TAURI_POLL" --selector body --text Peer --no-errors',
    ].join('\n');
    const result = spawnSync('bash', ['-c', recipe], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
        VERIFY_TAURI_PID: '4242',
        VERIFY_TAURI_POLL: fakePoll,
        VERIFY_TAURI_EVAL_CAPTURE: evalCapture,
        VERIFY_TAURI_POLL_CAPTURE: pollCapture,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(evalCapture, 'utf8')).toBe(EXPRESSION);
    expect(readFileSync(pollCapture, 'utf8')).toBe(
      '--selector\nbody\n--text\nPeer\n--no-errors\n',
    );
  });

  it('removes the per-run bridge token only after stopping the owned process tree', () => {
    const stopIndex = src.indexOf('"$WORK/stop.sh" >/dev/null 2>&1 || true');
    const runtimeTokenCleanupIndex = src.indexOf(
      'rm -f -- "${TMPDIR:-/tmp}/tauri-dev-bridge-$BRIDGE_PID.token"',
    );
    const fallbackTokenCleanupIndex = src.indexOf(
      'rm -f -- "/tmp/tauri-dev-bridge-$BRIDGE_PID.token"',
    );
    expect(stopIndex).toBeGreaterThan(0);
    expect(runtimeTokenCleanupIndex).toBeGreaterThan(stopIndex);
    expect(fallbackTokenCleanupIndex).toBeGreaterThan(runtimeTokenCleanupIndex);
    expect(src).toContain('if [ "${TMPDIR:-/tmp}" != "/tmp" ]; then');
  });
});

describe('P-014 corpus-count Tauri acceptance recipe', () => {
  it('pins every required route and decisive selector without a placeholder', () => {
    expect(countSurfacesSrc).not.toContain('<exit-coded assertion command>');
    expect(countSurfacesSrc).toContain('tab: "harnesses", slug: "papercusp"');
    expect(countSurfacesSrc).toContain('tab: "learning", lview: "observations"');
    expect(countSurfacesSrc).toContain('tab: "learning", lview: "improvements"');
    expect(countSurfacesSrc).toContain('tab: "learning", lview: "learnings"');
    expect(countSurfacesSrc).toContain('tab: "git", slug: "papercusp"');
    expect(countSurfacesSrc).toContain('to: "/coord", search: { panel: "history" }');
    expect(countSurfacesSrc).toContain('to: "/cupboard"');
    expect(countSurfacesSrc).toContain('[data-testid=wi-count]');
    expect(countSurfacesSrc).toContain('[data-testid=observations-count]');
    // The Improve match count moved to the shared `.pc-advpanel__count` chrome that
    // Retain also renders, so this selector MUST stay scoped to the Improve toolbar.
    // The previous pin named `.pc-learning__inlinetools .pc-learning__matchcount`,
    // a selector the rename had already deleted — which made the assert in the
    // script unsatisfiable and made THIS guard enforce the drift instead of catching
    // it. A pin on a class that no longer exists is worse than no pin at all.
    expect(countSurfacesSrc).toContain(
      '.pc-learning__improvebar .pc-advpanel__count',
    );
    // Both tabs render `.pc-advpanel__count` now, so an UNSCOPED query can silently
    // read the wrong tab's number and still pass. This is the live version of the
    // hazard the old `.pc-learning__matchcount` line was written for.
    expect(countSurfacesSrc).not.toContain(
      'document.querySelector(".pc-advpanel__count")',
    );
    expect(countSurfacesSrc).not.toContain('"$P014_TAURI_TOOL" wait');
    expect(countSurfacesSrc).not.toContain('"$P014_TAURI_TOOL" type');
    expect(countSurfacesSrc).toContain('p014_type_controlled()');
    expect(countSurfacesSrc).toContain(
      "Object.getOwnPropertyDescriptor(proto, 'value')?.set",
    );
    expect(countSurfacesSrc).toContain(
      'new URLSearchParams(location.search).get(${query_key_json}) === ${text_json}',
    );
    expect(countSurfacesSrc).toContain('  impq');
    expect(countSurfacesSrc).toContain('  rq');
    expect(countSurfacesSrc).toContain(
      'if ! "$P014_TAURI_POLL" --quiet --selector \'[data-testid="wi-count"]\'; then',
    );
    expect(countSurfacesSrc).toContain(
      'if ! "$P014_TAURI_POLL" --quiet --selector \'.pc-adv-logs .pc-advpanel__filterbar[data-count-evidence="window"]\'; then',
    );
    expect(countSurfacesSrc).toContain('p014_open_catalog_panel()');
    expect(countSurfacesSrc).toContain("p014_open_catalog_panel 'Work items'");
    expect(countSurfacesSrc).toContain("p014_open_catalog_panel 'Run log'");
    expect(countSurfacesSrc).toContain("querySelectorAll('.pc-add-panel__label')");
    expect(countSurfacesSrc).toContain("label?.closest('button')");
    expect(countSurfacesSrc).not.toContain(
      'querySelectorAll("button,[role=option],[role=menuitem]")',
    );
    expect(countSurfacesSrc.match(/"\$P014_TAURI_POLL" \\\n  --eval/g)).toHaveLength(3);
    expect(
      countSurfacesSrc.match(
        /if \(\/\^Count \(\?:loading…\|updating…\|unavailable\)\$\/\.test\(visible\)\) return aria === visible;/g,
      ),
    ).toHaveLength(2);
    expect(
      countSurfacesSrc.match(
        /if \(visible === "—"\) return \/\^Count \(\?:loading…\|updating…\|unavailable\)\$\/\.test\(aria\);/g,
      ),
    ).toHaveLength(2);
    expect(countSurfacesSrc).toContain(
      'P014_TAURI_DIAG learning-improve did not converge',
    );
    expect(countSurfacesSrc).toContain('.pc-learning__retained .pc-advpanel__count');
    expect(countSurfacesSrc).toContain('.pc-adv-gitgrid__count');
    expect(countSurfacesSrc).toContain('Filter option counts cover latest 300 events.');
    expect(countSurfacesSrc).toContain('latest matches · up to 200');
    expect(countSurfacesSrc).toContain('[data-testid=cupboard-pagination]');
  });

  it('makes population mismatches, console errors, and missing provenance fail closed', () => {
    expect(countSurfacesSrc).toContain('set -euo pipefail');
    expect(countSurfacesSrc).toContain('missing PAPERCUSP_SID provenance');
    expect(countSurfacesSrc).toContain(
      'missing provenance-checked VERIFY_TAURI_DISPLAY',
    );
    expect(countSurfacesSrc).toContain('list-windows --json');
    expect(countSurfacesSrc).toContain('DISPLAY="$P014_TAURI_DISPLAY"');
    expect(countSurfacesSrc).toContain('--window-id "$P014_TAURI_WINDOW_ID"');
    expect(countSurfacesSrc).toContain("'rgba:-'");
    expect(countSurfacesSrc).not.toContain('--title Papercusp');
    expect(countSurfacesSrc).toContain('--no-errors');
    expect(countSurfacesSrc).toContain('/loaded/i.test');
    expect(countSurfacesSrc).toContain('facets.reduce((a, b) => a + b, 0) === total');
  });

  it('fails closed when capture reports screenshot errors despite exiting zero', () => {
    const { result } = runFakeCountSurfacesAcceptance('failure');

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('P014_TAURI_ACCEPTANCE_OK');
    expect(result.stderr).toContain(
      'P014_TAURI_CAPTURE_INVALID name=work-items reason=errorCount=1',
    );
  });

  it('fails closed when eight valid PNGs all depict the same wrong window', () => {
    const { result } = runFakeCountSurfacesAcceptance('duplicate');

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('P014_TAURI_ACCEPTANCE_OK');
    expect(result.stderr).toContain(
      'P014_TAURI_SCREENSHOT_SET_INVALID reason=duplicate-pixels=',
    );
  });

  it('emits the terminal marker only after eight validated PNG captures', () => {
    const { output, result } = runFakeCountSurfacesAcceptance('success');

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(
      'P014_TAURI_SCREENSHOT_SET_OK uniquePixels=8',
    );
    expect(result.stdout.match(/P014_TAURI_ACCEPTANCE_OK/g)).toHaveLength(1);
    const selected = JSON.parse(
      readFileSync(join(output, 'window-selected.json'), 'utf8'),
    ) as { targetPid: number; selected: { windowId: string; name: string } };
    expect(selected).toMatchObject({
      targetPid: 4242,
      selected: { windowId: '4242002', name: 'Papercusp' },
    });
    for (const capture of P014_CAPTURE_NAMES) {
      const record = JSON.parse(
        readFileSync(join(output, `${capture}-result.json`), 'utf8'),
      ) as { errorCount: number; files: Record<string, string> };
      expect(record.errorCount).toBe(0);
      expect(readFileSync(record.files['screenshot.png']).subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
    }
  });

  it('drops live bridge credentials from persisted window evidence', () => {
    const { output, result } = runFakeCountSurfacesAcceptance('success');

    expect(result.status, result.stderr).toBe(0);
    const inventoryText = readFileSync(join(output, 'windows.json'), 'utf8');
    const selectedText = readFileSync(join(output, 'window-selected.json'), 'utf8');
    for (const evidence of [inventoryText, selectedText]) {
      expect(evidence).not.toContain('p014-secret-');
      expect(evidence).not.toContain('"bridge"');
      expect(evidence).not.toContain('"authorization"');
      expect(evidence).not.toContain('"token"');
    }
    const inventory = JSON.parse(inventoryText) as Array<Record<string, unknown>>;
    expect(inventory).toContainEqual(
      expect.objectContaining({
        windowId: '4242002',
        pid: 4242,
        name: 'Papercusp',
        width: 1280,
        height: 800,
        tauri: true,
      }),
    );
  });

  it('writes route-specific captures and one unambiguous terminal marker', () => {
    for (const capture of P014_CAPTURE_NAMES) {
      expect(countSurfacesSrc).toContain(`p014_capture ${capture}`);
    }
    expect(countSurfacesSrc).toContain('P014_TAURI_ACCEPTANCE_OK');
  });
});

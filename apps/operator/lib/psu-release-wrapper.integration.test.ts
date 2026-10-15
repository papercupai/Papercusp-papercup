// @vitest-environment node
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execPath } from 'node:process';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PSU_REEXEC_EXIT_CODE } from '../scripts/psu-pty-host.mjs';

const RELEASE_PSU = fileURLToPath(new URL('../../tui/release/psu', import.meta.url));

describe('PUI release psu wrapper', () => {
  it.skipIf(process.platform === 'win32')('keeps the re-exec parent and removes one-shot kickoff args', () => {
    const root = mkdtempSync(join(tmpdir(), 'psu-release-wrapper-'));
    try {
      const bin = join(root, 'bin');
      const nodeDir = join(root, 'lib/node');
      const psuDir = join(root, 'lib/psu');
      mkdirSync(bin, { recursive: true });
      mkdirSync(nodeDir, { recursive: true });
      mkdirSync(psuDir, { recursive: true });
      const wrapper = join(bin, 'psu');
      copyFileSync(RELEASE_PSU, wrapper);
      chmodSync(wrapper, 0o755);
      symlinkSync(execPath, join(nodeDir, 'node'));

      const log = join(root, 'runs.jsonl');
      const launcher = [
        "import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';",
        'const log = process.env.PSU_TEST_RUN_LOG;',
        'let count = 0;',
        "try { count = Number(readFileSync(log + '.count', 'utf8')); } catch {}",
        'appendFileSync(log, JSON.stringify({',
        '  reexec: process.env.PAPERCUSP_PSU_REEXEC,',
        '  reexecCount: process.env.PAPERCUSP_PSU_REEXEC_COUNT,',
        '  advertiser: process.env.PAPERCUSP_PSU_REEXEC_PPID,',
        '  ppid: process.ppid,',
        '  sidecar: process.env.PAPERCUSP_SIDECAR_BIN,',
        '  args: process.argv.slice(2),',
        '}) + \'\\n\');',
        "writeFileSync(log + '.count', String(count + 1));",
        'process.exit(count === 0 ? ' + PSU_REEXEC_EXIT_CODE + ' : 0);',
        '',
      ].join('\n');
      writeFileSync(join(psuDir, 'psu.mjs'), launcher);

      const result = spawnSync(wrapper, ['--agent=claude', '--kickoff=once', '--resume=session'], {
        encoding: 'utf8',
        env: { ...process.env, PSU_TEST_RUN_LOG: log, PAPERCUSP_PSU_REEXEC_COUNT: '99' },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const runs = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(runs).toHaveLength(2);
      expect(runs[0].reexec).toBe(String(PSU_REEXEC_EXIT_CODE));
      expect(runs.map((run) => run.reexecCount)).toEqual(['0', '1']);
      expect(runs.every((run) => String(run.ppid) === run.advertiser)).toBe(true);
      expect(runs.every((run) => run.sidecar === nodeDir)).toBe(true);
      expect(runs[0].args).toEqual(['--agent=claude', '--kickoff=once', '--resume=session']);
      expect(runs[1].args).toEqual(['--agent=claude', '--resume=session']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('honors the explicit host-adopt kill switch without advertising a loop', () => {
    const root = mkdtempSync(join(tmpdir(), 'psu-release-wrapper-off-'));
    try {
      const bin = join(root, 'bin');
      const nodeDir = join(root, 'lib/node');
      const psuDir = join(root, 'lib/psu');
      mkdirSync(bin, { recursive: true });
      mkdirSync(nodeDir, { recursive: true });
      mkdirSync(psuDir, { recursive: true });
      const wrapper = join(bin, 'psu');
      copyFileSync(RELEASE_PSU, wrapper);
      chmodSync(wrapper, 0o755);
      symlinkSync(execPath, join(nodeDir, 'node'));
      const log = join(root, 'runs.jsonl');
      writeFileSync(join(psuDir, 'psu.mjs'), [
        "import { appendFileSync } from 'node:fs';",
        'appendFileSync(process.env.PSU_TEST_RUN_LOG, JSON.stringify({reexec: process.env.PAPERCUSP_PSU_REEXEC}) + \'\\n\');',
        'process.exit(' + PSU_REEXEC_EXIT_CODE + ');',
        '',
      ].join('\n'));
      const result = spawnSync(wrapper, [], {
        encoding: 'utf8',
        env: { ...process.env, PAPERCUSP_PSU_HOST_ADOPT: '0', PSU_TEST_RUN_LOG: log },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(PSU_REEXEC_EXIT_CODE);
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['{}']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

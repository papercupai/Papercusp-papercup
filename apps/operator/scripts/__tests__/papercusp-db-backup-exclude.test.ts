/**
 * The hourly host dump enumerates databases and drops names matching EXCLUDE_RE
 * with `grep -vE` (papercusp-db-backup.sh). This pins which names that real regex
 * keeps and drops, using the same grep engine the script uses.
 *
 * EI-25211496463956189: the test harness's migration templates (`tmpl_*`) and
 * throwaway integration baselines (`papercusp_it_baseline_*`) were dumped every
 * hour (17 + 7 on 2026-10-06), and one dropped mid-run failed the whole backup.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptPath =
  process.env.PAPERCUSP_DB_BACKUP_SCRIPT_UNDER_TEST ||
  fileURLToPath(new URL('../systemd/papercusp-db-backup.sh', import.meta.url));

function excludeRe(): string {
  const match = readFileSync(scriptPath, 'utf8').match(/^EXCLUDE_RE='([^']+)'$/m);
  if (!match) throw new Error(`EXCLUDE_RE='...' not found in ${scriptPath}`);
  return match[1];
}

/** The names `grep -vE "$EXCLUDE_RE"` lets through, exactly as the script filters them. */
function kept(names: string[]): string[] {
  const r = spawnSync('grep', ['-vE', excludeRe()], { input: `${names.join('\n')}\n`, encoding: 'utf8' });
  expect(r.status === 0 || r.status === 1, r.stderr).toBe(true);
  return r.stdout.split('\n').filter(Boolean);
}

describe('papercusp-db-backup database exclusion', () => {
  it('drops the test harness templates and throwaway integration baselines', () => {
    const throwaway = [
      'papercusp_it_baseline_ddaa2356748f',
      'papercusp_it_baseline_4dc12ef7a500',
      'tmpl_78004e9a662d18b5',
      'tmpl_bld_78004e9a662d18b5_1a2b3c4d',
      'tmpl_gym_0123456789abcde',
    ];
    expect(kept(throwaway)).toEqual([]);
  });

  it('keeps the previously excluded classes excluded', () => {
    expect(kept(['orders_test', 'e2e_run', 'repro_1', 'scratch_x', 'restore_check_1', 'gym_smoke_a', 'template1'])).toEqual([]);
  });

  it('still dumps real databases, including ones that merely contain the excluded words', () => {
    const real = ['papercusp', 'postgres', 'email_app', 'phone_app_test2', 'consulte_86d93eaa33', 'papercusp_it', 'my_tmpl_store'];
    expect(kept(real)).toEqual(real);
  });
});

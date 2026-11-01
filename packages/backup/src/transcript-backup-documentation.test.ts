import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const hookSource = new URL('./hook.ts', import.meta.url);
const producerSource = new URL(
  '../../../apps/operator/scripts/systemd/papercusp-db-backup.sh',
  import.meta.url,
);

describe('host transcript backup documentation', () => {
  it('matches the producer root, cadence, tier, and Kopia policy', async () => {
    const [hook, producer] = await Promise.all([
      readFile(hookSource, 'utf8'),
      readFile(producerSource, 'utf8'),
    ]);

    expect(producer).toContain('PC_BACKUP_TIER_DBS="${PC_BACKUP_TIER_DBS:-papercusp}"');
    expect(producer).toContain('DUMP="${PAPERCUSP_HOST_PG_DUMP_DIR:-/mnt/cold-a/Backup/db-dumps}"');
    expect(producer).toContain('PC_BACKUP_TRANSCRIPT_MIN_AGE_SEC="${PC_BACKUP_TRANSCRIPT_MIN_AGE_SEC:-9000}"');
    expect(producer).toContain('ensure_kopiaignore_rule "$db-transcript"');

    expect(hook).toContain('/mnt/cold-a/Backup/db-dumps/pg');
    expect(hook).toContain('9000 seconds old');
    expect(hook).toContain('local-only tier');
    expect(hook).toContain('never enrolled in Kopia');
    expect(hook).toContain('no Kopia snapshot coverage');
    expect(hook).not.toContain('/mnt/data/Backup/db-dumps/pg/papercusp/');
    expect(hook).not.toContain('hourly host-level dump remains the recovery path');
  });
});

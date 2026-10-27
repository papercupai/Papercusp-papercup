import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SU_EXEC_INVENTORY, SU_EXEC_NATIVE_REQUESTS } from './__fixtures__/su-execution-parity';
import { SU_EXEC_REQUEST_BASELINE, SU_EXEC_REQUEST_DISPOSITIONS } from './__fixtures__/su-execution-native-requests';

describe('P007 native renderer inventory closure', () => {
  it('pins the full baseline revision, content and every native request family without silently reducing the population', () => {
    const baseline = readFileSync(resolve(__dirname, '__fixtures__/su-execution-parity.ts'));
    expect(SU_EXEC_REQUEST_BASELINE.revision).toBe(SU_EXEC_INVENTORY.revision);
    expect(SU_EXEC_REQUEST_BASELINE.sha256).toBe(createHash('sha256').update(baseline).digest('hex'));
    const key = (row: { provider: string; method: string }) => `${row.provider}:${row.method}`;
    expect(SU_EXEC_REQUEST_DISPOSITIONS.map(key).sort()).toEqual(SU_EXEC_NATIVE_REQUESTS.map(key).sort());
    expect(new Set(SU_EXEC_REQUEST_DISPOSITIONS.map(key)).size).toBe(SU_EXEC_NATIVE_REQUESTS.length);
    for (const row of SU_EXEC_REQUEST_DISPOSITIONS) {
      expect(['supported', 'refused']).toContain(row.disposition);
      expect(row.owner).toBe('P-007'); expect(row.reason.length).toBeGreaterThan(20);
      expect(row.scenario.length).toBeGreaterThan(20);
      const source = readFileSync(resolve(__dirname, '../../..', row.testFile), 'utf8').replaceAll("\\'", "'");
      expect(source, row.scenario).toContain(row.declaration);
    }
  });
});

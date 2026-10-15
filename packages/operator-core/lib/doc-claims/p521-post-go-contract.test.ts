import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runbook = readFileSync(
  new URL('../../../../shared-pot-release-testing/P521-HARDENED-ACCEPTANCE-2026-09-05.md', import.meta.url),
  'utf8',
);
const afterGo = runbook.split('## After GO\n')[1]?.split('\n## ')[0];

describe('P521 physical acceptance post-GO contract', () => {
  it('does not restore the retired timed-soak gate', () => {
    expect(afterGo).toBeDefined();
    expect(afterGo).toContain('D-170/D-173 remove P-501 and every timed-soak prerequisite');
    expect(afterGo).not.toMatch(/(?:start|complete|require)[^.\n]*(?:72.hour|3.day|timed.soak)/i);
  });

  it('retains actual chaos, denied-effect checks, and owner-authorized recovery', () => {
    expect(afterGo).toContain('owner-freeze/recovery chaos exercise');
    expect(afterGo).toContain('must leave protected effects unchanged');
    expect(afterGo).toContain('fresh owner-countersigned monotonic advance');
    expect(afterGo).toContain('never automatic takeover');
    expect(afterGo).toContain('public publication remains separately governed');
  });
});

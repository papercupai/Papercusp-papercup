import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * EI-24671762379791202 / EI-21852216520189549: a capability:bash background deadline is
 * the transient service's RuntimeMaxSec, and systemd 255 refuses to change RuntimeMaxSec on
 * a running unit (both `set-property --runtime` and the persistent form fail with "Cannot set
 * property RuntimeMaxUSec"). The `timeout` arg description must say so, or an agent sizes a
 * multi-hour chain for the happy path and loses a rep at the deadline.
 *
 * The claim has two halves, pinned together:
 *  - PROSE: the timeout description states the deadline is fixed at launch.
 *  - CODE TRUTH: no processes:* verb extends a running task's deadline. If one is added,
 *    this test fails so the prose is corrected in the same change instead of going stale.
 */

/** Repo root from this file: packages/operator-core/lib/doc-claims → up four. */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const BASH_TOOL = 'packages/operator-core/lib/agent-tools/capability/bash.ts';
const PROCESSES_DIR = 'packages/operator-core/lib/agent-tools/processes';

/** Extract the `timeout:` zod field's `.describe(...)` text (template literals concatenated). */
function timeoutDescribeText(source: string): string | null {
  const start = source.indexOf('timeout: z');
  if (start < 0) return null;
  const describeAt = source.indexOf('.describe(', start);
  // The next schema field ends this one; a describe past it belongs to someone else.
  const nextField = source.slice(start + 1).search(/\n\s{4}[a-z_]+: z\b/);
  const fieldEnd = nextField < 0 ? source.length : start + 1 + nextField;
  if (describeAt < 0 || describeAt > fieldEnd) return null;
  const body = source.slice(describeAt, fieldEnd);
  return [...body.matchAll(/`([^`]*)`/g)].map((m) => m[1]).join('');
}

/** The claim the prose must carry. */
function judgeDeadlineProse(text: string | null): { ok: boolean; problem?: string } {
  if (text === null) return { ok: false, problem: 'timeout .describe() not found — anchor renamed?' };
  if (!/FIXED AT LAUNCH/.test(text)) return { ok: false, problem: 'does not say the deadline is fixed at launch' };
  if (!/cannot be extended/i.test(text)) return { ok: false, problem: 'does not say a running task cannot be extended' };
  if (!/all command wall-clock work, including sleeps, SSH\/remote round-trips, retries, and other waits/i.test(text)) {
    return { ok: false, problem: 'does not say the execution deadline covers all command waits and remote work' };
  }
  if (!/separate tasks/i.test(text)) return { ok: false, problem: 'gives no alternative (chain as separate tasks)' };
  return { ok: true };
}

/** Verb files whose name says they would change a running task's deadline. */
function deadlineExtendVerbs(files: string[]): string[] {
  return files.filter((f) => /^(extend|deadline|set-deadline|renew)[\w-]*\.ts$/.test(f) && !f.endsWith('.test.ts'));
}

const FIXTURE = [
  '    timeout: z',
  '      .number()',
  '      .describe(',
  '        `Wall-clock timeout. Budget it for all command wall-clock work, including sleeps, SSH/remote round-trips, retries, and other waits. ` +',
  '        `The deadline is FIXED AT LAUNCH and cannot be extended ` +',
  '          `on a running task: chain longer work as separate tasks.`,',
  '      ),',
  '    yield_after_ms: z',
  '      .number()',
].join('\n');

describe('capability:bash deadline-immutability doc claim (EI-24671762379791202)', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('accepts the fixture that carries the claim', () => {
      expect(judgeDeadlineProse(timeoutDescribeText(FIXTURE))).toEqual({ ok: true });
    });

    it('fails when the immutability sentence is dropped', () => {
      const v = judgeDeadlineProse(timeoutDescribeText(FIXTURE.replace('FIXED AT LAUNCH and cannot be extended', 'tunable')));
      expect(v.ok).toBe(false);
    });

    it('fails when the full command-budget guidance is dropped', () => {
      const v = judgeDeadlineProse(timeoutDescribeText(FIXTURE.replace(
        'Budget it for all command wall-clock work, including sleeps, SSH/remote round-trips, retries, and other waits. ',
        '',
      )));
      expect(v.ok).toBe(false);
    });

    it('fails when the timeout field cannot be found, rather than passing vacuously', () => {
      expect(judgeDeadlineProse(timeoutDescribeText(FIXTURE.replace('timeout: z', 'deadline: z'))).ok).toBe(false);
    });

    it('does not read a later field\'s describe as the timeout\'s', () => {
      const noDescribe = FIXTURE.replace('      .describe(', '      .optional(');
      expect(timeoutDescribeText(noDescribe)).toBeNull();
    });

    it('flags an extend verb file and ignores tests and unrelated verbs', () => {
      expect(deadlineExtendVerbs(['kill.ts', 'extend.ts', 'extend.test.ts', 'list.ts'])).toEqual(['extend.ts']);
    });
  });

  describe('real tree', () => {
    it('the live capability:bash timeout description states the deadline is fixed at launch', () => {
      const text = timeoutDescribeText(readFileSync(join(REPO_ROOT, BASH_TOOL), 'utf8'));
      expect(judgeDeadlineProse(text)).toEqual({ ok: true });
    });

    it('no processes:* verb extends a running task deadline (else update the prose above)', () => {
      const files = readdirSync(join(REPO_ROOT, PROCESSES_DIR));
      expect(files).toContain('kill.ts'); // positive control: the haystack is the real verb dir
      expect(deadlineExtendVerbs(files)).toEqual([]);
    });
  });
});

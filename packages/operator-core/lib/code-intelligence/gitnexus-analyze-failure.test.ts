/**
 * WI-10005680 recurrence guard — a vendor segfault inside `gitnexus analyze` must surface as a NAMED
 * failure (which knob, which residue), on BOTH ways a caller can observe it:
 *   - the bench sees exit 139 (GNU `time`/`timeout` re-report 128 + SIGSEGV),
 *   - the production reindex action sees `code=null, signal=SIGSEGV` (collapsed to code 1).
 * Nothing here spawns a real analyzer; the fixtures are the vendor's own measured log lines.
 */
import { describe, expect, it } from 'vitest';
import { classifyAnalyzeFailure, describeAnalyzeFailure } from './gitnexus-analyze-failure';

// The measured WI-39394 / WI-10005581 sequence, ANSI erase-line prefix included (the real logs carry it).
const CEILING_LOG = [
  '01:20:11 \u001b[2K  Writing embeddings',
  '01:48:02 \u001b[2K  Buffer manager exception: Maximum database size of 17179869184 bytes has been reached.',
  '01:48:02 \u001b[2K  manual WAL checkpoint failed after retries',
].join('\n');
const POOL_LOG = 'COPY failed for File: Buffer manager exception: Unable to allocate memory! The buffer pool is full and no memory could be freed!';

describe('classifyAnalyzeFailure', () => {
  it('names the ceiling for the bench shape (exit 139 + vendor line)', () => {
    const c = classifyAnalyzeFailure({ code: 139, stdout: '', stderr: CEILING_LOG });
    expect(c?.kind).toBe('lbug-max-db-size');
    expect(c?.summary).toContain('17179869184');
    expect(c?.summary).toContain('16 GiB');
    expect(c?.remedy).toContain('GITNEXUS_LBUG_MAX_DB_SIZE');
  });

  it('names the ceiling for the production shape (code collapsed to 1, signal kept) with the line in stdout', () => {
    const c = classifyAnalyzeFailure({ code: 1, signal: 'SIGSEGV', stdout: CEILING_LOG, stderr: '' });
    expect(c?.kind).toBe('lbug-max-db-size');
  });

  it('prefers the ceiling over its own downstream symptom (the real log carries both)', () => {
    expect(classifyAnalyzeFailure({ code: 139, stderr: CEILING_LOG })?.kind).toBe('lbug-max-db-size');
    expect(classifyAnalyzeFailure({ code: 139, stderr: 'manual WAL checkpoint failed after retries' })?.kind).toBe('wal-checkpoint-failed');
  });

  it('separates the buffer pool (resident memory) from the ceiling (virtual reservation)', () => {
    const c = classifyAnalyzeFailure({ code: 1, stderr: POOL_LOG });
    expect(c?.kind).toBe('buffer-pool-full');
    expect(c?.remedy).toContain('GITNEXUS_LBUG_BUFFER_POOL_SIZE');
  });

  it('flags an unexplained native crash by exit code OR by signal', () => {
    expect(classifyAnalyzeFailure({ code: 139, stderr: 'segfault, nothing else' })?.kind).toBe('native-crash');
    const bySignal = classifyAnalyzeFailure({ code: 1, signal: 'SIGSEGV', stderr: 'segfault, nothing else' });
    expect(bySignal?.kind).toBe('native-crash');
    expect(bySignal?.summary).toContain('SIGSEGV');
  });

  it('returns null — "not recognised", never "fine" — for success, deadline kills and ordinary failures', () => {
    // A success must never be reclassified, even if its log mentions the line (e.g. a retried-then-ok run).
    expect(classifyAnalyzeFailure({ code: 0, stdout: CEILING_LOG })).toBeNull();
    expect(classifyAnalyzeFailure({ code: 124, stderr: 'deadline' })).toBeNull();
    expect(classifyAnalyzeFailure({ code: 137, stderr: 'killed' })).toBeNull();
    expect(classifyAnalyzeFailure({ code: 1, stderr: 'ENOENT: no such file' })).toBeNull();
  });

  it('describeAnalyzeFailure carries the kind and the knob for a log line / alert body', () => {
    const c = classifyAnalyzeFailure({ code: 139, stderr: CEILING_LOG });
    const line = describeAnalyzeFailure(c!);
    expect(line.startsWith('[lbug-max-db-size] ')).toBe(true);
    expect(line).toContain('GITNEXUS_LBUG_MAX_DB_SIZE');
  });
});

describe('the guard is falsifiable (control measured against the same cases)', () => {
  // The pre-fix reporting: exit code only, signal erased. If the guard cannot tell this apart from the
  // real classifier on the production-shaped case, it proves nothing.
  const exitCodeOnly = (r: { code: number | null }): string | null => (r.code === 139 ? 'native-crash' : null);

  it('the exit-code-only reporter misses the production shape the real classifier names', () => {
    const productionShape = { code: 1, signal: 'SIGSEGV', stdout: CEILING_LOG, stderr: '' };
    expect(exitCodeOnly(productionShape)).toBeNull();
    expect(classifyAnalyzeFailure(productionShape)?.kind).toBe('lbug-max-db-size');
  });

  it('the exit-code-only reporter never names the knob even where it does fire', () => {
    expect(exitCodeOnly({ code: 139 })).toBe('native-crash');
    expect(classifyAnalyzeFailure({ code: 139, stderr: CEILING_LOG })?.remedy).toContain('GITNEXUS_LBUG_MAX_DB_SIZE');
  });
});

/**
 * Tests for the COMMIT-TIME secrets detector (EI-21230011589307899).
 *
 * ⚠ EVERY CREDENTIAL-SHAPED FIXTURE IN THIS FILE IS ASSEMBLED AT RUNTIME, and
 * that is load-bearing, not fussiness. A literal credential shape in this file's
 * TEXT would be caught by the very scanner under test the moment git-sync swept
 * the tree — freezing the pot's p2p egress at this blob, which no later edit can
 * undo. Writing a detector's test suite is the single most likely way to arm the
 * trap the detector exists to prevent (it is why four unrelated files already sit
 * in secrets-guard.ts's static FIXTURE_FILES set).
 *
 * The split-literal technique below keeps this file scannable-clean while still
 * exercising real matches, so it needs no exemption entry at all. Prefer it over
 * adding another exemption — an exemption is a permanent security waiver, and
 * this is a formatting choice.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  findCommitBlockingSecrets,
  findCommitBlockingSecretsSliced,
  describeCommitBlockingSecrets,
  cachedExemptionLoader,
  EXEMPTION_CACHE_TTL_MS,
} from './secrets';
import { secretsDetector, setContentLintExemptionLoader, DEFAULT_CONTENT_DETECTORS } from './registry';
import { scanTextForSecrets, scanTextForSecretsSliced, SLICED_SCAN_LINES_PER_CHECK } from '../sync/pot-git/secrets-guard';

/** An AWS-access-key-shaped value, assembled so this file's own text never
 *  carries the contiguous shape. Deliberately NOT suffixed `EXAMPLE`: the
 *  scanner treats AWS's reserved docs suffix as a documented example and skips
 *  it, which would make this fixture silently non-matching. */
const awsShape = (): string => 'AK' + 'IA' + 'QRSTUVWXYZ234567';

/** A PEM private-key HEADER, assembled the same way. No key body — the rule
 *  matches the header alone, which is exactly how a NEGATIVE test fixture in an
 *  unrelated package froze egress on 2026-08-26. */
const pemHeader = (): string => ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');

const NO_EXEMPTIONS: ReadonlySet<string> = new Set();

describe('findCommitBlockingSecrets', () => {
  it('flags a credential shape in ordinary source', () => {
    const findings = findCommitBlockingSecrets('apps/operator/lib/thing.ts', `const id = '${awsShape()}';\n`, NO_EXEMPTIONS);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe('aws-access-key-id');
    expect(findings[0].line).toBe(1);
  });

  it('flags a bare PEM header with no key body — the shape that froze egress', () => {
    const findings = findCommitBlockingSecrets('libs/x/harness.test.ts', `\n\nexpect(scan('${pemHeader()}')).toThrow();\n`, NO_EXEMPTIONS);
    expect(findings.map((f) => f.rule)).toContain('private-key-pem');
    expect(findings[0].line).toBe(3);
  });

  it('reports clean text as clean', () => {
    expect(findCommitBlockingSecrets('a/b.ts', "const NEVER_EMIT_MARKER = 'never-emit-me';\n", NO_EXEMPTIONS)).toEqual([]);
  });

  it('keeps the mobile HTTP audit fixtures committable without a secrets exemption', () => {
    const path = 'packages/operator-core/lib/owner-sessions/device-actions.integration.test.ts';
    const text = readFileSync(new URL('../owner-sessions/device-actions.integration.test.ts', import.meta.url), 'utf8');
    expect(findCommitBlockingSecrets(path, text, NO_EXEMPTIONS)).toEqual([]);
  });

  it('skips a STATIC fixture file (isFixtureFile) so the scanner cannot wedge its own suite', () => {
    const path = 'packages/operator-core/lib/sync/pot-git/secrets-guard.test.ts';
    expect(findCommitBlockingSecrets(path, `const v = '${awsShape()}';\n`, NO_EXEMPTIONS)).toEqual([]);
  });

  it('skips a RUNTIME-exempt exact path', () => {
    // Not optional: a path exempted to unfreeze PUBLISH would otherwise be
    // quarantined from COMMIT forever, trading one deadlock for another.
    const path = 'libs/generic/deployment-driver/src/workspace-host-test-harness.test.ts';
    expect(findCommitBlockingSecrets(path, `const v = '${awsShape()}';\n`, new Set([path]))).toEqual([]);
  });

  it('honours the directory-PREFIX exemption form', () => {
    const exemptions = new Set(['libs/generic/fixtures/']);
    expect(findCommitBlockingSecrets('libs/generic/fixtures/creds.ts', `const v = '${awsShape()}';\n`, exemptions)).toEqual([]);
  });

  it('does NOT let a directory-prefix exemption leak to a sibling path', () => {
    const exemptions = new Set(['libs/generic/fixtures/']);
    const findings = findCommitBlockingSecrets('libs/generic/fixtures-other.ts', `const v = '${awsShape()}';\n`, exemptions);
    expect(findings).toHaveLength(1);
  });
});

describe('describeCommitBlockingSecrets', () => {
  const message = (): string =>
    describeCommitBlockingSecrets('a/b.test.ts', findCommitBlockingSecrets('a/b.test.ts', `const v = '${awsShape()}';\n`, NO_EXEMPTIONS));

  it('says the file was excluded and left on disk, not that the commit failed', () => {
    // The D-001 contract the whole design rests on: quarantine the FILE, never
    // stall the tree's commit. An agent reading "commit failed" would retry.
    expect(message()).toMatch(/EXCLUDED from the commit and left on disk/);
    expect(message()).toMatch(/do not retry the write/i);
  });

  it('names the low-entropy-marker remedy BEFORE the exemption path', () => {
    // THE ordering assertion. Its predecessor (the publish-time refusal) named
    // only the exemption path — the heavier, riskier remedy — and that is how the
    // exemption surface grew. A credential stand-in in a test is a naming choice.
    const m = message();
    const markerAt = m.indexOf('NEVER_EMIT_MARKER');
    const exemptionAt = m.indexOf('secrets_exemptions');
    expect(markerAt).toBeGreaterThan(-1);
    expect(exemptionAt).toBeGreaterThan(-1);
    expect(markerAt).toBeLessThan(exemptionAt);
  });

  it('embeds the offending path in a ready-to-run exemption command', () => {
    expect(message()).toContain("path:'a/b.test.ts'");
  });

  it('does not echo the matched secret in the clear', () => {
    expect(message()).not.toContain(awsShape());
  });
});

describe('cachedExemptionLoader', () => {
  it('reads once across a burst of per-file scans within the TTL', async () => {
    const load = vi.fn(async (): Promise<ReadonlySet<string>> => new Set(['a/']));
    let now = 1_000;
    const cached = cachedExemptionLoader(load, () => now);
    await cached();
    now += EXEMPTION_CACHE_TTL_MS - 1;
    await cached();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('re-reads once the TTL has elapsed', async () => {
    const load = vi.fn(async (): Promise<ReadonlySet<string>> => new Set());
    let now = 1_000;
    const cached = cachedExemptionLoader(load, () => now);
    await cached();
    now += EXEMPTION_CACHE_TTL_MS + 1;
    await cached();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent callers onto a single read', async () => {
    const load = vi.fn(async (): Promise<ReadonlySet<string>> => new Set());
    const cached = cachedExemptionLoader(load, () => 1_000);
    await Promise.all([cached(), cached(), cached()]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('yields an EMPTY set instead of THROWING when the exemption read fails', async () => {
    // The failure-direction test, and the reason it is not a style choice: the
    // content guard FAILS OPEN — a detector that throws is skipped and the file
    // commits. For every other detector that is right (a miss costs a broken
    // build). Here a miss costs a permanent egress freeze that no edit can undo,
    // so a load failure must degrade to "scan everything" rather than escape as
    // an exception into the guard's fail-open path.
    const cached = cachedExemptionLoader(async () => {
      throw new Error('db down');
    });
    await expect(cached()).resolves.toEqual(new Set());
  });

  it('recovers on the next call after a failed read', async () => {
    let fail = true;
    const load = vi.fn(async (): Promise<ReadonlySet<string>> => {
      if (fail) throw new Error('db down');
      return new Set(['x/']);
    });
    let now = 1_000;
    const cached = cachedExemptionLoader(load, () => now);
    expect(await cached()).toEqual(new Set());
    fail = false;
    // A failed read caches nothing, so the very next call retries — it must not
    // be pinned to the empty set for a whole TTL.
    expect(await cached()).toEqual(new Set(['x/']));
  });
});

/**
 * The WIRING tests. The block above proves the detection LOGIC; these prove the
 * detector is actually reachable from the list git-sync consumes. That is the
 * half worth testing explicitly, because a correct detector nobody registered is
 * indistinguishable from no detector at all — and it is silent.
 */
describe('secretsDetector (registry wiring)', () => {
  afterEach(() => setContentLintExemptionLoader());

  it('is registered in the list the git-sync content guard runs', () => {
    expect(DEFAULT_CONTENT_DETECTORS).toContain(secretsDetector);
  });

  it('is ordered FIRST, ahead of every build-guarding detector', () => {
    // Not cosmetic: a file can trip several detectors, and the first offender is
    // the message that gets recorded and escalated. An unrecoverable egress
    // freeze must not be reported behind a smart-quote.
    expect(DEFAULT_CONTENT_DETECTORS[0]).toBe(secretsDetector);
  });

  it('scopes to the whole tracked tree, not a suffix set', () => {
    // The three historical instances were a .test.ts, a .mjs hook and a test
    // harness — no suffix filter would have caught all three.
    expect(secretsDetector.matches('libs/generic/x/harness.test.ts')).toBe(true);
    expect(secretsDetector.matches('apps/operator/scripts/hooks/cc/thing.mjs')).toBe(true);
    expect(secretsDetector.matches('docs/whatever.md')).toBe(true);
  });

  it('honours the shared exclusions (retired trees, vendored code, build output)', () => {
    expect(secretsDetector.matches('packages/x/node_modules/pkg/index.js')).toBe(false);
    expect(secretsDetector.matches('_retired/old.ts')).toBe(false);
    expect(secretsDetector.matches('packages/x/dist/bundle.js')).toBe(false);
  });

  it('still matches a TOP-LEVEL node_modules path — documented, and harmless here', () => {
    // `isExcludedPath` tests for '/node_modules/' WITH a leading slash, so a
    // repo-root `node_modules/...` path is not excluded. Recorded as a real
    // assertion rather than quietly avoided, because this detector is the first
    // in the registry scoped to `**/*` — every other one also carries a suffix or
    // prefix filter, so it is the first for which that quirk is load-bearing.
    //
    // Deliberately NOT "fixed" in the shared helper: nine other detectors consume
    // it, and the case is moot at the only seam that matters — the content guard
    // scans DIRTY files from `git status`, and node_modules is gitignored, so a
    // top-level vendored path never reaches this predicate in production.
    expect(secretsDetector.matches('node_modules/pkg/index.js')).toBe(true);
  });

  it('returns an actionable error through detect() when a credential shape is present', async () => {
    setContentLintExemptionLoader(async () => new Set());
    const error = await secretsDetector.detect('apps/operator/lib/thing.ts', `const id = '${awsShape()}';\n`);
    expect(error).toMatch(/credential-shaped content would enter git history/);
    expect(error).toMatch(/aws-access-key-id/);
  });

  it('returns null through detect() for clean text', async () => {
    setContentLintExemptionLoader(async () => new Set());
    expect(await secretsDetector.detect('a/b.ts', 'export const x = 1;\n')).toBeNull();
  });

  it('consults the RUNTIME exemption loader from detect()', async () => {
    // Proves the loader is actually threaded through the registry rather than
    // the detector quietly falling back to static exemptions only — which would
    // quarantine an exempted file from commit forever.
    setContentLintExemptionLoader(async () => new Set(['apps/operator/lib/']));
    expect(await secretsDetector.detect('apps/operator/lib/thing.ts', `const id = '${awsShape()}';\n`)).toBeNull();
  });

  it('declares NO autoFix — a credential-shaped repair is never applied unread', () => {
    expect(secretsDetector.autoFix).toBeUndefined();
  });
});

describe('time-sliced scan (WI-6554700010008327)', () => {
  // More shapes, assembled at runtime for the reason in this file's header.
  const slackShape = (): string => 'xo' + 'xb-' + '1234567890abcdef';
  const assignment = (): string => 'pass' + 'word = "' + 'Zx9Qw3Er' + '7Ty1Ui5Op2As"';

  const corpus = (): Array<[string, string]> => [
    ['empty', ''],
    ['clean', 'export const x = 1;\nexport const y = 2;\n'],
    ['first-middle-last-no-trailing-newline', `${awsShape()}\nclean\n${pemHeader()}\nclean\n${slackShape()}`],
    ['trailing-newline', `clean\n${assignment()}\n`],
    ['crlf', `clean\r\n${awsShape()}\r\nclean\r\n`],
    ['two-on-one-line', `a ${awsShape()} b ${slackShape()}\n`],
    ['overlong-line-skipped', `${'x'.repeat(5000)} ${awsShape()}\nnext ${awsShape()}\n`],
  ];

  it('the sliced scanner returns exactly the synchronous scanner’s findings, yielding mid-text', async () => {
    let positives = 0;
    for (const [name, text] of corpus()) {
      const path = `docs/${name}.md`;
      const expected = scanTextForSecrets(path, text);
      positives += expected.length;
      let yields = 0;
      const sliced = await scanTextForSecretsSliced(path, text, async () => { yields += 1; }, 2);
      expect(sliced, name).toEqual(expected);
      if (text.split('\n').length > 2) expect(yields, `${name} yields`).toBeGreaterThan(0);
    }
    // Positive control: without it, a broken fixture would make the comparison
    // above pass vacuously on empty arrays.
    expect(positives).toBe(8);
  });

  it('yields every SLICED_SCAN_LINES_PER_CHECK lines inside ONE large file and still finds a hit on its last line', async () => {
    const lineCount = 5000;
    const text = `${'const clean = 1;\n'.repeat(lineCount)}const id = '${awsShape()}';`;
    let yields = 0;
    const findings = await findCommitBlockingSecretsSliced('apps/operator/lib/big.ts', text, NO_EXEMPTIONS, async () => {
      yields += 1;
    });
    expect(findings.map((f) => [f.line, f.rule])).toEqual([[lineCount + 1, 'aws-access-key-id']]);
    expect(yields).toBe(Math.floor(lineCount / SLICED_SCAN_LINES_PER_CHECK));
  });

  it('keeps both exemption layers and does no scanning work for an exempt file', async () => {
    let yields = 0;
    const count = async (): Promise<void> => { yields += 1; };
    const big = `${'x\n'.repeat(2000)}${awsShape()}`;
    const fixture = 'packages/operator-core/lib/sync/pot-git/secrets-guard.test.ts';
    expect(await findCommitBlockingSecretsSliced(fixture, big, NO_EXEMPTIONS, count)).toEqual([]);
    expect(await findCommitBlockingSecretsSliced('libs/generic/fixtures/a.ts', big, new Set(['libs/generic/fixtures/']), count)).toEqual([]);
    expect(yields).toBe(0);
  });
});

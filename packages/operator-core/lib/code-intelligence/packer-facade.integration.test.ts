/**
 * P-016 end-to-end against the REAL pinned packers.
 *
 * The unit suite proves what we ASK the engines for: that the argv can never
 * carry `--no-security-check`, that the deny-set survives caller input, that a
 * flag-shaped pattern is refused. Necessary, and not sufficient — none of it
 * proves what the engines DO. This suite proves the three claims that are only
 * true of the real processes:
 *
 *   1. both vendored binaries report EXACTLY the pinned versions (the pin is
 *      real, not a constant we wrote down and never compared to anything);
 *   2. a real pack of a real git checkout carries a real commit, and `dirty`
 *      flips when the tree is actually dirtied — the field a consumer relies on
 *      before citing a pack as "the code at <sha>";
 *   3. a `.env` sitting in the packed directory does NOT appear in the output.
 *      That is the security claim of the whole leg, and it is the one thing a
 *      unit test genuinely cannot establish: it depends on the engine honouring
 *      the exclusion we passed, not merely on us having passed it.
 *
 * Skips (rather than fails) when a binary is unprovisioned, since provisioning
 * is environmental — but asserts the skip reason is a GENUINE absence, never a
 * present-but-wrong binary quietly satisfying the check.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CODE2PROMPT_PINNED_VERSION,
  nativeChangeReport,
  packerFacade,
  packerIdentity,
  REPOMIX_PINNED_VERSION,
  resolveCode2PromptBin,
  resolveRepomixBin,
} from './packer-facade.ts';
import { runPackerFacadeLeg } from './code-intel-bench.ts';

const repomixProvisioned = resolveRepomixBin() !== null;
const code2promptProvisioned = resolveCode2PromptBin() !== null;
const maybeRepomix = repomixProvisioned ? describe : describe.skip;
const maybePackers = repomixProvisioned && code2promptProvisioned ? describe : describe.skip;

let dir: string;

const git = (args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'packer-int-'));
  writeFileSync(join(dir, 'alpha.ts'), 'export const alpha = 1;\n');
  writeFileSync(join(dir, 'beta.ts'), 'export const beta = 2;\n');
  // The security fixture. A distinctive value so its presence in a pack is
  // unambiguous — a substring match on "SECRET" alone could hit a comment.
  writeFileSync(join(dir, '.env'), 'API_TOKEN=pcsk_live_do_not_pack_me_9f3a2b\n');
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'packer integration test']);
  git(['add', '-A']);
  git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture']);
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('native P010 diff report through the actual compiler worker', () => {
  it('finds the reference consumer of the edited symbol and refreshes after its source changes', async () => {
    writeFileSync(join(dir, 'alpha.ts'), 'export function changedTarget() { return 3; }\n');
    writeFileSync(join(dir, 'consumer.ts'), 'import { changedTarget } from "./alpha";\nexport const answer = changedTarget();\n');
    try {
      const args = { rootPath: dir, include: ['*.ts'], baseRef: 'HEAD' };
      const subject = { symbol: 'changedTarget', file: 'alpha.ts', paths: ['.'] };
      const first = await nativeChangeReport(args, subject);
      expect(first.answer.error).toBeNull();
      expect(first.report.consumers.map(site => `${site.path}:${site.line1}`)).toEqual(['consumer.ts:2']);
      expect(first.report.changed.map(file => file.path)).toContain('alpha.ts');
      expect(first.report.freshness).toBe('first-read');
      expect(first.report.provenance.dirty).toBe(true);
      writeFileSync(join(dir, 'consumer.ts'), 'export const answer = 3;\n');
      const next = await nativeChangeReport(args, { ...subject, previousFingerprint: first.report.sourceFingerprint });
      expect(next.report.consumers).toEqual([]);
      expect(next.report.freshness).toBe('changed');
      expect(next.report.limitations.some(line => line.includes('runtime execution'))).toBe(true);
    } finally {
      writeFileSync(join(dir, 'alpha.ts'), 'export const alpha = 1;\n');
      rmSync(join(dir, 'consumer.ts'), { force: true });
    }
  }, 120_000);
});

describe('the pins are REAL — the constants are compared to the binaries', () => {
  it.runIf(repomixProvisioned)('vendored repomix reports exactly the pinned version', async () => {
    const id = await packerIdentity('repomix');
    expect(id.ok, id.ok ? '' : id.reason).toBe(true);
    if (!id.ok) return;
    expect(id.identity.version).toBe(REPOMIX_PINNED_VERSION);
  });

  it.runIf(code2promptProvisioned)('vendored code2prompt reports exactly the pinned version', async () => {
    const id = await packerIdentity('code2prompt');
    expect(id.ok, id.ok ? '' : id.reason).toBe(true);
    if (!id.ok) return;
    expect(id.identity.version).toBe(CODE2PROMPT_PINNED_VERSION);
  });

  it('a skip here is a genuine absence, not a wrong binary answering', () => {
    // If the path resolves, the version check above is what judges it — this
    // asserts the two states are distinguishable rather than conflated.
    if (!repomixProvisioned) expect(resolveRepomixBin()).toBeNull();
    else expect(resolveRepomixBin()).toContain('vendor');
  });
});

maybeRepomix('a real pack carries real provenance', () => {
  it('stamps the actual HEAD commit and reports a clean tree as clean', async () => {
    const head = git(['rev-parse', 'HEAD']).trim();
    const r = await packerFacade('pack', { include: ['*.ts'], rootPath: dir, format: 'xml' });
    expect(r.answer.error).toBeNull();
    expect(r.artifact?.provenance.commit).toBe(head);
    expect(r.artifact?.provenance.dirty).toBe(false);
    expect(r.artifact?.provenance.engineVersion).toBe(REPOMIX_PINNED_VERSION);
    expect(r.artifact?.provenance.securityScan).toBe('secretlint+deny-set');
  }, 120_000);

  it('selected the packed files and says how many', async () => {
    const r = await packerFacade('pack', { include: ['*.ts'], rootPath: dir, format: 'xml' });
    const paths = r.answer.sites.map((s) => s.path);
    expect(paths).toContain('alpha.ts');
    expect(paths).toContain('beta.ts');
    // fileCount must agree with the selection rather than being computed twice.
    expect(r.artifact?.provenance.fileCount).toBe(paths.length);
  }, 120_000);

  it('reports dirty:true once the tree actually diverges from HEAD', async () => {
    // The field exists so a pack is never miscited as "the code at <sha>".
    // Proving it FLIPS is the only way to know it is measured, not hardcoded.
    writeFileSync(join(dir, 'alpha.ts'), 'export const alpha = 999; // dirtied\n');
    try {
      const r = await packerFacade('pack', { include: ['*.ts'], rootPath: dir, format: 'xml' });
      expect(r.artifact?.provenance.dirty).toBe(true);
      expect(r.answer.freshness.staleVsDisk).toBe(true);
    } finally {
      git(['checkout', '--', 'alpha.ts']);
    }
  }, 120_000);

  it('THE SECURITY CLAIM: a .env in the packed directory does not reach the pack', async () => {
    // Deliberately asks for EVERYTHING in the directory. The only thing keeping
    // the credential out is the non-overridable deny-set actually being honoured
    // by the real engine — which is exactly what a unit test cannot establish.
    const r = await packerFacade('pack', {
      include: ['**/*'],
      rootPath: dir,
      format: 'xml',
    });
    expect(r.answer.error).toBeNull();
    const packed = r.answer.sites.map((s) => s.path);
    expect(packed, '.env must never be selected').not.toContain('.env');

    // Read the FULL artifact, never `preview`. The preview is bounded to
    // ~resultTokensMax chars, so a secret sitting past that boundary would make
    // an absence assertion against it pass while the credential is very much in
    // the pack — a bounded measurement reported as a complete one.
    const path = r.artifact?.path;
    expect(path, 'the pack must have been written somewhere to be checkable').toBeTruthy();
    const full = readFileSync(path!, 'utf8');
    expect(full.length).toBeGreaterThan(0);
    expect(full, 'the credential must not appear anywhere in the pack').not.toContain(
      'pcsk_live_do_not_pack_me_9f3a2b',
    );
    // Positive control: the pack really did contain the directory's code, so
    // the absence above is a real exclusion and not an empty/failed pack.
    expect(full).toContain('alpha');
  }, 120_000);
});

maybePackers('Repomix + Code2Prompt acceptance bench leg', () => {
  it('invokes both maintained engines and grades their real artifacts', async () => {
    writeFileSync(join(dir, 'beta.ts'), 'export const beta = 222; // bench diff\n');
    try {
      const report = await runPackerFacadeLeg({ repoRoot: dir, include: ['*.ts'] });

      expect(report.measurements.map((measurement) => measurement.engine)).toEqual(['repomix', 'code2prompt']);
      expect(report.measurements.every((measurement) => measurement.result.artifact)).toBe(true);
      expect(report.measurements.every((measurement) => measurement.grade.correct)).toBe(true);
      expect(report.correct).toBe(true);
    } finally {
      git(['checkout', '--', 'beta.ts']);
    }
  }, 240_000);
});

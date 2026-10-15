/**
 * CLAUDE.md's two-port claim "`:3170` serves an isolated generation of the canonical
 * tree's LOCAL committed `staging` (`sync-staging-checkout.sh` resolves
 * `rev-parse staging`, not `origin/staging`)" must stay true of the script
 * (WI-6554700010008524; same family as `gate-candidate-ref.test.ts`).
 *
 * The prose used to say `:3170` was pinned to `origin/staging`, so agents waited for a
 * push that :3170 never needed. The fixture controls are load-bearing: once the live
 * assertion is green it stops being evidence that the detector can fail at all.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = join(ROOT, 'apps/operator/bin/release/sync-staging-checkout.sh');
const CLAUDE_MD = join(ROOT, 'CLAUDE.md');

interface Verdict {
  ok: boolean;
  targetSites: string[];
  violations: string[];
}

/** Drop shell comments (whole-line and trailing ` # …`) so prose cannot satisfy or trip the rule. */
function stripShellComments(source: string): string[] {
  return source
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line.replace(/\s+#\s.*$/, '')))
    .filter((line) => line.trim().length > 0);
}

/** Judge the script: its advance target must be the LOCAL integration branch, never a remote ref. */
function judgeStagingSyncTarget(source: string): Verdict {
  if (source.length < 2_000) {
    throw new Error(`Refusing to judge a ${source.length}-char read: a failed read must not look clean`);
  }
  const lines = stripShellComments(source);
  const targetSites = lines.filter((line) => /^\s*target=.*rev-parse/.test(line));
  const violations: string[] = [];
  if (targetSites.length === 0) {
    violations.push('no `target=… rev-parse …` site — the claim no longer holds as written; re-point this pin');
  }
  for (const site of targetSites) {
    if (!/git -C "\$INTEGRATION_ROOT"/.test(site)) violations.push(`target not resolved in INTEGRATION_ROOT: ${site.trim()}`);
    if (!/\$\{BRANCH\}/.test(site)) violations.push(`target is not the integration BRANCH: ${site.trim()}`);
    if (/origin\/|refs\/remotes\//.test(site)) violations.push(`target is a remote-tracking ref: ${site.trim()}`);
  }
  const fetches = lines.filter((line) => /\bgit\b.*\bfetch\b/.test(line));
  for (const site of fetches) violations.push(`script fetches before resolving: ${site.trim()}`);
  return { ok: violations.length === 0, targetSites, violations };
}

/** Pad a fixture past the min-length refusal so we test the RULE, not the guard. */
const pad = (body: string): string => `${body}\n${'# filler\n'.repeat(300)}`;

describe('CLAUDE.md :3170 staging-sync target claim', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('accepts the local integration-branch resolution', () => {
      const verdict = judgeStagingSyncTarget(
        pad('target="$(git -C "$INTEGRATION_ROOT" rev-parse --verify "${BRANCH}^{commit}")"'),
      );
      expect(verdict.ok).toBe(true);
      expect(verdict.targetSites).toHaveLength(1);
    });

    it('catches a target cut from origin/ — the belief the old prose taught', () => {
      const verdict = judgeStagingSyncTarget(
        pad('target="$(git -C "$INTEGRATION_ROOT" rev-parse --verify "origin/${BRANCH}^{commit}")"'),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/remote-tracking/);
    });

    it('catches a fetch ahead of the resolve', () => {
      const verdict = judgeStagingSyncTarget(
        pad('git -C "$INTEGRATION_ROOT" fetch origin\ntarget="$(git -C "$INTEGRATION_ROOT" rev-parse --verify "${BRANCH}^{commit}")"'),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/fetches/);
    });

    it('catches the target site disappearing entirely', () => {
      const verdict = judgeStagingSyncTarget(pad('unrelated=1'));
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/no longer holds/);
    });

    it('does NOT fire on origin/ or fetch mentioned only in comments', () => {
      const verdict = judgeStagingSyncTarget(
        pad(
          '# we used to git fetch origin and resolve origin/staging here\n' +
            'target="$(git -C "$INTEGRATION_ROOT" rev-parse --verify "${BRANCH}^{commit}")" # not origin/staging',
        ),
      );
      expect(verdict.ok).toBe(true);
    });

    it('REFUSES a short/empty read instead of reporting it clean', () => {
      expect(() => judgeStagingSyncTarget('')).toThrow(/Refusing to judge/);
    });
  });

  describe('the live claim', () => {
    it('sync-staging-checkout.sh advances :3170 to the LOCAL committed integration branch', () => {
      const verdict = judgeStagingSyncTarget(readFileSync(SCRIPT, 'utf8'));
      expect(verdict.violations).toEqual([]);
      expect(verdict.targetSites.length).toBeGreaterThan(0);
    });

    it('CLAUDE.md states the LOCAL-staging behaviour, not origin/staging', () => {
      const doc = readFileSync(CLAUDE_MD, 'utf8');
      expect(doc).toContain("canonical tree's LOCAL committed");
      expect(doc).toMatch(/resolves\s+`rev-parse staging`,\s+not\s+`origin\/staging`/);
    });
  });
});

/**
 * P-017 (c) — the "this value has a cell, read it" detector.
 *
 * The bulk of this suite is FALSE-POSITIVE tests, and that is deliberate. Per EI-10949
 * (work_items/complete.ts), a nudge that misfires on ordinary prose teaches agents to
 * skim the channel it shares with real warnings — so for a tier-3 detector, precision
 * is the correctness property and recall is secondary. A detector that catches every
 * transcription and cries wolf twice a day is WORSE than one that catches most and
 * never does.
 */

import { describe, it, expect } from 'vitest';
import {
  detectCellTranscriptions,
  cellTranscriptionHint,
  formatCellTranscriptionHint,
  suggestDependsOnCells,
  MAX_DEPENDS_ON_SUGGESTIONS,
  CONTEXT_WINDOW,
} from './cell-transcription-detector';
import { cellTranscriptionHintResolvingCommits, commitResolverRepo, gitResolvesToCommit } from './git-commit-resolver';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerBuiltinCells } from './cell-registrations';
import { getCellUnchecked, __resetCellRegistryForTests } from './cell-registry';
import { chunkHeaderText } from './agent-tools/coordination/tools/send-chunking';

describe('cell-transcription detector — TRUE positives (the 2026-07-26 shape)', () => {
  it('flags a sha stated as the deployed position', () => {
    const hits = detectCellTranscriptions(':3070 is serving abc1234 right now');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.value).toBe('abc1234');
    expect(hits[0]!.cell).toBe('git.pipelinePosition');
  });

  it('routes a sha stated as the gate candidate to the candidate cell', () => {
    const hits = detectCellTranscriptions('green-checkpoint is judging candidate 60bb6f3c33');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.cell).toBe('gate.greenCheckpoint.candidate');
    expect(hits[0]!.field).toBe('changeInCandidate.judgingSha');
    expect(hits[0]!.what).toContain('green-checkpoint candidate');
  });

  it('does not classify a gate candidate as the deployed pipeline position', () => {
    const hits = detectCellTranscriptions('gate candidate adf6129c');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.cell).toBe('gate.greenCheckpoint.candidate');
  });

  it('does not treat an active source/candidate citation without state language as a claim', () => {
    expect(detectCellTranscriptions('preserve the active adf6129c salvage')).toEqual([]);
  });

  it('flags a behind-count stated as current pipeline state', () => {
    const hits = detectCellTranscriptions('main is 3 commits behind staging');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h) => h.cell === 'git.pipelinePosition')).toBe(true);
  });

  it('flags the "behind by N" phrasing too', () => {
    expect(detectCellTranscriptions('origin/main is behind by 12 right now').length).toBeGreaterThanOrEqual(1);
  });

  it('reports the SAME sha claimed twice only once (dedupe, case-insensitive)', () => {
    const hits = detectCellTranscriptions('deployed ABC1234 … confirming deployed abc1234');
    expect(hits).toHaveLength(1);
  });

  it('finds several DISTINCT transcriptions in one body', () => {
    const hits = detectCellTranscriptions(
      'deployed sha is abc1234, staging is on def5678, and main is 4 commits behind',
    );
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });
});

describe('cell-transcription detector — FALSE positives it must NOT raise (EI-10949)', () => {
  const mustNotFire = [
    // A citation, not a state claim — the single most important negative.
    ['a historical commit citation', 'see commit abc1234 for the rationale behind this change'],
    ['a fix reference', 'this was fixed in abc1234, which predates the refactor'],
    // Hex-shaped things that are not shas.
    ['a hex colour', 'the token resolves to #a1b2c3d and the contrast still passes'],
    // THE ONE THAT ACTUALLY BIT: agent ids travel in coord messages beside words like
    // "live"/"running" constantly, and `\b` treats `-` as a boundary — so a naive sha
    // pattern matched the uuid's 8- and 12-char hex segments and would have fired on a
    // large share of real traffic. Both the prefixed and bare forms are pinned.
    ['a prefixed agent id', 'session su-8d9a671c-ccda-4aa9-b4f4-8f0d1c7a4804 is live'],
    ['a bare uuid (leading segment, no prefix)', '8d9a671c-ccda-4aa9-b4f4-8f0d1c7a4804 is running'],
    ['an id in a deploy sentence', 'agent su-2846407f-4f4c-4313-8db8-dce7592e269d deployed the change'],
    ['a hyphenated identifier', 'the branch deadbeef-fix is now on staging'],
    [
      'an explicit lock id in coordination prose',
      'please release the desktop-sidecar lock `cac76150`',
    ],
    ['an explicit lease token', 'the lease token cac76150 is live'],
    ['a lock-id prefix label', 'the lock-id prefix `cac76150` is live'],
    // A source checkout's HEAD is not the deployed pipeline position. The nearby
    // release/staging words belong to separate facts in the same report.
    ['a current source HEAD beside unrelated pipeline prose', 'current HEAD 2b95ba4eb7; release status remains red'],
    ['a source HEAD beside a staging note', 'source HEAD is 2b95ba4eb7, while staging source is ahead'],
    ['a historical root HEAD beside an origin divergence', 'Root HEAD cd9b060 was still ahead of direct origin/staging'],
    [
      'a future target-commit ancestry check beside pipeline words',
      'on next immutable checkpoint verdict, validate P-008 commit 13a4158ebd main/deployed ancestry',
    ],
    // Pure digits are numbers far more often than shas — the pattern requires an a-f.
    ['a 7-digit number', 'the sweep processed 1234567 rows in the window'],
    ['a row count', 'tool_invocations holds 5461000 rows over 30 days'],
    // Counts with no pipeline context.
    ['a generic count of commits in prose', 'I reviewed 3 commits worth of changes to the parser'],
    ['an unrelated number', 'the suite runs 155 tests in 12 seconds'],
    // Ordinary engineering prose.
    ['plain prose', 'refactored the resolver so the audience check is applied on the read path'],
    ['an empty string', ''],
  ] as const;

  for (const [label, text] of mustNotFire) {
    it(`does not fire on ${label}`, () => {
      expect(detectCellTranscriptions(text), `text: ${text}`).toEqual([]);
    });
  }

  it('does not fire when the state word is FAR from the value (outside the context window)', () => {
    const far = `abc1234 ${'x'.repeat(CONTEXT_WINDOW * 3)} deployed`;
    expect(detectCellTranscriptions(far)).toEqual([]);
  });

  it('DOES fire when that same pair is close together — proving the window is what separates them', () => {
    expect(detectCellTranscriptions('abc1234 was deployed').length).toBeGreaterThanOrEqual(1);
  });

  it('does not pair a work-item checkpoint hash with candidate context in the next sentence', async () => {
    const text =
      "Final canonical Next action heading corrected the initial replacement's oversized resume packet. " +
      'Latest8710 checkpoint f90d28e7d85e and bounded nextAction readback verified; ' +
      'use this instead of intermediate d90099a21e31. Candidate/rollout limits unchanged; ' +
      'no test or source work replayed.';

    // Isolate context matching from the git resolver. The recorded coord:send false hint
    // named d90099a21e31 as a gate candidate even though its candidate prose starts after
    // the sentence boundary; a same-sentence candidate remains a real transcription.
    const hint = await cellTranscriptionHintResolvingCommits(text, async () => true);
    expect(hint).toBeNull();
    const positive = await cellTranscriptionHintResolvingCommits(
      'green-checkpoint is judging candidate 9a4319b7',
      async () => true,
    );
    expect(positive).toContain('9a4319b7');
  });

  it('DOES fire when a source HEAD is explicitly described as deployed', () => {
    const hits = detectCellTranscriptions('current HEAD 2b95ba4eb7 is deployed to :3070');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.value).toBe('2b95ba4eb7');
  });

  it('DOES fire when a root HEAD is explicitly described as deployed', () => {
    const hits = detectCellTranscriptions('Root HEAD cd9b060 is deployed to :3070');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.value).toBe('cd9b060');
  });

  it('does not classify a worktree HEAD next to a staging mention as the deployed position', () => {
    const text = 'My current worktree remains on staging at HEAD 14f32c7e05.';
    expect(detectCellTranscriptions(text)).toEqual([]);
    expect(cellTranscriptionHint(text)).toBeNull();
  });

  it('does not classify a local test HEAD as deployed when the same sentence disclaims deployment', async () => {
    const text =
      "Live coord injection reports git-sync is still quarantined after 665 ticks: 7 files failed the content check and the content-fixer could not repair them, so human intervention is needed. " +
      'My focused suites pass locally at HEAD cb797c99b1; this does not establish commit or deployment. ' +
      "I could not identify from the alert whether any of the seven files are in this item's import graph.";
    let resolverCalls = 0;
    const hint = await cellTranscriptionHintResolvingCommits(text, async () => {
      resolverCalls += 1;
      return true;
    });

    expect(hint).toBeNull();
    expect(resolverCalls).toBe(0);
  });

  it('does not describe a staged SHA as deployed when the message explicitly says it is not deployed', async () => {
    const text =
      "FYI for live gate item WI-10006055: dev:pipeline_position for packages/operator-core/lib/carry-blind-window.ts reports target SHA 27733d8abafa1325b394c1c59edab6b39445b6c5 committed/on staging, not in main and not deployed; blockedOn=gate, gateVerdict=inconclusive, gateOwnership=held-live. " +
      'The ownership cell identifies you as the live holder. ' +
      "This is the deployment boundary for EI-25461817843124970's post-promotion verification; I will leave LIVE_GATE_OPS with you.";
    let resolverCalls = 0;
    const hint = await cellTranscriptionHintResolvingCommits(text, async () => {
      resolverCalls += 1;
      return true;
    });

    expect(hint).toBeNull();
    expect(resolverCalls).toBe(0);
  });

  it('still flags a locally tested HEAD when it is explicitly described as deployed', () => {
    const hits = detectCellTranscriptions('focused suites pass locally at HEAD cb797c99b1 is deployed to :3070');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.value).toBe('cb797c99b1');
  });

  it('DOES fire when a target commit is explicitly described as deployed', () => {
    const hits = detectCellTranscriptions('validate target commit abc1234 is deployed to :3070');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.value).toBe('abc1234');
  });

  it('still detects a release commit when it is not labeled as a lock or lease id', () => {
    const hits = detectCellTranscriptions('release commit cac76150 is live on :3070');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.value).toBe('cac76150');
  });

  it('does not classify a commit explicitly described as committed locally/on staging as deployed', () => {
    const text =
      'coord:send said commit e67fcd6c5 was committed locally/on staging and explicitly said the gate was deliberately paused';
    expect(detectCellTranscriptions(text)).toEqual([]);
    expect(cellTranscriptionHint(text)).toBeNull();
  });

  it('does not classify a work-item checkpoint contentHash as a deployed SHA', () => {
    const text = 'The implementation-start checkpoint is written (contentHash 562d3b6d9979)';
    expect(detectCellTranscriptions(text)).toEqual([]);
    expect(cellTranscriptionHint(text)).toBeNull();
  });

  it.each(['barHash', 'priorBarHash', 'nextBarHash', 'sha256', 'fingerprint', 'fingerprint digest'])(
    'does not classify a labeled %s artifact digest as a deployed SHA beside release context',
    (label) => {
      const text = `The release acceptance rubric ${label} 2e12616a568397f3`;
      const collidingCommit = () => true;
      expect(detectCellTranscriptions(text, { resolvesToCommit: collidingCommit })).toEqual([]);
      expect(cellTranscriptionHint(text, { resolvesToCommit: collidingCommit })).toBeNull();
    },
  );

  it('does not classify a checkpoint fingerprint as a deployed SHA beside unrelated release context', async () => {
    const text = 'Checkpoint fingerprint digest fa14e401 is persisted; release status remains unchanged';
    expect(detectCellTranscriptions(text, { resolvesToCommit: () => true })).toEqual([]);
    expect(cellTranscriptionHint(text)).toBeNull();

    const requested: string[] = [];
    const hint = await cellTranscriptionHintResolvingCommits(text, async (token) => {
      requested.push(token);
      return true;
    });
    expect(requested).toEqual([]);
    expect(hint).toBeNull();
  });

  it('does not classify a labeled memory ID prefix as a deployed SHA even if it resolves to a commit', () => {
    const text =
      'memory 0035cbc4: specAdequacy { classRef, evidenceRefs } must list the live binding evidence_ref strings';
    const collidingCommit = () => true;
    expect(detectCellTranscriptions(text, { resolvesToCommit: collidingCommit })).toEqual([]);
    expect(cellTranscriptionHint(text, { resolvesToCommit: collidingCommit })).toBeNull();
  });

  it('still detects a deployed commit when memory is not the value label', () => {
    const text = 'the memory service commit 8badf00d is live on :3070';
    const hits = detectCellTranscriptions(text, { resolvesToCommit: () => true });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.value).toBe('8badf00d');
  });

  it('does not classify an explicitly labeled Git blob hash as a deployed SHA', () => {
    const text = 'InboxPane staging blob 6183d5ee';
    expect(detectCellTranscriptions(text)).toEqual([]);
    expect(cellTranscriptionHint(text)).toBeNull();
  });

  it('does not classify a checkpoint hash from a coord summary with unrelated live-lock context', () => {
    const summary = 'WI-40905 checkpoint 721014582be1: waiting on two live Vite locks before final rebuild';
    const body =
      'Checkpoint 721014582be1 records the rejected torn artifact, root 81a24825be after git-sync, ' +
      'and the two remaining production paths live-locked by su-e9b139d9.';
    const text = `${summary}\n${body}`;
    const hits = detectCellTranscriptions(text);

    expect(hits.some((hit) => hit.value === '721014582be1')).toBe(false);
    expect(cellTranscriptionHint(text)).not.toContain('721014582be1');
  });
});

describe('EI-25431705270466357 — fractional byte amounts are not commit SHAs', () => {
  for (const amount of ['40,279,831,019.520004B', '14,991,024,619.520004B', '0.1234567B']) {
    for (const context of ['No live reclaim occurred.', 'The green-checkpoint candidate needs space.']) {
      it(`does not classify fractional byte amount ${amount} beside ${context}`, () => {
        const text = `reserve${amount}; ${context}`;
        expect(detectCellTranscriptions(text)).toEqual([]);
        // Even a colliding commit cannot change the amount's numeric meaning.
        expect(detectCellTranscriptions(text, { resolvesToCommit: () => true })).toEqual([]);
        expect(cellTranscriptionHint(text)).toBeNull();
        expect(suggestDependsOnCells(text)).toEqual([]);
      });
    }
  }

  it('retains a standalone deployed SHA beside a fractional byte amount', () => {
    const text = 'reserve40,279,831,019.520004B; release is serving abc1234';
    expect(detectCellTranscriptions(text).map((hit) => hit.value)).toEqual(['abc1234']);
    expect(detectCellTranscriptions('release is serving 520004B').map((hit) => hit.value)).toEqual(['520004B']);
  });

  it('does not resolve a fractional byte suffix even when the resolver would accept it', async () => {
    const asked: string[] = [];
    const hint = await cellTranscriptionHintResolvingCommits(
      'reserve40,279,831,019.520004B; release is serving abc1234',
      async (token) => {
        asked.push(token);
        return true;
      },
    );
    expect(asked).toEqual(['abc1234']);
    expect(hint).toContain('abc1234');
    expect(hint).not.toContain('520004B');
  });
});

describe('EI-24684014950807803 — a hex token that names no commit is not a sha', () => {
  it('does not suggest a Git dependency for a coord message prefix that resolves to no commit', () => {
    const body = 'Live intake: ask c308 a853236d for existing-builder acceptance.';
    expect(suggestDependsOnCells(body)).toEqual([
      expect.objectContaining({ cell: 'git.pipelinePosition', value: 'a853236d' }),
    ]);
    expect(suggestDependsOnCells(body, [], { resolvesToCommit: () => false })).toEqual([]);
  });

  // The measured message: a peer named by its agent short id beside a real candidate sha.
  const text =
    'c0b38c83 is live on staging and owns the repair; candidate 9a4319b7 is what green-checkpoint is judging';
  const realShas = new Set(['9a4319b7']);
  const resolvesToCommit = (token: string) => realShas.has(token.toLowerCase());

  it('POSITIVE CONTROL: without a resolver the shape-only scan still flags the agent short id', () => {
    expect(detectCellTranscriptions(text).map((h) => h.value)).toContain('c0b38c83');
  });

  it('drops an agent short id that does not resolve, and keeps the real candidate sha', () => {
    const hits = detectCellTranscriptions(text, { resolvesToCommit });
    expect(hits.map((h) => h.value)).not.toContain('c0b38c83');
    expect(hits.some((h) => h.value === '9a4319b7' && h.cell === 'gate.greenCheckpoint.candidate')).toBe(true);
    expect(cellTranscriptionHint(text, { resolvesToCommit })).not.toContain('c0b38c83');
  });

  it('keeps the hit when the resolver cannot tell (null) or throws — fail-open', () => {
    expect(detectCellTranscriptions(':3070 is serving abc1234', { resolvesToCommit: () => null })).toHaveLength(1);
    const throwing = () => {
      throw new Error('git unavailable');
    };
    expect(detectCellTranscriptions(':3070 is serving abc1234', { resolvesToCommit: throwing })).toHaveLength(1);
  });

  it('never applies the resolver to commit COUNTS, which are not shas', () => {
    const hits = detectCellTranscriptions('main is 3 commits behind staging', { resolvesToCommit: () => false });
    expect(hits).toHaveLength(1);
  });

  it('the async two-pass hint resolves only sha-claimed tokens and applies the verdicts', async () => {
    const asked: string[] = [];
    const hint = await cellTranscriptionHintResolvingCommits(text, async (token) => {
      asked.push(token);
      return realShas.has(token);
    });
    expect(asked.sort()).toEqual(['9a4319b7', 'c0b38c83']);
    expect(hint).toContain('9a4319b7');
    expect(hint).not.toContain('c0b38c83');
  });

  it('the async hint fails open: a rejecting resolver keeps every shape-only hit', async () => {
    const hint = await cellTranscriptionHintResolvingCommits(text, async () => {
      throw new Error('git unavailable');
    });
    expect(hint).toContain('c0b38c83');
    expect(hint).toContain('9a4319b7');
  });

  it('the async hint spawns nothing for text with no sha-shaped claim', async () => {
    let calls = 0;
    const hint = await cellTranscriptionHintResolvingCommits('main is 3 commits behind staging', async () => {
      calls += 1;
      return false;
    });
    expect(calls).toBe(0);
    expect(hint).not.toBeNull();
  });

  it('the async hint does not resolve an explicitly labeled memory ID as a commit', async () => {
    const text =
      'memory 0035cbc4: specAdequacy { classRef, evidenceRefs } must list the live binding evidence_ref strings';
    const asked: string[] = [];
    const hint = await cellTranscriptionHintResolvingCommits(text, async (token) => {
      asked.push(token);
      return true;
    });

    expect(asked).toEqual([]);
    expect(hint).toBeNull();
  });

  it('does not treat generated coord:send chunk headers as authored commit references', async () => {
    const groupId = 'abaddeed';
    const realSha = '8badf00d';
    const text = `${chunkHeaderText(1, 2, groupId, true)}\n:3070 is serving ${realSha}`;
    const asked: string[] = [];
    const hint = await cellTranscriptionHintResolvingCommits(text, async (token) => {
      asked.push(token);
      return true; // Model a short-id collision with a real commit.
    });

    expect(asked).toEqual([realSha]);
    expect(hint).toContain(realSha);
    expect(hint).not.toContain(groupId);
  });

  it('resolves against PAPERCUSP_INTEGRATION_ROOT, not the release checkout cwd', () => {
    expect(commitResolverRepo({ PAPERCUSP_INTEGRATION_ROOT: '/srv/integration' }, '/srv/release/apps/operator')).toBe(
      '/srv/integration',
    );
    expect(commitResolverRepo({}, '/srv/repo')).toBe('/srv/repo');
  });

  it('the git resolver answers true for a real commit, false for an agent short id, null outside a repo', async () => {
    // Bound the object population: the shared checkout's short-ID lookup can
    // legitimately hit the resolver's deadline or collide with a real object.
    const fixture = mkdtempSync(join(tmpdir(), 'commit-resolver-'));
    const repo = join(fixture, 'repo');
    const outside = join(fixture, 'outside');
    mkdirSync(repo);
    mkdirSync(outside);
    const git = (args: string[]) => execFileSync('git', args, {
      cwd: repo, encoding: 'utf8', timeout: 10_000,
    }).trim();
    try {
      git(['init', '--quiet']);
      git(['-c', 'user.name=Resolver Test', '-c', 'user.email=resolver@example.invalid',
        '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
        'commit', '--quiet', '--allow-empty', '-m', 'resolver fixture']);
      const head = git(['rev-parse', '--short=8', 'HEAD']);
      const absent = head.startsWith('c0b38c83') ? 'd0b38c83' : 'c0b38c83';
      expect(await gitResolvesToCommit(head, repo)).toBe(true);
      expect(await gitResolvesToCommit(absent, repo)).toBe(false);
      expect(await gitResolvesToCommit('not-hex', repo)).toBe(false);
      expect(await gitResolvesToCommit('abc1234', outside)).toBeNull();
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe('cell-transcription detector — never throws, never blocks (tier-3 invariant)', () => {
  const junk: unknown[] = [null, undefined, 42, {}, [], true, Symbol('x'), () => {}, NaN];

  for (const v of junk) {
    it(`returns [] for ${String(typeof v)} input rather than throwing`, () => {
      expect(() => detectCellTranscriptions(v)).not.toThrow();
      expect(detectCellTranscriptions(v)).toEqual([]);
    });
  }

  it('bounds the scan on a very large body without hanging', () => {
    const huge = `${'deployed abc1234 '.repeat(5000)}`;
    const t0 = Date.now();
    const hits = detectCellTranscriptions(huge);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('is ORDER-INDEPENDENT — repeated calls give identical results (no shared regex lastIndex)', () => {
    const text = 'deployed abc1234 and main is 3 commits behind';
    const a = detectCellTranscriptions(text);
    const b = detectCellTranscriptions(text);
    const c = detectCellTranscriptions(text);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
});

describe('the advisory text', () => {
  it('is null when there is nothing to say — callers must not attach an empty hint', () => {
    expect(formatCellTranscriptionHint([])).toBeNull();
    expect(cellTranscriptionHint('nothing of interest here')).toBeNull();
  });

  it('names the CELL, not just the offending value — a hint with no next call is useless', () => {
    const hint = cellTranscriptionHint(':3070 is serving abc1234')!;
    expect(hint).toContain('git.pipelinePosition');
    expect(hint).toContain('abc1234');
  });

  it('says plainly that nothing was blocked — it is a DETECTOR, not a gate', () => {
    const hint = cellTranscriptionHint(':3070 is serving abc1234')!;
    expect(hint).toMatch(/nothing was blocked|advisory/i);
  });

  it('caps the enumerated list and reports the remainder rather than dumping everything', () => {
    const hint = cellTranscriptionHint(
      'deployed abc1234, def5678, 9abcdef, feedbee, cafebabe are all live releases',
    )!;
    expect(hint).toMatch(/and \d+ more/);
  });
});

/**
 * P-007 — dependsOn SUGGESTIONS.
 *
 * Same precision-over-recall contract as the detector above, for the same EI-10949
 * reason, one notch sharper: these suggestions share a response with facts:assert's
 * genuinely load-bearing disclosures (truncation, unresolved dependencies, eviction,
 * the P-006 normalization receipt). A chatty suggestion here does not just annoy —
 * it devalues those. So the guards below are the subject under test, and a
 * suggestion that fires when it should not is a FAILURE, not a nuisance.
 */
describe('P-007 dependsOn suggestions — precision guards', () => {
  // The shared positive control. Every "does not suggest" test below is only
  // meaningful if this one still fires — otherwise a broken matcher would make the
  // whole block pass by suggesting nothing, ever.
  const TRANSCRIBING_BODY = 'main is 3 commits behind staging right now';

  it('POSITIVE CONTROL: suggests the cell whose value the body transcribes', () => {
    const out = suggestDependsOnCells(TRANSCRIBING_BODY);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].cell).toBe('git.pipelinePosition');
    // The evidence travels with the suggestion — that is what makes it checkable
    // against the text the caller just typed rather than taken on faith.
    expect(TRANSCRIBING_BODY).toContain(out[0].value);
    expect(out[0].what).toBeTruthy();
  });

  it('does NOT suggest a cell the caller ALREADY declared', () => {
    // Guard 2. Restating the caller's own input back to them as advice is the purest
    // form of the trust-tax EI-10949 describes.
    expect(suggestDependsOnCells(TRANSCRIBING_BODY, ['git.pipelinePosition'])).toEqual([]);
  });

  it('matches an already-declared cell despite case and surrounding whitespace', () => {
    // The declared list is caller-typed, so it arrives however they typed it. Missing a
    // match here re-suggests something they already declared, which is guard 2 failing
    // in the direction that is invisible until an agent complains about the noise.
    expect(suggestDependsOnCells(TRANSCRIBING_BODY, ['  GIT.PipelinePosition  '])).toEqual([]);
  });

  it('collapses repeated mentions of one cell into a SINGLE suggestion', () => {
    // Guard 3. The detector dedupes by cell+VALUE because it reports transcriptions;
    // a dependency is per-CELL, so three positions are still one dependency.
    const out = suggestDependsOnCells(
      'main is 3 commits behind staging, and staging is 12 commits behind, ' +
        'and we are behind by 40 commits overall',
    );
    expect(out.filter((s) => s.cell === 'git.pipelinePosition')).toHaveLength(1);
  });

  it('never returns more than the cap', () => {
    const out = suggestDependsOnCells(
      'deployed abc1234 is live and main is 3 commits behind staging and ' +
        'the release serving def5678 is running',
    );
    expect(out.length).toBeLessThanOrEqual(MAX_DEPENDS_ON_SUGGESTIONS);
  });

  it('does NOT suggest for a CITATION rather than a live-state claim', () => {
    // This is the guard that carries the most weight and the one most likely to rot:
    // it inherits the detector's context-window requirement. If the matcher were ever
    // loosened to fire on a bare value, this is the test that catches it — the
    // positive control above proves the [] here is a real refusal, not a dead matcher.
    expect(suggestDependsOnCells('the number 3 appears in the changelog')).toEqual([]);
  });

  it('does NOT suggest a plan content hash as a Git pipeline dependency', () => {
    // plans:get contentHash values are hex-shaped, but "plan v143/hash ... governs"
    // is plan metadata, not a deployment or serving-state claim. Keep this exact
    // acceptance-carry shape quiet so a stale plan fingerprint cannot arm
    // git.pipelinePosition invalidation.
    const body =
      'The body said plan v143/hash 65e44ddf6efb governs; that value is plans:get.contentHash, ' +
      'not a Git SHA, and the sentence says it governs the plan rather than deployment.';
    expect(detectCellTranscriptions(body)).toEqual([]);
    expect(suggestDependsOnCells(body)).toEqual([]);
  });

  it('is fail-soft on anything unparseable', () => {
    // An advisory that can throw turns facts:assert into an outage — the one failure
    // mode a tier-3 mechanism must not have.
    for (const bad of [null, undefined, 42, {}, [], '']) {
      expect(suggestDependsOnCells(bad as unknown)).toEqual([]);
    }
    expect(suggestDependsOnCells(TRANSCRIBING_BODY, undefined)).not.toEqual([]);
  });

  it('tolerates a malformed declared-cells list without dropping real suggestions', () => {
    // declaredCells is caller input reaching a pure helper; a null inside it must not
    // take out the suggestion path (and must not silently suppress every suggestion,
    // which would be a failure that looks exactly like "nothing to suggest").
    const out = suggestDependsOnCells(TRANSCRIBING_BODY, [
      null as unknown as string,
      '',
      '   ',
    ]);
    expect(out.length).toBeGreaterThan(0);
  });
});

/**
 * THE ANTI-DRIFT GUARD. The pattern table names cells by string; nothing in the type
 * system ties those to the registry. A cell that is renamed (or a pattern written
 * against a cell P-007 has not shipped yet) would leave the detector silently matching
 * nothing — the exact failure mode this plan keeps cataloguing.
 */
describe('every cell named by the pattern table is actually REGISTERED', () => {
  it('resolves each pattern cell through the registry', () => {
    __resetCellRegistryForTests();
    registerBuiltinCells();

    const named = new Set(
      detectCellTranscriptions(
        'deployed abc1234 and main is 3 commits behind staging',
      ).map((h) => h.cell),
    );
    expect(named.size).toBeGreaterThan(0);

    for (const cell of named) {
      expect(getCellUnchecked(cell), `pattern references unregistered cell "${cell}"`).toBeDefined();
    }
  });
});

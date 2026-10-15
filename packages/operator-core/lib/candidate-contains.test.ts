import { describe, it, expect } from 'vitest';
import {
  blobAtCommit,
  blobInWorkingTree,
  callerEditsInCandidate,
  classifyPathsAgainstCandidate,
  committedBlobAtHead,
  excludedCommitsTouchingPath,
  gitReadFromExecSync,
  markerAtCommit,
  testImplSplitRisk,
  uncommittedPaths,
  type GitRead,
  type PathContainment,
} from './candidate-contains';

/**
 * P-004 (EI-18752644493166307). These assert the BEHAVIOURS the incident turned on,
 * not the shape of the object.
 *
 * The incident: two gate runs judged candidates that did not contain the caller's fix.
 * The suite reds on the PRE-FIX failure with the PRE-FIX count, which reads as "your fix
 * did not work" rather than "your fix was not present" — so the natural next move is to
 * re-debug correct code. Every case below encodes one way that misread can be produced.
 */

/**
 * A fake git keyed by arg shape. `null` means the command FAILED; `''` means it
 * succeeded with no output — the distinction the whole module rests on, so the fake
 * has to model it faithfully or the tests below prove nothing.
 */
function fakeGit(opts: {
  /** `${sha}:${path}` → blob sha at that commit. Absent key ⇒ git exits non-zero. */
  blobs?: Record<string, string>;
  /** path → working-tree blob sha. Absent ⇒ the file cannot be read. */
  tree?: Record<string, string>;
  log?: string;
  diff?: string;
  lsFiles?: string;
  /**
   * `${sha}:${path}` → the file's CONTENT at that commit (what `git show` prints).
   * Absent key ⇒ `ls-tree` reports the path is not in that tree (''), the clean-miss
   * signal — NOT a failure. `showFails` models the anomalous case separately.
   */
  contents?: Record<string, string>;
  /** `${sha}:${path}` keys whose `ls-tree` says present but whose `git show` FAILS. */
  showFails?: string[];
  /** Simulate a total git failure (bad repo, missing binary). */
  allFail?: boolean;
  /** Does `<sha>^{commit}` resolve? Default true — a bogus candidate sets it false. */
  resolvesCommit?: boolean;
  /**
   * `${ref}:${path}` → the newest commit sha touching `path` in `ref` (the
   * `log -1 --pretty=%H <ref> -- <path>` shape `refineUnattributedUncommitted` reads).
   * Absent key ⇒ '' (a measured "no commit touches this path"), matching every other
   * unset-option default in this fake — NOT a failure.
   */
  newestCommit?: Record<string, string>;
  /**
   * `${ref}..${sha}` → is `sha` an ancestor-or-equal of `ref`? Answered through
   * `merge-base <sha> <ref>` (git-ref-contains.ts), which prints `sha` itself when it is.
   * Absent key ⇒ `null` (a FAILED read, the safe default so a test that does not care
   * about ancestry never accidentally triggers the refinement).
   */
  ancestry?: Record<string, boolean>;
}): GitRead {
  return async (args) => {
    if (opts.allFail) return null;
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      // The candidate-commit existence probe, distinct from a `<sha>:<path>` blob read.
      if (args[2].endsWith('^{commit}')) return opts.resolvesCommit === false ? null : 'c'.repeat(40);
      return opts.blobs?.[args[2]] ?? null;
    }
    if (args[0] === 'hash-object') {
      return opts.tree?.[args[2]] ?? null;
    }
    if (args[0] === 'ls-files') return opts.lsFiles ?? '';
    // `log -1 --pretty=%H <ref> -- <path>` (newestCommitTouching) is a DISTINCT shape
    // from `log --oneline --no-decorate <range> -- <path>` (excludedCommitsTouchingPath)
    // — route on `args[1]` so both can be modelled independently in the same fake.
    if (args[0] === 'log' && args[1] === '-1') {
      const key = `${args[3]}:${args[5]}`;
      return opts.newestCommit?.[key] ?? '';
    }
    if (args[0] === 'log') return opts.log ?? '';
    if (args[0] === 'merge-base' && args.length === 3) {
      const contained = opts.ancestry?.[`${args[2]}..${args[1]}`];
      if (contained === undefined) return null;
      return contained ? args[1] : '0'.repeat(40);
    }
    if (args[0] === 'diff') return opts.diff ?? '';
    // `git ls-tree <sha> -- <path>`: an entry line when present, EXIT 0 WITH NO OUTPUT
    // when the tree simply has no such path. That '' is the clean-miss signal
    // markerAtCommit relies on to call a definitive absence without risking a
    // failure-reads-as-absence error, so the fake must reproduce it exactly.
    if (args[0] === 'ls-tree') {
      const key = `${args[1]}:${args[3]}`;
      const present = opts.contents?.[key] !== undefined || opts.showFails?.includes(key);
      return present ? `100644 blob ${'e'.repeat(40)}\t${args[3]}` : '';
    }
    if (args[0] === 'show') {
      const key = args[1];
      if (opts.showFails?.includes(key)) return null;
      return opts.contents?.[key] ?? null;
    }
    return null;
  };
}

describe('blob reads distinguish "absent" from "unreadable"', () => {
  it('blobAtCommit returns the blob sha, and null when the path is absent at that commit', async () => {
    const git = fakeGit({ blobs: { 'cand1:a.ts': 'b'.repeat(40) } });
    expect(await blobAtCommit(git, 'cand1', 'a.ts')).toBe('b'.repeat(40));
    expect(await blobAtCommit(git, 'cand1', 'new.ts')).toBeNull();
  });

  it('rejects non-sha output rather than treating it as a blob id', async () => {
    // A git that prints a warning/usage line on stdout must not be read as an answer.
    const git = fakeGit({ blobs: { 'cand1:a.ts': 'fatal: not a valid object name' } });
    expect(await blobAtCommit(git, 'cand1', 'a.ts')).toBeNull();
  });

  it('blobInWorkingTree reads an UNTRACKED file — the case `git diff <commit>` cannot see', async () => {
    const git = fakeGit({ tree: { 'brand-new.test.ts': 'c'.repeat(40) } });
    expect(await blobInWorkingTree(git, 'brand-new.test.ts')).toBe('c'.repeat(40));
  });
});

/**
 * EI-18797292094433710. The incident these encode: a candidate DID carry the caller's
 * fix, but a peer had appended an unrelated block to the same file, so blob identity
 * said "does not contain" and the tool advised a re-fire — twice, each restarting a
 * ~55min clock during a 3h+ fleet-wide outage. Blob identity answers "is the file
 * identical"; the caller is asking "is MY change in there". These are the cases where
 * those two answers come apart.
 */
describe('markerAtCommit — "is MY change in the judged commit", not "is the file identical"', () => {
  const FIX = "superseded_at IS NULL";

  it('finds the caller change in a candidate a PEER has since edited — the incident itself', async () => {
    // The candidate carries the fix 7×; the working tree now has 8 because a peer added
    // an unrelated occurrence. Blob identity calls this "missing"; the marker does not.
    const git = fakeGit({ contents: { 'cand:store.ts': `x ${FIX} y ${FIX} z` } });
    const r = await markerAtCommit(git, 'cand', 'store.ts', FIX);
    expect(r.present).toBe(true);
    expect(r.count).toBe(2);
  });

  it('a genuine miss is a DEFINITIVE false, so a real re-fire is still advised', async () => {
    const git = fakeGit({ contents: { 'cand:store.ts': 'nothing relevant here' } });
    const r = await markerAtCommit(git, 'cand', 'store.ts', FIX);
    expect(r.present).toBe(false);
    expect(r.count).toBe(0);
    expect(r.unknownReason).toBeNull();
  });

  it('a path ABSENT from that commit is a definitive miss, distinguished by pathPresent', async () => {
    const git = fakeGit({ contents: { 'cand:other.ts': FIX } });
    const r = await markerAtCommit(git, 'cand', 'store.ts', FIX);
    expect(r.present).toBe(false);
    expect(r.pathPresent).toBe(false);
    expect(r.unknownReason).toBeNull();
  });

  /**
   * The load-bearing case. Every other verdict here is only trustworthy because a broken
   * read cannot reach `present:false` — a false negative would send an agent to re-fire a
   * gate that already carries its change, which is the exact behaviour being fixed.
   */
  it('a FAILED read is null, never a confident absence', async () => {
    expect((await markerAtCommit(fakeGit({ allFail: true }), 'cand', 'store.ts', FIX)).present).toBeNull();

    const bogus = fakeGit({ resolvesCommit: false, contents: { 'cand:store.ts': FIX } });
    const r = await markerAtCommit(bogus, 'cand', 'store.ts', FIX);
    expect(r.present).toBeNull();
    expect(r.unknownReason?.code).toBe('resolver-failed');

    // ls-tree says the path IS there but the read fails: an anomaly, not an absence.
    const anomalous = fakeGit({ showFails: ['cand:store.ts'] });
    expect((await markerAtCommit(anomalous, 'cand', 'store.ts', FIX)).present).toBeNull();
  });

  it('treats the marker as a LITERAL, so regex metacharacters in real code cannot misfire', async () => {
    const git = fakeGit({ contents: { 'cand:a.ts': 'if (x?.y) return [1];' } });
    expect((await markerAtCommit(git, 'cand', 'a.ts', 'x?.y')).present).toBe(true);
    // As a regex `.` would match any char and this would wrongly hit.
    expect((await markerAtCommit(git, 'cand', 'a.ts', 'x?Zy')).present).toBe(false);
  });

  it('an empty marker is "not measured" rather than a match against everything', async () => {
    const git = fakeGit({ contents: { 'cand:a.ts': 'anything' } });
    const r = await markerAtCommit(git, 'cand', 'a.ts', '');
    expect(r.present).toBeNull();
    expect(r.unknownReason?.code).toBe('not-applicable');
  });
});

describe('classifyPathsAgainstCandidate', () => {
  const SAME = 'a'.repeat(40);
  const OTHER = 'd'.repeat(40);

  it('identical blobs ⇒ the candidate carries exactly what you have', async () => {
    const git = fakeGit({ blobs: { 'cand:a.ts': SAME }, tree: { 'a.ts': SAME } });
    const [r] = await classifyPathsAgainstCandidate(git, 'cand', ['a.ts']);
    expect(r.inCandidate).toBe(true);
    expect(r.reason).toBeNull();
  });

  it('MISFIRE 1 — an uncommitted edit is missing, and the lever named is "commit it"', async () => {
    // The working tree differs from HEAD ⇒ the edit never left the tree, which is the
    // one thing the caller can act on.
    const git = fakeGit({
      blobs: { 'cand:a.ts': SAME, 'HEAD:a.ts': SAME },
      tree: { 'a.ts': OTHER },
    });
    const [r] = await classifyPathsAgainstCandidate(git, 'cand', ['a.ts']);
    expect(r.inCandidate).toBe(false);
    expect(r.reason).toBe('uncommitted');
  });

  it('MISFIRE 2 — committed, but the quiet-cut candidate predates it ⇒ newer-commit, not uncommitted', async () => {
    // HEAD matches the tree (so it IS committed); the candidate simply lags. Naming this
    // 'uncommitted' would send the caller to git-sync:run, which would not help.
    const git = fakeGit({
      blobs: { 'cand:a.ts': SAME, 'HEAD:a.ts': OTHER },
      tree: { 'a.ts': OTHER },
    });
    const [r] = await classifyPathsAgainstCandidate(git, 'cand', ['a.ts']);
    expect(r.inCandidate).toBe(false);
    expect(r.reason).toBe('newer-commit');
  });

  it('a NEW file absent from the candidate is missing, not silently fine', async () => {
    // HEAD lacks it too, so this one really is uncommitted — and naming that is strictly
    // more useful than `absent`, which names no lever. See MISFIRE 3 for why the two
    // cases must be told apart rather than both reported as "not committed".
    const git = fakeGit({ tree: { 'new.test.ts': OTHER } });
    const [r] = await classifyPathsAgainstCandidate(git, 'cand', ['new.test.ts']);
    expect(r.inCandidate).toBe(false);
    expect(r.reason).toBe('uncommitted');
  });

  /**
   * MISFIRE 3 — the live misread that motivated this case. A file NEW since the candidate
   * is absent there by definition, and the classifier concluded `absent` without asking
   * HEAD whether a newer commit already carries it. The renderer then folded `absent` into
   * "NOT COMMITTED … Fix: git-sync:run" — a NO-OP for an already-committed file, while the
   * real lever (wait out the quiet window / let the next run pick it up) went unnamed.
   *
   * This is the single commonest shape on this tree, because the quiet-cut deliberately
   * steps the judged commit ~4 min behind the tip: every new file committed in that window
   * lands here. Observed 2026-07-27 on WI-6126, where the tool's own
   * `excludedCommitsTouchingYourFiles` simultaneously named the commit carrying the file it
   * was calling uncommitted.
   */
  it('MISFIRE 3 — a NEW file already committed past the candidate is newer-commit, NOT uncommitted', async () => {
    const git = fakeGit({
      // The candidate has no such path (new file); HEAD carries exactly the tree content.
      blobs: { 'HEAD:new.ts': OTHER },
      tree: { 'new.ts': OTHER },
    });
    const [r] = await classifyPathsAgainstCandidate(git, 'cand', ['new.ts']);
    expect(r.inCandidate).toBe(false);
    expect(r.reason).toBe('newer-commit');
  });

  it('a new file whose HEAD copy DIFFERS from the tree is still uncommitted', async () => {
    // Committed once, then edited again: the working-tree content genuinely has not
    // been committed, so git-sync:run IS the right lever here.
    const git = fakeGit({ blobs: { 'HEAD:new.ts': SAME }, tree: { 'new.ts': OTHER } });
    const [r] = await classifyPathsAgainstCandidate(git, 'cand', ['new.ts']);
    expect(r.reason).toBe('uncommitted');
  });

  it('absent survives only when there is no HEAD to ask about committed-ness', async () => {
    // committedSha explicitly null ⇒ the question cannot be answered, so the honest
    // report is `absent` rather than a guessed lever.
    const git = fakeGit({ tree: { 'new.ts': OTHER } });
    const [r] = await classifyPathsAgainstCandidate(git, 'cand', ['new.ts'], null);
    expect(r.inCandidate).toBe(false);
    expect(r.reason).toBe('absent');
  });

  /**
   * THE central invariant. The naive implementation (`git diff --name-only <sha> -- <path>`,
   * empty ⇒ "same") converts a FAILED git call into "your change IS in the candidate" — a
   * false reassurance, which is precisely the misread this module exists to prevent. A
   * broken read must be `null`, and null must never be counted as included.
   */
  it('an unreadable working tree yields UNKNOWN, never a false "contained"', async () => {
    const git = fakeGit({ blobs: { 'cand:a.ts': SAME } });
    const [r] = await classifyPathsAgainstCandidate(git, 'cand', ['a.ts']);
    expect(r.inCandidate).toBeNull();
    expect(r.unknownReason?.code).toBe('resolver-failed');
    expect(r.unknownReason?.detail).toMatch(/UNKNOWN, not confirmed/);
  });

  it('a totally failed git yields UNKNOWN for every path', async () => {
    const git = fakeGit({ allFail: true });
    const rs = await classifyPathsAgainstCandidate(git, 'cand', ['a.ts', 'b.ts']);
    expect(rs.map((r) => r.inCandidate)).toEqual([null, null]);
  });

  it('an unresolved candidate is UNKNOWN, not "missing" — there is nothing to compare against', async () => {
    const git = fakeGit({ tree: { 'a.ts': SAME } });
    const [r] = await classifyPathsAgainstCandidate(git, null, ['a.ts']);
    expect(r.inCandidate).toBeNull();
    // No candidate supplied ⇒ the question does not apply yet. FINAL, not a failure.
    expect(r.unknownReason?.code).toBe('not-applicable');
    expect(r.unknownReason?.detail).toMatch(/No candidate commit/);
  });

  /**
   * Caught by a LIVE run against the real repo, not by a fixture. A sha that does not
   * resolve makes every `<sha>:<path>` read fail — and on the candidate side a failed read
   * looks exactly like "this commit genuinely lacks the path". So every file came back
   * `absent`: a DEFINITIVE miss, hard-warning the caller that none of its work is in the
   * run. `judgingSha` is parsed from a log line / a foreign checkout's HEAD, so a stale or
   * bogus value is a real input — and this false alarm fires on EVERY path at once, which
   * is exactly how a detector teaches people to ignore it.
   */
  it.each([
    ['verification read failed', { allFail: true }],
    ['no commit was resolved', { resolvesCommit: false }],
  ] as const)(
    'a candidate SHA that cannot be verified is UNKNOWN — never a blanket "absent" (%s)',
    async (_caseName, failure) => {
      const git = fakeGit({ tree: { 'a.ts': SAME }, ...failure });
      const rs = await classifyPathsAgainstCandidate(git, 'deadbeefdeadbeef', ['a.ts', 'b.ts']);
      expect(rs.map((r) => r.inCandidate)).toEqual([null, null]);
      expect(rs[0].reason).toBeNull();
      // GitRead collapses command failure and an unresolved SHA to null, so the
      // detail must not claim which happened. Fetching the right checkout may yet
      // answer; keep this retry-shaped, not `not-applicable`.
      expect(rs[0].unknownReason?.code).toBe('resolver-failed');
      expect(rs[0].unknownReason?.detail).toMatch(/Could not verify candidate commit/);
      expect(rs[0].unknownReason?.detail).not.toMatch(/does not resolve in this repo/);
    },
  );

  it('…but a RESOLVING candidate that truly lacks the path is still a definitive miss', async () => {
    // The guard above must not swallow the genuine new-file case it sits in front of.
    // The verdict stays FALSE (a miss, never UNKNOWN); only the lever is now named
    // precisely — HEAD lacks it here too, so it is uncommitted.
    const git = fakeGit({ tree: { 'new.ts': OTHER } }); // commit resolves; the PATH is absent
    const [r] = await classifyPathsAgainstCandidate(git, 'deadbeefdeadbeef', ['new.ts']);
    expect(r.inCandidate).toBe(false);
    expect(r.reason).toBe('uncommitted');
    expect(r.unknownReason).toBeNull();
  });

  /**
   * EI-19326775809436764 — the incident: `release:checkpoint-run { paths }` reported
   * `sync-resolver/index.ts` as `missing / reason:'uncommitted'`, blamed "your file(s)",
   * and prescribed `git-sync:run, then re-fire` — while the caller's fix (committed as
   * bd5ba29a9b) was PROVABLY already an ancestor of the candidate (4a9b218ba0). The dirty
   * working-tree content that broke the blob-identity comparison was a PEER's unrelated,
   * still-uncommitted edit on the same shared file. A red gate from a needless re-fire on
   * an already-current candidate costs a multi-hour suite run for nothing.
   */
  describe('ancestry refinement — the shared-tree "uncommitted" false-attribution (EI-19326775809436764)', () => {
    const SAME = 'a'.repeat(40);
    const OTHER = 'd'.repeat(40);
    const HEAD_SHA = 'b'.repeat(40);

    it('the incident, reproduced: candidate already carries everything committed for this path — NOT missing, NOT uncommitted', async () => {
      // candidate lacks the tree's exact bytes (a peer's dirty edit is in the tree, not
      // in HEAD or the candidate) — the same shape that used to fall straight into
      // 'uncommitted'. But the last commit that ever touched this path at HEAD
      // (HEAD_SHA) IS already an ancestor of the candidate: nothing COMMITTED is missing.
      const git = fakeGit({
        blobs: { 'cand:index.ts': SAME, 'HEAD:index.ts': SAME },
        tree: { 'index.ts': OTHER }, // a peer's uncommitted edit, unrelated to the caller
        newestCommit: { 'HEAD:index.ts': HEAD_SHA },
        ancestry: { ['cand..' + HEAD_SHA]: true }, // HEAD_SHA is an ancestor-or-equal of cand
      });
      const [r] = await classifyPathsAgainstCandidate(git, 'cand', ['index.ts']);
      // The recurrence-guard bar, verbatim: NOT missing, NOT a "your file" claim, NOT the
      // re-fire lever. Reported as UNKNOWN — never a false POSITIVE (D-038 axis 2) — with
      // an enumerated, branchable reason.
      expect(r.inCandidate).toBeNull();
      expect(r.reason).toBeNull();
      expect(r.unknownReason?.code).toBe('insufficient-data');
      expect(r.unknownReason?.detail).toContain('every commit landed');
      expect(r.unknownReason?.detail).not.toMatch(/your file/i);

      const v = await callerEditsInCandidate(git, 'cand', ['index.ts']);
      expect(v.missing).not.toContain('index.ts');
      expect(v.unknown).toContain('index.ts');

      // And the tool-facing warning built from this verdict must carry neither the scary
      // claim nor the wasteful lever for this path.
      expect(v.missing.length).toBe(0); // renderContainmentWarning is only invoked when missing.length > 0
    });

    it('a genuinely newer commit (the ancestry check fails) is UNCHANGED — still a real "uncommitted" miss', async () => {
      // Same dirty-tree shape, but this time the last commit touching the path at HEAD is
      // NOT yet in the candidate (rev-list --count reports a nonzero count) — a real,
      // actionable case the refinement must not silently swallow.
      const git = fakeGit({
        blobs: { 'cand:index.ts': SAME, 'HEAD:index.ts': SAME },
        tree: { 'index.ts': OTHER },
        newestCommit: { 'HEAD:index.ts': HEAD_SHA },
        ancestry: { ['cand..' + HEAD_SHA]: false }, // NOT an ancestor
      });
      const [r] = await classifyPathsAgainstCandidate(git, 'cand', ['index.ts']);
      expect(r.inCandidate).toBe(false);
      expect(r.reason).toBe('uncommitted');
    });

    it('no commit has ever touched this path at HEAD — refinement does not apply, original classification stands', async () => {
      const git = fakeGit({
        blobs: { 'cand:index.ts': SAME, 'HEAD:index.ts': SAME },
        tree: { 'index.ts': OTHER },
        // newestCommit unset ⇒ '' ⇒ no commit found — refineUnattributedUncommitted bails.
      });
      const [r] = await classifyPathsAgainstCandidate(git, 'cand', ['index.ts']);
      expect(r.inCandidate).toBe(false);
      expect(r.reason).toBe('uncommitted');
    });

    it('the ancestry read itself FAILS — fails safe to the original classification, never a false unknown', async () => {
      const git = fakeGit({
        blobs: { 'cand:index.ts': SAME, 'HEAD:index.ts': SAME },
        tree: { 'index.ts': OTHER },
        newestCommit: { 'HEAD:index.ts': HEAD_SHA },
        // ancestry unset ⇒ null ⇒ the merge-base read FAILED — must not be read as "ancestor".
      });
      const [r] = await classifyPathsAgainstCandidate(git, 'cand', ['index.ts']);
      expect(r.inCandidate).toBe(false);
      expect(r.reason).toBe('uncommitted');
    });

    it('the absent-from-candidate branch (a brand-new-looking path) gets the same refinement', async () => {
      // candidateBlob is null here (the earlier commit deleted/never had the path at the
      // candidate) rather than merely differing — the OTHER mismatch branch in
      // classifyPathsAgainstCandidate. Same ancestry proof should still suppress the miss.
      const git = fakeGit({
        blobs: { 'HEAD:gone.ts': SAME }, // no 'cand:gone.ts' entry ⇒ candidateBlob is null
        tree: { 'gone.ts': OTHER }, // differs from HEAD ⇒ would otherwise read as 'uncommitted'
        newestCommit: { 'HEAD:gone.ts': HEAD_SHA },
        ancestry: { ['cand..' + HEAD_SHA]: true },
      });
      const [r] = await classifyPathsAgainstCandidate(git, 'cand', ['gone.ts']);
      expect(r.inCandidate).toBeNull();
      expect(r.unknownReason?.code).toBe('insufficient-data');
    });
  });
});

describe('callerEditsInCandidate', () => {
  const SAME = 'a'.repeat(40);
  const OTHER = 'd'.repeat(40);

  it('splits included / missing / unknown, and never counts an unknown as included', async () => {
    const git = fakeGit({
      blobs: { 'cand:in.ts': SAME, 'HEAD:in.ts': SAME, 'cand:out.ts': SAME, 'HEAD:out.ts': SAME },
      tree: { 'in.ts': SAME, 'out.ts': OTHER },
      // 'gone.ts' has no working-tree entry ⇒ unknown
    });
    const v = await callerEditsInCandidate(git, 'cand', ['in.ts', 'out.ts', 'gone.ts']);
    expect(v.included).toEqual(['in.ts']);
    expect(v.missing).toEqual(['out.ts']);
    expect(v.unknown).toEqual(['gone.ts']);
    expect(v.included).not.toContain('gone.ts');
  });
});

describe('uncommittedPaths', () => {
  it('reports untracked files — the input a committed candidate provably cannot contain', async () => {
    const git = fakeGit({ diff: 'packages/x/edited.ts', lsFiles: 'packages/x/brand-new.test.ts' });
    expect(await uncommittedPaths(git)).toEqual(['packages/x/edited.ts', 'packages/x/brand-new.test.ts']);
  });

  /**
   * The regression this parse was rewritten for: `git status --porcelain` encodes state
   * in a two-column PREFIX (`" M path"`), and every runner here trims stdout — which eats
   * the first line's leading space and shifts the column parse by one, silently yielding
   * a truncated path ("irty.ts" for "dirty.ts"). Bare-path reads have no column to lose,
   * so a trimmed answer is still a correct answer.
   */
  it('survives a TRIMMED first line — no leading-column dependency', async () => {
    const git = fakeGit({ diff: 'dirty.ts', lsFiles: '' });
    expect(await uncommittedPaths(git)).toEqual(['dirty.ts']);
  });

  it('de-duplicates a path reported by both reads', async () => {
    const git = fakeGit({ diff: 'a.ts\nb.ts', lsFiles: 'b.ts' });
    expect(await uncommittedPaths(git)).toEqual(['a.ts', 'b.ts']);
  });

  it('a clean tree is empty, and a failed read is empty rather than throwing', async () => {
    expect(await uncommittedPaths(fakeGit({ diff: '', lsFiles: '' }))).toEqual([]);
    expect(await uncommittedPaths(fakeGit({ allFail: true }))).toEqual([]);
  });
});

describe('excluded-commit attribution (the resolution of "if your fix is among them")', () => {
  it('names the commits that touch a specific path', async () => {
    const git = fakeGit({ log: 'abc1234 fix the thing\ndef5678 also the thing' });
    expect(await excludedCommitsTouchingPath(git, 'cand', 'tip', 'a.ts')).toEqual([
      'abc1234 fix the thing',
      'def5678 also the thing',
    ]);
  });

  it('short-circuits without a git call when nothing was excluded', async () => {
    let calls = 0;
    const git: GitRead = async () => {
      calls += 1;
      return '';
    };
    expect(await excludedCommitsTouchingPath(git, 'same', 'same', 'a.ts')).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe('gitReadFromExecSync', () => {
  it('preserves the "" vs null distinction a zero-exit empty answer depends on', async () => {
    const ok = gitReadFromExecSync(() => ({ status: 0, stdout: '' }), '/repo');
    const fail = gitReadFromExecSync(() => ({ status: 128, stdout: '' }), '/repo');
    expect(await ok(['status', '--porcelain'])).toBe('');
    expect(await fail(['status', '--porcelain'])).toBeNull();
  });

  it('scopes every read to the given repo with -C', async () => {
    let seen: string[] = [];
    const read = gitReadFromExecSync((_cmd, args) => {
      seen = args;
      return { status: 0, stdout: 'out' };
    }, '/my/repo');
    await read(['rev-parse', 'HEAD']);
    expect(seen).toEqual(['-C', '/my/repo', 'rev-parse', 'HEAD']);
  });
});

/**
 * EI-18828378090895599 — a COMMITTED file inside a submodule was reported `uncommitted`.
 *
 * Why this was expensive rather than cosmetic: `uncommitted` prescribes "git-sync:run,
 * then re-fire". The file was committed all along, so that lever cannot help — it just
 * burns another ~55min gate run on an already-red gate and delays the whole fleet. It is
 * the exact inverse of the misread `marker` was added to kill: a CONFIDENT WRONG answer,
 * not a blind spot.
 *
 * Mechanism: the superproject stores only a gitlink (160000) for a submodule, so
 * `rev-parse <sha>:<sub>/<file>` fails — while `hash-object -- <sub>/<file>` succeeds,
 * because it hashes bytes on disk. Candidate-null + tree-present + HEAD-null then fell
 * into the "new file" branch and `headBlob === treeBlob` was false ⇒ `uncommitted`.
 */
describe('submodule paths — the false "uncommitted" verdict (EI-18828378090895599)', () => {
  const SUB = 'papercusp-desktop';
  const FILE = `${SUB}/bin/lib/federation-asserts.selftest.sh`;
  const REL = 'bin/lib/federation-asserts.selftest.sh';
  const FIXED = 'f'.repeat(40);
  const OLD = '0'.repeat(40);

  /**
   * A superproject fake whose reads FAIL for any `<sha>:<sub>/<path>` — exactly as real
   * git does — and which routes an accumulated `-C <sub>` into the submodule's own store.
   * Modelling that failure faithfully is the point: it is what produced the wrong answer.
   */
  function fakeSuperGit(opts: {
    /** superproject sha → the submodule commit it pins. Absent ⇒ ls-tree '' (absent). */
    pins?: Record<string, string>;
    /** `${subSha}:${relPath}` → blob sha inside the submodule. */
    subBlobs?: Record<string, string>;
    /** relPath → submodule working-tree blob. */
    subTree?: Record<string, string>;
    /** No `.gitmodules` at all (a plain repo). */
    noGitmodules?: boolean;
    /** The gitlink read fails outright. */
    gitlinkUnreadable?: boolean;
  }): GitRead {
    const sub: GitRead = async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        if (args[2].endsWith('^{commit}')) return 'c'.repeat(40);
        return opts.subBlobs?.[args[2]] ?? null;
      }
      if (args[0] === 'hash-object') return opts.subTree?.[args[2]] ?? null;
      return null;
    };
    return async (args) => {
      if (args[0] === '-C') return sub(args.slice(2));
      if (args[0] === 'config') {
        return opts.noGitmodules ? null : `submodule.${SUB}.path ${SUB}`;
      }
      if (args[0] === 'ls-tree') {
        if (opts.gitlinkUnreadable) return null;
        const pin = opts.pins?.[args[1]];
        return pin ? `160000 commit ${pin}\t${SUB}` : '';
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        if (args[2].endsWith('^{commit}')) return 'c'.repeat(40);
        return null; // a `<sha>:<sub>/<file>` read — always fails in the superproject
      }
      if (args[0] === 'hash-object') return FIXED; // succeeds on disk; the trap
      return null;
    };
  }

  it('THE INCIDENT: a committed, pinned submodule file is CONTAINED — not "uncommitted"', async () => {
    const git = fakeSuperGit({
      pins: { cand: 'e0ebb3c6' },
      subBlobs: { [`e0ebb3c6:${REL}`]: FIXED, [`HEAD:${REL}`]: FIXED },
      subTree: { [REL]: FIXED },
    });
    const [r] = await classifyPathsAgainstCandidate(git, 'cand', [FILE]);
    expect(r.inCandidate).toBe(true);
    // The regression guard proper: the old code said false/'uncommitted' here.
    expect(r.reason).toBeNull();
  });

  it('resolves a committed instrument through the superproject gitlink', async () => {
    const git = fakeSuperGit({
      pins: { HEAD: 'e0ebb3c6' },
      subBlobs: { [`e0ebb3c6:${REL}`]: FIXED, [`HEAD:${REL}`]: OLD },
      subTree: { [REL]: FIXED },
    });
    expect(await committedBlobAtHead(git, FILE)).toBe(FIXED);
  });

  it("fails closed when an instrument's gitlink cannot be read", async () => {
    const git = fakeSuperGit({ gitlinkUnreadable: true, subTree: { [REL]: FIXED } });
    expect(await committedBlobAtHead(git, FILE)).toBeNull();
  });

  it('never prescribes git-sync:run for a file already committed in the submodule', async () => {
    // Pin PREDATES the fix: genuinely missing, but the lever is "wait", not "commit".
    const git = fakeSuperGit({
      pins: { cand: 'oldpin' },
      subBlobs: { [`oldpin:${REL}`]: OLD, [`HEAD:${REL}`]: FIXED },
      subTree: { [REL]: FIXED },
    });
    const [r] = await classifyPathsAgainstCandidate(git, 'cand', [FILE]);
    expect(r.inCandidate).toBe(false);
    expect(r.reason).toBe('newer-commit');
    expect(r.reason).not.toBe('uncommitted');
  });

  it('still reports a genuinely uncommitted submodule edit as uncommitted', async () => {
    // The tree differs from the submodule's own HEAD ⇒ git-sync:run really is the lever.
    const git = fakeSuperGit({
      pins: { cand: 'e0ebb3c6' },
      subBlobs: { [`e0ebb3c6:${REL}`]: OLD, [`HEAD:${REL}`]: OLD },
      subTree: { [REL]: FIXED },
    });
    const [r] = await classifyPathsAgainstCandidate(git, 'cand', [FILE]);
    expect(r.inCandidate).toBe(false);
    expect(r.reason).toBe('uncommitted');
  });

  it('an UNREADABLE gitlink is unknown, never a verdict', async () => {
    const git = fakeSuperGit({ gitlinkUnreadable: true, subTree: { [REL]: FIXED } });
    const [r] = await classifyPathsAgainstCandidate(git, 'cand', [FILE]);
    expect(r.inCandidate).toBeNull();
    expect(r.unknownReason?.code).toBe('resolver-failed');
    expect(r.unknownReason?.detail).toMatch(/UNKNOWN, not missing/);
  });

  it('a candidate predating the submodule is a definitive miss, with a real lever', async () => {
    const git = fakeSuperGit({
      pins: {}, // ls-tree '' ⇒ the submodule is not in that commit at all
      subBlobs: { [`HEAD:${REL}`]: FIXED },
      subTree: { [REL]: FIXED },
    });
    const [r] = await classifyPathsAgainstCandidate(git, 'cand', [FILE]);
    expect(r.inCandidate).toBe(false);
    expect(r.reason).toBe('newer-commit');
  });

  it('an unchecked-out submodule is unknown, not "uncommitted"', async () => {
    const git = fakeSuperGit({ pins: { cand: 'e0ebb3c6' } }); // no subTree ⇒ unreadable
    const [r] = await classifyPathsAgainstCandidate(git, 'cand', [FILE]);
    expect(r.inCandidate).toBeNull();
    expect(r.unknownReason?.detail).toMatch(/UNKNOWN, not confirmed/);
  });

  it('the submodule directory itself is not-applicable, not a blob verdict', async () => {
    const git = fakeSuperGit({ pins: { cand: 'e0ebb3c6' } });
    const [r] = await classifyPathsAgainstCandidate(git, 'cand', [SUB]);
    expect(r.inCandidate).toBeNull();
    expect(r.unknownReason?.code).toBe('not-applicable');
  });

  it('callerEditsInCandidate reports the incident file as included, not missing', async () => {
    const git = fakeSuperGit({
      pins: { df300ebf: 'e0ebb3c6' },
      subBlobs: { [`e0ebb3c6:${REL}`]: FIXED, [`HEAD:${REL}`]: FIXED },
      subTree: { [REL]: FIXED },
    });
    const r = await callerEditsInCandidate(git, 'df300ebf', [FILE]);
    expect(r.included).toEqual([FILE]);
    expect(r.missing).toEqual([]);
    expect(r.unknown).toEqual([]);
  });

  /**
   * The blast radius: this tree has 39 submodules (libs/papercusp, every libs/generic/*),
   * so the deepest prefix must win or a nested submodule is evaluated in its parent.
   */
  it('resolves the DEEPEST submodule prefix, not the first match', async () => {
    const git: GitRead = async (args) => {
      if (args[0] === 'config') return 'submodule.a.path libs\nsubmodule.b.path libs/generic/sse';
      if (args[0] === '-C') {
        expect(args[1]).toBe('libs/generic/sse'); // not 'libs'
        if (args[2] === 'hash-object') return FIXED;
        if (args[2] === 'rev-parse') return FIXED;
        return null;
      }
      if (args[0] === 'ls-tree') return `160000 commit deadbee\t${args[3]}`;
      if (args[0] === 'rev-parse') return 'c'.repeat(40);
      return null;
    };
    const [r] = await classifyPathsAgainstCandidate(git, 'cand', ['libs/generic/sse/src/index.ts']);
    expect(r.inCandidate).toBe(true);
  });

  it('a repo with no .gitmodules behaves exactly as before', async () => {
    const git = fakeSuperGit({ noGitmodules: true, subTree: { [REL]: FIXED } });
    const [r] = await classifyPathsAgainstCandidate(git, 'cand', [FILE]);
    // Falls through to the plain superproject path — no submodule handling engaged.
    expect(r.inCandidate).toBe(false);
    expect(r.reason).toBe('uncommitted');
  });

  it('an explicit empty submodule list forces plain superproject behaviour', async () => {
    const git = fakeSuperGit({ pins: { cand: 'e0ebb3c6' }, subTree: { [REL]: FIXED } });
    const [r] = await classifyPathsAgainstCandidate(git, 'cand', [FILE], 'HEAD', { submodules: [] });
    expect(r.inCandidate).toBe(false);
  });
});

/**
 * EI-18796358994458975. The incident this encodes: candidate `2864c150` carried
 * `sync-resolver/deliberation-harness-fallback.test.ts` (included) while excluding
 * `sync-resolver/index.ts` (missing, reason `newer-commit`) — a test committed without the
 * implementation commit that makes it pass, guaranteed red before the suite even starts.
 */
describe('testImplSplitRisk (P-004 follow-up, EI-18796358994458975)', () => {
  const path = (
    p: string,
    inCandidate: boolean | null,
    reason: PathContainment['reason'] = null,
  ): PathContainment => ({ path: p, inCandidate, reason, unknownReason: null });

  it('detects the exact incident shape: an included test + a newer-commit non-test sibling', () => {
    const r = testImplSplitRisk([
      path('packages/operator-core/lib/sync-resolver/deliberation-harness-fallback.test.ts', true),
      path('packages/operator-core/lib/sync-resolver/index.ts', false, 'newer-commit'),
      path('packages/operator-core/lib/system-health/tool-efficiency.ts', true),
    ]);
    expect(r.detected).toBe(true);
    expect(r.includedTests).toEqual(['packages/operator-core/lib/sync-resolver/deliberation-harness-fallback.test.ts']);
    expect(r.missingImpl).toEqual(['packages/operator-core/lib/sync-resolver/index.ts']);
  });

  it('is silent when the test itself is what is missing — nothing torn, just not committed yet', () => {
    const r = testImplSplitRisk([
      path('a.test.ts', false, 'uncommitted'),
      path('a.ts', true),
    ]);
    expect(r.detected).toBe(false);
    expect(r.includedTests).toEqual([]);
  });

  it('is silent when the missing non-test file is `uncommitted`, not `newer-commit` (a different lever)', () => {
    const r = testImplSplitRisk([path('a.test.ts', true), path('a.ts', false, 'uncommitted')]);
    expect(r.detected).toBe(false);
    expect(r.missingImpl).toEqual([]);
  });

  it('is silent when everything declared is included — no risk to report', () => {
    const r = testImplSplitRisk([path('a.test.ts', true), path('a.ts', true)]);
    expect(r.detected).toBe(false);
  });

  it('a missing .test.ts is never counted as the "impl" half of a pair', () => {
    // Two test files, one included one newer-commit — not the shape this detects (there is
    // no non-test implementation file in play at all).
    const r = testImplSplitRisk([path('a.test.ts', true), path('b.test.ts', false, 'newer-commit')]);
    expect(r.detected).toBe(false);
    expect(r.missingImpl).toEqual([]);
  });
});

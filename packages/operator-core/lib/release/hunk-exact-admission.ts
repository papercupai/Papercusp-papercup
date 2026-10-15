/**
 * P-020 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03, D-008 layers 2–3):
 * build the SOURCE COMMIT for a hunk-exact admission.
 *
 * WHAT IT DOES. `admitPathsOntoRepairHead` (P-001) is source-agnostic: it admits the named
 * paths' entries from ANY commit in the object store onto repairHead. Path-exact admission
 * with `source: staging` therefore admits staging's whole BLOB of each path — which on this
 * shared tree can carry a stranger's concurrent work in the same file (D-008). This module
 * synthesises a source commit whose tree is repairHead's tree with each admitted path's blob
 * replaced by *repairHead's blob + ONLY the calling agent's ledgered hunks, replayed in
 * order*. Handing that commit to the primitive makes the admission hunk-exact while the
 * primitive's own proof (diff-tree == allowlist) still applies unchanged.
 *
 * WHAT IT REFUSES — and why each refusal names its exit, never a silent widening:
 *   - `no-ledgered-hunks`  no hunk by the caller (∪ includeHunksFrom) is ledgered for a path.
 *                          The ledger cannot attribute what it never saw (an edit made before
 *                          the freeze, a Codex apply_patch, a hook that could not reach the
 *                          operator). Exits: includeHunksFrom:[agent] / wholeBlob:true+reason.
 *   - `hunk-conflict`      a hunk's anchor is not in the content at that point of the replay:
 *                          the fix was made on top of a foreign change. Names the hunk and the
 *                          other agents who touched the path. Same two exits.
 *   - `hunk-already-applied` a hunk's effect is ALREADY on repairHead (WI-6554700010009955): an
 *                          earlier admission carried it without consuming its ledger row — a
 *                          whole-blob / committed-patch admission, or a build that predates
 *                          consumed-row tracking. Replaying an insertion again DUPLICATES its text
 *                          (no anchor miss, so nothing else refuses); a replacement would refuse
 *                          as a misleading `hunk-conflict`. Exit: the exact `ledgerRowIds` of the
 *                          hunks repairHead does not carry yet — never skipped on the tool's own.
 *   - `oversize`           a hunk exceeded the ledger cap and carries no content.
 *   - `not-a-blob`         the path is a symlink/gitlink/directory at repairHead — replaying
 *                          text hunks onto it is meaningless; admit it whole-blob by name.
 *
 * Synchronous plumbing like the primitive it feeds; every git call goes through the same
 * injectable runner. The scratch index and blob files are removed on every path.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ADMISSION_GIT_DATE,
  ADMISSION_GIT_IDENTITY,
  findGitlinkAncestor,
  normalizeAdmissionPath,
  realAdmissionGit,
  type AdmissionGitResult,
  type AdmissionGitRunner,
} from './repair-head-admission';
import { replayFrozenRepairHunks, type FrozenRepairEditHunk, type FrozenRepairEditLedgerRow } from './frozen-repair-edit-ledger';
import type { FrozenRepairAdmission } from './frozen-candidate-repair-queue';

const SHA_RE = /^[0-9a-f]{40,64}$/;

export interface HunkExactPathReport {
  path: string;
  /** Ledgered hunks replayed (the caller's ∪ includeHunksFrom's), in ledger order. */
  applied: number;
  /** The agents whose hunks were replayed. */
  agents: string[];
  /** Ledgered hunks on this path by agents NOT replayed — the work D-008 keeps out. */
  foreignHunks: number;
  foreignAgents: string[];
  /** repairHead's blob (null when the path did not exist there) and the replayed blob. */
  baseBlob: string | null;
  blob: string;
  /** true when the replay reproduced repairHead's blob byte-for-byte (nothing to admit). */
  unchanged: boolean;
}

export type HunkExactRefusalCode =
  | 'invalid-ledger-selection'
  | 'invalid-paths'
  | 'repair-head-unresolvable'
  | 'no-ledgered-hunks'
  | 'hunk-conflict'
  | 'hunk-already-applied'
  | 'oversize'
  | 'not-a-blob'
  | 'path-under-gitlink'
  | 'invalid-patch-source'
  | 'patch-conflict'
  | 'git-failed';

export interface HunkExactRefusal {
  ok: false;
  code: HunkExactRefusalCode;
  detail: string;
  path?: string;
  /** Other agents with ledgered hunks on `path` — the `includeHunksFrom` candidates. */
  foreignAgents?: string[];
  /** hunk-conflict / oversize: index into the replayed hunk list. */
  hunkIndex?: number;
  step?: string;
  /** The explicit widenings D-008 allows — never chosen by the tool on its own. */
  exits: string[];
}

export interface HunkExactSuccess {
  ok: true;
  /** Exact source-capture identities, never an admission-end timestamp watermark. */
  ledgerRowIds?: number[];
  /** The synthesised source commit (parent: repairHead). Pass as `source.ref` to the primitive. */
  sourceCommit: string;
  tree: string;
  perPath: HunkExactPathReport[];
  /** Every admitted path replayed to exactly repairHead's blob — the primitive will say nothing-to-admit. */
  allUnchanged: boolean;
}

export type HunkExactSourceOutcome = HunkExactSuccess | HunkExactRefusal;

export interface BuildHunkExactSourceInput {
  root: string;
  candidate: string;
  repairHead: string;
  paths: readonly string[];
  /** Ledger rows for this candidate (any path/agent — filtered here). */
  ledger: readonly FrozenRepairEditLedgerRow[];
  actor: string;
  /** D-008 layer 3a: other agents whose hunks are replayed too (a genuinely shared fix). */
  includeHunksFrom?: readonly string[];
  /** Pin a reviewed source snapshot while a precheck runs. */
  ledgerRowIds?: readonly number[];
  /** Identities recorded by prior successful admissions of this candidate. */
  consumedLedgerRowIds?: readonly number[];
  /** Legacy hunk admissions recorded exact per-path replay counts before row ids existed. */
  admissions?: readonly FrozenRepairAdmission[];
  git?: AdmissionGitRunner;
  nowMs: number;
}

function countOccurrences(haystack: string, needle: string): number {
  return needle === '' ? 0 : haystack.split(needle).length - 1;
}

/**
 * WI-6554700010009955: indices of `hunks` whose effect `base` ALREADY carries, judged in replay
 * order (a hunk found present is not re-applied, so later hunks are judged against the content
 * they were authored on top of). Content-based on purpose: consumed-row bookkeeping covers only
 * hunk-exact admissions, so a whole-blob / committed-patch admission — or one recorded by a build
 * that predates consumed-row tracking — leaves its carried rows unconsumed, and this is the one
 * check that holds whatever the bookkeeping missed.
 *
 *   - an INSERTION keeps its anchor (`new` contains `old`), so re-applying it never misses the
 *     anchor — it silently duplicates the inserted text. Present = its post-image is in the
 *     content (for `replaceAll`: every occurrence of the anchor sits inside a post-image).
 *   - a REPLACEMENT / DELETION removes its anchor. Present = anchor gone and post-image there
 *     (a deletion has none). Without this it refuses as a misleading `hunk-conflict`.
 *
 * Stops at the first hunk it cannot judge (an oversize hunk, or a genuine anchor miss): the
 * replay reports those with their own refusal code. Whole-file writes are idempotent on replay
 * and never reported.
 */
export function findAlreadyAppliedHunks(base: string | null, hunks: readonly FrozenRepairEditHunk[]): number[] {
  let content = base ?? '';
  const already: number[] = [];
  for (let i = 0; i < hunks.length; i += 1) {
    const h = hunks[i]!;
    if (h.kind === 'oversize') return already;
    if (h.kind === 'write') {
      content = h.body;
      continue;
    }
    if (h.new === h.old) continue;
    if (h.old === '') {
      // Client-level create: present when the file already holds exactly that body.
      if (content !== '' && content === h.new) {
        already.push(i);
        continue;
      }
      if (content !== '') return already;
      content = h.new;
      continue;
    }
    const hasOld = content.includes(h.old);
    const hasNew = h.new !== '' && content.includes(h.new);
    const insertion = h.new.includes(h.old);
    const present = insertion
      ? h.replaceAll
        ? hasNew && countOccurrences(content, h.old) === countOccurrences(h.new, h.old) * countOccurrences(content, h.new)
        : hasNew
      : !hasOld && (h.new === '' || hasNew);
    if (present) {
      already.push(i);
      continue;
    }
    if (!hasOld) return already;
    const at = content.indexOf(h.old);
    content = h.replaceAll ? content.split(h.old).join(h.new) : content.slice(0, at) + h.new + content.slice(at + h.old.length);
  }
  return already;
}

/**
 * WI-6554700010009991: the ledger rows a whole-blob / committed-patch admission CARRIES, so the
 * admission can record them as `ledgerRowIds` and a later hunk-exact admission treats them as
 * consumed instead of refusing `hunk-already-applied` (or, on a build without that check,
 * replaying an insertion twice).
 *
 * Each unconsumed row on a path is judged INDEPENDENTLY against that path's REAL admitted
 * content. It deliberately does not reuse `findAlreadyAppliedHunks`' sequence result: that
 * applies an absent-but-applicable hunk to a virtual content and keeps judging, so a later row
 * could be judged present on text the real blob lacks. A mis-consumed row is never replayed,
 * which is the unsafe direction, so this errs toward leaving a row unconsumed; a row left behind
 * still meets the WI-6554700010009955 content check on the next hunk-exact admission.
 *
 *   - `write`    carried when the content is exactly its body.
 *   - `oversize` never: it holds no content to judge.
 *   - `edit`     the same presence rule as `findAlreadyAppliedHunks`, applied to one row alone.
 *
 * A path missing from `contentByPath`, or mapped to null (deleted, or not a regular-file blob),
 * carries nothing. Ids come back in ledger order.
 */
export function findCarriedLedgerRowIds(input: {
  contentByPath: ReadonlyMap<string, string | null>;
  ledger: readonly FrozenRepairEditLedgerRow[];
  consumedLedgerRowIds?: Iterable<number>;
}): number[] {
  const consumed = new Set(input.consumedLedgerRowIds ?? []);
  const carried: number[] = [];
  for (const row of input.ledger) {
    if (consumed.has(row.id)) continue;
    const content = input.contentByPath.get(row.path);
    if (content === undefined || content === null) continue;
    const h = row.hunk;
    const present =
      h.kind === 'write' ? content === h.body : h.kind === 'edit' && findAlreadyAppliedHunks(content, [h]).length === 1;
    if (present) {
      consumed.add(row.id);
      carried.push(row.id);
    }
  }
  return carried;
}

function exitsFor(path: string, foreignAgents: string[]): string[] {
  const named = foreignAgents.length > 0 ? foreignAgents.map((a) => JSON.stringify(a)).join(', ') : '<agent>';
  return [
    `release:repair-queue { op:'admit', paths:['${path}'], includeHunksFrom:[${named}] } — replay another agent's ledgered hunks too (a shared fix)`,
    `release:repair-queue { op:'admit', paths:['${path}'], wholeBlob:true, reason:'<why the whole staging blob is safe>' } — admit staging's blob as-is; the ledger records every foreign hunk it carries`,
  ];
}

/**
 * Build the hunk-exact source commit. Never publishes anything: the commit is an ordinary
 * unreferenced object until the primitive builds an admission from it, and garbage otherwise.
 */
export function buildHunkExactSource(input: BuildHunkExactSourceInput): HunkExactSourceOutcome {
  const git = input.git ?? realAdmissionGit;
  const run = (argv: readonly string[], env?: NodeJS.ProcessEnv): AdmissionGitResult =>
    git(argv, { cwd: input.root, env: env ? { ...process.env, ...env } : undefined });
  const gitFailed = (step: string, r: AdmissionGitResult): HunkExactRefusal => ({
    ok: false,
    code: 'git-failed',
    step,
    detail: `${step} exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`,
    exits: [],
  });
  const revParse = (ref: string): string | null => {
    const r = run(['rev-parse', '--verify', '--quiet', ref]);
    const out = r.stdout.trim();
    return r.status === 0 && SHA_RE.test(out) ? out : null;
  };

  const paths: string[] = [];
  const invalid: string[] = [];
  for (const raw of input.paths) {
    const n = normalizeAdmissionPath(raw);
    if (!n) invalid.push(raw);
    else if (!paths.includes(n)) paths.push(n);
  }
  if (invalid.length > 0 || paths.length === 0) {
    return {
      ok: false,
      code: 'invalid-paths',
      detail: invalid.length ? `not repo-relative normal paths: ${invalid.map((p) => JSON.stringify(p)).join(', ')}` : 'no paths were named',
      exits: [],
    };
  }
  const repairHead = revParse(`${input.repairHead}^{commit}`);
  if (!repairHead) {
    return { ok: false, code: 'repair-head-unresolvable', detail: `repairHead ${input.repairHead} does not resolve to a commit in ${input.root}`, exits: [] };
  }
  const repairHeadTree = revParse(`${repairHead}^{tree}`);
  if (!repairHeadTree) return gitFailed('rev-parse repairHead^{tree}', run(['rev-parse', `${repairHead}^{tree}`]));

  const accepted = new Set<string>([input.actor.trim(), ...(input.includeHunksFrom ?? []).map((a) => a.trim()).filter(Boolean)]);
  const consumed = new Set(input.consumedLedgerRowIds ?? []);
  for (const admission of input.admissions ?? []) {
    if (admission.ledgerRowIds) {
      for (const id of admission.ledgerRowIds) consumed.add(id);
      continue;
    }
    if (admission.mode !== 'hunk-exact') continue;
    for (const [path, captured] of Object.entries(admission.hunks ?? {})) {
      // The legacy builder replayed the complete ordered actor prefix. Its recorded
      // count, rather than publication time, distinguishes edits arriving during R6.
      if (!Number.isSafeInteger(captured.applied) || captured.applied <= 0) continue;
      const prefix = input.ledger.filter((r) => r.path === path && captured.agents.includes(r.agent))
        .slice(0, captured.applied);
      if (prefix.length === captured.applied && prefix.every((r) => r.atMs <= admission.atMs)) {
        for (const r of prefix) consumed.add(r.id);
      }
    }
  }
  const selected = input.ledgerRowIds === undefined ? null : new Set(input.ledgerRowIds);
  if (selected && (selected.size === 0 || selected.size !== input.ledgerRowIds!.length ||
    [...selected].some((id) => !Number.isSafeInteger(id) || id <= 0 || consumed.has(id) ||
      !input.ledger.some((r) => r.id === id && r.candidate === input.candidate && paths.includes(r.path) && accepted.has(r.agent))))) {
    return { ok: false, code: 'invalid-ledger-selection', detail: 'Every selected row must exist for this candidate, named path and accepted actor, and must not already be consumed.', exits: [] };
  }
  // Capture once. Later rows, including ones written during R6, remain available.
  const ledger = input.ledger.filter((r) => !consumed.has(r.id) && (selected === null || selected.has(r.id)));
  const scratch = mkdtempSync(join(tmpdir(), 'papercusp-hunk-exact-'));
  const indexEnv: NodeJS.ProcessEnv = { GIT_INDEX_FILE: join(scratch, 'index') };
  try {
    const rt = run(['read-tree', repairHead], indexEnv);
    if (rt.status !== 0) return gitFailed('read-tree', rt);

    const perPath: HunkExactPathReport[] = [];
    const alreadyApplied: Array<{ path: string; row: FrozenRepairEditLedgerRow; index: number }> = [];
    for (const path of paths) {
      // A file inside a submodule has no entry in the superproject tree, so without this check
      // its hunks replay onto an empty base and refuse as a misleading `hunk-conflict`
      // (WI-10005976). The superproject can only admit the submodule POINTER, whole.
      for (const commit of [repairHead, input.candidate]) {
        const enclosing = findGitlinkAncestor(run, commit, path);
        if (!enclosing.ok) return gitFailed(enclosing.step, enclosing.result);
        if (enclosing.entry) {
          const gitlink = enclosing.entry.path;
          return {
            ok: false,
            code: 'path-under-gitlink',
            path,
            detail:
              `${path} is inside the submodule gitlink ${gitlink} (${(enclosing.entry.sha ?? '?').slice(0, 12)} at ${commit.slice(0, 12)}); ` +
              'hunks cannot be replayed into a submodule from the superproject. Admit the submodule pointer itself.',
            exits: [
              `release:repair-queue { op:'admit', paths:['${gitlink}'], wholeBlob:true, reason:'<why the staging pin of ${gitlink} is safe to admit whole>' } — moves the gitlink to staging's pin, carrying every submodule commit between the two pins`,
            ],
          };
        }
      }
      const rows = ledger.filter((r) => r.path === path);
      const mine = rows.filter((r) => accepted.has(r.agent));
      const foreign = rows.filter((r) => !accepted.has(r.agent));
      const foreignAgents = [...new Set(foreign.map((r) => r.agent))].sort();
      if (mine.length === 0) {
        return {
          ok: false,
          code: 'no-ledgered-hunks',
          path,
          foreignAgents,
          detail:
            `no ledgered hunk by ${JSON.stringify(input.actor)}${accepted.size > 1 ? ` (or ${[...accepted].filter((a) => a !== input.actor.trim()).join(', ')})` : ''} ` +
            `for ${path} under candidate ${input.candidate.slice(0, 12)}` +
            (foreignAgents.length ? `; ${foreign.length} hunk(s) by ${foreignAgents.join(', ')} ARE ledgered` : '; nobody ledgered an edit to it') +
            ' — hunk-exact admission has nothing to replay (an edit made before the freeze, a Codex apply_patch, or a hook that could not reach the operator is not attributable)',
          exits: exitsFor(path, foreignAgents),
        };
      }
      // repairHead's entry: mode + blob, or absent.
      const ls = run(['ls-tree', '-z', repairHead, '--', path]);
      if (ls.status !== 0) return gitFailed(`ls-tree ${repairHead.slice(0, 12)} -- ${path}`, ls);
      const line = ls.stdout.split('\0').find((l) => l.endsWith(`\t${path}`));
      let mode = '100644';
      let baseBlob: string | null = null;
      if (line) {
        const m = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40,64})\t/.exec(line);
        if (!m) return gitFailed(`ls-tree ${path}`, { ...ls, stderr: `unparseable entry ${JSON.stringify(line)}` });
        if (m[2] !== 'blob' || m[1] === '120000') {
          return {
            ok: false,
            code: 'not-a-blob',
            path,
            detail: `${path} is a ${m[2] === 'tree' ? 'directory' : m[2] === 'commit' ? 'submodule gitlink' : 'symlink'} at repairHead ${repairHead.slice(0, 12)} — text hunks cannot be replayed onto it`,
            exits: exitsFor(path, foreignAgents).slice(1),
          };
        }
        mode = m[1]!;
        baseBlob = m[3]!;
      }
      let base: string | null = null;
      if (baseBlob) {
        const cat = run(['cat-file', 'blob', baseBlob]);
        if (cat.status !== 0) return gitFailed(`cat-file blob ${baseBlob.slice(0, 12)}`, cat);
        base = cat.stdout;
      }
      // WI-6554700010009955: a hunk repairHead already carries is never replayed twice. Judged
      // after every path, so the exit is ONE ledgerRowIds selection covering them all.
      const present = findAlreadyAppliedHunks(base, mine.map((r) => r.hunk));
      if (present.length > 0) {
        for (const index of present) alreadyApplied.push({ path, row: mine[index]!, index });
        continue;
      }
      const replay = replayFrozenRepairHunks(
        base,
        mine.map((r) => r.hunk),
      );
      if (!replay.ok) {
        const row = mine[replay.index];
        return {
          ok: false,
          code: replay.reason,
          path,
          hunkIndex: replay.index,
          foreignAgents,
          detail:
            `${path}: ${replay.detail}` +
            (row ? ` (hunk by ${row.agent} at ${new Date(row.atMs).toISOString()}${row.workItem ? `, ${row.workItem}` : ''})` : '') +
            (replay.reason === 'hunk-conflict' && foreignAgents.length
              ? `; the path also carries ${foreign.length} ledgered hunk(s) by ${foreignAgents.join(', ')} — your fix may depend on one of them`
              : ''),
          exits: exitsFor(path, foreignAgents),
        };
      }
      const blobFile = join(scratch, `blob-${perPath.length}`);
      writeFileSync(blobFile, replay.content, 'utf8');
      const ho = run(['hash-object', '-w', '--', blobFile]);
      const blob = ho.stdout.trim();
      if (ho.status !== 0 || !SHA_RE.test(blob)) return gitFailed(`hash-object ${path}`, ho);
      const ui = run(['update-index', '--add', '--replace', '--cacheinfo', `${mode},${blob},${path}`], indexEnv);
      if (ui.status !== 0) return gitFailed(`update-index --cacheinfo ${path}`, ui);
      perPath.push({
        path,
        applied: replay.applied,
        agents: [...new Set(mine.map((r) => r.agent))].sort(),
        foreignHunks: foreign.length,
        foreignAgents,
        baseBlob,
        blob,
        unchanged: blob === baseBlob,
      });
    }
    if (alreadyApplied.length > 0) {
      const presentIds = new Set(alreadyApplied.map((a) => a.row.id));
      const remaining = ledger.filter((r) => paths.includes(r.path) && accepted.has(r.agent) && !presentIds.has(r.id));
      const remainingPaths = paths.filter((p) => remaining.some((r) => r.path === p));
      const presentPaths = [...new Set(alreadyApplied.map((a) => a.path))];
      const others = [...accepted].filter((a) => a !== input.actor.trim());
      const quoted = (ps: readonly string[]) => ps.map((p) => `'${p}'`).join(', ');
      const exits: string[] = [];
      if (remaining.length > 0) {
        exits.push(
          `release:repair-queue { op:'admit', paths:[${quoted(remainingPaths)}]` +
            (others.length ? `, includeHunksFrom:[${others.map((a) => JSON.stringify(a)).join(', ')}]` : '') +
            `, ledgerRowIds:[${remaining.map((r) => r.id).join(', ')}] } — replay only the hunks repairHead does not carry yet`,
        );
      }
      exits.push(
        `release:repair-queue { op:'admit', paths:[${quoted(presentPaths)}], wholeBlob:true, reason:'<why the whole staging blob is safe>' } — admit staging's blob as-is`,
      );
      const first = alreadyApplied[0]!;
      return {
        ok: false,
        code: 'hunk-already-applied',
        path: first.path,
        hunkIndex: first.index,
        detail:
          `${alreadyApplied.length} ledgered hunk(s) are ALREADY on repairHead ${repairHead.slice(0, 12)}: ` +
          alreadyApplied.map((a) => `${a.path} row #${a.row.id} (hunk #${a.index + 1} by ${a.row.agent})`).join('; ') +
          '. An earlier admission carried them without consuming their ledger rows (a whole-blob / committed-patch admission, ' +
          'or a build without consumed-row tracking); replaying them again would duplicate inserted text. ' +
          (remaining.length > 0
            ? `${remaining.length} selected hunk(s) are not on repairHead yet — admit exactly those (first exit).`
            : 'Every selected hunk is already on repairHead — there is nothing to admit hunk-exactly.'),
        exits,
      };
    }
    const wt = run(['write-tree'], indexEnv);
    const tree = wt.stdout.trim();
    if (wt.status !== 0 || !SHA_RE.test(tree)) return gitFailed('write-tree', wt);
    const identityEnv: NodeJS.ProcessEnv = {
      GIT_AUTHOR_NAME: ADMISSION_GIT_IDENTITY.name,
      GIT_AUTHOR_EMAIL: ADMISSION_GIT_IDENTITY.email,
      GIT_AUTHOR_DATE: ADMISSION_GIT_DATE,
      GIT_COMMITTER_NAME: ADMISSION_GIT_IDENTITY.name,
      GIT_COMMITTER_EMAIL: ADMISSION_GIT_IDENTITY.email,
      GIT_COMMITTER_DATE: ADMISSION_GIT_DATE,
    };
    const message =
      `hunk-exact source for ${input.actor.trim()} onto ${repairHead.slice(0, 12)} (candidate ${input.candidate.slice(0, 12)})\n\n` +
      perPath.map((p) => `${p.path}: ${p.applied} hunk(s) by ${p.agents.join(', ')}${p.foreignHunks ? `; ${p.foreignHunks} foreign hunk(s) NOT carried (${p.foreignAgents.join(', ')})` : ''}`).join('\n') +
      '\n\nBuilt deterministically by papercusp release:repair-queue admit (P-020 / D-008).\n';
    const ct = run(['commit-tree', tree, '-p', repairHead, '-m', message], identityEnv);
    const sourceCommit = ct.stdout.trim();
    if (ct.status !== 0 || !SHA_RE.test(sourceCommit)) return gitFailed('commit-tree', ct);
    const ledgerRowIds = ledger.filter((r) => paths.includes(r.path) && accepted.has(r.agent)).map((r) => r.id);
    return { ok: true, sourceCommit, tree, perPath, ledgerRowIds, allUnchanged: perPath.every((p) => p.unchanged) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export interface CommittedPatchSuccess {
  ok: true;
  sourceCommit: string;
  tree: string;
  patch: NonNullable<FrozenRepairAdmission['patch']>;
}

/**
 * Explicit recovery when the hook never captured an edit (notably Codex apply_patch).
 * Git proves the selected commit's DELTA, not its author. A reasoned opt-in accepts that
 * delta; it never manufactures edit-ledger attribution or imports the source's whole blob.
 * Only staging-authored, single-parent commits qualify. No checkout, real-index mutation,
 * three-way merge, or ref publication occurs here; the ordinary admission door still
 * performs its path proof, import preflight and queue/ref CAS.
 */
export function buildCommittedPatchSource(input: {
  root: string;
  repairHead: string;
  patchCommit: string;
  integrationRef: string;
  paths: readonly string[];
  reason: string;
  git?: AdmissionGitRunner;
}): CommittedPatchSuccess | HunkExactRefusal {
  const git = input.git ?? realAdmissionGit;
  const run = (args: string[], env?: NodeJS.ProcessEnv, stdin?: string) =>
    git(args, { cwd: input.root, env: { ...process.env, GIT_LITERAL_PATHSPECS: '1', ...env }, input: stdin });
  const refuse = (code: HunkExactRefusalCode, detail: string): HunkExactRefusal =>
    ({ ok: false, code, detail, exits: [] });
  const failed = (step: string, r: AdmissionGitResult) =>
    refuse('git-failed', `${step} exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  const paths = [...new Set(input.paths.map(normalizeAdmissionPath))];
  if (!paths.length || paths.some((p) => p === null)) return refuse('invalid-paths', 'Name normal repository-relative paths');
  const wanted = paths as string[];
  if (!SHA_RE.test(input.patchCommit) || input.reason.trim().length < 8) {
    return refuse('invalid-patch-source', 'patchCommit requires a full immutable SHA and an explicit review reason (at least 8 characters)');
  }
  const source = run(['rev-list', '--parents', '-n', '1', input.patchCommit, '--']);
  if (source.status !== 0) return failed('resolve patch commit', source);
  const parents = source.stdout.trim().split(/\s+/);
  if (parents.length !== 2 || parents[0] !== input.patchCommit || !SHA_RE.test(parents[1]!)) {
    return refuse('invalid-patch-source', 'The patch source must be a single-parent commit, never a root or merge commit');
  }
  const parent = parents[1]!;
  const ancestor = run(['merge-base', '--is-ancestor', input.patchCommit, input.integrationRef]);
  if (ancestor.status === 1) return refuse('invalid-patch-source', 'The patch commit is not an ancestor of the integration branch');
  if (ancestor.status !== 0) return failed('prove integration ancestry', ancestor);
  const head = run(['rev-parse', '--verify', `${input.repairHead}^{commit}`]);
  if (head.status !== 0 || !SHA_RE.test(head.stdout.trim())) return failed('resolve repair head', head);
  const repairHead = head.stdout.trim();
  // Literal paths only: never expand a directory, wildcard, symlink or gitlink into a
  // wider patch. Text additions/deletions are supported; git apply rejects conflicts.
  for (const ref of [parent, input.patchCommit, repairHead]) {
    const entries = run(['ls-tree', '-z', ref, '--', ...wanted]);
    if (entries.status !== 0) return failed('read patch entries', entries);
    for (const entry of entries.stdout.split('\0').filter(Boolean)) {
      const match = /^(100644|100755) blob [0-9a-f]{40,64}\t(.+)$/.exec(entry);
      if (!match || !wanted.includes(match[2]!)) {
        return refuse('not-a-blob', 'Committed patch replay accepts exact regular-file paths only');
      }
    }
  }
  const changed = run(['diff', '--name-only', '-z', '--no-renames', parent, input.patchCommit, '--', ...wanted]);
  if (changed.status !== 0) return failed('read patch paths', changed);
  const sourcePaths = changed.stdout.split('\0').filter(Boolean);
  if (wanted.some((p) => !sourcePaths.includes(p)) || sourcePaths.some((p) => !wanted.includes(p))) {
    return refuse('invalid-paths', 'Every named path must change in the selected commit, with no expanded paths');
  }
  const diff = run(['diff', '--binary', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv', parent, input.patchCommit, '--', ...wanted]);
  if (diff.status !== 0) return failed('read committed patch', diff);
  if (!diff.stdout) return refuse('invalid-patch-source', 'The selected patch is empty');
  const patch = { commit: input.patchCommit, parent, sha256: createHash('sha256').update(diff.stdout).digest('hex') };
  const scratch = mkdtempSync(join(tmpdir(), 'papercusp-committed-patch-'));
  const env = { GIT_INDEX_FILE: join(scratch, 'index') };
  try {
    const read = run(['read-tree', repairHead], env);
    if (read.status !== 0) return failed('read-tree', read);
    const apply = run(['apply', '--cached', '--whitespace=nowarn', '-'], env, diff.stdout);
    if (apply.status !== 0) return refuse('patch-conflict', `The selected committed delta does not apply cleanly to repairHead: ${apply.stderr.trim().slice(0, 600)}`);
    const proof = run(['diff', '--cached', '--name-only', '-z', repairHead, '--'], env);
    if (proof.status !== 0) return failed('prove replay paths', proof);
    const replayPaths = proof.stdout.split('\0').filter(Boolean);
    if (!replayPaths.length || replayPaths.some((p) => !wanted.includes(p))) {
      return refuse('invalid-paths', 'Replayed patch is empty or escaped the named path set');
    }
    const treeResult = run(['write-tree'], env);
    const tree = treeResult.stdout.trim();
    if (treeResult.status !== 0 || !SHA_RE.test(tree)) return failed('write-tree', treeResult);
    const commit = run(['commit-tree', tree, '-p', repairHead, '-m',
      `Committed patch source\n\ncommit: ${patch.commit}\nparent: ${patch.parent}\npatch-sha256: ${patch.sha256}\npaths: ${JSON.stringify(wanted)}\nreason: ${input.reason}\n\nCommit delta provenance only; no hook/agent authorship asserted.\n`,
    ], {
      ...env,
      GIT_AUTHOR_NAME: ADMISSION_GIT_IDENTITY.name,
      GIT_AUTHOR_EMAIL: ADMISSION_GIT_IDENTITY.email,
      GIT_AUTHOR_DATE: ADMISSION_GIT_DATE,
      GIT_COMMITTER_NAME: ADMISSION_GIT_IDENTITY.name,
      GIT_COMMITTER_EMAIL: ADMISSION_GIT_IDENTITY.email,
      GIT_COMMITTER_DATE: ADMISSION_GIT_DATE,
    });
    if (commit.status !== 0 || !SHA_RE.test(commit.stdout.trim())) return failed('commit-tree', commit);
    return { ok: true, sourceCommit: commit.stdout.trim(), tree, patch };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ── P-004 (gate-throughput-shift-left-2026-10-06): attribution without the hunk ledger ──

/** One row of `harness_shared.edit_attribution_ledger` — who edited a file, and when.
 *  Written by the edit hook through a different path from the frozen hunk ledger, so it
 *  survives the misses that produce `no-ledgered-hunks` (measured: all three edits in
 *  EI-24313562050732849 and EI-24557368838482892 are present there with the right agent). */
export interface EditAttributionRow {
  path: string;
  agent: string;
  tsMs: number;
}

/** How far before the candidate's commit time the attribution window opens. An edit is
 *  swept into a commit minutes after it is made, so a peer's edit made just before the cut
 *  but committed after it is still inside this window — and therefore still refuses. */
export const SOLE_EDITOR_WINDOW_MARGIN_MS = 30 * 60_000;

export type SoleEditorVerdict =
  | { ok: true; agentsByPath: Record<string, string[]> }
  | {
      ok: false;
      reason: 'peer-edits' | 'no-recorded-edits';
      path: string;
      peers: string[];
      detail: string;
    };

/**
 * Decide whether an admission whose paths carry NO ledgered hunk at all may still be
 * attributed to the caller. It may only when, for EVERY path, the attribution ledger
 * records at least one edit since the window opened and every recorded edit is by the
 * caller (∪ includeHunksFrom). Then staging's whole post-freeze change to those paths is
 * the caller's, and admitting staging's blob carries no peer work. Any other recorded
 * editor — a `system:` writer included — refuses, naming them: a peer's concurrent hunk
 * is never admitted. An edit no hook recorded at all cannot be seen by any attribution
 * source; that residual risk is the same one `wholeBlob:true` already carries.
 */
export function attributeUnledgeredPaths(input: {
  paths: readonly string[];
  actor: string;
  includeHunksFrom?: readonly string[];
  rows: readonly EditAttributionRow[];
  windowStartMs: number;
}): SoleEditorVerdict {
  const accepted = new Set([input.actor.trim(), ...(input.includeHunksFrom ?? []).map((a) => a.trim()).filter(Boolean)]);
  const agentsByPath: Record<string, string[]> = {};
  for (const raw of input.paths) {
    const path = normalizeAdmissionPath(raw) ?? raw;
    const rows = input.rows.filter((r) => r.path === path && r.tsMs >= input.windowStartMs);
    const agents = [...new Set(rows.map((r) => r.agent))].sort();
    const peers = agents.filter((a) => !accepted.has(a));
    if (peers.length > 0) {
      return {
        ok: false,
        reason: 'peer-edits',
        path,
        peers,
        detail:
          `${path} has no ledgered hunk, and the edit attribution ledger shows ${peers.join(', ')} also edited it ` +
          `since the freeze window opened — staging's blob would carry their work, so it cannot be admitted as yours`,
      };
    }
    if (agents.length === 0) {
      return {
        ok: false,
        reason: 'no-recorded-edits',
        path,
        peers: [],
        detail:
          `${path} has no ledgered hunk, and the edit attribution ledger records no edit to it by anyone since the ` +
          `freeze window opened — the change cannot be attributed to ${input.actor.trim()}`,
      };
    }
    agentsByPath[path] = agents;
  }
  return { ok: true, agentsByPath };
}

/** Ledgered hunks on `paths` by agents other than `actor` (∪ include) — what a whole-blob admission may carry. */
export function summarizeForeignHunks(
  ledger: readonly FrozenRepairEditLedgerRow[],
  paths: readonly string[],
  actor: string,
  include: readonly string[] = [],
): { count: number; agents: string[]; byPath: Record<string, number> } {
  const accepted = new Set([actor.trim(), ...include.map((a) => a.trim()).filter(Boolean)]);
  const wanted = new Set(paths.map((p) => normalizeAdmissionPath(p)).filter((p): p is string => p !== null));
  const byPath: Record<string, number> = {};
  const agents = new Set<string>();
  let count = 0;
  for (const row of ledger) {
    if (!wanted.has(row.path) || accepted.has(row.agent)) continue;
    count += 1;
    agents.add(row.agent);
    byPath[row.path] = (byPath[row.path] ?? 0) + 1;
  }
  return { count, agents: [...agents].sort(), byPath };
}

/**
 * machine-surface-catalogue.test.ts
 *
 * Two jobs, and the second is the one that matters long-term.
 *
 *  1. Pin the predicates' BEHAVIOUR — in particular the asymmetry that makes
 *     them safe: a machine surface at the HEAD is hidden, the same string quoted
 *     mid-sentence by the owner is kept.
 *
 *  2. THE RECURRENCE GUARD. The defect this catalogue closes
 *     (EI-20135573616431912, plan owner-visibility-provenance) was never a
 *     missing pattern — it was a private copy of the list that the surface which
 *     needed it could not reach. This repo grew FOUR divergent copies that way,
 *     and nothing failed when each appeared. So the class returns silently
 *     unless something fails on a NEW copy. That is what `ONE HOME` below does.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  CLASSIFY_HEAD_CHARS,
  MACHINE_SURFACE_PATTERNS,
  SYNTHETIC_MARKERS,
  hasMachineSurfaceMarker,
  hasSyntheticMarker,
  isUnenrolledMachineSurface,
  parseCrossSessionSender,
} from './machine-surface-catalogue';

const regexKey = (re: RegExp): string => `${re.source}/${re.flags}`;

/**
 * Census-backed exceptions to the catalogue's head-anchor invariant.
 *
 * Keep this set explicit and keyed by the actual regex source + flags. A new
 * unanchored pattern must carry a written reason here, and a removed pattern
 * must remove its exception, so the safety tradeoff cannot hide in a broad
 * "self-identifying" heuristic.
 */
const UNANCHORED_PATTERN_EXCEPTIONS = new Map<string, string>([
  [
    '\\[\\s*SYSTEM NOTIFICATION\\b[^\\]]*\\bNOT USER INPUT\\b[^\\]]*\\]/i',
    'The bracketed NOT USER INPUT delimiters self-identify the CLI banner; the frozen corpus census found zero matches, and the shape stays aligned with the live classifier.',
  ],
  [
    '⟦\\s*machine-issued self-compaction/i',
    'The CLI places this marker after the /compact wrapper; anchoring it would miss the real machine-issued continuation rows.',
  ],
  [
    '✻\\s*Conversation compacted|●\\s*Compaction is queued/i',
    'The compaction UI captures this status after a leading quote/newline; anchoring it would miss the observed machine row.',
  ],
]);

describe('machine-surface catalogue — predicates', () => {
  it('HIDES the CLI compaction preamble (the largest single un-enrolled shape)', () => {
    expect(
      isUnenrolledMachineSurface(
        'This session is being continued from a previous conversation that ran out of context.',
      ),
    ).toBe(true);
  });

  it('HIDES the TUI interrupt marker', () => {
    expect(isUnenrolledMachineSurface('[Request interrupted by user]')).toBe(true);
  });

  it('HIDES the exact Claude usage-limit reset continuation, but keeps it when quoted by an owner', () => {
    const reset =
      'Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.';
    expect(isUnenrolledMachineSurface(reset)).toBe(true);
    expect(isUnenrolledMachineSurface(`Claude showed: "${reset}"`)).toBe(false);
    expect(isUnenrolledMachineSurface(`${reset} Please explain what it means.`)).toBe(false);
  });

  it('HIDES a Claude cross-session message in both recorded shapes and parses its sender (WI-6554700010017528)', () => {
    const tag =
      '<cross-session-message from="uds:/run/user/1000/cc-socks/957123.sock" from-name="papercusp-86" from-mode="bypass">\nConfirmed in my own log.\n</cross-session-message>';
    const transcript = `Another Claude session sent a message:\n${tag}`;
    expect(isUnenrolledMachineSurface(tag)).toBe(true);
    expect(isUnenrolledMachineSurface(transcript)).toBe(true);
    expect(parseCrossSessionSender(transcript)).toEqual({
      from: 'uds:/run/user/1000/cc-socks/957123.sock',
      fromName: 'papercusp-86',
    });
    expect(parseCrossSessionSender('<cross-session-message from="uds:/x.sock">hi')).toEqual({
      from: 'uds:/x.sock',
      fromName: null,
    });
    // An owner quoting it, or typing the tag without its from attribute, keeps the turn.
    expect(isUnenrolledMachineSurface(`look at this: ${tag}`)).toBe(false);
    expect(isUnenrolledMachineSurface('<cross-session-message> — what sends these?')).toBe(false);
    expect(parseCrossSessionSender(`look at this: ${tag}`)).toBeNull();
  });

  it('HIDES the specific Papercusp peer recovery diagnostic, but keeps generic peer text and owner quotations', () => {
    const diagnostic =
      '[peer:su-4a84c93a-e530-450c-b01e-8beb7bdc670f] Parent recovery diagnostic under existing EI-26842368936683990.';
    expect(isUnenrolledMachineSurface(diagnostic)).toBe(true);
    expect(isUnenrolledMachineSurface(`Why did this appear? ${diagnostic}`)).toBe(false);
    expect(
      isUnenrolledMachineSurface(
        '[peer:su-4a84c93a-e530-450c-b01e-8beb7bdc670f] Ordinary note from my own text.',
      ),
    ).toBe(false);
  });

  it('HIDES a synthetic slash-command wrapper', () => {
    expect(isUnenrolledMachineSurface('<command-name>compact</command-name>')).toBe(true);
    expect(hasSyntheticMarker('<local-command-stdout>ok</local-command-stdout>')).toBe(true);
  });

  it('recognizes every synthetic marker, including tags after a command wrapper', () => {
    const examples: ReadonlyArray<readonly [string, string]> = [
      ['local-command-caveat', '<local-command-caveat>Do not echo this</local-command-caveat>'],
      ['local-command-stdout', '<local-command-stdout>ok</local-command-stdout>'],
      ['command-name', '<command-message>statusline</command-message>\n<command-name>/statusline</command-name>'],
      ['command-message', '<command-message>compact</command-message>'],
    ];
    for (const [label, text] of examples) {
      expect(hasSyntheticMarker(text), `${label} marker was not recognized`).toBe(true);
    }
  });

  /* ── V-002 / D-015: the codex launch prompt. ─────────────────────────────
     Verbatim head of a real row (session 019ff297…, 2026-08-11T20:51Z). This
     one is CLI-authored: papercusp writes CODEX_HOME/AGENTS.md but the CLI
     composes the wrapper, so there is no seam to prefix an envelope onto and
     no whole-turn hash either side can compute. Hence a pattern, not an
     enrolment — the reasoning is recorded beside the entries in the source. */
  it('HIDES the codex AGENTS.md launch prompt (the su persona rendered as the owner)', () => {
    const LAUNCH_PROMPT =
      '# AGENTS.md instructions\n\n<INSTRUCTIONS>\n' +
      '# Superuser engineer-collaborator (su) — domain-neutral base persona\n\n' +
      '> The DOMAIN-NEUTRAL su role: a superuser engineer working alongside the people who\n' +
      '> run this workspace.';
    expect(isUnenrolledMachineSurface(LAUNCH_PROMPT)).toBe(true);
  });

  it('HIDES the codex plugin preamble (same population, same authorship)', () => {
    expect(
      isUnenrolledMachineSurface(
        '<recommended_plugins>\nHere is a list of plugins that are available but not installed.',
      ),
    ).toBe(true);
  });

  it('recognizes the native environment wrapper while retaining questions quoting it', () => {
    expect(isUnenrolledMachineSurface('<environment_context>cwd=/repo</environment_context>')).toBe(true);
    expect(isUnenrolledMachineSurface('What does <environment_context> mean in my transcript?')).toBe(false);
  });

  it('KEEPS an owner ASKING about their AGENTS.md — the rail for the two entries above', () => {
    expect(
      isUnenrolledMachineSurface('why does my AGENTS.md instructions block show up as my own turn?'),
    ).toBe(false);
    expect(
      isUnenrolledMachineSurface(
        'the pane opens with "# AGENTS.md instructions" and I never typed it — where does that come from?',
      ),
    ).toBe(false);
  });

  /* ── The direction that must NEVER regress. ──────────────────────────────
     Hiding a machine row too few is recoverable; hiding something the human
     actually wrote is not. Every case below is an owner TALKING ABOUT a machine
     shape, which is exactly what a naive substring matcher would eat. */

  it('KEEPS an owner quoting the compaction preamble mid-sentence', () => {
    expect(
      isUnenrolledMachineSurface(
        'the pane shows "This session is being continued from a previous conversation" as my own message — fix that',
      ),
    ).toBe(false);
  });

  /* ── WI-38157: the head anchor is not enough when the PREFIX is shared. ────
     The mid-sentence case above passed all along, because the pattern is
     head-anchored. What it could not catch is an owner turn that legitimately
     BEGINS with the same words and then continues into a question. That matched
     the old prefix pattern and the predicate returned an empty string, so the
     owner's question was suppressed outright — the unrecoverable direction.

     The fix was to match the full machine sentence rather than its prefix, which
     is lossless: measured over the whole corpus, the loose prefix and the full
     sentence both match 3,434 rows, so nothing stopped being hidden.

     Note what is NOT the fix. The obvious remedy — "hide only if the turn is
     substantially just the banner" — fails open on every real machine row: the
     genuine turn is the banner PLUS the entire compaction summary, never under
     ~1,000 chars. The `HIDES` case below is deliberately long for that reason,
     so anyone reaching for a length/ratio test sees it fail here first. */
  it('KEEPS an owner turn that BEGINS with the compaction preamble and then asks about it', () => {
    expect(
      isUnenrolledMachineSurface(
        'This session is being continued from a previous conversation -- what does that mean?',
      ),
    ).toBe(false);
    expect(
      isUnenrolledMachineSurface(
        'This session is being continued from a previous conversation, apparently. Why am I seeing it twice?',
      ),
    ).toBe(false);
  });

  it('still HIDES the real banner, which is the full sentence followed by the summary', () => {
    const REAL_MACHINE_TURN =
      'This session is being continued from a previous conversation that ran out of context. ' +
      'The summary below covers the earlier portion of the conversation.\n\nSummary:\n' +
      `${'1. Primary Request and Intent: ...\n'.repeat(40)}`;
    expect(REAL_MACHINE_TURN.length).toBeGreaterThan(1000);
    expect(isUnenrolledMachineSurface(REAL_MACHINE_TURN)).toBe(true);
  });

  it('KEEPS an owner asking about the interrupt marker', () => {
    expect(
      isUnenrolledMachineSurface(
        'why does [Request interrupted by user] keep appearing in my chat as if I wrote it?',
      ),
    ).toBe(false);
  });

  it('KEEPS ordinary owner prose, including a markdown heading', () => {
    // There is deliberately no `^# ` rule: a human pastes markdown.
    expect(isUnenrolledMachineSurface('# my notes\n\nship the pane fix')).toBe(false);
    expect(isUnenrolledMachineSurface('hi')).toBe(false);
    expect(isUnenrolledMachineSurface('')).toBe(false);
  });

  it('BOUNDS the scan to the head, so a long owner turn cannot trip a late marker', () => {
    // The arithmetic half of "the filters are heuristics, the cap is arithmetic":
    // the same marker is decisive at the head and inert past the bound.
    const marker = '[Request interrupted by user]';
    expect(hasMachineSurfaceMarker(marker)).toBe(true);
    expect(hasMachineSurfaceMarker(`${'x'.repeat(CLASSIFY_HEAD_CHARS + 50)}${marker}`)).toBe(false);
  });

  it('applies the head bound INSIDE the predicate, not at the call site', () => {
    // A caller that has to remember to slice is a caller that can forget. Passing
    // the WHOLE turn must give the same answer as passing a pre-sliced head.
    const whole = `[Request interrupted by user]\n${'x'.repeat(4096)}`;
    expect(isUnenrolledMachineSurface(whole)).toBe(
      isUnenrolledMachineSurface(whole.slice(0, CLASSIFY_HEAD_CHARS)),
    );
  });

  it('every pattern is head-anchored or has an explicit census-backed exception', () => {
    // Head anchoring is the safe default: an owner quoting a machine shape
    // later in the bounded head keeps their turn. Intentional exceptions must
    // be named with a written reason, not admitted by a broad self-identifying
    // heuristic that silently blesses future unanchored additions.
    for (const re of MACHINE_SURFACE_PATTERNS) {
      const anchored = re.source.startsWith('^');
      const reason = UNANCHORED_PATTERN_EXCEPTIONS.get(regexKey(re));
      expect(
        anchored || reason,
        `unanchored pattern lacks an explicit exception: ${regexKey(re)}`,
      ).toBeTruthy();
      if (!anchored) expect(reason?.trim()).not.toBe('');
    }

    // The exception set is shrink-only and cannot become stale or silently
    // bless a different regex after a catalogue edit.
    for (const [key, reason] of UNANCHORED_PATTERN_EXCEPTIONS) {
      expect(
        MACHINE_SURFACE_PATTERNS.some((re) => regexKey(re) === key),
        `stale unanchored-pattern exception: ${key}`,
      ).toBe(true);
      expect(reason.trim(), `empty reason for unanchored pattern: ${key}`).not.toBe('');
    }
    // Synthetic markers are substring-matched, so each must be a tag, not a word.
    for (const m of SYNTHETIC_MARKERS) expect(m.startsWith('<')).toBe(true);
  });
});

/**
 * ONE HOME — the recurrence guard.
 *
 * Fails when a machine-surface marker is re-declared in a NEW source file
 * instead of imported from this catalogue. The allowlist is SHRINK-ONLY: it
 * records the copies that already existed when this guard was written, each
 * with the reason it survives and who owns collapsing it. Adding an entry to
 * make this pass is the exact move the guard exists to stop — import the
 * catalogue instead.
 */
describe('machine-surface catalogue — ONE HOME (recurrence guard)', () => {
  const CATALOGUE = 'packages/operator-core/lib/turn-provenance/machine-surface-catalogue.ts';

  /** Distinctive literals that only a copy of the catalogue would contain. */
  const MARKERS = [
    'This session is being continued from a previous conversation',
    'Request interrupted by user',
    'Parent recovery diagnostic',
  ];

  /**
   * Known pre-existing copies, and why each is still here.
   *
   * `human-turn-tail.ts` holds `UNENVELOPED_MACHINE_HEADS`, a SEPARATE curated
   * list serving the memory tail. Plan item P-005 ("define owner-visibility
   * ONCE — the same defect is live at three altitudes") owns collapsing it into
   * this catalogue; it is deliberately NOT collapsed here because P-003's scope
   * is the display filter and widening it would put an untested change to the
   * memory path in the same commit.
   */
  const ALLOWED_COPIES = new Set([
    CATALOGUE,
    'packages/operator-core/lib/memory/human-turn-tail.ts',
  ]);

  /** Repo root — this file sits at <root>/packages/operator-core/lib/turn-provenance/. */
  const ROOT = join(__dirname, '..', '..', '..', '..');
  const isSourceFile = (name: string): boolean =>
    /\.tsx?$/.test(name) && !/\.(?:test|spec)\.tsx?$/.test(name);

  function sourceFilesUnder(rel: string): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
        const full = join(dir, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) walk(full);
        // Test fixtures legitimately contain these literals; the guard scans
        // source files, not Vitest or Playwright test fixtures.
        else if (isSourceFile(name)) out.push(full);
      }
    };
    walk(join(ROOT, rel));
    return out;
  }

  it('excludes Vitest and Playwright specs from the source census', () => {
    expect(isSourceFile('machine-surface-catalogue.test.ts')).toBe(false);
    expect(isSourceFile('adv-conversations-sessions.spec.ts')).toBe(false);
    expect(isSourceFile('machine-surface-catalogue.ts')).toBe(true);
    expect(isSourceFile('route.tsx')).toBe(true);
  });

  /**
   * The detection, as a PURE function over (paths → text).
   *
   * Split out so its falsifiability can be proven against synthetic inputs
   * rather than by mutating the shared tree. A mutation probe is unsafe here on
   * two counts: git-sync commits the whole working tree on a schedule, so a
   * file held mutated for the length of a run can be COMMITTED even when
   * nothing goes wrong, and a killed run skips its own restore.
   */
  function findOffenders(
    paths: readonly string[],
    readText: (p: string) => string | null,
    allowed: ReadonlySet<string>,
  ): string[] {
    const offenders: string[] = [];
    for (const rel of paths) {
      const text = readText(rel);
      if (text === null) continue;
      if (!MARKERS.some((m) => text.includes(m))) continue;
      if (!allowed.has(rel)) offenders.push(rel);
    }
    return offenders;
  }

  it('FALSIFIABLE: the guard reports a new copy, and stays silent on an allowlisted one', () => {
    // Proves the assertion below can actually fail. Without this, a guard that
    // silently matched nothing would look identical to a clean repo.
    const corpus: Record<string, string> = {
      'packages/operator-core/lib/some/new-file.ts':
        'const MINE = [/^\\s*\\[Request interrupted by user/];',
      'packages/operator-core/lib/memory/human-turn-tail.ts': '[Request interrupted by user]',
      'packages/operator-core/lib/unrelated.ts': 'export const x = 1;',
    };
    const read = (p: string) => corpus[p] ?? null;
    const allowed = new Set(['packages/operator-core/lib/memory/human-turn-tail.ts']);

    // The new copy is caught…
    expect(findOffenders(Object.keys(corpus), read, allowed)).toEqual([
      'packages/operator-core/lib/some/new-file.ts',
    ]);
    // …and once it imports the catalogue instead, the guard goes quiet.
    delete corpus['packages/operator-core/lib/some/new-file.ts'];
    expect(findOffenders(Object.keys(corpus), read, allowed)).toEqual([]);
  });

  it('no source file outside the catalogue re-declares a machine-surface marker', () => {
    const abs = [...sourceFilesUnder('packages/operator-core'), ...sourceFilesUnder('apps/operator')];
    const rels = abs.map((a) => a.slice(ROOT.length + 1));
    const offenders = findOffenders(
      rels,
      (rel) => {
        try {
          return readFileSync(join(ROOT, rel), 'utf8');
        } catch {
          return null;
        }
      },
      ALLOWED_COPIES,
    );

    // The scan must actually have looked at something — a walk that silently
    // returned nothing would pass this suite while checking zero files.
    expect(rels.length).toBeGreaterThan(100);

    expect(
      offenders,
      `These files re-declare a machine-surface marker instead of importing it from ${CATALOGUE}.\n` +
        'That is how this repo grew four divergent copies and how the owner-visibility leak survived ' +
        'three fixes. Import { isUnenrolledMachineSurface } from the catalogue instead of adding a ' +
        'pattern here. If a copy is genuinely unavoidable, it needs a plan decision — not an ' +
        'allowlist entry.',
    ).toEqual([]);
  });

  it('the allowlist is honest — every entry still exists and still contains a marker', () => {
    // A stale allowlist entry silently widens the guard. If a copy was collapsed,
    // its entry must be REMOVED (the set is shrink-only), and this fails until it is.
    for (const rel of ALLOWED_COPIES) {
      const text = readFileSync(join(ROOT, rel), 'utf8');
      expect(
        MARKERS.some((m) => text.includes(m)),
        `${rel} is allowlisted as a known copy but no longer contains a marker — remove the entry.`,
      ).toBe(true);
    }
  });
});

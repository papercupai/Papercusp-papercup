/**
 * carry-note-unread-run — EI-19455262557905604.
 *
 * `checks: [{ claim, recheck?, verified? }]` on `work_items:checkpoint` already
 * carries the VERIFIED-vs-PREDICTED distinction: `verified` is an evidence STRING
 * whose presence renders `✓ VERIFIED` and whose absence renders `? PREDICTED`.
 * It landed 2026-08-02T01:31Z. The problem is not that it is missing — it is that
 * it is INVISIBLE at the one moment it is actionable.
 *
 * Two independent misses, both AFTER the field shipped, are what this module
 * answers:
 *
 *  1. A checkpoint written ~5h after `checks` landed still wrote `RESOLVED (6)` vs
 *     `REMAINING (5) — NOT yet diagnosed` as flat prose. All 5 "REMAINING" files
 *     were already green; a successor nearly "fixed" 5 passing files.
 *  2. ~40h after it shipped, an su read the tool, concluded "there is no field,
 *     badge, or convention separating them", and filed to BUILD it. Miss (2) is
 *     the sharper signal: not merely unused, but undiscoverable to someone
 *     deliberately looking.
 *
 * This is the D-016 shape, and this repo has solved it once already: `loop:arm`'s
 * `blockedOn` measured ZERO uses in 294 arm calls across 91 arming agents (14d).
 * D-098's fix was NOT to document it harder — it was to surface the affordance at
 * the one moment it is actionable, on a STRUCTURAL trigger. This mirrors those
 * constraints exactly: advisory, no rejection, no behaviour change, fail-open.
 *
 * MEASURED BASELINE (2026-09-05, harness_shared.carry_notes, papercusp-workspace,
 * scope LIKE 'workitem:%'). The filing itself reported `0 / 0` and correctly
 * labelled it a FALSE ZERO from a wrong accessor (`metadata->>'checkpoint'`);
 * checkpoints are carry-notes. The real numbers:
 *   - 10,475 work-item carry-notes; 919 (8.8%) carry a `## Checks` section.
 *   - Last 14d: 530 / 7,849 = 6.75% — adoption is LOWER recently, i.e. not rising.
 *   - 676 (6.5%) contain in-flight vocabulary; 447 of those carry no checks.
 *   - 132 (1.26%) carry in-flight vocabulary AND a run artifact AND no checks.
 * That last figure is this advisory's firing rate, and it is why BOTH positive
 * signals are required: at 1.26% it is rare enough to be read, which is the D-004
 * property an advisory firing on every write does not have.
 *
 * WHY BOTH SIGNALS, AND WHY NO "RESULT LINE" SUPPRESSOR. Status vocabulary is a
 * candidate cue, not proof by itself; historical or unrelated prose can contain
 * the same words. A recognized run output must appear in the same clause, and
 * "launched" also needs a run-like subject. The standalone phrase "in-flight" is
 * more ambiguous, so it only counts when attached to a run-like subject ("test run
 * is in-flight"). This avoids treating unrelated compounds such as "in-flight
 * store rebinding" as an unread run. Adding a fuzzy result-detector on top would
 * buy nothing and could suppress a true positive, which is the worse failure
 * direction: an advisory that silently does not fire is indistinguishable from one
 * that had nothing to say.
 *
 * WHY THE TRIGGER IS PROSE AND NOT STRUCTURAL. Half of it IS structural — "this
 * write stored zero check rows" is a fact about the note, not a guess about it.
 * The other half cannot be fully structural: the argument has no run id or status
 * field, so the advisory ties its prose cue to a recognized output reference.
 * D-098 had an interval to key on; there is no equivalent
 * argument here, which is exactly the "wherever possible" carve-out in the filing.
 */

/**
 * Checkpoint language that may indicate a run was just launched or is unresolved.
 *
 * Deliberately narrow. `launched` alone is far too common ("launched a fleet"),
 * which is why a recognized run output in the same sentence, or an explicit
 * following handle sentence, is also required before anything fires.
 */
const IN_FLIGHT_RE =
  /\b(?:launched|in[-\s]flight|still running|not yet diagnosed|not yet read|awaiting (?:the )?results?|pending results?|results? (?:are )?pending)\b/gi;

const RUN_SUBJECT_BEFORE_IN_FLIGHT_RE =
  /\b(?:run|test|suite|job|command|process|build|check|lint|typecheck)\b(?:\W+\w+){0,4}\W*$/i;
const RUN_SUBJECT_AFTER_IN_FLIGHT_RE =
  /^\W*(?:(?:is|are|was|were|remains?|still|currently|actively)\W+){0,2}\b(?:run|test|suite|job|command|process|build|check|lint|typecheck)\b/i;

/**
 * A concrete execution log or tool run identifier. Arbitrary /tmp files
 * (source diffs, read captures, and similar artifacts) are not run references.
 */
const RUN_REF_RE = /(?:\S+?\.(?:log|out|err|stdout|stderr)\b|\b(?:bash_id|task_id|taskId)\s*[:=]?\s*["'`]?[_a-z0-9][\w.-]{2,})/gi;

/** Cap on how many matched fragments are echoed back, so the note stays one line. */
const MAX_SIGNALS = 3;

/**
 * A checkpoint receipt can quote the advisory emitted by an earlier write. That
 * quoted text describes the receipt's subject, not the current writer's run.
 * Keep this narrower than the historical-quote rule: current runner prose such
 * as `The current runner says "still running"` remains actionable, while a
 * `work_items:checkpoint receipt ... warns 'run ... in-flight ...'` quote is
 * evidence being reconciled rather than a new unread admission.
 */
const RECEIPT_QUOTE_ATTRIBUTION_RE =
  /\b(?:receipt|checkpoint)\b[^.!?;\n]{0,140}\b(?:warns?|reports?|says?|states?|contains?|includes?)\s*$/i;

/**
 * An explicitly attributed historical quotation is evidence about an earlier
 * report, not the writer's current admission. Keep ambiguous prose and quoted
 * current reports actionable; this is deliberately not a result-line suppressor.
 */
function withoutHistoricalQuotations(text: string): string {
  const quotes = /"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|“[^”\n]*”|‘[^’\n]*’/g;
  return text.replace(quotes, (quote: string, offset: number) => {
    const start = Math.max(
      text.lastIndexOf('\n', offset - 1),
      text.lastIndexOf('.', offset - 1),
      text.lastIndexOf(';', offset - 1),
    ) + 1;
    const attribution = text.slice(start, offset);
    const historical = /\b(?:historical|(?:saved|recovered)\b[^.!?;\n]{0,100}\b(?:transcript|parts?\d*))\b/i;
    const current = /\b(?:but|however|now|current(?:ly)?)\b/i;
    const receiptQuote = RECEIPT_QUOTE_ATTRIBUTION_RE.test(attribution);
    return (historical.test(attribution) && !current.test(attribution)) || receiptQuote
      ? ' '.repeat(quote.length)
      : quote;
  });
}

/**
 * JSON manifests are structured metadata, not prose references to a run output.
 * Blank valid inline JSON values before the lexical matcher sees filenames or
 * task handles embedded in their `files`/`jobs` fields. Preserve newlines and
 * offsets so the surrounding sentence matching remains unchanged.
 */
function withoutJsonValues(text: string): string {
  const chars = text.split('');
  for (let start = 0; start < text.length; start++) {
    const opener = text[start];
    if (opener !== '{' && opener !== '[') continue;

    const stack: string[] = [opener];
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = start + 1; index < text.length; index++) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{' || char === '[') {
        stack.push(char);
        continue;
      }
      if (char !== '}' && char !== ']') continue;
      const expected = char === '}' ? '{' : '[';
      if (stack.pop() !== expected) break;
      if (stack.length === 0) {
        end = index;
        break;
      }
    }
    if (end < 0) continue;
    try {
      JSON.parse(text.slice(start, end + 1));
    } catch {
      continue;
    }
    for (let index = start; index <= end; index++) {
      if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
    }
    start = end;
  }
  return chars.join('');
}

export interface UnreadRunSignals {
  /** In-flight phrases this body used (deduped, lowercased, capped). */
  inFlight: string[];
  /** Run artifacts this body referenced (deduped, capped). */
  runRefs: string[];
}

export interface UnreadRunAdvisory {
  flagged: true;
  note: string;
  signals: UnreadRunSignals;
}

function collect(
  text: string,
  re: RegExp,
  lower: boolean,
  includeMatch?: (match: RegExpExecArray) => boolean,
): string[] {
  const seen = new Set<string>();
  // A `g` regex carries lastIndex across calls; matchAll consumes a fresh clone.
  for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
    if (includeMatch && !includeMatch(m)) continue;
    // A path is greedy to a whitespace boundary, so it absorbs the sentence
    // punctuation that follows it — `/tmp/run.log.` rather than `/tmp/run.log`.
    // Echoing that back reads like a different (nonexistent) file, so trim it.
    const raw = m[0].trim().replace(/[.,;:!?)\]}>"']+$/, '');
    if (!raw) continue;
    const key = lower ? raw.toLowerCase() : raw;
    if (!seen.has(key)) seen.add(key);
    if (seen.size >= MAX_SIGNALS) break;
  }
  return [...seen];
}

function isRunScopedInFlight(text: string, index: number, length: number): boolean {
  const previousBoundary = Math.max(
    text.lastIndexOf('\n', index - 1),
    text.lastIndexOf('.', index - 1),
    text.lastIndexOf(';', index - 1),
    text.lastIndexOf('!', index - 1),
    text.lastIndexOf('?', index - 1),
  );
  const start = previousBoundary + 1;
  const nextBoundaries = [
    text.indexOf('\n', index + length),
    text.indexOf('.', index + length),
    text.indexOf(';', index + length),
    text.indexOf('!', index + length),
    text.indexOf('?', index + length),
  ].filter((boundary) => boundary >= 0);
  const end = nextBoundaries.length > 0 ? Math.min(...nextBoundaries) : text.length;
  const before = text.slice(Math.max(start, index - 80), index);
  const after = text.slice(index + length, Math.min(end, index + length + 80));
  return RUN_SUBJECT_BEFORE_IN_FLIGHT_RE.test(before) || RUN_SUBJECT_AFTER_IN_FLIGHT_RE.test(after);
}

// Adversative clauses can introduce another operation without a run-like noun
// (`...test log was read, while scorecards:repair is still running`). Keep the
// completed operation's artifact out of the pending operation's reference range.
// Explicit coordinated subjects such as `and the separate native-custody job was
// launched` need the same boundary even when the writer omits the comma. End the
// boundary at `separate` so the run subject remains available for status scoping.
const SENTENCE_BOUNDARY_RE =
  /[\n;]|\b(?:but|while|whereas|however|although)\b|\b(?:and\s+)?(?:(?:a|the)\s+)?(?:separate|another|different)\b(?=\s+(?:[\w'-]+\s+){0,3}(?:run|test|suite|job|command|process|build|check|lint|typecheck)\b(?=\s+(?:(?:is|are|was|were|has|have|had|remains?|still|currently|actively|explicitly|marked)\s+){0,4}(?:launched|started|ran|executed|spawned|submitted|running|in[-\s]flight|pending|completed|finished|exited)\b))|,(?=\s+(?:(?:and|but|while|whereas|however|although)\s+)?(?:\w+\s+){0,4}(?:run|test|suite|job|command|process|build|check|lint|typecheck)\b)|[.!?](?=\s|$)/g;
const RUN_SUBJECT_AFTER_LAUNCH_RE =
  /^\W*(?:(?:a|an|the|my|our|this|that|full|affected|verification|separate)\W+){0,3}\b(?:run|test|suite|job|command|process|build|check|lint|typecheck)\b/i;
const PEER_LAUNCH_BEFORE_STATUS_RE =
  /\b(?:the\s+)?(?:peer|agent|worker|member)\s+su-[a-z0-9-]{4,}(?:\/thread-post\d+)?\b[^.!?;\n]{0,100}\b(?:launched|started|ran|executed|spawned|submitted)\b/i;
const PEER_LAUNCH_AFTER_STATUS_RE =
  /\b(?:launched|started|ran|executed|spawned|submitted)\b[^.!?;\n]{0,100}\bby\s+(?:the\s+)?(?:peer|agent|worker|member)\s+su-[a-z0-9-]{4,}(?:\/thread-post\d+)?\b/i;
const COMPLETED_RUN_RE =
  /\b(?:completed|finished|exited|exit\s*(?:code)?\s*\d+|job\s+end|task\s+end|ended|passed|failed)\b/i;
const READ_EVIDENCE_RE =
  /\b(?:read|inspected|reviewed|checked|tailed|parsed)\b[^;\n]{0,120}\b(?:log|output|result|artifact|capture)\b|\b(?:log|output|result|artifact|capture)\b[^;\n]{0,120}\b(?:was|were|is|are|has been|have been)?\s*(?:read|inspected|reviewed|checked|tailed|parsed)\b/i;
const UNRELATED_RUN_EVIDENCE_RE =
  /\b(?:separate|different|previous|earlier|historical|another)\s+(?:run|test|suite|job|command|process|build|check|lint|typecheck|log|output|result)\b/i;

function sentenceRange(text: string, index: number, length: number): { start: number; end: number } {
  let start = 0;
  let end = text.length;
  for (const boundary of text.matchAll(new RegExp(SENTENCE_BOUNDARY_RE.source, 'g'))) {
    const boundaryStart = boundary.index ?? 0;
    const boundaryEnd = boundaryStart + boundary[0].length;
    if (boundaryStart < index) {
      start = boundaryEnd;
    } else if (boundaryStart >= index + length) {
      end = boundaryStart;
      break;
    }
  }
  return { start, end };
}

function isRunScopedLaunch(text: string, index: number, length: number): boolean {
  const { start, end } = sentenceRange(text, index, length);
  const before = text.slice(Math.max(start, index - 80), index);
  const after = text.slice(index + length, Math.min(end, index + length + 80));
  return RUN_SUBJECT_BEFORE_IN_FLIGHT_RE.test(before) || RUN_SUBJECT_AFTER_LAUNCH_RE.test(after);
}

/** A run explicitly attributed to another agent is not the checkpoint writer's unread run. */
function isPeerAttributedRun(text: string, index: number, length: number): boolean {
  const { start, end } = sentenceRange(text, index, length);
  const clause = text.slice(start, end);
  return PEER_LAUNCH_BEFORE_STATUS_RE.test(clause) || PEER_LAUNCH_AFTER_STATUS_RE.test(clause);
}

/**
 * A concrete run reference with nearby completion and read evidence is measured
 * evidence, not an unread prediction. Keep the window local, require the same
 * reference set, and refuse to borrow evidence across a second in-flight signal
 * or an explicitly separate/historical run.
 */
function isCompletedAndReadRun(
  text: string,
  range: { start: number; end: number },
  match: RegExpMatchArray,
  scopedMatches: RegExpMatchArray[],
): boolean {
  const refs = collect(text.slice(range.start, range.end), RUN_REF_RE, false);
  if (refs.length === 0) return false;

  const windowStart = Math.max(0, range.start - 180);
  const windowEnd = Math.min(text.length, range.end + 180);
  const context = text.slice(windowStart, windowEnd);
  const contextRefs = collect(context, RUN_REF_RE, false);
  if (contextRefs.some((ref) => !refs.includes(ref))) return false;

  const matchStart = match.index ?? 0;
  if (scopedMatches.some((candidate) => candidate !== match && Math.abs((candidate.index ?? 0) - matchStart) <= 180)) {
    return false;
  }
  if (UNRELATED_RUN_EVIDENCE_RE.test(context)) return false;
  return COMPLETED_RUN_RE.test(context) && READ_EVIDENCE_RE.test(context);
}

function runReferenceRange(text: string, index: number, length: number): { start: number; end: number } | null {
  const range = sentenceRange(text, index, length);
  const hasReference = (value: string) => new RegExp(RUN_REF_RE.source, RUN_REF_RE.flags).test(value);
  if (hasReference(text.slice(range.start, range.end))) return range;

  // An explicitly attached output clause names that same run. A completed
  // run in another clause must remain unlinked, even within one sentence.
  const separator = /^[.!?;]?\s*/.exec(text.slice(range.end))?.[0] ?? '';
  const nextStart = range.end + separator.length;
  if (!/^(?:handle|output|log)(?:\s*:|\s+at\b)/i.test(text.slice(nextStart))) return null;
  // A labeled tool handle can contain semicolon-separated fields, e.g.
  // `Handle: run_in_background:true; bash_id:abc123`. Keep that explicit
  // metadata together even though semicolons otherwise delimit clauses.
  const attachedTail = text.slice(nextStart);
  const terminal = /[\n]|[.!?](?=\s|$)/.exec(attachedTail);
  const nextEnd = terminal ? nextStart + terminal.index : text.length;
  return hasReference(text.slice(nextStart, nextEnd)) ? { start: range.start, end: nextEnd } : null;
}

/** Negation immediately governing this status is not an unread admission.
 * Keep the match local: a completed result elsewhere must not suppress a
 * separate pending run, and `not yet read` is itself an affirmative signal. */
function isNegatedRunStatus(text: string, index: number): boolean {
  const clauseStart = sentenceRange(text, index, 0).start;
  const before = text.slice(Math.max(clauseStart, index - 120), index);
  const directNegation = /\b(?:not|never|no longer|(?:is|are|was|were|has|have|had|did|does|do|can|could|would|should)n['’]t)\s+(?:(?:currently|actively|actually|still)\s+){0,2}["'`“‘]?\s*$/i;
  // Evidence qualifiers can sit between the negator and launch status ("not
  // proven launched"). Do not treat that uncertainty as an affirmative run;
  // `not yet read` remains a positive unread signal because it has no qualifier.
  const unprovenStatus = /\b(?:not|never)\s+(?:(?:currently|actively|actually|still|yet)\s+){0,2}(?:proven|confirmed|verified|established)\s+(?:(?:to|be|have|been)\s+){0,3}$/i;
  // Status phrases often put the negator before the run subject ("No jobs still
  // running"). The old check only handled a negator immediately before the
  // matched phrase, so it treated that completed-status sentence as unread.
  const noRunSubject = /\b(?:no|zero)\s+(?:agent|agents|fleet|fleets|run|runs|test|tests|suite|suites|job|jobs|command|commands|process|processes|build|builds|check|checks|lint|typecheck|typechecks)(?:\s+\w+){0,2}\s+(?:(?:is|are|was|were|has|have|had)\s+)?["'`“‘]?\s*$/i;
  // EI-26699409305176974: inventory notes often negate coordinated subjects,
  // e.g. "No product code or runtime launched". Keep the conjunction and its
  // subjects explicit so a later affirmative clause is never swallowed.
  const noCoordinatedSubject = /\bno\s+(?:product\s+)?(?:code|runtime|run|test|job|process|build)(?:\s+(?:or|and)\s+(?:code|runtime|run|test|job|process|build)){1,2}\s+(?:(?:is|are|was|were|has|have|had|been)\s+){0,2}$/i;
  // Some launch statements negate a longer subject ("no parallel implementation
  // repair run was launched"). Keep this bounded to the current clause so a later
  // affirmative launch after "but" remains actionable.
  const noLongSubject = /\b(?:no|zero)(?:\s+[\w'-]+){1,5}\s+(?:(?:is|are|was|were|has|have|had|been)\s+)?\s*$/i;
  return directNegation.test(before) || unprovenStatus.test(before) || noRunSubject.test(before) || noLongSubject.test(before) || noCoordinatedSubject.test(before);
}

/** A proposed scenario or conditional is not a statement that a run exists.
 * This is clause-local, rather than excluding an entire Next section: a
 * successor still needs a warning for "Next: read the suite still running". */
function isHypotheticalRunStatus(text: string, index: number): boolean {
  const boundary = Math.max(...['\n', '.', ';', '!', '?'].map((char) => text.lastIndexOf(char, index - 1)));
  const before = text.slice(Math.max(boundary + 1, index - 160), index);
  if (/\b(?:but|however|now|currently|actually)\b/i.test(before)) return false;
  return /\b(?:proposed|hypothetical|future|planned)\s+scenario\b/i.test(before)
    || /\b(?:if|unless)\b[^.!?;\n]{0,120}$/i.test(before);
}

/**
 * Describe a checkpoint body that reports a launched-but-unread run in prose while
 * storing no `checks` rows.
 *
 * @param body            the checkpoint prose SUPPLIED BY THIS CALL (not the merged
 *                        stored note) — the same choice `absenceLint` makes, so a
 *                        later checks-only patch is not re-flagged for old prose.
 * @param storedChecks    how many `## Checks` rows the FINAL stored note ended up
 *                        with. Any row at all suppresses: the writer has clearly
 *                        found the affordance, and this advisory exists only to
 *                        point at it.
 * @returns the advisory, or `null` when there is nothing to say.
 */
export function describeUnreadRun(
  body: string | null | undefined,
  storedChecks: number,
): UnreadRunAdvisory | null {
  if (storedChecks > 0) return null;
  const text = (body ?? '').trim();
  if (!text) return null;

  const inFlightText = withoutJsonValues(withoutHistoricalQuotations(text));
  const scopedMatches = [...inFlightText.matchAll(new RegExp(IN_FLIGHT_RE.source, IN_FLIGHT_RE.flags))]
    .filter((match) => {
      const index = match.index ?? 0;
      if (isNegatedRunStatus(inFlightText, index) || isHypotheticalRunStatus(inFlightText, index)) return false;
      if (/^in[-\s]flight$/i.test(match[0]) && !isRunScopedInFlight(inFlightText, index, match[0].length)) {
        return false;
      }
      if (/^launched$/i.test(match[0]) && !isRunScopedLaunch(inFlightText, index, match[0].length)) return false;
      return true;
    });
  const anchoredMatches = scopedMatches.flatMap((match) => {
    const index = match.index ?? 0;
    const range = runReferenceRange(inFlightText, index, match[0].length);
    if (!range || isPeerAttributedRun(inFlightText, index, match[0].length)) return [];
    if (isCompletedAndReadRun(inFlightText, range, match, scopedMatches)) return [];
    return [{ match, range }];
  });
  // Retain an adjacent diagnosis as signal metadata once a concrete following
  // run admission has independently supplied the execution reference.
  const relevantMatches = scopedMatches.filter((match) =>
    anchoredMatches.some(({ match: anchored }) => anchored === match || (
      /^not yet diagnosed$/i.test(match[0]) &&
      (anchored.index ?? 0) > (match.index ?? 0) &&
      /^[.!?\s]*(?:run|test|suite|job|command|process|build|check|lint|typecheck)\b[^.!?\n]{0,80}$/i.test(
        inFlightText.slice((match.index ?? 0) + match[0].length, anchored.index),
      )
    )),
  );
  const inFlight = [...new Set(relevantMatches.map((match) => match[0].trim().toLowerCase()))].slice(0, MAX_SIGNALS);
  if (inFlight.length === 0) return null;
  const signalSentences = anchoredMatches.map(({ range }) => range);
  const runRefs = collect(inFlightText, RUN_REF_RE, false, (match) =>
    signalSentences.some(({ start, end }) => match.index >= start && match.index < end),
  );
  if (runRefs.length === 0) return null;

  return {
    flagged: true,
    note:
      'unread_run_lint: this checkpoint describes a run as launched or still in flight ' +
      '(' + inFlight.join(', ') + ' — ' + runRefs.join(', ') + ') and stores no check rows, so its ' +
      'status lines will reach your successor as prose it cannot tell apart from measurement. ' +
      'Pass `checks:[{ claim, recheck }]` and omit `verified` — that renders the row ? PREDICTED, ' +
      'so the next holder re-measures instead of trusting it. Add `verified:"<evidence>"` only for ' +
      'a result you actually read. Advisory only; the write was kept.',
    signals: { inFlight, runRefs },
  };
}

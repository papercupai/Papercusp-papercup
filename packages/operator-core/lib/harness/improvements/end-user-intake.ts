/**
 * end-user-intake.ts — the in-app "Report a problem" door
 * (unified-bug-pipeline-and-honest-queue-2026-10-05 P-011, D-046 pt 4).
 *
 * A thin wrapper over the ONE intake, `captureImprovement` (D-046 pt 1): it
 * classifies what a person typed as a bug, an idea or a note, sends bugs and
 * ideas through `captureImprovement` stamped `reporterKind: 'end-user'` with the
 * report context the app captured, and stores a note in memory as quoted,
 * untrusted end-user text. It never builds a work item itself, so redaction,
 * the error-signature fold, similarity folding and candidate admission all
 * apply to a person's report exactly as they do to an agent's.
 *
 * Classification is deliberately conservative: anything not clearly an idea or
 * an explicit note is a bug, so a real defect is never lost into memory. A report
 * that carries recent errors is always a bug. Agents never come through here;
 * they classify by choosing `kind` on improvements:capture.
 *
 * Out of scope here: the UI and transport that call this door (P-014), the
 * upstream path for installed copies (P-015), and the untrusted-input hardening
 * of quoted text (P-013).
 */

import { redactSensitiveText } from '../../sensitive-text';
import { getMemoryBackend } from '../../memory/backend';
import { PLATFORM_POT_SLUG } from '../../platform-pot-slug';
import { captureImprovement, type CaptureImprovementInput, type CaptureImprovementResult } from './capture-core';
import type { ReportContextInput } from './report-context';
import { END_USER_NOTE_HEADER, quoteEndUserText } from './untrusted-evidence';

export type EndUserReportClass = 'bug' | 'idea' | 'note';

export interface EndUserReportClassification {
  kind: EndUserReportClass;
  /** Which rule decided it, so a misclassification can be traced. */
  basis: 'recent-errors' | 'explicit-note' | 'defect-cue' | 'idea-cue' | 'ambiguous';
}

/** An explicit note: the person says up front it is for the record, not a request. */
const NOTE_PREFIX = /^\s*(note|fyi|for the record|just so you know|remember( that)?|heads[- ]up)\b\s*[:,-]?/i;

/** Wording that describes something going wrong. */
const DEFECT_CUE =
  /\b(errors?|crash(es|ed|ing)?|broken|breaks?|bugs?|fail(s|ed|ing|ure)?|exceptions?|stuck|freez(es|ing|e)|frozen|hangs?|hung|wrong|missing|disappear(s|ed)?|blank|not (working|loading|showing|saving|responding)|(does ?n['’]?t|did ?n['’]?t|wo ?n['’]?t|can ?n?['’]?t|cannot|unable to) \w+|undefined|null|404|500|timed? ?out)\b/i;

/** Wording that asks for something new rather than reporting a fault. */
const IDEA_CUE =
  /\b(it would be (nice|great|good|helpful)|would (love|like) (it|to|if)|could you (add|make|let)|can (you|we) (add|have|get)|please add|feature request|i wish|suggest(ion)?|idea|should (be able|support|let|have)|nice to have|how about)\b/i;

const MAX_TITLE = 120;
const MAX_NOTE = 2000;
/** Trusted filing actor, not a reporter identity or contact detail. */
export const ANONYMOUS_END_USER_FILER = 'system:anonymous-report';

export function classifyEndUserReport(text: string, ctx?: ReportContextInput | null): EndUserReportClassification {
  if (Array.isArray(ctx?.recentErrors) && ctx.recentErrors.length > 0) return { kind: 'bug', basis: 'recent-errors' };
  // A defect cue beats a note prefix: "FYI the export is broken" reports a bug.
  if (DEFECT_CUE.test(text)) return { kind: 'bug', basis: 'defect-cue' };
  if (NOTE_PREFIX.test(text)) return { kind: 'note', basis: 'explicit-note' };
  if (IDEA_CUE.test(text)) return { kind: 'idea', basis: 'idea-cue' };
  return { kind: 'bug', basis: 'ambiguous' };
}

export interface EndUserReportInput {
  /** What the person typed. */
  text: string;
  /** An optional title the door collected separately; derived from the text otherwise. */
  title?: string;
  /** The person's identity, when the app has one (kept on the row as createdBy). */
  reporterId?: string | null;
  /** What the app captured: version, screen, recent errors, log excerpt, screenshot ref. */
  reportContext?: ReportContextInput | null;
  /** 'harness:<slug>' for a specific Pot; omitted files under the platform Pot. */
  scope?: string;
  workspaceId?: string;
  /** Memory pool a note is written to. Defaults to the scope's harness pool, then the reporter. */
  noteScope?: string;
}

export type EndUserReportResult =
  | { routed: 'work-item'; classification: EndUserReportClassification; capture: CaptureImprovementResult }
  | { routed: 'memory'; classification: EndUserReportClassification; memoryIds: string[]; scope: string };

export interface EndUserIntakeDeps {
  capture: (input: CaptureImprovementInput) => Promise<CaptureImprovementResult>;
  rememberNote: (content: string, opts: { scope: string; metadata: Record<string, unknown> }) => Promise<string[]>;
}

export function defaultEndUserIntakeDeps(): EndUserIntakeDeps {
  return {
    capture: captureImprovement,
    rememberNote: async (content, opts) => {
      const { ids } = await getMemoryBackend().remember(content, {
        scope: opts.scope,
        kind: 'feedback',
        metadata: opts.metadata,
        // Stored as written: the extraction step would rephrase untrusted text.
        verbatim: true,
      });
      return ids;
    },
  };
}

function titleFrom(input: EndUserReportInput): string {
  const explicit = input.title?.trim();
  const source = explicit || input.text.split('\n').map((l) => l.trim()).find(Boolean) || 'End-user report';
  const stripped = source.replace(NOTE_PREFIX, '').trim() || source;
  return stripped.length > MAX_TITLE ? `${stripped.slice(0, MAX_TITLE - 1)}…` : stripped;
}

function noteScopeFor(input: EndUserReportInput): string | null {
  if (input.noteScope) return input.noteScope;
  if (input.scope?.startsWith('harness:')) return input.scope;
  if (input.reporterId) return input.reporterId;
  return null;
}

/**
 * Route one end-user report. Bugs and ideas go through the one intake; a note
 * goes to memory. A note with nowhere to be stored is filed as a bug instead of
 * being dropped.
 */
export async function intakeEndUserReport(
  input: EndUserReportInput,
  deps: EndUserIntakeDeps = defaultEndUserIntakeDeps(),
): Promise<EndUserReportResult> {
  const text = input.text ?? '';
  if (!text.trim()) throw new Error('an end-user report needs text');
  let classification = classifyEndUserReport(text, input.reportContext);

  if (classification.kind === 'note') {
    const scope = noteScopeFor(input);
    if (scope) {
      // P-013 (D-003): redact, then store only as a quoted-evidence block, the
      // same form captureImprovement gives a filed report.
      const redacted = redactSensitiveText(text.replace(NOTE_PREFIX, '').trim() || text.trim()).slice(0, MAX_NOTE);
      const content = quoteEndUserText(redacted, END_USER_NOTE_HEADER);
      const memoryIds = await deps.rememberNote(content, {
        scope,
        metadata: {
          source: 'end-user-report',
          untrusted: true,
          reporterId: input.reporterId ?? null,
          classification: classification.basis,
        },
      });
      return { routed: 'memory', classification, memoryIds, scope };
    }
    classification = { kind: 'bug', basis: 'ambiguous' };
  }

  const capture = await deps.capture({
    title: titleFrom(input),
    body: text,
    kind: classification.kind === 'idea' ? 'feature' : 'bug',
    reporterKind: 'end-user',
    sourceRole: 'human',
    ...(input.reportContext ? { reportContext: input.reportContext } : {}),
    // A null filer prevents independent acceptance from establishing its party
    // set. Attribute anonymous filings to this door without identifying anyone.
    createdBy: input.reporterId?.trim() || ANONYMOUS_END_USER_FILER,
    // Omitted scope files under the platform Pot. Left unset, captureImprovement
    // files under the workspace's operator scope instead, so an agent's report of
    // the same error (filed under the Pot) would never fold onto this one.
    scope: input.scope ?? `harness:${PLATFORM_POT_SLUG}`,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    foundDuring: 'end-user report',
    payloadExtra: { endUserIntake: { classification: classification.basis } },
  });
  return { routed: 'work-item', classification, capture };
}

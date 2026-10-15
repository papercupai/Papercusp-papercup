/**
 * resume-transcript-preflight.ts — "is there anything a resume/fork/convert can
 * actually OPEN?", shared by every consult launch path.
 *
 * Extracted from revive-responder.ts (plan consult-expert-routing-2026-09-22
 * P-003) when the fork/convert dispatcher became a second caller. It is a
 * FAIL-CLOSED preflight, and both callers depend on that: `adv_sessions` is only
 * a launch ledger, so an ended row can outlive both its native transcript and its
 * archive copy, and launching against one produces a 502-producing headless shell
 * rather than a responder.
 *
 * The on-disk check comes FIRST because a healthy transcript need not have an
 * archive row. If the file was retired, `rematerializeTranscript` restores from
 * the canonical archive and the check re-resolves beneath the exact restored root.
 */
import type { ResumeTarget } from '../agent-launch-core';
import type { TranscriptStreamKey } from '../session-transcript-remat';

export interface ConsultResumeTranscriptCheck {
  available: boolean;
  detail: string;
  /**
   * The exact native transcript resolved on disk or restored from the archive.
   * Claude forks analyze its tail; conversions validate it with the maintained
   * session-port adapter before spending a launch (WI-10007960).
   */
  transcriptPath?: string;
}

/**
 * Per-backend transcript location: how to find the native file, and which
 * archive key a restore would use. Shared by the restoring check and the
 * read-only selection probe so the two cannot disagree about a source.
 */
type TranscriptLocator =
  | { refusal: string }
  | { label: string; findNative: () => Promise<string | null>; streamKey: TranscriptStreamKey };

async function locateConsultTranscript(target: ResumeTarget): Promise<TranscriptLocator> {
  const agent = (target.agent ?? '').toLowerCase();
  if (agent === 'claude' || agent === 'claude-code') {
    if (!target.sessionId) return { refusal: 'Claude resume target has no native session id' };
    const sessionId = target.sessionId;
    const { findSessionTranscript } = await import('../claude-sessions');
    return {
      label: 'native transcript',
      findNative: () => findSessionTranscript(sessionId, { owner: target.ownerId }),
      streamKey: { kind: 'claude', sessionId, ...(target.ownerId ? { owner: target.ownerId } : {}) },
    };
  }

  if (agent === 'codex') {
    const [{ findCodexRolloutPath, findCodexRolloutPathByUuid }, { codexHomeForSessionKey }] = await Promise.all([
      import('../session-transcript-resolvers'),
      import('@papercusp/orchestrator/session-launch-dirs'),
    ]);
    const codexHome = codexHomeForSessionKey(target.advSessionId);
    const rolloutId = target.sessionId;
    return {
      label: 'Codex transcript',
      findNative: () => rolloutId
        ? findCodexRolloutPathByUuid(rolloutId, { homeOverride: codexHome })
        : findCodexRolloutPath(target.advSessionId, { homeOverride: codexHome }),
      streamKey: rolloutId
        ? { kind: 'codex-rollout', rolloutId }
        : { kind: 'codex-session-key', sessionKey: String(target.advSessionId) },
    };
  }

  if (agent === 'omp' || agent === 'pi') {
    if (!target.ompThreadId) return { refusal: 'OMP resume target has no thread id' };
    const threadId = target.ompThreadId;
    const { findOmpSessionPath } = await import('../session-transcript-resolvers');
    return {
      label: 'OMP transcript',
      findNative: () => findOmpSessionPath(threadId, { sessionKey: target.advSessionId }),
      streamKey: { kind: 'omp', threadId, sessionKey: target.advSessionId },
    };
  }

  return { refusal: `unsupported resume backend ${target.agent ?? '(unknown)'}` };
}

export async function checkConsultResumeTranscript(
  target: ResumeTarget,
): Promise<ConsultResumeTranscriptCheck> {
  try {
    const located = await locateConsultTranscript(target);
    if ('refusal' in located) return { available: false, detail: located.refusal };
    const existing = await located.findNative();
    if (existing) {
      return { available: true, detail: `${located.label} found at ${existing}`, transcriptPath: existing };
    }
    const { rematerializeTranscript } = await import('../session-transcript-remat');
    const restored = await rematerializeTranscript(located.streamKey);
    return restored.path
      ? {
          available: true,
          detail: `${located.label} restored from archive at ${restored.path}`,
          transcriptPath: restored.path,
        }
      : { available: false, detail: `${located.label} unavailable (${restored.reason})` };
  } catch (e) {
    return {
      available: false,
      detail: `transcript availability preflight failed: ${(e as Error)?.message ?? String(e)}`,
    };
  }
}

/** Result of the read-only selection probe. `dispatchable: null` is UNKNOWN. */
export interface ConsultTranscriptProbe {
  dispatchable: boolean | null;
  detail: string;
}

/**
 * READ-ONLY twin of {@link checkConsultResumeTranscript} for SELECTION
 * (WI-6554700010009982): could the dispatch walk open this source at all?
 * It finds the native file or a complete archive stamp, and never restores —
 * a selector probes every ranked candidate, and restoring each one would write
 * transcripts for sources that are never chosen.
 *
 * `false` only for a measured absence: no native file AND no archive row (or a
 * target the walk refuses identically, e.g. no session id). Every fault is
 * `null`, which a selector must treat as keep — the walk's own preflight stays
 * the authority at launch time.
 */
export async function probeConsultResumeTranscript(
  target: ResumeTarget,
  deps: { probeArchive?: (key: TranscriptStreamKey) => Promise<{ archived: boolean | null; reason: string }> } = {},
): Promise<ConsultTranscriptProbe> {
  try {
    const located = await locateConsultTranscript(target);
    if ('refusal' in located) return { dispatchable: false, detail: located.refusal };
    const existing = await located.findNative();
    if (existing) return { dispatchable: true, detail: `${located.label} found at ${existing}` };
    const probeArchive = deps.probeArchive ??
      (async (key: TranscriptStreamKey) => (await import('../session-transcript-remat')).probeTranscriptArchive(key));
    const archive = await probeArchive(located.streamKey);
    if (archive.archived === true) return { dispatchable: true, detail: `${located.label} restorable from archive` };
    if (archive.archived === false) {
      return { dispatchable: false, detail: `${located.label} absent on disk and ${archive.reason}` };
    }
    return { dispatchable: null, detail: `${located.label} absent on disk; archive ${archive.reason}` };
  } catch (e) {
    return { dispatchable: null, detail: `transcript probe failed: ${(e as Error)?.message ?? String(e)}` };
  }
}

/** Conversion has stricter source requirements than a native fork. Reuse the
 * port's bounded, fixed-high-water reader and exact backend adapter; never repair
 * or rewrite a source transcript to make it eligible. Inspection reacquires and
 * validates the source again at launch, so this preflight grants no authority. */
export async function checkConsultSessionPortTranscript(
  target: ResumeTarget,
  transcript: ConsultResumeTranscriptCheck,
): Promise<ConsultResumeTranscriptCheck> {
  if (target.role != null) {
    return { available: false, detail: 'session-port protocol v1 requires a plain tracked SU source' };
  }
  const agent = target.agent === 'claude-code' ? 'claude' : target.agent;
  const nativeId = agent === 'omp' ? target.ompThreadId ?? target.sessionId : target.sessionId;
  if (!['claude', 'codex', 'omp'].includes(agent ?? '') || !nativeId || !transcript.available || !transcript.transcriptPath) {
    return { available: false, detail: 'session-port preflight requires an exact supported native transcript' };
  }
  try {
    const [{ readStableLiveJsonl }, { adaptNativeSessionJsonl }] = await Promise.all([
      import('../session-port/source'),
      import('../session-port/native-adapter'),
    ]);
    const stable = await readStableLiveJsonl(transcript.transcriptPath);
    adaptNativeSessionJsonl(agent as 'claude' | 'codex' | 'omp', stable.bytes.toString('utf8'), nativeId);
    return { available: true, detail: 'exact source passed session-port transcript validation' };
  } catch (e) {
    return { available: false, detail: `session-port transcript preflight refused: ${(e as Error)?.message ?? String(e)}` };
  }
}

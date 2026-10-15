/**
 * problem-report.ts — the payload the desktop "Report a problem" dialog sends
 * (unified-bug-pipeline-and-honest-queue-2026-10-05 P-014, D-048 pts 2-3, D-013).
 *
 * The preview IS the payload. The dialog builds the payload here, renders that
 * object in its Review step, and posts the same object with `previewDigest`.
 * The route recomputes the digest and refuses a mismatch, and refuses any
 * payload this builder would not have produced (`isNormalizedProblemReport`).
 * So nothing the reporter did not see can ride along.
 *
 * Pure and browser-safe. It imports only `sensitive-text`, which has no imports,
 * and hashes with WebCrypto (`globalThis.crypto.subtle`), present in the webview
 * and in Node. Redaction runs here, on the device, before the preview is drawn;
 * the server redacts again (the one intake, and the attachment store).
 *
 * Anonymous by construction: the payload has no field for a name, an email or
 * an account. Status reaches the reporter through the install (P-016).
 */
import { redactSensitiveText } from '../../sensitive-text';

export const PROBLEM_REPORT_SCHEMA_VERSION = 1 as const;

/** The app name every desktop report carries. */
export const PROBLEM_REPORT_APP = 'papercusp-desktop' as const;

export const PROBLEM_REPORT_LIMITS = {
  /** "What went wrong?" is one sentence. */
  text: 280,
  appVersion: 120,
  route: 300,
  stateKeys: 40,
  stateKey: 80,
  stateValue: 300,
  recentErrors: 5,
  errorMessage: 500,
  errorSource: 120,
  logLines: 200,
  logLine: 500,
  screenshotBytes: 2 * 1024 * 1024,
} as const;

/**
 * URL params that are the dialog's own state rather than what the reporter was
 * looking at. `report` is the dialog's nuqs open flag (D-048 pt 1).
 */
export const PROBLEM_REPORT_OWN_PARAMS: ReadonlySet<string> = new Set(['report']);

export interface ProblemReportError {
  at: string | null;
  source: string | null;
  message: string;
}

export interface ProblemReportScreen {
  /** The route path (location.pathname). */
  route: string;
  /** User-meaningful UI state: the nuqs URL params, minus the dialog's own. */
  state: Record<string, string> | null;
}

export interface ProblemReportLogAttachment {
  kind: 'log';
  mime: 'text/plain';
  lineCount: number;
  content: string;
}

export interface ProblemReportPayload {
  schemaVersion: typeof PROBLEM_REPORT_SCHEMA_VERSION;
  text: string;
  context: {
    app: typeof PROBLEM_REPORT_APP;
    appVersion: string | null;
    screen: ProblemReportScreen | null;
    recentErrors: ProblemReportError[];
  };
  /** Only what the reporter ticked. Empty unless they opted in. */
  attachments: Array<ProblemReportLogAttachment | ProblemReportScreenshotAttachment>;
}

export interface ProblemReportScreenshotAttachment {
  kind: 'screenshot';
  mime: 'image/png';
  content: string;
}

/** Browser-safe decoder; transport bytes stay bound to the preview digest. */
export function decodeProblemScreenshot(content: string): Uint8Array {
  if (content.length > Math.ceil(PROBLEM_REPORT_LIMITS.screenshotBytes / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) {
    throw new Error('Screenshot is invalid or exceeds 2 MiB');
  }
  const decoded = atob(content);
  const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length > PROBLEM_REPORT_LIMITS.screenshotBytes || btoa(decoded) !== content ||
      !signature.every((byte, index) => bytes[index] === byte)) {
    throw new Error('Screenshot must be a PNG of at most 2 MiB');
  }
  return bytes;
}

/** What the dialog collects before building the payload. */
export interface ProblemReportDraft {
  text: string;
  appVersion?: string | null;
  route?: string | null;
  /** location.search, with or without the leading '?'. */
  search?: string | null;
  recentErrors?: ReadonlyArray<{ at?: string | null; source?: string | null; message: string }>;
  /** The opt-in tick (default off). */
  attachLog?: boolean;
  /** Candidate log lines; included only when attachLog is true. */
  logLines?: readonly string[];
  attachScreenshot?: boolean;
  screenshotDataUrl?: string | null;
}

function bounded(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  // Redact before cutting, so a cut can never leave half a secret behind.
  const cleaned = redactSensitiveText(value).trim();
  if (!cleaned) return null;
  return cleaned.length > limit ? cleaned.slice(0, limit) : cleaned;
}

/** One line: newlines and runs of whitespace collapse to a single space. */
function oneLine(value: unknown, limit: number): string | null {
  return bounded(typeof value === 'string' ? value.replace(/\s+/g, ' ') : value, limit);
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function buildScreen(route: unknown, search: unknown): ProblemReportScreen | null {
  const path = oneLine(route, PROBLEM_REPORT_LIMITS.route);
  if (!path) return null;
  let state: Record<string, string> | null = null;
  if (typeof search === 'string' && search.trim()) {
    const params = new URLSearchParams(search.trim().replace(/^\?/, ''));
    const kept: Record<string, string> = {};
    let count = 0;
    for (const [rawKey, rawValue] of params) {
      if (PROBLEM_REPORT_OWN_PARAMS.has(rawKey)) continue;
      if (count >= PROBLEM_REPORT_LIMITS.stateKeys) break;
      const key = oneLine(rawKey, PROBLEM_REPORT_LIMITS.stateKey);
      const value = oneLine(rawValue, PROBLEM_REPORT_LIMITS.stateValue);
      if (!key || value == null || key in kept) continue;
      kept[key] = value;
      count += 1;
    }
    if (count > 0) state = kept;
  }
  return { route: path, state };
}

function buildErrors(errors: ProblemReportDraft['recentErrors']): ProblemReportError[] {
  if (!Array.isArray(errors)) return [];
  const out: ProblemReportError[] = [];
  // The most recent errors are the useful ones: keep the tail.
  for (const raw of errors.slice(-PROBLEM_REPORT_LIMITS.recentErrors)) {
    if (!raw || typeof raw !== 'object') continue;
    const message = oneLine(raw.message, PROBLEM_REPORT_LIMITS.errorMessage);
    if (!message) continue;
    out.push({
      at: isoOrNull(raw.at),
      source: oneLine(raw.source, PROBLEM_REPORT_LIMITS.errorSource),
      message,
    });
  }
  return out;
}

function buildLogAttachment(lines: readonly string[] | undefined): ProblemReportLogAttachment | null {
  if (!Array.isArray(lines)) return null;
  const kept: string[] = [];
  for (const raw of lines.slice(-PROBLEM_REPORT_LIMITS.logLines)) {
    const line = oneLine(raw, PROBLEM_REPORT_LIMITS.logLine);
    if (line) kept.push(line);
  }
  if (kept.length === 0) return null;
  return { kind: 'log', mime: 'text/plain', lineCount: kept.length, content: kept.join('\n') };
}

/**
 * Build the exact payload the dialog previews and sends. Pure. Throws only when
 * the reporter wrote nothing, which the dialog prevents.
 */
export function buildProblemReport(draft: ProblemReportDraft): ProblemReportPayload {
  const text = oneLine(draft.text, PROBLEM_REPORT_LIMITS.text);
  if (!text) throw new Error('a problem report needs a sentence describing what went wrong');
  const log = draft.attachLog === true ? buildLogAttachment(draft.logLines) : null;
  let screenshot: ProblemReportScreenshotAttachment | null = null;
  if (draft.attachScreenshot === true && draft.screenshotDataUrl) {
    const prefix = 'data:image/png;base64,';
    if (!draft.screenshotDataUrl.startsWith(prefix)) throw new Error('Screenshot must be a PNG');
    const content = draft.screenshotDataUrl.slice(prefix.length);
    decodeProblemScreenshot(content);
    screenshot = { kind: 'screenshot', mime: 'image/png', content };
  }
  return {
    schemaVersion: PROBLEM_REPORT_SCHEMA_VERSION,
    text,
    context: {
      app: PROBLEM_REPORT_APP,
      appVersion: oneLine(draft.appVersion, PROBLEM_REPORT_LIMITS.appVersion),
      screen: buildScreen(draft.route, draft.search),
      recentErrors: buildErrors(draft.recentErrors),
    },
    attachments: [...(log ? [log] : []), ...(screenshot ? [screenshot] : [])],
  };
}

/**
 * Re-run the builder over a received payload. A payload the builder would have
 * produced comes back unchanged; anything else (unredacted text, over-long
 * fields, an extra state key the dialog strips) comes back different.
 */
export function renormalizeProblemReport(payload: ProblemReportPayload): ProblemReportPayload | null {
  try {
    const screen = payload.context.screen;
    const search = screen?.state ? new URLSearchParams(screen.state).toString() : null;
    const log = payload.attachments.find((attachment) => attachment.kind === 'log');
    const screenshot = payload.attachments.find((attachment) => attachment.kind === 'screenshot');
    return buildProblemReport({
      text: payload.text,
      appVersion: payload.context.appVersion,
      route: screen?.route ?? null,
      search,
      recentErrors: payload.context.recentErrors,
      attachLog: !!log,
      logLines: log ? log.content.split('\n') : [],
      attachScreenshot: !!screenshot,
      screenshotDataUrl: screenshot ? `data:image/png;base64,${screenshot.content}` : null,
    });
  } catch {
    return null;
  }
}

/** True when the payload is exactly what `buildProblemReport` would have produced. */
export function isNormalizedProblemReport(payload: ProblemReportPayload): boolean {
  if (payload.attachments.length > 2) return false;
  const again = renormalizeProblemReport(payload);
  return again !== null && canonicalJson(again) === canonicalJson(payload);
}

/**
 * Deterministic JSON: object keys sorted at every depth, array order kept,
 * `undefined` object members dropped (as JSON.stringify does). Two structurally
 * equal values always serialize to the same string.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value);
    return s === undefined ? 'null' : s;
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** 'sha256:<hex>' of the payload's canonical JSON. The binding between preview and send. */
export async function previewDigest(payload: ProblemReportPayload): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto (crypto.subtle) is unavailable; cannot bind the preview to the payload');
  const bytes = new TextEncoder().encode(canonicalJson(payload));
  const hash = new Uint8Array(await subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const b of hash) hex += b.toString(16).padStart(2, '0');
  return `sha256:${hex}`;
}

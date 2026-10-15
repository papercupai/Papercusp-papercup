/**
 * report-context.ts — the captured context block a filed bug carries
 * (unified-bug-pipeline-and-honest-queue-2026-10-05 P-010, D-001).
 *
 * Stored at `payload.reportContext` on a bug work item, beside the reporter
 * stamp (provenance.ts). It answers "what was the reporter looking at": the
 * app and the version THE REPORTER ran, the screen or URL state, recent errors,
 * a log excerpt and an optional screenshot reference.
 *
 * Why it is not the freshness envelope: `freshnessEnvelope` (createIssue)
 * records the operator runtime that PERSISTED the row. For an end-user report
 * from an installed desktop app, the reporter's own version can differ; this
 * block records the reporter side. For agent and watchdog filings the two agree,
 * and the builder fills the reporter side from the serving build.
 *
 * Bounded and redacted at the boundary: every string goes through the shared
 * `redactSensitiveText` and is cut to a fixed limit; a screenshot is stored only
 * as a reference, never inline bytes. Consent and on-device redaction for end
 * users (D-013) are the reporter door's job (P-014); P-013 adds the
 * untrusted-input rules. This module never rejects a filing — a malformed
 * field is dropped and named in `refused`.
 */

import { redactSensitiveText } from '../../sensitive-text';
import {
  CHAT_REPORTER_NOTE_HEADER,
  CHAT_THREAD_EXCERPT_HEADER,
  quoteEndUserText,
  quoteEndUserTitle,
} from './untrusted-evidence';

export const REPORT_CONTEXT_SCHEMA_VERSION = 1 as const;

/**
 * Bounds of the chat block (slack-messages-to-bug-reports-2026-10-05 P-005, D-012). The
 * excerpt and note are a person's chat text, so beyond redaction and bounds they are
 * stored QUOTED as untrusted evidence (unified D-003), and display names as one-line
 * quoted titles: whatever renders this block shows them as evidence, never instructions.
 */
export const REPORT_CHAT_LIMITS = {
  provider: 40,
  id: 120,
  name: 120,
  permalink: 2000,
  gesture: 40,
  note: 2000,
  threadExcerpt: 3000,
  attachments: 20,
  attachmentName: 200,
  attachmentMimetype: 120,
  attachmentUrl: 2000,
} as const;

export interface ReportChatPerson {
  /** The provider's user id. Recorded, never resolved to a Papercusp principal (Slack D-004). */
  externalUserId: string | null;
  /** The provider display name, as a one-line quoted title. */
  displayName: string | null;
}

export interface ReportChatAttachment {
  name: string | null;
  mimetype: string | null;
  size: number | null;
  /** A provider link to the file (https). Never the file's bytes or a private download URL. */
  url: string;
}

/** Where in a chat workspace a report came from, and who made it. */
export interface ReportChatContext {
  provider: string;
  workspace: { id: string | null; name: string | null };
  channel: { id: string | null; name: string | null };
  permalink: string | null;
  /** How the report was made (Slack: reaction, shortcut, mention, bug-channel, new-thread). */
  gesture: string | null;
  reportedAt: string | null;
  /** When the reported message was posted. */
  postedAt: string | null;
  /** The person who reported it (who reacted, used the shortcut, or posted in a bug channel). */
  reporter: ReportChatPerson | null;
  /** The person who wrote the reported message. */
  author: ReportChatPerson | null;
  /** The reporter's note from the report form, quoted as untrusted evidence. */
  note: string | null;
  /** A bounded excerpt of the thread, quoted as untrusted evidence. */
  threadExcerpt: string | null;
  attachments: ReportChatAttachment[];
  /** Whether the reporter consented to attaching the files themselves (Slack D-004). */
  attachmentConsent: boolean;
}

export const REPORT_CONTEXT_LIMITS = {
  app: 80,
  appVersion: 120,
  url: 2000,
  route: 300,
  stateKeys: 40,
  stateKey: 80,
  stateValue: 300,
  recentErrors: 10,
  errorMessage: 500,
  errorSource: 120,
  logExcerpt: 4000,
  screenshotRef: 300,
} as const;

export interface ReportContextError {
  at: string | null;
  source: string | null;
  message: string;
}

export interface ReportContextScreen {
  url: string | null;
  route: string | null;
  /** User-meaningful UI state (the nuqs URL params in Papercusp apps). */
  state: Record<string, string> | null;
}

export interface ReportContext {
  schemaVersion: typeof REPORT_CONTEXT_SCHEMA_VERSION;
  capturedAt: string;
  app: string;
  /** The version the REPORTER ran (see header). */
  appVersion: string | null;
  screen: ReportContextScreen | null;
  recentErrors: ReportContextError[];
  logExcerpt: string | null;
  screenshot: { ref: string } | null;
  /** Fields the builder filled itself rather than receiving from the reporter. */
  autoCaptured: string[];
  /** Fields cut to their bound. */
  truncated: string[];
  /** Fields dropped as malformed or disallowed (e.g. an inline screenshot). */
  refused: string[];
  /** Present only on a report made from a chat workspace (reporter kind 'chat'). */
  chat?: ReportChatContext;
}

/** What a filing door may hand in. Every field is optional. */
export interface ReportContextInput {
  app?: unknown;
  appVersion?: unknown;
  screen?: unknown;
  recentErrors?: unknown;
  logExcerpt?: unknown;
  screenshot?: unknown;
  /** A chat report's context (ReportChatContext shape, every field optional). */
  chat?: unknown;
}

/** The failing call a watchdog or agent captured, when there is one. */
export interface ReportContextFailure {
  toolName?: unknown;
  errorCode?: unknown;
  status?: unknown;
  message?: unknown;
}

function clean(v: unknown, limit: number, field: string, truncated: string[]): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = redactSensitiveText(v).trim();
  if (!trimmed) return null;
  if (trimmed.length > limit) {
    if (!truncated.includes(field)) truncated.push(field);
    return trimmed.slice(0, limit);
  }
  return trimmed;
}

function cleanScreen(v: unknown, truncated: string[], refused: string[]): ReportContextScreen | null {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) {
    refused.push('screen');
    return null;
  }
  const s = v as Record<string, unknown>;
  const url = clean(s.url, REPORT_CONTEXT_LIMITS.url, 'screen.url', truncated);
  const route = clean(s.route, REPORT_CONTEXT_LIMITS.route, 'screen.route', truncated);
  let state: Record<string, string> | null = null;
  if (s.state && typeof s.state === 'object' && !Array.isArray(s.state)) {
    const entries = Object.entries(s.state as Record<string, unknown>);
    if (entries.length > REPORT_CONTEXT_LIMITS.stateKeys) truncated.push('screen.state');
    state = {};
    for (const [k, raw] of entries.slice(0, REPORT_CONTEXT_LIMITS.stateKeys)) {
      const key = clean(k, REPORT_CONTEXT_LIMITS.stateKey, 'screen.state', truncated);
      const value = clean(
        typeof raw === 'string' ? raw : raw == null ? null : JSON.stringify(raw),
        REPORT_CONTEXT_LIMITS.stateValue,
        'screen.state',
        truncated,
      );
      if (key && value != null) state[key] = value;
    }
    if (Object.keys(state).length === 0) state = null;
  } else if (s.state != null) {
    refused.push('screen.state');
  }
  if (!url && !route && !state) return null;
  return { url, route, state };
}

function cleanErrors(v: unknown, truncated: string[], refused: string[]): ReportContextError[] {
  if (v == null) return [];
  if (!Array.isArray(v)) {
    refused.push('recentErrors');
    return [];
  }
  if (v.length > REPORT_CONTEXT_LIMITS.recentErrors) truncated.push('recentErrors');
  const out: ReportContextError[] = [];
  // The most RECENT errors are the useful ones: keep the tail.
  for (const raw of v.slice(-REPORT_CONTEXT_LIMITS.recentErrors)) {
    const e = typeof raw === 'string' ? { message: raw } : raw;
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    const message = clean(r.message, REPORT_CONTEXT_LIMITS.errorMessage, 'recentErrors', truncated);
    if (!message) continue;
    out.push({
      at: typeof r.at === 'string' ? r.at : null,
      source: clean(r.source, REPORT_CONTEXT_LIMITS.errorSource, 'recentErrors', truncated),
      message,
    });
  }
  return out;
}

function failureAsError(failure: ReportContextFailure | null | undefined, at: string, truncated: string[]): ReportContextError | null {
  if (!failure) return null;
  const head = [failure.toolName, failure.errorCode ?? failure.status]
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    .join(' ');
  const body = typeof failure.message === 'string' ? failure.message : '';
  const message = clean([head, body].filter(Boolean).join(': '), REPORT_CONTEXT_LIMITS.errorMessage, 'recentErrors', truncated);
  if (!message) return null;
  const source = clean(failure.toolName, REPORT_CONTEXT_LIMITS.errorSource, 'recentErrors', truncated);
  return { at, source, message };
}

function cleanIso(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function cleanHttps(v: unknown, limit: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^https:\/\/\S+$/i.test(s) || s.length > limit) return null;
  return s;
}

/** A one-line name a person chose (a display name): redacted, bounded, quoted as a title. */
function quotedName(v: unknown, field: string, truncated: string[]): string | null {
  const name = clean(typeof v === 'string' ? v.replace(/\s+/g, ' ') : v, REPORT_CHAT_LIMITS.name, field, truncated);
  return name ? quoteEndUserTitle(name) : null;
}

function cleanPerson(v: unknown, field: string, truncated: string[], refused: string[]): ReportChatPerson | null {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) {
    refused.push(field);
    return null;
  }
  const p = v as Record<string, unknown>;
  const externalUserId = clean(p.externalUserId, REPORT_CHAT_LIMITS.id, `${field}.externalUserId`, truncated);
  const displayName = quotedName(p.displayName, `${field}.displayName`, truncated);
  return externalUserId || displayName ? { externalUserId, displayName } : null;
}

function cleanAttachments(v: unknown, truncated: string[], refused: string[]): ReportChatAttachment[] {
  if (v == null) return [];
  if (!Array.isArray(v)) {
    refused.push('chat.attachments');
    return [];
  }
  if (v.length > REPORT_CHAT_LIMITS.attachments) truncated.push('chat.attachments');
  const out: ReportChatAttachment[] = [];
  for (const raw of v.slice(0, REPORT_CHAT_LIMITS.attachments)) {
    const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    const url = a ? cleanHttps(a.url, REPORT_CHAT_LIMITS.attachmentUrl) : null;
    // A link only: a file without one, or with an inline/non-https URL, is dropped and named.
    if (!a || !url) {
      if (!refused.includes('chat.attachments')) refused.push('chat.attachments');
      continue;
    }
    const size = typeof a.size === 'number' && Number.isFinite(a.size) && a.size >= 0 ? Math.floor(a.size) : null;
    out.push({
      name: clean(a.name, REPORT_CHAT_LIMITS.attachmentName, 'chat.attachments', truncated),
      mimetype: clean(a.mimetype, REPORT_CHAT_LIMITS.attachmentMimetype, 'chat.attachments', truncated),
      size,
      url,
    });
  }
  return out;
}

/** Text a person wrote in chat: redacted, bounded, then stored as quoted evidence. */
function quotedChatText(
  v: unknown,
  limit: number,
  field: string,
  header: typeof CHAT_REPORTER_NOTE_HEADER | typeof CHAT_THREAD_EXCERPT_HEADER,
  truncated: string[],
): string | null {
  const text = clean(v, limit, field, truncated);
  return text ? quoteEndUserText(text, header) : null;
}

/**
 * The chat block (Slack D-012). Null when the door sent none; an unusable block is
 * refused as a whole ('chat'), never half-kept.
 */
function cleanChat(v: unknown, truncated: string[], refused: string[]): ReportChatContext | null {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) {
    refused.push('chat');
    return null;
  }
  const c = v as Record<string, unknown>;
  const provider = clean(c.provider, REPORT_CHAT_LIMITS.provider, 'chat.provider', truncated);
  if (!provider) {
    refused.push('chat');
    return null;
  }
  const place = (raw: unknown, field: string) => {
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    return {
      id: clean(r.id, REPORT_CHAT_LIMITS.id, `${field}.id`, truncated),
      name: quotedName(r.name, `${field}.name`, truncated),
    };
  };
  const permalinkRaw = c.permalink;
  const permalink = cleanHttps(permalinkRaw, REPORT_CHAT_LIMITS.permalink);
  if (permalinkRaw != null && !permalink) refused.push('chat.permalink');
  return {
    provider,
    workspace: place(c.workspace, 'chat.workspace'),
    channel: place(c.channel, 'chat.channel'),
    permalink,
    gesture: clean(c.gesture, REPORT_CHAT_LIMITS.gesture, 'chat.gesture', truncated),
    reportedAt: cleanIso(c.reportedAt),
    postedAt: cleanIso(c.postedAt),
    reporter: cleanPerson(c.reporter, 'chat.reporter', truncated, refused),
    author: cleanPerson(c.author, 'chat.author', truncated, refused),
    note: quotedChatText(c.note, REPORT_CHAT_LIMITS.note, 'chat.note', CHAT_REPORTER_NOTE_HEADER, truncated),
    threadExcerpt: quotedChatText(
      c.threadExcerpt,
      REPORT_CHAT_LIMITS.threadExcerpt,
      'chat.threadExcerpt',
      CHAT_THREAD_EXCERPT_HEADER,
      truncated,
    ),
    attachments: cleanAttachments(c.attachments, truncated, refused),
    attachmentConsent: c.attachmentConsent === true,
  };
}

/**
 * Build the context block for a filing. Pure; never throws.
 *
 * `defaults` is the serving side (app + build) and fills whatever the reporter
 * did not send. `failure` is the captured failing call, used as the recent
 * error when the reporter sent none.
 */
export function buildReportContext(args: {
  input?: ReportContextInput | null;
  defaults: { app: string; appVersion: string | null };
  failure?: ReportContextFailure | null;
  capturedAt: string;
}): ReportContext {
  const truncated: string[] = [];
  const refused: string[] = [];
  const autoCaptured: string[] = [];
  const input = args.input && typeof args.input === 'object' ? args.input : {};

  let app = clean(input.app, REPORT_CONTEXT_LIMITS.app, 'app', truncated);
  if (!app) {
    app = args.defaults.app.slice(0, REPORT_CONTEXT_LIMITS.app);
    autoCaptured.push('app');
  }
  let appVersion = clean(input.appVersion, REPORT_CONTEXT_LIMITS.appVersion, 'appVersion', truncated);
  if (!appVersion && args.defaults.appVersion) {
    appVersion = args.defaults.appVersion.slice(0, REPORT_CONTEXT_LIMITS.appVersion);
    autoCaptured.push('appVersion');
  }

  const screen = cleanScreen(input.screen, truncated, refused);

  let recentErrors = cleanErrors(input.recentErrors, truncated, refused);
  if (recentErrors.length === 0) {
    const fromFailure = failureAsError(args.failure, args.capturedAt, truncated);
    if (fromFailure) {
      recentErrors = [fromFailure];
      autoCaptured.push('recentErrors');
    }
  }

  const logExcerpt = clean(input.logExcerpt, REPORT_CONTEXT_LIMITS.logExcerpt, 'logExcerpt', truncated);

  let screenshot: { ref: string } | null = null;
  if (input.screenshot != null) {
    const raw = input.screenshot;
    const ref = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? (raw as Record<string, unknown>).ref : null;
    // A reference only: inline image bytes would put an unbounded, unredactable
    // blob on the work item.
    if (typeof ref === 'string' && ref.trim() && !/^data:/i.test(ref.trim()) && ref.trim().length <= REPORT_CONTEXT_LIMITS.screenshotRef) {
      screenshot = { ref: ref.trim() };
    } else {
      refused.push('screenshot');
    }
  }

  const chat = cleanChat(input.chat, truncated, refused);

  return {
    schemaVersion: REPORT_CONTEXT_SCHEMA_VERSION,
    capturedAt: args.capturedAt,
    app,
    appVersion,
    screen,
    recentErrors,
    logExcerpt,
    screenshot,
    autoCaptured,
    truncated,
    refused,
    ...(chat ? { chat } : {}),
  };
}

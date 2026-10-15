/**
 * ReportProblemDialog — the desktop "Report a problem" door
 * (unified-bug-pipeline-and-honest-queue-2026-10-05 P-014, D-048, D-013).
 *
 * Step 1: one sentence, "What went wrong?". Step 2, Review: the EXACT payload
 * that will be sent (built by problem-report.ts, redacted on the device), with
 * the opt-in "Attach recent log lines" tick, default off. Send posts that same
 * object plus its digest; the server refuses anything else. Anonymous.
 *
 * Open state is the `?report=true` URL param (nuqs), so agents can open it with
 * ui:dispatch; the palette command report.problem and the mod+shift+b shortcut
 * set the same param.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import './shortcuts-cheat-sheet.css';
import { parseAsBoolean, parseAsString, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { toast } from 'sonner';
import { Checkbox } from '../harness/Checkbox';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import type { WorkItemRow } from '../adv/harnesses/WorkItemsPanel';
import type { WorkItemDetailRow } from '../adv/harnesses/DetailPanel';
import { CHAT_WORK_ITEM_POPUP_PARAM, encodeScopedRef } from './chat/chat-ref-popup-params';
import { PLATFORM_POT_SLUG } from '@papercusp/operator-core/lib/platform-pot-slug';
import { useShortcutAction } from '../../lib/hotkeys';
import {
  PROBLEM_REPORT_LIMITS,
  buildProblemReport,
  previewDigest,
  decodeProblemScreenshot,
  type ProblemReportPayload,
} from '@papercusp/operator-core/lib/harness/improvements/problem-report';
import {
  installClientReportRing,
  readClientReportRing,
  type ClientReportError,
} from '@papercusp/operator-core/lib/client-report-ring';

// Record from app start, so the errors that led to a report are in the ring.
installClientReportRing();

interface Captured {
  route: string;
  search: string;
  errors: ClientReportError[];
  logLines: string[];
}

type SendResult = {
  routed: 'work-item' | 'memory';
  id: string | null;
  delivery?: 'queued-for-federation';
  attachments?: Array<{ kind: string; ok: boolean; reason?: string; delivery?: 'local-only' | 'upstream-received' }>;
};

export function ReportProblemReceipt({ sent }: { sent: SendResult }) {
  return <>
    <p>Thanks — {sent.routed === 'memory' ? 'your note was saved' : 'your report was filed'}{sent.id ? ` as ${sent.id}` : ''}.</p>
    {sent.delivery === 'queued-for-federation' && <p>Queued for upstream delivery. Upstream receipt has not yet been confirmed.</p>}
    {sent.attachments?.map((attachment, index) => {
      const name = attachment.kind === 'screenshot' ? 'Screenshot' : 'Log attachment';
      return (
      <p key={index} role={attachment.ok ? undefined : 'alert'}>
        {attachment.ok
          ? attachment.delivery === 'upstream-received'
            ? `${name} received upstream.`
            : attachment.delivery === 'local-only' || sent.delivery === 'queued-for-federation'
            ? `${name} saved on this install. It has not been sent upstream.`
            : `${name} saved.`
          : `${name} could not be saved: ${attachment.reason ?? 'unknown error'}. Your report remains filed.`}
      </p>
    ); })}
  </>;
}

export default function ReportProblemDialog() {
  const workspaceId = useWorkspaceId();
  const receiptsKey = `papercusp.report-receipts.${workspaceId}`;
  const [receiptIds, setReceiptIds] = useState<string[]>([]);
  const [, setWorkItemPopup] = useQueryState(CHAT_WORK_ITEM_POPUP_PARAM, parseAsString);
  useEffect(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(receiptsKey) ?? '[]');
      setReceiptIds(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []);
    } catch { setReceiptIds([]); }
  }, [receiptsKey]);
  const [open, setOpen] = useQueryState('report', parseAsBoolean.withDefault(false));
  const [text, setText] = useState('');
  const [attachLog, setAttachLog] = useState(false);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [attachScreenshot, setAttachScreenshot] = useState(false);
  const [capturingScreenshot, setCapturingScreenshot] = useState(false);
  const screenshotGeneration = useRef(0);
  const [captured, setCaptured] = useState<Captured | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<SendResult | null>(null);

  useShortcutAction('report.problem', () => {
    void setOpen(!open);
  }, { enableOnFormTags: ['INPUT', 'TEXTAREA'] });

  useEffect(() => {
    if (!open) {
      screenshotGeneration.current += 1;
      setCapturingScreenshot(false);
      setText('');
      setAttachLog(false);
      setScreenshot(null);
      setAttachScreenshot(false);
      setCaptured(null);
      setError(null);
      setSent(null);
      return;
    }
    let cancelled = false;
    fetch('/api/desktop/version', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((v: { appVersion?: string; sidecarSha?: string } | null) => {
        if (!cancelled && v?.appVersion) setAppVersion(v.sidecarSha ? `${v.appVersion} (${v.sidecarSha})` : v.appVersion);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  // The preview IS the payload: the Review step renders this object and Send posts it.
  const payload: ProblemReportPayload | null = useMemo(() => {
    if (!captured || !text.trim()) return null;
    return buildProblemReport({
      text,
      appVersion,
      route: captured.route,
      search: captured.search,
      recentErrors: captured.errors,
      attachLog,
      logLines: captured.logLines,
      attachScreenshot,
      screenshotDataUrl: screenshot,
    });
  }, [captured, text, appVersion, attachLog, screenshot, attachScreenshot]);

  const captureScreenshot = async () => {
    const generation = ++screenshotGeneration.current;
    setCapturingScreenshot(true);
    setError(null);
    setAttachScreenshot(false);
    try {
      const { toPng } = await import('html-to-image');
      const image = await toPng(document.body, {
        width: window.innerWidth, height: window.innerHeight, pixelRatio: 1,
        filter: (node) => !(node instanceof Element && node.closest('[data-report-capture-exclude]')),
      });
      decodeProblemScreenshot(image.replace(/^data:image\/png;base64,/, ''));
      if (generation === screenshotGeneration.current) setScreenshot(image);
    } catch {
      if (generation === screenshotGeneration.current) {
        setScreenshot(null);
        setError('The screenshot could not be captured. You can still send your report.');
      }
    } finally {
      if (generation === screenshotGeneration.current) setCapturingScreenshot(false);
    }
  };

  const review = () => {
    const ring = readClientReportRing();
    setCaptured({ route: window.location.pathname, search: window.location.search, ...ring });
  };

  const send = async () => {
    if (!payload) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch('/api/desktop/report-problem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload, previewDigest: await previewDigest(payload) }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ? `${body.error} (HTTP ${res.status})` : `HTTP ${res.status}`);
      setSent({ routed: body.routed, id: body.id ?? null, delivery: body.delivery, attachments: body.attachments });
      if (body.routed === 'work-item' && typeof body.id === 'string') {
        setReceiptIds((previous) => {
          const ids = [...new Set([...previous, body.id as string])];
          try { localStorage.setItem(receiptsKey, JSON.stringify(ids)); } catch { /* status still works for this live session */ }
          return ids;
        });
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setSending(false);
    }
  };

  return (
    <>
    {receiptIds.map((id) => <ReportProblemUpdate key={`${workspaceId}:${id}`} id={id} workspaceId={workspaceId} onOpen={() => void setWorkItemPopup(encodeScopedRef(PLATFORM_POT_SLUG, id))} />)}
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) void setOpen(false); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="kbd-cheat-overlay" data-report-capture-exclude />
        <Dialog.Content
          aria-label="Report a problem"
          data-testid="report-problem-dialog"
          data-report-capture-exclude
          style={{
            position: 'fixed', top: '12vh', left: '50%', transform: 'translateX(-50%)',
            width: 'min(640px, 92vw)', maxHeight: '76vh', overflow: 'hidden auto',
            background: 'var(--pc-surface, #16181d)', color: 'var(--pc-text, #e5e7eb)',
            border: '1px solid var(--pc-border, #2a2e37)', borderRadius: 10, padding: 16,
            zIndex: 1000, boxShadow: '0 18px 50px rgba(0,0,0,.5)', fontSize: 13,
          }}
        >
          <Dialog.Title style={{ fontSize: 14, margin: '0 0 6px' }}>Report a problem</Dialog.Title>
          <Dialog.Description style={{ fontSize: 11, opacity: 0.6, margin: '0 0 10px' }}>
            Nothing is sent until you press Send. No name, email or account is included.
          </Dialog.Description>

          {sent ? (
            <div data-testid="report-problem-sent">
              {sent.id && sent.routed === 'work-item' ? <button type="button" onClick={() => { void setOpen(false); void setWorkItemPopup(encodeScopedRef(PLATFORM_POT_SLUG, sent.id!)); }}>View report status</button> : null}
              <ReportProblemReceipt sent={sent} />
              <button type="button" onClick={() => void setOpen(false)}>Close</button>
            </div>
          ) : !captured ? (
            <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) review(); }}>
              <label style={{ display: 'block', marginBottom: 6 }} htmlFor="report-problem-text">What went wrong?</label>
              <input
                id="report-problem-text"
                data-testid="report-problem-text"
                autoFocus
                value={text}
                maxLength={PROBLEM_REPORT_LIMITS.text}
                onChange={(e) => setText(e.target.value)}
                placeholder="One sentence"
                style={{ width: '100%', padding: '6px 8px', boxSizing: 'border-box' }}
              />
              <div style={{ marginTop: 10, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => void setOpen(false)}>Cancel</button>
                <button type="submit" data-testid="report-problem-review" disabled={!text.trim()}>Review</button>
              </div>
            </form>
          ) : (
            <div>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '0 0 8px' }}>
                <Checkbox
                  id="report-problem-attach-log"
                  dataTestId="report-problem-attach-log"
                  ariaLabel="Attach recent log lines"
                  checked={attachLog}
                  onChange={setAttachLog}
                  disabled={sending}
                />
                Attach recent log lines ({captured.logLines.length})
              </label>
              <button type="button" disabled={capturingScreenshot || sending} onClick={() => void captureScreenshot()}>
                {capturingScreenshot ? 'Capturing screenshot…' : screenshot ? 'Capture again' : 'Capture screenshot'}
              </button>
              {screenshot && <div data-testid="report-problem-screenshot-preview">
                <img src={screenshot} alt="Screenshot preview" style={{ width: '100%', maxHeight: 240, objectFit: 'contain' }} />
                <label htmlFor="report-problem-attach-screenshot" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Checkbox id="report-problem-attach-screenshot" dataTestId="report-problem-attach-screenshot" ariaLabel="Attach this screenshot" checked={attachScreenshot} onChange={setAttachScreenshot} disabled={sending} />
                  Attach this screenshot
                </label>
                <p style={{ fontSize: 11 }}>Images are not redacted. Check the preview before attaching it.</p>
              </div>}
              <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 4 }}>This is exactly what will be sent:</div>
              <pre
                data-testid="report-problem-preview"
                style={{ maxHeight: '40vh', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, padding: 8, background: 'rgba(0,0,0,.25)', borderRadius: 6 }}
              >
                {payload ? JSON.stringify(payload, function (key, value) {
                  return key === 'content' && this?.kind === 'screenshot' ? '[Screenshot shown above]' : value;
                }, 2) : ''}
              </pre>
              {error ? <p role="alert" style={{ color: 'var(--bad)' }}>{error}</p> : null}
              <div style={{ marginTop: 10, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => setCaptured(null)}>Back</button>
                <button type="button" data-testid="report-problem-send" disabled={!payload || sending || capturingScreenshot} onClick={() => void send()}>
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    </>
  );
}

/** Existing sync invalidation is the subscription; no polling or contact address. */
export function ReportProblemUpdate({ id, workspaceId, onOpen }: { id: string; workspaceId: string; onOpen: () => void }) {
  const { data } = useSyncQuery<WorkItemDetailRow>({ queryName: 'workItems.detail', args: { harnessSlug: PLATFORM_POT_SLUG, id } });
  const report = data?.[0]?.reporterStatus;
  const event = report?.status === 'fixed' && report.release
    ? { key: `release:${report.release.completionRef}:${report.release.artifactCommit}`, text: report.label }
    : report?.followUp && !report.followUp.answer
      ? { key: `question:${report.followUp.question.id}`, text: report.followUp.question.text } : null;
  const eventKey = event?.key;
  const eventText = event?.text;
  useEffect(() => {
    if (!eventKey || !eventText) return;
    const key = `papercusp.report-notification.${workspaceId}.${id}.${eventKey}`;
    try { if (localStorage.getItem(key)) return; } catch { /* retain live notification */ }
    toast(eventText, { id: key, description: `Update on your report ${id}`, action: { label: 'View report', onClick: onOpen }, duration: Infinity });
    try { localStorage.setItem(key, 'shown'); } catch { /* toast id deduplicates within this session */ }
  }, [eventKey, eventText, id, workspaceId, onOpen]);
  return null;
}

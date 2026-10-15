'use client';

/**
 * TokensView — the Insights → Tokens subtab (B-TOK-UI,
 * token-tracking-plan-and-briefs-2026-06-20).
 *
 * The SIBLING of the SpendCard's single headline total: this surfaces the same
 * CACHE-INCLUSIVE spend (input + output + cache_read + cache_creation — the
 * B-TOK-2 fix for the ~5× undercount) broken DOWN by model, role, and day so the
 * owner can see WHERE the burn is. The 24h audit that motivated this plan found
 * opus = 90% of spend and cache-read = 82% of all tokens — both invisible in the
 * old input+output-only number.
 *
 * Self-fetching (the LearningTab `?lview` model): reads through the
 * `insights.tokens` sync resolver via useSyncQuery, scoped to ONE harness slug.
 * Fetch-on-mount + a manual Refresh, matching the /adv no-polling ethos. Degrades
 * to a clean empty state when the substrate has no samples yet (the resolver/loader
 * never 500s).
 *
 * Per-account attribution is NOT yet captured on agent_usage_samples (routing is
 * gateway-layer state), so the brief's "by account" axis renders an honest note
 * rather than a fabricated breakdown.
 */

import { useState, type CSSProperties, type ReactNode } from 'react';
import { Coins, RefreshCw, Cpu, UserRound, CalendarDays, Info } from 'lucide-react';
import { useSyncQuery } from '@papercusp/sync';
import type { TokensDashboardSnapshot, TokenGroupRow } from '@papercusp/operator-core/lib/harness-insights/card-types';
import { operatorUi, useOperatorWorkspaceLocation } from '@papercusp/operator-ui/seam';
import { Table } from '../Table';
import { Select } from '../Select';

// ─── number formatting (matches SpendCard's idiom) ──────────────────
function formatUsd(n: number): string {
  return n < 1 ? `$${n.toFixed(2)}` : n < 100 ? `$${n.toFixed(1)}` : `$${Math.round(n).toLocaleString()}`;
}
function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}
function pct(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  return `${Math.round((part / whole) * 100)}%`;
}

// ─── styles (CSS-var tokens, matching SpendCard / InsightsTab) ──────
const WRAP: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 16, padding: 16 };
const HEAD: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 };
const TITLE: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 600, color: 'var(--fg)' };
const SUB: CSSProperties = { fontSize: 12, color: 'var(--fg-dim)' };
const REFRESH: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12,
  border: '1px solid var(--border)', background: 'var(--bg-1)', color: 'var(--fg-dim)',
  borderRadius: 6, padding: '4px 8px', cursor: 'pointer',
};
const SCOREBOARD: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12 };
const STAT_CARD: CSSProperties = {
  border: '1px solid var(--border)', background: 'var(--bg-1)', borderRadius: 8, padding: 16,
  display: 'flex', flexDirection: 'column', gap: 2,
};
const STAT_VAL: CSSProperties = { fontSize: 22, fontWeight: 600, color: 'var(--fg)' };
const STAT_LABEL: CSSProperties = { fontSize: 11, color: 'var(--fg-dim)' };
const CARD: CSSProperties = {
  border: '1px solid var(--border)', background: 'var(--bg-1)', borderRadius: 8, padding: 16,
  display: 'flex', flexDirection: 'column', gap: 10,
};
const CARD_HEAD: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: 'var(--fg)' };
const ROW: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 };
const ROW_KEY: CSSProperties = { flex: '0 0 34%', color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const BAR_TRACK: CSSProperties = { flex: 1, height: 8, borderRadius: 4, background: 'var(--bg-2)', overflow: 'hidden' };
const ROW_NUM: CSSProperties = { flex: '0 0 auto', color: 'var(--fg-dim)', fontVariantNumeric: 'tabular-nums', minWidth: 56, textAlign: 'right' };
const NOTE: CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, lineHeight: 1.5,
  padding: '8px 12px', borderRadius: 6, background: 'var(--bg-2)', color: 'var(--fg-dim)',
};
const EMPTY: CSSProperties = {
  border: '1px dashed var(--border)', borderRadius: 8, padding: 24, textAlign: 'center',
  color: 'var(--fg-dim)', fontSize: 13, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center',
};

function Stat({ value, label, testid }: { value: string; label: string; testid?: string }) {
  return (
    <div style={STAT_CARD} data-testid={testid}>
      <div style={STAT_VAL}>{value}</div>
      <div style={STAT_LABEL}>{label}</div>
    </div>
  );
}

/** A grouped breakdown table — each row a proportion bar sized by token share. */
function Breakdown({
  title,
  icon,
  rows,
  totalTokens,
  emptyHint,
  testid,
}: {
  title: string;
  icon: ReactNode;
  rows: TokenGroupRow[];
  totalTokens: number;
  emptyHint: string;
  testid: string;
}) {
  const max = rows.reduce((m, r) => Math.max(m, r.tokens), 0);
  return (
    <div style={CARD} data-testid={testid}>
      <div style={CARD_HEAD}>
        {icon}
        {title}
      </div>
      {rows.length === 0 ? (
        <div style={{ ...SUB, padding: '4px 0' }}>{emptyHint}</div>
      ) : (
        rows.map((r) => (
          <div key={r.key} style={ROW} title={`${formatTokens(r.tokens)} tokens · ${formatUsd(r.costUsd)} · ${r.runs} runs · ${pct(r.tokens, totalTokens)} of tokens`}>
            <span style={ROW_KEY}>{r.key}</span>
            <span style={BAR_TRACK}>
              <span
                style={{
                  display: 'block',
                  height: '100%',
                  width: max > 0 ? `${Math.max(2, (r.tokens / max) * 100)}%` : '0%',
                  background: 'var(--accent, #6366f1)',
                  borderRadius: 4,
                }}
              />
            </span>
            <span style={ROW_NUM}>{formatTokens(r.tokens)}</span>
            <span style={{ ...ROW_NUM, minWidth: 52 }}>{formatUsd(r.costUsd)}</span>
          </div>
        ))
      )}
    </div>
  );
}

/** Daily token trend — inline bars, ascending by day. */
function DayTrend({ snapshot }: { snapshot: TokensDashboardSnapshot }) {
  const days = snapshot.byDay;
  const max = days.reduce((m, d) => Math.max(m, d.tokens), 0);
  return (
    <div style={CARD} data-testid="tokens-by-day">
      <div style={CARD_HEAD}>
        <CalendarDays size={14} aria-hidden /> By day
      </div>
      {days.length === 0 ? (
        <div style={{ ...SUB, padding: '4px 0' }}>No samples in this window yet.</div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 72 }}>
          {days.map((d) => (
            <div
              key={d.startMs}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 0 }}
              title={`${d.label}: ${formatTokens(d.tokens)} tokens · ${formatUsd(d.costUsd)}`}
            >
              <span
                style={{
                  width: '100%',
                  height: max > 0 ? `${Math.max(3, (d.tokens / max) * 56)}px` : '3px',
                  background: 'var(--accent, #6366f1)',
                  borderRadius: '3px 3px 0 0',
                }}
              />
              <span style={{ fontSize: 9, color: 'var(--fg-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
                {d.label}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TokensView({ slug }: { slug: string }): ReactNode {
  const location = useOperatorWorkspaceLocation();
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [exportWindow, setExportWindow] = useState(24 * 60 * 60 * 1000);
  const exportDiagnostics = async () => {
    setExporting(true); setExportStatus(null);
    try {
      const response = await operatorUi().apiFetch(`/api/harness/${encodeURIComponent(slug)}/insights/diagnostic-export`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation_id: crypto.randomUUID(), window_ms: exportWindow }),
      });
      const result = await response.json();
      setExportStatus(response.ok && result.delivered === true ? 'Aggregate accepted for delivery.' :
        result.code === 'consent_disabled' ? 'Enable aggregate diagnostic export in Settings → Profile first.' :
        'Aggregate was not delivered. Check your monitoring choice and local usage availability.');
    } catch { setExportStatus('Aggregate was not delivered. Local diagnostics remain available.'); }
    finally { setExporting(false); }
  };
  const sync = useSyncQuery<TokensDashboardSnapshot>({
    queryName: 'insights.tokens',
    args: { harness: slug },
    staleTime: 30_000,
    enabled: !!slug,
  });
  const snap = sync.data?.[0];

  const cacheReadShare = snap ? pct(snap.totals.cacheReadTokens, snap.totals.tokens) : '—';

  return (
    <div style={WRAP} data-testid="insights-tokens-view">
      <div style={HEAD}>
        <div>
          <div style={TITLE}>
            <Coins size={16} aria-hidden /> Token spend
          </div>
          <div style={SUB}>Calls observed by this runtime, with cache-inclusive tokens and labeled model costs.</div>
        </div>
        <button
          type="button"
          style={REFRESH}
          aria-label="Reload token spend"
          disabled={sync.fetching}
          onClick={() => sync.invalidate()}
        >
          <RefreshCw size={13} aria-hidden /> Refresh
        </button>
      </div>
      <p style={SUB}>This local ledger covers calls this runtime observes. It does not measure provider-account usage,
        subscription balances, invoices, or cloud bills. Papercusp service charges are separate.
        Customer usage stays local unless you explicitly authorize aggregate diagnostic export.</p>
      {location === 'cloud' && <section style={CARD} aria-label="Aggregate diagnostic export">
        <p style={SUB}>Send only call and token counts, provider-reported or estimated model cost, and the count of unpriced calls
          to Papercusp’s PostHog at flags.papercuspai.com. No prompts, code, private tasks, logs, account details or host/cloud bills.
          Export is off by default; enable it in Settings → Profile. The period starts after your latest opt-in.
          Revocation stops future delivery. Previously sent events remain under the project’s current unlimited retention.</p>
        <label>Export period <Select ariaLabel="Export period" value={String(exportWindow)} disabled={exporting}
          onChange={value => setExportWindow(Number(value))} options={[
            { value: String(24 * 60 * 60 * 1000), label: 'Last 24 hours' },
            { value: String(7 * 24 * 60 * 60 * 1000), label: 'Last 7 days' },
          ]} /></label>
        <button type="button" disabled={exporting} onClick={() => { void exportDiagnostics(); }}>Send aggregate diagnostics</button>
        {exportStatus && <p role="status">{exportStatus}</p>}
      </section>}

      {sync.loading && !snap ? (
        <div style={EMPTY}>Loading token spend…</div>
      ) : sync.error ? (
        <div style={EMPTY}>Token spend unavailable: {sync.error.message}</div>
      ) : snap?.observation === 'unavailable' ? (
        <div style={EMPTY} role="status" data-testid="tokens-unavailable">Local usage is unavailable. Token counts and costs are unknown.</div>
      ) : !snap || snap.totals.runs === 0 ? (
        <div style={EMPTY} data-testid="tokens-empty">
          <Coins size={20} aria-hidden />
          <strong>No token usage recorded yet</strong>
          <span>Agent runs on this harness write per-call token + cost samples; once they land, the cache-inclusive breakdown by model, role, and day appears here.</span>
        </div>
      ) : (
        <>
          <div style={SCOREBOARD} aria-label="Token spend totals">
            <Stat value={formatUsd(snap.totals.costUsd)} label="Recorded model cost" testid="tokens-stat-cost" />
            <Stat value={formatTokens(snap.totals.tokens)} label="Total tokens" testid="tokens-stat-tokens" />
            <Stat value={snap.totals.runs.toLocaleString()} label="Observed calls" testid="tokens-stat-runs" />
            <Stat value={cacheReadShare} label="Cache-read share" testid="tokens-stat-cache" />
          </div>

          <div style={NOTE} data-testid="tokens-cache-note">
            <Info size={14} aria-hidden style={{ flex: '0 0 auto', marginTop: 1 }} />
            <span>
              Cache-inclusive: {formatTokens(snap.totals.inputTokens)} input · {formatTokens(snap.totals.outputTokens)} output ·{' '}
              {formatTokens(snap.totals.cacheReadTokens)} cache-read · {formatTokens(snap.totals.cacheCreationTokens)} cache-create.
              {snap.totals.estimatedUsd > 0
                ? ` Includes ${formatUsd(snap.totals.estimatedUsd)} estimated from token counts (codex/OMP report no billed cost).`
                : ''}
              {snap.totals.reportedUsd !== undefined ? ` Provider-reported call cost: ${formatUsd(snap.totals.reportedUsd)}.` : ''}
              {(snap.totals.unpricedCalls ?? 0) > 0 ? ` Cost is unknown for ${snap.totals.unpricedCalls} call(s); these are excluded from the recorded total.` : ''}
            </span>
          </div>

          <DayTrend snapshot={snap} />
          <section style={CARD} aria-label="Recent local calls">
            <div style={CARD_HEAD}>Recent local calls</div>
            <p style={SUB}>Up to 20 recorded calls in the selected window. Unknown counters remain unknown.</p>
            <div style={{ overflowX: 'auto' }}><Table rows={snap.recentCalls ?? []} getRowKey={call => call.id}
              ariaLabel="Recent local call usage" columns={[
                { key: 'time', header: 'Time', render: call => new Date(call.atMs).toLocaleString() },
                { key: 'model', header: 'Model', render: call => call.model },
                { key: 'input', header: 'Input', render: call => call.inputTokens === null ? 'Unknown' : formatTokens(call.inputTokens) },
                { key: 'output', header: 'Output', render: call => call.outputTokens === null ? 'Unknown' : formatTokens(call.outputTokens) },
                { key: 'cache-read', header: 'Cache read', render: call => call.cacheReadTokens === null ? 'Unknown' : formatTokens(call.cacheReadTokens) },
                { key: 'cache-write', header: 'Cache write', render: call => call.cacheCreationTokens === null ? 'Unknown' : formatTokens(call.cacheCreationTokens) },
                { key: 'cost', header: 'Model cost', render: call => call.costUsd === null ? 'Unknown' :
                  `${formatUsd(call.costUsd)} (${call.costSource === 'provider' ? 'provider reported' : 'estimated'})` },
              ]} /></div>
          </section>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
            <Breakdown
              title="By model"
              icon={<Cpu size={14} aria-hidden />}
              rows={snap.byModel}
              totalTokens={snap.totals.tokens}
              emptyHint="No model attribution on these samples."
              testid="tokens-by-model"
            />
            <Breakdown
              title="By role"
              icon={<UserRound size={14} aria-hidden />}
              rows={snap.byRole}
              totalTokens={snap.totals.tokens}
              emptyHint="No role attribution on these samples."
              testid="tokens-by-role"
            />
            <Breakdown
              title="By account"
              icon={<UserRound size={14} aria-hidden />}
              rows={snap.byAccount}
              totalTokens={snap.totals.tokens}
              emptyHint="No account attribution on these samples."
              testid="tokens-by-account"
            />
          </div>

          {!snap.accountAttributionAvailable ? (
            <div style={NOTE} data-testid="tokens-account-note">
              <Info size={14} aria-hidden style={{ flex: '0 0 auto', marginTop: 1 }} />
              <span>
                Per-account attribution isn’t captured yet — account routing is gateway-layer state, not a usage-sample
                column, so spend can’t be split by Max account here. (Tracked separately from B-TOK-FIX.)
              </span>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

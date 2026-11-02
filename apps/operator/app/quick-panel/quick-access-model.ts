import type { PlanListRow } from '@/app/admin/plans/plans-api';
import type { RosterEntry } from '@/app/adv/sessions/SessionsRosterView';
import type { toReportFull, toReportSummary } from '@papercusp/operator-core/lib/agent-tools/reports/_shared';
import type { AgentClaim } from '@papercusp/operator-core/lib/fleet/assignments';
import { canFocusWindow } from '@papercusp/agent-roster/logic';

export type QuickPlan = Pick<PlanListRow, 'slug' | 'harness' | 'title' | 'status' | 'updated' | 'nextAction'>;
export type QuickAgent = Pick<RosterEntry, 'ownerId' | 'label' | 'intent' | 'agent' | 'currentPlanSlug' |
  'sessionState' | 'advSessionId' | 'windowId' | 'pid' | 'isLocal' | 'stale' | 'revoked'> & {
    claims?: ReadonlyArray<Pick<AgentClaim, 'harnessSlug' | 'planSlug' | 'active'>>;
  };
export type QuickReport = ReturnType<typeof toReportSummary>;
export type FullReport = ReturnType<typeof toReportFull>;
export type QuickScope = 'all' | 'plans' | 'agents' | 'reports';
export const QUICK_SCOPES: QuickScope[] = ['all', 'plans', 'agents', 'reports'];
export type QuickResult =
  | { key: string; kind: 'plans'; title: string; subtitle: string; plan: QuickPlan }
  | { key: string; kind: 'agents'; title: string; subtitle: string; agent: QuickAgent }
  | { key: string; kind: 'reports'; title: string; subtitle: string; report: QuickReport };

export function quickAgentName(a: Pick<QuickAgent, 'ownerId' | 'label'>): string {
  return a.label?.trim() || a.ownerId;
}

/** Keys preserve harness identity and never infer an agent target from a name. */
export function quickResults(
  plans: QuickPlan[], agents: QuickAgent[], reports: QuickReport[], query: string, scope: QuickScope,
): QuickResult[] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = (...values: (string | undefined | null)[]) =>
    terms.every(term => values.join(' ').toLocaleLowerCase().includes(term));
  const results: QuickResult[] = [];
  if (scope === 'all' || scope === 'plans') {
    for (const p of plans) {
      // Presence's currentPlanSlug is unqualified. Only canonical claims prove
      // which identically named plan this person belongs to.
      const people = agents.filter(a => a.claims?.some(c =>
        c.active && c.harnessSlug === p.harness && c.planSlug === p.slug,
      )).map(quickAgentName).join(' ');
      if (matches(p.title, p.slug, p.harness, p.nextAction, people)) {
        results.push({ key: JSON.stringify(['plans', p.harness, p.slug]), kind: 'plans',
          title: p.title || p.slug, subtitle: `${p.status} · ${p.harness}`, plan: p });
      }
    }
  }
  if (scope === 'all' || scope === 'agents') {
    for (const a of agents) {
      if (matches(a.label, a.ownerId, a.intent, a.agent, a.currentPlanSlug)) {
        results.push({ key: JSON.stringify(['agents', a.ownerId]), kind: 'agents',
          title: quickAgentName(a), subtitle: a.intent || a.sessionState || 'Activity unavailable', agent: a });
      }
    }
  }
  if (scope === 'all' || scope === 'reports') {
    for (const r of reports) {
      if (matches(r.title, r.summary, r.kind, r.subject?.label)) {
        results.push({ key: JSON.stringify(['reports', r.report_id]), kind: 'reports',
          title: r.title, subtitle: `${r.kind} · ${new Date(r.published_at).toLocaleDateString()}`, report: r });
      }
    }
  }
  return results;
}

export function quickFocusReason(a: QuickAgent): string | null {
  if (a.revoked || a.sessionState === 'ended' || a.stale) return 'Session is no longer live';
  if (a.isLocal === false) return 'Window is on another machine';
  if (!canFocusWindow(a)) return 'No desktop window recorded';
  return null;
}

export function quickSelection(results: QuickResult[], key: string): QuickResult | null {
  return results.find(r => r.key === key) ?? results[0] ?? null;
}

/** Reserve room for each source so a large plan catalog cannot hide people or reports. */
export function quickVisibleResults(results: QuickResult[], scope: QuickScope): QuickResult[] {
  const counts = { plans: 0, agents: 0, reports: 0 };
  const limit = scope === 'all' ? 26 : 80;
  return results.filter(result => ++counts[result.kind] <= limit);
}

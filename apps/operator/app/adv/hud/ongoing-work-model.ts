/** Shared presentation of the existing goal read models. No new goal lifecycle. */
import type { GoalDetailInput } from './goal-detail-model';
import type { HudGoalInput } from './hud-entity-board';
import type { GoalPackageRailEntry } from './GoalPackagesRail';

export function representedOngoingGoalIds(entries: GoalPackageRailEntry[]): Set<string> {
  return new Set(entries.filter((e) => e.standing && e.activeGoalId).map((e) => e.activeGoalId!));
}

export function ongoingStatus(status?: string | null, effective?: string | null, holder?: string | null) {
  if (status === 'paused') return { label: 'Paused', tone: 'warn' } as const;
  if (status === 'achieved') return { label: 'Achieved', tone: 'muted' } as const;
  if (status === 'killed') return { label: 'Stopped', tone: 'muted' } as const;
  if (effective === 'dormant' || holder === 'unheld' || holder === 'lost') {
    return { label: 'Not running', tone: 'warn' } as const;
  }
  if (status === 'active' && holder === 'held' && (!effective || effective === 'active')) {
    return { label: 'Running', tone: 'good' } as const;
  }
  return { label: 'Status unavailable', tone: 'muted' } as const;
}

function count(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value >= 0 ? value : null;
}

export function ongoingWorkView(goal: HudGoalInput | null | undefined, detail?: GoalDetailInput | null) {
  // A detail from a previous instance must never populate the new card.
  const data = goal && detail?.goal?.id === goal.id ? detail : null;
  const current = data?.goal ?? goal;
  const priorities = (data?.goalModeState?.portfolio?.priorities ?? [])
    .filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim());
  // Only an actually closed, positively completed work item is an outcome.
  // updatedAt, a stopped/killed item, and a goal's definition edit are not one.
  const outcomes = (data?.activity ?? []).filter((a) =>
    a.status === 'done' && !!a.closedAt && Number.isFinite(Date.parse(a.closedAt)),
  ).sort((a, b) => Date.parse(b.closedAt!) - Date.parse(a.closedAt!));
  const latest = outcomes[0] ?? null;
  const attention = count(data?.waitingOnYouTotal) ?? count(goal?.needsHuman);
  const recent = current?.spendRecentUsd;
  const days = current?.spendRecentWindowDays;
  const spend = recent != null && Number.isFinite(recent) && days != null && days > 0
    ? `$${recent.toFixed(2)} in the last ${days} days` : null;
  const cents = current?.budgetCents;
  const sec = current?.budgetWindowSec;
  const window = sec === undefined ? 'window unavailable' : sec === null ? 'lifetime' : sec % 86400 === 0 ? `${sec / 86400} days`
    : sec % 3600 === 0 ? `${sec / 3600} hours` : `${sec} seconds`;
  return {
    status: ongoingStatus(current?.status, data?.effectiveStatus ?? goal?.effectiveStatus,
      data?.holderLiveness ?? goal?.holderLiveness),
    priorities,
    focus: priorities[0] ?? null,
    latest,
    attention,
    attentionItem: data?.waitingOnYou?.[0] ?? null,
    spend,
    budget: cents != null && Number.isFinite(cents) ? `$${(cents / 100).toFixed(2)} / ${window}` : null,
  };
}

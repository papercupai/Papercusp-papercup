'use client';

import { Infinity as InfinityIcon } from 'lucide-react';
import { agoText, type GoalDetailInput } from './goal-detail-model';
import type { HudGoalInput } from './hud-entity-board';
import { ongoingWorkView } from './ongoing-work-model';

/** One view of existing goal data, shared by the package rail and goal brief. */
export default function OngoingWorkOverview({
  goal, detail, title, description, variant = 'featured', nowMs, actions, onOpenWorkItem, onOpenPlan,
}: {
  goal?: HudGoalInput | null;
  detail?: GoalDetailInput | null;
  title: string;
  description?: string;
  variant?: 'featured' | 'compact' | 'detail';
  nowMs: number;
  actions?: React.ReactNode;
  onOpenWorkItem?: (id: string) => void;
  onOpenPlan?: (harnessSlug: string, planSlug: string) => void;
}) {
  const view = ongoingWorkView(goal, detail);
  const openItem = (id: string, text: string) => onOpenWorkItem ? (
    <button type="button" className="pc-ctl-act" onClick={() => onOpenWorkItem(id)}>{text}</button>
  ) : <strong>{text}</strong>;
  const lanes = variant === 'detail' ? <div className="hud-ongoing__lanes">
    <h4>Where work is moving</h4>
    <p>Current priorities, in the order reported by this goal.</p>
    {view.priorities.length ? <ol>{view.priorities.map((priority, i) => <li key={`${i}:${priority}`}>{priority}</li>)}</ol>
      : <p>Work priorities are unavailable.</p>}
    {detail?.plans?.length ? <div className="hud-ongoing__plans">
      <h4>Plans for this goal</h4>
      {detail.plans.map((plan) => <div key={`${plan.harnessSlug}:${plan.planSlug}`}>
        {onOpenPlan ? <button type="button" className="pc-ctl-act"
          onClick={() => onOpenPlan(plan.harnessSlug, plan.planSlug)}>{plan.title || plan.planSlug}</button>
          : <span>{plan.title || plan.planSlug}</span>}
        <p>{plan.harnessSlug}{plan.status ? ` · ${plan.status}` : ''}
          {plan.openItems != null ? ` · ${plan.openItems} open items` : ''}</p>
      </div>)}
    </div> : null}
  </div> : null;
  return (
    <section className={`hud-ongoing hud-ongoing--${variant}`} aria-label={`Ongoing work: ${title}`} data-testid="ongoing-work-overview">
      <div className="hud-ongoing__top">
        <div className="hud-ongoing__identity">
          <InfinityIcon size={24} aria-hidden="true" />
          <div>
            <div className="hud-ongoing__title"><h3>{variant === 'detail' ? 'Ongoing work' : title}</h3>
              <span className={`hud__chip hud__chip--${view.status.tone}`} data-testid="ongoing-status">{view.status.label}</span>
            </div>
            {variant !== 'compact' && description ? <p>{description}</p> : null}
          </div>
        </div>
        <div className="hud-ongoing__actions">{actions}</div>
      </div>
      {lanes}
      {variant === 'compact' ? (
        <div className="hud-ongoing__compact-read">
          <span>{view.latest ? `Latest outcome: ${view.latest.title}` : 'No completed outcome available'}</span>
          <span>{view.attention == null ? 'Attention unavailable' : `${view.attention} needs you`}</span>
        </div>
      ) : (
        <div className="hud-ongoing__signals">
          <div><h4>Current focus</h4><strong>{view.focus ?? 'Priorities unavailable'}</strong></div>
          <div><h4>Recent outcome</h4>
            {view.latest ? <>{openItem(view.latest.id, view.latest.title)}<p>{agoText(view.latest.closedAt, nowMs)}</p></>
              : <strong>No completed outcome available</strong>}
          </div>
          <div><h4>Needs your attention</h4>
            {view.attentionItem ? openItem(view.attentionItem.id, view.attentionItem.title) : null}
            <p>{view.attention == null ? 'Attention unavailable' : view.attention === 0 ? 'No decision waiting on you' : `${view.attention} waiting on you`}</p>
          </div>
        </div>
      )}
      {variant !== 'compact' ? <div className="hud-ongoing__foot">
        <span>Ongoing work · Pause or stop at any time</span>
        <span>{view.spend ? `Spend: ${view.spend}` : 'Spend unavailable'}{view.budget ? ` · Budget: ${view.budget}` : ' · Budget unavailable'}</span>
      </div> : null}
    </section>
  );
}

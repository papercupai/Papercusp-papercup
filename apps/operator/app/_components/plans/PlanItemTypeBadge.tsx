/**
 * plan-item-types-registry-cupboard-2026-10-20 P-007 (R-19, D-009): the item-type and plan-type
 * badges the Plans pane shows. The values come from the `plans.itemTypeView` sync query, which
 * resolves each item at the plan's pinned revisions, so a badge names the type the gates hold the
 * item to.
 */

export interface PlanItemTypeBadgeProps {
  /** The resolved item type id; null renders nothing (the item resolves no type). */
  itemType: string | null;
  revision: number | null;
  /** True for the first-party item types behind the built-in deliverable kinds. */
  builtIn: boolean;
  /** When set the badge is a button that opens the item's type panel. */
  onOpen?: () => void;
  /** Marks the badge whose panel is open. */
  active?: boolean;
  testId?: string;
}

export function itemTypeLabel(itemType: string, revision: number | null): string {
  return revision === null ? itemType : `${itemType}@${revision}`;
}

export default function PlanItemTypeBadge({
  itemType,
  revision,
  builtIn,
  onOpen,
  active = false,
  testId,
}: PlanItemTypeBadgeProps) {
  if (!itemType) return null;
  const label = itemTypeLabel(itemType, revision);
  const className = `plan-dash__ibadge plan-dash__ibadge--type${builtIn ? " plan-dash__ibadge--builtin" : ""}${
    active ? " plan-dash__ibadge--active" : ""
  }`;
  const title = builtIn
    ? `Built-in item type ${label}`
    : `Item type ${label}, installed in the type registry`;
  const shared = {
    className,
    title,
    "data-item-type": itemType,
    "data-item-type-revision": revision === null ? undefined : String(revision),
    "data-item-type-builtin": builtIn ? "true" : "false",
    "data-testid": testId,
  };
  if (!onOpen) {
    return (
      <span {...shared} aria-label={`Item type: ${label}`}>
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      {...shared}
      aria-label={`Item type: ${label}. Show its modules and completion fields`}
      aria-pressed={active}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      {label}
    </button>
  );
}

export interface PlanTypeBadgeProps {
  /** The `type:` the plan declares; null means its profile's first-party plan type. */
  planType: string | null;
  profile: string;
  testId?: string;
}

export function PlanTypeBadge({ planType, profile, testId }: PlanTypeBadgeProps) {
  const label = planType ?? profile;
  const title = planType
    ? `Plan type ${planType} (verification profile ${profile})`
    : `No declared plan type: held to the ${profile} profile's first-party plan type`;
  return (
    <span
      className={`plan-dash__ibadge plan-dash__ibadge--type${planType ? "" : " plan-dash__ibadge--builtin"}`}
      title={title}
      aria-label={`Plan type: ${label}`}
      data-plan-type={planType ?? ""}
      data-plan-profile={profile}
      data-testid={testId}
    >
      {label}
    </span>
  );
}

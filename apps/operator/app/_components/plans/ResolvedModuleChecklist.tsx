/**
 * plan-item-types-registry-cupboard-2026-10-20 P-007 (R-25, D-009): the resolved checklist for one
 * plan item, meaning every verification module of its resolved module set plus the acceptance
 * criteria its item type contributes. The module set comes from the `plans.itemTypeView` sync
 * query, the same set the ship gate holds the item to.
 */

export interface ResolvedModuleChecklistProps {
  modules: readonly string[];
  criteria?: ReadonlyArray<{ key: string; title: string }>;
  testId?: string;
}

export default function ResolvedModuleChecklist({
  modules,
  criteria = [],
  testId,
}: ResolvedModuleChecklistProps) {
  return (
    <div className="plan-dash__tcheck" data-testid={testId}>
      <div className="plan-dash__tcheck-h">
        Verification modules · {modules.length}
      </div>
      {modules.length === 0 ? (
        <div className="plan-dash__empty">
          This item is held to no verification module.
        </div>
      ) : (
        <ul
          className="plan-dash__tcheck-list"
          aria-label="Resolved verification modules"
        >
          {modules.map((module) => (
            <li key={module} data-module={module}>
              <code>{module}</code>
            </li>
          ))}
        </ul>
      )}
      {criteria.length > 0 ? (
        <>
          <div className="plan-dash__tcheck-h">
            Item-type criteria · {criteria.length}
          </div>
          <ul
            className="plan-dash__tcheck-list"
            aria-label="Item-type acceptance criteria"
          >
            {criteria.map((criterion) => (
              <li key={criterion.key} data-criterion={criterion.key}>
                {criterion.title}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

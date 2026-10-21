"use client";

/**
 * plan-item-types-registry-cupboard-2026-10-20 P-007 (D-009): the type panel the Plans pane opens
 * from an item's type badge (URL state: `?pdtype=<item id>`). It shows the item's resolved module
 * set and the item type's criteria, plus the completion form when the type asks for fields.
 */
import { X } from "lucide-react";
import type { PlanItemTypeViewItem } from "@papercusp/operator-core/lib/plan-types/item-type-view";
import PlanItemTypeBadge from "./PlanItemTypeBadge";
import ResolvedModuleChecklist from "./ResolvedModuleChecklist";
import ItemTypeCompletionForm from "./ItemTypeCompletionForm";

/** nuqs key for the open type panel; the value is the plan item id. */
export const PLAN_ITEM_TYPE_PARAM = "pdtype";

export interface PlanItemTypePanelProps {
  planSlug: string;
  harness?: string | null;
  item: PlanItemTypeViewItem;
  onClose: () => void;
}

export default function PlanItemTypePanel({ planSlug, harness, item, onClose }: PlanItemTypePanelProps) {
  return (
    <section
      className="plan-dash__card plan-dash__tpanel"
      data-testid={`plan-dash-type-panel-${item.itemId}`}
      aria-label={`Item type of ${item.itemId}`}
    >
      <div className="plan-dash__sec-h">
        {item.itemId} ·{" "}
        <PlanItemTypeBadge itemType={item.itemType} revision={item.revision} builtIn={item.builtIn} />
        {item.rubricRef ? <span className="plan-dash__tpanel-meta">rubric {item.rubricRef}</span> : null}
        <span className="plan-dash__sec-line" aria-hidden="true" />
        <button type="button" className="plan-dash__tpanel-close" onClick={onClose} aria-label="Close the type panel">
          <X size={12} aria-hidden="true" />
        </button>
      </div>
      <ResolvedModuleChecklist
        modules={item.modules}
        criteria={item.criteria}
        testId={`plan-dash-type-modules-${item.itemId}`}
      />
      {item.completionSchema ? (
        <>
          <div className="plan-dash__tcheck-h">
            Completion fields
            {item.completion?.kind === "datatype" ? ` · datatype ${item.completion.datatypeRef}` : ""}
          </div>
          <ItemTypeCompletionForm
            planSlug={planSlug}
            harness={harness}
            itemId={item.itemId}
            schema={item.completionSchema}
            testId={`plan-dash-type-form-${item.itemId}`}
          />
        </>
      ) : item.completionUnresolved && item.completion?.kind === "datatype" ? (
        <div className="plan-dash__empty" role="status">
          This item type takes its completion fields from datatype {item.completion.datatypeRef}, which is
          not installed in this workspace.
        </div>
      ) : null}
    </section>
  );
}

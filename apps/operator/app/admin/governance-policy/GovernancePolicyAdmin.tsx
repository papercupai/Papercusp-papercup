"use client";

import { useState, type CSSProperties } from "react";
import { toast } from "sonner";
import { parseAsString, parseAsStringEnum, useQueryState } from "nuqs";
import { useSyncQuery } from "@papercusp/sync";
import type {
  ExplainedVerdict,
  GovernancePolicyExplanation,
  GovernancePolicySimulation,
  GovernancePolicySimulationCase,
  GovernancePolicyState,
} from "@papercusp/operator-core/lib/governance-policy/control";
import type {
  CategoryRule,
  GovernedCategory,
  PolicyException,
  PolicyLevel,
  PolicyTraceStep,
} from "@papercusp/operator-core/lib/governance-policy/inherited-policy";
import type { PolicyLayerVersion, StoredPolicyLayer } from "@papercusp/operator-core/lib/governance-policy/store";
import { Select } from "@/app/harness/Select";
import { Table, type TableColumn } from "@/app/harness/Table";

/**
 * /admin/governance-policy — the administrator pane for the inherited organization → department →
 * workspace governance policy (plan papercusp-enterprise-readiness-roadmap-2026-10-09 P-005,
 * WI-6554700010011434).
 *
 * READ: `governancePolicy.state` — the workspace's chain, every layer and its version history,
 * from governance-policy/control.ts (the same module the `governance:policy` tool uses).
 * WRITE / ASK: POST /api/governance-policy/{explain,simulate,set,add-exception}.
 *
 * The pane never decides policy itself. "Explain" and "preview" are answered by the server's
 * evaluator (the same code the kernel enforces with), so a workspace admin cannot make the UI
 * show a widened organization refusal. Apply is offered only after the CURRENT draft has been
 * previewed, and always carries a change reason, which is recorded as a new layer version.
 *
 * Imports from operator-core are TYPE-ONLY: the governed categories and levels arrive in the
 * state payload, so this file never loads server modules.
 */

export const GOVERNANCE_TABS = ["chain", "explain", "edit", "exceptions", "history"] as const;
export type GovernanceTab = (typeof GOVERNANCE_TABS)[number];
export const NEW_LAYER = "__new__";

const TAB_LABEL: Record<GovernanceTab, string> = {
  chain: "Effective chain",
  explain: "Explain a decision",
  edit: "Edit & preview",
  exceptions: "Exceptions",
  history: "Version history",
};

// ── pure helpers (exported for tests) ──────────────────────────────────────────────────────────────

/** Split a newline/comma separated list into trimmed, de-duplicated values. */
export function parseList(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\n,]/)) {
    const s = raw.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

export type RulesDraft = Record<string, { allow: string; deny: string }>;

export function draftFromRules(
  categories: readonly GovernedCategory[],
  rules: Partial<Record<GovernedCategory, CategoryRule>>,
): RulesDraft {
  const out: RulesDraft = {};
  for (const c of categories) {
    out[c] = { allow: (rules[c]?.allow ?? []).join(", "), deny: (rules[c]?.deny ?? []).join(", ") };
  }
  return out;
}

/** A blank allow field means "no allow list" (inherit); it never means "allow nothing". */
export function rulesFromDraft(
  categories: readonly GovernedCategory[],
  draft: RulesDraft,
): Partial<Record<GovernedCategory, CategoryRule>> {
  const out: Partial<Record<GovernedCategory, CategoryRule>> = {};
  for (const c of categories) {
    const allow = parseList(draft[c]?.allow ?? "");
    const deny = parseList(draft[c]?.deny ?? "");
    const rule: CategoryRule = {};
    if (allow.length) rule.allow = allow;
    if (deny.length) rule.deny = deny;
    if (rule.allow || rule.deny) out[c] = rule;
  }
  return out;
}

/** One test request per non-empty line: `category: value, value`. */
export function parseRequestLines(
  text: string,
  categories: readonly GovernedCategory[],
): { ok: true; requests: Array<Partial<Record<GovernedCategory, string[]>>> } | { ok: false; error: string } {
  const requests: Array<Partial<Record<GovernedCategory, string[]>>> = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    const sep = line.indexOf(":");
    const cat = (sep === -1 ? "" : line.slice(0, sep).trim()) as GovernedCategory;
    if (!categories.includes(cat)) {
      return { ok: false, error: `line ${i + 1}: start with one of ${categories.join(", ")} followed by ':'` };
    }
    const values = parseList(line.slice(sep + 1));
    if (!values.length) return { ok: false, error: `line ${i + 1}: name at least one ${cat} value` };
    requests.push({ [cat]: values });
  }
  if (!requests.length) return { ok: false, error: "add at least one test line, e.g. tools: capability:bash" };
  return { ok: true, requests };
}

/** Display only. The server evaluator is authoritative; an expired exception grants nothing. */
export function isExceptionActive(e: PolicyException, nowMs: number): boolean {
  const t = e.expiresAt ? Date.parse(e.expiresAt) : Number.NaN;
  return Number.isFinite(t) && t > nowMs;
}

export function describeStep(step: PolicyTraceStep): string {
  return `${step.level} ${step.layerId} v${step.version}: ${step.outcome}${step.pattern ? ` (${step.pattern})` : ""}`;
}

function requestLabel(r: Partial<Record<GovernedCategory, readonly string[]>>): string {
  return Object.entries(r)
    .map(([c, v]) => `${c}: ${(v ?? []).join(", ")}`)
    .join("; ");
}

function verdictLabel(v: ExplainedVerdict): string {
  return v.allow ? "allowed" : `refused (${v.code})`;
}

export function simulationNote(c: GovernancePolicySimulationCase): string {
  if (c.decidedByAncestor && !c.after.allow && c.after.decidedBy) {
    return `Still refused by ${c.after.decidedBy.level} ${c.after.decidedBy.layerId}: a lower layer cannot widen it`;
  }
  if (!c.changed) return "No change";
  return c.after.allow ? "Would become allowed" : "Would become refused";
}

// ── styles (same tokens as /admin/work-scope) ──────────────────────────────────────────────────────

const PAGE_STYLE: CSSProperties = { display: "flex", flexDirection: "column", gap: 16, padding: 16, maxWidth: 1100 };
const CARD_STYLE: CSSProperties = {
  border: "1px solid var(--border, rgba(255,255,255,0.18))",
  borderRadius: 10,
  padding: 14,
  display: "flex",
  flexDirection: "column",
  gap: 10,
};
const LABEL_STYLE: CSSProperties = { fontSize: 12, opacity: 0.7, textTransform: "uppercase", fontWeight: 600 };
const MONO_STYLE: CSSProperties = { fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 12 };
const INPUT_STYLE: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--border, rgba(255,255,255,0.18))",
  background: "var(--bg-deep, rgba(0,0,0,0.25))",
  color: "inherit",
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  fontSize: 13,
};
const BUTTON_STYLE: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 8,
  border: "1px solid var(--border, rgba(255,255,255,0.18))",
  background: "var(--accent, #2563eb)",
  color: "#fff",
  cursor: "pointer",
};
const GHOST_BUTTON_STYLE: CSSProperties = { ...BUTTON_STYLE, background: "transparent", color: "inherit" };
const ROW_STYLE: CSSProperties = { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" };
const BANNER_TONE = {
  none: { bg: "rgba(148,163,184,0.18)", text: "No inherited policy governs this workspace yet (no workspace layer)." },
  ok: { bg: "rgba(34,197,94,0.18)", text: "Enforced: every dispatch is judged against this chain, root first." },
  malformed: { bg: "rgba(239,68,68,0.2)", text: "Malformed chain: everything is refused until it is repaired." },
} as const;

const TRACE_COLUMNS: TableColumn<PolicyTraceStep>[] = [
  { key: "layer", header: "Layer", render: (s) => `${s.level} ${s.layerId} v${s.version}` },
  { key: "value", header: "Value", render: (s) => `${s.category}: ${s.value}` },
  { key: "outcome", header: "Outcome", render: (s) => s.outcome },
  { key: "pattern", header: "Matched", render: (s) => s.pattern ?? "—" },
];
const SIM_COLUMNS: TableColumn<GovernancePolicySimulationCase>[] = [
  { key: "request", header: "Request", render: (c) => requestLabel(c.request) },
  { key: "before", header: "Now", render: (c) => verdictLabel(c.before) },
  { key: "after", header: "After saving", render: (c) => verdictLabel(c.after) },
  { key: "note", header: "Effect", render: (c) => simulationNote(c) },
];
const VERSION_COLUMNS: TableColumn<PolicyLayerVersion>[] = [
  { key: "version", header: "Version", render: (v) => `v${v.version}` },
  { key: "at", header: "Recorded", render: (v) => v.recordedAt.replace("T", " ").replace(/\.\d+Z$/, "Z") },
  { key: "actor", header: "Actor", render: (v) => v.actor },
  { key: "reason", header: "Reason", render: (v) => v.reason },
  { key: "hash", header: "Content", render: (v) => v.contentHash.slice(0, 12) },
];

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || !j.ok) throw new Error((j.error as string | undefined) ?? `HTTP ${res.status}`);
  return j as T;
}

interface EditDraft {
  key: string;
  layerId: string;
  level: PolicyLevel;
  scopeRef: string;
  parentLayerId: string;
  baseVersion: number;
  rules: RulesDraft;
  exceptions: PolicyException[];
  tests: string;
  reason: string;
}

function seedDraft(state: GovernancePolicyState, layer: StoredPolicyLayer | null): EditDraft {
  const leaf = state.chain[state.chain.length - 1] ?? null;
  if (!layer) {
    return {
      key: NEW_LAYER,
      layerId: "",
      level: leaf ? "workspace" : "organization",
      scopeRef: leaf ? state.workspaceId : "",
      parentLayerId: "",
      baseVersion: 0,
      rules: draftFromRules(state.categories, {}),
      exceptions: [],
      tests: "tools: capability:bash",
      reason: "",
    };
  }
  return {
    key: layer.layerId,
    layerId: layer.layerId,
    level: layer.level,
    scopeRef: layer.scopeRef,
    parentLayerId: layer.parentLayerId ?? "",
    baseVersion: layer.version,
    rules: draftFromRules(state.categories, layer.rules),
    exceptions: layer.exceptions ?? [],
    tests: "tools: capability:bash",
    reason: "",
  };
}

function proposalOf(state: GovernancePolicyState, d: EditDraft) {
  return {
    layerId: d.layerId.trim(),
    level: d.level,
    scopeRef: d.scopeRef.trim(),
    parentLayerId: d.level === "organization" ? null : d.parentLayerId.trim() || null,
    rules: rulesFromDraft(state.categories, d.rules),
    exceptions: d.exceptions,
  };
}

// ── component ────────────────────────────────────────────────────────────────────────────

export default function GovernancePolicyAdmin() {
  const query = useSyncQuery<GovernancePolicyState>({
    queryName: "governancePolicy.state",
    args: { versionLimit: 20 },
    staleTime: 15_000,
  });
  const state = query.data?.[0];

  const [tab, setTab] = useQueryState("tab", parseAsStringEnum<GovernanceTab>([...GOVERNANCE_TABS]).withDefault("chain"));
  const [layerParam, setLayerParam] = useQueryState("layer", parseAsString.withDefault(""));

  const [busy, setBusy] = useState<string | null>(null);
  const [explainCategory, setExplainCategory] = useState<string>("tools");
  const [explainValues, setExplainValues] = useState("");
  const [explanation, setExplanation] = useState<GovernancePolicyExplanation | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [simulation, setSimulation] = useState<{ signature: string; result: GovernancePolicySimulation } | null>(null);
  const [exceptionForm, setExceptionForm] = useState({ category: "tools", pattern: "", reason: "", expires: "" });

  if (query.loading && !state) return <div style={PAGE_STYLE}>Loading governance policy…</div>;
  if (query.error && !state) {
    return <div style={PAGE_STYLE}>Failed to load the governance policy: {String(query.error)}</div>;
  }
  if (!state) return <div style={PAGE_STYLE}>No governance policy state returned.</div>;

  const allLayers = [...state.chain, ...state.layers.filter((l) => !state.chain.some((c) => c.layerId === l.layerId))];
  const leaf = state.chain[state.chain.length - 1] ?? null;
  const isNew = layerParam === NEW_LAYER;
  const selected = isNew ? null : (allLayers.find((l) => l.layerId === layerParam) ?? leaf ?? allLayers[0] ?? null);
  const selectedKey = selected?.layerId ?? NEW_LAYER;
  const form = draft && draft.key === selectedKey ? draft : seedDraft(state, selected);
  const proposal = proposalOf(state, form);
  const signature = JSON.stringify(proposal);
  const previewed = simulation !== null && simulation.signature === signature;
  const canApply =
    busy === null && previewed && simulation?.result.validation === null && form.reason.trim().length >= 3;
  const categoryOptions = state.categories.map((c) => ({ value: c, label: c }));
  const layerOptions = [
    ...allLayers.map((l) => ({ value: l.layerId, label: `${l.level} · ${l.layerId} (v${l.version})` })),
    ...(tab === "edit" ? [{ value: NEW_LAYER, label: "New layer…" }] : []),
  ];
  const tone = BANNER_TONE[state.load];
  const update = (patch: Partial<EditDraft>) => setDraft({ ...form, ...patch });

  async function runExplain() {
    setBusy("explain");
    try {
      // Name the workspace the pane is SHOWING; never let the server fall back to another one.
      const out = await post<GovernancePolicyExplanation>("/api/governance-policy/explain", {
        workspaceId: state!.workspaceId,
        request: { [explainCategory]: parseList(explainValues) },
      });
      setExplanation(out);
    } catch (e) {
      toast.error("Could not explain", { description: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy(null);
    }
  }

  async function runSimulate() {
    const tests = parseRequestLines(form.tests, state!.categories);
    if (!tests.ok) {
      toast.error("Fix the test requests", { description: tests.error });
      return;
    }
    setBusy("simulate");
    try {
      const result = await post<GovernancePolicySimulation>("/api/governance-policy/simulate", {
        workspaceId: state!.workspaceId,
        proposed: proposal,
        requests: tests.requests,
      });
      setSimulation({ signature, result });
    } catch (e) {
      toast.error("Preview failed", { description: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy(null);
    }
  }

  async function runApply() {
    setBusy("set");
    try {
      const out = await post<{ revision: string }>("/api/governance-policy/set", {
        ...proposal,
        reason: form.reason.trim(),
        expectedVersion: form.baseVersion,
      });
      toast.success("Policy saved", { description: `${out.revision} · reason recorded` });
      setDraft(null);
      setSimulation(null);
      if (isNew) void setLayerParam(proposal.layerId);
    } catch (e) {
      toast.error("Policy not saved", { description: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy(null);
    }
  }

  async function runAddException() {
    if (!selected) return;
    const expiresAt = exceptionForm.expires ? new Date(exceptionForm.expires).toISOString() : "";
    setBusy("exception");
    try {
      const out = await post<{ revision: string }>("/api/governance-policy/add-exception", {
        layerId: selected.layerId,
        exception: {
          category: exceptionForm.category,
          pattern: exceptionForm.pattern.trim(),
          reason: exceptionForm.reason.trim(),
          expiresAt,
        },
        reason: `exception: ${exceptionForm.reason.trim()}`,
        expectedVersion: selected.version,
      });
      toast.success("Exception added", { description: `${out.revision} · expires ${expiresAt}` });
      setExceptionForm({ ...exceptionForm, pattern: "", reason: "", expires: "" });
    } catch (e) {
      toast.error("Exception not added", { description: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy(null);
    }
  }

  const nowMs = Date.now();
  const layerPicker = (
    <div style={ROW_STYLE}>
      <span style={LABEL_STYLE}>Layer</span>
      <Select
        ariaLabel="Policy layer"
        testId="gp-layer-select"
        value={selectedKey}
        onChange={(v: string) => void setLayerParam(v)}
        options={layerOptions}
      />
    </div>
  );

  return (
    <div style={PAGE_STYLE} data-testid="governance-policy-admin">
      <section style={{ ...CARD_STYLE, background: tone.bg }} data-testid="gp-load-status" data-load={state.load}>
        <div style={LABEL_STYLE}>Workspace {state.workspaceId}</div>
        <div>{tone.text}</div>
        {state.reason ? <div style={MONO_STYLE}>{state.reason}</div> : null}
        <div style={MONO_STYLE}>Chain: {state.revision ?? "none"}</div>
      </section>

      <nav style={ROW_STYLE} role="tablist" aria-label="Governance policy views">
        {GOVERNANCE_TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            data-testid={`gp-tab-${t}`}
            style={tab === t ? BUTTON_STYLE : GHOST_BUTTON_STYLE}
            onClick={() => void setTab(t)}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </nav>

      {tab === "chain" && (
        <section style={CARD_STYLE} data-testid="gp-chain">
          <div style={LABEL_STYLE}>Effective chain, root first</div>
          <div style={{ opacity: 0.8 }}>
            A value must pass every layer. A lower layer can only narrow what its ancestors permit.
          </div>
          {state.chain.length === 0 ? <div>No layers govern this workspace.</div> : null}
          {state.chain.map((l) => {
            const ruled = state.categories.filter((c) => l.rules[c]);
            const exceptions = l.exceptions ?? [];
            const active = exceptions.filter((e) => isExceptionActive(e, nowMs)).length;
            return (
              <div key={l.layerId} style={CARD_STYLE} data-testid={`gp-chain-layer-${l.layerId}`}>
                <div>
                  <strong>{l.level}</strong> · <span style={MONO_STYLE}>{l.layerId}</span> v{l.version} · scope{" "}
                  {l.scopeRef} · updated by {l.updatedBy}
                </div>
                {ruled.length === 0 ? (
                  <div style={{ opacity: 0.8 }}>No rules: passes everything its ancestors permit.</div>
                ) : (
                  ruled.map((c) => (
                    <div key={c} style={MONO_STYLE}>
                      {c}: {l.rules[c]?.allow ? `allow only ${l.rules[c]?.allow?.join(", ")}` : "no allow list"}
                      {l.rules[c]?.deny?.length ? ` · deny ${l.rules[c]?.deny?.join(", ")}` : ""}
                    </div>
                  ))
                )}
                <div style={{ opacity: 0.8 }}>
                  Exceptions: {active} active, {exceptions.length - active} expired
                </div>
              </div>
            );
          })}
        </section>
      )}

      {tab === "explain" && (
        <section style={CARD_STYLE} data-testid="gp-explain">
          <div style={LABEL_STYLE}>Why is an action allowed or denied?</div>
          <div style={ROW_STYLE}>
            <Select
              ariaLabel="Category"
              testId="gp-explain-category"
              value={explainCategory}
              onChange={(v: string) => setExplainCategory(v)}
              options={categoryOptions}
            />
            <input
              aria-label="Values to check"
              data-testid="gp-explain-values"
              style={{ ...INPUT_STYLE, flex: 1 }}
              placeholder="e.g. capability:bash"
              value={explainValues}
              onChange={(e) => setExplainValues(e.target.value)}
            />
            <button
              type="button"
              data-testid="gp-explain-submit"
              style={BUTTON_STYLE}
              disabled={busy !== null || parseList(explainValues).length === 0}
              onClick={() => void runExplain()}
            >
              Explain
            </button>
          </div>
          {explanation ? (
            <div data-testid="gp-explain-result" data-allow={String(explanation.verdict.allow)}>
              <div>
                <strong>{explanation.verdict.allow ? "Allowed" : "Denied"}</strong>: {explanation.explanation}
              </div>
              {!explanation.verdict.allow && explanation.verdict.decidedBy ? (
                <div style={MONO_STYLE}>Decided by {describeStep(explanation.verdict.decidedBy)}</div>
              ) : null}
              {explanation.verdict.trace.length ? (
                <Table<PolicyTraceStep>
                  ariaLabel="Decision trace"
                  columns={TRACE_COLUMNS}
                  rows={explanation.verdict.trace}
                  getRowKey={(s) => `${s.layerId}:${s.category}:${s.value}`}
                />
              ) : null}
            </div>
          ) : null}
        </section>
      )}

      {tab === "edit" && (
        <section style={CARD_STYLE} data-testid="gp-edit">
          {layerPicker}
          {isNew ? (
            <div style={ROW_STYLE}>
              <input aria-label="Layer id" data-testid="gp-new-id" style={{ ...INPUT_STYLE, flex: 1 }} placeholder="layer id, e.g. org-acme" value={form.layerId} onChange={(e) => update({ layerId: e.target.value })} />
              <Select ariaLabel="Level" testId="gp-new-level" value={form.level} onChange={(v: string) => update({ level: v as PolicyLevel })} options={state.levels.map((l) => ({ value: l, label: l }))} />
              <input aria-label="Scope" data-testid="gp-new-scope" style={{ ...INPUT_STYLE, flex: 1 }} placeholder="scope (org, department or workspace id)" value={form.scopeRef} onChange={(e) => update({ scopeRef: e.target.value })} />
              {form.level !== "organization" ? (
                <Select ariaLabel="Parent layer" testId="gp-new-parent" value={form.parentLayerId} onChange={(v: string) => update({ parentLayerId: v })} options={[{ value: "", label: "Choose parent…" }, ...allLayers.map((l) => ({ value: l.layerId, label: `${l.level} · ${l.layerId}` }))]} />
              ) : null}
            </div>
          ) : null}
          <div style={{ opacity: 0.8 }}>
            Comma-separated patterns. A blank allow field means no allow list. Deny beats allow, and no rule here can
            widen an ancestor&apos;s refusal.
          </div>
          {state.categories.map((c) => (
            <div key={c} style={ROW_STYLE} data-testid={`gp-rule-${c}`}>
              <span style={{ ...LABEL_STYLE, width: 80 }}>{c}</span>
              <input aria-label={`${c} allow`} style={{ ...INPUT_STYLE, flex: 1 }} placeholder="allow only…" value={form.rules[c]?.allow ?? ""} onChange={(e) => update({ rules: { ...form.rules, [c]: { allow: e.target.value, deny: form.rules[c]?.deny ?? "" } } })} />
              <input aria-label={`${c} deny`} style={{ ...INPUT_STYLE, flex: 1 }} placeholder="deny…" value={form.rules[c]?.deny ?? ""} onChange={(e) => update({ rules: { ...form.rules, [c]: { allow: form.rules[c]?.allow ?? "", deny: e.target.value } } })} />
            </div>
          ))}
          <label style={LABEL_STYLE} htmlFor="gp-tests">Preview against (one per line, category: values)</label>
          <textarea id="gp-tests" data-testid="gp-tests" rows={3} style={INPUT_STYLE} value={form.tests} onChange={(e) => update({ tests: e.target.value })} />
          <div style={ROW_STYLE}>
            <button type="button" data-testid="gp-simulate" style={BUTTON_STYLE} disabled={busy !== null} onClick={() => void runSimulate()}>
              Preview effect
            </button>
            {previewed ? null : <span style={{ opacity: 0.8 }}>Preview the current draft before applying it.</span>}
          </div>
          {simulation && previewed ? (
            <div data-testid="gp-sim-result" data-changed={simulation.result.changedCount}>
              {simulation.result.validation ? (
                <div data-testid="gp-sim-invalid">Cannot save: {simulation.result.validation}</div>
              ) : null}
              {simulation.result.note ? <div>{simulation.result.note}</div> : null}
              <div style={MONO_STYLE}>After saving: {simulation.result.proposedRevision ?? "(not in this workspace's chain)"}</div>
              <Table<GovernancePolicySimulationCase>
                ariaLabel="Preview"
                columns={SIM_COLUMNS}
                rows={simulation.result.cases}
                getRowKey={(c) => requestLabel(c.request)}
              />
            </div>
          ) : null}
          <input aria-label="Change reason" data-testid="gp-reason" style={INPUT_STYLE} placeholder="Change reason (required, recorded with the new version)" value={form.reason} onChange={(e) => update({ reason: e.target.value })} />
          <div style={ROW_STYLE}>
            <button type="button" data-testid="gp-apply" style={BUTTON_STYLE} disabled={!canApply} onClick={() => void runApply()}>
              Apply as v{form.baseVersion + 1}
            </button>
          </div>
        </section>
      )}

      {tab === "exceptions" && (
        <section style={CARD_STYLE} data-testid="gp-exceptions">
          {layerPicker}
          {!selected ? (
            <div>Create a layer first.</div>
          ) : (
            <>
              <div style={{ opacity: 0.8 }}>
                An exception lifts only this layer&apos;s refusal, never an ancestor&apos;s, and stops applying at its expiry.
              </div>
              {(selected.exceptions ?? []).map((e, i) => {
                const active = isExceptionActive(e, nowMs);
                return (
                  <div key={`${e.category}:${e.pattern}:${i}`} style={MONO_STYLE} data-testid="gp-exception-row" data-active={String(active)}>
                    {e.category}: {e.pattern} · {e.reason} · expires {e.expiresAt ?? "never (grants nothing)"} ·{" "}
                    {active ? "active" : "expired, grants nothing"}
                  </div>
                );
              })}
              <div style={ROW_STYLE}>
                <Select ariaLabel="Exception category" testId="gp-exception-category" value={exceptionForm.category} onChange={(v: string) => setExceptionForm({ ...exceptionForm, category: v })} options={categoryOptions} />
                <input aria-label="Exception pattern" data-testid="gp-exception-pattern" style={{ ...INPUT_STYLE, flex: 1 }} placeholder="pattern" value={exceptionForm.pattern} onChange={(e) => setExceptionForm({ ...exceptionForm, pattern: e.target.value })} />
                <input aria-label="Exception reason" data-testid="gp-exception-reason" style={{ ...INPUT_STYLE, flex: 1 }} placeholder="reason" value={exceptionForm.reason} onChange={(e) => setExceptionForm({ ...exceptionForm, reason: e.target.value })} />
                <input aria-label="Exception expiry" data-testid="gp-exception-expires" type="datetime-local" style={{ ...INPUT_STYLE, width: 220 }} value={exceptionForm.expires} onChange={(e) => setExceptionForm({ ...exceptionForm, expires: e.target.value })} />
                <button
                  type="button"
                  data-testid="gp-exception-add"
                  style={BUTTON_STYLE}
                  disabled={busy !== null || !exceptionForm.pattern.trim() || exceptionForm.reason.trim().length < 3 || !exceptionForm.expires}
                  onClick={() => void runAddException()}
                >
                  Add exception
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {tab === "history" && (
        <section style={CARD_STYLE} data-testid="gp-history">
          {layerPicker}
          {selected ? (
            <Table<PolicyLayerVersion>
              ariaLabel="Version history"
              columns={VERSION_COLUMNS}
              rows={state.versions[selected.layerId] ?? []}
              getRowKey={(v) => `${v.layerId}@${v.version}`}
            />
          ) : (
            <div>No layer selected.</div>
          )}
          {state.historyTruncated ? <div style={{ opacity: 0.8 }}>History is shown for the first 50 layers.</div> : null}
        </section>
      )}
    </div>
  );
}

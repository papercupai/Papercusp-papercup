"use client";

/**
 * plan-item-types-registry-cupboard-2026-10-20 P-007 (R-20, D-009): the completion form the Plans
 * pane generates from an item type's completion schema. Every property of the schema gets a
 * field. Submitting posts the typed values to POST /api/admin/plan-item-type-fields, which runs
 * `checkTypeFields`, the validation `work_items:complete` applies to `completion.typeFields`, at
 * the plan's pinned revisions. The server is the only validator; the form converts drafts to
 * typed values and passes anything it cannot convert through unchanged so the check reports it.
 */
import { useMemo, useState, type FormEvent } from "react";

export type CompletionFieldKind =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "enum"
  | "string-list"
  | "json";

export interface CompletionField {
  name: string;
  kind: CompletionFieldKind;
  required: boolean;
  title: string;
  description?: string;
  options?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeOf(property: Record<string, unknown>): string | undefined {
  const raw = property.type;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.find((entry) => typeof entry === "string" && entry !== "null");
  return undefined;
}

function kindOf(property: Record<string, unknown>): CompletionFieldKind {
  if (Array.isArray(property.enum) && property.enum.length > 0 && property.enum.every((v) => typeof v === "string")) {
    return "enum";
  }
  const type = typeOf(property);
  if (type === "boolean") return "boolean";
  if (type === "integer") return "integer";
  if (type === "number") return "number";
  if (type === "string") return "string";
  if (type === "array" && isRecord(property.items) && typeOf(property.items) === "string") return "string-list";
  return "json";
}

/** One field per property of the completion schema, in declaration order. */
export function completionFields(schema: Record<string, unknown>): CompletionField[] {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((v): v is string => typeof v === "string") : [],
  );
  return Object.entries(properties).map(([name, raw]) => {
    const property = isRecord(raw) ? raw : {};
    const kind = kindOf(property);
    return {
      name,
      kind,
      required: required.has(name),
      title: typeof property.title === "string" && property.title !== "" ? property.title : name,
      ...(typeof property.description === "string" ? { description: property.description } : {}),
      ...(kind === "enum" ? { options: property.enum as string[] } : {}),
    };
  });
}

export type FieldDraft = string | boolean | undefined;

function draftValue(field: CompletionField, draft: FieldDraft): { include: boolean; value?: unknown } {
  if (field.kind === "boolean") {
    if (draft === undefined) return field.required ? { include: true, value: false } : { include: false };
    return { include: true, value: draft === true };
  }
  const text = typeof draft === "string" ? draft : "";
  if (text.trim() === "") return { include: false };
  switch (field.kind) {
    case "number":
    case "integer": {
      const parsed = Number(text);
      return { include: true, value: Number.isFinite(parsed) ? parsed : text };
    }
    case "string-list":
      return {
        include: true,
        value: text.split("\n").map((line) => line.trim()).filter((line) => line !== ""),
      };
    case "json":
      try {
        return { include: true, value: JSON.parse(text) as unknown };
      } catch {
        return { include: true, value: text };
      }
    default:
      return { include: true, value: text };
  }
}

/** The `typeFields` object a set of drafts submits. An empty optional field is omitted. */
export function typeFieldsFrom(
  fields: readonly CompletionField[],
  drafts: Readonly<Record<string, FieldDraft>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const { include, value } = draftValue(field, drafts[field.name]);
    if (include) out[field.name] = value;
  }
  return out;
}

export interface FieldsCheckRequest {
  slug: string;
  harness?: string;
  itemId: string;
  typeFields: Record<string, unknown>;
}

export type FieldsCheckResult =
  | { ok: true }
  | { ok: false; code?: string; errors?: string[]; error?: string };

export const PLAN_ITEM_TYPE_FIELDS_API = "/api/admin/plan-item-type-fields";

/** Default submit: the server route that runs the completion-schema validation. */
export async function postPlanItemTypeFields(request: FieldsCheckRequest): Promise<FieldsCheckResult> {
  const response = await fetch(PLAN_ITEM_TYPE_FIELDS_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const body: unknown = await response.json().catch(() => null);
  if (isRecord(body) && typeof body.ok === "boolean") return body as FieldsCheckResult;
  return { ok: false, errors: [`the field check failed with HTTP ${response.status}`] };
}

export interface ItemTypeCompletionFormProps {
  planSlug: string;
  harness?: string | null;
  itemId: string;
  schema: Record<string, unknown>;
  submit?: (request: FieldsCheckRequest) => Promise<FieldsCheckResult>;
  testId?: string;
}

export default function ItemTypeCompletionForm({
  planSlug,
  harness,
  itemId,
  schema,
  submit = postPlanItemTypeFields,
  testId,
}: ItemTypeCompletionFormProps) {
  const fields = useMemo(() => completionFields(schema), [schema]);
  const [drafts, setDrafts] = useState<Record<string, FieldDraft>>({});
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ check: FieldsCheckResult; typeFields: Record<string, unknown> } | null>(null);

  const setDraft = (name: string, value: FieldDraft) => {
    setDrafts((current) => ({ ...current, [name]: value }));
    setResult(null);
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const typeFields = typeFieldsFrom(fields, drafts);
    setPending(true);
    try {
      const check = await submit({ slug: planSlug, itemId, typeFields, ...(harness ? { harness } : {}) });
      setResult({ check, typeFields });
    } catch (error) {
      setResult({
        check: { ok: false, errors: [error instanceof Error ? error.message : String(error)] },
        typeFields,
      });
    } finally {
      setPending(false);
    }
  };

  const errors = result && !result.check.ok
    ? [...(result.check.errors ?? []), ...(result.check.error ? [result.check.error] : [])]
    : [];

  return (
    <form
      className="plan-dash__tform"
      data-testid={testId}
      aria-label={`Completion fields for ${itemId}`}
      onSubmit={(event) => void onSubmit(event)}
    >
      {fields.length === 0 ? (
        <div className="plan-dash__empty">This item type's completion schema declares no fields.</div>
      ) : null}
      {fields.map((field) => {
        const id = `ptf-${itemId}-${field.name}`;
        const draft = drafts[field.name];
        return (
          <div key={field.name} className="plan-dash__tfield" data-field={field.name} data-field-kind={field.kind}>
            <label htmlFor={id}>
              {field.title}
              {field.required ? <span aria-hidden="true"> *</span> : null}
            </label>
            {field.kind === "boolean" ? (
              <input
                id={id}
                type="checkbox"
                checked={draft === true}
                onChange={(event) => setDraft(field.name, event.target.checked)}
              />
            ) : field.kind === "enum" ? (
              <select
                id={id}
                value={typeof draft === "string" ? draft : ""}
                required={field.required}
                onChange={(event) => setDraft(field.name, event.target.value)}
              >
                <option value="">—</option>
                {(field.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : field.kind === "string-list" || field.kind === "json" ? (
              <textarea
                id={id}
                rows={3}
                value={typeof draft === "string" ? draft : ""}
                placeholder={field.kind === "string-list" ? "One entry per line" : "JSON value"}
                onChange={(event) => setDraft(field.name, event.target.value)}
              />
            ) : (
              <input
                id={id}
                type={field.kind === "string" ? "text" : "number"}
                step={field.kind === "integer" ? 1 : "any"}
                value={typeof draft === "string" ? draft : ""}
                onChange={(event) => setDraft(field.name, event.target.value)}
              />
            )}
            {field.description ? <div className="plan-dash__tfield-hint">{field.description}</div> : null}
          </div>
        );
      })}
      <div className="plan-dash__tform-actions">
        <button type="submit" disabled={pending}>
          {pending ? "Checking…" : "Check fields"}
        </button>
      </div>
      {result?.check.ok ? (
        <div className="plan-dash__tform-ok" role="status" data-testid={testId ? `${testId}-ok` : undefined}>
          The fields match the completion schema. Pass them as <code>completion.typeFields</code>:
          <pre>{JSON.stringify(result.typeFields, null, 2)}</pre>
        </div>
      ) : null}
      {errors.length > 0 ? (
        <ul className="plan-dash__tform-errors" role="alert" data-testid={testId ? `${testId}-errors` : undefined}>
          {errors.map((message, index) => (
            <li key={index}>{message}</li>
          ))}
        </ul>
      ) : null}
    </form>
  );
}

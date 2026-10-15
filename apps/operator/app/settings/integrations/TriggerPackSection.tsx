'use client';

/**
 * One installed trigger pack on Settings → Integrations (plan cupboard-distributable-integrations-
 * 2026-10-10 P-005, SPEC-R-2-P-005): its settings form, what it will do, what it still lacks, and
 * the Arm button.
 *
 * Everything is read from the pack's own manifest and review: the form fields from its
 * `triggerPack.inputs` JSON schema (a field with `x-options` becomes a picker filled by an installed
 * provider, P-004), the review from cupboard/trigger-pack-lifecycle.ts. Arming sends the review
 * fingerprint on screen, so a review that changed underneath the owner is refused, not armed.
 *
 * A pack the Cupboard installed without a project renders as `TriggerPackSetup` instead: the same
 * fields plus the project its plans run in, and a Set up button that materializes it (plan
 * decision D-017). From then on it is an ordinary section.
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { AvailableTriggerPack, TriggerPackSettings } from '@papercusp/operator-core/lib/cupboard/trigger-pack-lifecycle';
import type { TriggerPackUnmet } from '@papercusp/operator-core/lib/cupboard/trigger-pack-materialize';
import { Button } from '../../harness/Button';
import { Checkbox } from '../../harness/Checkbox';
import { Select } from '../../harness/Select';
import { ProviderOptionsSelect } from './ProviderOptionsSelect';
import {
  armTriggerPackRequest,
  IntegrationRequestError,
  saveTriggerPackInputs,
  setUpTriggerPackRequest,
} from './ticket-integrations-client';

type Values = Record<string, unknown>;

interface InputField {
  key: string;
  property: Record<string, unknown>;
  label: string;
  description: string;
  required: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The form fields, in schema order, from a pack's `triggerPack.inputs` JSON schema. */
export function inputFields(schema: Record<string, unknown> | null): InputField[] {
  if (!schema || !isRecord(schema.properties)) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === 'string') : []);
  return Object.entries(schema.properties)
    .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
    .map(([key, property]) => ({
      key,
      property,
      label: typeof property.title === 'string' && property.title ? property.title : key,
      description: typeof property.description === 'string' ? property.description : '',
      required: required.has(key),
    }));
}

/** One line per thing the pack still needs before it can be armed. */
export function unmetText(unmet: TriggerPackUnmet): string {
  const requirement = unmet.requirement;
  switch (unmet.reason) {
    case 'inputs-invalid':
      return `Settings: ${requirement.kind === 'inputs' ? requirement.errors.join('; ') : 'not valid yet'}`;
    case 'ambiguous':
      return `More than one connected source fits “${unmet.bindingId}”.`;
    case 'upstream-unmet':
      return `“${unmet.bindingId}” waits on “${requirement.kind === 'upstream' ? requirement.upstreamBindingId : 'an earlier step'}”.`;
    default:
      if (requirement.kind === 'source' && 'sourceKind' in requirement) return `Connect a ${requirement.sourceKind} source.`;
      if (requirement.kind === 'source' && 'datatype' in requirement) return `Connect a source that provides ${requirement.datatype}.`;
      return `“${unmet.bindingId}” has no source.`;
  }
}

const sameValues = (a: Values, b: Values): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * `onChanged` re-reads the page after this section's own successful save or arm. The page must not
 * wait on the server's push to see its own write: the sync bus drops a repeat of the same
 * invalidation inside its dedupe window (90s by default), so a save shortly after another
 * integrations write would leave the form dirty and its Save button enabled.
 */
export function TriggerPackSection({ pack, onChanged }: { pack: TriggerPackSettings; onChanged?: () => void }) {
  const fields = useMemo(() => inputFields(pack.inputsSchema), [pack.inputsSchema]);
  const savedKey = JSON.stringify(pack.inputs);
  const [draft, setDraft] = useState<Values>(pack.inputs);
  // A refresh from the server replaces the draft only when the saved values actually changed.
  useEffect(() => setDraft(JSON.parse(savedKey) as Values), [savedKey]);
  const [saving, setSaving] = useState(false);
  const [arming, setArming] = useState(false);

  const { state } = pack;
  const unmet = state.review.unmet;
  const dirty = !sameValues(draft, pack.inputs);
  const armedAll = state.current && state.bindingCount > 0 && state.armedBindingCount === state.bindingCount;
  const canArm = !dirty && unmet.length === 0 && state.bindingCount > 0 && !armedAll;

  const save = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      setSaving(true);
      try {
        const result = await saveTriggerPackInputs(pack.installationId, draft);
        onChanged?.();
        toast.success(
          result.unmet.length > 0
            ? `${pack.pluginName} settings saved. It still needs ${result.unmet.length} thing${result.unmet.length === 1 ? '' : 's'} before it can be armed.`
            : `${pack.pluginName} settings saved. Check what it will do below, then arm it.`,
        );
      } catch (err) {
        toast.error(`Couldn’t save ${pack.pluginName} settings: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setSaving(false);
      }
    },
    [draft, onChanged, pack.installationId, pack.pluginName],
  );

  const arm = useCallback(async () => {
    setArming(true);
    try {
      const result = await armTriggerPackRequest(pack.installationId, state.fingerprint);
      onChanged?.();
      toast.success(`${pack.pluginName} armed: ${result.armedBindingIds.length} trigger${result.armedBindingIds.length === 1 ? '' : 's'} on.`);
    } catch (err) {
      if (err instanceof IntegrationRequestError && err.code === 'trigger_pack_review_stale') {
        toast.error(`${pack.pluginName} changed since this page loaded. Check what it will do again, then arm it.`);
      } else {
        toast.error(`Couldn’t arm ${pack.pluginName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      setArming(false);
    }
  }, [onChanged, pack.installationId, pack.pluginName, state.fingerprint]);

  const status = armedAll
    ? `Armed · ${state.armedBindingCount} of ${state.bindingCount} triggers on`
    : unmet.length > 0
      ? 'Needs setup'
      : state.armedBindingCount > 0
        ? 'Changed since it was armed · review and arm again'
        : 'Not armed';

  return (
    <section className="pc-settings-section" aria-label={`${pack.pluginName} triggers`} data-trigger-pack={pack.pluginName} style={cardStyle}>
      <div style={cardHead}>
        <div style={{ minWidth: 0 }}>
          <h2 style={cardTitle}>{pack.pluginName}</h2>
          <div style={metaText}>
            Version {pack.pluginVersion} · runs plans in <code>{pack.harnessSlug}</code>
          </div>
        </div>
        <span role="status" style={armedAll ? goodText : hintText}>
          {status}
        </span>
      </div>

      {fields.length > 0 && (
        <form onSubmit={(event) => void save(event)} aria-label={`${pack.pluginName} settings`} style={formStyle}>
          {fields.map((field) => (
            <FieldInput
              key={field.key}
              id={`pack-${pack.installationId}-${field.key}`}
              field={field}
              value={draft[field.key]}
              disabled={saving}
              onChange={(value) => setDraft((prev) => ({ ...prev, [field.key]: value }))}
            />
          ))}
          <div>
            <Button type="submit" disabled={!dirty || saving}>
              {saving ? 'Saving…' : 'Save settings'}
            </Button>
          </div>
        </form>
      )}

      <h3 style={subTitle}>What it will do</h3>
      {state.review.bindings.length === 0 ? (
        <p style={muteText}>This pack has no triggers yet.</p>
      ) : (
        <ul aria-label={`${pack.pluginName} triggers`} style={listStyle}>
          {state.review.bindings.map((binding) => (
            <li key={binding.packBindingId} style={bodyText}>
              When <code>{binding.eventPattern}</code>
              {binding.source.kind ? <> arrives from {binding.source.kind}</> : null}
              {binding.target.planSlug ? (
                <>
                  , run plan <code>{binding.target.planSlug}</code>
                </>
              ) : null}
              .
            </li>
          ))}
        </ul>
      )}
      {state.review.recipients.length > 0 && (
        <p style={bodyText}>
          Sends to: {state.review.recipients.map((r) => `${String(r.value)} (${r.input})`).join(', ')}
        </p>
      )}

      {unmet.length > 0 && (
        <>
          <h3 style={subTitle}>Still needed</h3>
          <ul aria-label={`${pack.pluginName} still needs`} style={listStyle}>
            {unmet.map((item, index) => (
              <li key={`${item.bindingId}-${index}`} style={warnText}>
                {unmetText(item)}
              </li>
            ))}
          </ul>
        </>
      )}

      <div style={{ marginTop: 10 }}>
        <Button variant="primary" onClick={() => void arm()} disabled={!canArm || arming}>
          {arming ? 'Arming…' : state.armedBindingCount > 0 && !state.current ? 'Arm again with these changes' : `Arm ${pack.pluginName}`}
        </Button>
        {dirty && <span style={{ ...hintText, marginLeft: 8 }}>Save your settings before arming.</span>}
      </div>
    </section>
  );
}

// ── a pack installed from the Cupboard, not set up yet (D-017) ──────────────────────────────────

/** `@scope/name` is not a usable element id. */
const domId = (name: string): string => name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * The Cupboard installs a package without choosing a project, so its pack has no installation yet.
 * The owner picks the project its plans run in, fills its settings, and sets it up; its triggers
 * stay off until it is reviewed and armed in the section that replaces this one.
 */
export function TriggerPackSetup({
  pack,
  harnesses,
  onChanged,
}: {
  pack: AvailableTriggerPack;
  harnesses: string[];
  onChanged?: () => void;
}) {
  const fields = useMemo(() => inputFields(pack.inputsSchema), [pack.inputsSchema]);
  const [draft, setDraft] = useState<Values>({});
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);
  // With exactly one project there is nothing to choose.
  const harness = picked || (harnesses.length === 1 ? harnesses[0] : '');
  const idBase = `pack-setup-${domId(pack.pluginName)}`;

  const setUp = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!harness) return;
      setBusy(true);
      try {
        const result = await setUpTriggerPackRequest(pack.pluginName, harness, draft);
        onChanged?.();
        toast.success(
          result.unmet.length > 0
            ? `${pack.pluginName} is set up in ${harness}. It still needs ${result.unmet.length} thing${result.unmet.length === 1 ? '' : 's'} before it can be armed.`
            : `${pack.pluginName} is set up in ${harness}. Check what it will do, then arm it.`,
        );
      } catch (err) {
        toast.error(`Couldn’t set up ${pack.pluginName}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [draft, harness, onChanged, pack.pluginName],
  );

  return (
    <section
      className="pc-settings-section"
      aria-label={`${pack.pluginName} triggers`}
      data-trigger-pack={pack.pluginName}
      data-trigger-pack-state="not-set-up"
      style={cardStyle}
    >
      <div style={cardHead}>
        <div style={{ minWidth: 0 }}>
          <h2 style={cardTitle}>{pack.pluginName}</h2>
          <div style={metaText}>Version {pack.pluginVersion} · installed, not set up yet</div>
        </div>
        <span role="status" style={hintText}>
          Not set up
        </span>
      </div>
      {pack.description && <p style={bodyText}>{pack.description}</p>}
      <form onSubmit={(event) => void setUp(event)} aria-label={`Set up ${pack.pluginName}`} style={formStyle}>
        <div style={fieldStyle}>
          <label htmlFor={`${idBase}-harness`} style={labelStyle}>
            Run its plans in (required)
          </label>
          <Select
            id={`${idBase}-harness`}
            ariaLabel="Run its plans in"
            value={harness}
            onChange={(value) => setPicked(String(value))}
            options={harnesses.map((slug) => ({ value: slug, label: slug }))}
            placeholder={harnesses.length > 0 ? 'Choose a project…' : 'No projects yet'}
            disabled={busy || harnesses.length === 0}
            triggerStyle={inputStyle}
          />
          <div style={hintText}>The project whose plans this workflow runs. Its triggers stay off until you arm them.</div>
        </div>
        {fields.map((field) => (
          <FieldInput
            key={field.key}
            id={`${idBase}-${field.key}`}
            field={field}
            value={draft[field.key]}
            disabled={busy}
            onChange={(value) => setDraft((prev) => ({ ...prev, [field.key]: value }))}
          />
        ))}
        <div>
          <Button type="submit" variant="primary" disabled={!harness || busy}>
            {busy ? 'Setting up…' : `Set up ${pack.pluginName}`}
          </Button>
        </div>
      </form>
    </section>
  );
}

// ── one settings field ────────────────────────────────────────────────────────────────────────

function FieldInput({
  id,
  field,
  value,
  disabled,
  onChange,
}: {
  id: string;
  field: InputField;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const { property } = field;
  const label = `${field.label}${field.required ? ' (required)' : ''}`;
  const hint = field.description ? <div style={hintText}>{field.description}</div> : null;

  if (property['x-options'] !== undefined) {
    return (
      <div style={fieldStyle}>
        <ProviderOptionsSelect
          id={id}
          label={label}
          property={property}
          value={typeof value === 'string' || Array.isArray(value) ? (value as string | string[]) : undefined}
          onChange={onChange}
          disabled={disabled}
        />
        {hint}
      </div>
    );
  }

  let control;
  if (Array.isArray(property.enum)) {
    control = (
      <Select
        id={id}
        ariaLabel={label}
        value={typeof value === 'string' ? value : ''}
        onChange={onChange}
        options={property.enum.map((option) => ({ value: String(option), label: String(option) }))}
        placeholder="Choose…"
        disabled={disabled}
        triggerStyle={inputStyle}
      />
    );
  } else if (property.type === 'boolean') {
    control = <Checkbox id={id} ariaLabel={label} checked={value === true} disabled={disabled} onChange={onChange} />;
  } else if (property.type === 'number' || property.type === 'integer') {
    control = (
      <input
        id={id}
        type="number"
        value={typeof value === 'number' ? value : ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        style={inputStyle}
      />
    );
  } else if (property.type === 'array') {
    control = (
      <input
        id={id}
        type="text"
        value={Array.isArray(value) ? value.join(', ') : ''}
        disabled={disabled}
        placeholder="Separate several with commas"
        onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
        style={inputStyle}
      />
    );
  } else {
    control = (
      <input id={id} type="text" value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} style={inputStyle} />
    );
  }
  return (
    <div style={fieldStyle}>
      <label htmlFor={id} style={labelStyle}>
        {label}
      </label>
      {control}
      {hint}
    </div>
  );
}

const muteText: CSSProperties = { color: 'var(--fg-mute)', fontSize: 13, margin: '6px 0' };
const bodyText: CSSProperties = { color: 'var(--fg)', fontSize: 13, margin: '4px 0' };
const hintText: CSSProperties = { color: 'var(--fg-mute)', fontSize: 12 };
const goodText: CSSProperties = { color: 'var(--good, #3fb950)', fontSize: 12 };
const warnText: CSSProperties = { color: 'var(--warn, #d29922)', fontSize: 13, margin: '4px 0' };
const metaText: CSSProperties = { color: 'var(--fg-mute)', fontSize: 12, marginTop: 2 };
const cardStyle: CSSProperties = { marginBottom: 20 };
const cardHead: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 8 };
const cardTitle: CSSProperties = { fontSize: 16, margin: 0 };
const subTitle: CSSProperties = { fontSize: 13, margin: '12px 0 4px' };
const listStyle: CSSProperties = { margin: 0, paddingLeft: 18 };
const formStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, margin: '8px 0' };
const fieldStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 420 };
const labelStyle: CSSProperties = { fontSize: 13, color: 'var(--fg)' };
const inputStyle: CSSProperties = {
  background: 'var(--bg)',
  color: 'var(--fg)',
  border: '1px solid var(--border, rgba(127,127,127,0.35))',
  borderRadius: 4,
  padding: '5px 8px',
  fontSize: 13,
};

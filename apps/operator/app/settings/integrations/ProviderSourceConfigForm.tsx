'use client';

/** Uses the existing source config endpoint and schema renderer for every non-ticket provider. */
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { TicketSourceSummary } from '@papercusp/operator-core/lib/integrations/ticket-integrations';
import SchemaForm from '../../dev/_components/SchemaForm';
import { Button } from '../../harness/Button';
import { integrationRequest } from './ticket-integrations-client';

export function ProviderSourceConfigForm({ source, displayName, schema, onSaved }: {
  source: Pick<TicketSourceSummary, 'id' | 'config'>;
  displayName: string;
  schema: Record<string, unknown>;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(source.config);
  const [saving, setSaving] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const properties = schema.properties && typeof schema.properties === 'object' ? Object.keys(schema.properties) : [];
    const patch = Object.fromEntries(properties.map((key) => [key, draft[key] ?? null]));
    setSaving(true);
    try {
      await integrationRequest(`/sources/${encodeURIComponent(source.id)}/config`, 'PATCH', { patch });
      toast.success(`${displayName} connection settings saved.`);
      onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <details>
      <summary>Configure connection</summary>
      <form aria-label={`${displayName} connection settings`} onSubmit={(event) => void save(event)} style={{ display: 'grid', gap: 12, paddingTop: 12 }}>
        <fieldset disabled={saving} style={{ border: 0, padding: 0 }}>
          <SchemaForm schema={schema} value={draft} onChange={setDraft} />
        </fieldset>
        <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save connection settings'}</Button>
      </form>
    </details>
  );
}

'use client';

/**
 * How a provider's connected source is shared, on its card (cupboard-distributable-integrations-
 * 2026-10-10 D-026 ruling 4).
 *
 * Renders only what the provider's descriptor offers (`provider.sourceSettings`, derived host-side
 * from `membership` and the `search.live` capability) and names no provider:
 *   - who can read what it syncs: only the owner, or the organization, each document readable by
 *     the people who can see it at the provider;
 *   - live search: searched at read time, as the person asking, instead of copied.
 * Saving goes through the same setup route as the credentials (`source` in the PUT body), which
 * invalidates `integrations.tickets`, so the card shows the stored choice from the live query.
 */

import { useCallback, useState, type CSSProperties, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { ProviderSourceSettingsOffer } from '@papercusp/operator-core/lib/integrations/provider-source-settings';
import { Button } from '../../harness/Button';
import { Checkbox } from '../../harness/Checkbox';
import { RadioGroup } from '../../harness/RadioGroup';
import { providerCredentialsPath } from './ProviderCredentialsForm';
import { IntegrationRequestError } from './ticket-integrations-client';

type Scope = 'personal' | 'organization';

const SCOPE_OPTIONS: ReadonlyArray<{ value: Scope }> = [{ value: 'personal' }, { value: 'organization' }];

async function saveSettings(providerId: string, source: { scope: Scope; liveSearch?: boolean }): Promise<void> {
  const res = await fetch(providerCredentialsPath(providerId), {
    method: 'PUT',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source }),
  });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; detail?: string } | null;
  if (!res.ok || !json || json.ok === false) {
    throw new IntegrationRequestError(json?.error ?? `http_${res.status}`, json?.detail ?? json?.error ?? `HTTP ${res.status}`);
  }
}

export function ProviderSourceSettingsForm({
  providerId,
  displayName,
  offer,
  sources,
}: {
  providerId: string;
  displayName: string;
  offer: ProviderSourceSettingsOffer;
  /** The owner's connected sources for this provider; the settings apply to all of them. */
  sources: ReadonlyArray<{ scope: string; liveSearch: boolean }>;
}) {
  const current = sources[0];
  const storedScope: Scope = current?.scope === 'organization' ? 'organization' : 'personal';
  const storedLive = current?.liveSearch === true;
  // Mid-edit choices before Save: transient form state, so useState rather than the URL.
  const [scope, setScope] = useState<Scope | null>(null);
  const [live, setLive] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const nextScope = scope ?? storedScope;
  const nextLive = nextScope === 'organization' && (live ?? storedLive);
  const changed = nextScope !== storedScope || nextLive !== storedLive;

  const save = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      setFormError(null);
      setBusy(true);
      try {
        await saveSettings(providerId, { scope: nextScope, ...(offer.liveSearch ? { liveSearch: nextLive } : {}) });
        setScope(null);
        setLive(null);
        toast.success(`${displayName} sharing saved.`);
      } catch (err) {
        setFormError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [displayName, nextLive, nextScope, offer.liveSearch, providerId],
  );

  if (!offer.organization || !current) return null;

  return (
    <form
      onSubmit={(event) => void save(event)}
      style={formStyle}
      aria-label={`${displayName} sharing`}
      data-provider-source-settings={providerId}
      data-scope={storedScope}
      data-live-search={storedLive ? 'true' : 'false'}
    >
      <fieldset style={fieldsetStyle}>
        <legend style={labelText}>Who can read what it syncs</legend>
        <RadioGroup label="Who can read what it syncs" value={nextScope} options={SCOPE_OPTIONS} onChange={setScope} optionStyle={() => choiceButton}>
          {(option, selected) => (
            <>
              <span aria-hidden="true">{selected ? '◉' : '○'}</span>
              <span>
                {option.value === 'personal'
                  ? 'Only you'
                  : `Your organization: each item is readable by the people who can see it in ${displayName}`}
              </span>
            </>
          )}
        </RadioGroup>
      </fieldset>
      {offer.liveSearch && (
        // The wrapping label names the checkbox and keeps the whole sentence a click target.
        <label style={checkRow}>
          <Checkbox checked={nextLive} disabled={nextScope !== 'organization'} onChange={setLive} style={{ marginTop: 2 }} />
          Search {displayName} live instead of copying it. Each search runs as the person asking, with their own access.
        </label>
      )}
      {formError && (
        <p role="alert" style={errorText}>
          {formError}
        </p>
      )}
      <div style={actionRow}>
        <Button type="submit" variant="primary" disabled={busy || !changed}>
          {busy ? 'Saving…' : 'Save sharing'}
        </Button>
      </div>
    </form>
  );
}

const formStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, margin: '8px 0 12px' };
const fieldsetStyle: CSSProperties = { border: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 };
const labelText: CSSProperties = { fontSize: 13, color: 'var(--fg)', padding: 0, marginBottom: 2 };
const choiceButton: CSSProperties = {
  display: 'flex',
  width: '100%',
  gap: 6,
  alignItems: 'baseline',
  padding: '2px 0',
  border: 'none',
  background: 'transparent',
  color: 'var(--fg)',
  fontFamily: 'inherit',
  fontSize: 13,
  textAlign: 'left',
  cursor: 'pointer',
};
const checkRow: CSSProperties = { display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 13, color: 'var(--fg)' };
const errorText: CSSProperties = { color: 'var(--bad)', fontSize: 12, margin: '4px 0 0', overflowWrap: 'anywhere' };
const actionRow: CSSProperties = { display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' };

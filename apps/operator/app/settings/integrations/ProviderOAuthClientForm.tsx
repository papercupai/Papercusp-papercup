'use client';

/**
 * The owner's OAuth app registration on an OAuth provider's card (cupboard-distributable-
 * integrations-2026-10-10 P-009; SPEC-R-2-P-009, SPEC-R-7-P-009).
 *
 * A provider package never ships a client secret, so before an OAuth provider can connect the
 * owner registers an app with the vendor and enters its client ID and secret here. The form names
 * no provider: it renders from the summary's `oauthClient` status. A saved secret never comes back
 * to the page; a saved registration shows its client ID and when it was saved, with Replace. The
 * redirect URL the vendor needs is shown so the owner can paste it into the vendor's app settings.
 *
 * Writes go to /api/user/integrations/providers/:id/oauth-client; that route invalidates
 * `integrations.tickets`, so the card updates from the live query rather than a poll.
 */

import { useCallback, useState, type CSSProperties, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { ProviderOAuthClientSummary } from '@papercusp/operator-core/lib/integrations/ticket-integrations';
import { Button } from '../../harness/Button';
import { formatTime, IntegrationRequestError } from './ticket-integrations-client';

export const providerOAuthClientPath = (providerId: string): string =>
  `/api/user/integrations/providers/${encodeURIComponent(providerId)}/oauth-client`;

/** The same shape check the host runs: one line, no spaces or control characters. */
function valueIssue(label: string, value: string): string | null {
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return `${label} contains spaces or control characters.`;
  return null;
}

export function ProviderOAuthClientForm({
  providerId,
  displayName,
  client,
}: {
  providerId: string;
  displayName: string;
  client: ProviderOAuthClientSummary | null;
}) {
  // Mid-edit drafts and whether a saved registration is being replaced: transient form state.
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const editing = Boolean(client && (!client.configured || replacing));
  const secretNeeded = Boolean(client && client.secretRequired && !client.hasClientSecret);

  const save = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      setFormError(null);
      const id = clientId.trim();
      const secret = clientSecret.trim();
      if (!id) {
        setFormError('Enter the app’s client ID.');
        return;
      }
      if (secretNeeded && !secret) {
        setFormError('Enter the app’s client secret as well.');
        return;
      }
      const issue = valueIssue('Client ID', id) ?? (secret ? valueIssue('Client secret', secret) : null);
      if (issue) {
        setFormError(issue);
        return;
      }
      setBusy(true);
      try {
        const res = await fetch(providerOAuthClientPath(providerId), {
          method: 'PUT',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(secret ? { clientId: id, clientSecret: secret } : { clientId: id }),
        });
        const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; detail?: string } | null;
        if (!res.ok || !json || json.ok === false) {
          throw new IntegrationRequestError(json?.error ?? `http_${res.status}`, json?.detail ?? json?.error ?? `HTTP ${res.status}`);
        }
        setClientId('');
        setClientSecret('');
        setReplacing(false);
        toast.success(`${displayName} OAuth app saved.`);
      } catch (err) {
        setFormError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [clientId, clientSecret, displayName, providerId, secretNeeded],
  );

  if (!client) return null;

  return (
    <form
      onSubmit={(event) => void save(event)}
      style={formStyle}
      aria-label={`${displayName} OAuth app`}
      data-provider-oauth-client={providerId}
      data-configured={client.configured ? 'true' : 'false'}
    >
      <div style={fieldHead}>
        <span style={labelText}>OAuth app</span>
        <span style={metaText} role="status">
          {client.configured
            ? `Client ID ${client.clientId ?? ''}${client.savedAt ? ` · saved ${formatTime(client.savedAt)}` : ''}`
            : `Not registered yet: ${displayName} sign-in needs your own OAuth app.`}
        </span>
      </div>
      <p style={hintText}>
        Redirect URL for the app: <code data-oauth-redirect-uri>{client.redirectUri}</code>
      </p>
      {editing ? (
        <>
          <input
            type="text"
            name="oauth-client-id"
            aria-label="Client ID"
            autoComplete="off"
            spellCheck={false}
            placeholder="Client ID"
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            style={inputStyle}
          />
          <input
            type="password"
            name="oauth-client-secret"
            aria-label="Client secret"
            autoComplete="off"
            spellCheck={false}
            placeholder={client.hasClientSecret ? 'Client secret (leave blank to keep the saved one)' : 'Client secret'}
            value={clientSecret}
            onChange={(event) => setClientSecret(event.target.value)}
            style={inputStyle}
          />
        </>
      ) : null}
      {formError && (
        <p role="alert" style={errorText}>
          {formError}
        </p>
      )}
      <div style={actionRow}>
        {editing ? (
          <>
            <Button type="submit" variant="primary" disabled={busy || clientId.trim() === ''}>
              {busy ? 'Saving…' : 'Save OAuth app'}
            </Button>
            {client.configured && (
              <Button
                type="button"
                variant="neutral"
                onClick={() => {
                  setReplacing(false);
                  setClientId('');
                  setClientSecret('');
                  setFormError(null);
                }}
              >
                Keep saved app
              </Button>
            )}
          </>
        ) : (
          <Button type="button" variant="neutral" onClick={() => setReplacing(true)}>
            Replace
          </Button>
        )}
      </div>
    </form>
  );
}

const formStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, margin: '8px 0 12px' };
const fieldHead: CSSProperties = { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' };
const labelText: CSSProperties = { fontSize: 13, color: 'var(--fg)' };
const metaText: CSSProperties = { color: 'var(--fg-mute)', fontSize: 12, overflowWrap: 'anywhere' };
const hintText: CSSProperties = { color: 'var(--fg-mute)', fontSize: 12, margin: 0, overflowWrap: 'anywhere' };
const errorText: CSSProperties = { color: 'var(--bad)', fontSize: 12, margin: '4px 0 0', overflowWrap: 'anywhere' };
const actionRow: CSSProperties = { display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' };
const inputStyle: CSSProperties = {
  background: 'var(--bg)',
  color: 'var(--fg)',
  border: '1px solid var(--border, rgba(127,127,127,0.35))',
  borderRadius: 4,
  padding: '5px 8px',
  fontSize: 13,
};

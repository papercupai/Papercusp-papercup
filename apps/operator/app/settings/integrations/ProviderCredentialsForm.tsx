'use client';

/**
 * Paste-a-secret fields on a provider card (cupboard-distributable-integrations-2026-10-10 P-001;
 * SPEC-R-2-P-001).
 *
 * The provider package declares the fields (`setup.credentials`); this form renders whatever it
 * declares and names no provider. A stored value never comes back to the page: a configured field
 * shows when it was saved, with Replace and Clear. Inputs are masked, never prefilled, and each
 * value is checked with the SDK's own `providerCredentialValueIssue` before it is sent, the same
 * check the host runs, so the page and the host never disagree about what is acceptable.
 *
 * A field the package declares `perPrincipal` (D-026) is each signed-in person's own: its status
 * describes the viewer's value, and the card says so.
 *
 * Writes go to /api/user/integrations/providers/:id/credentials; that route invalidates
 * `integrations.tickets`, so the card's status updates from the live query rather than a poll.
 */

import { useCallback, useState, type CSSProperties, type FormEvent } from 'react';
import { toast } from 'sonner';
import { providerCredentialValueIssue } from '@papercusp/plugin-sdk/provider';
import type { ProviderCredentialStatus } from '@papercusp/operator-core/lib/integrations/provider-credentials';
import { Button } from '../../harness/Button';
import { openExternalWebUrl } from '../../_components/ExternalLinkProvider';
import { formatTime, IntegrationRequestError } from './ticket-integrations-client';

export const providerCredentialsPath = (providerId: string): string =>
  `/api/user/integrations/providers/${encodeURIComponent(providerId)}/credentials`;

async function credentialRequest(path: string, method: 'PUT' | 'DELETE', body?: unknown): Promise<void> {
  const res = await fetch(path, {
    method,
    cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; detail?: string } | null;
  if (!res.ok || !json || json.ok === false) {
    throw new IntegrationRequestError(json?.error ?? `http_${res.status}`, json?.detail ?? json?.error ?? `HTTP ${res.status}`);
  }
}

export function ProviderCredentialsForm({
  providerId,
  displayName,
  credentials,
}: {
  providerId: string;
  displayName: string;
  credentials: ProviderCredentialStatus[];
}) {
  // Mid-edit drafts and which configured fields are being replaced: transient form state, so
  // useState rather than the URL. Values are never written anywhere but the PUT body.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [replacing, setReplacing] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const editing = credentials.filter((field) => !field.configured || replacing[field.key]);
  const pending = editing.filter((field) => (drafts[field.key] ?? '').trim() !== '');

  const save = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      setFormError(null);
      const values: Record<string, string> = {};
      for (const field of pending) {
        const value = drafts[field.key] ?? '';
        const issue = providerCredentialValueIssue({ label: field.label, ...(field.pattern ? { pattern: field.pattern } : {}) }, value);
        if (issue) {
          setFormError(issue);
          return;
        }
        values[field.key] = value;
      }
      if (Object.keys(values).length === 0) return;
      setBusy('save');
      try {
        await credentialRequest(providerCredentialsPath(providerId), 'PUT', { values });
        setDrafts({});
        setReplacing({});
        toast.success(`${displayName} credentials saved.`);
      } catch (err) {
        setFormError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [displayName, drafts, pending, providerId],
  );

  const clear = useCallback(
    async (field: ProviderCredentialStatus) => {
      setFormError(null);
      setBusy(`clear:${field.key}`);
      try {
        await credentialRequest(`${providerCredentialsPath(providerId)}/${encodeURIComponent(field.key)}`, 'DELETE');
        toast.success(`${field.label} cleared.`);
      } catch (err) {
        setFormError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [providerId],
  );

  if (credentials.length === 0) return null;

  return (
    <form onSubmit={(event) => void save(event)} style={formStyle} aria-label={`${displayName} credentials`} data-provider-credentials={providerId}>
      {credentials.map((field) => {
        const open = !field.configured || replacing[field.key];
        return (
          <div key={field.key} style={fieldStyle} data-credential={field.key} data-configured={field.configured ? 'true' : 'false'}>
            <div style={fieldHead}>
              <span style={labelText}>{field.label}</span>
              {field.perPrincipal && (
                <span style={metaText} data-per-principal="true">
                  Your own: only your searches use it, and nobody else sees it
                </span>
              )}
              {field.configured && (
                <span style={metaText}>{field.savedAt ? `Saved ${formatTime(field.savedAt)}` : 'Saved'}</span>
              )}
            </div>
            {(field.help || field.helpUrl) && (
              <p style={hintText}>
                {field.help}
                {field.helpUrl && (
                  <>
                    {field.help ? ' ' : ''}
                    <a
                      href={field.helpUrl}
                      onClick={(event) => {
                        event.preventDefault();
                        void openExternalWebUrl(field.helpUrl!);
                      }}
                    >
                      Where to find it
                    </a>
                  </>
                )}
              </p>
            )}
            {open ? (
              <input
                type="password"
                name={`credential-${field.key}`}
                aria-label={field.label}
                autoComplete="off"
                spellCheck={false}
                placeholder={field.placeholder ?? ''}
                value={drafts[field.key] ?? ''}
                onChange={(event) => setDrafts((prev) => ({ ...prev, [field.key]: event.target.value }))}
                style={inputStyle}
              />
            ) : null}
            {field.configured && (
              <div style={actionRow}>
                {replacing[field.key] ? (
                  <Button
                    type="button"
                    variant="neutral"
                    onClick={() => {
                      setReplacing((prev) => ({ ...prev, [field.key]: false }));
                      setDrafts((prev) => ({ ...prev, [field.key]: '' }));
                    }}
                  >
                    Keep saved value
                  </Button>
                ) : (
                  <Button type="button" variant="neutral" onClick={() => setReplacing((prev) => ({ ...prev, [field.key]: true }))}>
                    Replace
                  </Button>
                )}
                <Button type="button" variant="neutral" disabled={busy !== null} onClick={() => void clear(field)}>
                  {busy === `clear:${field.key}` ? 'Clearing…' : 'Clear'}
                </Button>
              </div>
            )}
          </div>
        );
      })}
      {formError && (
        <p role="alert" style={errorText}>
          {formError}
        </p>
      )}
      {editing.length > 0 && (
        <div style={actionRow}>
          <Button type="submit" variant="primary" disabled={busy !== null || pending.length === 0}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}
    </form>
  );
}

const formStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, margin: '8px 0 12px' };
const fieldStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 };
const fieldHead: CSSProperties = { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' };
const labelText: CSSProperties = { fontSize: 13, color: 'var(--fg)' };
const metaText: CSSProperties = { color: 'var(--fg-mute)', fontSize: 12 };
const hintText: CSSProperties = { color: 'var(--fg-mute)', fontSize: 12, margin: 0 };
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

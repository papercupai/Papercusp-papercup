'use client';

/**
 * "Create app" on a provider card (cupboard-distributable-integrations-2026-10-10 P-002;
 * SPEC-R-2-P-002).
 *
 * The provider package declares the vendor app the owner creates first (`setup.appRegistration`);
 * this row renders whatever it declares and names no provider. "Create app" opens the vendor's
 * page with the app definition already filled in (the host resolves the descriptor's `{definition}`
 * placeholder into `createUrl`). Some vendors prefill only part of a definition, or document no
 * prefill at all, so "Copy definition" puts the same definition on the clipboard to paste by hand.
 */

import { useCallback, useState, type CSSProperties } from 'react';
import { toast } from 'sonner';
import type { ProviderAppRegistrationView } from '@papercusp/plugin-sdk/provider';
import { Button } from '../../harness/Button';
import { openExternalWebUrl } from '../../_components/ExternalLinkProvider';

export function ProviderAppRegistration({
  providerId,
  displayName,
  registration,
}: {
  providerId: string;
  displayName: string;
  registration: ProviderAppRegistrationView | null;
}) {
  const [busy, setBusy] = useState<'create' | 'copy' | null>(null);

  const create = useCallback(async () => {
    if (!registration) return;
    setBusy('create');
    try {
      await openExternalWebUrl(registration.createUrl);
    } catch (err) {
      toast.error(`Couldn’t open the ${displayName} app page: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }, [registration, displayName]);

  const copy = useCallback(async () => {
    if (!registration?.definitionText) return;
    setBusy('copy');
    try {
      await navigator.clipboard.writeText(registration.definitionText);
      toast.success(registration.copyHint ? `Definition copied. ${registration.copyHint}` : 'Definition copied.');
    } catch (err) {
      toast.error(`Couldn’t copy the definition: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }, [registration]);

  if (!registration) return null;

  return (
    <div style={rowStyle} aria-label={`${displayName} app`} data-provider-app-registration={providerId}>
      <p style={hintText}>
        {displayName} needs an app in your own {displayName} account first. Create it from the definition below, then
        connect it here.
      </p>
      <div style={actionRow}>
        {/* A link, not a button: it navigates to the vendor's page (the SDK contract calls it the
            "Create app" link), so the resolved URL is in the DOM for hover, copy-link and agents.
            The click still goes through the system opener — the webview cannot open it itself.
            createUrl is validated https at manifest validation (validateProviderAppRegistration). */}
        <Button asChild variant="neutral">
          <a
            href={registration.createUrl}
            aria-disabled={busy !== null}
            onClick={(event) => {
              event.preventDefault();
              if (busy === null) void create();
            }}
          >
            Create {displayName} app
          </a>
        </Button>
        {registration.definitionText !== null && (
          <Button type="button" variant="ghost" disabled={busy !== null} onClick={() => void copy()}>
            Copy definition
          </Button>
        )}
        {registration.docsUrl && (
          <a
            href={registration.docsUrl}
            style={linkStyle}
            onClick={(event) => {
              event.preventDefault();
              void openExternalWebUrl(registration.docsUrl!);
            }}
          >
            How to create it
          </a>
        )}
      </div>
    </div>
  );
}

const rowStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, margin: '8px 0 4px' };
const hintText: CSSProperties = { color: 'var(--fg-mute)', fontSize: 12, margin: 0 };
const actionRow: CSSProperties = { display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' };
const linkStyle: CSSProperties = { fontSize: 12, color: 'var(--accent)' };

/**
 * WI-6554700010018437 — what the create/link picker tells the user about the
 * per-harness schema provisioning that POST /api/harness/projects runs.
 *
 * The route answers 200 even when the schema scaffold failed (it reports
 * `provisioning: { ok: false, error }`), and a project registered that way is
 * unusable: every read fails with "relation agent_chats does not exist". The
 * picker used to toast "added" regardless. This helper turns the envelope into
 * the one message the user must see, so a failure is never shown as success.
 *
 * Re-submitting the SAME slug + folder is the supported retry: the route treats
 * it as an idempotent re-provision (`reprovisioned: true`) instead of a 409.
 */

export type ProvisioningEnvelope = {
  provisioning?: { ok: true } | { ok: false; error?: string };
  reprovisioned?: boolean;
};

export type ProvisioningNotice =
  | { kind: 'failed'; message: string }
  | { kind: 'reprovisioned'; message: string }
  | null;

export function provisioningNotice(data: ProvisioningEnvelope, slug: string): ProvisioningNotice {
  const p = data.provisioning;
  if (p && p.ok === false) {
    const why = p.error ? `: ${p.error}` : '';
    return {
      kind: 'failed',
      message: `'${slug}' is registered, but its database schema could not be provisioned${why}. Submit the same folder again to retry.`,
    };
  }
  if (data.reprovisioned) {
    return { kind: 'reprovisioned', message: `'${slug}' was already registered at this folder; its database schema was re-provisioned.` };
  }
  return null;
}

/**
 * Channel-2 publisher attestation (relocated from the retired per-harness
 * publish route — comb-retire-per-harness-sharing-2026-06-11 P-006; originally
 * Phase 9 item 1). Resolves the local GitHub identity + device keypair +
 * idempotent device-binding gist so a Cupboard publish can be attributed to a
 * verifiable, bannable device identity.
 *
 * Deps are injectable for testing; defaults lazily import the real identity
 * modules (only the deps actually used are imported). Returns `null` on ANY
 * failure (no gh auth, keychain miss, gist API down) — attestation is
 * best-effort and must NEVER block a publish.
 */

export interface AttestationDeps {
  resolveIdentity: () => Promise<{
    kind: string;
    githubUserId?: number;
    githubLogin?: string;
    token?: string;
  }>;
  keychainIdFor: (githubUserId: number) => string | Promise<string>;
  loadKeypair: (keychainId: string) => Promise<{ pubkeyBase64: string }>;
  ensureGist: (input: {
    keychainId: string;
    pubkeyBase64: string;
    deviceLabel: string;
    githubUserId: number;
    githubLogin: string;
    token: string;
    knownGistId?: string;
  }) => Promise<string>;
  /**
   * WI-10006733: the gist this SAME device resolved before (announce identity
   * cache), passed to ensureGist as a verify-first hint so a publish does not
   * walk every gist on the account. Defaults to the cache only when ensureGist
   * is the real one, so injected-dependency tests stay hermetic.
   */
  knownGistIdFor: (device: {
    keychainId: string;
    pubkeyBase64: string;
    githubUserId: number;
  }) => Promise<string | undefined>;
}

async function cachedGistIdFor(device: {
  keychainId: string;
  pubkeyBase64: string;
  githubUserId: number;
}): Promise<string | undefined> {
  const { loadCachedLocalAnnounceIdentity } = await import(
    '../sync/hyperbee/local-announce-identity'
  );
  const cached = await loadCachedLocalAnnounceIdentity().catch(() => null);
  if (
    !cached ||
    cached.keychainId !== device.keychainId ||
    cached.devicePubkeyBase64 !== device.pubkeyBase64 ||
    cached.githubUserId !== device.githubUserId
  ) {
    return undefined;
  }
  return cached.attestationGistId || undefined;
}

export async function resolvePublisherAttestation(
  deps?: Partial<AttestationDeps>,
): Promise<{ attestation_gist_id: string; publisher_device_pubkey: string } | null> {
  try {
    const resolveIdentity =
      deps?.resolveIdentity ??
      (async () =>
        (await import('../identity/resolve-local-github-identity')).resolveLocalGithubIdentity());
    const keychainIdFor =
      deps?.keychainIdFor ??
      (async (id: number) =>
        (await import('../identity/device-keychain-id')).resolveDeviceKeychainId(id));
    const loadKeypair =
      deps?.loadKeypair ??
      (async (k: string) => (await import('../identity/attest')).loadOrGenerateDeviceKeypair(k));
    const ensureGist =
      deps?.ensureGist ??
      (async (i: Parameters<AttestationDeps['ensureGist']>[0]) =>
        (await import('../identity/attest')).ensureAttestationGist(i));
    const knownGistIdFor =
      deps?.knownGistIdFor ??
      (deps?.ensureGist ? async () => undefined : cachedGistIdFor);

    const identity = await resolveIdentity();
    // The identity union is `{kind:'ok', githubUserId, githubLogin, token}` |
    // `{kind:'gh_auth_required'}` — only the 'ok' variant carries the fields. A
    // positive `kind !== 'ok'` narrow (rather than the negative `=== 'gh_auth_required'`
    // disjunction) lets TS narrow before we read githubUserId/githubLogin/token.
    if (identity.kind !== 'ok') return null;
    const { githubUserId, githubLogin, token } = identity as {
      githubUserId?: number;
      githubLogin?: string;
      token?: string;
    };
    if (githubUserId == null || !githubLogin || !token) return null;
    const keychainId = await keychainIdFor(githubUserId);
    const keypair = await loadKeypair(keychainId);
    const knownGistId = await knownGistIdFor({
      keychainId,
      pubkeyBase64: keypair.pubkeyBase64,
      githubUserId,
    }).catch(() => undefined);
    const gistId = await ensureGist({
      keychainId,
      pubkeyBase64: keypair.pubkeyBase64,
      deviceLabel: 'unnamed-device',
      githubUserId,
      githubLogin,
      token,
      ...(knownGistId ? { knownGistId } : {}),
    });
    if (!gistId) return null;
    return { attestation_gist_id: gistId, publisher_device_pubkey: keypair.pubkeyBase64 };
  } catch {
    return null; // best-effort — publish proceeds without attestation
  }
}

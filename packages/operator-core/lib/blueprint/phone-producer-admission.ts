import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Principal } from '@papercusp/agent-mcp';
import { derivedTerminalCompletionAuthority } from '../completion-audit';
import { isTransportOnlyIdentity } from '../agent-tools/coordination/identity';
import { createWorkItem, getWorkItem, nextWorkItemId, type CreateWorkItemInput, type WorkItem } from '../work-items';
import type { ExternalRuntimeProducerBinding } from './operation-worker-binding';
import { appPrincipalRefOfSlug } from '../connected-apps/enforce';
import { evaluateAppScope, type AppScopeRow } from '../connected-apps/scope-policy';
import { loadAppScopeRow, loadAccessTokenScopeRow } from '../connected-apps/store';
import { resolveWorkItemPot } from '../pot-membership';
import { gateWorkScope } from '../work-scope-policy';
import { phoneRetainedOutcomeReader, type PhoneRetainedOutcomeHost } from './phone-retained-outcome';
import type { ExternalRuntimeCompletionAttempt } from './operation-worker-binding';

const text = z.string().min(1).refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value));
const admissionSchema = z.object({
  workspaceId: text, harnessSlug: text, storageHarnessSlug: text, executionOwnerId: text,
  ownerId: text, roomName: text, callKey: text, callId: text,
  runId: text, jobId: text, configFingerprint: text,
  sessionStartedAt: text.refine((value) => Number.isFinite(Date.parse(value))),
  workerAdmitted: z.boolean(), contentDeleted: z.boolean(), sessionEndedAt: text.nullable(),
});

/** All identity fields come from host records, not an MCP request body. */
export type PhoneProducerAdmission = z.infer<typeof admissionSchema>;
type PhoneProducerPrincipal = Pick<Principal, 'slug' | 'workspaceId'> &
  Partial<Pick<Principal, 'kind' | 'trust' | 'authMethod'>>;
export interface PhoneProducerAdmissionHost {
  readAdmission(roomName: string): Promise<PhoneProducerAdmission>;
  readRegistration(roomName: string): Promise<ExternalRuntimeProducerBinding | null>;
  /** First-write-wins transaction on phone_call_units. Re-read owner, call,
   * runtime, live worker admission, deletion and session-end under that lock;
   * refuse a changed snapshot. An existing exact registration may replay after
   * end/expiry. Return the winner, never replace it with the proposed binding. */
  reserveRegistration(snapshot: PhoneProducerAdmission, proposed: ExternalRuntimeProducerBinding): Promise<ExternalRuntimeProducerBinding>;
}

/** Host configuration, never public admission arguments. HTTPS authenticates
 * the configured sidecar authority; the secret authenticates this caller.
 * Redirects cannot move either credential or trusted record reads elsewhere. */
export function createHttpsPhoneProducerAdmissionHost(options: {
  endpoint: string;
  token: string;
  request?: typeof fetch;
}): PhoneProducerAdmissionHost & { retainedOutcomeHost: PhoneRetainedOutcomeHost } {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
    throw new Error('phone_producer_https_authority_required');
  }
  const token = options.token.trim();
  if (!token || /[\r\n]/.test(token)) throw new Error('phone_producer_bridge_credential_required');
  const request = options.request ?? fetch;
  const bindingSchema = z.object({
    kind: z.literal('external-runtime-producer'), workspaceId: text, harnessSlug: text,
    storageHarnessSlug: text, workItemId: text, executionOwnerId: text, ownerId: text,
    callKey: text, callId: text, runId: text, jobId: text,
    configurationSha256: z.string().regex(/^[a-f0-9]{64}$/), registeredAt: text,
  });
  async function invoke(action: string, args: Record<string, unknown>): Promise<unknown> {
    const response = await request(endpoint.href, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ action, ...args }),
    });
    if (!response.ok) throw new Error(`phone_producer_bridge_failed:${response.status}`);
    const envelope = z.object({ ok: z.literal(true), data: z.unknown() }).parse(await response.json());
    return envelope.data;
  }
  return {
    async readAdmission(roomName) {
      return admissionSchema.parse(await invoke('readAdmission', { roomName }));
    },
    async readRegistration(roomName) {
      return bindingSchema.nullable().parse(await invoke('readRegistration', { roomName }));
    },
    retainedOutcomeHost: {
      async readRegistration(ownerId, callKey) {
        return z.object({ binding: bindingSchema, roomName: text, contentDeleted: z.boolean() })
          .parse(await invoke('readRetainedRegistration', { ownerId, callKey }));
      },
      async readExport(ownerId, roomName) {
        return invoke('readExport', { ownerId, roomName });
      },
    },
    async reserveRegistration(snapshot, proposed) {
      return bindingSchema.parse(await invoke('reserveRegistration', { snapshot, proposed }));
    },
  };
}

/** Production entry from work_items:create. Configuration is injected by the
 * operator host, never selected by a tool caller. No credential fallback. */
export async function admitConfiguredPhoneProducer(principal: PhoneProducerPrincipal | null | undefined,
  roomName: string, requested: { harness?: string; workspace?: string },
  env: NodeJS.ProcessEnv = process.env) {
  if (principal?.kind !== 'service' || principal.trust !== 'verified' ||
      principal.authMethod !== 'bearer-token' || !principal.workspaceId || !principal.slug ||
      isTransportOnlyIdentity(principal.slug)) throw new Error('phone_producer_authenticated_service_required');
  if (requested.workspace && requested.workspace !== principal.workspaceId) {
    throw new Error('phone_producer_authenticated_scope_mismatch');
  }
  const endpoint = env.PHONE_PRODUCER_ADMISSION_ENDPOINT?.trim();
  const tokenFile = env.PHONE_PRODUCER_TOKEN_FILE?.trim();
  if (!endpoint || !tokenFile) throw new Error('phone_producer_bridge_not_configured');
  const host = createHttpsPhoneProducerAdmissionHost({ endpoint, token: await readFile(tokenFile, 'utf8') });
  return admitAuthenticatedPhoneProducer(principal, {
    ...host,
    readAdmission: async (room) => {
      const snapshot = await host.readAdmission(room);
      if (requested.harness && requested.harness !== snapshot.harnessSlug) {
        throw new Error('phone_producer_authenticated_scope_mismatch');
      }
      const scope = await gateWorkScope('work_items:create', { harness: snapshot.harnessSlug, actor: principal.slug });
      if (!scope.allowed) throw new Error('phone_producer_work_scope_refused');
      return snapshot;
    },
  }, roomName);
}

/** Completion uses the same host authority as admission. Neither the endpoint,
 * credential nor retained-record callback is accepted in public tool input. */
export async function configuredPhoneProducerCompletionAttempt(
  principal: PhoneProducerPrincipal | null | undefined,
  item: Pick<WorkItem, 'id' | 'harness' | 'assignee' | 'payload' | 'updatedAt'>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExternalRuntimeCompletionAttempt> {
  const payload = item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
    ? item.payload as Record<string, unknown> : {};
  const binding = payload.externalRuntimeProducer as ExternalRuntimeProducerBinding | undefined;
  if (principal?.kind !== 'service' || principal.trust !== 'verified' ||
      principal.authMethod !== 'bearer-token' || !principal.slug || !principal.workspaceId ||
      isTransportOnlyIdentity(principal.slug)) throw new Error('phone_producer_authenticated_service_required');
  if (!binding || binding.kind !== 'external-runtime-producer' ||
      binding.executionOwnerId !== principal.slug || binding.workspaceId !== principal.workspaceId ||
      binding.workItemId !== item.id || binding.storageHarnessSlug !== item.harness ||
      item.assignee !== principal.slug) throw new Error('phone_producer_authenticated_scope_mismatch');
  const endpoint = env.PHONE_PRODUCER_ADMISSION_ENDPOINT?.trim();
  const tokenFile = env.PHONE_PRODUCER_TOKEN_FILE?.trim();
  if (!endpoint || !tokenFile) throw new Error('phone_producer_bridge_not_configured');
  const host = createHttpsPhoneProducerAdmissionHost({ endpoint, token: await readFile(tokenFile, 'utf8') });
  return { binding: { ...binding }, updatedTs: Date.parse(item.updatedAt),
    readStoredOutcome: phoneRetainedOutcomeReader(host.retainedOutcomeHost, binding) };
}

type ProducerRow = Pick<WorkItem, 'id' | 'harness' | 'assignee' | 'payload'>;
export interface PhoneProducerCanonicalStore {
  allocateId(): Promise<string>;
  read(id: string, harness: string): Promise<ProducerRow | null>;
  create(input: CreateWorkItemInput): Promise<ProducerRow>;
}
const canonicalStore: PhoneProducerCanonicalStore = {
  allocateId: nextWorkItemId,
  read: (id, harness) => getWorkItem(id, harness),
  create: createWorkItem,
};

export interface PhoneProducerGrantStore {
  loadRow(id: string): Promise<AppScopeRow | null>;
  loadTokenRow(tokenId: string, appId: string): Promise<AppScopeRow | null>;
}
const grantStore: PhoneProducerGrantStore = {
  loadRow: loadAppScopeRow, loadTokenRow: loadAccessTokenScopeRow,
};

/** Connected-app credentials must authorize the canonical create, including
 * the host-resolved harness. Reuse the maintained parent/token scope policy;
 * a capability set alone cannot establish a current grant or token expiry. */
async function checkProducerGrant(slug: string, snapshot: PhoneProducerAdmission,
  grants: PhoneProducerGrantStore): Promise<void> {
  const ref = appPrincipalRefOfSlug(slug);
  if (!ref) return; // Other verified service credentials use their trusted host scope resolver.
  const parent = await grants.loadRow(ref.appId);
  const token = ref.tokenId ? await grants.loadTokenRow(ref.tokenId, ref.appId) : null;
  if (!parent || (ref.tokenId && !token)) throw new Error('phone_producer_grant_unavailable');
  for (const row of token ? [parent, token] : [parent]) {
    const verdict = evaluateAppScope({
      tool: { name: 'work_items:create', capabilities: ['work_items:write'], acceptsHarness: true },
      args: { harness: snapshot.harnessSlug }, workspaceId: snapshot.workspaceId,
    }, row);
    if (!verdict.allow) throw new Error(`phone_producer_grant_${verdict.code}`);
  }
}

/** Authenticated dispatch boundary. The principal must be the transport's
 * verified credential, and the host must already resolve the permitted harness
 * from that credential's grant. Neither is a public tool argument. A reported
 * speaker/UI client id cannot replace the service execution principal. */
export async function admitAuthenticatedPhoneProducer(principal: PhoneProducerPrincipal | null | undefined,
  host: PhoneProducerAdmissionHost, roomName: string,
  store: PhoneProducerCanonicalStore = canonicalStore,
  grants: PhoneProducerGrantStore = grantStore,
  resolveStorage: typeof resolveWorkItemPot = resolveWorkItemPot): Promise<Readonly<ExternalRuntimeProducerBinding>> {
  if (principal?.kind !== 'service' || principal.trust !== 'verified' ||
      principal.authMethod !== 'bearer-token' || !principal.workspaceId || !principal.slug ||
      isTransportOnlyIdentity(principal.slug)) throw new Error('phone_producer_authenticated_service_required');
  // Capture the credential identity before I/O; a mutable dispatch context must
  // not change who receives the canonical producer while a read is in flight.
  const workspaceId = principal.workspaceId;
  const executionOwnerId = principal.slug;
  const checkStorage = async (snapshot: PhoneProducerAdmission) => {
    const storageHarness = await resolveStorage({ rawSlug: snapshot.harnessSlug, workspaceId });
    if (!storageHarness || storageHarness !== snapshot.storageHarnessSlug) {
      throw new Error('phone_producer_storage_scope_mismatch');
    }
  };
  const readAdmission = async (room: string) => {
    const snapshot = await host.readAdmission(room);
    if (snapshot.workspaceId !== workspaceId || snapshot.executionOwnerId !== executionOwnerId) {
      throw new Error('phone_producer_authenticated_scope_mismatch');
    }
    await checkProducerGrant(executionOwnerId, snapshot, grants);
    // The TLS-authenticated sidecar identifies the call, but cannot select the
    // canonical ledger partition. Use the same maintained resolver as create.
    await checkStorage(snapshot);
    return snapshot;
  };
  return admitPhoneProducer({
    readAdmission,
    readRegistration: (room) => host.readRegistration(room),
    reserveRegistration: async (snapshot, proposed) => {
      await checkProducerGrant(executionOwnerId, snapshot, grants);
      await checkStorage(snapshot);
      return host.reserveRegistration(snapshot, proposed);
    },
  }, roomName, {
    ...store,
    create: async (input) => {
      // Allocation/reservation can await storage. Re-read the grant immediately
      // before creating the ledger row instead of trusting the earlier check.
      await readAdmission(roomName);
      return store.create(input);
    },
  });
}

function expectedBinding(snapshot: PhoneProducerAdmission, id: string): ExternalRuntimeProducerBinding {
  return { kind: 'external-runtime-producer', workspaceId: snapshot.workspaceId,
    harnessSlug: snapshot.harnessSlug, storageHarnessSlug: snapshot.storageHarnessSlug,
    workItemId: id, executionOwnerId: snapshot.executionOwnerId, ownerId: snapshot.ownerId,
    callKey: snapshot.callKey, callId: snapshot.callId, runId: snapshot.runId, jobId: snapshot.jobId,
    configurationSha256: createHash('sha256').update(snapshot.configFingerprint, 'utf8').digest('hex'),
    registeredAt: snapshot.sessionStartedAt };
}

/** Internal authenticated host adapter; do not expose host/store callbacks as
 * public arguments. Reservation precedes canonical create so a crash between
 * the two writes recovers the same ID. No accepted-operation/program identity
 * is minted for an external voice process. Terminal settlement is separate. */
export async function admitPhoneProducer(host: PhoneProducerAdmissionHost, roomName: string,
  store: PhoneProducerCanonicalStore = canonicalStore): Promise<Readonly<ExternalRuntimeProducerBinding>> {
  const snapshot = Object.freeze(admissionSchema.parse(await host.readAdmission(roomName)));
  if (snapshot.roomName !== roomName || snapshot.contentDeleted) throw new Error('phone_producer_call_unavailable');
  if (isTransportOnlyIdentity(snapshot.executionOwnerId) ||
      derivedTerminalCompletionAuthority({ isTerminal: true, by: snapshot.executionOwnerId }) === null) {
    throw new Error('phone_producer_attributed_executor_required');
  }
  let registered = await host.readRegistration(roomName);
  if (!registered) {
    if (!snapshot.workerAdmitted || snapshot.sessionEndedAt !== null) throw new Error('phone_producer_not_admitted');
    const proposed = Object.freeze(expectedBinding(snapshot, await store.allocateId()));
    registered = await host.reserveRegistration(snapshot, proposed);
  }
  // Concurrent reservation may have won with another ID; every other field
  // must still be the independently read admitted call/runtime identity.
  if (!registered.workItemId || !isDeepStrictEqual(registered, expectedBinding(snapshot, registered.workItemId))) {
    throw new Error('phone_producer_registration_conflict');
  }
  const binding = Object.freeze({ ...registered });
  let row = await store.read(binding.workItemId, binding.storageHarnessSlug);
  if (!row) {
    try {
      await store.create({ id: binding.workItemId, kind: 'task',
        title: `Phone voice session ${binding.callId}`, summary: `Admitted voice runtime ${binding.runId}/${binding.jobId}`,
        workspaceId: binding.workspaceId, harness: binding.harnessSlug,
        createdBy: binding.executionOwnerId, assignee: binding.executionOwnerId,
        payload: { externalRuntimeProducer: binding } });
    } catch (error) {
      // A duplicate or lost response is recoverable only from the canonical
      // row. Never retry with a fresh ID or swallow an absent-row failure.
      row = await store.read(binding.workItemId, binding.storageHarnessSlug);
      if (!row) throw error;
    }
    row ??= await store.read(binding.workItemId, binding.storageHarnessSlug);
  }
  const payload = row?.payload as { externalRuntimeProducer?: unknown } | undefined;
  if (!row || row.id !== binding.workItemId || row.harness !== binding.storageHarnessSlug ||
      row.assignee !== binding.executionOwnerId || !isDeepStrictEqual(payload?.externalRuntimeProducer, binding)) {
    throw new Error('phone_producer_canonical_binding_conflict');
  }
  const after = admissionSchema.parse(await host.readAdmission(roomName));
  const afterRegistration = await host.readRegistration(roomName);
  if (after.contentDeleted || after.roomName !== roomName ||
      !isDeepStrictEqual(expectedBinding(after, binding.workItemId), binding) ||
      !isDeepStrictEqual(afterRegistration, binding)) throw new Error('phone_producer_registration_changed');
  return binding;
}

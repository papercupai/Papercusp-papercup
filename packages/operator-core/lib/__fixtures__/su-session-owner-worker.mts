/**
 * Worker-process fixture for su-session-owner-routing.integration.test.ts
 * (WI-10003879). One forked process = one operator cluster worker.
 *
 * Runs the PRODUCTION owner-rpc worker side on this process's real IPC channel
 * and the PRODUCTION su-session-owner-routing module. The only substitutions are
 * the database reads/writes (owner record, durable row, owner-turn receipts and
 * client leases), injected through each module's test seam so no Postgres is
 * needed. The engine is a real SuSessionHost with an executor that exists only
 * in the process that opened it — exactly the state a PUI launch leaves on the
 * worker that served it.
 */
import {
  SU_SESSION_PROTOCOL_VERSION,
  SU_SESSION_SCHEMA,
  type SuSessionCapabilities,
  type SuSessionDescriptor,
} from '@papercusp/chat-protocol';
import { startWorkerOwnerRpc } from '../cluster-owner-rpc.ts';
import { SuSessionHost, registerSuSessionHost } from '../su-session-host.ts';
import { _resetSuClientLeaseForTest } from '../su-session-client-lease.ts';
import type { SuSessionCommandStore } from '../su-session-commands.ts';
import type { SuSessionHostOwner } from '../su-session-persistence.ts';
import { createHash } from 'node:crypto';
import type { ProjectedTool, UnifiedToolContext } from '@papercusp/tooldef';
import { dispatchProjectedToolToMcp } from '@papercusp/tooldef-mcp';
import { NativeInstalledPerUseTurns, createInstalledPerUseChokepoint, type AdmittedPerUseToolTurn } from '../agent-tools/per-use-chokepoint.ts';
import { canonicalJson } from '../authority/authority-rpc-envelope.ts';
import { declareMeter, LocalMeteredTurn } from '../p2p/metered-invocation.ts';
import { createMicrochargeChannel } from '../p2p/microcharge.ts';
import { signPaymentTestBytes } from '../p2p/_payment-voucher-fixture.ts';
import type { InstalledPluginProvenance } from '../cupboard/types.ts';
import {
  _configureSuSessionRoutingForTest,
  createForwardedSuSessionEventResponse,
  localSuSessionHostOwner,
  resolveSuSessionRoute,
  runRoutedSuSessionOp,
  registerSuNativeToolDispatcher,
  runOnSuNativeToolOwner,
} from '../su-session-owner-routing.ts';

const supported = { state: 'supported', implementation: 'native' } as const;
const capabilities: SuSessionCapabilities = {
  commands: {
    owner_turn: supported,
    interrupt: supported,
    resume: supported,
    fork: { state: 'unsupported', reason: 'fixture has no fork' },
    focus: { state: 'supported', implementation: 'host' },
    end: supported,
  },
  features: {
    'tool-events': supported, 'interactive-cards': supported, 'reasoning-stream': supported, usage: supported,
    compaction: supported, approvals: supported, context: supported, modes: supported,
  },
};

export const ADDRESS = { workspaceId: 'fixture-workspace', harnessSlug: 'fixture', agentChatId: 'chat-owner-routing' };

function descriptor(): SuSessionDescriptor<'claude'> {
  return {
    identity: {
      agentChatId: ADDRESS.agentChatId, advSessionId: 77, backend: 'claude', nativeSessionId: 'native-77',
      ownerId: 'su-fixture', workspaceId: ADDRESS.workspaceId, harnessSlug: ADDRESS.harnessSlug,
    },
    lifecycle: 'starting', runtimeGeneration: 1, role: 'su', model: 'claude-fixture', accountServed: null,
    accountRoute: 'default', carry: 'warm', modes: [], capabilities,
    backendExtension: { backend: 'claude', configDir: '/tmp/fixture-claude', configDirSource: 'live-process' },
  };
}

// What this worker's database read "would" return for the owner record.
let ownerRecord: SuSessionHostOwner | null = null;
const receipts = new Map<string, { fingerprint: string; outcome?: unknown }>();
const commandStore: SuSessionCommandStore = {
  async reserve(command, fingerprint) {
    const existing = receipts.get(command.commandId);
    if (existing) return { created: false, receipt: existing as never };
    const receipt = { fingerprint };
    receipts.set(command.commandId, receipt);
    return { created: true, receipt: receipt as never };
  },
  async finish(command, _fingerprint, outcome) {
    const r = receipts.get(command.commandId);
    if (r) r.outcome = outcome;
  },
};
_configureSuSessionRoutingForTest({
  readOwner: async () => ownerRecord,
  readDurable: async () => null,
  commandStore,
});
_resetSuClientLeaseForTest({ grant: async () => undefined, renew: async () => undefined, detach: async () => true, expired: async () => [] });

let host: SuSessionHost<'claude'> | null = null;
const executed: string[] = [];

// D-063 reuses this real worker/IPC fixture. Only the host's authenticated
// funding/provenance inputs and persistence are fixture-owned. Observation
// lookup, dispatch, reservations, vouchers and failed-unit retention are real.
const fp = (value: string) => createHash('sha256').update(value).digest('hex');
const nativeAddress = { workspaceId: ADDRESS.workspaceId, advSessionId: 78,
  ownerId: 'su-native-fixture', nativeSessionIdFingerprint: fp('native-paid-78') };
const nativeRegistry = new NativeInstalledPerUseTurns();
const nativeProvenance: InstalledPluginProvenance = {
  schema: 'papercusp.plugin-installation/v1', name: 'owner-paid', version: '1.0.0',
  contentFingerprint: 'b'.repeat(64), hadListing: true, contentSource: 'r2',
  listing: { listingId: 'listing-native-paid', githubUrl: 'https://github.com/seller/tool', ref: '.',
    publisherId: 'gh:4242', skuRef: 'native-paid-sku', releaseVersion: '1.0.0',
    priceModel: 'per-use', releaseContentHash: 'c'.repeat(64) },
};
const nativeTerms = { unitPriceMicros: 250, meterUnit: 'tool-call', priceVersion: 'v1',
  splitManifestHash: `sha256:${'a'.repeat(64)}` };
let nativeMeter: LocalMeteredTurn | null = null;
let nativeHooks: ReturnType<NativeInstalledPerUseTurns['register']> | null = null;
let nativeLocalCalls = 0;
let nativeInvocations = 0;
let nativeReceiptFailure = false;
const nativeAroundInvoke = createInstalledPerUseChokepoint({ readProvenance: async () => nativeProvenance,
  resolveAdmittedTurn: request => nativeRegistry.resolve(request) });

async function dispatchNative(body: unknown) {
  const request = body as { callId: string; fail?: boolean; indirect?: boolean; settlementFail?: boolean };
  nativeReceiptFailure = request.settlementFail === true;
  const ctx = { log: () => {}, signal: new AbortController().signal, progress: () => {}, emit: () => {},
    workspaceId: nativeAddress.workspaceId, role: 'worker', advSessionId: nativeAddress.advSessionId,
    uiClientId: nativeAddress.ownerId, indirectDispatch: request.indirect === true,
    principal: { slug: 'native-agent', workspaceId: nativeAddress.workspaceId, trust: 'verified', capabilities: new Set() },
    requestOrigin: { transport: 'mcp', nativeSession: { carrier: 'meta:threadId', binding: 'bound',
      candidateAdvSessionId: nativeAddress.advSessionId, valueFingerprint: nativeAddress.nativeSessionIdFingerprint,
      callIdFingerprint: fp(request.callId) } },
  } as UnifiedToolContext;
  const target = { name: 'run', description: 'native paid fixture', capabilities: [], inputSchema: { type: 'object' },
    pluginName: nativeProvenance.name,
    pluginInstallation: { version: '1.0.0', path: '/fixture/owner-paid', source: 'project' },
    expose: { mcp: { name: 'owner-paid:run' } },
    fn: async () => {
      nativeInvocations++;
      if (request.fail) throw new Error('native fixture handler failed after reservation');
      return { content: [{ type: 'text', text: `paid-owner:${process.pid}` }] };
    },
  } as ProjectedTool;
  try {
    return await dispatchProjectedToolToMcp(target, 'owner-paid:run', {}, ctx, { aroundInvoke: nativeAroundInvoke });
  } catch (error) {
    // Keep the originating error in the runner's durable log: the receiver
    // correctly exposes only outcome uncertainty after a remote exception.
    console.error('[native-paid-fixture] dispatch failed', error);
    throw error;
  }
}

registerSuNativeToolDispatcher(dispatchNative);

startWorkerOwnerRpc();

async function handle(message: any): Promise<unknown> {
  switch (message.op) {
    case 'open-native-engine': {
      const base = descriptor();
      const nativeDescriptor: SuSessionDescriptor<'codex'> = { ...base,
        identity: { ...base.identity, agentChatId: 'native-paid-chat', advSessionId: 78, backend: 'codex',
          nativeSessionId: 'native-paid-78', ownerId: nativeAddress.ownerId },
        lifecycle: 'ready', model: 'codex-fixture', backendExtension: { backend: 'codex', codexHome: null } };
      registerSuSessionHost(new SuSessionHost({ descriptor: nativeDescriptor,
        executeCommand: async () => ({ status: 'completed' }) }));
      const declared = declareMeter(nativeTerms);
      if (!declared.ok) throw new Error(declared.detail);
      nativeMeter = new LocalMeteredTurn({ state: { turnId: 'native-funded-turn', payer: 'authenticated-buyer',
        seller: 'gh:4242', releaseRef: 'native-paid-sku', meter: declared.meter, ceilingMicros: 1_000n,
        expiresAtMs: 10_000, reservedMicros: 0n, channel: createMicrochargeChannel('native-channel', 2_000n), units: {} },
        nowMs: () => 1_000, signVoucher: signPaymentTestBytes,
        signReceipt: () => {
          if (nativeReceiptFailure) throw new Error('fixture receipt signing unavailable');
          return 'seller-signature';
        },
        persist: async () => {} });
      const admission: AdmittedPerUseToolTurn = { kind: 'per-use', workspaceId: ADDRESS.workspaceId,
        principalId: 'native-agent', payer: 'authenticated-buyer', provenance: nativeProvenance, entitled: true,
        offer: { offerId: 'native-offer', productId: 'native-product', skuRef: 'native-paid-sku', creatorId: 'gh:4242',
          active: true, productActive: true, terms: nativeTerms }, turn: nativeMeter };
      nativeHooks = nativeRegistry.register({ workspaceId: ADDRESS.workspaceId, ownerId: nativeAddress.ownerId,
        principalId: 'native-agent', nativeSessionId: 'native-paid-78', ownerTurnId: 'native-owner-turn', advSessionId: 78,
        mcpServer: 'papercusp-su', nativeTools: { paid_run: 'owner-paid:run', tools_invoke: 'tools:invoke' },
        admissions: [{ ok: true, admission, turnId: 'native-funded-turn', binding: { kind: 'tool',
          workspaceId: ADDRESS.workspaceId, ownerId: nativeAddress.ownerId, principalId: 'native-agent',
          executionId: 'native-paid-78', admissionId: 'native-owner-turn', provenanceHash: fp(canonicalJson(nativeProvenance)),
          payer: admission.payer, seller: 'gh:4242', channelId: 'native-channel', offer: admission.offer,
          quantityCeiling: 4n, expiresAtMs: 10_000 } }] });
      await nativeHooks.bindNativeTurn('native-turn');
      return { owner: localSuSessionHostOwner() };
    }
    case 'native-observe':
      await nativeHooks!.observeToolCall!({ nativeTurnId: 'native-turn', callId: message.callId,
        server: 'papercusp-su', tool: message.indirect ? 'tools_invoke' : 'paid_run' });
      return { ok: true };
    case 'native-route':
      return runOnSuNativeToolOwner(nativeAddress, message.request, async () => {
        nativeLocalCalls++;
        return dispatchNative(message.request);
      }, message.timeoutMs);
    case 'native-stop':
      await nativeHooks!.withdraw();
      return { ok: true };
    case 'native-meter': {
      const state = nativeMeter?.snapshot();
      const units = Object.fromEntries(Object.entries(state?.units ?? {}).map(([nonce, unit]) =>
        [nonce, { quantity: String(unit.voucher.meterQuantity), completedAtMs: unit.completedAtMs,
          hasReceipt: unit.receipt !== null }]));
      return { nativeLocalCalls, nativeInvocations, units,
        outstandingMicros: String(Object.values(state?.channel.reservations ?? {}).reduce((sum, value) => sum + value, 0n)),
        reservedMicros: String(state?.reservedMicros ?? 0n), channelCommittedMicros: String(state?.channel.committedMicros ?? 0n),
        admissionClosed: state?.admissionClosed ?? false };
    }
    case 'open-engine': {
      // What a launch does on the worker that served it: attach an engine and
      // record itself as the owner.
      host = new SuSessionHost<'claude'>({
        descriptor: descriptor(),
        runtimeReady: () => true,
        executeCommand: async (command, ctx) => {
          executed.push(`${command.type}:${process.pid}`);
          ctx.emit({ type: 'assistant_text', text: `owner ${process.pid} handled ${command.type}` } as never);
          return { status: 'completed' };
        },
      });
      registerSuSessionHost(host);
      host.transition('ready', 'fixture engine ready');
      return { owner: localSuSessionHostOwner() };
    }
    case 'set-owner-record':
      ownerRecord = message.owner;
      return { ok: true };
    case 'route': {
      const outcome = await runRoutedSuSessionOp(ADDRESS, message.request);
      if (outcome instanceof Response) return { status: outcome.status, body: await outcome.json(), servedBy: null };
      return { status: outcome.result.status, body: outcome.result.body, servedBy: outcome.servedBy };
    }
    case 'route-kind':
      return { kind: (await resolveSuSessionRoute(ADDRESS)).kind };
    case 'emit': {
      host!.emit({ type: 'assistant_text', text: message.text } as never);
      return { ok: true };
    }
    case 'executed':
      return { executed };
    case 'stream': {
      // Open the forwarded SSE stream and read until `untilText` shows up.
      const route = await resolveSuSessionRoute(ADDRESS);
      if (route.kind !== 'remote') return { error: `route was ${route.kind}` };
      const controller = new AbortController();
      const response = await createForwardedSuSessionEventResponse(
        new Request('http://fixture/events', { signal: controller.signal }), ADDRESS, route.owner,
      );
      if (!response) return { error: 'owner fell back' };
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const deadline = Date.now() + (message.timeoutMs ?? 20_000);
      while (!text.includes(message.untilText) && Date.now() < deadline) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<null>((r) => setTimeout(() => r(null), 500)),
        ]);
        if (chunk && !chunk.done) text += decoder.decode(chunk.value, { stream: true });
        if (chunk && chunk.done) break;
        // Ask the test to publish on the owner once the stream is open.
        if (message.signalOpen && !text.includes('__opened__')) {
          text += '__opened__';
          process.send!({ type: 'fixture:stream-open', seq: message.seq });
        }
      }
      controller.abort();
      return { text, servedBy: response.headers.get('X-Papercusp-Su-Session-Served-By') };
    }
    default:
      return { error: `unknown op ${message.op}` };
  }
}

process.on('message', async (message: any) => {
  if (message?.type !== 'fixture:op') return;
  try {
    process.send!({ type: 'fixture:result', seq: message.seq, out: await handle(message) });
  } catch (error) {
    process.send!({ type: 'fixture:result', seq: message.seq, out: { error: String(error) } });
  }
});

process.on('disconnect', () => process.exit(0));

process.send!({ type: 'fixture:ready', pid: process.pid });

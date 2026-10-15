import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import * as discovery from './events/await/psu-pty-discovery';
import { describe, expect, it, vi } from 'vitest';
import {
  gradeColdBootDrill,
  reportColdBootDrills,
  scanCarryDrillDrops,
  startColdBootDrill,
  terminalOutcomesFromLedger,
  verifyColdBootDrill,
  type ColdBootDrillHostEvent,
  type ColdBootDrillLedgerEvent,
  type StartColdBootDrillDeps,
} from './cold-boot-drill-live';
import type { RespawnLaunchSpec } from './carry-respawn';
import type { ReplayTranscript, ReplayTurn } from './replay/types';
import { parseTranscriptJsonl } from './replay/transcript';

const NOW = Date.parse('2026-07-15T06:00:00.000Z');
const HOST = {
  ownerId: 'su-1',
  advSessionId: 'adv-1',
  pid: 10,
  ptyPid: 11,
  sock: '/tmp/su-1.sock',
  command: 'claude',
  startedAt: NOW,
  caps: ['carry-respawn'],
};
const SPEC: RespawnLaunchSpec = {
  systemPromptAddendum: '## Identity\nownerId: su-1\n## Plan state (your claimed / in-flight items)\nWI-4852',
  firstPrompt: null,
  budgetChars: 80_000,
  openOwnerQuestion: { crossesOpenOwnerMessage: false },
};

function startHarness(seed: ColdBootDrillLedgerEvent[] = []) {
  const ledger = [...seed];
  const injected: Array<{ sock: string; msg: Record<string, unknown> }> = [];
  const built: Array<{
    ownerId: string;
    input: Parameters<StartColdBootDrillDeps['buildSpec']>[1];
  }> = [];
  return {
    ledger,
    injected,
    built,
    deps: {
      now: () => NOW,
      newId: () => 'drill-1',
      findHost: async () => HOST,
      resolveTranscript: async () => ({
        sourceKind: 'claude' as const,
        sessionId: 'current-native-id',
        filePath: '/tmp/current.jsonl',
      }),
      resolveEffectiveWindow: async () => 200_000,
      buildBrief: async () => null,
      flushGate: async () => ({ verdict: 'clear' as const, tripwires: [] }),
      buildSpec: async (ownerId: string, input: Parameters<StartColdBootDrillDeps['buildSpec']>[1]) => {
        built.push({ ownerId, input });
        return SPEC;
      },
      inject: async (sock: string, msg: Record<string, unknown>) => {
        injected.push({ sock, msg });
        return true;
      },
      tagTurn: async ({ sid, origin, text }: { sid: string; origin: string; text: string }) => ({
        taggedText: `⟦turn-origin:${origin} nonce:0123456789abcdef⟧\n${text}`,
        envelope: `⟦turn-origin:${origin} nonce:0123456789abcdef⟧`,
        nonce: '0123456789abcdef',
        origin: 'watchdog',
        ledgerWritten: true,
      }),
      readLedger: async () => ledger,
      appendLedger: async (event: ColdBootDrillLedgerEvent) => {
        ledger.push(event);
        return true;
      },
    },
  };
}

describe('startColdBootDrill — explicit/default-off live cut', () => {
  it('queues the existing carry-respawn verb with a durable id and grading marker', async () => {
    const h = startHarness();
    const result = await startColdBootDrill(
      { ownerId: 'su-1', ownerLabel: 'su · 1', workspaceId: 'ws', sessionClass: 'claude-su' },
      h.deps,
    );
    expect(result).toMatchObject({ ok: true, drillId: 'drill-1', sessionClass: 'claude-su', queued: true });
    expect(h.ledger.map((event) => event.kind)).toEqual(['carry-drill-requested', 'carry-drill-queued']);
    expect(h.injected).toHaveLength(1);
    expect(h.injected[0]).toMatchObject({
      sock: HOST.sock,
      msg: {
        mode: 'carry-respawn',
        ownerId: 'su-1',
        drillId: 'drill-1',
        sessionClass: 'claude-su',
        systemPromptAddendum: SPEC.systemPromptAddendum,
      },
    });
    expect(String(h.injected[0].msg.data)).toContain('⟦carry-drill:drill-1⟧');
    expect(String(h.injected[0].msg.data)).toMatch(/^⟦turn-origin:watchdog nonce:[a-f0-9]{16}⟧\n/);
    expect(String(h.injected[0].msg.data)).toContain('⟦post-compaction-recovery⟧');
    expect(String(h.injected[0].msg.data)).toContain('do not call coord:orient');
    expect(String(h.injected[0].msg.data)).toContain('coord:declare-intent { intent, current_plan_slug, items }');
    expect(String(h.injected[0].msg.data)).toContain('exactly once only when the marker is absent');
    expect(String(h.injected[0].msg.data)).not.toContain('First run coord:orient');
    expect(String(h.injected[0].msg.data)).toContain('session:carry-drill { op: "grade"');
  });

  it('EI-153: the carry-respawn payload NAMES its addressee — an unaddressed one re-execs whatever host receives it', async () => {
    // The receiving host's misdelivery guard is `msg.ownerId != null && msg.ownerId !== ownerId`,
    // so a payload with NO ownerId makes it ABSTAIN and accept unconditionally. That is
    // maximally severe for this mode specifically: carry-respawn RE-EXECS the CLI on the
    // carried document, so an unaddressed one replaces a stranger's session with this
    // drill. The autorunner drives this over listLiveHosts() with the flag default ON,
    // so every live host is reachable. `toMatchObject` above cannot catch a MISSING field
    // — this asserts presence and correctness directly, which is what regressed unnoticed.
    const h = startHarness();
    await startColdBootDrill(
      { ownerId: 'su-1', ownerLabel: 'su · 1', workspaceId: 'ws', sessionClass: 'claude-su' },
      h.deps,
    );
    expect(h.injected).toHaveLength(1);
    expect(Object.keys(h.injected[0].msg)).toContain('ownerId');
    expect(h.injected[0].msg.ownerId).toBe('su-1');
  });

  it('waits for asynchronous host discovery before deciding whether the host is live', async () => {
    const h = startHarness();
    let resolveHost!: (host: typeof HOST) => void;
    const pendingHost = new Promise<typeof HOST>((resolve) => { resolveHost = resolve; });
    const result = startColdBootDrill(
      { ownerId: 'su-1', ownerLabel: 'su · 1' },
      { ...h.deps, findHost: () => pendingHost },
    );

    resolveHost(HOST);
    await expect(result).resolves.toMatchObject({ ok: true, queued: true });
  });

  it('P-021: an OMITTED sessionClass defaults from the CANONICAL classifier (sessionClassForHost) — the drill ledger and live actuation share one vocabulary', async () => {
    // Headless host → 'claude-headless'.
    const h = startHarness();
    const headless = await startColdBootDrill(
      { ownerId: 'su-1', ownerLabel: 'su · 1' },
      { ...h.deps, findHost: async () => ({ ...HOST, bridgeTty: false }) },
    );
    expect(headless).toMatchObject({ ok: true, sessionClass: 'claude-headless' });
    expect(h.ledger[0]).toMatchObject({ kind: 'carry-drill-requested', sessionClass: 'claude-headless' });

    // Interactive / legacy host (no bridgeTty field) → 'claude-interactive'.
    const h2 = startHarness();
    const legacy = await startColdBootDrill({ ownerId: 'su-1', ownerLabel: 'su · 1' }, h2.deps);
    expect(legacy).toMatchObject({ ok: true, sessionClass: 'claude-interactive' });

    // An explicit caller class still WINS (scoped campaigns).
    const h3 = startHarness();
    const explicit = await startColdBootDrill(
      { ownerId: 'su-1', ownerLabel: 'su · 1', sessionClass: 'gateway-claude-headless' },
      { ...h3.deps, findHost: async () => ({ ...HOST, bridgeTty: false }) },
    );
    expect(explicit).toMatchObject({ ok: true, sessionClass: 'gateway-claude-headless' });
  });

  it('resolves a managed Codex transcript, preserves its source kind in the carry, and isolates its drill class from Claude evidence', async () => {
    const h = startHarness();
    const result = await startColdBootDrill(
      { ownerId: 'su-1', ownerLabel: 'su · 1' },
      {
        ...h.deps,
        findHost: async () => ({ ...HOST, command: 'codex' }),
        resolveTranscript: async () => ({
          sourceKind: 'codex',
          sessionId: 'codex-native-id',
          filePath: '/tmp/codex-rollout.jsonl',
        }),
      },
    );

    expect(result).toMatchObject({ ok: true, sessionClass: 'codex-interactive' });
    expect(h.ledger[0]).toMatchObject({
      kind: 'carry-drill-requested',
      sessionClass: 'codex-interactive',
    });
    expect(h.built).toHaveLength(1);
    expect(h.built[0]).toMatchObject({
      ownerId: 'su-1',
      input: {
        buildOpts: {
          transcriptPath: '/tmp/codex-rollout.jsonl',
          transcriptSourceKind: 'codex',
        },
      },
    });
  });

  it('fails closed before the flush/build/inject path when the managed transcript cannot be resolved', async () => {
    const h = startHarness();
    const result = await startColdBootDrill(
      { ownerId: 'su-1', ownerLabel: 'su · 1' },
      { ...h.deps, resolveTranscript: async () => null },
    );

    expect(result).toEqual({
      ok: false,
      error: 'transcript_unavailable',
      note: 'The current managed session transcript could not be resolved; no process was cut.',
    });
    expect(h.built).toEqual([]);
    expect(h.injected).toEqual([]);
    expect(h.ledger).toEqual([]);
  });

  it('rate-limits a second destructive cut from the persisted ledger', async () => {
    const h = startHarness([
      { ts: new Date(NOW - 5 * 60_000).toISOString(), kind: 'carry-drill-queued', drillId: 'prior', ownerId: 'su-1', sessionClass: 'claude-su' },
    ]);
    const result = await startColdBootDrill({ ownerId: 'su-1', ownerLabel: 'su · 1' }, h.deps);
    expect(result).toMatchObject({ ok: false, error: 'drill_rate_limited' });
    expect(h.injected).toHaveLength(0);
  });

  it('honors the flush gate and open-owner gate before registering or cutting', async () => {
    const flush = startHarness();
    const flushResult = await startColdBootDrill(
      { ownerId: 'su-1', ownerLabel: 'su · 1' },
      {
        ...flush.deps,
        flushGate: async () => ({ verdict: 'refuse' as const, tripwires: [{ kind: 'missing-checkpoint' as const, subject: 'WI-1', detail: 'flush it' }], refusalText: 'flush it' }),
      },
    );
    expect(flushResult).toMatchObject({ ok: false, error: 'flush_required' });
    expect(flush.ledger).toEqual([]);

    const owner = startHarness();
    const ownerResult = await startColdBootDrill(
      { ownerId: 'su-1', ownerLabel: 'su · 1' },
      { ...owner.deps, buildSpec: async () => ({ ...SPEC, openOwnerQuestion: { crossesOpenOwnerMessage: true } }) },
    );
    expect(ownerResult).toMatchObject({ ok: false, error: 'open_owner_message' });
    expect(owner.ledger).toEqual([]);
  });

  it('requires an explicit retry acknowledgement only for uncertain history', async () => {
    const uncertainSpec: RespawnLaunchSpec = {
      ...SPEC,
      openOwnerQuestion: {
        crossesOpenOwnerMessage: true,
        basis: 'history-uncertain',
        historyStatus: 'truncated',
      },
    };
    const first = startHarness();
    const refused = await startColdBootDrill(
      { ownerId: 'su-1', ownerLabel: 'su · 1' },
      { ...first.deps, buildSpec: async () => uncertainSpec },
    );
    expect(refused).toMatchObject({
      ok: false,
      error: 'owner_history_uncertain',
      historyStatus: 'truncated',
    });
    expect(first.ledger).toEqual([]);
    expect(first.injected).toEqual([]);

    const acknowledged = startHarness();
    const queued = await startColdBootDrill(
      {
        ownerId: 'su-1',
        ownerLabel: 'su · 1',
        acknowledgeOwnerHistoryUncertainty: true,
        note: 'live Codex acceptance',
      },
      { ...acknowledged.deps, buildSpec: async () => uncertainSpec },
    );
    expect(queued).toMatchObject({
      ok: true,
      queued: true,
      ownerHistoryUncertaintyAcknowledged: true,
    });
    expect(acknowledged.ledger[0]).toMatchObject({
      kind: 'carry-drill-requested',
      detail: 'live Codex acceptance',
    });
    expect(acknowledged.injected).toHaveLength(1);

    const knownOpen = startHarness();
    const stillRefused = await startColdBootDrill(
      {
        ownerId: 'su-1',
        ownerLabel: 'su · 1',
        acknowledgeOwnerHistoryUncertainty: true,
      },
      {
        ...knownOpen.deps,
        buildSpec: async () => ({
          ...SPEC,
          openOwnerQuestion: {
            crossesOpenOwnerMessage: true,
            basis: 'known-unanswered',
          },
        }),
      },
    );
    expect(stillRefused).toMatchObject({ ok: false, error: 'open_owner_message' });
    expect(knownOpen.ledger).toEqual([]);
    expect(knownOpen.injected).toEqual([]);
  });

  it('records a socket failure and leaves it out of the active rate-limit set', async () => {
    const h = startHarness();
    const result = await startColdBootDrill(
      { ownerId: 'su-1', ownerLabel: 'su · 1' },
      { ...h.deps, inject: async () => false },
    );
    expect(result).toMatchObject({ ok: false, error: 'carry_respawn_inject_failed' });
    expect(h.ledger.map((event) => event.kind)).toEqual(['carry-drill-requested', 'carry-drill-request-failed']);
  });
});

describe('gradeColdBootDrill — host event + successor transcript', () => {
  const requested: ColdBootDrillLedgerEvent = {
    ts: new Date(NOW).toISOString(),
    kind: 'carry-drill-requested',
    drillId: 'drill-1',
    ownerId: 'su-1',
    sessionClass: 'claude-su',
  };
  const tool = (index: number, toolName: string, input: unknown): ReplayTurn => ({
    index,
    role: 'tool_use',
    toolName,
    text: JSON.stringify(input),
  });
  const transcript: ReplayTranscript = {
    ref: '/tmp/fresh.jsonl',
    backend: 'claude-code',
    turns: [
      { index: 0, role: 'user', text: '⟦carry-drill:drill-1⟧\ncontinue' },
      tool(1, 'coord:orient', { afterCompaction: true }),
      { index: 2, role: 'tool_result', text: '{"recall":[{"text":"facts","similarity":0.03}]}' },
      tool(3, 'work_items:get', { id: 'WI-4852' }),
      tool(4, 'functions.exec', { cmd: 'sed -n 1,40p source.ts' }),
      tool(5, 'session:carry-drill', { op: 'grade', drillId: 'drill-1' }),
    ],
  };

  it('mechanically records only explicit recovery lookups and returns the class report', async () => {
    const ledger = [requested];
    const result = await gradeColdBootDrill('su-1', 'drill-1', {
      readLedger: async () => ledger,
      appendLedger: async (event) => { ledger.push(event); return true; },
      readHostEvents: async () => [{ kind: 'carry-drill-respawned', drillId: 'drill-1', nativeId: 'native-2', launchContextPath: '/safe/carry.md' }],
      readCarry: async () => SPEC.systemPromptAddendum,
      loadTranscript: async () => transcript,
      now: () => NOW + 1000,
    });
    expect(result).toMatchObject({
      ok: true,
      alreadyGraded: false,
      transcriptPath: transcript.ref,
      sample: {
        sessionClass: 'claude-su',
        lookups: [
          { kind: 'orient-recall-fold', targetClass: 'facts', similarity: 0.03 },
          { kind: 'reread-state', targetClass: 'held-wi', recoveredInCarry: true },
        ],
      },
      report: { perClass: [{ sessionClass: 'claude-su', drills: 1, gaps: 0, surfacingGaps: 1, sufficient: false }] },
    });
    expect(ledger.at(-1)?.kind).toBe('carry-drill-graded');
  });

  it('grades a delivered drill when the recipient identity differs from its originating owner', async () => {
    const ledger = [requested];
    const hostOwners: string[] = [];
    const transcriptOwners: string[] = [];
    const result = await gradeColdBootDrill('system:judge/su-1', 'drill-1', {
      readLedger: async () => ledger,
      appendLedger: async (event) => { ledger.push(event); return true; },
      readHostEvents: async (ownerId) => {
        hostOwners.push(ownerId);
        return [{ kind: 'carry-drill-respawned', drillId: 'drill-1', nativeId: 'native-2', launchContextPath: '/safe/carry.md' }];
      },
      readCarry: async () => SPEC.systemPromptAddendum,
      loadTranscript: async (ownerId) => {
        transcriptOwners.push(ownerId);
        return transcript;
      },
      now: () => NOW + 1000,
    });

    expect(result).toMatchObject({ ok: true, drillId: 'drill-1', alreadyGraded: false });
    expect(hostOwners).toEqual(['su-1']);
    expect(transcriptOwners).toEqual(['su-1']);
    expect(ledger.at(-1)).toMatchObject({
      kind: 'carry-drill-graded',
      ownerId: 'su-1',
      gradedByOwnerId: 'system:judge/su-1',
    });
  });

  it('refuses a drill id recorded under multiple owners', async () => {
    const secondOwner = { ...requested, ownerId: 'su-2' };
    let storageReads = 0;
    const result = await gradeColdBootDrill('system:judge/su-1', 'drill-1', {
      readLedger: async () => [requested, secondOwner],
      appendLedger: async () => true,
      readHostEvents: async () => { storageReads += 1; return []; },
      readCarry: async () => null,
      loadTranscript: async () => null,
      now: () => NOW,
    });

    expect(result).toMatchObject({ ok: false, error: 'ambiguous_drill' });
    expect(storageReads).toBe(0);
  });

  it('grades a current Codex response_item successor through the shared replay parser', async () => {
    const ledger: ColdBootDrillLedgerEvent[] = [
      { ...requested, sessionClass: 'codex-interactive' },
    ];
    const codexBody = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '⟦carry-drill:drill-1⟧\nContinue the carried work.' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          input: [
            'const result = await tools.mcp__papercusp_su__tools_invoke({',
            '  name: "work_items:get",',
            '  args: { id: "WI-4852" }',
            '});',
            'text(result);',
          ].join('\n'),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          input: [
            'const result = await tools.mcp__papercusp_su__tools_invoke({',
            '  name: "session:carry-drill",',
            '  args: { op: "grade", drillId: "drill-1" }',
            '});',
            'text(result);',
          ].join('\n'),
        },
      }),
    ].join('\n');
    const codexTranscript = parseTranscriptJsonl(codexBody, '/tmp/codex-successor.jsonl');

    const result = await gradeColdBootDrill('su-1', 'drill-1', {
      readLedger: async () => ledger,
      appendLedger: async (event) => { ledger.push(event); return true; },
      readHostEvents: async () => [{
        kind: 'carry-drill-respawned',
        drillId: 'drill-1',
        nativeId: 'codex-native-2',
        launchContextPath: '/safe/carry.md',
      }],
      readCarry: async () => SPEC.systemPromptAddendum,
      loadTranscript: async () => codexTranscript,
      now: () => NOW + 1000,
    });

    expect(result).toMatchObject({
      ok: true,
      transcriptPath: '/tmp/codex-successor.jsonl',
      sample: {
        sessionClass: 'codex-interactive',
        lookups: [{ kind: 'reread-state', targetClass: 'held-wi', recoveredInCarry: true }],
      },
    });
    expect(ledger.at(-1)).toMatchObject({
      kind: 'carry-drill-graded',
      sessionClass: 'codex-interactive',
      transcriptPath: '/tmp/codex-successor.jsonl',
    });
  });

  it('is idempotent once a sample is graded', async () => {
    const graded: ColdBootDrillLedgerEvent = {
      ...requested,
      kind: 'carry-drill-graded',
      lookups: [],
      transcriptPath: transcript.ref,
    };
    let appendCalls = 0;
    const result = await gradeColdBootDrill('su-1', 'drill-1', {
      readLedger: async () => [requested, graded],
      appendLedger: async () => { appendCalls += 1; return true; },
      readHostEvents: async () => [],
      readCarry: async () => null,
      loadTranscript: async () => null,
      now: () => NOW,
    });
    expect(result).toMatchObject({ ok: true, alreadyGraded: true, sample: { lookups: [] } });
    expect(appendCalls).toBe(0);
  });

  it('does not guess when the host has not recorded a successor', async () => {
    const result = await gradeColdBootDrill('su-1', 'drill-1', {
      readLedger: async () => [requested],
      appendLedger: async () => true,
      readHostEvents: async () => [],
      readCarry: async () => SPEC.systemPromptAddendum,
      loadTranscript: async () => transcript,
      now: () => NOW,
    });
    expect(result).toMatchObject({ ok: false, error: 'respawn_not_observed' });
  });

  it('surfaces a durable host preparation failure instead of reporting an ambiguous wait', async () => {
    const result = await gradeColdBootDrill('su-1', 'drill-1', {
      readLedger: async () => [requested],
      appendLedger: async () => true,
      readHostEvents: async () => [{ kind: 'carry-drill-respawn-failed', drillId: 'drill-1', reason: 'argv-build-failed' }],
      readCarry: async () => SPEC.systemPromptAddendum,
      loadTranscript: async () => transcript,
      now: () => NOW,
    });
    expect(result).toMatchObject({ ok: false, error: 'respawn_failed' });
  });
});

describe('reportColdBootDrills', () => {
  it('deduplicates drill ids and accepts the owner-shortened one-clean-smoke gate', async () => {
    const rows: ColdBootDrillLedgerEvent[] = Array.from({ length: 1 }, (_, i) => ({
      ts: new Date(NOW + i).toISOString(),
      kind: 'carry-drill-graded',
      drillId: `d-${i}`,
      ownerId: `su-${i}`,
      sessionClass: 'claude-su',
      lookups: [],
    }));
    rows.push({ ...rows[0], ts: new Date(NOW + 99).toISOString() });
    const report = await reportColdBootDrills(async () => rows);
    expect(report.perClass[0]).toMatchObject({ drills: 1, gaps: 0, surfacingGaps: 0, sufficient: true });
    expect(report.sufficientClasses).toEqual(['claude-su']);
  });

  it('surfaces host-mirrored terminal outcomes so an all-dropped class is visible, not an empty report (EI-12655)', async () => {
    const rows: ColdBootDrillLedgerEvent[] = [
      { ts: new Date(NOW).toISOString(), kind: 'carry-drill-requested', drillId: 'd-1', ownerId: 'su-1', sessionClass: 'gateway-claude-headless' },
      { ts: new Date(NOW + 1).toISOString(), kind: 'carry-drill-queued', drillId: 'd-1', ownerId: 'su-1', sessionClass: 'gateway-claude-headless' },
      { ts: new Date(NOW + 2).toISOString(), kind: 'carry-drill-respawned', drillId: 'd-1', ownerId: 'su-1', sessionClass: 'gateway-claude-headless', nativeId: 'n-1' },
      { ts: new Date(NOW + 3).toISOString(), kind: 'carry-drill-carry-dropped', drillId: 'd-1', ownerId: 'su-1', sessionClass: 'gateway-claude-headless', reason: 'never-settled' },
      { ts: new Date(NOW + 4).toISOString(), kind: 'carry-drill-carry-dropped', drillId: 'd-2', ownerId: 'su-2', sessionClass: 'gateway-claude-headless', reason: 'busy-gate-expired' },
      { ts: new Date(NOW + 5).toISOString(), kind: 'carry-drill-carry-delivered', drillId: 'd-3', ownerId: 'su-3', sessionClass: 'claude-su' },
    ];
    // A duplicated mirror row must not double-count the drill.
    rows.push({ ...rows[3], ts: new Date(NOW + 9).toISOString() });
    const report = await reportColdBootDrills(async () => rows);
    // Nothing graded → sufficiency stays empty; terminal outcomes still tell the story.
    expect(report.perClass).toEqual([]);
    const headless = report.terminalOutcomes.find((c) => c.sessionClass === 'gateway-claude-headless');
    expect(headless).toMatchObject({ respawned: 1, delivered: 0, dropped: 2 });
    expect(headless?.dropReasons).toEqual({ 'never-settled': 1, 'busy-gate-expired': 1 });
    const su = report.terminalOutcomes.find((c) => c.sessionClass === 'claude-su');
    expect(su).toMatchObject({ delivered: 1, dropped: 0 });
  });

  it('terminalOutcomesFromLedger buckets a class-less mirrored row under unknown', () => {
    const outcomes = terminalOutcomesFromLedger([
      { ts: new Date(NOW).toISOString(), kind: 'carry-drill-respawn-failed', drillId: 'd-9', ownerId: 'su-9', sessionClass: '', reason: 'spawn-failed' },
    ]);
    expect(outcomes).toEqual([
      { sessionClass: 'unknown', respawned: 0, respawnFailed: 1, delivered: 0, dropped: 0, dropReasons: {} },
    ]);
  });
});

describe('verifyColdBootDrill — post-start lifecycle self-check (EI-12655 fix c)', () => {
  const LEDGER: ColdBootDrillLedgerEvent[] = [
    { ts: new Date(NOW).toISOString(), kind: 'carry-drill-requested', drillId: 'd-1', ownerId: 'su-1', sessionClass: 'gateway-claude-headless' },
    { ts: new Date(NOW + 1).toISOString(), kind: 'carry-drill-queued', drillId: 'd-1', ownerId: 'su-1', sessionClass: 'gateway-claude-headless' },
  ];
  const HOST_EVENTS: ColdBootDrillHostEvent[] = [
    { ts: new Date(NOW + 2).toISOString(), kind: 'carry-drill-respawned', drillId: 'd-1', sessionClass: 'gateway-claude-headless', nativeId: 'n-1' },
    { ts: new Date(NOW + 3).toISOString(), kind: 'carry-drill-carry-delivered', drillId: 'd-1', sessionClass: 'gateway-claude-headless' },
  ];

  it('checks the recorded live socket when it is outside the discovery directory', async () => {
    const dir = mkdtempSync('/tmp/pc-drill-');
    const sock = `${dir}/recorded.sock`;
    const server = createServer();
    const find = vi.spyOn(discovery, 'findLiveHostAsync').mockResolvedValue({ ...HOST, pid: process.pid, sock });
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(sock, resolve); });
      const result = await verifyColdBootDrill('su-1', { drillId: 'd-1' }, {
        readLedger: async () => LEDGER, readHostEvents: async () => HOST_EVENTS,
      });
      expect(find).toHaveBeenCalledWith('su-1');
      expect(result).toMatchObject({ ok: true, pass: true });
    } finally {
      find.mockRestore();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes all four assertions for a fully-recorded drill', async () => {
    const result = await verifyColdBootDrill('su-1', { drillId: 'd-1' }, {
      readLedger: async () => LEDGER,
      readHostEvents: async () => HOST_EVENTS,
      socketExists: async () => true,
    });
    expect(result).toMatchObject({ ok: true, drillId: 'd-1', sessionClass: 'gateway-claude-headless', pass: true });
    if (result.ok) expect(result.assertions.map((a) => [a.name, a.pass])).toEqual([
      ['ledger-registered', true],
      ['host-respawned', true],
      ['terminal-outcome', true],
      ['owner-socket-live', true],
    ]);
  });

  it('fails host-respawned + terminal-outcome for the silent-vanish class (queued row only, dead host)', async () => {
    const result = await verifyColdBootDrill('su-1', {}, {
      readLedger: async () => LEDGER,
      readHostEvents: async () => [],
      socketExists: async () => false,
    });
    expect(result).toMatchObject({ ok: true, drillId: 'd-1', pass: false });
    if (result.ok) {
      const byName = Object.fromEntries(result.assertions.map((a) => [a.name, a.pass]));
      expect(byName).toEqual({
        'ledger-registered': true,
        'host-respawned': false,
        'terminal-outcome': false,
        'owner-socket-live': false,
      });
    }
  });

  it('accepts a host-mirrored terminal row from the SHARED ledger when the per-owner log is gone', async () => {
    const mirrored: ColdBootDrillLedgerEvent[] = [
      ...LEDGER,
      { ts: new Date(NOW + 2).toISOString(), kind: 'carry-drill-respawned', drillId: 'd-1', ownerId: 'su-1', sessionClass: 'gateway-claude-headless', nativeId: 'n-1' },
      { ts: new Date(NOW + 3).toISOString(), kind: 'carry-drill-carry-dropped', drillId: 'd-1', ownerId: 'su-1', sessionClass: 'gateway-claude-headless', reason: 'busy-gate-expired' },
    ];
    const result = await verifyColdBootDrill('su-1', { drillId: 'd-1' }, {
      readLedger: async () => mirrored,
      readHostEvents: async () => [],
      socketExists: async () => true,
    });
    expect(result).toMatchObject({ ok: true, pass: true });
    if (result.ok) {
      expect(result.assertions.find((a) => a.name === 'terminal-outcome')?.detail).toContain('busy-gate-expired');
    }
  });

  it('resolves the latest drill for the owner when drillId is omitted, filtered by sessionClass', async () => {
    const two: ColdBootDrillLedgerEvent[] = [
      ...LEDGER,
      { ts: new Date(NOW + 10).toISOString(), kind: 'carry-drill-requested', drillId: 'd-2', ownerId: 'su-1', sessionClass: 'claude-su' },
    ];
    const latest = await verifyColdBootDrill('su-1', {}, {
      readLedger: async () => two,
      readHostEvents: async () => [],
      socketExists: async () => true,
    });
    expect(latest.ok && latest.drillId).toBe('d-2');
    const filtered = await verifyColdBootDrill('su-1', { sessionClass: 'gateway-claude-headless' }, {
      readLedger: async () => two,
      readHostEvents: async () => [],
      socketExists: async () => true,
    });
    expect(filtered.ok && filtered.drillId).toBe('d-1');
  });

  it('is loud on an unknown explicit drillId and on an owner with no drills', async () => {
    const unknown = await verifyColdBootDrill('su-1', { drillId: 'nope' }, {
      readLedger: async () => LEDGER,
      readHostEvents: async () => [],
      socketExists: async () => true,
    });
    expect(unknown).toMatchObject({ ok: false, error: 'unknown_drill' });
    const none = await verifyColdBootDrill('su-none', {}, {
      readLedger: async () => LEDGER,
      readHostEvents: async () => [],
      socketExists: async () => true,
    });
    expect(none).toMatchObject({ ok: false, error: 'no_drill_found' });
  });
});

describe('scanCarryDrillDrops (EI-12755 — the drop watchdog scanner)', () => {
  const T0 = Date.parse('2026-07-15T12:00:00.000Z');
  const row = (
    kind: ColdBootDrillLedgerEvent['kind'],
    drillId: string,
    offsetMs: number,
    extra: Partial<ColdBootDrillLedgerEvent> = {},
  ): ColdBootDrillLedgerEvent => ({
    ts: new Date(T0 + offsetMs).toISOString(),
    kind,
    drillId,
    ownerId: 'su-w',
    sessionClass: 'gateway-claude-headless',
    ...extra,
  });

  it('alerts on dropped + respawn-failed rows newer than the watermark, ignoring the rest', () => {
    const events = [
      row('carry-drill-requested', 'd-1', 1_000),
      row('carry-drill-queued', 'd-1', 1_100),
      row('carry-drill-carry-delivered', 'd-1', 2_000),
      row('carry-drill-carry-dropped', 'd-2', 3_000, { reason: 'busy-gate-expired' }),
      row('carry-drill-respawn-failed', 'd-3', 4_000, { reason: 'argv-build-failed' }),
      // EI-12754's non-terminal marker must never alert (its retry ends in its own terminal row).
      row('carry-drill-rearm-queued', 'd-4', 5_000),
    ];
    const { alerts, watermarkMs } = scanCarryDrillDrops(events, T0);
    expect(alerts).toEqual([
      expect.objectContaining({ drillId: 'd-2', kind: 'carry-drill-carry-dropped', reason: 'busy-gate-expired' }),
      expect.objectContaining({ drillId: 'd-3', kind: 'carry-drill-respawn-failed', reason: 'argv-build-failed' }),
    ]);
    expect(watermarkMs).toBe(T0 + 4_000);
  });

  it('respects the watermark and dedupes per (drillId, kind)', () => {
    const events = [
      row('carry-drill-carry-dropped', 'd-old', -60_000, { reason: 'never-settled' }),
      row('carry-drill-carry-dropped', 'd-5', 1_000, { reason: 'busy-gate-expired' }),
      // A retried mirror write can duplicate a row — one drill never alerts twice.
      row('carry-drill-carry-dropped', 'd-5', 1_500, { reason: 'busy-gate-expired' }),
      // ...but a DIFFERENT terminal kind for the same drill is a distinct signal.
      row('carry-drill-respawn-failed', 'd-5', 2_000, { reason: 'argv-build-failed' }),
    ];
    const { alerts } = scanCarryDrillDrops(events, T0);
    expect(alerts.map((a) => `${a.drillId}:${a.kind}`)).toEqual([
      'd-5:carry-drill-carry-dropped',
      'd-5:carry-drill-respawn-failed',
    ]);
  });

  it('returns the unchanged watermark when nothing qualifies', () => {
    const events = [row('carry-drill-carry-delivered', 'd-6', 1_000)];
    expect(scanCarryDrillDrops(events, T0)).toEqual({ alerts: [], watermarkMs: T0 });
  });

  it('terminalOutcomesFromLedger ignores the non-terminal rearm-queued kind', () => {
    const events = [
      row('carry-drill-rearm-queued', 'd-7', 1_000),
      row('carry-drill-carry-dropped', 'd-7', 2_000, { reason: 'busy-gate-expired', rearmed: true }),
    ];
    const outcomes = terminalOutcomesFromLedger(events);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ dropped: 1, respawned: 0, delivered: 0 });
  });
});

describe('source hygiene — no raw NUL byte in the module (EI-12655)', () => {
  it('contains no raw NUL byte (keeps it a text file, not binary)', () => {
    // terminalOutcomesFromLedger joins its dedupe key with a NUL delimiter. It must
    // be written as the `\x00` escape, NOT a literal NUL char in source: a raw NUL
    // makes the file report as binary to file(1)/grep and breaks tooling (the file
    // was shipped this way by the EI-12655 fix). Guard against the class recurring.
    const src = readFileSync(new URL('./cold-boot-drill-live.ts', import.meta.url), 'utf8');
    expect(src.includes('\u0000')).toBe(false);
  });
});

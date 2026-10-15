/**
 * Installed-binary real-PTY E2E for the pui Context-pane cockpit (WI-42179 /
 * plan pui-agent-context-cockpit-2026-08-26 P-008).
 *
 * Launches the ACTUAL `pui` binary (`pui context-pane <sourceKind> <sessionId>
 * <harness>`) under a real PTY (@lydell/node-pty) against a local fake
 * canonical HTTP operator (node:http), and asserts the terminal render + the
 * wire contract through the cockpit loop:
 *
 *  - projection fetch over `/api/zero-harness/rest-query?name=conversations.contextProjection`
 *  - claim → burn-down flip across fixture stages (refreshed with `g`)
 *  - typed block ref rendered ("blocked on WI-…") + server-side auto-unblock
 *  - owner task editor + lifecycle (`a/e` add/edit · `s/x` start/done ·
 *    `b/u` block/unblock · `r` reopen · `K/J` reorder · `d` drop)
 *    → POST /api/harness/<h>/agent-chats/<chat>/tasks with {action, taskId},
 *    and the mutation response's canonical projection applied to the render
 *  - revision-conflict and network refusals retain the exact editor draft for retry
 *  - promote → the response projection carries the created work-item's
 *    `for`-edge link (links[] contract; the pane renders the task's blocker
 *    transition — link chips themselves are not part of the pane render)
 *  - read-only tier (codex target): task keys emit NO wire ops, footer
 *    degrades to "unavailable sections stay absent"
 *
 * The semantic tool cards / per-model-family alias shims are the CHAT-lane
 * (apps/tui/src/semantic_tool_cards.rs `card_for_tool` + `tool_name_is`) and
 * are unit-verified in that crate (`cargo test` in apps/tui); they do not
 * render in the Context pane, so they are deliberately not re-asserted here.
 *
 * Binary resolution: $PUI_BIN → `cargo metadata` target dir → common target
 * paths → $PATH. If absent, the suite builds it (`cargo build --bin pui`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawn as ptySpawn, type IPty } from '@lydell/node-pty';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { screenContains, VtScreen } from './vt-screen';
import { describeObserverBlock, pollUntil } from './poll-until';
import { HARNESS_TAG } from './release-acceptance';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const TUI_DIR = path.join(REPO_ROOT, 'apps', 'tui');
const HARNESS = 'papercusp';
const CHAT_ID = 'chat-e2e';
const HUD_HARNESS = 'papercup';

// ─── binary resolution ────────────────────────────────────────────────────────

function cargoTargetDir(): string | null {
  const probe = spawnSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], {
    cwd: TUI_DIR,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (probe.status !== 0 || !probe.stdout) return null;
  try {
    return (JSON.parse(probe.stdout) as { target_directory?: string }).target_directory ?? null;
  } catch {
    return null;
  }
}

function resolvePuiBinary(): string | null {
  const targetDir = cargoTargetDir();
  const candidates: Array<string | null> = [
    targetDir ? path.join(targetDir, 'debug', 'pui') : null,
    targetDir ? path.join(targetDir, 'release', 'pui') : null,
    path.join(TUI_DIR, 'target', 'debug', 'pui'),
    path.join(TUI_DIR, 'target', 'release', 'pui'),
  ];
  return candidates.find((c): c is string => Boolean(c && existsSync(c))) ?? null;
}

/**
 * PUI_BIN explicitly selects an installed artifact; otherwise ALWAYS build
 * (incremental — a no-op when current). Reusing whatever binary already exists
 * measured stale code while reporting a current pass, which then bound as
 * evidence for source it never ran. Same contract as agent-chat-pty.
 */
function ensurePuiBinary(): string {
  if (process.env.PUI_BIN) {
    if (!existsSync(process.env.PUI_BIN)) throw new Error('The explicit PUI_BIN artifact does not exist');
    return process.env.PUI_BIN;
  }
  const build = spawnSync('cargo', ['build', '--locked', '--bin', 'pui'], {
    cwd: TUI_DIR,
    encoding: 'utf8',
    timeout: 840_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (build.status !== 0) {
    throw new Error(`cargo build --locked --bin pui failed:\n${build.stderr?.slice(-4000)}`);
  }
  const built = resolvePuiBinary();
  if (!built) throw new Error('pui binary is absent after a successful cargo build');
  return built;
}

// ─── projection fixtures ──────────────────────────────────────────────────────

type TaskFixture = {
  id: string;
  content: string;
  activeForm: string;
  status: string;
  blockerRef?: string | null;
  explanation?: string | null;
  updatedAt?: string;
  links?: Array<{ workItemId: string; workItemHarness?: string; relation: 'for' | 'relates' }>;
};

function taskFrame(t: TaskFixture, position: number) {
  return {
    kind: 'task',
    id: `task:${t.id}`,
    taskId: t.id,
    content: t.content,
    activeForm: t.activeForm,
    status: t.status,
    blockerRef: t.blockerRef ?? null,
    explanation: t.explanation ?? null,
    position,
    updatedAt: t.updatedAt ?? '2026-08-26T22:00:00Z',
    links: t.links ?? [],
  };
}

function makeProjection(opts: {
  sourceKind: string;
  sessionId: string;
  tier: string;
  taskWrite: boolean;
  burnDown: string;
  claim: { value: string; state: string };
  tasks: TaskFixture[];
  approvals?: Array<{ callId: string; toolName: string; status: string; reason?: string }>;
}) {
  return {
    schemaVersion: 'conversation-context-v1',
    session: {
      sourceKind: opts.sourceKind,
      sessionId: opts.sessionId,
      harness: HARNESS,
      role: 'sentinel',
      linkedWorkItemId: 'WI-42179',
      capabilityTier: opts.tier,
    },
    capabilities: {
      liveFrames: true,
      taskWrite: opts.taskWrite,
      approvalWrite: opts.taskWrite,
    },
    frames: [
      {
        kind: 'context',
        id: 'context:identity',
        section: 'identity',
        title: 'Identity',
        entries: [{ label: 'Session', value: opts.sessionId, state: null, badges: [] }],
      },
      {
        kind: 'context',
        id: 'context:work',
        section: 'work',
        title: 'Work',
        entries: [
          { label: 'Burn-down', value: opts.burnDown, state: null, badges: [] },
          { label: 'Claim', value: opts.claim.value, state: opts.claim.state, badges: [] },
        ],
      },
      ...opts.tasks.map((t, i) => taskFrame(t, i)),
      ...(opts.approvals ?? []).map((a) => ({
        kind: 'approval',
        id: `approval:${a.callId}`,
        callId: a.callId,
        toolName: a.toolName,
        status: a.status,
        reason: a.reason ?? null,
      })),
    ],
  };
}

// ─── fake canonical operator ──────────────────────────────────────────────────

type RecordedQuery = { name: string; args: Record<string, unknown> };
type RecordedTaskOp = { path: string; body: Record<string, unknown> };
type RecordedRequest = { method: string; path: string; body?: Record<string, unknown> };

function mcpEnvelope(value: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function runToolEnvelope(value: unknown) {
  return { ok: true, result: mcpEnvelope(value) };
}

class FakeOperator {
  server: Server;
  port = 0;
  /** rows served for the projection query, keyed by sessionId */
  projections = new Map<string, unknown>();
  /** projection returned inside the NEXT task-op mutation response */
  mutationProjection: unknown = null;
  jsonRoutes = new Map<string, unknown>();
  runToolResponses = new Map<string, unknown>();
  queries: RecordedQuery[] = [];
  taskOps: RecordedTaskOp[] = [];
  taskOpFailures: Array<{ status: number; code: string; message: string }> = [];
  requests: RecordedRequest[] = [];
  private sockets = new Set<Socket>();

  constructor() {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const send = (value: unknown, status = 200) => {
        const body = JSON.stringify(value);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body);
      };
      if (url.pathname === '/api/tui/identity') {
        send({
          schemaVersion: 1,
          workspaceId: 'ws-e2e',
          store: { id: 'store-e2e', target: 'pg', source: 'e2e' },
          build: { version: '0.0.0-e2e', sha: null },
          agentChat: { scope: 'workspace:ws-e2e', route: '/api/harness' },
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/agent-mcp/run-tool') {
        let raw = '';
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', () => {
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(raw || '{}');
          } catch {
            /* keep {} */
          }
          this.requests.push({ method: 'POST', path: url.pathname, body });
          const name = String(body.name ?? '');
          send(runToolEnvelope(this.runToolResponses.get(name) ?? { ok: true }));
        });
        return;
      }
      const routeKey = `${req.method ?? 'GET'} ${url.pathname}`;
      if (this.jsonRoutes.has(routeKey)) {
        this.requests.push({ method: req.method ?? 'GET', path: url.pathname });
        send(this.jsonRoutes.get(routeKey));
        return;
      }
      if (url.pathname === '/api/zero-harness/rest-query') {
        const name = url.searchParams.get('name') ?? '';
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(url.searchParams.get('args') ?? '{}');
        } catch {
          /* keep {} */
        }
        this.queries.push({ name, args });
        if (name === 'conversations.contextProjection') {
          const projection = this.projections.get(String(args.sessionId ?? ''));
          send({ rows: projection ? [projection] : [], version: 1 });
          return;
        }
        send({ rows: [], version: 1 });
        return;
      }
      // Any SSE subscription: hold the stream open with a heartbeat comment.
      if (url.pathname.includes('/sse') || (req.headers.accept ?? '').includes('text/event-stream')) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(': heartbeat\n\n');
        return; // never ended; sockets are destroyed in close()
      }
      if (req.method === 'POST' && /^\/api\/harness\/[^/]+\/agent-chats\/[^/]+\/tasks$/.test(url.pathname)) {
        let raw = '';
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', () => {
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(raw || '{}');
          } catch {
            /* keep {} */
          }
          this.taskOps.push({ path: url.pathname, body });
          const failure = this.taskOpFailures.shift();
          if (failure) {
            send({ error: { code: failure.code, message: failure.message } }, failure.status);
            return;
          }
          send({
            ok: true,
            action: body.action ?? 'check',
            op: String(body.action ?? 'check'),
            changedTaskId: body.taskId ?? null,
            tasks: [],
            projection: this.mutationProjection,
          });
        });
        return;
      }
      // Everything else: benign empties — the pui DTOs default missing fields.
      send({ rows: [], ok: true });
    });
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server.address() as AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  async waitForTool(name: string, timeoutMs = 15_000): Promise<RecordedRequest> {
    const find = () => this.requests.find((candidate) => candidate.body?.name === name);
    const { maxLateMs } = await pollUntil(() => find() !== undefined, { timeoutMs, intervalMs: 50 });
    const request = find();
    if (request) return request;
    throw new Error(`timed out waiting for run-tool request ${name}${describeObserverBlock(maxLateMs)}`);
  }

  async waitForTaskAction(action: string, after = 0, timeoutMs = 15_000): Promise<RecordedTaskOp> {
    const find = () => this.taskOps.slice(after).find((candidate) => candidate.body.action === action);
    const { maxLateMs } = await pollUntil(() => find() !== undefined, { timeoutMs, intervalMs: 50 });
    const request = find();
    if (request) return request;
    throw new Error(`timed out waiting for task action ${action}${describeObserverBlock(maxLateMs)}`);
  }
}

// ─── PTY harness ──────────────────────────────────────────────────────────────

class PuiPane {
  pty: IPty;
  private raw = '';

  constructor(bin: string, args: string[], env: Record<string, string>) {
    this.pty = ptySpawn(bin, args, {
      name: 'xterm-256color',
      cols: 140,
      rows: 40,
      cwd: REPO_ROOT,
      env,
    });
    this.pty.onData((chunk) => {
      this.raw += chunk;
    });
  }

  /** The RENDERED screen: 40 rows × 140 cols, right-trimmed, newline-joined. */
  screen(): string {
    const vt = new VtScreen(40, 140);
    vt.feed(this.raw);
    return vt.text();
  }

  /**
   * Substring match against the whitespace-NORMALIZED rendered screen (runs of
   * spaces collapse per row), so a column-aligned layout ("Burn-down   2/5")
   * still matches a single-spaced needle. Needles never span rows.
   */
  contains(needle: string): boolean {
    return screenContains(this.screen(), needle);
  }

  async waitFor(needle: string, opts: { timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 20_000;
    const { ok, maxLateMs } = await pollUntil(() => this.contains(needle), { timeoutMs });
    if (ok) return;
    throw new Error(
      `timed out (${timeoutMs}ms) waiting for ${JSON.stringify(needle)} on the rendered screen`
        + `${describeObserverBlock(maxLateMs)}:\n${this.screen()}`,
    );
  }

  async waitForAbsent(needle: string, opts: { timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 20_000;
    const { ok, maxLateMs } = await pollUntil(() => !this.contains(needle), { timeoutMs });
    if (ok) return;
    throw new Error(
      `timed out (${timeoutMs}ms) waiting for ${JSON.stringify(needle)} to leave the rendered screen`
        + `${describeObserverBlock(maxLateMs)}:\n${this.screen()}`,
    );
  }

  write(keys: string): void {
    this.pty.write(keys);
  }

  kill(): void {
    try {
      this.pty.kill();
    } catch {
      /* already dead */
    }
  }
}

function paneEnv(operatorPort: number, home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TERM: 'xterm-256color',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    PUI_OPERATOR: `http://127.0.0.1:${operatorPort}`,
    // Deliberately NOT inheriting PAPERCUSP_OPERATOR_URL / ZELLIJ etc. — a
    // conflicting operator selector makes the binary bail out at startup.
  };
}

function configureHudCockpitFixture(fake: FakeOperator): void {
  const plan = 'hud-cockpit-e2e';
  // Roster rows feed the Sessions destination, whose default WHEN window is 7d
  // against the real clock, so these stamps must be relative to now: absolute
  // dates silently aged this fixture out of the default view a week after it
  // was written.
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const leader = {
    ownerId: 'su-hud-leader',
    label: 'HUD Leader',
    source: 'codex',
    agent: 'codex',
    role: 'su',
    intent: 'Drive the HUD acceptance lane',
    liveness: 'live',
    sessionState: 'live',
    heartbeatFresh: true,
    heartbeatAt: ago(20 * 60_000),
    fleetSlug: 'hud-fleet',
    fleetRole: 'leader',
    currentPlanSlug: plan,
    agentPaneKind: 'sentinel',
  };
  const endedWithFreshHeartbeat = {
    ownerId: 'su-ended-fresh',
    label: 'Ended Fresh',
    source: 'codex',
    agent: 'codex',
    role: 'worker',
    intent: 'Finished the prior lane',
    liveness: 'live',
    sessionState: 'ended',
    heartbeatFresh: true,
    heartbeatAt: ago(1_000),
    fleetSlug: 'hud-fleet',
    fleetRole: 'member',
    currentPlanSlug: plan,
    advSessionId: 4242,
    hasLaunchRecord: true,
    cwd: REPO_ROOT,
    mode: 'console',
    transcriptRef: 'codex:hud-ended:4242',
    transcriptExcerpt: 'Durable ended-session transcript',
    transcriptAt: ago(2_000),
  };

  fake.jsonRoutes.set('GET /api/adv/roster', {
    active: [leader, endedWithFreshHeartbeat],
    pending: [],
    ended: [endedWithFreshHeartbeat],
  });
  fake.jsonRoutes.set('GET /api/operator/conversations', {
    conversation: { id: 'conv-hud-e2e' },
    turns: [
      { seq: 1, role: 'user', text: 'Ship the cockpit acceptance gate.' },
      {
        seq: 2,
        role: 'assistant',
        text: 'The work item is complete.',
        tools: [{ name: 'mcp__papercusp-su__work_items_complete' }],
      },
    ],
    hasMoreEarlier: false,
  });
  fake.jsonRoutes.set(`GET /api/harness/${HUD_HARNESS}/agent-chats`, {
    chats: [
      {
        id: 'chat-hud-e2e',
        role: 'operator',
        title: 'HUD acceptance chat',
        // Agent Chat's front door opens only a classified su-session chat;
        // an unclassified one stays in the history picker and never loads.
        su_runtime_class: 'su-session',
        turn_count: 2,
        created_at: '2026-08-27T03:20:00Z',
        updated_at: '2026-08-27T03:59:00Z',
      },
    ],
  });
  fake.jsonRoutes.set(`GET /api/harness/${HUD_HARNESS}/agent-chats/chat-hud-e2e`, {
    id: 'chat-hud-e2e',
    role: 'operator',
    title: 'HUD acceptance chat',
    transcript: [
      { role: 'user', content: 'Ship the cockpit acceptance gate.', ts: '2026-08-27T03:58:00Z' },
      {
        role: 'assistant',
        content: 'The work item is complete.',
        ts: '2026-08-27T03:59:00Z',
        tools: [{ name: 'mcp__papercusp-su__work_items_complete' }],
      },
    ],
  });
  fake.jsonRoutes.set(`GET /api/harness/${HUD_HARNESS}/agent-chats/chat-hud-e2e/approvals`, {
    approvals: [],
  });
  // pui-chat-first-ux D-030: Agent Chat's front door only opens a chat whose
  // session inventory row places it in the launch directory; a chat with no
  // snapshot belongs to no directory and is never opened. The pane launches
  // from REPO_ROOT, so the ended session records that directory (realpath, the
  // way pui reads its own current_dir).
  fake.jsonRoutes.set(`GET /api/harness/${HUD_HARNESS}/agent-chats/chat-hud-e2e/su-session`, {
    ok: true,
    descriptor: {
      identity: {
        agentChatId: 'chat-hud-e2e',
        advSessionId: 4242,
        backend: 'claude',
        nativeSessionId: 'native-hud-e2e',
        ownerId: 'su-hud-e2e',
        workspaceId: 'ws-e2e',
        harnessSlug: HUD_HARNESS,
      },
      lifecycle: 'ended',
      runtimeGeneration: 1,
      role: 'operator',
      carry: 'warm',
      modes: [],
      capabilities: { commands: {}, features: {} },
      backendExtension: { backend: 'claude' },
    },
    floorSequence: 0,
    lastSequence: 2,
    terminal: true,
    launchCwd: realpathSync(REPO_ROOT),
  });
  fake.jsonRoutes.set('GET /api/admin/plans/list', {
    plans: [
      {
        slug: plan,
        title: 'HUD cockpit installed-binary gate',
        status: 'active',
        updated: '2026-08-27T03:30:00Z',
        harness: HUD_HARNESS,
        owner: 'avi@storewolf.com',
        next: 'Run the acceptance gate',
        itemCounts: { todo: 2, wip: 1, done: 1 },
      },
    ],
  });
  fake.jsonRoutes.set('GET /api/tui/goals', { goals: [], totalGoals: 0, truncatedByLimit: false });
  fake.jsonRoutes.set('GET /api/tui/plan-item-states', {
    harness: HUD_HARNESS,
    plan,
    harnessLivenessMode: 'activity',
    items: [
      {
        itemId: 'P-HUD-ROOT',
        itemStatus: 'wip',
        blockedBy: [],
        inPlan: true,
        disposition: 'active',
        claimOwner: 'HUD Leader',
        claimOwnerId: 'su-hud-leader',
        claimOwnerName: 'hud-leader',
        claimIntent: 'Drive the HUD acceptance lane',
        claimLivenessMode: 'activity',
      },
      {
        itemId: 'P-HUD-NEXT',
        itemStatus: 'todo',
        blockedBy: ['P-HUD-ROOT'],
        inPlan: true,
        disposition: 'pooled',
      },
    ],
  });
  fake.jsonRoutes.set(
    'POST /api/agent-tools/fleet/assignments',
    mcpEnvelope({
      agents: [
        {
          agentId: 'su-hud-leader',
          label: 'HUD Leader',
          alive: true,
          sessionState: 'live',
          contextPressure: 'critical',
          lastToolCallAt: '2026-08-27T03:59:00Z',
          verdict: 'speaking',
          intent: 'Drive the HUD acceptance lane',
          load: 1,
          queued: [{ id: 'WI-HUD-FLIGHT', title: 'Implement HUD gate', status: 'wip' }],
          claims: [{ planSlug: plan }],
        },
        {
          agentId: 'su-ended-fresh',
          label: 'Ended Fresh Heartbeat',
          alive: false,
          sessionState: 'ended',
          contextPressure: 'ok',
          lastToolCallAt: null,
          verdict: 'dead',
          intent: 'Finished the prior lane',
          load: 0,
          queued: [],
          claims: [],
        },
      ],
    }),
  );
  fake.jsonRoutes.set(
    'POST /api/agent-tools/activity/recent',
    mcpEnvelope({
      activity: [
        {
          id: 'activity-hud-complete',
          owner_id: 'su-hud-leader',
          kind: 'tool',
          tool_name: 'fleet:event',
          summary: 'HUD work item completed',
          detail: {
            transition: 'item-completed',
            fleetSlug: 'hud-fleet',
            payload: { id: 'WI-HUD-DONE', state: 'done', agentId: 'su-hud-leader' },
          },
          created_at: '2026-08-27T03:58:00Z',
        },
      ],
    }),
  );

  fake.runToolResponses.set('work_items:burn_down', {
    harness: HUD_HARNESS,
    generatedAt: '2026-08-27T04:00:00Z',
    terminal: { total: 7 },
    inFlight: [
      { id: 'WI-HUD-FLIGHT', kind: 'change', title: 'Implement HUD gate', state: 'wip', assignee: 'su-hud-leader' },
    ],
    parked: [
      {
        id: 'WI-HUD-NEEDS-YOU',
        kind: 'change',
        title: 'Approve the visible acceptance result',
        state: 'needs_human',
        reason: 'owner verdict',
        mechanism: 'needs-human',
      },
    ],
    unclaimed: [{ id: 'WI-HUD-READY', kind: 'change', title: 'Take the next cockpit lane', state: 'open' }],
    counts: { total: 10, terminal: 7, inFlight: 1, parked: 1, unclaimed: 1 },
  });
  fake.runToolResponses.set('work_items:get', { ok: true, results: [] });
  fake.runToolResponses.set('fleet:leader-brief', {
    ok: true,
    summary: {
      fleet: 'hud-fleet',
      members: 2,
      speaking: 1,
      stalled: 0,
      dead: 1,
      highContext: 0,
      criticalContext: 1,
      claimableNow: { value: 1 },
    },
    members: [
      {
        agentId: 'su-hud-leader',
        label: 'HUD Leader',
        sessionState: 'live',
        contextPressure: 'critical',
        lastToolCallAgeMs: 5000,
        workItemIds: ['WI-HUD-FLIGHT'],
        queuedCount: 1,
        load: 1,
      },
    ],
    announcedGates: [{ event: 'fleet:hud-fleet:ship', fired: false, awaiters: 1 }],
    customInvariants: [],
    admissionBlocked: [],
    specRevision: 3,
    specMatched: 1,
    harnessWidePool: 2,
  });
  fake.runToolResponses.set('sessions:search', { ok: true, results: [] });
  fake.runToolResponses.set('sessions:read', {
    ok: true,
    turns: [{ speaker: 'assistant', ts: '2026-08-27T03:59:58Z', text: 'Durable ended-session transcript' }],
  });
  fake.runToolResponses.set('scheduler:preview_spec_delta', {
    counts: { proposedClaimable: 1, retained: 0, newlyAdmitted: 1, newlyExcluded: 0 },
    newlyAdmitted: [{ id: 'WI-HUD-READY' }],
    newlyExcluded: [],
  });
  fake.runToolResponses.set('fleet:launch-on-plan', {
    ok: true,
    fleet: 'pui-hud-cockpit-e2e',
    launched: 1,
  });
}

// ─── the suite ────────────────────────────────────────────────────────────────

let bin: string;
let operator: FakeOperator;
let tempHome: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  bin = ensurePuiBinary();
  tempHome = mkdtempSync(path.join(tmpdir(), 'pui-e2e-home-'));
  // Pre-seed the first-run tutorial as seen so its overlay does not eat keys.
  mkdirSync(path.join(tempHome, '.papercusp'), { recursive: true });
  writeFileSync(path.join(tempHome, '.papercusp', 'pui-state.json'), JSON.stringify({ tutorialSeen: true }));
  operator = new FakeOperator();
  await operator.listen();
  // Release acceptance (P-012 / D-018): this suite is lower-level coverage.
  // Its node:http operator is a fixture, so nothing here is release evidence.
  console.info(HARNESS_TAG, JSON.stringify({ operator: 'fake', binary: bin }));
}, 900_000);

afterAll(async () => {
  await operator?.close();
});

describe('pui context-pane cockpit (installed binary, real PTY, fake canonical operator)', () => {
  test('owned-loop cockpit: claim → burn-down flip, auto-unblock, task ops wire + render, promote for-edge, g refresh', async () => {
    operator.queries = [];
    operator.taskOps = [];
    operator.projections.delete(CHAT_ID);

    const pane = new PuiPane(bin, ['context-pane', 'agent_chat', CHAT_ID, HARNESS], paneEnv(operator.port, tempHome));
    try {
      // Boot: explicit target, no projection rows yet → explicit degradation.
      await pane.waitFor('does not expose Context', { timeoutMs: 30_000 });

      // ── Stage A: initial projection ─────────────────────────────────────
      const tasksA: TaskFixture[] = [
        { id: 't1', content: 'Wire the cockpit E2E', activeForm: 'Wiring the cockpit E2E', status: 'in_progress' },
        {
          id: 't2',
          content: 'Verify blocker clears',
          activeForm: 'Verifying blocker clears',
          status: 'blocked',
          blockerRef: 'WI-9001',
        },
        { id: 't3', content: 'Drop this decoy task', activeForm: 'Dropping the decoy task', status: 'pending' },
        { id: 't4', content: 'Promote me to a work-item', activeForm: 'Promoting to a work-item', status: 'pending' },
      ];
      operator.projections.set(
        CHAT_ID,
        makeProjection({
          sourceKind: 'agent_chat',
          sessionId: CHAT_ID,
          tier: 'owned-loop',
          taskWrite: true,
          burnDown: '2/5 open',
          claim: { value: 'unclaimed', state: 'waiting' },
          tasks: tasksA,
          approvals: [{ callId: 'call-1', toolName: 'locks:acquire', status: 'pending', reason: 'requested' }],
        }),
      );
      pane.write('g');
      await pane.waitFor('Context · owned-loop');
      await pane.waitFor('task write');
      await pane.waitFor('Burn-down');
      await pane.waitFor('2/5 open');
      await pane.waitFor('unclaimed');
      // in_progress renders the activeForm; blocked renders content + typed block ref
      await pane.waitFor('Wiring the cockpit E2E');
      await pane.waitFor('blocked on WI-9001');
      await pane.waitFor('Tasks (4)');
      // approvals surface
      await pane.waitFor('Needs you (1)');
      await pane.waitFor('locks:acquire');
      // writable footer
      await pane.waitFor('Shift-P promote');

      // The wire was queried with the typed target.
      const projQueries = operator.queries.filter((q) => q.name === 'conversations.contextProjection');
      expect(projQueries.length).toBeGreaterThan(0);
      expect(projQueries.at(-1)!.args).toMatchObject({
        sourceKind: 'agent_chat',
        sessionId: CHAT_ID,
        harness: HARNESS,
      });

      // ── Stage B: claim lands server-side → burn-down flips; blocker WI resolves → auto-unblock ──
      const tasksB: TaskFixture[] = [
        tasksA[0],
        { ...tasksA[1], status: 'in_progress', blockerRef: null },
        tasksA[2],
        tasksA[3],
      ];
      operator.projections.set(
        CHAT_ID,
        makeProjection({
          sourceKind: 'agent_chat',
          sessionId: CHAT_ID,
          tier: 'owned-loop',
          taskWrite: true,
          burnDown: '3/5 open',
          claim: { value: 'su-e2e · claimed', state: 'live' },
          tasks: tasksB,
          approvals: [],
        }),
      );
      pane.write('g');
      await pane.waitFor('3/5 open');
      await pane.waitFor('su-e2e · claimed');
      // auto-unblock: t2 now renders its in_progress activeForm, with no block ref
      await pane.waitFor('Verifying blocker clears');
      // …and the stale typed block ref is no longer anywhere on the screen.
      expect(pane.contains('blocked on WI-9001')).toBe(false);

      // ── Task op: x = check (selected task index 0 → t1) ─────────────────
      operator.mutationProjection = makeProjection({
        sourceKind: 'agent_chat',
        sessionId: CHAT_ID,
        tier: 'owned-loop',
        taskWrite: true,
        burnDown: '3/5 open',
        claim: { value: 'su-e2e · claimed', state: 'live' },
        tasks: [{ ...tasksB[0], status: 'completed' }, tasksB[1], tasksB[2], tasksB[3]],
      });
      pane.write('x');
      await pane.waitFor('Wire the cockpit E2E'); // completed renders content form ("Wiring…" → "Wire…")
      expect(operator.taskOps.at(-1)).toMatchObject({
        path: `/api/harness/${HARNESS}/agent-chats/${CHAT_ID}/tasks`,
        body: { action: 'check', taskId: 't1' },
      });

      // ── Task op: d = drop (nav j j → t3) ────────────────────────────────
      operator.mutationProjection = makeProjection({
        sourceKind: 'agent_chat',
        sessionId: CHAT_ID,
        tier: 'owned-loop',
        taskWrite: true,
        burnDown: '3/5 open',
        claim: { value: 'su-e2e · claimed', state: 'live' },
        tasks: [{ ...tasksB[0], status: 'completed' }, tasksB[1], { ...tasksB[2], status: 'dropped' }, tasksB[3]],
      });
      pane.write('jj');
      await sleep(200);
      pane.write('d');
      const dropDeadline = Date.now() + 15_000;
      while (Date.now() < dropDeadline && operator.taskOps.at(-1)?.body.action !== 'drop') {
        await sleep(60);
      }
      expect(operator.taskOps.at(-1)).toMatchObject({ body: { action: 'drop', taskId: 't3' } });

      // ── Task op: Shift-P = promote (nav j → t4); response carries the for-edge ──
      operator.mutationProjection = makeProjection({
        sourceKind: 'agent_chat',
        sessionId: CHAT_ID,
        tier: 'owned-loop',
        taskWrite: true,
        burnDown: '3/5 open',
        claim: { value: 'su-e2e · claimed', state: 'live' },
        tasks: [
          { ...tasksB[0], status: 'completed' },
          tasksB[1],
          { ...tasksB[2], status: 'dropped' },
          {
            ...tasksB[3],
            status: 'blocked',
            blockerRef: 'WI-7777',
            links: [{ workItemId: 'WI-7777', workItemHarness: HARNESS, relation: 'for' }],
          },
        ],
      });
      pane.write('j');
      await sleep(200);
      pane.write('P');
      await pane.waitFor('blocked on WI-7777');
      await pane.waitFor('evidence WI-7777 (for)');
      const promoteOp = operator.taskOps.at(-1)!;
      expect(promoteOp).toMatchObject({ body: { action: 'promote', taskId: 't4' } });
      // The canonical projection the operator returned for the promote carries
      // the created work-item's `for` edge; the pane applied that projection
      // (the WI-7777 block ref just asserted comes from it).
      const promoted = (operator.mutationProjection as { frames: Array<Record<string, unknown>> }).frames.find(
        (f) => f.kind === 'task' && (f as { taskId?: string }).taskId === 't4',
      ) as { links: Array<{ workItemId: string; relation: string }> };
      expect(promoted.links).toEqual([{ workItemId: 'WI-7777', workItemHarness: HARNESS, relation: 'for' }]);

      // ── Task op: u = clear blocker (still on t4) ────────────────────────
      operator.mutationProjection = makeProjection({
        sourceKind: 'agent_chat',
        sessionId: CHAT_ID,
        tier: 'owned-loop',
        taskWrite: true,
        burnDown: '3/5 open',
        claim: { value: 'su-e2e · claimed', state: 'live' },
        tasks: [
          { ...tasksB[0], status: 'completed' },
          tasksB[1],
          { ...tasksB[2], status: 'dropped' },
          {
            ...tasksB[3],
            status: 'in_progress',
            activeForm: 'Unblocked and rolling',
            blockerRef: null,
            links: [{ workItemId: 'WI-7777', workItemHarness: HARNESS, relation: 'for' }],
          },
        ],
      });
      pane.write('u');
      await pane.waitFor('Unblocked and rolling');
      expect(operator.taskOps.at(-1)).toMatchObject({ body: { action: 'clear_blocker', taskId: 't4' } });
    } finally {
      pane.kill();
    }
  }, 180_000);

  test('PUI-TASK owner journey: edit retry, agent update, add/status/block/reopen/reorder/drop persist across reload and session scope', async () => {
    operator.taskOps = [];
    operator.taskOpFailures = [];
    const secondChat = 'chat-e2e-second';
    const base = (tasks: TaskFixture[], sessionId = CHAT_ID) =>
      makeProjection({
        sourceKind: 'agent_chat',
        sessionId,
        tier: 'owned-loop',
        taskWrite: true,
        burnDown: `${tasks.filter((task) => !['completed', 'dropped'].includes(task.status)).length}/${tasks.length} open`,
        claim: { value: 'su-e2e · claimed', state: 'live' },
        tasks,
      });
    const t1 = {
      id: 'owner-1',
      content: 'Owner task',
      activeForm: 'Working owner task',
      status: 'pending',
      updatedAt: 'revision-1',
    };
    const t2 = {
      id: 'owner-2',
      content: 'Second task',
      activeForm: 'Working second task',
      status: 'pending',
      updatedAt: 'revision-1',
    };
    let tasks: TaskFixture[] = [t1, t2];
    operator.projections.set(CHAT_ID, base(tasks));

    const pane = new PuiPane(bin, ['context-pane', 'agent_chat', CHAT_ID, HARNESS], paneEnv(operator.port, tempHome));
    try {
      await pane.waitFor('Owner task', { timeoutMs: 30_000 });
      await pane.waitFor('a/e add/edit');

      // Conflict: the editor retains the exact owner draft and the same revision
      // token is sent again on retry. Nothing is optimistically changed locally.
      pane.write('e');
      await pane.waitFor('Edit task > Owner task');
      pane.write('\x15');
      pane.write('Owner revised task');
      operator.taskOpFailures.push({
        status: 409,
        code: 'task_revision_conflict',
        message: 'agent updated the task first',
      });
      const conflictStart = operator.taskOps.length;
      pane.write('\r');
      const conflict = await operator.waitForTaskAction('edit', conflictStart);
      expect(conflict.body).toMatchObject({
        taskId: 'owner-1',
        content: 'Owner revised task',
        expectedUpdatedAt: 'revision-1',
      });
      await pane.waitFor('Owner revised task');
      await pane.waitFor('context task:');

      tasks = [{ ...t1, content: 'Owner revised task', activeForm: 'Working owner revised task', updatedAt: 'revision-2' }, t2];
      operator.mutationProjection = base(tasks);
      const retryStart = operator.taskOps.length;
      pane.write('\r');
      await operator.waitForTaskAction('edit', retryStart);
      await pane.waitForAbsent('Edit task >');
      await pane.waitFor('Owner revised task');

      // A model-side update arrives through the same projection and preserves
      // the owner-authored id; the next owner mutation targets that exact id.
      tasks = [{ ...tasks[0], status: 'in_progress', activeForm: 'Agent updating owner revised task', updatedAt: 'revision-3' }, t2];
      operator.projections.set(CHAT_ID, base(tasks));
      pane.write('g');
      await pane.waitFor('Agent updating owner revised task');

      // Network refusal exercises the same retained-draft retry path separately
      // from the revision conflict above.
      pane.write('e');
      pane.write('\x15');
      pane.write('Owner final task text');
      operator.taskOpFailures.push({ status: 503, code: 'unavailable', message: 'network refusal' });
      const refusalStart = operator.taskOps.length;
      pane.write('\r');
      await operator.waitForTaskAction('edit', refusalStart);
      await pane.waitFor('Owner final task text');
      tasks = [{ ...tasks[0], content: 'Owner final task text', activeForm: 'Working owner final task text', status: 'pending', updatedAt: 'revision-4' }, t2];
      operator.mutationProjection = base(tasks);
      const networkRetryStart = operator.taskOps.length;
      pane.write('\r');
      await operator.waitForTaskAction('edit', networkRetryStart);
      await pane.waitForAbsent('Edit task >');
      await pane.waitFor('Owner final task text');

      // Status → block → unblock → complete → reopen all address owner-1.
      tasks = [{ ...tasks[0], status: 'in_progress', explanation: 'Started by owner', updatedAt: 'revision-5' }, t2];
      operator.mutationProjection = base(tasks);
      let start = operator.taskOps.length;
      pane.write('s');
      expect((await operator.waitForTaskAction('start', start)).body.taskId).toBe('owner-1');
      await pane.waitFor('Started by owner');

      pane.write('b');
      await pane.waitFor('Block task on >');
      pane.write('waiting for owner review');
      tasks = [{ ...tasks[0], status: 'blocked', blockerRef: 'waiting for owner review', updatedAt: 'revision-6' }, t2];
      operator.mutationProjection = base(tasks);
      start = operator.taskOps.length;
      pane.write('\r');
      expect(await operator.waitForTaskAction('block', start)).toMatchObject({
        body: { taskId: 'owner-1', blockerRef: 'waiting for owner review' },
      });
      await pane.waitFor('blocked on waiting for owner review');

      tasks = [{ ...tasks[0], status: 'pending', blockerRef: null, explanation: 'Unblocked by owner', updatedAt: 'revision-7' }, t2];
      operator.mutationProjection = base(tasks);
      start = operator.taskOps.length;
      pane.write('u');
      await operator.waitForTaskAction('clear_blocker', start);
      await pane.waitFor('Unblocked by owner');

      tasks = [{ ...tasks[0], status: 'completed', explanation: 'Completed by owner', updatedAt: 'revision-8' }, t2];
      operator.mutationProjection = base(tasks);
      start = operator.taskOps.length;
      pane.write('x');
      await operator.waitForTaskAction('check', start);
      await pane.waitFor('Completed by owner');

      tasks = [{ ...tasks[0], status: 'pending', explanation: 'Reopened by owner', updatedAt: 'revision-9' }, t2];
      operator.mutationProjection = base(tasks);
      start = operator.taskOps.length;
      pane.write('r');
      await operator.waitForTaskAction('reopen', start);
      await pane.waitFor('Reopened by owner');

      // Reorder owner-1 below owner-2, then add and drop using the resulting
      // selected canonical row. The final projection is retained for reload.
      tasks = [{ ...t2 }, { ...tasks[0], explanation: 'Moved by owner' }];
      operator.mutationProjection = base(tasks);
      start = operator.taskOps.length;
      pane.write('J');
      await operator.waitForTaskAction('move_down', start);
      await pane.waitFor('Moved by owner');

      pane.write('a');
      pane.write('Added entirely in PUI');
      tasks = [...tasks, {
        id: 'owner-3',
        content: 'Added entirely in PUI',
        activeForm: 'Added entirely in PUI',
        status: 'pending',
        updatedAt: 'revision-10',
      }];
      operator.mutationProjection = base(tasks);
      start = operator.taskOps.length;
      pane.write('\r');
      const added = await operator.waitForTaskAction('add', start);
      expect(added.body).toMatchObject({ content: 'Added entirely in PUI' });
      await pane.waitFor('Tasks (3)');

      tasks = [{ ...tasks[0], status: 'dropped', updatedAt: 'revision-11' }, tasks[1], tasks[2]];
      operator.mutationProjection = base(tasks);
      start = operator.taskOps.length;
      pane.write('d');
      await operator.waitForTaskAction('drop', start);
      operator.projections.set(CHAT_ID, base(tasks));
      pane.write('g');
      await pane.waitFor('Tasks (3)');
      expect(pane.screen().indexOf('Second task')).toBeLessThan(pane.screen().indexOf('Owner final task text'));
    } finally {
      pane.kill();
    }

    // A fresh process reloads the same ordered identities, while a different
    // exact session id sees only its own canonical task list.
    const reloaded = new PuiPane(bin, ['context-pane', 'agent_chat', CHAT_ID, HARNESS], paneEnv(operator.port, tempHome));
    try {
      await reloaded.waitFor('Added entirely in PUI', { timeoutMs: 30_000 });
      expect(reloaded.screen().indexOf('Second task')).toBeLessThan(reloaded.screen().indexOf('Owner final task text'));
    } finally {
      reloaded.kill();
    }

    operator.projections.set(secondChat, base([{
      id: 'other-1',
      content: 'Second session only',
      activeForm: 'Working second session only',
      status: 'pending',
      updatedAt: 'other-revision-1',
    }], secondChat));
    const switched = new PuiPane(bin, ['context-pane', 'agent_chat', secondChat, HARNESS], paneEnv(operator.port, tempHome));
    try {
      await switched.waitFor('Second session only', { timeoutMs: 30_000 });
      expect(switched.contains('Owner final task text')).toBe(false);
    } finally {
      switched.kill();
    }
    // Printed under the release tag on purpose: the release check must refuse
    // it because this suite's operator is a fixture (the R-12 negative control).
    console.info('PUI_TASK_ACCEPTANCE', JSON.stringify({ binary: bin, chatId: CHAT_ID, secondChat }));
  }, 240_000);

  test('codex target is read-only: degraded footer, and task keys emit no wire ops', async () => {
    operator.queries = [];
    operator.taskOps = [];
    const SESSION = 'rollout-x';

    const pane = new PuiPane(bin, ['context-pane', 'codex', SESSION, HARNESS], paneEnv(operator.port, tempHome));
    try {
      await pane.waitFor('does not expose Context', { timeoutMs: 30_000 });

      operator.projections.set(
        SESSION,
        makeProjection({
          sourceKind: 'codex',
          sessionId: SESSION,
          tier: 'shared-projection',
          taskWrite: false,
          burnDown: '1/2 open',
          claim: { value: 'foreign session', state: 'parked' },
          tasks: [
            { id: 'c1', content: 'Codex-side task', activeForm: 'Codex-side task running', status: 'in_progress' },
          ],
        }),
      );
      pane.write('g');
      await pane.waitFor('Context · shared-projection');
      await pane.waitFor('tasks read-only');
      await pane.waitFor('unavailable sections stay absent');
      await pane.waitFor('Codex-side task running');

      // The typed target rode the query.
      const projQueries = operator.queries.filter((q) => q.name === 'conversations.contextProjection');
      expect(projQueries.at(-1)!.args).toMatchObject({ sourceKind: 'codex', sessionId: SESSION });

      // Task keys on a read-only (non-agent_chat) target emit NO mutations.
      const opsBefore = operator.taskOps.length;
      pane.write('x');
      pane.write('d');
      pane.write('P');
      pane.write('u');
      await sleep(700);
      expect(operator.taskOps.length).toBe(opsBefore);
    } finally {
      pane.kill();
    }
  }, 120_000);

  test('HUD cockpit: semantic cards, actionable frontier, lifecycle oracle, launcher door, ended sessions, leader tape and critical path', async () => {
    operator.queries = [];
    operator.taskOps = [];
    operator.requests = [];
    operator.jsonRoutes.clear();
    operator.runToolResponses.clear();
    configureHudCockpitFixture(operator);

    const pane = new PuiPane(bin, ['hud'], paneEnv(operator.port, tempHome));
    try {
      // Persisted cross-model tool aliases must reach the semantic registry in
      // the real HUD transcript, not fall back to the raw MCP identifier.
      pane.write('1');
      await pane.waitFor('Completing work item', { timeoutMs: 40_000 });
      expect(pane.contains('mcp__papercusp-su__work_items_complete')).toBe(false);

      // Plans owns both dependency truth and the one fleet-launch seam.
      pane.write('3');
      await pane.waitFor('HUD cockpit installed-binary gate');
      pane.write('K');
      await pane.waitFor('Critical path');
      await pane.waitFor('P-HUD-ROOT [wip]');
      await pane.waitFor('P-HUD-NEXT [todo]');
      await pane.waitFor('critical');
      pane.write('K');

      pane.write('L');
      await pane.waitFor('Fleet launcher');
      await pane.waitFor('preview proposed 1');
      await pane.waitFor('y CONFIRM LAUNCH');
      pane.write('y');
      const launch = await operator.waitForTool('fleet:launch-on-plan');
      expect(launch.body).toMatchObject({
        name: 'fleet:launch-on-plan',
        confirmed: false,
        args: {
          name: 'pui-hud-cockpit-e2e',
          plan: 'hud-cockpit-e2e',
          harness: HUD_HARNESS,
          count: 1,
          agent: 'codex',
          account: 'default',
          carry: 'warm',
          headless: false,
        },
      });
      pane.write('L');

      // The fleet surface is driven by burn_down (not a hand-built queue),
      // and sessionState=ended wins even when heartbeatFresh=true.
      pane.write('4');
      await pane.waitFor('Agents (2)');
      // The leader cockpit is an explicitly selected-leader view. Enter the
      // roster, move off and back onto the leader row, and let the selection
      // publish before asserting the leader brief replaces WORK FRONTIER.
      pane.write('\r');
      pane.write('j');
      pane.write('k');
      await pane.waitFor('leader members');
      await pane.waitFor('hud-fleet');
      await pane.waitFor('Finished the prior lane');
      // Assert on the ended ROW, not the screen: the legend alone contains
      // "ended", and it truncates once the leader cockpit takes the right column.
      // ○ is the draining/suspect/ended glyph — never the live ●.
      const endedRow = pane.screen().split('\n').find((line) => line.includes('Finished the prior lane'));
      expect(endedRow).toMatch(/○ codex\s+Finished the prior lane/);

      // The leader cockpit intentionally owns the right column while its
      // brief is available. A failed refresh must fall back to the canonical
      // whole-fleet frontier instead of leaving that work surface unreachable.
      // Clear the explicit leader selection before exercising the whole-fleet
      // fallback leg.
      pane.write('\x1b');
      await sleep(100);
      pane.write('\x1b');
      await sleep(100);
      operator.runToolResponses.set('fleet:leader-brief', 'invalid');
      pane.write('3');
      await pane.waitFor('HUD cockpit installed-binary gate');
      pane.write('4');
      await pane.waitFor('Agents (2)');
      pane.write('l');
      await pane.waitFor('WORK FRONTIER');
      await pane.waitFor('READY NOW');
      await pane.waitFor('WI-HUD-READY');

      // Curated → Mirror → Tape. The lossless ledger must retain the semantic
      // item-completed transition rather than collapsing it into roster state.
      pane.write('\t\t');
      await pane.waitFor('Transition tape');
      // The tape renders the transition through the semantic registry, so the
      // item-completed kind appears as its label on the WI-HUD-DONE row.
      await pane.waitFor('WI-HUD-DONE');
      const completedRow = pane.screen().split('\n').find((line) => line.includes('WI-HUD-DONE'));
      expect(completedRow).toMatch(/Item completed\s+WI-HUD-DONE/);

      // Both the durable Sessions destination and Ctrl-S switcher keep ended
      // sessions browseable/resumable. The fixture's fresh heartbeat is a
      // positive control that the lifecycle verdict, not heartbeat age, wins.
      pane.write('s');
      await pane.waitFor('Ended Fresh');
      await pane.waitFor('ended');
      pane.write('\x13');
      await pane.waitFor('fuzzy live + parked + ended + recorded');
      await pane.waitFor('Ended Fresh');

      expect(operator.requests.some((request) => request.path === '/api/adv/roster')).toBe(true);
      expect(
        operator.requests.some(
          (request) =>
            request.body?.name === 'work_items:burn_down' &&
            (request.body.args as Record<string, unknown> | undefined)?.harness === HUD_HARNESS,
        ),
      ).toBe(true);
    } finally {
      pane.kill();
    }
  }, 300_000);
});

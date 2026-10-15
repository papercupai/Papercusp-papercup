/**
 * P-014 / P-015 (plan blueprint-backed-work-item-execution-2026-09-23, BAR R-12)
 * — DEPLOYED-PLANE smoke for blueprint operations.
 *
 * R-12 requires deployed evidence: the documented examples must work against a
 * running platform build, not only against an in-process fixture. The docs suite
 * (operation-docs-examples.integration.test.ts) proves the page against the
 * current source on a fresh PostgreSQL, and settles its direct work item with a
 * simulated durable write. This suite proves the same page against a real
 * operator, over the real authenticated transports, with nothing simulated:
 *
 *   • /api/health names the build under test (optionally pinned by sha);
 *   • every documented HTTP route is served (a validation refusal, never a 404);
 *   • a neutral harness is created through the public `harness:create` door
 *     with the DOCUMENTED declaration (plus the documented plan-target
 *     operation), inside a dedicated local pot (`pot:create` + `pot:add-member`),
 *     because plans are Hive-scoped and the plan-target template must live in
 *     the harness's Hive; then:
 *       – agent op: submit → replay → conflict → status → pending result →
 *         signal (+ replay) → events → cancel (a request: effected false) →
 *         a non-worker drop is refused by the applied-worker guard → cancel
 *         replay still not effected, result still pending (D-046);
 *       – program op: submit → terminal `ready` whose output validates against
 *         the declared resultSchema (the real program settlement shape);
 *       – program op cancelled before launch: the program executor settles it
 *         terminal `cancelled` and the cancel replay reports it effected;
 *       – plan-target op: submit → a plan run instance → cancel request
 *         reflected (D-045: a plan run has no cancellation fence).
 *
 * The plan-target template is PROVISIONED, not created here (D-044 on the plan
 * above). A template is an ordinary post-epoch plan, so an operation can fire it
 * only once it carries Requirements BARs, the Design Bar-to-work map and an
 * activation audit (which seeds its BAR set and rubric). An activation audit needs
 * canonical session_turn sources, so this suite cannot run one itself. Provision a
 * new template once through the public doors, as the smoke client:
 * `plans:new { harness: SMOKE_POT, slug: SMOKE_TEMPLATE, content }` with
 * SMOKE_TEMPLATE_CONTENT below, then `plans:audit { phase: 'activation', classRef,
 * sourceRanges, mappings, itemProvenance }`. A new template needs a new
 * SMOKE_HARNESS too, because a reused harness keeps the pin it was created with.
 *
 * Opt-in: it runs only when P015_DEPLOYED_OPERATOR_URL is set (for example
 * http://127.0.0.1:3070), so the gate never reaches a live host. Evidence from
 * it is bound with details.evidencePlane:'deployed' only for a run against the
 * shipped build (P015_EXPECTED_SHA pins that).
 *
 * Auth: the bearer must be the token in the TARGET host's home. A shell with a
 * workspace-scoped PAPERCUSP_HOME reads a different token by default; pass
 * P015_SMOKE_TOKEN_FILE=~/.papercusp/superuser-token (or unset PAPERCUSP_HOME).
 *
 * The run writes real state to the target workspace: one local pot and one
 * harness (both reused on later runs), one work item per agent/program
 * submission, and one plan run.
 * The agent op is cancelled within seconds of admission.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BLUEPRINT_OPERATION_TOOLS,
  BlueprintOperationCancelReceiptSchema,
  BlueprintOperationEventsPageSchema,
  BlueprintOperationInputReceiptSchema,
  BlueprintOperationResultSchema,
  BlueprintOperationStatusSchema,
  SubmitResultSchema,
} from './operation-contract';
import { P013B_OPERATION } from './operation-performance-b-driver';

const BASE = process.env.P015_DEPLOYED_OPERATOR_URL?.replace(/\/+$/, '');
const EXPECTED_SHA = process.env.P015_EXPECTED_SHA?.trim() || null;
const WORKSPACE = process.env.P015_SMOKE_WORKSPACE?.trim() || 'papercusp-workspace';
interface SmokeClientEnvironment {
  P015_SMOKE_CLIENT?: string;
  PAPERCUSP_SID?: string;
}

/** This smoke creates a dedicated pot outside the caller's hive; never inherit a scoped agent SID. */
function resolveSmokeClient(env: SmokeClientEnvironment): string {
  return env.P015_SMOKE_CLIENT?.trim() || 'p015-deployed-smoke';
}

const CLIENT = resolveSmokeClient(process.env);
// Paired with SMOKE_TEMPLATE: the harness's blueprint pins the template it was created
// with, so a new template needs a new harness slug (the 2026-09-30 harness pins the
// pre-D-044 template, which can never start).
const SMOKE_HARNESS = process.env.P015_SMOKE_HARNESS?.trim() || 'p015-smoke-operations-2026-10-01';
// Plans are Hive-scoped (resolvePlanScope refuses a harness outside a Hive), so the
// plan-target operation needs its harness inside a Hive. The in-process suites fake
// that scope; only this smoke exercises it, through the public pot doors.
const SMOKE_POT = process.env.P015_SMOKE_POT?.trim() || 'p015-deployed-smoke-pot';
// The harness's blueprint pins this template at create time and the harness is reused,
// so the pin must never move: a FIXED slug that already ends in a date (plans:new
// appends -YYYY-MM-DD to any slug that does not), with fixed content. It must be
// provisioned and activation-audited before the suite runs (see the header, D-044).
const SMOKE_TEMPLATE = process.env.P015_SMOKE_TEMPLATE?.trim() || 'p015-smoke-fork-join-bar-2026-10-01';
/** The provisioned template's body: the P-013 fork/join graph plus one acceptance BAR. */
export const SMOKE_TEMPLATE_CONTENT = `# P-015 deployed smoke fork/join template

## Now
**State:** template, provisioned once for the R-12 deployed smoke (D-044).
**Next:** run through the documented plan-target blueprint operation.

## Background

The R-12 deployed smoke submits the documented plan-target operation against a deployed operator.
Under D-044 a plan-target template is an ordinary post-epoch plan, so it must carry acceptance BARs
and pass an activation audit before an operation can fire it. This template is that fixture: the
P-013 fork/join item graph (two forks and a join) with one BAR.

## Requirements

**R-1 — Fork/join run settles.**
\`\`\`requirement
{"intent":{"request":"A run of this template promotes two fork items and a join that is blocked by both, and settles once the join publishes its output."},"acceptance":{"condition":"Each run instance promotes P-001 and P-002 as claimable, holds P-003 until both forks complete, and settles after P-003 publishes the declared value output.","falsifier":"A run promotes the join before both forks complete, settles without the join's published output, or promotes items other than the three declared.","evidencePlane":"tree","requiredTestLayers":["integration"],"role":"outcome","mandatory":true},"verification":{"method":"Submit the plan-target operation against this template and inspect the instance's promoted items, blocker edges and the run's settlement.","check":{"kind":"requirements"}}}
\`\`\`

## Design

### Bar-to-work map for this plan

| bar | implementing plan items | evidence plane |
|---|---|---|
| R-1 | P-001, P-002, P-003 | tree |

## Phase 1

- **P-001** \`todo\` fork left
- **P-002** \`todo\` fork right
- **P-003** \`todo\` join blocked-by: P-001, P-002
`;
const SMOKE_PARENT = process.env.P015_SMOKE_PARENT_DIR?.trim() || join(homedir(), '.papercusp', 'smoke-harnesses');
const PROGRAM_SETTLE_MS = Number(process.env.P015_PROGRAM_SETTLE_MS ?? 180_000);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const DOC_PATH = process.env.P015_DOC_PATH
  ?? join(REPO_ROOT, 'apps/operator-docs/src/content/docs/harness/blueprint-operations.mdx');

/** The page's `runnable=<id>` JSON fences — the same extraction the docs suite uses. */
function runnable<T = Record<string, unknown>>(id: string): T {
  const page = readFileSync(DOC_PATH, 'utf8');
  const re = /^```(\w*)([^\n]*)\n([\s\S]*?)^```\s*$/gm;
  for (let m = re.exec(page); m; m = re.exec(page)) {
    if (/(?:^|\s)runnable=([\w-]+)/.exec(m[2])?.[1] === id) return JSON.parse(m[3]) as T;
  }
  throw new Error(`runnable fence ${id} missing from ${DOC_PATH}`);
}

class ToolRefusal extends Error {
  constructor(readonly tool: string, readonly body: unknown) {
    super(`${tool} refused: ${typeof body === 'string' ? body : JSON.stringify(body)}`.slice(0, 2000));
  }
}

/** Decode one streamable-HTTP MCP response (JSON body or SSE frames). */
function decodeMcp(raw: string, id: number): unknown {
  const frames = raw.trimStart().startsWith('{')
    ? [raw.trim()]
    : raw.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
  for (const frame of frames) {
    let d: { id?: number; error?: unknown; result?: Record<string, unknown> };
    try { d = JSON.parse(frame); } catch { continue; }
    if (d.id !== id) continue;
    if (d.error) throw new ToolRefusal('jsonrpc', d.error);
    const result = d.result ?? {};
    if (result.isError === true) throw new ToolRefusal('tool', result.content ?? result);
    const texts = Array.isArray(result.content)
      ? (result.content as Array<{ type?: string; text?: string }>).filter((c) => c.type === 'text' && typeof c.text === 'string')
      : [];
    for (const t of texts) {
      let parsed: unknown;
      try { parsed = JSON.parse(t.text!); } catch { continue; /* advisory text; keep looking */ }
      // A spill-reference envelope is NOT the tool's result. Returning it would hand
      // every caller's schema an object whose fields all read undefined.
      const env = parsed as { schemaVersion?: unknown; content?: Array<{ kind?: string; uri?: string }> };
      if (env?.schemaVersion === 'papercusp.output-envelope/v1' && env.content?.some((c) => c.kind === 'reference')) {
        throw new Error(`result was spilled behind a reference envelope (${env.content.find((c) => c.kind === 'reference')?.uri}); the call must carry its own _meta.outputGroupId`);
      }
      // A batch-shaped write (work_items:set_state and kin) reports a refusal IN BAND:
      // isError stays false and the transport says ok, but the body reads ok:false with
      // a per-result error. Returning it as a result let a refused executor drop pass
      // as a success (2026-10-01 rehearsal), so an in-band refusal is a refusal here.
      if ((parsed as { ok?: unknown })?.ok === false) throw new ToolRefusal('tool', parsed);
      return parsed;
    }
    if ('structuredContent' in result) return result.structuredContent;
    return texts[0]?.text ?? result;
  }
  throw new Error(`no JSON-RPC response for id ${id} in: ${raw.slice(0, 500)}`);
}

/**
 * The local deployed host accepts the token in the operator user's home.
 * PAPERCUSP_HOME may point at this workspace's separate Papercusp directory,
 * so it must not choose the default token. P015_SMOKE_TOKEN_FILE overrides the
 * local host path for a target with a different home; refusals report the path.
 */
interface SmokeTokenEnvironment {
  P015_SMOKE_TOKEN_FILE?: string;
  PAPERCUSP_HOME?: string;
}

/** The local deployed host validates its own home token, not a workspace-scoped PAPERCUSP_HOME token. */
function resolveSmokeTokenSource(env: SmokeTokenEnvironment, home: string): string {
  return env.P015_SMOKE_TOKEN_FILE?.trim() || join(home, '.papercusp', 'superuser-token');
}

const HOST_HOME = homedir();
const TOKEN_SOURCE = resolveSmokeTokenSource(process.env, HOST_HOME);
function smokeToken(): string | null {
  try {
    const tok = readFileSync(TOKEN_SOURCE, 'utf8').trim();
    return tok.length >= 16 ? tok : null;
  } catch {
    return null;
  }
}

let rpcId = 0;
async function mcp(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const token = smokeToken();
  if (!token) throw new Error(`no superuser token at ${TOKEN_SOURCE} — cannot authenticate to the deployed host`);
  const id = ++rpcId;
  const qs = new URLSearchParams({ superuser: '1', client: CLIENT, workspace: WORKSPACE, format: 'json' });
  const res = await fetch(`${BASE}/api/mcp?${qs}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    // Each smoke call is its own output group. Without an explicit group the
    // result door's compatibility fallback (result-door.ts beginResultDoorAggregate)
    // groups every call that starts within 2 s into ONE per-hop byte budget, and
    // this client fires ~20 calls back to back: past ~14 KB every later result
    // comes back as a spill-reference envelope instead of the tool's JSON.
    body: JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: tool, arguments: args, _meta: { outputGroupId: `p015-smoke:${id}:${randomUUID()}` } },
    }),
  });
  const raw = await res.text();
  try {
    return decodeMcp(raw, id);
  } catch (err) {
    if (err instanceof ToolRefusal) throw new ToolRefusal(tool, err.body);
    const message = (err as Error).message;
    if (message.includes('superuser_invalid_bearer')) {
      throw new Error(
        `${tool}: the deployed host refused the bearer read from ${TOKEN_SOURCE} (superuser_invalid_bearer). ` +
          'The host validates against the token in ITS home; set P015_SMOKE_TOKEN_FILE to that file ' +
          '(e.g. ~/.papercusp/superuser-token) or unset a workspace-scoped PAPERCUSP_HOME.',
      );
    }
    throw new Error(`${tool}: HTTP ${res.status}: ${message}`);
  }
}

async function refusalOf(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (err) { return (err as Error).message; }
  throw new Error('expected a refusal, got a result');
}

const T = BLUEPRINT_OPERATION_TOOLS;
type Handle = Record<string, unknown>;

describe('deployed smoke context defaults', () => {
  it('uses the dedicated smoke client instead of inheriting a hive-scoped agent SID', () => {
    expect(resolveSmokeClient({ PAPERCUSP_SID: 'su-scoped-agent' })).toBe('p015-deployed-smoke');
  });

  it('honors an explicit client override', () => {
    expect(resolveSmokeClient({ P015_SMOKE_CLIENT: '  p015-owner-client  ', PAPERCUSP_SID: 'su-scoped-agent' }))
      .toBe('p015-owner-client');
  });

  it('uses the deployed host home token despite a workspace-scoped PAPERCUSP_HOME', () => {
    expect(resolveSmokeTokenSource({ PAPERCUSP_HOME: '/workspace/.papercusp' }, HOST_HOME))
      .toBe(join(HOST_HOME, '.papercusp', 'superuser-token'));
  });

  it('honors an explicit deployed token file override', () => {
    expect(resolveSmokeTokenSource({ P015_SMOKE_TOKEN_FILE: '  /host/token  ' }, HOST_HOME))
      .toBe('/host/token');
  });
});

async function submit(operationId: string, requestKey: string, input: Record<string, unknown>): Promise<Handle> {
  return SubmitResultSchema.parse(await mcp(T.submit, { harness: SMOKE_HARNESS, operationId, requestKey, input })).handle as Handle;
}
const status = async (handle: Handle) => BlueprintOperationStatusSchema.parse(await mcp(T.status, { handle }));
const result = async (handle: Handle) => BlueprintOperationResultSchema.parse(await mcp(T.result, { handle }));

interface TemplatePin { ref: string; revision: string; contentHash: string }

/**
 * The documented declaration plus the documented plan-target operation, whose template
 * pin is re-pointed at the smoke's own template in the harness's Hive. The documented
 * pin names the P-013 B suite's template, which that suite seeds by SQL under an undated
 * slug no public door can create.
 */
function smokeDeclaration(pin: TemplatePin): Record<string, unknown> {
  const declaration = runnable<{ operations: unknown[] } & Record<string, unknown>>('declaration');
  const planTarget = runnable<{ target: { template: Record<string, unknown> } } & Record<string, unknown>>('plan-target');
  const pinned = { ...planTarget, target: { ...planTarget.target, template: { ...planTarget.target.template, ...pin } } };
  return { ...declaration, id: SMOKE_HARNESS, operations: [...declaration.operations, pinned] };
}

describe.skipIf(!BASE)('blueprint operations on a DEPLOYED operator (R-12 deployed plane)', () => {
  const run = randomUUID().slice(0, 8);

  it('serves the build under test and every documented HTTP route', async () => {
    const health = await (await fetch(`${BASE}/api/health`)).json() as { ok: boolean; sha: string };
    expect(health.ok).toBe(true);
    // Printed so a bound evidence row can name the exact deployed build.
    console.log(`P015_DEPLOYED_SMOKE build sha=${health.sha} url=${BASE}`);
    if (EXPECTED_SHA) expect(EXPECTED_SHA.startsWith(health.sha) || health.sha.startsWith(EXPECTED_SHA)).toBe(true);

    const routes = runnable<Record<string, string>>('tool-routes');
    expect(Object.keys(routes).sort()).toEqual(Object.values(T).sort());
    for (const [name, path] of Object.entries(routes)) {
      const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${smokeToken()}` },
        body: '{}',
      });
      // An empty body must be refused by the tool's own schema; 404/405 means the route is not served.
      expect([404, 405], `${name} → ${path} answered ${res.status}`).not.toContain(res.status);
    }
  });

  it('creates (or reuses) a neutral harness from the documented declaration', async () => {
    // harness:create requires an existing parentDir. The smoke runs on the
    // operator's own host (P015_DEPLOYED_OPERATOR_URL is loopback), so make it here.
    mkdirSync(SMOKE_PARENT, { recursive: true });
    // A dedicated local pot, so the smoke's template and plan runs never land in
    // another Hive's plan store. local-only: no GitHub remote; no wake.
    try {
      await mcp('pot:create', { slug: SMOKE_POT, parentDir: SMOKE_PARENT, repoRemote: 'local-only', knowledgePack: 'none' });
    } catch (err) {
      if (!/slug_exists|slug already exists/i.test((err as Error).message)) throw err;
    }
    // The plan-target template lives in the pot's plan store and must exist, BAR-ready,
    // before the harness whose blueprint pins it. It is provisioned and activation-audited
    // once (header, D-044); creating a bare one here would only be refused at submit with
    // `not-startable: acceptance BAR contract is not ready for start`.
    const got = await mcp('plans:get', { harness: SMOKE_POT, slug: SMOKE_TEMPLATE }).catch((err: Error) => {
      throw new Error(
        `plan-target template ${SMOKE_POT}/${SMOKE_TEMPLATE} is not provisioned (${err.message.slice(0, 200)}). ` +
          'Provision it once with plans:new (SMOKE_TEMPLATE_CONTENT) and plans:audit { phase: "activation" }; see this file\'s header.',
      );
    }) as { results?: Array<{ version?: number; contentHash?: string }> };
    const template = got.results?.[0];
    expect(template?.contentHash, `plans:get ${SMOKE_TEMPLATE} returned no contentHash`).toMatch(/^[0-9a-f]{64}$/);
    const pin: TemplatePin = { ref: SMOKE_TEMPLATE, revision: String(template!.version), contentHash: template!.contentHash! };
    try {
      await mcp('harness:create', {
        slug: SMOKE_HARNESS, parentDir: SMOKE_PARENT, folderName: SMOKE_HARNESS, blueprint: smokeDeclaration(pin), pot: SMOKE_POT,
      });
    } catch (err) {
      // A prior run left the harness in place; anything else is a real failure.
      // Match harness:create's two reuse refusals exactly: a loose /exist/ also
      // swallowed "does not exist" and hid a create that never happened.
      if (!/slug already exists|destination already exists/i.test((err as Error).message)) throw err;
    }
    // Idempotent: joins a harness reused from a run that predates its pot.
    await mcp('pot:add-member', { pot: SMOKE_POT, member: SMOKE_HARNESS });
  }, 120_000);

  it('runs the documented agent operation lifecycle and cancels it', async () => {
    const key = `p015-agent-${run}`;
    const handle = await submit('extract', key, { value: `deployed-${run}` });
    // Same key + same input replays the same handle; a different input conflicts.
    expect(await submit('extract', key, { value: `deployed-${run}` })).toEqual(handle);
    expect(await refusalOf(submit('extract', key, { value: 'other' }))).toMatch(/conflict|request_key|requestKey/i);

    const first = await status(handle);
    expect(['accepted', 'dispatched', 'waiting']).toContain(first.phase);
    expect((await result(handle)).state).toBe('pending');

    const signalArgs = { handle, channel: 'note', payload: { text: 'hi' }, requestKey: `${key}-note` };
    const receipt = BlueprintOperationInputReceiptSchema.parse(await mcp(T.signal, signalArgs));
    expect(receipt.replayed).toBe(false);
    const replay = BlueprintOperationInputReceiptSchema.parse(await mcp(T.signal, signalArgs));
    expect(replay).toMatchObject({ replayed: true, eventId: receipt.eventId });

    const page = BlueprintOperationEventsPageSchema.parse(await mcp(T.events, { handle }));
    expect(page.events.length).toBeGreaterThan(0);

    // Cancellation is a durable REQUEST (D-045): it never drops or fences work, so on an
    // item no executor has settled it is accepted, reflected, and not yet effected.
    const cancelArgs = { handle, requestKey: `${key}-cancel`, reason: 'P-015 deployed smoke: lifecycle proven' };
    const cancel = BlueprintOperationCancelReceiptSchema.parse(await mcp(T.cancel, cancelArgs));
    expect(cancel).toMatchObject({ accepted: true, replayed: false, effected: false });
    expect(await status(handle)).toMatchObject({ cancellationRequested: true });
    expect((await result(handle)).state).toBe('pending');

    // Only the operation's applied worker may settle its pinned item (D-046). This client
    // is not that worker, so the public door refuses its drop and the request stays a
    // request. The harness is a pot MEMBER, so the item is stored under the pot's home
    // slug (WI-10004360): address it there, so the refusal is the worker guard and not a
    // missing row.
    const items = (await status(handle)).items;
    expect(items).toHaveLength(1);
    expect(await refusalOf(mcp('work_items:set_state', {
      id: items[0].id, harness: SMOKE_POT, state: 'dropped', assumptions: 'none',
      completionRef: `P-015 deployed smoke: non-worker drop after cancellation ${cancel.eventId}`,
    }))).toMatch(/accepted operation item requires its applied worker/);

    // The replayed request returns the same event and still reports it not effected.
    const cancelReplay = BlueprintOperationCancelReceiptSchema.parse(await mcp(T.cancel, cancelArgs));
    expect(cancelReplay).toMatchObject({ replayed: true, eventId: cancel.eventId, effected: false });
    expect((await result(handle)).state).toBe('pending');
  }, 180_000);

  it('cancels a program operation before launch and its executor settles it cancelled', async () => {
    // The program executor is the one executor a deployed client can rely on. A cancel
    // sent straight after admission lands before the launch scan picks the root up, so
    // the executor observes it at settlement and drops the root (D-046; the tree twin is
    // coord-program-workflow.replay.integration.test.ts 'turns a pre-launch cancellation
    // into canonical cancelled settlement').
    const key = `p015-program-cancel-${run}`;
    const handle = await submit('extract-program', key, { value: `deployed-cancel-${run}` });
    const cancelArgs = { handle, requestKey: `${key}-cancel`, reason: 'P-015 deployed smoke: program cancellation' };
    const cancel = BlueprintOperationCancelReceiptSchema.parse(await mcp(T.cancel, cancelArgs));
    expect(cancel).toMatchObject({ accepted: true, replayed: false, effected: false });

    const deadline = Date.now() + PROGRAM_SETTLE_MS;
    let settled = await result(handle);
    while (settled.state === 'pending' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2_000));
      settled = await result(handle);
    }
    expect(settled.state, JSON.stringify(settled).slice(0, 1500)).toBe('cancelled');
    expect(settled.status).toMatchObject({ phase: 'terminal', outcome: 'cancelled', cancellationRequested: true });

    // Now canonical state reads cancelled: the replayed request reports it effected.
    const cancelReplay = BlueprintOperationCancelReceiptSchema.parse(await mcp(T.cancel, cancelArgs));
    expect(cancelReplay).toMatchObject({ replayed: true, eventId: cancel.eventId, effected: true });
  }, PROGRAM_SETTLE_MS + 60_000);

  it('settles the documented program operation ready with its declared result shape', async () => {
    const handle = await submit('extract-program', `p015-program-${run}`, { value: `deployed-${run}` });
    const deadline = Date.now() + PROGRAM_SETTLE_MS;
    let settled = await result(handle);
    while (settled.state === 'pending' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2_000));
      settled = await result(handle);
    }
    expect(settled.state, JSON.stringify(settled).slice(0, 1500)).toBe('ready');
    if (settled.state !== 'ready') return;
    // The declared resultSchema: { outcome: string, resolved: boolean }, nothing else.
    expect(settled.output).toEqual({ outcome: expect.any(String), resolved: expect.any(Boolean) });
    expect(Object.keys(settled.output as object).sort()).toEqual(['outcome', 'resolved']);
    expect(settled.status).toMatchObject({ phase: 'terminal', outcome: 'succeeded' });
    expect(settled.evidenceRef).toBeTruthy();
  }, PROGRAM_SETTLE_MS + 60_000);

  it('admits the documented plan-target operation as a plan run and cancels it', async () => {
    const key = `p015-plan-${run}`;
    const handle = await submit(P013B_OPERATION, key, { value: `deployed-${run}` });
    expect(handle).toMatchObject({ target: { kind: 'plan' } });
    const target = handle.target as { runId?: unknown; instanceSlug?: unknown };
    expect(target.runId).toBeTruthy();
    expect(target.instanceSlug).toBeTruthy();
    const current = await status(handle);
    expect(current.planRun).not.toBeNull();
    // A plan run has no cancellation fence (D-045): the request is recorded and
    // reflected, and effected stays false until canonical state reads cancelled.
    const cancel = BlueprintOperationCancelReceiptSchema.parse(
      await mcp(T.cancel, { handle, requestKey: `${key}-cancel`, reason: 'P-015 deployed smoke: plan admission proven' }));
    expect(cancel).toMatchObject({ accepted: true, replayed: false, effected: false });
    expect(await status(handle)).toMatchObject({ cancellationRequested: true });
  }, 120_000);
});

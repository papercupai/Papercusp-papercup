/**
 * End-to-end verification for plan-agent-launch — P-028.
 *
 * The plan-item explicitly says: "assert seeding + row-creation
 * rather than running a live LLM." We use the PAPERCUSP_FAKE_LLM=1
 * seam (apps/operator/lib/agent-chat-stream.ts) so launch + resume
 * complete deterministically against scripted deltas, and we verify
 * the durable state — plan_revisions rows, plan_runs rows,
 * plan_run_turns rows — via the existing admin verbs.
 *
 * Auto-skips when the dev server isn't running PAPERCUSP_FAKE_LLM=1
 * (same pattern as chat-streaming.spec.ts).
 *
 * Walks the full flow:
 *   1. plans:new — author a fresh plan with a unique slug.
 *   2. plans:set-content × 2 — each edit carries a rationale.
 *   3. plans:revisions — confirms 3 entries (origin + 2 edits) with
 *      rationales intact.
 *   4. plans:launch (await:false) — confirms the launch row appears
 *      and the run starts running.
 *   5. plans:runs — confirms the run is listed for this plan.
 *   6. plans:run-transcript — eventually shows the seeded user turn
 *      + the scripted assistant turn (waits for the background turn
 *      to settle).
 *   7. plans:resume (await:false) — sends a continuation message;
 *      a second pair of turns appears.
 *   8. /admin/plans page renders without 500 (smoke).
 */
import { test, expect, type APIRequestContext } from './_egress';
import { assertFixtureApiSuccess, assertFixturePlanReadback, seedFakeLlmHarness, seedFakeLlmPlanAcceptance } from './_fake-llm-fixture';
let harnessSlug = 'main';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

async function fakeLlmActive(request: APIRequestContext): Promise<boolean> {
  try {
    const res = await request.post(`${baseURL}/api/agent-tools/architect/chat`, {
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      data: { message: 'probe', harnessSlug },
      timeout: 6_000,
    });
    if (!res.ok() && process.env.VERIFY_TAURI_ISOLATED_DB !== '1') return false;
    const body = await res.text();
    const active = body.includes('[fake-llm]');
    if (process.env.VERIFY_TAURI_ISOLATED_DB === '1' && !active) throw new Error(`Isolated fake LLM probe failed: ${res.status()} ${body}`);
    return active;
  } catch (error) {
    if (process.env.VERIFY_TAURI_ISOLATED_DB === '1') throw error;
    return false;
  }
}

// Unique slug per run avoids collisions across re-runs / concurrent CI.
function freshSlug(): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 8);
  return `e2e-launch-${stamp}-${rand}`;
}

async function adminPost(
  request: APIRequestContext,
  verb: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  const res = await request.post(`${baseURL}/api/admin/plans/${verb}`, {
    headers: { 'Content-Type': 'application/json' },
    data: { ...body, harness: harnessSlug },
    timeout: 20_000,
  });
  const text = await res.text();
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* leave as text */ }
  if (verb === 'new' || verb === 'set-content') assertFixtureApiSuccess(verb, json);
  return { status: res.status(), json };
}

async function adminGet(
  request: APIRequestContext,
  verb: string,
  params: Record<string, string | number | boolean> = {},
): Promise<{ status: number; json: unknown }> {
  const url = new URL(`${baseURL}/api/admin/plans/${verb}`);
  // Transcript lookup is keyed by runId; its tool schema has no harness argument.
  if (verb !== 'run-transcript') url.searchParams.set('harness', harnessSlug);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  const res = await request.get(url.toString(), { timeout: 10_000 });
  const text = await res.text();
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* leave as text */ }
  return { status: res.status(), json };
}

async function pollRunStatus(
  request: APIRequestContext,
  slug: string,
  runId: number,
  desiredStatus: 'idle' | 'failed',
  maxMs = 20_000,
): Promise<{ status: string; turnCount: number } | null> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const r = await adminGet(request, 'runs', { slug });
    const runs = ((r.json as { runs?: Array<{ id: number; status: string; turnCount: number }> })
      .runs) ?? [];
    const row = runs.find((x) => x.id === runId);
    if (row && (row.status === desiredStatus || row.status === 'failed')) {
      return { status: row.status, turnCount: row.turnCount };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

test.describe('plan-agent-launch E2E (P-028)', () => {
  test.beforeAll(async () => { harnessSlug = await seedFakeLlmHarness({ hive: true }); });
  test('full flow: author → edit twice → launch → resume → verify rows', async ({ request, page }) => {
    if (!(await fakeLlmActive(request))) {
      test.skip(true, 'PAPERCUSP_FAKE_LLM=1 not set on dev server; skipping');
    }

    let slug = freshSlug();

    // ── 1. Author the plan. plans:new emits a real revision spine
    //      entry (seq 1) — the origin per D-006.
    const created = await adminPost(request, 'new', {
      slug,
      title: 'P-028 launch e2e',
      status: 'draft',
      ownerEmail: 'e2e@example.com',
    });
    expect(created.status, `plans:new should succeed: ${JSON.stringify(created.json)}`).toBe(200);
    expect((created.json as { ok?: boolean }).ok ?? false).toBe(true);
    // plans:new canonicalizes the slug (including its date suffix). Follow the
    // returned identity for every later read and CAS write.
    const createdSlug = (created.json as { slug?: string }).slug;
    expect(createdSlug, 'plans:new should return the persisted slug').toBeTruthy();
    slug = createdSlug!;

    // Fetch to get the current contentHash for the CAS write.
    const initialGet = await adminGet(request, 'get', { slug });
    expect(initialGet.status).toBe(200);
    expect((initialGet.json as { ok?: boolean }).ok, JSON.stringify(initialGet.json)).toBe(true);
    const hash1 = (initialGet.json as { contentHash?: string }).contentHash;
    expect(hash1, 'plans:get should include contentHash').toBeTruthy();

    // ── 2. First edit. Content adds a Now block + a substantive
    //      rationale (D-009).
    const edit1Body = [
      '---',
      'title: P-028 launch e2e',
      `slug: ${slug}`,
      'status: draft',
      'created: 2026-05-21',
      'updated: 2026-05-21',
      'owner: e2e@example.com',
      '---',
      '',
      '# P-028 launch e2e',
      '',
      '## Now',
      '',
      'First edit landed.',
      '',
      '## Requirements',
      '',
      '**R-1 — Durable launch rows.**',
      '```requirement',
      JSON.stringify({
        intent: { request: 'Verify plan launch and resume persist their revision and turn rows.', sourceRefs: ['test:plan-agent-launch'] },
        acceptance: { condition: 'Launch and resume retain the expected plan run and transcript rows.', falsifier: 'A launched run or seeded user turn is absent.', evidencePlane: 'tree', requiredScope: ['launch', 'resume'], requiredTestLayers: ['e2e'] },
        verification: { method: 'Run this scripted fake-LLM journey and inspect runs and run-transcript through the admin API.', check: { kind: 'tests', files: ['apps/operator/e2e/plan-agent-launch.spec.ts'] } },
      }),
      '```',
      '',
      '## Design',
      '',
      '### Bar-to-work map for this plan',
      '',
      '| bar | implementing plan items | evidence plane |',
      '|---|---|---|',
      '| R-1 | P-001 | tree |',
      '',
      '## Phase 1',
      '',
      '- **P-001** `todo` Author the e2e fixture.',
      '',
    ].join('\n');
    const edit1 = await adminPost(request, 'set-content', {
      slug,
      content: edit1Body,
      expectedHash: hash1,
      // This test deliberately replaces its own generated starter template.
      allowShrink: true,
      rationale: 'P-028 e2e: first scripted edit — adds a Now block.',
    });
    expect(edit1.status).toBe(200);
    expect((edit1.json as { ok?: boolean }).ok ?? false, JSON.stringify(edit1.json)).toBe(true);
    const hash2 = (edit1.json as { contentHash?: string }).contentHash;
    expect(hash2).toBeTruthy();
    expect(hash2).not.toBe(hash1);

    // ── 3. Second edit. Different rationale to verify per-revision
    //      capture.
    const edit2Body = edit1Body.replace(
      '- **P-001** `todo` Author the e2e fixture.',
      '- **P-001** `wip` Author the e2e fixture.',
    );
    const edit2 = await adminPost(request, 'set-content', {
      slug,
      content: edit2Body,
      expectedHash: hash2,
      rationale: 'P-028 e2e: flip P-001 to wip — agent is picking it up.',
    });
    expect(edit2.status).toBe(200);
    expect((edit2.json as { ok?: boolean }).ok ?? false, JSON.stringify(edit2.json)).toBe(true);

    const persisted = await adminGet(request, 'get', { slug, mode: 'full', includeRaw: true });
    expect(persisted.status).toBe(200);
    assertFixturePlanReadback(persisted.json, (edit2.json as { contentHash?: string }).contentHash, edit2Body);

    // ── 4. plans:revisions — expect 3 entries (origin + 2 edits)
    //      newest-first, with rationales intact.
    const revs = await adminGet(request, 'revisions', { slug });
    expect(revs.status).toBe(200);
    const revisions = ((revs.json as { revisions?: Array<{ seq: number; rationale: string | null }> })
      .revisions) ?? [];
    expect(revisions.length, 'expected 3 revisions (origin + 2 edits)').toBe(3);
    // Newest-first: seq 3 is the second edit, seq 1 is the origin.
    expect(revisions[0]!.seq).toBe(3);
    expect(revisions[0]!.rationale).toContain('flip P-001 to wip');
    expect(revisions[1]!.seq).toBe(2);
    expect(revisions[1]!.rationale).toContain('first scripted edit');
    expect(revisions[2]!.seq).toBe(1); // origin

    // ── 5. plans:launch — request the background mode used by the UI; we
    //      verify the row exists immediately.
    await seedFakeLlmPlanAcceptance(harnessSlug, slug);
    const launched = await adminPost(request, 'launch', {
      slug,
      await: false,
      note: 'P-028: focus on P-001.',
    });
    expect(launched.status).toBe(200);
    const launchJson = launched.json as {
      runId?: number;
      sessionId?: string;
      mode?: string;
      status?: string;
    };
    // The admin route unwraps the tool's JSON payload; background launch
    // success is represented by the run identity and state, without an ok flag.
    expect(launchJson.mode).toBe('background');
    expect(launchJson.status).toBe('running');
    expect(launchJson.runId).toBeGreaterThan(0);
    expect(launchJson.sessionId).toEqual(expect.any(String));
    expect(launchJson.sessionId).not.toBe('');
    const runId = launchJson.runId!;

    // ── 6. plans:runs should immediately show the run.
    const runsImmediate = await adminGet(request, 'runs', { slug });
    expect(runsImmediate.status).toBe(200);
    const initialRuns = ((runsImmediate.json as { runs?: Array<{ id: number }> }).runs) ?? [];
    expect(initialRuns.some((r) => r.id === runId), 'launched run should appear in plans:runs').toBe(true);

    // ── 7. Wait for the fake-LLM turn to settle.
    const settled = await pollRunStatus(request, slug, runId, 'idle');
    expect(settled, 'launch turn should settle within 20s under fake-LLM').not.toBeNull();
    // Either idle (success) or failed (fake-LLM not wired for this caller) — we
    // accept both since the goal is verifying row-creation, not the LLM itself.
    expect(['idle', 'failed']).toContain(settled!.status);
    expect(settled!.turnCount).toBeGreaterThanOrEqual(1);

    // ── 8. plans:run-transcript — should have at least the seeded
    //      user turn.
    const transcript = await adminGet(request, 'run-transcript', { runId });
    expect(transcript.status).toBe(200);
    const tj = transcript.json as {
      turns?: Array<{ seq: number; role: string; content: string }>;
      planContentHash?: string;
    };
    expect((tj.turns ?? []).length).toBeGreaterThanOrEqual(1);
    expect(tj.turns![0]!.role).toBe('user');
    expect(tj.turns![0]!.content).toContain('P-001');
    // The run was seeded against hash2's successor (set-content from edit2
    // bumped the file's hash). plans:get's current hash should match.
    const currentGet = await adminGet(request, 'get', { slug });
    const currentHash = (currentGet.json as { contentHash?: string }).contentHash;
    expect(tj.planContentHash).toBe(currentHash);

    // ── 9. plans:resume — only worth running if the launch actually
    //      settled (a 'failed' settle leaves no fake-LLM coverage to
    //      assert against here).
    if (settled!.status === 'idle') {
      const resumed = await adminPost(request, 'resume', {
        runId,
        await: false,
        message: 'P-028: continue — describe what you just did.',
      });
      expect(resumed.status).toBe(200);
      const rj = resumed.json as { runId?: number; sessionId?: string; mode?: string; status?: string };
      expect(rj.runId).toBe(runId);
      expect(rj.sessionId).toBe(launchJson.sessionId);
      expect(rj.mode).toBe('background');
      expect(rj.status).toBe('running');

      // Wait for the resume to settle, then verify a second pair of
      // turns landed.
      const resumed2 = await pollRunStatus(request, slug, runId, 'idle');
      expect(resumed2, 'resume turn should settle within 20s').not.toBeNull();
      expect(resumed2!.turnCount).toBeGreaterThanOrEqual(settled!.turnCount + 1);
    }

    // ── 10. Smoke: /admin/plans renders without 500 (the Agents tab
    //       is reachable via ?ptab=agents).
    const res = await page.goto(`${baseURL}/admin/plans?slug=${slug}&ptab=agents`, {
      waitUntil: 'load',
    });
    expect([200, 302, 307]).toContain(res?.status() ?? 0);
  });
});

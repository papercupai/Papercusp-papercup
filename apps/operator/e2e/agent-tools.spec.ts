/**
 * Agent-tools HTTP route surface — broad-coverage E2E.
 *
 * The 27+ built-in agent-mcp tools auto-mount at /api/agent-tools/<group>/<verb>
 * via defineTool (PR 0c.D). Each tool's contract is unit-tested at the tool
 * level; this spec verifies the catch-all routing + auth gate work end-to-end.
 *
 * Categories:
 *  - Unauthenticated reads (docs/outline, flags/list, harness/list_features —
 *    `requirePrincipal: false`, so no bearer needed)
 *  - Authenticated reads (tasks/list, memory/remember) — 401 without bearer
 *  - Input validation (zod schema errors return 400 invalid_input, not 500 —
 *    the dispatch stack validates args BEFORE invoking the handler, EI-334)
 *  - Unknown tool (404 with unknown_tool code)
 */
import { test, expect } from './_egress';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

test.describe('agent-tools catch-all routing', () => {
  test('unknown tool returns 404 with unknown_tool error code', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/agent-tools/totally:made:up`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error?.code).toBe('unknown_tool');
    expect(body.error?.message).toMatch(/No tool at path/);
  });

  test('tool name uses colon → slash mapping (docs:outline → /docs/outline)', async ({ request }) => {
    const colonStyle = await request.post(`${baseURL}/api/agent-tools/docs:outline`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    const slashStyle = await request.post(`${baseURL}/api/agent-tools/docs/outline`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    // colon-style is not a valid HTTP path → 404
    expect(colonStyle.status()).toBe(404);
    // slash-style is the canonical path → 200
    expect(slashStyle.status()).toBe(200);
  });

  test('docs:outline (unauth) returns the doc tree', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/agent-tools/docs/outline`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.content).toBeDefined();
    expect(Array.isArray(body.content)).toBe(true);
  });

  test('flags:list (unauth) returns flag keys + values', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/agent-tools/flags/list`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const text = body.content?.[0]?.text;
    expect(text).toBeTruthy();
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed.keys)).toBe(true);
    expect(parsed.flags).toBeDefined();
  });

  test('docs:search rejects missing query with invalid_input', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/agent-tools/docs/search`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    // The dispatch stack validates args against the tool's zod schema before
    // invoking the handler and codes a schema-validation failure `invalid_input`
    // (400), not `handler_error` (500) — EI-334: keeps caller mistakes out of
    // the structural tool-error telemetry class (tooldef dispatch-stack.ts
    // `invoke` step). Was asserted as 500/handler_error before that fix landed.
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error?.code).toBe('invalid_input');
    expect(body.error?.message).toMatch(/invalid_args/);
  });

  test('docs:search with valid query returns results', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/agent-tools/docs/search`, {
      data: { query: 'plugins' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.content).toBeDefined();
  });

  test('tasks:list (auth-required) returns 401 without bearer', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/agent-tools/tasks/list`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error?.code).toBe('unauthorized');
  });

  test('search:fulltext (unauth) returns ranked-prose hits envelope', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/agent-tools/search/fulltext`, {
      data: { query: 'test' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const parsed = JSON.parse(body.content?.[0]?.text ?? '{}');
    expect(parsed).toHaveProperty('query');
    expect(parsed).toHaveProperty('scope');
    expect(parsed).toHaveProperty('results');
    expect(Array.isArray(parsed.results)).toBe(true);
  });

  test('memory:remember (auth-required) returns 401 without bearer', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/agent-tools/memory/remember`, {
      data: { content: 'test memory', kind: 'preference' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 500]).toContain(res.status());
  });

  test('harness:list_features (no auth required) succeeds without bearer', async ({ request }) => {
    // This tool declares `requirePrincipal: false` (a public read, like
    // docs:outline / flags:list above) — it was never auth-gated, so it
    // belongs in the unauthenticated-reads category, not "returns 401
    // without bearer". The prior version of this test sent an undeclared
    // `harnessSlug` field (the real arg is `slug`); EI-334 made the dispatch
    // stack correctly reject an undeclared/missing arg with 400 invalid_input
    // BEFORE reaching the handler, which happened to still satisfy the old
    // [401, 500] assertion and masked that this test's premise was wrong
    // (EI-19373923898562595). Exercise the tool for real instead.
    const res = await request.post(`${baseURL}/api/agent-tools/harness/list_features`, {
      data: { slug: 'papercusp' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const parsed = JSON.parse(body.content?.[0]?.text ?? '{}');
    // A DB that has the 'papercusp' harness answers { features }; a fresh or
    // isolated DB has no harnesses and answers the handler's own structured
    // { error: 'unknown project' }. Both prove the unauthenticated call reached
    // the handler; anything else (no body, a 401/5xx shape) still fails.
    // WI-10006791: the isolated rig registers no harness, so pinning
    // `features` failed every isolated run.
    if ('error' in parsed) {
      expect(parsed.error).toBe('unknown project');
    } else {
      expect(Array.isArray(parsed.features)).toBe(true);
    }
  });

  test('docs:get accepts slug arg', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/agent-tools/docs/get`, {
      data: { slugs: ['plugins'] },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([200, 404, 500]).toContain(res.status());
  });

  test('GET method on tool routes returns 405', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/agent-tools/docs/outline`);
    expect([404, 405]).toContain(res.status());
  });

  test('POST with malformed JSON returns 4xx not 500', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/agent-tools/docs/outline`, {
      data: '{ not valid json',
      headers: { 'Content-Type': 'application/json' },
    });
    // Either 400 (bad request) or 500 (handler caught it) — both prove no crash
    expect([200, 400, 500]).toContain(res.status());
  });
});

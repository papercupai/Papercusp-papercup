/**
 * P-010 admission control (mcp-reliability-hardening-2026-07-11) — pin the
 * load-shed decision: only a POST tools/call is shed, only under CRITICAL loop
 * pressure, bounded diagnostics remain admitted, the body is peeked
 * NON-destructively (the handler still gets it), and the shed response is a
 * retryable 429 the proxy absorbs.
 */
import { afterEach, describe, it, expect } from 'vitest';
import {
  classifyMcpBody,
  classifyMcpRequest,
  shouldShedForPressure,
  shouldShedForCapacity,
  acquireAdmission,
  withMcpAdmission,
  evaluateAdmission,
  admissionShedResponse,
  getMcpAdmissionSnapshot,
  resetMcpAdmissionForTests,
  isBoundedDevTelemetryArgs,
  isBoundedCoordPresenceArgs,
  isBoundedCoordRosterArgs,
  isBoundedCoordInboxArgs,
  isBoundedCoordDeclareIntentArgs,
  isBoundedDocsGetArgs,
  isBoundedDocsSearchArgs,
  isBoundedSearchFulltextArgs,
  isBoundedEventsStatusArgs,
  isBoundedFactsListArgs,
  isBoundedBashOutputArgs,
  isBoundedGitSyncRunArgs,
  isBoundedSessionRequestCompactionArgs,
  isBoundedLogsReadArgs,
  isBoundedNotificationsRecentArgs,
  isBoundedTestingRunsArgs,
  isBoundedLoopArmArgs,
  isBoundedLoopCheckpointArgs,
  isBoundedActivityToolLogArgs,
  isBoundedSessionsTimelineArgs,
  isBoundedBackupSnapshotListArgs,
  isBoundedLocksListArgs,
  isBoundedLocksQueueArgs,
  isBoundedLocksReleaseArgs,
  isBoundedSessionsSearchArgs,
  isBoundedWorkItemsListArgs,
  isBoundedWorkItemsSearchArgs,
  isBoundedWorkItemsCommentArgs,
  isBoundedPlansSearchArgs,
  isBoundedRecipesSearchArgs,
  isBoundedWorkItemsCompleteArgs,
  isBoundedWorkItemsSetStateArgs,
} from './mcp-admission';

afterEach(() => resetMcpAdmissionForTests());

const toolsCall = (id: unknown = 7, name = 'plans:get', args: Record<string, unknown> = {}) =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

function post(body: string): Request {
  return new Request('http://127.0.0.1:3070/api/mcp?superuser=1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

const judgeRequestUrl = 'http://127.0.0.1:3070/api/mcp?superuser=1&role=judge';

describe('judge terminal scorecard admission', () => {
  it('reserves a bounded grading-integrity emit under critical pressure only with the judge routing hint', async () => {
    const body = toolsCall(51, 'scorecards:emit', {
      rubricRef: 'grading-integrity',
      terminal: true,
      subject: { kind: 'scorecard', ref: 'EI-24351558442836441' },
    });
    const judge = new Request(judgeRequestUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(classifyMcpRequest(body, judge.url)).toBe('diagnostic');
    expect(await evaluateAdmission(judge, 'critical', true)).toBeNull();

    const unhinted = post(body);
    expect(classifyMcpRequest(body, unhinted.url)).toBe('ordinary');
    const shed = await evaluateAdmission(unhinted, 'critical', true);
    expect((await shed!.json()).error.data).toMatchObject({ reason: 'loop_pressure_critical' });
  });
});

describe('classifyMcpBody — only a tools/call is sheddable', () => {
  it('flags a tools/call and echoes its id', () => {
    expect(classifyMcpBody(toolsCall(42))).toEqual({ sheddable: true, id: 42 });
    expect(classifyMcpBody(toolsCall('abc'))).toEqual({ sheddable: true, id: 'abc' });
  });
  it('does NOT shed cheap protocol methods', () => {
    for (const method of ['initialize', 'tools/list', 'ping', 'resources/list', 'prompts/list', 'notifications/initialized']) {
      expect(classifyMcpBody(JSON.stringify({ jsonrpc: '2.0', id: 1, method }))).toEqual({ sheddable: false, id: null });
    }
  });
  it.each([
    'dev:service_health',
    'dev:pg_query',
    'dev_pg_query',
    'mcp__papercusp-su__dev_pg_query',
    'mcp__papercusp_su__dev_pg_query',
    'dev:pg_active_queries',
    'dev_pg_active_queries',
    'mcp__papercusp-su__dev_pg_active_queries',
    'mcp__papercusp_su__dev_pg_active_queries',
    // EI-21574538947513211 — the tool used to OBSERVE loop pressure was itself being shed by
    // the pressure gate (94 retryable -32000s, reason loop_pressure_critical, on a bounded
    // 149-index ownLogProbe walk). Listed in every name form the normalizer must collapse,
    // because a client-mangled spelling reaching the gate un-normalized would silently
    // reinstate the shed.
    'dev:dogfood_substrate_status',
    'dev_dogfood_substrate_status',
    'mcp__papercusp-su__dev_dogfood_substrate_status',
  ])('does NOT shed bounded critical-pressure diagnostic %s', (name) => {
    expect(classifyMcpBody(toolsCall(11, name))).toEqual({ sheddable: false, id: null });
  });

  it('keeps similarly named but unreserved pg diagnostics shed under critical pressure', () => {
    for (const name of [
      'dev:pg_hot_queries',
      'dev_pg_hot_queries',
      'mcp__papercusp-su__dev_pg_table_sizes',
      'mcp__papercusp_su__dev_pg_table_sizes',
    ]) {
      const body = toolsCall(12, name);
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 12 });
      expect(classifyMcpRequest(body)).toBe('ordinary');
    }
  });

  it.each([
    ['canonical task id', 'capability:bash_output', { task_id: '0mu01ke7h44mxhxn2ps' }],
    ['canonical bash id', 'capability:bash_output', { bash_id: 'bash-1' }],
    ['underscore alias', 'capability_bash_output', { task_id: 'task-1' }],
    ['mcp-advertised alias', 'mcp__papercusp_su__capability_bash_output', { task_id: 'task-1' }],
  ])('does NOT shed a bounded single-job capability:bash_output status read under critical pressure: %s', (_label, name, args) => {
    expect(isBoundedBashOutputArgs(args)).toBe(true);
    const body = toolsCall(12, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps broad or output-expanding capability:bash_output reads sheddable under critical pressure', () => {
    for (const args of [
      {},
      { task_id: 'task-1', bash_id: 'bash-1' },
      { task_id: 'task-1', filter: 'ERROR' },
      { task_id: 'task-1', peek: true },
      { task_id: 'task-1', tail: 10 },
      { task_id: 'x'.repeat(257) },
    ]) {
      expect(isBoundedBashOutputArgs(args)).toBe(false);
      expect(classifyMcpBody(toolsCall(13, 'capability:bash_output', args))).toEqual({ sheddable: true, id: 13 });
      expect(classifyMcpRequest(toolsCall(13, 'capability:bash_output', args))).toBe('ordinary');
    }
  });

  it('recognizes a bounded capability:bash_output status read through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__capability_bash_output',
          args: { task_id: 'task-1' },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['canonical', 'backup:snapshot_list'],
    ['underscore', 'backup_snapshot_list'],
    ['mcp-advertised hyphen', 'mcp__papercusp-su__backup_snapshot_list'],
    ['mcp-advertised underscore', 'mcp__papercusp_su__backup_snapshot_list'],
  ])('does NOT shed a bounded backup:snapshot_list recovery read under critical pressure: %s', (_label, name) => {
    const args = { limit: 50 };
    expect(isBoundedBackupSnapshotListArgs(args)).toBe(true);
    const body = toolsCall(13, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('admits omitted/default backup:snapshot_list but keeps broad forms sheddable', () => {
    for (const args of [undefined, {}]) {
      expect(isBoundedBackupSnapshotListArgs(args)).toBe(true);
      expect(classifyMcpBody(toolsCall(14, 'backup:snapshot_list', args as Record<string, unknown>))).toEqual({
        sheddable: false,
        id: null,
      });
    }
    const omitted = JSON.stringify({
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: { name: 'backup:snapshot_list' },
    });
    expect(classifyMcpBody(omitted)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(omitted)).toBe('diagnostic');

    for (const args of [{ limit: 0 }, { limit: 51 }, { limit: 500 }, { limit: 50, unexpected: true }, null]) {
      expect(isBoundedBackupSnapshotListArgs(args)).toBe(false);
      expect(classifyMcpBody(toolsCall(16, 'backup:snapshot_list', args as Record<string, unknown>))).toEqual({
        sheddable: true,
        id: 16,
      });
      expect(classifyMcpRequest(toolsCall(16, 'backup:snapshot_list', args as Record<string, unknown>))).toBe('ordinary');
    }
  });

  it('recognizes a bounded backup:snapshot_list through deferred tools:invoke aliases', () => {
    for (const name of ['backup_snapshot_list', 'mcp__papercusp_su__backup_snapshot_list']) {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 17,
        method: 'tools/call',
        params: {
          name: 'tools:invoke',
          arguments: { name, args: { limit: 50 } },
        },
      });
      expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
      expect(classifyMcpRequest(body)).toBe('diagnostic');
    }
  });

  it.each([
    'coord:whoami',
    'coord_whoami',
    'mcp__papercusp-su__coord_whoami',
    'mcp__papercusp_su__coord_whoami',
  ])('does NOT shed no-args coord:whoami under critical pressure: %s', async (name) => {
    const body = toolsCall(14, name, {});
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
    expect(await evaluateAdmission(post(body), 'critical', true)).toBeNull();
  });

  it('admits omitted coord:whoami arguments but keeps non-empty arguments sheddable', () => {
    const omitted = JSON.stringify({
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: { name: 'coord:whoami' },
    });
    expect(classifyMcpBody(omitted)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(omitted)).toBe('diagnostic');

    for (const args of [{ ownerId: 'su-target' }, { unexpected: true }, null]) {
      const body = toolsCall(16, 'coord:whoami', args as Record<string, unknown>);
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 16 });
      expect(classifyMcpRequest(body)).toBe('ordinary');
    }
  });

  it('admits no-args coord:whoami through deferred tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 17,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: { name: 'mcp__papercusp_su__coord_whoami', args: {} },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['bare declaration', { intent: 'resume the current lane' }],
    ['plan lane', { intent: 'claim the plan lane', current_plan_slug: 'recovery-plan', items: ['P-001'] }],
    ['replacement clear', { intent: 'clear stale lane', items: [] }],
    ['harness-scoped lane', { intent: 'claim the plan lane', current_plan_slug: 'recovery-plan', items: ['P-001'], harness: 'papercusp' }],
  ])('does NOT shed bounded coord:declare-intent recovery declarations under critical pressure: %s', (_label, args) => {
    expect(isBoundedCoordDeclareIntentArgs(args)).toBe(true);
    const body = toolsCall(18, 'coord:declare-intent', args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps enriched or invalid coord:declare-intent declarations sheddable under critical pressure', () => {
    for (const args of [
      { intent: 'x', current_files: ['packages/operator-core/lib/example.ts'] },
      { intent: 'x', declared_goal_refs: ['EI-1'] },
      { intent: 'x'.repeat(601) },
      { intent: 'x', items: ['EI-1'] },
      { intent: 'x', current_plan_slug: 'plan', items: ['P-01'] },
      { intent: 'x', current_plan_slug: 'plan', items: Array.from({ length: 41 }, (_, i) => `P-${String(i + 1).padStart(3, '0')}`) },
    ]) {
      expect(isBoundedCoordDeclareIntentArgs(args)).toBe(false);
      expect(classifyMcpBody(toolsCall(19, 'coord:declare-intent', args))).toEqual({ sheddable: true, id: 19 });
      expect(classifyMcpRequest(toolsCall(19, 'coord:declare-intent', args))).toBe('ordinary');
    }
  });

  it('admits bounded coord:declare-intent through deferred tools:invoke and client aliases', () => {
    for (const name of ['coord_declare_intent', 'mcp__papercusp_su__coord_declare_intent']) {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: {
          name: 'tools:invoke',
          arguments: { name, args: { intent: 'resume the current lane' } },
        },
      });
      expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
      expect(classifyMcpRequest(body)).toBe('diagnostic');
    }
  });

  it.each([
    'tools:find',
    'tools_find',
    'mcp__papercusp-su__tools_find',
    'mcp__papercusp_su__tools_find',
  ])('does NOT shed catalog discovery under critical pressure: %s', (name) => {
    const body = toolsCall(11, name, { query: 'grading integrity scorecard tools' });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    'locks:queue',
    'locks_queue',
    'mcp__papercusp-su__locks_queue',
    'mcp__papercusp_su__locks_queue',
  ])('does NOT shed a bounded locks:queue ownership read under critical pressure: %s', (name) => {
    const args = { paths: ['packages/operator-core/lib/release/frozen-repair-edit-ledger.ts'] };
    const body = toolsCall(12, name, args);
    expect(isBoundedLocksQueueArgs(args)).toBe(true);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps broad locks:queue reads sheddable under critical pressure', () => {
    for (const args of [
      {},
      { paths: [] },
      { external_paths: [] },
      { paths: ['packages/operator-core/lib/release/frozen-repair-edit-ledger.ts'], include_completed: true },
      { paths: [''] },
    ]) {
      expect(isBoundedLocksQueueArgs(args)).toBe(false);
      expect(classifyMcpBody(toolsCall(13, 'locks:queue', args))).toEqual({ sheddable: true, id: 13 });
    }
  });

  it.each([
    ['exact resource', { resource: 'release-deploy' }],
    ['bounded browse', { limit: 50 }],
    ['bounded filtered browse', { q: 'git-sync', limit: 50 }],
  ])('does NOT shed a bounded locks:list recovery read under critical pressure: %s', (_label, args) => {
    expect(isBoundedLocksListArgs(args)).toBe(true);
    const body = toolsCall(18, 'locks:list', args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps broad, mixed-selector, and oversized locks:list reads sheddable under critical pressure', () => {
    for (const args of [
      {},
      { q: 'git-sync' },
      { resource: 'release-deploy', q: 'release' },
      { resource: 'release-deploy', limit: 1 },
      { limit: 0 },
      { limit: 51 },
      { limit: 500 },
      { q: '', limit: 50 },
      { limit: 50, unexpected: true },
    ]) {
      expect(isBoundedLocksListArgs(args)).toBe(false);
      const body = toolsCall(19, 'locks:list', args);
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 19 });
      expect(classifyMcpRequest(body)).toBe('ordinary');
    }
  });

  it('recognizes a bounded locks:list through deferred tools:invoke aliases', () => {
    for (const name of ['locks_list', 'mcp__papercusp_su__locks_list']) {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: {
          name: 'tools:invoke',
          arguments: { name, args: { resource: 'release-deploy' } },
        },
      });
      expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
      expect(classifyMcpRequest(body)).toBe('diagnostic');
    }
  });

  it.each([
    'locks:release',
    'locks_release',
    'mcp__papercusp-su__locks_release',
    'mcp__papercusp_su__locks_release',
  ])('does NOT shed a bounded single-lock locks:release under critical pressure: %s', (name) => {
    const args = { lock_id: '551d8e36-bd4f-4eea-9ad8-42ba8a9c98d8' };
    const body = toolsCall(14, name, args);
    expect(isBoundedLocksReleaseArgs(args)).toBe(true);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('recognizes a bounded locks:release through deferred tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__locks_release',
          args: { lock_id: '551d8e36-bd4f-4eea-9ad8-42ba8a9c98d8' },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps bulk, broad-selector, enriched, and invalid locks:release forms sheddable', () => {
    const lockId = '551d8e36-bd4f-4eea-9ad8-42ba8a9c98d8';
    for (const args of [
      { lock_ids: [lockId] },
      { all_mine: true },
      { paths: ['packages/operator-core/lib/example.ts'] },
      { lock_id: lockId, coordination_domain: '/canonical/staging' },
      { lock_id: lockId, published_sha: 'a'.repeat(40) },
      { lock_id: lockId, native_edit_proof: { success: true, source: 'codex', paths: ['example.ts'] } },
      { lock_id: 'not-a-uuid' },
      {},
    ]) {
      expect(isBoundedLocksReleaseArgs(args)).toBe(false);
      const body = toolsCall(16, 'locks:release', args);
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 16 });
      expect(classifyMcpRequest(body)).toBe('ordinary');
    }
  });

  it.each([
    'work_items:get',
    'work_items_get',
    'mcp__papercusp-su__work_items_get',
  ])('does NOT shed a bounded single-item work_items:get under critical pressure: %s', (name) => {
    const body = toolsCall(11, name, { id: 'EI-22381211295936796' });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps bulk and full-detail work_items:get reads sheddable under critical pressure', () => {
    for (const args of [
      { ids: ['EI-1', 'EI-2'] },
      { id: 'EI-1', detail: true },
      { id: 'EI-1', detail: true, threadLimit: 0 },
      { id: 'EI-1', threadLimit: 11 },
    ]) {
      expect(classifyMcpBody(toolsCall(12, 'work_items:get', args))).toEqual({ sheddable: true, id: 12 });
    }
  });

  it.each([
    ['thread window', { id: 'EI-1', threadLimit: 1 }],
    ['detail alias plus thread window', { id: 'EI-1', detail: true, threadLimit: 10 }],
    ['full alias plus thread window', { id: 'EI-1', detail: 'full', threadLimit: 10 }],
  ])('does NOT shed a bounded work_items:get thread-window read under critical pressure: %s', (_label, args) => {
    const body = toolsCall(12, 'work_items:get', args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['canonical', 'work_items:list'],
    ['underscore', 'work_items_list'],
    ['mcp-advertised hyphen', 'mcp__papercusp-su__work_items_list'],
    ['mcp-advertised underscore', 'mcp__papercusp_su__work_items_list'],
  ])('does NOT shed a bounded caller-owned work_items:list under critical pressure: %s', (_label, name) => {
    const args = {
      harness: 'papercusp',
      mine: true,
      notTerminal: true,
      limit: 10,
    };
    expect(isBoundedWorkItemsListArgs(args)).toBe(true);
    const body = toolsCall(15, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('accepts assignee:self and lifecycle filters as the alternate bounded reconciliation form', () => {
    const args = { assignee: 'self', state: ['open', 'failing'], limit: 5, includeObservations: false };
    expect(isBoundedWorkItemsListArgs(args)).toBe(true);
    expect(classifyMcpBody(toolsCall(16, 'work_items:list', args))).toEqual({ sheddable: false, id: null });
  });

  it('recognizes a bounded caller-owned work_items:list through deferred tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 17,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__work_items_list',
          args: { mine: true, limit: 10 },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps unscoped, peer, broad, and enriched work_items:list forms sheddable under critical pressure', () => {
    for (const args of [
      { harness: 'papercusp', limit: 10 },
      { assignee: 'peer-owner', limit: 10 },
      { mine: true },
      { mine: true, limit: 21 },
      { mine: true, limit: 10, includeChildren: true },
      { mine: true, limit: 10, q: 'reconcile' },
      { mine: true, limit: 10, includeObservations: true },
      { mine: true, limit: 10, state: 'open', states: ['open'] },
      { mine: true, limit: 10, states: [] },
      { mine: true, limit: 10, notTerminal: false },
    ]) {
      expect(isBoundedWorkItemsListArgs(args)).toBe(false);
      const body = toolsCall(18, 'work_items:list', args);
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 18 });
      expect(classifyMcpRequest(body)).toBe('ordinary');
    }
  });

  it.each([
    ['canonical', 'work_items:complete'],
    ['underscore', 'work_items_complete'],
    ['mcp-advertised hyphen', 'mcp__papercusp-su__work_items_complete'],
    ['mcp-advertised underscore', 'mcp__papercusp_su__work_items_complete'],
  ])('does NOT shed a bounded single work_items:complete under critical pressure: %s', (_label, name) => {
    const args = {
      id: 'EI-23096430176801261',
      state: 'resolved',
      assumptions: 'none',
      completion: {
        workItem: 'EI-23096430176801261',
        summary: 'bounded completion evidence',
        tests: 'focused admission tests',
      },
    };
    expect(isBoundedWorkItemsCompleteArgs(args)).toBe(true);
    const body = toolsCall(26, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('admits record-only and validateOnly work_items:complete forms, but not a bulk envelope', () => {
    const recordOnly = {
      id: 'EI-23096430176801261',
      completion: { workItem: 'EI-23096430176801261', summary: 'record progress only' },
    };
    const validateOnly = {
      id: 'EI-23096430176801261',
      validateOnly: true,
      state: 'resolved',
      assumptions: 'none',
      completion: { workItem: 'EI-23096430176801261', summary: 'validate the close contract' },
    };
    expect(isBoundedWorkItemsCompleteArgs(recordOnly)).toBe(true);
    expect(classifyMcpBody(toolsCall(27, 'work_items:complete', recordOnly))).toEqual({
      sheddable: false,
      id: null,
    });
    expect(isBoundedWorkItemsCompleteArgs(validateOnly)).toBe(true);
    expect(classifyMcpBody(toolsCall(28, 'work_items:complete', validateOnly))).toEqual({
      sheddable: false,
      id: null,
    });
    const bulk = {
      items: [{ id: 'EI-23096430176801261', completion: { summary: 'bulk completion' } }],
      validateOnly: true,
    };
    expect(isBoundedWorkItemsCompleteArgs(bulk)).toBe(false);
    expect(classifyMcpBody(toolsCall(29, 'work_items:complete', bulk))).toEqual({ sheddable: true, id: 29 });
    expect(classifyMcpRequest(toolsCall(29, 'work_items:complete', bulk))).toBe('ordinary');
  });

  it('recognizes a bounded work_items:complete through deferred tools:invoke', () => {
    const args = {
      id: 'EI-23096430176801261',
      validateOnly: true,
      completion: { workItem: 'EI-23096430176801261', summary: 'validate through deferred dispatch' },
    };
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__work_items_complete',
          args,
        },
      },
    });
    expect(isBoundedWorkItemsCompleteArgs(args)).toBe(true);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps malformed, oversized, and enriched work_items:complete shapes sheddable under critical pressure', () => {
    for (const args of [
      {},
      { id: 'EI-23096430176801261' },
      { id: 'EI-23096430176801261', completion: 'not an object' },
      { id: 'EI-23096430176801261', validateOnly: 'true', completion: { summary: 'bad flag' } },
      { id: 'EI-23096430176801261', completion: { summary: 'missing wrapper is okay only with a flat field' }, items: [] },
      { id: 'EI-23096430176801261', completion: { summary: 'bad assumptions' }, assumptions: [] },
      { id: 'EI-23096430176801261', completion: { summary: 'unknown top-level' }, extra: true },
      { id: 'EI-23096430176801261', completion: { summary: 'x'.repeat(8_001) } },
      {
        id: 'EI-23096430176801261',
        completion: { summary: 'too many evidence entries', filesChanged: Array.from({ length: 101 }, () => 'x.ts') },
      },
      {
        id: 'EI-23096430176801261',
        completion: { summary: 'expanded output' },
        outputPayload: 'x'.repeat(64_001),
      },
    ]) {
      expect(isBoundedWorkItemsCompleteArgs(args)).toBe(false);
      const body = toolsCall(31, 'work_items:complete', args);
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 31 });
      expect(classifyMcpRequest(body)).toBe('ordinary');
    }
  });

  it.each([
    ['canonical', 'docs:get'],
    ['underscore', 'docs_get'],
    ['mcp-advertised', 'mcp__papercusp-su__docs_get'],
    ['mcp-advertised-underscore', 'mcp__papercusp_su__docs_get'],
  ])('does NOT shed a bounded single-page docs:get recovery read under critical pressure: %s', (_label, name) => {
    const args = {
      slugs: ['agent-insights/coordination/checkpoints-and-facts'],
      harness: 'engineering',
    };
    expect(isBoundedDocsGetArgs(args)).toBe(true);
    const body = toolsCall(12, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps batched, partial-source, malformed, and oversized docs:get reads sheddable under critical pressure', () => {
    for (const args of [
      { slugs: ['one', 'two'] },
      { slugs: [] },
      { slugs: ['one'], slug: 'one' },
      { slugs: ['one'], source: true, heading: 'intro' },
      { slugs: ['one'], offset: -1 },
      { slugs: ['one'], offset: Number.MAX_SAFE_INTEGER + 1 },
      { slugs: ['one'], source: 'true' },
      { slugs: ['one'], heading: 'x'.repeat(257) },
      { slugs: ['one'], harness: 'x'.repeat(121) },
      { slugs: ['x'.repeat(513)] },
      { slugs: ['one'], extra: 'unbounded' },
    ]) {
      expect(isBoundedDocsGetArgs(args)).toBe(false);
      const body = toolsCall(13, 'docs:get', args);
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 13 });
      expect(classifyMcpRequest(body)).toBe('ordinary');
    }
  });

  it('recognizes a bounded docs:get through deferred tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__docs_get',
          args: { slugs: ['agent-insights/coordination/checkpoints-and-facts'], harness: 'all' },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['canonical', 'docs:search'],
    ['underscore', 'docs_search'],
    ['mcp-advertised', 'mcp__papercusp-su__docs_search'],
    ['mcp-advertised-underscore', 'mcp__papercusp_su__docs_search'],
  ])('does NOT shed a bounded lexical-only docs:search under critical pressure: %s', (_label, name) => {
    const args = {
      query: 'find the recovery runbook for this lane',
      limit: 5,
      harness: 'engineering',
      semantic: false,
    };
    expect(isBoundedDocsSearchArgs(args)).toBe(true);
    const body = toolsCall(15, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('accepts the bounded docs:search default page while keeping unsafe forms sheddable', () => {
    expect(isBoundedDocsSearchArgs({ query: 'find the recovery runbook', semantic: false })).toBe(true);
    for (const args of [
      { query: 'recover this', limit: 5 },
      { query: 'recover this', semantic: true, limit: 5 },
      { query: 'recover this', semantic: false, limit: 21 },
      { query: 'recover this', semantic: false, limit: 0 },
      { query: 'recover this', semantic: false, harness: 'x'.repeat(121), limit: 5 },
      { query: 'x'.repeat(201), semantic: false, limit: 5 },
      { query: 'recover this', semantic: false, extra: 'unbounded', limit: 5 },
    ]) {
      expect(isBoundedDocsSearchArgs(args)).toBe(false);
      const body = toolsCall(16, 'docs:search', args);
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 16 });
      expect(classifyMcpRequest(body)).toBe('ordinary');
    }
  });

  it('recognizes a bounded lexical-only docs:search through deferred tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 17,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__docs_search',
          args: { query: 'find a recovery runbook', semantic: false, limit: 5 },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['canonical', 'search:fulltext'],
    ['underscore', 'search_fulltext'],
    ['mcp-advertised', 'mcp__papercusp-su__search_fulltext'],
    ['mcp-advertised-underscore', 'mcp__papercusp_su__search_fulltext'],
  ])('does NOT shed a bounded single-source search:fulltext under critical pressure: %s', (_label, name) => {
    const args = {
      query: 'find the prior admission-shed incident',
      scope: ['work_item'],
      harness_slug: 'papercusp',
      limit: 5,
    };
    expect(isBoundedSearchFulltextArgs(args)).toBe(true);
    const body = toolsCall(18, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('requires an explicit single source and keeps fulltext filters/enrichment sheddable', () => {
    expect(isBoundedSearchFulltextArgs({ query: 'find the incident', scope: ['work_item'] })).toBe(true);
    for (const args of [
      { query: 'find the incident', limit: 5 },
      { query: 'find the incident', scope: [] },
      { query: 'find the incident', scope: ['work_item', 'coord_message'], limit: 5 },
      { query: 'find the incident', scope: ['all'], limit: 5 },
      { query: 'find the incident', scope: ['work_item'], limit: 6 },
      { query: 'find the incident', scope: ['work_item'], harness_slug: 'x'.repeat(121) },
      { query: 'x'.repeat(401), scope: ['work_item'], limit: 5 },
      { query: 'find the incident', scope: ['work_item'], owner: 'self', limit: 5 },
      { query: 'find the incident', scope: ['work_item'], semantic: false, limit: 5 },
    ]) {
      expect(isBoundedSearchFulltextArgs(args)).toBe(false);
      const body = toolsCall(19, 'search:fulltext', args);
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 19 });
      expect(classifyMcpRequest(body)).toBe('ordinary');
    }
  });

  it('recognizes bounded single-source search:fulltext through deferred tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__search_fulltext',
          args: { query: 'find a recovery incident', scope: ['work_item'], limit: 5 },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['canonical', 'work_items:search'],
    ['underscore', 'work_items_search'],
    ['mcp-advertised', 'mcp__papercusp-su__work_items_search'],
    ['mcp-advertised-underscore', 'mcp__papercusp_su__work_items_search'],
  ])('does NOT shed a bounded lexical-only work_items:search under critical pressure: %s', (_label, name) => {
    const args = {
      query: 'request shed during validation drain',
      harness: 'papercusp',
      kind: 'bug',
      limit: 5,
      semantic: false,
      includeObservations: false,
    };
    expect(isBoundedWorkItemsSearchArgs(args)).toBe(true);
    const body = toolsCall(12, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps semantic, broad, malformed, and enriched work_items:search forms sheddable under critical pressure', () => {
    for (const args of [
      { query: 'recover this', limit: 5 },
      { query: 'recover this', semantic: true, limit: 5 },
      { query: 'recover this', semantic: false, limit: 21 },
      { query: 'recover this', semantic: false, limit: 0 },
      { query: 'recover this', semantic: false, limit: 5, includeObservations: true },
      { query: 'recover this', semantic: false, cursor: 'opaque' },
      { query: 'x'.repeat(401), semantic: false, limit: 5 },
      { query: 'recover this', semantic: false, harness: 'x'.repeat(81), limit: 5 },
      { query: 'recover this', semantic: false, kind: 'x'.repeat(81), limit: 5 },
      { query: 'recover this', semantic: false, limit: 5, extra: 'unbounded' },
    ]) {
      expect(isBoundedWorkItemsSearchArgs(args)).toBe(false);
      const body = toolsCall(13, 'work_items:search', args);
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 13 });
      expect(classifyMcpRequest(body)).toBe('ordinary');
    }
  });

  it('recognizes a bounded lexical-only work_items:search through deferred tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__work_items_search',
          args: { query: 'request shed', semantic: false, limit: 5 },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['canonical', 'recipes:search'],
    ['underscore', 'recipes_search'],
    ['mcp-advertised', 'mcp__papercusp-su__recipes_search'],
    ['mcp-advertised-underscore', 'mcp__papercusp_su__recipes_search'],
  ])('does NOT shed a bounded lexical-only recipes:search under critical pressure: %s', (_label, name) => {
    const args = {
      query: 'find the recovery recipe for this lane',
      limit: 5,
      semantic: false,
    };
    expect(isBoundedRecipesSearchArgs(args)).toBe(true);
    const body = toolsCall(15, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps semantic, broad, malformed, and enriched recipes:search forms sheddable under critical pressure', () => {
    for (const args of [
      { query: 'recover this', limit: 5 },
      { query: 'recover this', semantic: true, limit: 5 },
      { query: 'recover this', semantic: false, limit: 21 },
      { query: 'recover this', semantic: false, limit: 0 },
      { query: 'recover this', semantic: false, context: { fleet: 'live-fleet' }, limit: 5 },
      { query: 'x'.repeat(401), semantic: false, limit: 5 },
      { query: 'recover this', semantic: false, extra: 'unbounded', limit: 5 },
    ]) {
      expect(isBoundedRecipesSearchArgs(args)).toBe(false);
      const body = toolsCall(16, 'recipes:search', args);
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 16 });
      expect(classifyMcpRequest(body)).toBe('ordinary');
    }
  });

  it('recognizes a bounded lexical-only recipes:search through deferred tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 17,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__recipes_search',
          args: { query: 'find a recovery recipe', semantic: false, limit: 5 },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    'git-sync:run',
    'git_sync_run',
    'mcp__papercusp-su__git_sync_run',
    'mcp__papercusp_su__git_sync_run',
  ])('does NOT shed a bounded read-only git-sync:run preview under critical pressure: %s', (name) => {
    const args = { installSlug: 'papercusp', dryRun: true, reason: 'inspect the selected staging checkout' };
    expect(isBoundedGitSyncRunArgs(args)).toBe(true);
    const body = toolsCall(13, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps non-preview, ambiguous, malformed, or oversized git-sync:run shapes sheddable under critical pressure', () => {
    for (const args of [
      {},
      { installSlug: 'papercusp' },
      { installSlug: 'papercusp', dryRun: false },
      { installSlug: 'papercusp', dryRun: true, harness: 'papercusp' },
      { installSlug: 'x'.repeat(121), dryRun: true },
      { harness: 'papercusp', dryRun: true, reason: 'x'.repeat(1_001) },
      { harness: 'papercusp', dryRun: true, reason: 42 },
      { harness: 'papercusp', dryRun: true, extra: 'unbounded' },
    ]) {
      expect(isBoundedGitSyncRunArgs(args)).toBe(false);
      const body = toolsCall(14, 'git-sync:run', args);
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 14 });
      expect(classifyMcpRequest(body)).toBe('ordinary');
    }
  });

  it('recognizes a bounded read-only git-sync:run preview through deferred tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__git_sync_run',
          args: { harness: 'papercusp', dryRun: true, reason: 'inspect before retry' },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    'session:request-compaction',
    'session_request_compaction',
    'mcp__papercusp-su__session_request_compaction',
    'mcp__papercusp_su__session_request_compaction',
  ])('does NOT shed a bounded session:request-compaction recovery call under critical pressure: %s', (name) => {
    const args = {
      focus: 'resume the current fleet lane',
      autoContinue: false,
      resumeMode: 'same',
      reason: 'clean stopping point',
      respawn: true,
      continueNote: 'Re-orient from the carry document and resume the current fleet lane.',
    };
    expect(isBoundedSessionRequestCompactionArgs(args)).toBe(true);
    const body = toolsCall(16, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps malformed or oversized session:request-compaction calls sheddable under critical pressure', () => {
    for (const args of [
      { focus: 'x'.repeat(601) },
      { continueNote: 'x'.repeat(1_001) },
      { reason: 'x'.repeat(601) },
      { autoContinue: 'false' },
      { respawn: 1 },
      { resumeMode: 'fresh' },
      { unsupported: true },
    ]) {
      expect(isBoundedSessionRequestCompactionArgs(args)).toBe(false);
      const body = toolsCall(17, 'session:request-compaction', args);
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 17 });
      expect(classifyMcpRequest(body)).toBe('ordinary');
    }
  });

  it('recognizes a bounded session:request-compaction through deferred tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 18,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__session_request_compaction',
          args: { focus: 'resume the current lane', autoContinue: true, resumeMode: 'same' },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    'testing:run-status',
    'testing_run_status',
    'mcp__papercusp-su__testing_run_status',
    'mcp__papercusp_su__testing_run_status',
  ])('does NOT shed a bounded detached testing:run-status read under critical pressure: %s', (name) => {
    const body = toolsCall(13, name, { runId: '6de15d63-d7fb-4ed4-bcec-8af90bdd6106' });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps malformed or output-expanding testing:run-status reads sheddable under critical pressure', () => {
    for (const args of [
      {},
      { runId: '' },
      { runId: 'x'.repeat(121) },
      { runId: 'run-1', extra: true },
    ]) {
      const body = toolsCall(14, 'testing:run-status', args);
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 14 });
      expect(classifyMcpRequest(body)).toBe('ordinary');
    }
  });

  it('recognizes a bounded testing:run-status read through deferred tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__testing_run_status',
          args: { runId: 'run-1' },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    'logs:read',
    'logs_read',
    'mcp__papercusp-su__logs_read',
    'mcp__papercusp_su__logs_read',
  ])('does NOT shed a bounded logs:read recovery read under critical pressure: %s', (name) => {
    const args = {
      unit: ['papercup-api', 'papercup-bg-host'],
      grep: 'error|failed',
      level: 'err',
      limit: 50,
      scope: 'user',
    };
    expect(isBoundedLogsReadArgs(args)).toBe(true);
    const body = toolsCall(16, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps unbounded or malformed logs:read calls sheddable under critical pressure', () => {
    for (const args of [
      { unit: 'papercup-api' },
      { limit: 50 },
      { unit: ['a', 'b', 'c', 'd'], limit: 50 },
      { unit: 'papercup-api', limit: 51 },
      { unit: 'papercup-api', grep: 'x'.repeat(201), limit: 50 },
      { unit: 'papercup-api', level: 'fatal', limit: 50 },
      { unit: 'papercup-api', limit: 50, extra: true },
    ]) {
      expect(isBoundedLogsReadArgs(args)).toBe(false);
      const body = toolsCall(17, 'logs:read', args);
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 17 });
      expect(classifyMcpRequest(body)).toBe('ordinary');
    }
  });

  it.each([
    'notifications:recent',
    'notifications_recent',
    'mcp__papercusp-su__notifications_recent',
    'mcp__papercusp_su__notifications_recent',
  ])('does NOT shed a bounded notifications:recent read under critical pressure: %s', (name) => {
    const args = { level: 'error', limit: 50 };
    expect(isBoundedNotificationsRecentArgs(args)).toBe(true);
    const body = toolsCall(18, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('admits notifications:recent defaults but keeps expanded forms sheddable under critical pressure', () => {
    expect(isBoundedNotificationsRecentArgs(undefined)).toBe(true);
    expect(isBoundedNotificationsRecentArgs({})).toBe(true);
    for (const args of [
      { limit: 51 },
      { level: 'fatal' },
      { limit: 50, extra: true },
      null,
    ]) {
      expect(isBoundedNotificationsRecentArgs(args)).toBe(false);
      const body = toolsCall(19, 'notifications:recent', args as Record<string, unknown>);
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 19 });
      expect(classifyMcpRequest(body)).toBe('ordinary');
    }
  });

  it.each([
    'testing:runs',
    'testing_runs',
    'mcp__papercusp-su__testing_runs',
    'mcp__papercusp_su__testing_runs',
  ])('does NOT shed a bounded testing:runs ledger read under critical pressure: %s', (name) => {
    const args = {
      commitSha: 'abc1234',
      status: ['fail', 'error'],
      source: 'ci',
      limit: 25,
    };
    expect(isBoundedTestingRunsArgs(args)).toBe(true);
    const body = toolsCall(20, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('admits bounded exact test-run IDs but keeps broad or expanded testing:runs reads sheddable', () => {
    expect(isBoundedTestingRunsArgs({ testRunIds: [1, 2] })).toBe(true);
    for (const args of [
      { limit: 25 },
      { commitSha: 'abc1234' },
      { commitSha: 'abc1234', limit: 26 },
      { commitSha: 'abc1234', status: ['failed'], limit: 25 },
      { testRunIds: Array.from({ length: 26 }, (_, index) => index + 1) },
      { commitSha: 'abc1234', limit: 25, extra: true },
    ]) {
      expect(isBoundedTestingRunsArgs(args)).toBe(false);
      const body = toolsCall(21, 'testing:runs', args);
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 21 });
      expect(classifyMcpRequest(body)).toBe('ordinary');
    }
  });

  it('recognizes all three bounded readers through deferred tools:invoke aliases', () => {
    for (const [name, args] of [
      ['mcp__papercusp_su__logs_read', { unit: 'papercup-api', limit: 50 }],
      ['mcp__papercusp_su__notifications_recent', { limit: 50 }],
      ['mcp__papercusp_su__testing_runs', { testRunIds: [42] }],
    ] as const) {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: {
          name: 'tools:invoke',
          arguments: { name, args },
        },
      });
      expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
      expect(classifyMcpRequest(body)).toBe('diagnostic');
    }
  });

  it.each([
    'activity:tool-log',
    'activity_tool_log',
    'mcp__papercusp-su__activity_tool_log',
    'mcp__papercusp_su__activity_tool_log',
  ])('does NOT shed a bounded activity:tool-log recovery read under critical pressure: %s', (name) => {
    const args = {
      owner: 'self',
      since: '2026-09-14T07:00:00Z',
      until: '2026-09-14T08:00:00Z',
      max_lines: 40,
      top_k: 8,
    };
    expect(isBoundedActivityToolLogArgs(args)).toBe(true);
    const body = toolsCall(16, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('accepts a bounded session-scoped activity:tool-log read and keeps broad forms sheddable', () => {
    const sessionScoped = { session_id: 'session-123', max_lines: 5, top_k: 1 };
    expect(isBoundedActivityToolLogArgs(sessionScoped)).toBe(true);
    expect(classifyMcpBody(toolsCall(17, 'activity:tool-log', sessionScoped))).toEqual({
      sheddable: false,
      id: null,
    });

    for (const args of [
      {},
      { max_lines: 40 },
      { owner: 'self', max_lines: 41 },
      { owner: 'self', max_lines: 4 },
      { owner: 'self', top_k: 9 },
      { owner: 'self', since: '-15 min' },
      { owner: 'self', until: 'not-an-iso-timestamp' },
      { owner: 'self', extra: true },
    ]) {
      expect(isBoundedActivityToolLogArgs(args)).toBe(false);
      const body = toolsCall(18, 'activity:tool-log', args);
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 18 });
      expect(classifyMcpRequest(body)).toBe('ordinary');
    }
  });

  it('recognizes a bounded activity:tool-log read through deferred tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 19,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__activity_tool_log',
          args: { owner: 'self', max_lines: 5, top_k: 3 },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    'facts:list',
    'facts_list',
    'mcp__papercusp-su__facts_list',
    'mcp__papercusp_su__facts_list',
  ])('does NOT shed a bounded exact-key facts:list read under critical pressure: %s', (name) => {
    const args = { scope: 'owner', key: 'launch-provenance', full: true };
    expect(isBoundedFactsListArgs(args)).toBe(true);
    const body = toolsCall(24, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps broad, historical, malformed, and expanded facts:list requests sheddable under critical pressure', () => {
    for (const args of [
      {},
      { scope: 'workspace' },
      { scope: 'workspace', key: '' },
      { scope: 'workspace', key: '   ' },
      { scope: 'plan', key: 'release-plan' },
      { scope: 'workspace', key: 'x'.repeat(201) },
      { scope: 'workspace', key: 'known-key', all: true },
      { scope: 'workspace', key: 'known-key', limit: 1 },
      { scope: 'workspace', key: 'known-key', versions: true },
      { scope: 'workspace', key: 'known-key', scopeRef: 'unexpected' },
      { scope: 'harness', scopeRef: 'x'.repeat(121), key: 'known-key' },
      { scope: 'owner', key: 'known-key', full: 'true' },
      { scope: 'owner', key: 'known-key', projection: { pick: ['facts[].key'] } },
    ]) {
      expect(isBoundedFactsListArgs(args)).toBe(false);
      const body = toolsCall(25, 'facts:list', args);
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 25 });
      expect(classifyMcpRequest(body)).toBe('ordinary');
    }
  });

  it('recognizes a bounded exact-key facts:list read through deferred tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 26,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__facts_list',
          args: { scope: 'workspace', key: 'guard-rail:checkpoint-git-probes-async-execfile-replay' },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    'sessions:search',
    'sessions_search',
    'mcp__papercusp-su__sessions_search',
    'mcp__papercusp_su__sessions_search',
  ])('does NOT shed bounded post-compaction self-recall under critical pressure: %s', (name) => {
    const args = { query: 'resume the current lane', session: 'self', mode: 'verbatim' };
    expect(isBoundedSessionsSearchArgs(args)).toBe(true);
    const body = toolsCall(16, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps broad or output-expanding sessions:search reads sheddable under critical pressure', () => {
    for (const args of [
      { query: 'recover this', session: 'self' },
      { query: 'recover this', session: 'self', mode: 'hybrid' },
      { query: 'recover this', session: 'other', mode: 'verbatim' },
      { query: 'recover this', session: 'self', mode: 'verbatim', limit: 6 },
      { query: 'recover this', session: 'self', mode: 'verbatim', context: 3 },
      { query: 'recover this', session: 'self', mode: 'verbatim', include_coord: true },
      { query: 'recover this', session: 'self', mode: 'verbatim', cursor: 'opaque' },
      { query: 'recover this', session: 'self', mode: 'verbatim', owner: 'self' },
      { query: 'x'.repeat(501), session: 'self', mode: 'verbatim' },
    ]) {
      expect(isBoundedSessionsSearchArgs(args)).toBe(false);
      const body = toolsCall(17, 'sessions:search', args);
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 17 });
      expect(classifyMcpRequest(body)).toBe('ordinary');
    }
  });

  it('recognizes bounded sessions:search self-recall through deferred tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 18,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__sessions_search',
          args: { query: 'resume the current lane', session: 'self', mode: 'verbatim', limit: 1, context: 0 },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    'sessions:timeline',
    'sessions_timeline',
    'mcp__papercusp-su__sessions_timeline',
    'mcp__papercusp_su__sessions_timeline',
  ])('does NOT shed a bounded stale-wake timeline read under critical pressure: %s', (name) => {
    const args = {
      owner: 'self',
      since: '2026-09-14T07:00:00Z',
      limit: 100,
      kinds: ['tool', 'coord'],
      include_auto: true,
    };
    expect(isBoundedSessionsTimelineArgs(args)).toBe(true);
    const body = toolsCall(19, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps malformed, expanded, and enriched sessions:timeline reads sheddable under critical pressure', () => {
    for (const args of [
      {},
      { owner: '' },
      { owner: 'self', limit: 101 },
      { owner: 'self', kinds: ['turn', 'tool', 'coord', 'extra'] },
      { owner: 'self', include_auto: 'true' },
      { owner: 'self', cursor: 'x'.repeat(513) },
      { owner: 'self', extra: 'unbounded' },
      { owner: 'x'.repeat(121) },
    ]) {
      expect(isBoundedSessionsTimelineArgs(args)).toBe(false);
      const body = toolsCall(20, 'sessions:timeline', args);
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 20 });
      expect(classifyMcpRequest(body)).toBe('ordinary');
    }
  });

  it('recognizes a bounded sessions:timeline stale-wake read through deferred tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__sessions_timeline',
          args: { owner: 'self', since: '2026-09-14T07:00:00Z', limit: 1 },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    'plans:get',
    'plans_get',
    'mcp__papercusp-su__plans_get',
    'mcp__papercusp_su__plans_get',
  ])('does NOT shed a bounded heading-narrowed plans:get under critical pressure: %s', (name) => {
    const args = {
      slug: 'portal-voice-parity-and-release-2026-09-08',
      harness: 'papercusp',
      heading: 'Decisions',
      mode: 'sections',
      // Explicit mode wins over this compatibility alias in the handler.
      detail: 'full',
    };
    const body = toolsCall(18, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('admits a P-NNN subsection and the bounded shape through deferred tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 19,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__plans_get',
          args: {
            slug: 'portal-voice-parity-and-release-2026-09-08',
            harness: 'papercusp',
            heading: 'P-031',
            mode: 'sections',
            detail: 'full',
          },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps broad, full, and ship-readiness plans:get forms sheddable', () => {
    for (const args of [
      { slug: 'plan', mode: 'sections' },
      { slug: 'plan', heading: 'Decisions', detail: 'full' },
      { slug: 'plan', heading: 'Decisions', mode: 'full' },
      { slugs: ['plan-a', 'plan-b'], heading: 'Decisions', mode: 'sections' },
      { slug: 'plan', heading: 'Decisions', mode: 'sections', shipReadiness: true },
      { slug: 'plan', heading: 'Context', mode: 'sections' },
    ]) {
      expect(classifyMcpBody(toolsCall(20, 'plans:get', args))).toEqual({ sheddable: true, id: 20 });
    }
  });

  it.each([
    ['owner', { owner: 'su-target' }],
    ['ownerId', { ownerId: 'su-target' }],
    ['owners', { owners: ['su-target', 'su-peer'] }],
    ['ownerIds', { ownerIds: ['su-target', 'su-peer'] }],
  ])('admits bounded targeted coord:presence selector %s under critical pressure', (_label, args) => {
    const body = toolsCall(31, 'coord:presence', args);
    expect(isBoundedCoordPresenceArgs(args)).toBe(true);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('admits targeted coord:presence aliases through tools:invoke and rejects broad/project-only reads', () => {
    const deferred = JSON.stringify({
      jsonrpc: '2.0',
      id: 32,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: { name: 'mcp__papercusp_su__coord_presence', args: { ownerIds: ['su-target'] } },
      },
    });
    expect(classifyMcpBody(deferred)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(deferred)).toBe('diagnostic');
    for (const args of [{}, { project: 'ids' }, { owner: 'su-target', owners: ['su-peer'] }, { owners: [] }]) {
      expect(isBoundedCoordPresenceArgs(args)).toBe(false);
      expect(classifyMcpBody(toolsCall(33, 'coord:presence', args))).toEqual({ sheddable: true, id: 33 });
    }
  });

  it.each([
    ['default live', { owner: 'su-target' }],
    ['live', { view: 'live', owner: 'su-target' }],
    ['members', { view: 'members', owner: 'su-target' }],
  ])('admits bounded targeted coord:roster %s under critical pressure', (_label, args) => {
    const body = toolsCall(34, 'coord:roster', args);
    expect(isBoundedCoordRosterArgs(args)).toBe(true);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('admits targeted coord:roster through tools:invoke but preserves broad/project-only shedding', () => {
    const deferred = JSON.stringify({
      jsonrpc: '2.0',
      id: 35,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: { name: 'mcp__papercusp_su__coord_roster', args: { view: 'members', owner: 'su-target' } },
      },
    });
    expect(classifyMcpBody(deferred)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(deferred)).toBe('diagnostic');
    for (const args of [{ view: 'live' }, { view: 'live', project: 'ids' }, { view: 'claims', owner: 'su-target' }, { owner: '' }]) {
      expect(isBoundedCoordRosterArgs(args)).toBe(false);
      expect(classifyMcpBody(toolsCall(36, 'coord:roster', args))).toEqual({ sheddable: true, id: 36 });
    }
  });

  it.each([
    ['canonical', 'coord:inbox'],
    ['underscore', 'coord_inbox'],
    ['mcp-advertised', 'mcp__papercusp_su__coord_inbox'],
  ])('does NOT shed a bounded directed coord:inbox recovery read under critical pressure: %s', (_label, name) => {
    const args = { directed: true, unanswered_only: true, limit: 10 };
    expect(isBoundedCoordInboxArgs(args)).toBe(true);
    const body = toolsCall(37, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps broad and unbounded coord:inbox recovery reads shed under critical pressure', () => {
    for (const args of [
      {},
      { directed: true },
      { unanswered_only: true },
      { directed: true, unanswered_only: true },
      { directed: false, unanswered_only: true, limit: 10 },
      { directed: true, unanswered_only: false, limit: 10 },
      { directed: true, unanswered_only: true, limit: 11 },
      { directed: true, unanswered_only: true, limit: 10, from: 'su-peer' },
    ]) {
      expect(isBoundedCoordInboxArgs(args)).toBe(false);
      expect(classifyMcpBody(toolsCall(38, 'coord:inbox', args))).toEqual({ sheddable: true, id: 38 });
      expect(classifyMcpRequest(toolsCall(38, 'coord:inbox', args))).toBe('ordinary');
    }
  });

  it('recognizes the bounded coord:inbox recovery read through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 39,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__coord_inbox',
          args: { directed: true, unanswered_only: true, limit: 10 },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('recognizes the bounded work_items:get through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: { name: 'mcp__papercusp-su__work_items_get', args: { id: 'EI-1' } },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['canonical', 'scheduler:get_next'],
    ['underscore', 'scheduler_get_next'],
    ['mcp-advertised', 'mcp__papercusp_su__scheduler_get_next'],
  ])('does NOT shed a bounded scheduler self-pull under critical pressure: %s', (_label, name) => {
    const body = toolsCall(14, name, {
      harness: 'papercusp',
      heldPaths: [],
      states: ['open'],
      rigAvailable: false,
      ignoreContextPressure: false,
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps broad or malformed scheduler self-pulls sheddable under critical pressure', () => {
    for (const args of [
      { harness: 'papercusp', unknown: true },
      { harness: '', states: ['open'] },
      { harness: 'papercusp', states: ['blocked'] },
      { harness: 'papercusp', heldPaths: Array.from({ length: 501 }, () => 'path') },
      { harness: 'papercusp', heldPaths: ['x'.repeat(513)] },
      { harness: 'papercusp', rigAvailable: 'false' },
    ]) {
      expect(classifyMcpBody(toolsCall(15, 'scheduler:get_next', args))).toEqual({
        sheddable: true,
        id: 15,
      });
    }
  });

  it('recognizes a bounded scheduler self-pull through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 16,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__scheduler_get_next',
          args: { harness: 'papercusp', heldPaths: [], states: ['failing'] },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['canonical', 'loop:status'],
    ['underscore', 'loop_status'],
    ['mcp-advertised', 'mcp__papercusp_su__loop_status'],
  ])('does NOT shed a bounded loop status read under critical pressure: %s', (_label, name) => {
    const body = toolsCall(17, name, { harness: 'papercusp', ownerId: 'self' });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('still sheds an opaque loop status payload under critical pressure', () => {
    expect(
      classifyMcpBody(toolsCall(18, 'loop:status', { unexpected: 'unbounded' })),
    ).toEqual({ sheddable: true, id: 18 });
  });

  it.each([
    ['canonical', 'loop:checkpoint'],
    ['underscore', 'loop_checkpoint'],
    ['mcp-advertised', 'mcp__papercusp_su__loop_checkpoint'],
  ])('does NOT shed a bounded loop checkpoint under critical pressure: %s', (_label, name) => {
    const args = {
      did: 'completed the current lane step',
      left: 'pull the next admitted item',
      insight: 'the durable checkpoint preserves the next wake context',
      next: 'resume scheduler pull',
      harness: 'papercusp',
    };
    expect(isBoundedLoopCheckpointArgs(args)).toBe(true);
    const body = toolsCall(19, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('recognizes a bounded loop checkpoint through deferred tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__loop_checkpoint',
          args: { did: 'persist the current wake state', next: 'resume the lane' },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps reads, owner overrides, retirement controls, and oversized loop checkpoints sheddable', () => {
    for (const args of [
      { read: true },
      { harness: 'papercusp' },
      { expectedHash: '551d8e36bd4f' },
      { did: 'persist', ownerId: 'su-peer' },
      { did: 'persist', rowsMode: 'replace' },
      { did: 'x'.repeat(8_001) },
      { checks: Array.from({ length: 13 }, (_, i) => ({ claim: `check-${i}` })) },
    ]) {
      expect(isBoundedLoopCheckpointArgs(args)).toBe(false);
      expect(classifyMcpBody(toolsCall(21, 'loop:checkpoint', args))).toEqual({ sheddable: true, id: 21 });
      expect(classifyMcpRequest(toolsCall(21, 'loop:checkpoint', args))).toBe('ordinary');
    }
  });

  it('recognizes a bounded loop status read through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 19,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__loop_status',
          args: { owner: 'self' },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['canonical', 'loop:arm'],
    ['underscore', 'loop_arm'],
    ['mcp-advertised', 'mcp__papercusp_su__loop_arm'],
  ])('does NOT shed a bounded short work loop arm under critical pressure: %s', (_label, name) => {
    const args = { intervalSec: 60, goal: 'resume the current fleet work item', carry: 'cold', mode: 'work' };
    expect(isBoundedLoopArmArgs(args)).toBe(true);
    const body = toolsCall(20, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('recognizes a bounded loop arm through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__loop_arm',
          args: {
            intervalSec: 60,
            goal: 'resume the current fleet work item',
            workItem: 'EI-23122062573237933',
            carry: 'cold',
          },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps unbounded or non-work loop arms sheddable under critical pressure', () => {
    for (const args of [
      { intervalSec: 60, goal: 'resume the current fleet work item', wakePrompt: 'custom wake' },
      { intervalSec: 60, goal: 'resume the current fleet work item', mode: 'monitor' },
      { intervalSec: 60, goal: 'resume the current fleet work item', continuation: 'gated' },
      { intervalSec: 60, goal: 'x'.repeat(501) },
      { intervalSec: 60, goal: 'resume the current fleet work item', blockedOn: { reason: 'peer' } },
      { intervalSec: 60, goal: 'resume the current fleet work item', ownerId: 'su-peer' },
    ]) {
      expect(isBoundedLoopArmArgs(args)).toBe(false);
      expect(classifyMcpBody(toolsCall(22, 'loop:arm', args))).toEqual({ sheddable: true, id: 22 });
      expect(classifyMcpRequest(toolsCall(22, 'loop:arm', args))).toBe('ordinary');
    }
  });

  it.each([
    ['canonical', 'events:status'],
    ['underscore', 'events_status'],
    ['mcp-advertised', 'mcp__papercusp_su__events_status'],
  ])('does NOT shed an exact events status await read under critical pressure: %s', (_label, name) => {
    const args = { await_id: 178337 };
    expect(isBoundedEventsStatusArgs(args)).toBe(true);
    const body = toolsCall(24, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['canonical', 'events:status'],
    ['underscore', 'events_status'],
    ['mcp-advertised', 'mcp__papercusp_su__events_status'],
  ])('does NOT shed an exact events status event read under critical pressure: %s', (_label, name) => {
    const args = { event: 'work-item:done:EI-23109903341283549', after_generation: 7 };
    expect(isBoundedEventsStatusArgs(args)).toBe(true);
    const body = toolsCall(25, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('recognizes an exact events status read through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 26,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__events_status',
          args: { event: 'work-item:done:EI-23109903341283549' },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps broad, metered, mixed, and malformed events status reads sheddable', () => {
    for (const args of [
      {},
      { meter: false },
      { meter: true, await_id: 178337 },
      { await_id: 0 },
      { await_id: 1.5 },
      { await_id: '178337' },
      { await_id: 178337, event: 'work-item:done:EI-1' },
      { await_id: 178337, after_generation: 7 },
      { after_generation: 7 },
      { event: '' },
      { event: '   ' },
      { event: 'x'.repeat(201) },
      { event: 'work-item:done:EI-1', after_generation: -1 },
      { event: 'work-item:done:EI-1', after_generation: 1.5 },
      { event: 'work-item:done:EI-1', unexpected: true },
    ]) {
      expect(isBoundedEventsStatusArgs(args)).toBe(false);
      expect(classifyMcpBody(toolsCall(27, 'events:status', args))).toEqual({
        sheddable: true,
        id: 27,
      });
    }
  });

  it.each([
    ['canonical', 'work_items:checkpoint'],
    ['underscore', 'work_items_checkpoint'],
    ['mcp-advertised', 'mcp__papercusp_su__work_items_checkpoint'],
  ])('does NOT shed a single work-item checkpoint under critical pressure: %s', (_label, name) => {
    const body = toolsCall(19, name, { id: 'WI-10000745', checkpoint: 'resume from this boundary' });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('admits one-item checkpoint batches but keeps bulk or ambiguous calls sheddable', () => {
    expect(
      classifyMcpBody(
        toolsCall(20, 'work_items:checkpoint', {
          items: [{ id: 'WI-10000745', checkpoint: 'resume from this boundary' }],
        }),
      ),
    ).toEqual({ sheddable: false, id: null });
    for (const args of [
      { items: [{ id: 'WI-1' }, { id: 'WI-2' }] },
      { id: 'WI-1', items: [{ id: 'WI-2' }] },
      { checkpoint: 'missing item identity' },
    ]) {
      expect(classifyMcpBody(toolsCall(21, 'work_items:checkpoint', args))).toEqual({
        sheddable: true,
        id: 21,
      });
    }
  });

  it('recognizes a single work-item checkpoint through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__work_items_checkpoint',
          args: { id: 'WI-10000745', checkpoint: 'resume from this boundary' },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['canonical', 'work_items:set_state'],
    ['underscore', 'work_items_set_state'],
    ['mcp-advertised', 'mcp__papercusp_su__work_items_set_state'],
  ])('does NOT shed a bounded single work_items:set_state target under critical pressure: %s', (_label, name) => {
    const args = { id: 'WI-10000607', state: 'wip' };
    expect(isBoundedWorkItemsSetStateArgs(args)).toBe(true);
    const body = toolsCall(23, name, args);
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('admits exactly one target in each set_state shape but keeps batches and mixed selectors shed', () => {
    for (const args of [
      { ids: ['WI-10000607'], state: 'wip' },
      { items: [{ id: 'WI-10000607', state: 'wip' }] },
      { id: 'WI-10000607', state: 'wip', items: [{ id: 'WI-2', state: 'wip' }] },
    ]) {
      expect(isBoundedWorkItemsSetStateArgs(args)).toBe(args.ids !== undefined || args.items?.length === 1 && args.id === undefined);
    }
    for (const args of [
      { ids: ['WI-1', 'WI-2'], state: 'wip' },
      { items: [{ id: 'WI-1', state: 'wip' }, { id: 'WI-2', state: 'wip' }] },
      { id: 'WI-10000607', state: 'wip', ids: ['WI-2'] },
      { id: 'WI-10000607' },
      { state: 'wip' },
      { items: [{ id: 'WI-10000607' }] },
      { id: 'WI-10000607', state: 'wip', unexpected: true },
      { id: 'WI-10000607', state: 'wip', completionRef: 'x'.repeat(2_001) },
    ]) {
      expect(isBoundedWorkItemsSetStateArgs(args)).toBe(false);
      expect(classifyMcpBody(toolsCall(24, 'work_items:set_state', args))).toEqual({ sheddable: true, id: 24 });
      expect(classifyMcpRequest(toolsCall(24, 'work_items:set_state', args))).toBe('ordinary');
    }
  });

  it('recognizes a bounded work_items:set_state through deferred tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 25,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__work_items_set_state',
          args: { id: 'WI-10000607', state: 'wip' },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['canonical', 'coord:send'],
    ['underscore', 'coord_send'],
    ['mcp-advertised', 'mcp__papercusp_su__coord_send'],
  ])('admits one bounded direct coord:send under critical pressure: %s', (_label, name) => {
    const body = toolsCall(40, name, {
      to: ['su-peer'],
      summary: 'critical-pressure correction recorded',
      expects: 'none',
      body: [{ text: 'The durable correction is recorded; retry the detailed write after recovery.' }],
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['canonical', 'coord:send'],
    ['underscore', 'coord_send'],
    ['mcp-advertised', 'mcp__papercusp_su__coord_send'],
  ])('admits one bounded @fleet-leader coord:send under critical pressure: %s', (_label, name) => {
    const body = toolsCall(45, name, {
      to: ['@fleet-leader:nonp2p-bug-drain-luna-max-50'],
      summary: 'critical-pressure fleet status recorded',
      expects: 'none',
      body: [{ text: 'The fleet status is recorded; retry detailed coordination after recovery.' }],
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('admits one bounded coord:send through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 41,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__coord_send',
          args: {
            to: ['su-peer'],
            summary: 'critical-pressure correction recorded',
            expects: 'none',
            body: [{ text: 'The durable correction is recorded.' }],
          },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('admits one bounded @fleet-leader coord:send through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 47,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__coord_send',
          args: {
            to: ['@fleet-leader:nonp2p-bug-drain-luna-max-50'],
            summary: 'critical-pressure fleet status recorded',
            expects: 'none',
            body: [{ text: 'The fleet status is recorded.' }],
          },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps broad or enriched coord:send writes sheddable under critical pressure', () => {
    for (const args of [
      {
        to: ['*'],
        summary: 'broadcast',
        expects: 'none',
      },
      {
        to: ['@fleet:nonp2p-bug-drain-luna-max-50'],
        summary: 'audience',
        expects: 'none',
      },
      {
        to: ['@fleet-leader:'],
        summary: 'empty leader audience',
        expects: 'none',
      },
      {
        to: ['@topic:coordination'],
        summary: 'broad audience',
        expects: 'none',
      },
      {
        to: ['su-peer', 'su-other'],
        summary: 'multiple recipients',
        expects: 'none',
      },
      {
        to: ['su-peer'],
        summary: 'wake',
        expects: 'none',
        wake: 'required',
      },
      {
        to: ['su-peer'],
        summary: 'missing action body',
        expects: 'action',
      },
      {
        to: ['su-peer'],
        summary: 'enriched',
        expects: 'none',
        body: [{ text: 'status', premises: ['EI-1'] }],
      },
      {
        to: ['su-peer'],
        summary: 'x'.repeat(601),
        expects: 'none',
      },
    ]) {
      expect(classifyMcpBody(toolsCall(42, 'coord:send', args))).toEqual({ sheddable: true, id: 42 });
    }
  });

  it('keeps enriched coord:send and aliased work_items:comment sheddable through tools:invoke', () => {
    for (const [name, args] of [
      [
        'mcp__papercusp_su__coord_send',
        { to: ['su-peer'], summary: 'wake', expects: 'none', wake: 'required' },
      ],
      ['mcp__papercusp_su__work_items_comment', { id: 'EI-1', comment: 'alias' }],
    ] as const) {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 46,
        method: 'tools/call',
        params: { name: 'tools:invoke', arguments: { name, args } },
      });
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 46 });
      expect(classifyMcpRequest(body)).toBe('ordinary');
    }
  });

  it.each([
    ['canonical', 'work_items:comment'],
    ['underscore', 'work_items_comment'],
    ['mcp-advertised', 'mcp__papercusp_su__work_items_comment'],
  ])('admits one bounded direct work_items:comment under critical pressure: %s', (_label, name) => {
    const body = toolsCall(43, name, { id: 'EI-23122407516371253', body: 'Correction recorded.' });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('admits one bounded work_items:comment batch through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 44,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__work_items_comment',
          args: { items: [{ id: 'EI-23122407516371253', body: 'Correction recorded.' }] },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('admits a bounded acceptance-BAR approval receipt larger than the ordinary comment reserve', () => {
    const approval = {
      schemaVersion: 1,
      kind: 'acceptance-bar-amendment-approval',
      rubricRef: 'acceptance-plan',
      subjectPlan: 'subject-plan',
      bars: Array.from({ length: 4 }, (_, index) => ({
        barKey: `R-${index + 1}`,
        priorBarHash: 'a'.repeat(64),
        nextBarHash: 'b'.repeat(64),
      })),
    };
    const args = { id: 'EI-23122407516371253', body: JSON.stringify(approval) };
    expect(args.body.length).toBeGreaterThan(600);
    expect(isBoundedWorkItemsCommentArgs(args)).toBe(true);
    expect(classifyMcpBody(toolsCall(47, 'work_items:comment', args))).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(toolsCall(47, 'work_items:comment', args))).toBe('diagnostic');
  });

  it('keeps arbitrary long comments and malformed approval receipts sheddable', () => {
    const base = {
      schemaVersion: 1,
      kind: 'acceptance-bar-amendment-approval',
      rubricRef: 'acceptance-plan',
      subjectPlan: 'subject-plan',
      bars: [{ barKey: 'R-1', priorBarHash: 'a'.repeat(64), nextBarHash: 'b'.repeat(64) }],
    };
    for (const [index, body] of [
      'x'.repeat(601),
      JSON.stringify({ ...base, extra: 'x'.repeat(500) }),
      JSON.stringify({ ...base, bars: Array.from({ length: 33 }, (_, index) => ({
        barKey: `R-${index + 1}`,
        priorBarHash: 'a'.repeat(64),
        nextBarHash: 'b'.repeat(64),
      })) }),
      JSON.stringify({ ...base, bars: [{ barKey: 'R-1', priorBarHash: 'not-a-hash', nextBarHash: null }], extra: 'x'.repeat(500) }),
    ].entries()) {
      expect(isBoundedWorkItemsCommentArgs({ id: 'EI-1', body }), `case ${index}, body length ${body.length}`).toBe(false);
      expect(classifyMcpBody(toolsCall(48, 'work_items:comment', { id: 'EI-1', body }))).toEqual({
        sheddable: true,
        id: 48,
      });
    }
  });

  it('keeps bulk, aliases, and enriched work_items:comment writes sheddable under critical pressure', () => {
    for (const args of [
      { id: 'EI-1', comment: 'alias' },
      { id: 'EI-1', body: 'inline', harness: 'papercusp' },
      { items: [{ id: 'EI-1', body: 'one' }, { id: 'EI-2', body: 'two' }] },
      { items: [{ id: 'EI-1', comment: 'alias' }] },
      { id: 'EI-1', body: 'x'.repeat(601) },
    ]) {
      expect(classifyMcpBody(toolsCall(45, 'work_items:comment', args))).toEqual({ sheddable: true, id: 45 });
    }
  });

  it.each([
    ['canonical', 'scorecards:list'],
    ['underscore', 'scorecards_list'],
    ['mcp-advertised', 'mcp__papercusp_su__scorecards_list'],
  ])('does NOT shed an exact scorecard audit read under critical pressure: %s', (_label, name) => {
    const body = toolsCall(13, name, {
      rubricRef: 'grading-integrity',
      subjectRef: 'EI-22581128473264750',
      includeSuperseded: true,
      includeRetracted: true,
      limit: 1,
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('admits the reported exact 50-row spec audit read under critical pressure', async () => {
    const body = toolsCall(13, 'scorecards:list', {
      rubricRef: 'spec-test-adequacy',
      subjectRef: 'SPEC-P-025-LEADER-BRIEF-NEVER-DROP-FACTS@1',
      limit: 50,
      payloadTier: 'full',
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(await evaluateAdmission(post(body), 'critical', true)).toBeNull();
  });

  it('keeps broad or oversized scorecards:list reads sheddable under critical pressure', () => {
    for (const args of [
      { rubricRef: 'grading-integrity' },
      { subjectRef: 'EI-22581128473264750' },
      { rubricRef: 'grading-integrity', subjectRef: 'EI-22581128473264750', limit: 51 },
    ]) {
      expect(classifyMcpBody(toolsCall(14, 'scorecards:list', args))).toEqual({ sheddable: true, id: 14 });
    }
  });

  it('recognizes the exact scorecard audit through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__scorecards_list',
          args: { rubricRef: 'grading-integrity', subjectRef: 'EI-22581128473264750', limit: 1 },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['canonical', 'scorecards:evaluate'],
    ['underscore', 'scorecards_evaluate'],
    ['mcp-advertised', 'mcp__papercusp_su__scorecards_evaluate'],
  ])('does NOT shed a skeleton scorecards:evaluate read under critical pressure: %s', (_label, name) => {
    const body = toolsCall(16, name, { rubricRef: 'spec-test-adequacy' });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('recognizes an empty-ratings scorecards:evaluate skeleton through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 17,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__scorecards_evaluate',
          args: { rubricRef: 'spec-test-adequacy', ratings: {} },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps completed or opaque scorecards:evaluate payloads sheddable under critical pressure', () => {
    for (const args of [
      { rubricRef: 'spec-test-adequacy', ratings: { criterion: { rating: 'pass', evidence: 'evidence' } } },
      { rubricRef: 'spec-test-adequacy', instrumentSnapshots: {} },
      { rubricRef: 'spec-test-adequacy', testedSha: '01a80572c224' },
      { rubricRef: 'spec-test-adequacy', unknown: true },
    ]) {
      expect(classifyMcpBody(toolsCall(18, 'scorecards:evaluate', args))).toEqual({ sheddable: true, id: 18 });
    }
  });

  it.each([
    ['canonical', 'scorecards:get'],
    ['underscore', 'scorecards_get'],
    ['mcp-advertised', 'mcp__papercusp_su__scorecards_get'],
  ])('does NOT shed one scorecard evidence read under critical pressure: %s', (_label, name) => {
    const body = toolsCall(29, name, { issueId: 'EI-22581128473264750' });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('does NOT shed generated scorecard evidence pages under critical pressure', () => {
    for (const args of [
      { issueId: 'EI-22581128473264750', criterionKey: 'freshness' },
      { issueId: 'EI-22581128473264750', criterionKey: 'freshness', evidenceOffset: 1600 },
    ]) {
      const body = toolsCall(29, 'scorecards:get', args);
      expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
      expect(classifyMcpRequest(body)).toBe('diagnostic');
    }
  });

  it('keeps ambiguous or oversized scorecards:get reads sheddable under critical pressure', () => {
    for (const args of [
      {},
      { id: 'EI-22581128473264750' },
      { issueId: ' ' },
      { issueId: 'x'.repeat(121) },
      { issueId: 'EI-1', extra: true },
      { issueId: 'EI-1', evidenceOffset: 1600 },
      { issueId: 'EI-1', criterionKey: 'freshness', evidenceOffset: -1 },
    ]) {
      expect(classifyMcpBody(toolsCall(30, 'scorecards:get', args))).toEqual({ sheddable: true, id: 30 });
    }
  });

  it('recognizes one scorecard evidence read through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 31,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__scorecards_get',
          args: { issueId: 'EI-22581128473264750' },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('recognizes a paginated scorecard evidence read through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 31,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__scorecards_get',
          args: { issueId: 'EI-22581128473264750', criterionKey: 'freshness', evidenceOffset: 1600 },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['canonical', 'improvements:capture'],
    ['underscore', 'improvements_capture'],
    ['mcp-advertised', 'mcp__papercusp_su__improvements_capture'],
  ])('does NOT shed the bounded tool-failure capture shorthand under critical pressure: %s', (_label, name) => {
    const body = toolsCall(32, name, {
      toolFailure: {
        toolName: 'scorecards:get',
        errorCode: 'loop_pressure_critical',
        status: 429,
        message: 'operator MCP admission shed the scorecard evidence read',
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps authored, malformed, or oversized captures sheddable under critical pressure', () => {
    for (const args of [
      { title: 'operator admission shed a grading audit call', kind: 'bug' },
      {
        title: 'operator admission shed a grading audit call',
        toolFailure: { toolName: 'scorecards:get', message: 'shed' },
      },
      { toolFailure: { toolName: 'scorecards:get' } },
      { toolFailure: { toolName: 'scorecards:get', message: 'x'.repeat(4001) } },
    ]) {
      expect(classifyMcpBody(toolsCall(33, 'improvements:capture', args))).toEqual({ sheddable: true, id: 33 });
      expect(classifyMcpRequest(toolsCall(33, 'improvements:capture', args))).toBe('ordinary');
    }
  });

  it('recognizes the bounded tool-failure capture through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 34,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__improvements_capture',
          args: {
            toolFailure: { toolName: 'scorecards:get', message: 'operator MCP admission shed the read' },
          },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['canonical', 'rubrics:get'],
    ['underscore', 'rubrics_get'],
    ['mcp-advertised', 'mcp__papercusp_su__rubrics_get'],
  ])('does NOT shed a single full rubric read under critical pressure: %s', (_label, name) => {
    const body = toolsCall(16, name, { rubricRef: 'goal-mode-e2e' });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('keeps bulk or ambiguous rubrics:get reads sheddable under critical pressure', () => {
    for (const args of [
      { rubricRefs: ['goal-mode-e2e', 'grading-integrity'] },
      { rubricRef: 'goal-mode-e2e', rubricRefs: ['grading-integrity'] },
      { revision: 3 },
    ]) {
      const body = toolsCall(17, 'rubrics:get', args);
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 17 });
      expect(classifyMcpRequest(body)).toBe('ordinary');
    }
  });

  it('recognizes a single rubric read through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 18,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__rubrics_get',
          args: { rubricRef: 'goal-mode-e2e' },
        },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it('admits only bounded judge-role audit probes under critical pressure', () => {
    const cases = [
      [
        'plans:evaluate-spec-test-adequacy',
        { slug: 'adequacy-plan', classRef: 'plan-class-investigation', specIds: ['SPEC-001'], limit: 1 },
      ],
      ['gates:degenerate-check', { sinceHours: 24, minDecisions: 30 }],
      ['plans:get-specs', { slug: 'adequacy-plan', specIds: ['SPEC-001'] }],
      ['plans:get-spec-evidence', { slug: 'adequacy-plan', specIds: ['SPEC-001'], limit: 1 }],
    ] as const;
    for (const [name, args] of cases) {
      const body = toolsCall(23, name, args);
      expect(classifyMcpBody(body, judgeRequestUrl)).toEqual({ sheddable: false, id: null });
      expect(classifyMcpRequest(body, judgeRequestUrl)).toBe('diagnostic');
    }
  });

  it('admits the generated exact evaluator replay shape at the critical-pressure boundary', () => {
    const body = toolsCall(23, 'plans:evaluate-spec-test-adequacy', {
      harness: 'papercusp',
      slug: 'adequacy-plan',
      classRef: 'plan-class-investigation',
      evaluatorBuild: { sha: 'sha256:evaluator', version: '0.0.0' },
      specIds: ['SPEC-001'],
      evidenceRefs: ['test-run:42'],
      includeDraft: true,
      limit: 25,
      specRevision: 1,
      specFingerprint: 'sha256:spec',
      replaySnapshot: true,
      current: [],
    });
    expect(classifyMcpBody(body, judgeRequestUrl)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body, judgeRequestUrl)).toBe('diagnostic');
  });

  it('keeps generic, non-judge, and unbounded judge audit probes sheddable', () => {
    const cases = [
      ['plans:evaluate-spec-test-adequacy', { slug: 'adequacy-plan', classRef: 'plan-class-investigation' }],
      [
        'plans:evaluate-spec-test-adequacy',
        { slug: 'adequacy-plan', classRef: 'plan-class-investigation', specIds: ['SPEC-001'], limit: 26 },
      ],
      ['gates:degenerate-check', { sinceHours: 25 }],
      ['plans:get-specs', { slug: 'adequacy-plan' }],
      ['plans:get-specs', { slug: 'adequacy-plan', specIds: ['SPEC-001'], includeHistory: true }],
      ['plans:get-spec-evidence', { slug: 'adequacy-plan', specIds: ['SPEC-001'] }],
    ] as const;
    for (const [name, args] of cases) {
      const body = toolsCall(24, name, args);
      expect(classifyMcpBody(body, judgeRequestUrl)).toEqual({ sheddable: true, id: 24 });
      expect(classifyMcpRequest(body, judgeRequestUrl)).toBe('ordinary');
      expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 24 });
    }
  });

  it('recognizes bounded judge audit probes through tools:invoke', () => {
    for (const [name, args] of [
      [
        'plans:evaluate-spec-test-adequacy',
        { slug: 'adequacy-plan', classRef: 'plan-class-investigation', specIds: ['SPEC-001'], limit: 1 },
      ],
      ['gates:degenerate-check', { sinceHours: 24, minDecisions: 30 }],
      ['plans:get-specs', { slug: 'adequacy-plan', specIds: ['SPEC-001'] }],
      ['plans:get-spec-evidence', { slug: 'adequacy-plan', specIds: ['SPEC-001'], limit: 1 }],
    ] as const) {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 25,
        method: 'tools/call',
        params: { name: 'tools:invoke', arguments: { name, args } },
      });
      expect(classifyMcpBody(body, judgeRequestUrl)).toEqual({ sheddable: false, id: null });
      expect(classifyMcpRequest(body, judgeRequestUrl)).toBe('diagnostic');
    }
  });

  it('sheds the unbounded outer code:run wrapper while reserving a direct bounded scorecard probe', async () => {
    // code:run has a bounded script/foreground timeout, but its script may loop, branch, and
    // dispatch an unbounded number of nested tools during that window. The pressure gate must
    // classify that outer orchestration as ordinary even when its script happens to contain a
    // bounded-looking scorecards:get call; only the direct bounded probe gets the recovery lane.
    const outerBody = toolsCall(29, 'code:run', {
      script: [
        "const first = await tools.scorecards.get({ issueId: 'EI-22581128473264750' });",
        'for (const issueId of inputs.issueIds) await tools.scorecards.get({ issueId });',
        'return { found: Boolean(first), scanned: inputs.issueIds.length };',
      ].join('\n'),
      timeoutSec: 30,
    });
    expect(classifyMcpBody(outerBody, judgeRequestUrl)).toEqual({ sheddable: true, id: 29 });
    expect(classifyMcpRequest(outerBody, judgeRequestUrl)).toBe('ordinary');

    const shed = await evaluateAdmission(
      new Request(judgeRequestUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: outerBody,
      }),
      'critical',
      true,
    );
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });

    const direct = await evaluateAdmission(
      new Request(judgeRequestUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: toolsCall(30, 'scorecards:get', { issueId: 'EI-22581128473264750' }),
      }),
      'critical',
      true,
    );
    expect(direct).toBeNull();
  });

  it('recognizes tools:find through tools:invoke', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: { name: 'mcp__papercusp_su__tools_find', args: { query: 'grading integrity scorecard tools' } },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['uri', { uri: 'papercusp://scratch/papercusp-workspace/result.spill', byte_offset: 0, byte_limit: 4096 }],
    ['file_path', { file_path: '/home/builduser/.papercusp/scratch/papercusp-workspace/result.spill', byte_offset: 0, byte_limit: 4096 }],
    ['file_path markdown spill', { file_path: '/home/builduser/.papercusp/scratch/papercusp-workspace/result-door-1789368949483.md', byte_offset: 0, byte_limit: 4096 }],
  ])('recognizes bounded scratch capability:read through tools:invoke (%s)', (_shape, args) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: { name: 'mcp__papercusp_su__capability_read', args },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: false, id: null });
    expect(classifyMcpRequest(body)).toBe('diagnostic');
  });

  it.each([
    ['non-scratch path', { file_path: '/tmp/result.spill', byte_offset: 0, byte_limit: 4096 }],
    ['unsupported scratch extension', { file_path: '/home/builduser/.papercusp/scratch/papercusp-workspace/result.txt', byte_offset: 0, byte_limit: 4096 }],
    ['line window', { uri: 'papercusp://scratch/papercusp-workspace/result.spill', tail: 25 }],
    ['oversized page', { uri: 'papercusp://scratch/papercusp-workspace/result.spill', byte_offset: 0, byte_limit: 4097 }],
  ])('still sheds unsafe capability:read recovery shapes through tools:invoke (%s)', (_shape, args) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: { name: 'mcp__papercusp_su__capability_read', args },
      },
    });
    expect(classifyMcpBody(body)).toEqual({ sheddable: true, id: 15 });
    expect(classifyMcpRequest(body)).toBe('ordinary');
  });

  // The CONTROL for the case above: the exemption must stay an allowlist, not a prefix rule.
  // `dev:` is not a licence — a neighbouring dev tool with unread per-call cost must still shed,
  // or the narrow list quietly becomes "anything named dev:*".
  it.each(['dev:pipeline_position', 'dev:restart', 'dev:processes'])(
    'STILL sheds unlisted dev tool %s (the list is an allowlist, not a dev: prefix rule)',
    (name) => {
      expect(classifyMcpBody(toolsCall(12, name))).toEqual({ sheddable: true, id: 12 });
    },
  );
  it('sheds a batch that CONTAINS a tools/call and echoes the first call id', () => {
    const batch = JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x' } },
    ]);
    expect(classifyMcpBody(batch)).toEqual({ sheddable: true, id: 2 });
  });
  it('still sheds an ordinary call batched beside a reserved diagnostic and echoes the ordinary id', () => {
    const batch = JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'dev:pg_query' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'plans:get' } },
    ]);
    expect(classifyMcpBody(batch)).toEqual({ sheddable: true, id: 2 });
  });
  it('unparseable body → not sheddable (never shed blind)', () => {
    expect(classifyMcpBody('not json')).toEqual({ sheddable: false, id: null });
    expect(classifyMcpBody('')).toEqual({ sheddable: false, id: null });
  });
});

describe('shouldShedForPressure — critical band only, respects the kill-switch', () => {
  it('sheds only when enabled AND critical', () => {
    expect(shouldShedForPressure('critical', true)).toBe(true);
    expect(shouldShedForPressure('elevated', true)).toBe(false); // elevated still admits
    expect(shouldShedForPressure('ok', true)).toBe(false);
    expect(shouldShedForPressure('critical', false)).toBe(false); // kill-switch
  });
});

describe('operator capacity admission — bounded classes with a diagnostic reserve', () => {
  const capacity = {
    maxInFlight: 10,
    controlPlaneReserve: 2,
    diagnosticReserve: 1,
    maxHandshakes: 2,
  };

  it('classifies ordinary calls, handshakes, and the named health probe separately', () => {
    expect(classifyMcpRequest(toolsCall(1))).toBe('ordinary');
    expect(classifyMcpRequest(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize' }))).toBe('handshake');
    expect(classifyMcpRequest(toolsCall(3, 'dev:service_health'))).toBe('diagnostic');
    expect(
      classifyMcpRequest(
        JSON.stringify({ jsonrpc: '2.0', id: 'health', method: 'initialize' }),
        'http://127.0.0.1:3070/api/mcp?client=mcp-health',
      ),
    ).toBe('diagnostic');
  });

  it('sheds ordinary calls before the reserved control-plane and diagnostic slots', () => {
    expect(
      shouldShedForCapacity(
        'ordinary',
        { inFlight: 7, ordinaryInFlight: 7, handshakesInFlight: 0, diagnosticsInFlight: 0 },
        capacity,
      ),
    ).toBe(true); // 10 - (2 + 1) ordinary slots
    expect(
      shouldShedForCapacity(
        'handshake',
        { inFlight: 7, ordinaryInFlight: 7, handshakesInFlight: 0, diagnosticsInFlight: 0 },
        capacity,
      ),
    ).toBe(false);
    expect(
      shouldShedForCapacity(
        'diagnostic',
        { inFlight: 9, ordinaryInFlight: 7, handshakesInFlight: 2, diagnosticsInFlight: 0 },
        capacity,
      ),
    ).toBe(false);
  });

  it('keeps the handshake class bounded while retaining the diagnostic reserve', () => {
    expect(
      shouldShedForCapacity(
        'handshake',
        { inFlight: 8, ordinaryInFlight: 6, handshakesInFlight: 2, diagnosticsInFlight: 0 },
        capacity,
      ),
    ).toBe(true);
    expect(
      shouldShedForCapacity(
        'diagnostic',
        { inFlight: 9, ordinaryInFlight: 7, handshakesInFlight: 2, diagnosticsInFlight: 0 },
        capacity,
      ),
    ).toBe(false);
    expect(
      shouldShedForCapacity(
        'diagnostic',
        { inFlight: 10, ordinaryInFlight: 7, handshakesInFlight: 2, diagnosticsInFlight: 1 },
        capacity,
      ),
    ).toBe(true); // only the hard ceiling can shed diagnostics
  });

  it('leases operator work and releases it exactly once', async () => {
    const decision = await acquireAdmission(post(toolsCall(4)), 'ok', true);
    expect(decision.response).toBeNull();
    expect(decision.lease?.classification).toBe('ordinary');
    expect(getMcpAdmissionSnapshot()).toMatchObject({ inFlight: 1, ordinaryInFlight: 1 });
    decision.lease?.release();
    decision.lease?.release();
    expect(getMcpAdmissionSnapshot()).toEqual({
      inFlight: 0,
      handshakesInFlight: 0,
      diagnosticsInFlight: 0,
      ordinaryInFlight: 0,
    });
  });
});

describe('admissionShedResponse — a retryable 429 the proxy absorbs', () => {
  it('is a 429 with Retry-After and a JSON-RPC error envelope echoing the id', async () => {
    const res = admissionShedResponse(9);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('1'); // default
    const body = await res.json();
    expect(body).toMatchObject({ jsonrpc: '2.0', id: 9, error: { data: { retryable: true, reason: 'loop_pressure_critical' } } });
  });
  it('honors an explicit Retry-After', () => {
    expect(admissionShedResponse(null, 3).headers.get('retry-after')).toBe('3');
  });
});

describe('withMcpAdmission — handler-lifetime capacity lease', () => {
  it('holds the lease through handler completion and releases it afterward', async () => {
    let duringHandler: ReturnType<typeof getMcpAdmissionSnapshot> | undefined;
    const res = await withMcpAdmission(post(toolsCall(12)), 'ok', true, async () => {
      duringHandler = getMcpAdmissionSnapshot();
      return new Response('ok');
    });

    expect(res.status).toBe(200);
    expect(duringHandler).toMatchObject({ inFlight: 1, ordinaryInFlight: 1 });
    expect(getMcpAdmissionSnapshot()).toEqual({
      inFlight: 0,
      handshakesInFlight: 0,
      diagnosticsInFlight: 0,
      ordinaryInFlight: 0,
    });
  });

  it('releases the lease when the handler rejects', async () => {
    await expect(
      withMcpAdmission(post(toolsCall(13)), 'ok', true, async () => {
        throw new Error('handler failed');
      }),
    ).rejects.toThrow('handler failed');
    expect(getMcpAdmissionSnapshot()).toEqual({
      inFlight: 0,
      handshakesInFlight: 0,
      diagnosticsInFlight: 0,
      ordinaryInFlight: 0,
    });
  });

  it('does not invoke the handler when admission sheds the request', async () => {
    let invoked = false;
    const res = await withMcpAdmission(post(toolsCall(14)), 'critical', true, async () => {
      invoked = true;
      return new Response('unexpected');
    });

    expect(res.status).toBe(429);
    expect(invoked).toBe(false);
    expect(getMcpAdmissionSnapshot()).toMatchObject({ inFlight: 0 });
  });
});

describe('evaluateAdmission — end-to-end gate against a real Request', () => {
  it('sheds a POST tools/call under critical pressure and does NOT consume the body', async () => {
    const req = post(toolsCall(5));
    const res = await evaluateAdmission(req, 'critical', true);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
    // The gate peeked via req.clone() — the ORIGINAL body must still be readable by the handler.
    const passthroughBody = await req.text();
    expect(JSON.parse(passthroughBody).method).toBe('tools/call');
  });
  it('admits (null) when pressure is only elevated', async () => {
    expect(await evaluateAdmission(post(toolsCall()), 'elevated', true)).toBeNull();
  });
  it('admits (null) a non-tools/call even under critical pressure', async () => {
    const req = post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
  });
  it('admits bounded dev:pg_query under critical pressure so recovery diagnostics stay live', async () => {
    const req = post(toolsCall(6, 'dev:pg_query'));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('dev:pg_query');
  });
  it.each([
    ['canonical', 'dev:pg_active_queries'],
    ['underscore', 'dev_pg_active_queries'],
    ['mcp-advertised hyphen', 'mcp__papercusp-su__dev_pg_active_queries'],
    ['mcp-advertised underscore', 'mcp__papercusp_su__dev_pg_active_queries'],
  ])('admits bounded dev:pg_active_queries under critical pressure: %s', async (_label, name) => {
    const req = post(toolsCall(7, name, { limit: 50 }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe(name);
  });
  it('admits dev:pg_active_queries through deferred tools:invoke under critical pressure', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__dev_pg_active_queries',
          args: { limit: 50 },
        },
      },
    });
    const req = post(body);
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.arguments.name).toBe('mcp__papercusp_su__dev_pg_active_queries');
  });
  it('keeps the neighboring dev:pg_hot_queries diagnostic shed end-to-end', async () => {
    const shed = await evaluateAdmission(post(toolsCall(9, 'dev:pg_hot_queries')), 'critical', true);
    expect(shed).not.toBeNull();
    expect(shed!.status).toBe(429);
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('admits a bounded dev:telemetry rollup under critical pressure so recovery diagnostics stay live', async () => {
    const req = post(toolsCall(24, 'dev:telemetry', { hours: 24, limit: 50 }));
    expect(isBoundedDevTelemetryArgs({ hours: 24, limit: 50 })).toBe(true);
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('dev:telemetry');
  });
  it('keeps broad dev:telemetry queries shed under critical pressure', async () => {
    for (const args of [
      { hours: 24, limit: 51 },
      { hours: 25, limit: 50 },
      { limit: 50, unexpected: true },
      { hours: 24, limit: 50, workspaceIds: Array.from({ length: 33 }, (_, i) => `ws-${i}`) },
    ]) {
      expect(isBoundedDevTelemetryArgs(args)).toBe(false);
      const shed = await evaluateAdmission(post(toolsCall(25, 'dev:telemetry', args)), 'critical', true);
      expect(shed).not.toBeNull();
      expect((await shed!.json()).error.data).toMatchObject({
        retryable: true,
        reason: 'loop_pressure_critical',
      });
    }
  });
  it('admits bounded dev:telemetry through tools:invoke under critical pressure', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 26,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__dev_telemetry',
          args: { hours: 24, limit: 50 },
        },
      },
    });
    expect(await evaluateAdmission(post(body), 'critical', true)).toBeNull();
  });
  // EI-21574538947513211: the end-to-end shape of the reported failure. Asserted through
  // evaluateAdmission (not just the pure classifier) because the reported symptom was a real
  // 429 with reason 'loop_pressure_critical' reaching the caller — the classifier being right
  // would not have been enough if the gate still shed it downstream.
  it('admits dev:dogfood_substrate_status under critical pressure — the tool that OBSERVES the pressure must not be shed by it', async () => {
    const req = post(toolsCall(7, 'dev:dogfood_substrate_status'));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    // The body must survive the peek unconsumed, exactly as the pg_query case asserts.
    expect(JSON.parse(await req.text()).params.name).toBe('dev:dogfood_substrate_status');
  });
  it('admits a bounded capability:bash_output status read under critical pressure', async () => {
    const req = post(toolsCall(8, 'capability:bash_output', { task_id: '0mu01ke7h44mxhxn2ps' }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('capability:bash_output');
  });
  it('admits a bounded coord:declare-intent recovery declaration under critical pressure', async () => {
    const req = post(toolsCall(9, 'coord:declare-intent', {
      intent: 'resume the current fleet lane',
      current_plan_slug: 'recovery-plan',
      items: ['P-001'],
    }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('coord:declare-intent');
  });
  it('admits a bounded coord:inbox directed-mail recovery read under critical pressure', async () => {
    const req = post(toolsCall(10, 'coord:inbox', {
      directed: true,
      unanswered_only: true,
      limit: 10,
    }));
    expect(isBoundedCoordInboxArgs({ directed: true, unanswered_only: true, limit: 10 })).toBe(true);
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('coord:inbox');
  });
  it('admits a bounded backup:snapshot_list recovery read under critical pressure', async () => {
    const req = post(toolsCall(12, 'backup:snapshot_list', { limit: 50 }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('backup:snapshot_list');
  });
  it('admits a bounded locks:list recovery read under critical pressure', async () => {
    const req = post(toolsCall(13, 'locks:list', { resource: 'release-deploy' }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('locks:list');
  });
  it('still sheds an unfiltered coord:inbox read under critical pressure', async () => {
    const shed = await evaluateAdmission(post(toolsCall(11, 'coord:inbox')), 'critical', true);
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('admits a bounded locks:queue ownership read under critical pressure so recovery can inspect held files', async () => {
    const req = post(
      toolsCall(14, 'locks:queue', {
        paths: [
          'packages/operator-core/lib/release/frozen-repair-edit-ledger.ts',
          'packages/operator-core/lib/release/frozen-repair-edit-ledger.test.ts',
        ],
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('locks:queue');
  });
  it('admits a bounded single-lock locks:release under critical pressure and preserves the body', async () => {
    const req = post(toolsCall(16, 'locks:release', { lock_id: '551d8e36-bd4f-4eea-9ad8-42ba8a9c98d8' }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('locks:release');
  });
  it('still sheds bulk, selector, and enriched locks:release forms under critical pressure', async () => {
    const lockId = '551d8e36-bd4f-4eea-9ad8-42ba8a9c98d8';
    for (const args of [
      { lock_ids: [lockId] },
      { all_mine: true },
      { paths: ['packages/operator-core/lib/example.ts'] },
      { lock_id: lockId, coordination_domain: '/canonical/staging' },
    ]) {
      const shed = await evaluateAdmission(post(toolsCall(17, 'locks:release', args)), 'critical', true);
      expect(shed).not.toBeNull();
      expect((await shed!.json()).error.data).toMatchObject({
        retryable: true,
        reason: 'loop_pressure_critical',
      });
    }
  });
  it('still sheds an unfiltered locks:queue read under critical pressure', async () => {
    const shed = await evaluateAdmission(post(toolsCall(15, 'locks:queue')), 'critical', true);
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('admits a bounded single-item work_items:get under critical pressure so a drain can inspect its claim', async () => {
    const req = post(toolsCall(8, 'work_items:get', { id: 'EI-22381211295936796' }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('work_items:get');
  });
  it('admits a bounded detail-plus-thread work_items:get under critical pressure', async () => {
    const req = post(
      toolsCall(8, 'work_items:get', {
        id: 'EI-22381211295936796',
        detail: true,
        threadLimit: 10,
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.arguments).toMatchObject({
      id: 'EI-22381211295936796',
      detail: true,
      threadLimit: 10,
    });
  });
  it('admits a bounded caller-owned work_items:list under critical pressure and preserves the body', async () => {
    const req = post(
      toolsCall(19, 'work_items:list', {
        harness: 'papercusp',
        assignee: 'self',
        state: 'open',
        limit: 10,
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('work_items:list');
  });
  it('admits a bounded caller-owned work_items:list through tools:invoke under critical pressure', async () => {
    const req = post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: {
          name: 'tools:invoke',
          arguments: {
            name: 'mcp__papercusp_su__work_items_list',
            args: { mine: true, notTerminal: true, limit: 10 },
          },
        },
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('tools:invoke');
  });
  it('still sheds an unscoped work_items:list under critical pressure', async () => {
    const shed = await evaluateAdmission(
      post(toolsCall(21, 'work_items:list', { harness: 'papercusp', state: 'open', limit: 10 })),
      'critical',
      true,
    );
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('admits a bounded single-page docs:get under critical pressure so recovery can read the canonical runbook', async () => {
    const req = post(
      toolsCall(9, 'docs:get', {
        slugs: ['agent-insights/coordination/checkpoints-and-facts'],
        harness: 'engineering',
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('docs:get');
  });
  it('admits a bounded docs:get through tools:invoke under critical pressure', async () => {
    const req = post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'tools:invoke',
          arguments: {
            name: 'mcp__papercusp_su__docs_get',
            args: { slugs: ['agent-insights/coordination/checkpoints-and-facts'], harness: 'all' },
          },
        },
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('tools:invoke');
  });
  it('still sheds a batched docs:get under critical pressure', async () => {
    const shed = await evaluateAdmission(
      post(toolsCall(11, 'docs:get', { slugs: ['one', 'two'], harness: 'engineering' })),
      'critical',
      true,
    );
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('admits a bounded lexical-only docs:search under critical pressure', async () => {
    const req = post(
      toolsCall(12, 'docs:search', {
        query: 'find the recovery runbook for this lane',
        harness: 'engineering',
        limit: 5,
        semantic: false,
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('docs:search');
  });
  it('admits a bounded lexical-only docs:search through tools:invoke under critical pressure', async () => {
    const req = post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: {
          name: 'tools:invoke',
          arguments: {
            name: 'mcp__papercusp_su__docs_search',
            args: { query: 'find a recovery runbook', limit: 5, semantic: false },
          },
        },
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('tools:invoke');
  });
  it('still sheds semantic docs:search under critical pressure', async () => {
    const shed = await evaluateAdmission(
      post(toolsCall(14, 'docs:search', { query: 'find a recovery runbook', limit: 5 })),
      'critical',
      true,
    );
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('admits a bounded single-source search:fulltext under critical pressure', async () => {
    const req = post(
      toolsCall(52, 'search:fulltext', {
        query: 'find the prior admission-shed incident',
        scope: ['work_item'],
        harness_slug: 'papercusp',
        limit: 5,
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('search:fulltext');
  });
  it('admits bounded single-source search:fulltext through tools:invoke under critical pressure', async () => {
    const req = post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 53,
        method: 'tools/call',
        params: {
          name: 'tools:invoke',
          arguments: {
            name: 'mcp__papercusp_su__search_fulltext',
            args: { query: 'find a recovery incident', scope: ['work_item'], limit: 5 },
          },
        },
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('tools:invoke');
  });
  it('still sheds an unscoped search:fulltext under critical pressure', async () => {
    const shed = await evaluateAdmission(
      post(toolsCall(54, 'search:fulltext', { query: 'find a recovery incident', limit: 5 })),
      'critical',
      true,
    );
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('admits a bounded testing:run-status read under critical pressure so a detached test can be recovered', async () => {
    const req = post(toolsCall(39, 'testing:run-status', { runId: 'run-1' }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('testing:run-status');
  });
  it('admits a bounded lexical-only work_items:search under critical pressure', async () => {
    const req = post(
      toolsCall(46, 'work_items:search', {
        query: 'request shed during validation drain',
        harness: 'papercusp',
        kind: 'bug',
        limit: 5,
        semantic: false,
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('work_items:search');
  });
  it('admits a bounded lexical-only work_items:search through tools:invoke under critical pressure', async () => {
    const req = post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 47,
        method: 'tools/call',
        params: {
          name: 'tools:invoke',
          arguments: {
            name: 'mcp__papercusp_su__work_items_search',
            args: { query: 'request shed', semantic: false, limit: 5 },
          },
        },
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('tools:invoke');
  });
  it('admits a bounded lexical-only recipes:search under critical pressure', async () => {
    const req = post(
      toolsCall(53, 'recipes:search', {
        query: 'find the recovery recipe for this lane',
        limit: 5,
        semantic: false,
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('recipes:search');
  });
  it('admits a bounded lexical-only recipes:search through tools:invoke under critical pressure', async () => {
    const req = post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 54,
        method: 'tools/call',
        params: {
          name: 'tools:invoke',
          arguments: {
            name: 'mcp__papercusp_su__recipes_search',
            args: { query: 'find a recovery recipe', semantic: false, limit: 5 },
          },
        },
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('tools:invoke');
  });
  it('still sheds semantic recipes:search under critical pressure', async () => {
    const shed = await evaluateAdmission(
      post(toolsCall(55, 'recipes:search', { query: 'find a recovery recipe', limit: 5 })),
      'critical',
      true,
    );
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('still sheds semantic work_items:search under critical pressure', async () => {
    const shed = await evaluateAdmission(
      post(toolsCall(48, 'work_items:search', { query: 'request shed', limit: 5 })),
      'critical',
      true,
    );
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it.each([
    ['canonical', 'plans:search'],
    ['underscore alias', 'plans_search'],
    ['mcp-advertised alias', 'mcp__papercusp_su__plans_search'],
  ])('admits a bounded lexical-only plans:search under critical pressure: %s', async (_label, name) => {
    const args = {
      query: 'orient-recall-quality-2026-07-12',
      scope: ['slug', 'title'],
      limit: 5,
      semantic: false,
    };
    expect(isBoundedPlansSearchArgs(args)).toBe(true);
    const req = post(toolsCall(49, name, args));
    expect(classifyMcpRequest(await req.clone().text())).toBe('diagnostic');
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe(name);
  });
  it('admits a bounded lexical-only plans:search through tools:invoke under critical pressure', async () => {
    const req = post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 50,
        method: 'tools/call',
        params: {
          name: 'tools:invoke',
          arguments: {
            name: 'mcp__papercusp_su__plans_search',
            args: { q: 'orient-recall-quality-2026-07-12', scope: 'slug', limit: 5, semantic: false },
          },
        },
      }),
    );
    expect(isBoundedPlansSearchArgs({ q: 'orient-recall-quality-2026-07-12', scope: 'slug', limit: 5, semantic: false })).toBe(true);
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('tools:invoke');
  });
  it('still sheds semantic, broad, malformed, and oversized plans:search forms under critical pressure', async () => {
    for (const args of [
      { query: 'orient-recall-quality', limit: 5 },
      { query: 'orient-recall-quality', limit: 5, semantic: true },
      { query: 'orient-recall-quality', limit: 21, semantic: false },
      { query: 'orient-recall-quality', scope: ['unknown'], semantic: false },
      { query: 'x'.repeat(401), semantic: false },
      { query: 'orient-recall-quality', semantic: false, extra: true },
    ]) {
      expect(isBoundedPlansSearchArgs(args)).toBe(false);
      const shed = await evaluateAdmission(post(toolsCall(51, 'plans:search', args)), 'critical', true);
      expect(shed).not.toBeNull();
      expect((await shed!.json()).error.data).toMatchObject({
        retryable: true,
        reason: 'loop_pressure_critical',
      });
    }
  });
  it('admits a bounded read-only git-sync:run preview under critical pressure', async () => {
    const req = post(
      toolsCall(42, 'git-sync:run', {
        installSlug: 'papercusp',
        dryRun: true,
        reason: 'inspect the selected staging checkout',
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('git-sync:run');
  });
  it('still sheds a commit-capable git-sync:run call under critical pressure', async () => {
    const shed = await evaluateAdmission(
      post(toolsCall(43, 'git-sync:run', { installSlug: 'papercusp', reason: 'commit current staging' })),
      'critical',
      true,
    );
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('admits session:request-compaction directly under critical pressure', async () => {
    const req = post(
      toolsCall(44, 'session:request-compaction', {
        focus: 'resume the current lane',
        autoContinue: true,
        resumeMode: 'same',
        reason: 'clean stopping point',
        respawn: true,
        continueNote: 'Re-orient from the carry document and resume the current lane.',
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('session:request-compaction');
  });
  it('admits session:request-compaction through tools:invoke under critical pressure', async () => {
    const req = post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 45,
        method: 'tools/call',
        params: {
          name: 'tools:invoke',
          arguments: {
            name: 'mcp__papercusp_su__session_request_compaction',
            args: { focus: 'resume the current lane', autoContinue: true, resumeMode: 'same' },
          },
        },
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('tools:invoke');
  });
  it('admits bounded post-compaction sessions:search self-recall under critical pressure', async () => {
    const req = post(toolsCall(40, 'sessions:search', {
      query: 'resume the current lane',
      session: 'self',
      mode: 'verbatim',
      limit: 1,
      context: 0,
    }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('sessions:search');
  });
  it('still sheds broad sessions:search under critical pressure', async () => {
    const shed = await evaluateAdmission(
      post(toolsCall(41, 'sessions:search', { query: 'resume the current lane', session: 'self' })),
      'critical',
      true,
    );
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('admits a bounded sessions:timeline stale-wake read under critical pressure', async () => {
    const req = post(toolsCall(42, 'sessions:timeline', {
      owner: 'self',
      since: '2026-09-14T07:00:00Z',
      limit: 100,
      kinds: ['tool', 'coord'],
      include_auto: true,
      projection: { pick: ['entries[].ts'] },
    }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('sessions:timeline');
  });
  it('admits bounded sessions:timeline calls with parsed projections through tools:invoke under critical pressure', async () => {
    const commonArgs = {
      owner: 'self',
      since: '2026-10-02T07:04:17.197Z',
      limit: 100,
      kinds: ['tool'],
      goalRef: 'WI-10005166',
      group_repeated: true,
    };
    for (const pick of [
      ['entries[].ts', 'entries[].tool_name', 'entries[].status', 'entries[].text'],
      ['ts', 'tool_name', 'status'],
    ]) {
      const targetArgs = { ...commonArgs, projection: { pick } };
      const req = post(JSON.stringify({
        jsonrpc: '2.0',
        id: 46,
        method: 'tools/call',
        params: {
          name: 'tools:invoke',
          arguments: {
            name: 'mcp__papercusp_su__sessions_timeline',
            args: targetArgs,
          },
        },
      }));
      expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
      expect(JSON.parse(await req.text()).params.arguments.args).toEqual(targetArgs);
    }
  });
  it('keeps invalid sessions:timeline projections outside the critical-pressure diagnostic reserve', () => {
    expect(isBoundedSessionsTimelineArgs({
      owner: 'self',
      limit: 100,
      projection: { pick: [] },
    })).toBe(false);
  });
  it('still sheds an unbounded sessions:timeline read under critical pressure', async () => {
    const shed = await evaluateAdmission(
      post(toolsCall(43, 'sessions:timeline', { owner: 'self', limit: 101 })),
      'critical',
      true,
    );
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('admits a bounded heading-narrowed plans:get under critical pressure', async () => {
    const req = post(toolsCall(38, 'plans:get', {
      slug: 'portal-voice-parity-and-release-2026-09-08',
      harness: 'papercusp',
      heading: 'Decisions',
      mode: 'sections',
      detail: 'full',
    }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('plans:get');
  });
  it('admits a bounded scheduler self-pull under critical pressure for direct staging calls', async () => {
    const req = post(toolsCall(17, 'scheduler:get_next', {
      harness: 'papercusp',
      heldPaths: [],
      states: ['open'],
      rigAvailable: false,
    }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('scheduler:get_next');
  });
  it('admits a bounded loop status read under critical pressure for resumed reconciliation', async () => {
    const req = post(toolsCall(22, 'loop:status', { ownerId: 'self' }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('loop:status');
  });
  it('admits a bounded loop arm under critical pressure so a cold wake can restore its cadence', async () => {
    const req = post(toolsCall(23, 'loop:arm', {
      intervalSec: 60,
      goal: 'resume the current fleet work item',
      workItem: 'EI-23122062573237933',
      carry: 'cold',
    }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('loop:arm');
  });
  it('admits a deferred bounded loop arm under critical pressure', async () => {
    const req = post(JSON.stringify({
      jsonrpc: '2.0',
      id: 24,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__loop_arm',
          args: {
            intervalSec: 60,
            goal: 'resume the current fleet work item',
            workItem: null,
            carry: 'cold',
          },
        },
      },
    }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('tools:invoke');
  });
  it('still sheds an unbounded loop arm under critical pressure', async () => {
    const shed = await evaluateAdmission(
      post(toolsCall(25, 'loop:arm', {
        intervalSec: 60,
        goal: 'resume the current fleet work item',
        wakePrompt: 'custom wake',
      })),
      'critical',
      true,
    );
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });

  it.each([
    ['await id', { await_id: 178337 }],
    ['exact event', { event: 'work-item:done:EI-23109903341283549', after_generation: 7 }],
  ])('admits bounded events:status %s under critical pressure', async (_label, args) => {
    const req = post(toolsCall(28, 'events:status', args));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('events:status');
  });

  it('admits deferred bounded events:status under critical pressure', async () => {
    const req = post(JSON.stringify({
      jsonrpc: '2.0',
      id: 29,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__events_status',
          args: { await_id: 178337 },
        },
      },
    }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('tools:invoke');
  });

  it('still sheds a loop status read with an unknown argument under critical pressure', async () => {
    const shed = await evaluateAdmission(
      post(toolsCall(23, 'loop:status', { unknown: true })),
      'critical',
      true,
    );
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('still sheds a broad events:status read under critical pressure', async () => {
    const shed = await evaluateAdmission(post(toolsCall(30, 'events:status', {})), 'critical', true);
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('still sheds an unbounded scheduler self-pull under critical pressure', async () => {
    const shed = await evaluateAdmission(
      post(toolsCall(18, 'scheduler:get_next', { harness: 'papercusp', extra: 'unbounded' })),
      'critical',
      true,
    );
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('admits a single work_items:checkpoint under critical pressure so recovery state can be persisted', async () => {
    const req = post(toolsCall(19, 'work_items:checkpoint', {
      id: 'WI-10000745',
      checkpoint: 'resume from this boundary',
    }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('work_items:checkpoint');
  });
  it('admits a deferred single work_items:checkpoint under critical pressure', async () => {
    const req = post(JSON.stringify({
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__work_items_checkpoint',
          args: { id: 'WI-10000745', checkpoint: 'resume from this boundary' },
        },
      },
    }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('tools:invoke');
  });
  it('admits a bounded loop:checkpoint under critical pressure so carry state can be persisted', async () => {
    const req = post(toolsCall(20, 'loop:checkpoint', {
      did: 'persist the current wake state',
      left: 'resume the current lane',
      next: 'pull the next admitted item',
    }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('loop:checkpoint');
  });
  it('admits a bounded loop:checkpoint through tools:invoke under critical pressure', async () => {
    const req = post(JSON.stringify({
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: {
        name: 'tools:invoke',
        arguments: {
          name: 'mcp__papercusp_su__loop_checkpoint',
          args: { did: 'persist the current wake state', next: 'resume the lane' },
        },
      },
    }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('tools:invoke');
  });
  it('still sheds an unsafe loop:checkpoint recovery payload under critical pressure', async () => {
    const shed = await evaluateAdmission(
      post(toolsCall(22, 'loop:checkpoint', { read: true })),
      'critical',
      true,
    );
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('admits a bounded single work_items:set_state under critical pressure', async () => {
    const req = post(toolsCall(22, 'work_items:set_state', { id: 'WI-10000607', state: 'wip' }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('work_items:set_state');
  });
  it('still sheds bulk work_items:set_state under critical pressure', async () => {
    const shed = await evaluateAdmission(
      post(toolsCall(23, 'work_items:set_state', { ids: ['WI-1', 'WI-2'], state: 'wip' })),
      'critical',
      true,
    );
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('still sheds a bulk work_items:checkpoint under critical pressure', async () => {
    const shed = await evaluateAdmission(
      post(toolsCall(20, 'work_items:checkpoint', {
        items: [
          { id: 'WI-1', checkpoint: 'first' },
          { id: 'WI-2', checkpoint: 'second' },
        ],
      })),
      'critical',
      true,
    );
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('admits tools:find under critical pressure so discovery can locate recovery tools', async () => {
    const req = post(toolsCall(8, 'tools:find', { query: 'grading integrity scorecard tools' }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('tools:find');
  });
  it('admits tools:find through tools:invoke under critical pressure', async () => {
    const req = post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: 'tools:invoke',
          arguments: { name: 'mcp__papercusp_su__tools_find', args: { query: 'grading integrity scorecard tools' } },
        },
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('tools:invoke');
  });
  it('admits an exact scorecard audit through tools:invoke under critical pressure', async () => {
    const req = post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 15,
        method: 'tools/call',
        params: {
          name: 'tools:invoke',
          arguments: {
            name: 'scorecards:list',
            args: { rubricRef: 'grading-integrity', subjectRef: 'EI-22581128473264750', limit: 1 },
          },
        },
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('tools:invoke');
  });
  it('admits one scorecard evidence read under critical pressure', async () => {
    const req = post(toolsCall(35, 'scorecards:get', { issueId: 'EI-22581128473264750' }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('scorecards:get');
  });
  it('admits the bounded tool-failure capture under critical pressure', async () => {
    const req = post(
      toolsCall(36, 'improvements:capture', {
        toolFailure: { toolName: 'scorecards:get', message: 'operator MCP admission shed the read' },
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('improvements:capture');
  });
  it('still sheds an authored improvements:capture under critical pressure', async () => {
    const shed = await evaluateAdmission(
      post(toolsCall(37, 'improvements:capture', { title: 'operator admission shed a grading audit call' })),
      'critical',
      true,
    );
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('admits a single rubric read through tools:invoke under critical pressure', async () => {
    const req = post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 16,
        method: 'tools/call',
        params: {
          name: 'tools:invoke',
          arguments: {
            name: 'mcp__papercusp_su__rubrics_get',
            args: { rubricRef: 'goal-mode-e2e' },
          },
        },
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('tools:invoke');
  });
  it('still sheds a bulk rubric read through tools:invoke under critical pressure', async () => {
    const shed = await evaluateAdmission(
      post(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 17,
          method: 'tools/call',
          params: {
            name: 'tools:invoke',
            arguments: {
              name: 'rubrics:get',
              args: { rubricRefs: ['goal-mode-e2e', 'grading-integrity'] },
            },
          },
        }),
      ),
      'critical',
      true,
    );
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('admits the three bounded judge audit probes under critical pressure', async () => {
    for (const [name, args] of [
      [
        'plans:evaluate-spec-test-adequacy',
        { slug: 'adequacy-plan', classRef: 'plan-class-investigation', specIds: ['SPEC-001'], limit: 1 },
      ],
      ['gates:degenerate-check', { sinceHours: 24, minDecisions: 30 }],
      ['plans:get-specs', { slug: 'adequacy-plan', specIds: ['SPEC-001'] }],
      ['plans:get-spec-evidence', { slug: 'adequacy-plan', specIds: ['SPEC-001'], limit: 1 }],
    ] as const) {
      const req = new Request(judgeRequestUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: toolsCall(26, name, args),
      });
      expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    }
  });
  it('still sheds unbounded judge audit probes and bounded probes without judge role', async () => {
    const generic = await evaluateAdmission(
      post(
        toolsCall(27, 'plans:evaluate-spec-test-adequacy', {
          slug: 'adequacy-plan',
          classRef: 'plan-class-investigation',
          specIds: ['SPEC-001'],
        }),
      ),
      'critical',
      true,
    );
    expect(generic).not.toBeNull();
    const genericSpecs = await evaluateAdmission(
      post(toolsCall(28, 'plans:get-specs', { slug: 'adequacy-plan', specIds: ['SPEC-001'] })),
      'critical',
      true,
    );
    expect(genericSpecs).not.toBeNull();
    const nonJudge = await evaluateAdmission(
      post(toolsCall(29, 'plans:get-spec-evidence', { slug: 'adequacy-plan', specIds: ['SPEC-001'], limit: 1 })),
      'critical',
      true,
    );
    expect(nonJudge).not.toBeNull();
    expect((await nonJudge!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('admits bounded scratch capability:read through tools:invoke under critical pressure', async () => {
    const req = post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 14,
        method: 'tools/call',
        params: {
          name: 'tools:invoke',
          arguments: {
            name: 'mcp__papercusp_su__capability_read',
            args: {
              uri: 'papercusp://scratch/papercusp-workspace/result.spill',
              byte_offset: 0,
              byte_limit: 4096,
            },
          },
        },
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.name).toBe('tools:invoke');
  });
  it('admits a markdown result-door spill page through tools:invoke under critical pressure', async () => {
    const req = post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 41,
        method: 'tools/call',
        params: {
          name: 'tools:invoke',
          arguments: {
            name: 'mcp__papercusp_su__capability_read',
            args: {
              file_path: '/home/builduser/.papercusp/scratch/papercusp-workspace/result-door-1789368949483.md',
              byte_offset: 0,
              byte_limit: 4096,
            },
          },
        },
      }),
    );
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
    expect(JSON.parse(await req.text()).params.arguments.args.file_path).toMatch(/\.md$/);
  });
  it('admits bounded content-index selection through direct and deferred capability:read calls under critical pressure', async () => {
    const args = {
      uri: 'papercusp://scratch/papercusp-workspace/result.spill',
      content_indexes: [1],
      raw: true,
    };
    const direct = post(toolsCall(42, 'capability:read', args));
    expect(classifyMcpRequest(await direct.clone().text())).toBe('diagnostic');
    expect(await evaluateAdmission(direct, 'critical', true)).toBeNull();

    const deferred = post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 43,
        method: 'tools/call',
        params: {
          name: 'tools:invoke',
          arguments: { name: 'mcp__papercusp_su__capability_read', args },
        },
      }),
    );
    expect(classifyMcpRequest(await deferred.clone().text())).toBe('diagnostic');
    expect(await evaluateAdmission(deferred, 'critical', true)).toBeNull();
  });
  it('keeps malformed or mixed content-index capability:read calls shed under critical pressure', async () => {
    const reference = 'papercusp://scratch/papercusp-workspace/result.spill';
    const cases: Record<string, unknown>[] = [
      { uri: reference, content_indexes: [] },
      { uri: reference, content_indexes: Array.from({ length: 65 }, (_, index) => index) },
      { uri: reference, content_indexes: [-1] },
      { uri: reference, content_indexes: [1.5] },
      { uri: reference, content_indexes: [1], byte_offset: 0, byte_limit: 1 },
      { uri: reference, content_indexes: [1], offset: 1 },
      { uri: reference, content_indexes: [1], evidence_class: 'event' },
      { uri: reference, file_path: reference, content_indexes: [1] },
      { uri: reference, content_indexes: [1], raw: 'true' },
      { uri: reference, content_indexes: [1], unexpected: true },
    ];
    for (const args of cases) {
      const shed = await evaluateAdmission(post(toolsCall(44, 'capability:read', args)), 'critical', true);
      expect(shed).not.toBeNull();
      expect((await shed!.json()).error.data).toMatchObject({
        retryable: true,
        reason: 'loop_pressure_critical',
      });
    }
  });
  it('still sheds an unbounded work_items:get read under critical pressure', async () => {
    const shed = await evaluateAdmission(
      post(toolsCall(9, 'work_items:get', { ids: ['EI-1', 'EI-2'] })),
      'critical',
      true,
    );
    expect(shed).not.toBeNull();
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('CONTROL: still sheds an unlisted dev tool under critical pressure with reason loop_pressure_critical', async () => {
    const shed = await evaluateAdmission(post(toolsCall(8, 'dev:pipeline_position')), 'critical', true);
    // Proves the admission above is the ALLOWLIST working, not critical-pressure shedding
    // having stopped working altogether — without this, the test above would still pass if the
    // gate were disabled entirely.
    expect(shed).not.toBeNull();
    expect(shed!.status).toBe(429);
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('CONTROL: still sheds generic capability:bash under critical pressure', async () => {
    const shed = await evaluateAdmission(post(toolsCall(53, 'capability:bash', { command: 'printf test' })), 'critical', true);
    expect(shed).not.toBeNull();
    expect(shed!.status).toBe(429);
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('still sheds the expensive storage:usage read under critical pressure', async () => {
    // storage:usage combines PG catalog/age queries with on-disk walking under
    // a 30-second aggregate budget, so it is intentionally not a bounded
    // pressure diagnostic and must remain behind the critical-pressure gate.
    const shed = await evaluateAdmission(post(toolsCall(52, 'storage:usage')), 'critical', true);
    expect(shed).not.toBeNull();
    expect(shed!.status).toBe(429);
    expect((await shed!.json()).error.data).toMatchObject({
      retryable: true,
      reason: 'loop_pressure_critical',
    });
  });
  it('admits (null) when the kill-switch disables admission control', async () => {
    expect(await evaluateAdmission(post(toolsCall()), 'critical', false)).toBeNull();
  });
  it('never sheds a GET (SSE reconnect / discovery), even critical', async () => {
    const get = new Request('http://127.0.0.1:3070/api/mcp', { method: 'GET' });
    expect(await evaluateAdmission(get, 'critical', true)).toBeNull();
  });
});

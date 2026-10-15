import { describe, expect, it } from 'vitest';
import {
  assessTriggerPackDrill,
  readTriggerPackDrillRows,
  type DrillQuery,
  type DrillRows,
} from './trigger-pack-drill-evidence';

// Identifiers and row shapes copied from the BD003 drill (2026-10-12: the `slack` package
// plus the `bug-triage` trigger pack), trimmed to the judged fields.
const SOURCE = 'f0566e25-ec24-4c51-8388-74ebf49fb6fc';
const INSTALLED = '68b68066-ce37-4550-adf7-ea4824b108fa';
const IN_APP = '7c3c95c0-1111-4222-8333-444455556666';
const CHANNEL = 'C0C8836LU5C';
const MESSAGE = '1791775809.184469';
const DESTINATION = '1219381686283984';

const ids = {
  workspaceId: 'papercusp-workspace',
  sourceKind: 'slack',
  channelId: CHANNEL,
  messageId: MESSAGE,
  sourceId: SOURCE,
  installedBindingId: INSTALLED,
  inAppBindingId: IN_APP,
  windowStart: '2026-10-12T03:25:00Z',
  windowEnd: '2026-10-12T03:45:00Z',
};

function rows(): DrillRows {
  return {
    source: { id: SOURCE, kind: 'slack', credentialRef: 'provider-setup:slack', status: 'connected', lastError: null },
    bindings: [
      {
        id: INSTALLED,
        sourceId: SOURCE,
        planSlug: 'bug-triage',
        armed: true,
        datatypeId: 'chat-message',
        packInstallationId: '2e0593bb-17cc-4f27-bb68-5ef62cc9ea3c',
        action: { type: 'launch-plan', input: { channels: [CHANNEL], destination: DESTINATION } },
      },
      { id: IN_APP, sourceId: SOURCE, planSlug: 'slack-classify-bug-2026-10-08', armed: false, datatypeId: 'chat-message', packInstallationId: null, action: {} },
    ],
    runs: [
      {
        id: '6bdb0d6b-5fd7-4de5-825a-836e2e5da217',
        bindingId: INSTALLED,
        dedupeKey: `connector:${SOURCE}:chat-message:${CHANNEL}:${MESSAGE}:cbb73030f3961da1e00878017768ec28`,
        status: 'succeeded',
        triggeredAt: '2026-10-12T03:30:10.612Z',
        outcome: {
          minted: 1,
          replayed: false,
          planRunId: 1335,
          ticketFiling: {
            state: 'created',
            containerId: DESTINATION,
            externalRef: '1219394945745672',
            url: `https://app.asana.com/1/1219197493738449/project/${DESTINATION}/task/1219394945745672`,
          },
        },
      },
    ],
  };
}

const statusOf = (r: DrillRows, id: string, drillIds: typeof ids = ids) =>
  assessTriggerPackDrill(drillIds, r).checks.find((c) => c.id === id)!.status;

describe('trigger-pack live-drill assessor', () => {
  it('passes the BD003 rows: package source, one installed run, one ticket in the chosen project, in-app path silent', () => {
    const a = assessTriggerPackDrill(ids, rows());
    expect(a.checks.map((c) => [c.id, c.status])).toEqual([
      ['package-socket-path', 'pass'],
      ['chat-message-recorded', 'pass'],
      ['one-run-from-installed-binding', 'pass'],
      ['one-ticket-in-chosen-project', 'pass'],
      ['in-app-path-silent', 'pass'],
    ]);
    expect(a.status).toBe('pass');
    expect(a.kind).toBe('trigger-pack-drill-assessment');
    expect(a.sourceKind).toBe('slack');
    expect(a.planRunId).toBe(1335);
    expect(a.ticket).toEqual({ containerId: DESTINATION, externalRef: '1219394945745672', url: expect.stringContaining('/task/1219394945745672') });
  });

  it('fails package-socket-path when the source still uses the in-app credential', () => {
    const r = rows();
    r.source!.credentialRef = 'slack-bot-token:legacy';
    expect(statusOf(r, 'package-socket-path')).toBe('fail');
    expect(assessTriggerPackDrill(ids, r).status).toBe('fail');
  });

  it('fails package-socket-path when the source is disconnected or erroring', () => {
    const r = rows();
    r.source!.lastError = 'invalid_auth';
    expect(statusOf(r, 'package-socket-path')).toBe('fail');
  });

  it('fails package-socket-path when the source is not the declared provider kind', () => {
    expect(statusOf(rows(), 'package-socket-path', { ...ids, sourceKind: 'discord' })).toBe('fail');
    const r = rows();
    r.source!.kind = 'discord';
    expect(statusOf(r, 'package-socket-path')).toBe('fail');
  });

  it('fails chat-message-recorded when the run came from a different channel or message', () => {
    const r = rows();
    r.runs[0]!.dedupeKey = `connector:${SOURCE}:chat-message:COTHER:${MESSAGE}:x`;
    expect(statusOf(r, 'chat-message-recorded')).toBe('fail');
    const longer = rows();
    longer.runs[0]!.dedupeKey = `connector:${SOURCE}:chat-message:${CHANNEL}:${MESSAGE}9:x`;
    expect(statusOf(longer, 'chat-message-recorded')).toBe('fail');
  });

  it('fails one-run-from-installed-binding on a duplicate run', () => {
    const r = rows();
    r.runs.push({ ...r.runs[0]!, id: 'dup-run', dedupeKey: `${r.runs[0]!.dedupeKey}-dup` });
    expect(statusOf(r, 'one-run-from-installed-binding')).toBe('fail');
    expect(statusOf(r, 'chat-message-recorded')).toBe('fail');
  });

  it('fails one-run-from-installed-binding when the binding is not armed or not from an installation', () => {
    const disarmed = rows();
    disarmed.bindings[0]!.armed = false;
    expect(statusOf(disarmed, 'one-run-from-installed-binding')).toBe('fail');
    const handMade = rows();
    handMade.bindings[0]!.packInstallationId = null;
    expect(statusOf(handMade, 'one-run-from-installed-binding')).toBe('fail');
  });

  it('fails one-run-from-installed-binding when the run failed or minted nothing', () => {
    const r = rows();
    r.runs[0]!.status = 'failed';
    expect(statusOf(r, 'one-run-from-installed-binding')).toBe('fail');
    const replay = rows();
    (replay.runs[0]!.outcome as Record<string, unknown>).replayed = true;
    expect(statusOf(replay, 'one-run-from-installed-binding')).toBe('fail');
  });

  it('fails one-ticket-in-chosen-project when the ticket landed outside the installation destination', () => {
    const r = rows();
    ((r.runs[0]!.outcome as Record<string, unknown>).ticketFiling as Record<string, unknown>).containerId = '999';
    const a = assessTriggerPackDrill(ids, r);
    expect(a.checks.find((c) => c.id === 'one-ticket-in-chosen-project')!.status).toBe('fail');
    expect(a.ticket).toBeNull();
  });

  it('fails one-ticket-in-chosen-project when no ticket was created', () => {
    const r = rows();
    delete (r.runs[0]!.outcome as Record<string, unknown>).ticketFiling;
    expect(statusOf(r, 'one-ticket-in-chosen-project')).toBe('fail');
  });

  it('fails in-app-path-silent when the removed in-app binding is armed or ran', () => {
    const armed = rows();
    armed.bindings[1]!.armed = true;
    expect(statusOf(armed, 'in-app-path-silent')).toBe('fail');
    const ran = rows();
    ran.runs.push({ ...ran.runs[0]!, id: 'in-app-run', bindingId: IN_APP });
    expect(statusOf(ran, 'in-app-path-silent')).toBe('fail');
  });

  it('refuses malformed drill identifiers', () => {
    expect(() => assessTriggerPackDrill({ ...ids, messageId: 'has:colon' }, rows())).toThrow();
    expect(() => assessTriggerPackDrill({ ...ids, sourceKind: '' }, rows())).toThrow();
    const { sourceKind: _omitted, ...withoutKind } = ids;
    expect(() => assessTriggerPackDrill(withoutKind, rows())).toThrow();
  });
});

describe('trigger-pack live-drill row reader', () => {
  it('scopes every read to the workspace, both bindings and the window, and maps rows to the assessor shape', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const r = rows();
    const query: DrillQuery = async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('data_sources')) {
        return [{ id: SOURCE, kind: 'slack', credential_ref: 'provider-setup:slack', status: 'connected', last_error: null }];
      }
      if (sql.includes('trigger_bindings')) {
        return r.bindings.map((b) => ({
          id: b.id, source_id: b.sourceId, plan_slug: b.planSlug, armed: b.armed, datatype_id: b.datatypeId,
          pack_installation_id: b.packInstallationId, action: b.action,
        }));
      }
      return r.runs.map((x) => ({
        id: x.id, binding_id: x.bindingId, dedupe_key: x.dedupeKey, status: x.status,
        triggered_at: new Date(x.triggeredAt), outcome: x.outcome,
      }));
    };
    const read = await readTriggerPackDrillRows(query, ids);
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c.params[0]).toBe('papercusp-workspace');
    expect(calls.find((c) => c.sql.includes('trigger_runs'))!.params).toEqual([
      'papercusp-workspace', [INSTALLED, IN_APP], ids.windowStart, ids.windowEnd,
    ]);
    expect(read).toEqual(r);
    expect(assessTriggerPackDrill(ids, read).status).toBe('pass');
  });

  it('reports a missing source as a failing check rather than throwing', async () => {
    const query: DrillQuery = async () => [];
    const read = await readTriggerPackDrillRows(query, ids);
    const a = assessTriggerPackDrill(ids, read);
    expect(a.status).toBe('fail');
    expect(a.checks.every((c) => c.status === 'fail')).toBe(true);
  });
});

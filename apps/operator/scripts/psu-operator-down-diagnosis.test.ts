/**
 * psu-operator-down-diagnosis.test.ts — WI-10006057.
 *
 * After the 2026-10-05 reboot psu sat silent for ~90s and then printed only
 * `mcp_proxy_upstream_unavailable — connect ECONNREFUSED 127.0.0.1:3170`. The
 * cause (papercusp-staging-api's start job queued behind default.target, which
 * waited on papercusp-bg-host) was one systemctl call away. These tests pin the
 * diagnosis against systemctl output in the exact formats systemd 255 prints
 * (captured on this box), with a fake runner so nothing touches real units.
 *
 * Run: cd apps/operator && npx vitest run scripts/psu-operator-down-diagnosis.test.ts
 */
import { describe, it, expect } from 'vitest';

import {
  diagnoseOperatorPort,
  findOperatorUnitForPort,
  slowOperatorNotice,
  withOperatorDownDiagnosis,
} from './psu-operator-down-diagnosis.mjs';

const UNIT_CONFIGS = [
  [
    'Id=papercusp-dev-api.service',
    'Environment=PATH=/usr/bin PAPERCUSP_PTY_WS_PORT=3056',
    'ExecStart={ path=/usr/bin/bash ; argv[]=/usr/bin/bash -c set -a; exec node dist-host/hono-host.mjs ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }',
  ].join('\n'),
  [
    'Id=papercusp-staging-api.service',
    'Environment=PAPERCUSP_INTEGRATION_ROOT=/w/papercusp',
    'ExecStart={ path=/usr/bin/bash ; argv[]=/usr/bin/bash -c set -a; export PAPERCUSP_HONO_PORT=3170 PAPERCUSP_PTY_WS_PORT=3156; exec node dist-host/hono-host.mjs ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }',
  ].join('\n'),
  [
    'Id=papercup-mcp-proxy-staging.service',
    'Environment=PAPERCUSP_MCP_PROXY_TARGET_PORT=3170',
    'ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node lib/mcp-proxy/serve.mjs ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }',
  ].join('\n'),
].join('\n\n');

type UnitState = { active: string; sub: string; result?: string; restarts?: number; since?: string };

function showState(unit: string, s: UnitState): string {
  return [
    `Id=${unit}`,
    'LoadState=loaded',
    `ActiveState=${s.active}`,
    `SubState=${s.sub}`,
    `Result=${s.result ?? 'success'}`,
    `NRestarts=${s.restarts ?? 0}`,
    `StateChangeTimestamp=${s.since ?? 'Mon 2026-10-05 10:53:31 EDT'}`,
  ].join('\n');
}

/** A fake `systemctl --user` built from unit states and `list-jobs --before` listings. */
function fakeSystemctl(states: Record<string, UnitState>, jobs: Record<string, string> = {}) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'show' && args[1] === '--type=service') return UNIT_CONFIGS;
    if (args[0] === 'show') return states[args[1]] ? showState(args[1], states[args[1]]) : `Id=${args[1]}\nLoadState=not-found`;
    if (args[0] === 'list-jobs') return jobs[args[args.length - 1]] ?? '';
    return null;
  };
  return { run, calls };
}

const BOOT_GATED = fakeSystemctl(
  {
    'papercusp-staging-api.service': { active: 'inactive', sub: 'dead' },
    'default.target': { active: 'inactive', sub: 'dead' },
    'papercusp-bg-host.service': { active: 'activating', sub: 'start-pre', restarts: 3 },
    'papercusp-cloud-portal.service': { active: 'activating', sub: 'auto-restart', result: 'exit-code', restarts: 15 },
  },
  {
    'papercusp-staging-api.service':
      '107   papercusp-staging-api.service           start waiting\n└─    \tblocking job 9 (default.target/start) -     -\n',
    'default.target':
      '9     default.target                          start waiting\n' +
      '└─    \tblocking job 19690 (papercusp-bg-host.service/start) -     -\n' +
      '└─    \tblocking job 19097 (papercusp-cloud-portal.service/start) -     -\n',
    'papercusp-bg-host.service': '19690 papercusp-bg-host.service               start running\n',
    'papercusp-cloud-portal.service': '19097 papercusp-cloud-portal.service          start running\n',
  },
);

describe('which unit runs the operator on a port', () => {
  it('derives it from systemd unit config, with the same port precedence as hono-host.ts', () => {
    const { run } = fakeSystemctl({});
    expect(findOperatorUnitForPort(3170, { run })).toBe('papercusp-staging-api.service');
    // No PAPERCUSP_HONO_PORT / PORT: the Hono default. PAPERCUSP_PTY_WS_PORT is not PORT.
    expect(findOperatorUnitForPort(3070, { run })).toBe('papercusp-dev-api.service');
    // The proxy names :3170 in its config but does not run the operator.
    expect(findOperatorUnitForPort(9171, { run })).toBeNull();
  });
});

describe('diagnoseOperatorPort', () => {
  it('names the job a queued operator is really waiting on, through default.target (the 2026-10-05 outage)', () => {
    const d = diagnoseOperatorPort(3170, { run: BOOT_GATED.run });
    expect(d?.summary).toBe(
      'papercusp-staging-api.service (:3170) has not started: its start job is waiting on default.target, ' +
        'which is waiting on papercusp-bg-host.service (activating: start-pre; 3 automatic restarts), ' +
        'papercusp-cloud-portal.service (activating: auto-restart; 15 automatic restarts).',
    );
    expect(d?.hint).toBe('journalctl --user -u papercusp-bg-host.service -n 50 --no-pager');
  });

  it('reports a crash loop with its restart count and last result', () => {
    const { run } = fakeSystemctl({
      'papercusp-staging-api.service': { active: 'activating', sub: 'auto-restart', result: 'exit-code', restarts: 27 },
    });
    expect(diagnoseOperatorPort(3170, { run })?.summary).toBe(
      'papercusp-staging-api.service (:3170) is restarting in a loop (activating: auto-restart; 27 automatic restarts; last result: exit-code).',
    );
  });

  it('reports a failed unit and a stopped unit differently', () => {
    const failed = fakeSystemctl({ 'papercusp-dev-api.service': { active: 'failed', sub: 'failed', result: 'timeout' } });
    expect(diagnoseOperatorPort(3070, { run: failed.run })?.summary).toBe(
      'papercusp-dev-api.service (:3070) failed (timeout) at 2026-10-05 10:53:31 EDT and is not restarting.',
    );
    const stopped = fakeSystemctl({ 'papercusp-dev-api.service': { active: 'inactive', sub: 'dead' } });
    expect(diagnoseOperatorPort(3070, { run: stopped.run })?.summary).toBe(
      'papercusp-dev-api.service (:3070) is stopped (inactive: dead since 2026-10-05 10:53:31 EDT) and nothing is starting it.',
    );
  });

  it('says nothing when no local unit serves the port (desktop install, no systemd)', () => {
    expect(diagnoseOperatorPort(4555, { run: BOOT_GATED.run })).toBeNull();
    expect(diagnoseOperatorPort(3170, { run: () => null })).toBeNull();
  });
});

describe('withOperatorDownDiagnosis', () => {
  it("reads the refused port from the proxy's detail and appends the cause", () => {
    const out = withOperatorDownDiagnosis(
      'mcp_proxy_upstream_unavailable — connect ECONNREFUSED 127.0.0.1:3170',
      { detail: 'connect ECONNREFUSED 127.0.0.1:3170' },
      { run: BOOT_GATED.run },
    );
    expect(out).toContain('mcp_proxy_upstream_unavailable — connect ECONNREFUSED 127.0.0.1:3170\n  papercusp-staging-api.service (:3170) has not started');
    expect(out).toContain('\n  Details: journalctl --user -u papercusp-bg-host.service -n 50 --no-pager');
  });

  it('leaves the message unchanged when there is nothing to add', () => {
    expect(withOperatorDownDiagnosis('boom', { detail: 'connect ECONNREFUSED 10.0.0.5:3170' }, { run: BOOT_GATED.run })).toBe('boom');
    expect(withOperatorDownDiagnosis('boom', { url: 'http://127.0.0.1:4555' }, { run: BOOT_GATED.run })).toBe('boom');
  });
});

describe('slowOperatorNotice (printed while psu is still waiting)', () => {
  const proxyHealth = () =>
    new Response(JSON.stringify({ ok: true, target: { host: '127.0.0.1', port: 3170, source: 'static' } }), { status: 200 });

  it('explains the wait when the operator behind the proxy refuses its health check', async () => {
    const fetchImpl = async (url: string) => {
      if (url === 'http://127.0.0.1:9171/__mcp_proxy_health') return proxyHealth();
      throw new TypeError('fetch failed'); // :3170 refuses
    };
    const notice = await slowOperatorNotice('http://127.0.0.1:9171/api/agent-mcp/console/bootstrap-su', {
      fetchImpl: fetchImpl as typeof fetch,
      run: BOOT_GATED.run,
    });
    expect(notice).toContain(
      'psu: still waiting. The operator on :3170 (behind the MCP proxy at http://127.0.0.1:9171) is not answering',
    );
    expect(notice).toContain('papercusp-staging-api.service (:3170) has not started');
  });

  it('stays silent when the operator is healthy and the request is merely slow', async () => {
    const fetchImpl = async (url: string) =>
      url.endsWith('/__mcp_proxy_health') ? proxyHealth() : new Response('{"ok":true}', { status: 200 });
    const { run, calls } = fakeSystemctl({});
    expect(
      await slowOperatorNotice('http://127.0.0.1:9171/api/x', { fetchImpl: fetchImpl as typeof fetch, run }),
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  it('does not inspect local systemd for a proxy that forwards to a remote operator', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ target: { host: '10.0.0.5', port: 3170 } }), { status: 200 });
    const { run, calls } = fakeSystemctl({});
    expect(await slowOperatorNotice('http://127.0.0.1:9171/api/x', { fetchImpl: fetchImpl as typeof fetch, run })).toBeNull();
    expect(calls).toEqual([]);
  });
});

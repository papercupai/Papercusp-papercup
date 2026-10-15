/** AI-specific consumer journey in the maintained isolated native verifier.
 * Fixture stories exercise visibility/history; real news quality is certified
 * separately against the accepted research worker's report and primary sources. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { bridgeEval } from '../../../../libs/generic/tauri-verify/src/bridge-client';

const execute = promisify(execFile);
const isolated = process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED === '1';
let nativeEnvironment: NodeJS.ProcessEnv;
let pid: number;
let bridge: { tauriPID: number; bridgePort: number; bridgeToken: string };

describe.skipIf(!isolated)('Morning AI brief in the native owner Reports viewer', () => {
  beforeAll(async () => {
    const profile = JSON.parse(readFileSync(process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE!, 'utf8'));
    pid = Number(process.env.VERIFY_TAURI_PID);
    expect(profile.tauriPID).toBe(pid);
    expect(pid).toBeGreaterThan(0);
    nativeEnvironment = { ...process.env, TMPDIR: profile.nativeTmpDir };
    const token = JSON.parse(readFileSync(join(profile.nativeTmpDir, `tauri-dev-bridge-${pid}.token`), 'utf8'));
    expect(token.pid).toBe(pid);
    bridge = { tauriPID: pid, bridgePort: token.port, bridgeToken: token.token };
    expect((await bridgeEval(bridge, 'true')).ok).toBe(true);
    const receipt = JSON.parse(readFileSync(process.env.VERIFY_TAURI_SOURCE_RECEIPT!, 'utf8'));
    expect(receipt.sourceCommit).toBe(process.env.VERIFY_TAURI_SOURCE_REF);
    expect(process.env.PAPERCUSP_TEST_RUNS_DB_URL).toBeTruthy();
  });

  const poll = async (expression: string) => {
    const result = await execute(process.env.VERIFY_TAURI_POLL!, ['--require', '.reports-page', '--eval', expression],
      { env: { ...nativeEnvironment, VERIFY_TAURI_DOM_TIMEOUT: '60' }, timeout: 75_000, maxBuffer: 256_000 });
    expect(result.stderr).not.toMatch(/FATAL/);
  };
  const evaluate = async (expression: string) => {
    const result = await bridgeEval(bridge, expression);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  const navigate = async (path: string) => {
    await execute(process.env.VERIFY_TAURI_AGENT_TOOLS_BIN!, ['navigate', path, '--json', '--pid', String(pid)],
      { env: nativeEnvironment, timeout: 30_000 });
  };
  async function runTool(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
    await evaluate(`window.__aiFixture = { done:false }; void (async () => {
      try {
        const response = await fetch('/api/agent-mcp/run-tool', { method:'POST', headers:{'content-type':'application/json'},
          body:JSON.stringify(${JSON.stringify({ name, args, confirmed: true })}) });
        const envelope = await response.json(); const result = envelope.result;
        const record = result?.data ?? (result?.content?.find(x => x.type === 'text')
          ? JSON.parse(result.content.find(x => x.type === 'text').text) : result);
        window.__aiFixture = { done:true, status:response.status, envelope, record };
      } catch(error) { window.__aiFixture = { done:true, error:String(error) }; }
    })()`);
    await poll('window.__aiFixture?.done === true');
    const result = JSON.parse(String(await evaluate('JSON.stringify(window.__aiFixture)')));
    expect(result.status).toBe(200);
    expect(result.error).toBeUndefined();
    expect(result.envelope.result?.isError).not.toBe(true);
    expect(result.record?.ok).toBe(true);
    return result.record;
  }

  it('shows the series, citations and coverage after reload, with immutable dated history and correction links', async () => {
    const workspace = process.env.PAPERCUSP_WORKSPACE!;
    const series = 'series:papercusp-ai-brief';
    const listPath = `/reports?${new URLSearchParams({ ws: workspace, tag: series,
      subject: 'external:ai-news:papercusp', kind: 'status-digest' })}`;
    await navigate(listPath);
    await poll('!!document.querySelector(".reports-list")');
    const body = '# Act now\n\nFixture MCP release.\n\n'
      + '[Primary fixture release](https://example.test/mcp/v2)\n\n'
      + 'Event: 2026-10-07; published: 2026-10-07.\n\n'
      + 'Papercusp fit: verify the existing MCP integration.\n\n'
      + 'Coverage: partial; fixture feed unavailable.\n';
    const input = { title: 'Papercusp AI Brief — 2026-10-07', body_md: body, kind: 'status-digest',
      subject: { kind: 'external', ref: 'ai-news:papercusp' },
      tags: [series, 'ai-intelligence', 'edition:2026-10-07'], request_key: 'ai-native-edition-7' };
    const first = await runTool('reports:publish', input);
    expect((await runTool('reports:publish', input)).report_id).toBe(first.report_id);
    await poll(`document.querySelectorAll('.reports-list-item').length === 1`);
    const quiet = await runTool('reports:publish', { ...input, title: 'Papercusp AI Brief — 2026-10-08',
      body_md: '# No material updates\n\nComplete fixture coverage.\n',
      tags: [series, 'ai-intelligence', 'edition:2026-10-08'], request_key: 'ai-native-edition-8' });
    expect(quiet.lineage_id).not.toBe(first.lineage_id);
    await poll(`document.querySelectorAll('.reports-list-item').length === 2`);
    const correction = await runTool('reports:publish', { ...input, title: `${input.title} — corrected`,
      body_md: body.replace('/v2)', '/v2.1)'), supersedes: first.report_id, request_key: 'ai-native-correction-7' });
    await poll(`document.querySelectorAll('.reports-list-item').length === 2
      && document.querySelector('.reports-list-item')?.textContent.includes('corrected')`);
    await navigate(`${listPath}&sel=${first.report_id}&hist=true`);
    await poll(`document.querySelector('.reports-reader h2')?.textContent === ${JSON.stringify(input.title)}
      && document.querySelector('.reports-reader')?.textContent.includes('Coverage: partial')
      && document.querySelector('.reports-reader a[href="https://example.test/mcp/v2"]')
      && document.querySelectorAll('.reports-history-item').length === 2`);
    await evaluate('setTimeout(() => location.reload(), 100); true');
    await poll(`new URL(location.href).searchParams.get('sel') === ${JSON.stringify(first.report_id)}
      && document.querySelector('.reports-reader a[href="https://example.test/mcp/v2"]')
      && document.querySelectorAll('.reports-history-item').length === 2`);
    await evaluate(`Array.from(document.querySelectorAll('.reports-history-item'))
      .find(item => item.textContent.includes('corrected')).click(); true`);
    await poll(`new URL(location.href).searchParams.get('sel') === ${JSON.stringify(correction.report_id)}
      && document.querySelector('.reports-reader a[href="https://example.test/mcp/v2.1"]')`);
    const missingSeries = new URLSearchParams({ ws: workspace, tag: 'series:no-such-ai-series',
      subject: 'external:ai-news:papercusp', kind: 'status-digest', sel: first.report_id });
    await navigate(`/reports?${missingSeries}`);
    await poll(`document.querySelectorAll('.reports-list-item').length === 0
      && document.querySelector('.reports-reader a[href="https://example.test/mcp/v2"]')`);
    console.log(`MORNING_AI_NATIVE_E2E_SOURCE_RECEIPT=${process.env.VERIFY_TAURI_SOURCE_RECEIPT}`);
    console.log(`MORNING_AI_NATIVE_E2E_REPORTS=${JSON.stringify({ first: first.report_id, quiet: quiet.report_id, correction: correction.report_id })}`);
  }, 300_000);
});

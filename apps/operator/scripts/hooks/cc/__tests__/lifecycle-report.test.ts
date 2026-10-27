import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { runHookProcess } from './spawn-hook';

const HOOK = join(__dirname, '..', 'lifecycle-report.sh');
const TASK_ID = '0123456789abcdefghj';
const SESSION_ID = '22fa0398-0e51-48b1-93cb-e7c8426064d1';

let home: string;
let server: Server;
let port: number;
let reportedArgs: Record<string, unknown> | null = null;

beforeAll(async () => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'pc-lifecycle-task-home-'));
  fs.mkdirSync(join(home, '.papercusp'), { recursive: true });
  fs.writeFileSync(join(home, '.papercusp', 'superuser-token'), 'test-token\n');
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const rpc = JSON.parse(body);
      reportedArgs = rpc.params.arguments;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, id: 1 }) }] },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(home, { recursive: true, force: true });
});

describe('lifecycle-report task correlation', () => {
  it('forwards the exact enrolled task id from the hook environment into activity:report', async () => {
    reportedArgs = null;
    const { status } = await runHookProcess('bash', [HOOK], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: SESSION_ID,
        cwd: '/tmp/papercusp',
      }),
      env: {
        ...process.env,
        HOME: home,
        PAPERCUSP_SID: 'su-task-owner',
        PAPERCUSP_AGENT: 'claude',
        PAPERCUSP_AGENT_TASK_ID: TASK_ID,
        PAPERCUSP_ADV_SESSION_ID: '42',
        PAPERCUSP_ACTIVITY_SYNC: '1',
        PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:' + port,
      },
    });
    expect(status).toBe(0);
    expect(reportedArgs).toMatchObject({
      owner: 'su-task-owner',
      kind: 'lifecycle',
      summary: '▶ session started',
      session_id: SESSION_ID,
      adv_session_id: 42,
      agent_task_id: TASK_ID,
    });
  });
});

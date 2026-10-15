import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

export function assertFixtureApiSuccess(verb: string, data: unknown): asserts data is { ok: true; [key: string]: unknown } {
  const result = data as { ok?: unknown; error?: unknown } | null;
  if (result?.ok !== true || result.error != null) {
    throw new Error(`Fixture API ${verb} refused: ${JSON.stringify(data)}`);
  }
}

// plans:get defaults to structured sections. Exact document readback must
// request mode=full and compare raw, the same bytes used by set-content CAS.
export function assertFixturePlanReadback(data: unknown, expectedHash: unknown, authoredContent: string): void {
  assertFixtureApiSuccess('get', data);
  if (typeof expectedHash !== 'string' || !expectedHash || data.contentHash !== expectedHash || data.raw !== authoredContent) {
    throw new Error(`Fixture plan readback mismatch: ${JSON.stringify({
      expectedHash, actualHash: data.contentHash, hasRaw: typeof data.raw === 'string',
      exactContent: data.raw === authoredContent,
    })}`);
  }
}

export function fixtureChildFailure(error: unknown): Error {
  const child = error as { message?: string; code?: unknown; signal?: unknown; killed?: boolean; stdout?: string; stderr?: string };
  return new Error(`Isolated fixture child failed: ${JSON.stringify({
    message: child.message, code: child.code, signal: child.signal, killed: child.killed,
    stdout: child.stdout, stderr: child.stderr,
  })}`, { cause: error });
}

// execFile's message echoes the command, including its error strings. Only
// the child's actual stderr and exit disposition can prove a gate refusal.
export function fixtureChildWasGateRefusal(error: unknown): boolean {
  const child = (error as { cause?: unknown } | null)?.cause as
    { code?: unknown; signal?: unknown; killed?: boolean; stderr?: unknown } | undefined;
  return child?.code === 1 && child.signal == null && child.killed !== true &&
    typeof child.stderr === 'string' &&
    /^(?:Error: )?Plan fixture launch precondition failed:/m.test(child.stderr);
}

// Register a real harness only in the maintained disposable rig. The chat
// tools resolve their project before entering the fake model seam.
export async function seedFakeLlmHarness(options: { hive?: boolean } = {}): Promise<string> {
  if (process.env.VERIFY_TAURI_ISOLATED_DB !== '1') return 'main';
  const root = process.env.OPERATOR_SOURCE_ROOT;
  const workspace = process.env.PAPERCUSP_WORKSPACE_ID;
  const admin = process.env.HARNESS_ADMIN_DATABASE_URL;
  if (!root || !workspace?.startsWith('verify-tauri-isolated-') || !admin) throw new Error('Missing isolated chat fixture context');
  const database = new URL(admin);
  const slug = options.hive ? 'e2e-fake-plan' : 'e2e-fake-chat';
  if (!['127.0.0.1', 'localhost'].includes(database.hostname) || !database.port || database.port === '5432') throw new Error('Refusing shared chat fixture database');
  await runFixtureChild(root, admin, ['harness', slug]);
  return slug;
}

// Use the maintained transactional BAR writer, then the actual launch gate.
// This fixture is deliberately confined to the disposable database; it never
// changes admission policy or fabricates a successful gate verdict.
export async function seedFakeLlmPlanAcceptance(harnessSlug: string, planSlug: string): Promise<void> {
  if (process.env.VERIFY_TAURI_ISOLATED_DB !== '1') return;
  const root = process.env.OPERATOR_SOURCE_ROOT;
  const workspace = process.env.PAPERCUSP_WORKSPACE_ID;
  const admin = process.env.HARNESS_ADMIN_DATABASE_URL;
  if (!root || !workspace?.startsWith('verify-tauri-isolated-') || !admin) throw new Error('Missing isolated plan fixture context');
  const database = new URL(admin);
  if (!['127.0.0.1', 'localhost'].includes(database.hostname) || !database.port || database.port === '5432') throw new Error('Refusing shared plan fixture database');
  await runFixtureChild(root, admin, ['plan', harnessSlug, planSlug]);
}

async function runFixtureChild(root: string, admin: string, args: string[]): Promise<void> {
  await promisify(execFile)(process.execPath, [
    resolve(root, 'apps/operator/dist-verify/fake-llm-fixture-child.mjs'), ...args,
  ], { cwd: root, env: { ...process.env, DATABASE_URL: admin }, timeout: 30_000 })
    .catch(error => { throw fixtureChildFailure(error); });
}

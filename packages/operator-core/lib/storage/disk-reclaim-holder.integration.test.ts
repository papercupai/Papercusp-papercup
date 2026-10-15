import { spawn, spawnSync } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { mkdtemp, open, mkdir, rm, writeFile, link as hardLink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createRetentionHolderScanner, runDiskReclaimOnce } from './disk-reclaim';

// The OS pipe/kernel coverage uses fixture children. Durable task enrollment is
// independently exercised by disk-reclaim.integration.test.ts against real PG.
vi.mock('../task-manager/managed-spawn', () => ({ managedSpawn: async (
  command: string, args: string[], spec: { detail: { operation: string } },
  options: { onSpawn: (child: ReturnType<typeof spawn>, id: string) => void; requireRegistration: boolean },
) => {
  expect(spec.detail.operation).toBe('retention-holder-scan'); expect(options.requireRegistration).toBe(true);
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  options.onSpawn(child, 'holder-fixture-child'); return { child, taskId: 'holder-fixture-child' };
} }));

const worker = fileURLToPath(new URL('./disk-reclaim-holder-worker.py', import.meta.url));
const nativeHost = process.platform === 'linux' && existsSync('/sys/kernel/btf/vmlinux') &&
  spawnSync('/usr/bin/sudo', ['-n', 'true']).status === 0;

describe.skipIf(!nativeHost)('fresh read-only kernel holder walks', () => {
  it('observes new read-only and O_PATH handles, cwd and aliases, then observes their close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holder-iterator-test-'));
    const target = join(root, 'payload'), link = join(root, 'alias');
    await writeFile(target, 'test'); await hardLink(target, link);
    const child = spawn('/usr/bin/sudo', ['-n', 'python3', worker], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    const request = async (path: string, caller = process.pid, control = process.cwd()) => {
      child.stdin.write(JSON.stringify({ path, caller, control }) + '\n');
      const next = await iterator.next();
      if (next.done) throw new Error('kernel worker ended: ' + stderr);
      return JSON.parse(next.value);
    };
    const scan = async (path: string) => {
      const result = await request(path);
      expect(result.complete, JSON.stringify(result.diagnostics) + stderr).toBe(true);
      expect(result.diagnostics).toMatchObject({ fdEnd: 1, cwdEnd: 1, readFailures: 0, identityStable: true });
      return result;
    };
    let held: Awaited<ReturnType<typeof open>> | undefined;
    try {
      expect((await scan(target)).byPath).toEqual([]);
      held = await open(target, constants.O_RDONLY);
      expect((await scan(link)).byPath).toContainEqual([link, [String(process.pid)]]);
      await held.close(); held = undefined;
      expect((await scan(target)).byPath).toEqual([]);
      // Linux O_PATH is not exposed in Node's fs.constants.
      held = await open(link, 0x200000);
      expect((await scan(target)).byPath).toContainEqual([target, [String(process.pid)]]);
      await held.close(); held = undefined;
      expect((await scan(target)).byPath).toEqual([]);
      expect((await scan(process.cwd())).byPath[0]?.[1]).toContain(String(process.pid));
      await mkdir(join(root, 'nested'));
      const nested = join(root, 'nested', 'file'); await writeFile(nested, 'test');
      held = await open(nested, constants.O_RDONLY);
      expect((await scan(root)).byPath[0]?.[1]).toContain(String(process.pid));
      await held.close(); held = undefined;
      // The full cwd iterator must cover a different live process, and must
      // rebuild its evidence after that process exits.
      const cwdChild = spawn(process.execPath, ['-e', 'process.chdir(process.argv[1]); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);', join(root, 'nested')], { stdio: ['ignore', 'pipe', 'pipe'] });
      try {
        await new Promise<void>((resolveReady, rejectReady) => {
          cwdChild.stdout.once('data', () => resolveReady());
          cwdChild.once('error', rejectReady);
          cwdChild.once('exit', () => rejectReady(new Error('cwd fixture exited before readiness')));
        });
        expect((await scan(root)).byPath[0]?.[1]).toContain(String(cwdChild.pid));
      } finally {
        const exited = new Promise<void>(resolveExit => { if (cwdChild.exitCode !== null || cwdChild.signalCode !== null) resolveExit(); else cwdChild.once('exit', () => resolveExit()); });
        cwdChild.kill(); await exited;
      }
      expect((await scan(root)).byPath).toEqual([]);
      const wrongControl = await request(target, process.pid, root);
      expect(wrongControl).toMatchObject({ complete: false, byPath: [] });
      expect(wrongControl.diagnostics.reason).toContain('cwd identity mismatch');
      const vanishedCaller = await request(target, 2147483647);
      expect(vanishedCaller).toMatchObject({ complete: false, byPath: [] });
      const nestedMount = await request('/proc');
      expect(nestedMount).toMatchObject({ complete: false, byPath: [] });
      expect(nestedMount.diagnostics.reason).toContain('nested mount');
    } finally {
      await held?.close(); child.stdin.end();
      await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()); });
      lines.close(); await rm(root, { recursive: true, force: true });
    }
    expect(child.exitCode, stderr).toBe(0);
  }, 60_000);

  it('preserves intent order and sees a new O_PATH alias through the connected retention scanner', async () => {
    const base = await mkdtemp(join(tmpdir(), 'holder-retention-test-'));
    const root = join(base, 'artifacts'); await mkdir(root);
    const older = join(root, 'a-older'), later = join(root, 'b-later'), alias = join(base, 'alias');
    await writeFile(older, 'old'); await writeFile(later, 'later'); await hardLink(later, alias);
    let held: Awaited<ReturnType<typeof open>> | undefined;
    const fallback = vi.fn(); const scanner = createRetentionHolderScanner({ fallback });
    const intents: string[] = [];
    try {
      const nowMs = Date.now() + 48 * 3_600_000;
      const receipt = await runDiskReclaimOnce({
        roots: [{ path: root, classId: 'fixture' }],
        policy: [{ id: 'fixture', title: 'fixture', origin: 'agent', roots: [root], keep: { kind: 'max-age', maxAgeHours: 24 }, enforcers: [{ kind: 'standing-reclaim' }] }],
        nowMs, registeredWorkspaces: () => [], expectedDevices: [], sample: async () => [],
        // Avoid a bulk proc census here: each candidate still receives a fresh
        // kernel walk at its actual effect boundary, through the production seam.
        scanHolders: async (paths) => paths.length > 1 ? { complete: true, byPath: new Map() } : scanner.scan(paths),
        record: async (phase, detail) => {
          if (phase === 'remove-intent') {
            const path = (detail as { path: string }).path; intents.push(path);
            if (path === later && !held) held = await open(alias, 0x200000);
          }
        },
      });
      expect(receipt.complete, JSON.stringify(receipt.errors)).toBe(true);
      expect(intents[0]).toBe(older);
      expect(receipt.entries).toContainEqual(expect.objectContaining({ path: older, status: 'removed' }));
      expect(receipt.entries).toContainEqual(expect.objectContaining({ path: later, status: 'protected', reason: 'process evidence unavailable or held' }));
      expect((await scanner.scan([later])).byPath.get(later)).toContain(String(process.pid));
      await held?.close(); held = undefined;
      expect((await scanner.scan([later])).byPath.has(later)).toBe(false);
      expect(fallback).not.toHaveBeenCalled();
    } finally { await held?.close(); await scanner.close(); await rm(base, { recursive: true, force: true }); }
  }, 60_000);
});

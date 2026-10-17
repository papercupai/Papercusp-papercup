/**
 * delivery-ledger.mjs — the hook half of turn-start ACK-ON-PROOF
 * (owner-directive-delivery-redesign-2026-09-22 P-005). The end-to-end
 * "printed, then recorded" property is driven through the real CLI in
 * dispatcher.test.ts; these pin the module's own edges.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { ledgerDir, openDeliveryLedger, codeIntelDelivery } = await import(path.join(HERE, '..', 'delivery-ledger.mjs'));

const home = () => ({ PAPERCUSP_HOME: mkdtempSync(path.join(tmpdir(), 'ledger-unit-')) });
type CodeIntelState = { turn: string; chars: number; subjects: string[] };

describe('delivery ledger', () => {
  it('confirms only what was offered AND committed', () => {
    const env = home();
    const ledger = openDeliveryLedger('su-1', env);
    expect(ledger.confirmed()).toBeNull();
    // Commit before any offer records nothing.
    expect(ledger.commit()).toBe(false);
    ledger.offer('tok-1');
    // Offered is not proven: a fresh process still reads nothing.
    expect(openDeliveryLedger('su-1', env).confirmed()).toBeNull();
    expect(ledger.commit()).toBe(true);
    expect(openDeliveryLedger('su-1', env).confirmed()).toBe('tok-1');
  });

  it('keeps one token per session and leaves no temp file behind', () => {
    const env = home();
    const a = openDeliveryLedger('su-a', env);
    const b = openDeliveryLedger('su-b', env);
    a.offer('tok-a');
    b.offer('tok-b');
    a.commit();
    b.commit();
    expect(openDeliveryLedger('su-a', env).confirmed()).toBe('tok-a');
    expect(readdirSync(ledgerDir(env)).sort()).toEqual(['su-a.token', 'su-b.token']);
  });

  it('cannot be steered outside its directory by the session id', () => {
    const env = home();
    const ledger = openDeliveryLedger('../../escape', env);
    ledger.offer('tok-x');
    ledger.commit();
    expect(readdirSync(ledgerDir(env))).toEqual(['.._.._escape.token']);
  });

  it('opens nothing without a session id', () => {
    expect(openDeliveryLedger('', home())).toBeNull();
    expect(openDeliveryLedger(undefined, home())).toBeNull();
  });
});

describe('code intelligence delivery reservations', () => {
  it('retains source observations across turn and compaction boundaries', () => {
    const env = home();
    const observation = { path: 'a.ts', sha256: 'a'.repeat(64), at: Date.now() };
    codeIntelDelivery('su-1', env, (state: CodeIntelState & { recentEdits?: unknown[] }) => {
      state.recentEdits = [observation];
    });
    for (const boundary of ['turn-start', 'compaction']) {
      codeIntelDelivery('su-1', env, () => null, boundary);
      expect(codeIntelDelivery('su-1', env, (state: CodeIntelState & { recentEdits?: unknown[] }) => state.recentEdits))
        .toEqual([observation]);
    }
  });
  it('does not remove a competing writer lock or run its update', () => {
    const env = home();
    const lock = path.join(ledgerDir(env), 'su-1.code-intel.json.initial.lock');
    mkdirSync(lock, { recursive: true });
    let called = false;
    expect(codeIntelDelivery('su-1', env, () => { called = true; })).toBeNull();
    expect(called).toBe(false);
    expect(existsSync(lock)).toBe(true);
  });

  it.each([null, { turn: 'initial', chars: -5000, subjects: [] }, { turn: '../escape', chars: 0, subjects: [] },
    { turn: 'initial', chars: 0, subjects: [null] }])('does not admit malformed persisted state %j into the budget callback', invalid => {
    const env = home();
    mkdirSync(ledgerDir(env), { recursive: true });
    writeFileSync(path.join(ledgerDir(env), 'su-1.code-intel.json'), JSON.stringify(invalid));
    let called = false;
    expect(codeIntelDelivery('su-1', env, () => { called = true; return 'advice'; })).toBeNull();
    expect(called).toBe(false);
    // A boundary can rebuild corrupt state without trusting its subjects.
    codeIntelDelivery('su-1', env, () => null, 'turn-start');
    expect(codeIntelDelivery('su-1', env, (state: CodeIntelState) => state.chars)).toBe(0);
  });

  it('does not let an old writer overwrite a completed turn boundary', () => {
    const env = home();
    codeIntelDelivery('su-1', env, (state: CodeIntelState) => { state.subjects.push('prior'); });
    expect(codeIntelDelivery('su-1', env, (state: CodeIntelState) => {
      codeIntelDelivery('su-1', env, () => null, 'turn-start');
      state.chars = 1000;
      return 'old';
    })).toBeNull();
    const current = JSON.parse(readFileSync(path.join(ledgerDir(env), 'su-1.code-intel.json'), 'utf8'));
    expect(current.chars).toBe(0);
    expect(current.subjects).toEqual(['prior']);
  });

  it('serializes concurrent fresh processes against one turn budget', async () => {
    const env = home();
    codeIntelDelivery('su-1', env, () => null, 'turn-start');
    const run = promisify(execFile);
    const results = await Promise.all(Array.from({ length: 6 }, (_, n) => run(process.execPath, ['--input-type=module', '-e',
      `import { codeIntelDelivery } from ${JSON.stringify(path.join(HERE, '..', 'delivery-ledger.mjs'))};
       const result = codeIntelDelivery('su-1', ${JSON.stringify(env)}, state => {
         const until = Date.now() + 30; while (Date.now() < until) {}
         if (state.chars + 600 > 1500) return false;
         state.chars += 600; state.subjects.push(${JSON.stringify(String(n))}); return true;
       }); process.stdout.write(JSON.stringify(result));`], { env: { ...process.env, NODE_OPTIONS: '' } })));
    const admitted = results.filter(result => JSON.parse(result.stdout) === true).length;
    const state = codeIntelDelivery('su-1', env, (current: CodeIntelState) => ({ ...current }));
    expect(admitted).toBeGreaterThan(0);
    expect(state.chars).toBe(admitted * 600);
    expect(state.chars).toBeLessThanOrEqual(1500);
    expect(state.subjects).toHaveLength(admitted);
  });

  it('cannot replace a newer boundary when it lands between validation and rename', async () => {
    const env = home();
    const run = promisify(execFile);
    const result = await run(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { codeIntelDelivery, ledgerDir } from ${JSON.stringify(path.join(HERE, '..', 'delivery-ledger.mjs'))};
      const env = ${JSON.stringify(env)};
      codeIntelDelivery('su-1', env, state => { state.subjects.push('prior'); });
      const rename = fs.renameSync;
      let armed = true;
      fs.renameSync = (from, to) => {
        if (armed) {
          armed = false;
          codeIntelDelivery('su-1', env, () => null, 'turn-start');
        }
        return rename(from, to);
      };
      syncBuiltinESMExports();
      const old = codeIntelDelivery('su-1', env, state => { state.chars = 1000; return 'old'; });
      const current = codeIntelDelivery('su-1', env, state => ({ chars: state.chars, subjects: state.subjects }));
      process.stdout.write(JSON.stringify({ old, current }));
    `], { env: { ...process.env, NODE_OPTIONS: '' } });
    expect(JSON.parse(result.stdout)).toEqual({ old: null, current: { chars: 0, subjects: ['prior'] } });
  });
});

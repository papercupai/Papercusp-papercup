/**
 * DELIVERY LEDGER — the hook half of ACK-ON-PROOF for turn-start orientation.
 *
 * Plan: owner-directive-delivery-redesign-2026-09-22, P-005 (D-005). The server
 * half lives in packages/operator-core/lib/agent-tools/coordination/read-cursors.ts.
 *
 * WHY THE HOOK MUST PROVE EMISSION. The operator stages what it delivered and,
 * without proof, treats the NEXT request's arrival as the ack. Arrival only proves
 * the hook ran again. A hook killed after the server staged — this port's own
 * 2.5s wall, the client's hook timeout, a crash between receiving and printing —
 * still arrives next turn, so the block it never printed was acked and never
 * re-sent. With the ledger, the server hands back a `deliveryToken`; this module
 * records it ONLY after the payload has been written to stdout, and the next
 * request echoes it as `confirmedDelivery`. No record ⇒ no promotion ⇒ the
 * operator re-diffs from the last proven floor and re-delivers.
 *
 * One file per session under `<PAPERCUSP_HOME or ~/.papercusp>/state/turn-start-delivery/`.
 * The hook is a fresh process every turn, so the token has to outlive it.
 *
 * FAIL-SILENT, like everything in this directory: every IO failure is swallowed.
 * If the directory cannot be made writable the ledger is not opened at all and the
 * request goes out WITHOUT `confirmedDelivery`, keeping the server on
 * ack-on-arrival. That is deliberate: a ledger that can read but never record
 * would prove nothing on every turn, and the operator would re-deliver the whole
 * block forever.
 */

import { accessSync, constants, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * @typedef {object} DeliveryLedger
 * @property {() => string | null} confirmed  the token this session last proved it emitted
 * @property {(token: unknown) => void} offer  remember the token the operator just returned
 * @property {() => boolean} commit           record the offered token; call ONLY after emitting
 */

/**
 * Where the ledger lives. PAPERCUSP_HOME is an isolation pin (see
 * hooks/omp/inject-hook.ts `papercuspHomeDir`), so it is exclusive, not a fallback.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function ledgerDir(env = process.env) {
  return join(env.PAPERCUSP_HOME || join(homedir(), '.papercusp'), 'state', 'turn-start-delivery');
}

/**
 * Open the ledger for one session, or null when it cannot be written.
 * @param {string | null | undefined} owner  PAPERCUSP_SID
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {DeliveryLedger | null}
 */
export function openDeliveryLedger(owner, env = process.env) {
  if (typeof owner !== 'string' || !owner) return null;
  const dir = ledgerDir(env);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    accessSync(dir, constants.W_OK);
  } catch {
    return null;
  }
  // Session ids are `su-<uuid>`; anything else is flattened so it cannot name a
  // path outside the ledger directory.
  const file = join(dir, `${owner.replace(/[^A-Za-z0-9._-]/g, '_')}.token`);
  /** @type {string | null} */
  let offered = null;
  return {
    confirmed() {
      try {
        const token = readFileSync(file, 'utf8').trim();
        return token || null;
      } catch {
        return null;
      }
    },
    offer(token) {
      offered = typeof token === 'string' && token ? token : null;
    },
    commit() {
      if (!offered) return false;
      // Write-then-rename so a hook killed mid-write leaves the previous token
      // intact rather than a truncated one that matches nothing.
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, offered, { mode: 0o600 });
        renameSync(tmp, file);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Extend the existing delivery ledger for optional code-intelligence emission.
 * A generation-scoped exclusive directory serializes fresh hook processes. On
 * contention or an IO error, suppress only optional advice. A crashed writer's
 * lock expires at the next turn boundary, which uses a new generation; we never
 * remove a possibly live writer's lock to recover it. Reservations precede stdout
 * and are conservative if the client dies before printing, as on the server.
 */
export function codeIntelDelivery(owner, env, update, boundary = null) {
  if (typeof owner !== 'string' || !owner) return null;
  const dir = ledgerDir(env);
  const file = join(dir, `${owner.replace(/[^A-Za-z0-9._-]/g, '_')}.code-intel.json`);
  let lock;
  let tmp;
  const valid = state => state && typeof state.turn === 'string' && /^[A-Za-z0-9-]+$/.test(state.turn)
    && Array.isArray(state.subjects) && state.subjects.every(subject => typeof subject === 'string')
    && Number.isSafeInteger(state.chars) && state.chars >= 0;
  // The session file selects the generation. Reservations replace only that
  // generation's state, never the selector: a check followed by rename of the
  // shared session file cannot fence a boundary landing BETWEEN those operations.
  const generationFile = turn => `${file}.${turn}.state`;
  const readState = selector => {
    try {
      const current = JSON.parse(readFileSync(generationFile(selector.turn), 'utf8'));
      if (!valid(current) || current.turn !== selector.turn) throw new Error('invalid generation state');
      return current;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return selector; // also imports the previous single-file ledger format
    }
  };
  const selected = turn => {
    try { return JSON.parse(readFileSync(file, 'utf8')).turn === turn; }
    catch { return false; }
  };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let state;
    let present = false;
    try { state = JSON.parse(readFileSync(file, 'utf8')); present = true; }
    catch (error) { if (error.code !== 'ENOENT' && !boundary) return null; }
    if (present && !valid(state) && !boundary) return null;
    if (valid(state)) {
      try { state = readState(state); }
      catch { if (!boundary) return null; state = null; }
    }
    if (!valid(state)) {
      // Bootstrap itself is exclusive: simultaneous first hooks cannot each
      // create their own budget. A killed bootstrap stays quiet until reset.
      state = { turn: 'initial', chars: 0, subjects: [] };
    }
    const previousTurn = state.turn;
    if (boundary) {
      state = { turn: randomUUID(), chars: 0, subjects: boundary === 'compaction' ? [] : state.subjects,
        recentEdits: Array.isArray(state.recentEdits) ? state.recentEdits : [] };
    }
    const wanted = `${file}.${state.turn}.lock`;
    mkdirSync(wanted, { mode: 0o700 });
    lock = wanted;
    // Another process may have finished between our read and lock acquisition.
    if (!boundary) {
      try {
        const selector = JSON.parse(readFileSync(file, 'utf8'));
        if (!valid(selector) || selector.turn !== state.turn) return null;
        state = readState(selector);
      } catch (error) { if (error.code !== 'ENOENT') return null; }
    }
    const result = update(state);
    tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, generationFile(state.turn));
    if (boundary) {
      tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      renameSync(tmp, file);
      // A late old writer can recreate its own file, but it also detects the
      // superseded selector below and removes that file without touching ours.
      try { unlinkSync(generationFile(previousTurn)); } catch { /* absent or in flight */ }
    } else {
      if (!present) {
        try { writeFileSync(file, JSON.stringify(state), { mode: 0o600, flag: 'wx' }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      if (!selected(state.turn)) {
        try { unlinkSync(generationFile(state.turn)); } catch { /* already retired */ }
        return null;
      }
    }
    return result;
  } catch { return null; }
  finally {
    if (tmp) { try { unlinkSync(tmp); } catch { /* renamed or unwritable */ } }
    if (lock) { try { rmdirSync(lock); } catch { /* never disturb a hook */ } }
  }
}

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
 * The current token and the last 128 immutable emission receipts live under
 * `<PAPERCUSP_HOME or ~/.papercusp>/state/turn-start-delivery/`. A successor may
 * replace the token pointer, but retains earlier token/payload-hash/control
 * provenance. Receipts prove stdout emission, never a later server ACK, and
 * contain no hook plaintext.
 *
 * FAIL-SILENT, like everything in this directory: every IO failure is swallowed.
 * If the directory cannot be made writable the ledger is not opened at all and the
 * request goes out WITHOUT `confirmedDelivery`, keeping the server on
 * ack-on-arrival. That is deliberate: a ledger that can read but never record
 * would prove nothing on every turn, and the operator would re-deliver the whole
 * block forever.
 */

import { accessSync, constants, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * @typedef {object} DeliveryLedger
 * @property {() => string | null} confirmed  the token this session last proved it emitted
 * @property {(token: unknown, emission?: { payload?: string, client?: string, nativeSessionId?: string | null, control?: object | null }) => void} offer
 *   remember the returned token and the exact payload that the caller will emit
 * @property {() => boolean} commit           record the offered token; call ONLY after emitting
 */

export const MAX_DELIVERY_RECEIPTS = 128;
export const MAX_TURN_START_OUTCOME_RECEIPTS = 128;

const hash = value => createHash('sha256').update(value).digest('hex');
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const revision = value => value && isHash(value.specificationRevision) && isHash(value.stateRevision)
  ? { specificationRevision: value.specificationRevision, stateRevision: value.stateRevision }
  : null;

/** Whitelist metadata before writing: context text never enters the receipt. */
function emissionMetadata(owner, emission) {
  const payload = typeof emission?.payload === 'string' ? emission.payload : null;
  const c = emission?.control;
  const control = c?.targetOwnerId === owner && Number.isSafeInteger(c.generation) && c.generation >= 0
    ? {
        generation: c.generation,
        stateHash: isHash(c.stateHash) ? c.stateHash : null,
        activationStatus: ['desired', 'prepared', 'applied', 'failed'].includes(c.state?.activation?.status)
          ? c.state.activation.status : null,
        desired: revision(c.state?.activation?.desired),
        prepared: revision(c.state?.activation?.prepared),
        applied: revision(c.state?.activation?.applied),
      }
    : null;
  return {
    payloadSha256: payload === null ? null : hash(payload),
    payloadBytes: payload === null ? null : Buffer.byteLength(payload),
    client: ['claude', 'codex', 'omp'].includes(emission?.client) ? emission.client : null,
    nativeSessionId: typeof emission?.nativeSessionId === 'string' && emission.nativeSessionId.length <= 200
      ? emission.nativeSessionId : null,
    control,
  };
}

/** Retention never deletes the receipt being committed, including timestamp ties. */
function pruneEmissionReceipts(dir, current) {
  try {
    const older = readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name) && entry.name !== current)
      .map(entry => ({ name: entry.name, mtime: statSync(join(dir, entry.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
    for (const entry of older.slice(MAX_DELIVERY_RECEIPTS - 1)) {
      try { unlinkSync(join(dir, entry.name)); } catch { /* another hook may have pruned it */ }
    }
  } catch { /* optional retention must not change a successful emission */ }
}

/** Keep the per-request diagnostic receipt bounded independently of stdout proofs. */
function pruneTurnStartOutcomeReceipts(dir, current) {
  try {
    const older = readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name) && entry.name !== current)
      .map(entry => ({ name: entry.name, mtime: statSync(join(dir, entry.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
    for (const entry of older.slice(MAX_TURN_START_OUTCOME_RECEIPTS - 1)) {
      try { unlinkSync(join(dir, entry.name)); } catch { /* another hook may have pruned it */ }
    }
  } catch { /* optional retention must not change a successful receipt */ }
}

/** Whitelist the diagnostic vocabulary; prompt, error, and response text never persist. */
function turnStartOutcomeMetadata(outcome) {
  if (typeof outcome?.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(outcome.requestId)) return null;
  const oneOf = (value, values, fallback) => values.includes(value) ? value : fallback;
  const rawTransport = outcome.transport;
  let transport;
  if (rawTransport && typeof rawTransport === 'object') {
    const milliseconds = value => typeof value === 'number' && Number.isFinite(value)
      && value >= 0 && value <= 3_600_000 ? Math.round(value) : null;
    let operatorOrigin = null;
    try {
      const url = new URL(rawTransport.operatorOrigin);
      if (url.protocol === 'http:' || url.protocol === 'https:') operatorOrigin = url.origin;
    } catch { /* absent or malformed origin remains explicitly unknown */ }
    transport = {
      phase: oneOf(rawTransport.phase,
        ['not-started', 'waiting-for-headers', 'headers-received', 'reading-body', 'body-received'], 'unknown'),
      operatorOrigin,
      timeoutMs: milliseconds(rawTransport.timeoutMs),
      elapsedMs: milliseconds(rawTransport.elapsedMs),
      preFetchMs: milliseconds(rawTransport.preFetchMs),
      fetchMs: milliseconds(rawTransport.fetchMs),
      responseStatus: Number.isInteger(rawTransport.responseStatus)
        && rawTransport.responseStatus >= 100 && rawTransport.responseStatus <= 599
        ? rawTransport.responseStatus : null,
      headersElapsedMs: milliseconds(rawTransport.headersElapsedMs),
      responseBodyMs: milliseconds(rawTransport.responseBodyMs),
    };
  }
  return {
    requestId: outcome.requestId,
    client: ['claude', 'codex', 'omp'].includes(outcome.client) ? outcome.client : null,
    hookOutcome: oneOf(outcome.hookOutcome,
      ['response-received', 'http-error', 'request-failed', 'invalid-response', 'suppressed'], 'request-failed'),
    serverOutcome: oneOf(outcome.serverOutcome, ['matched', 'missing', 'mismatched', 'unavailable'], 'unavailable'),
    ambientGate: oneOf(outcome.ambientGate, ['allowed', 'denied', 'error', 'unknown'], 'unknown'),
    loopFire: typeof outcome.loopFire === 'boolean' ? outcome.loopFire : null,
    loopMarkerAppend: oneOf(outcome.loopMarkerAppend,
      ['appended', 'failed', 'not-applicable', 'pending', 'unknown'], 'unknown'),
    ...(transport ? { transport } : {}),
  };
}

/**
 * Where the ledger lives. PAPERCUSP_HOME is an isolation pin (see
 * hooks/omp/inject-hook.ts `papercuspHomeDir`), so it is exclusive, not a fallback.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function ledgerDir(env = process.env) {
  // The dispatcher is installed as standalone .mjs files without node_modules.
  const home = env.PAPERCUSP_HOME || join(homedir(), '.papercusp');
  return join(home, 'state', 'turn-start-delivery');
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
  const key = owner.replace(/[^A-Za-z0-9._-]/g, '_');
  const file = join(dir, `${key}.token`);
  const receipts = join(dir, `${key}.emissions`);
  /** @type {{ token: string, metadata: ReturnType<typeof emissionMetadata> } | null} */
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
    offer(token, emission) {
      offered = typeof token === 'string' && token
        ? { token, metadata: emissionMetadata(owner, emission) } : null;
    },
    recordOutcome(outcome) {
      const metadata = turnStartOutcomeMetadata(outcome);
      if (!metadata) return false;
      const receipts = join(dir, `${key}.outcomes`);
      const name = `${hash(metadata.requestId)}.json`;
      const receiptFile = join(receipts, name);
      const tmp = `${receiptFile}.${process.pid}.${randomUUID()}.tmp`;
      try {
        mkdirSync(receipts, { recursive: true, mode: 0o700 });
        const record = { version: 1, stage: 'turn-start-outcome', recordedAt: new Date().toISOString(), ...metadata };
        writeFileSync(tmp, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
        try { linkSync(tmp, receiptFile); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const existing = JSON.parse(readFileSync(receiptFile, 'utf8'));
          if (existing.version !== 1 || existing.stage !== 'turn-start-outcome' ||
              existing.requestId !== metadata.requestId) throw error;
        }
        pruneTurnStartOutcomeReceipts(receipts, name);
        return true;
      } catch {
        return false;
      } finally {
        try { unlinkSync(tmp); } catch { /* linked, failed, or never created */ }
      }
    },
    commit() {
      if (!offered) return false;
      const name = `${hash(offered.token)}.json`;
      const receiptFile = join(receipts, name);
      const receiptTmp = `${receiptFile}.${process.pid}.${randomUUID()}.tmp`;
      const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      try {
        mkdirSync(receipts, { recursive: true, mode: 0o700 });
        const record = { version: 1, stage: 'stdout-emitted', owner, token: offered.token,
          recordedAt: new Date().toISOString(), ...offered.metadata };
        writeFileSync(receiptTmp, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
        // Publish complete bytes without overwriting an earlier emission. A
        // kill before this link leaves no partial receipt at the durable name.
        try { linkSync(receiptTmp, receiptFile); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const existing = JSON.parse(readFileSync(receiptFile, 'utf8'));
          if (existing.version !== 1 || existing.stage !== 'stdout-emitted' ||
              existing.owner !== owner || existing.token !== offered.token) throw error;
        }
        // Advance the compatible current-token pointer only after preserving
        // this emission. Neither the receipt nor the pointer asserts an ACK.
        writeFileSync(tmp, offered.token, { mode: 0o600, flag: 'wx' });
        renameSync(tmp, file);
        pruneEmissionReceipts(receipts, name);
        return true;
      } catch {
        return false;
      } finally {
        for (const pending of [receiptTmp, tmp]) {
          try { unlinkSync(pending); } catch { /* renamed, linked, or never created */ }
        }
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

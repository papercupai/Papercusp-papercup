/** Nonsecret account-link lifecycle; PTYs and credential bytes never enter PG. */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { readProcessIdentity } from '../process-identity';
import { readOperatorState, updateOperatorState } from '../operator-state-pg';
import type { AccountProvider } from './account-pool';

const TABLE = 'operator_account_link_state';
export const LINK_RECOVERY_RETENTION_MS = 24 * 60 * 60_000;
const TERMINAL_GRACE_MS = 5 * 60_000;
export interface LinkOwner {
  host: string;
  pid: number;
  processIdentity: string | null;
  nonce: string;
}
export interface StoredCliLink {
  linkId: string;
  scope: string;
  accountId: string;
  label?: string;
  provider: AccountProvider;
  configDir: string;
  owner: LinkOwner;
  createdAt: number;
  expiresAt: number;
  retainUntil: number;
  outcome?: 'completed' | 'failed';
  /** Fixed public error codes only, never provider output or credential bytes. */
  failure?: 'interrupted' | 'expired' | 'start-failed' | 'registration-failed';
}
type State = Record<string, StoredCliLink>;

export function newLinkOwner(): LinkOwner {
  return { host: hostname(), pid: process.pid, processIdentity: readProcessIdentity(process.pid), nonce: randomUUID() };
}

/** ESRCH and a different kernel identity prove loss; permissions/remote hosts do not. */
export function linkOwnerLiveness(owner: LinkOwner): 'alive' | 'dead' | 'unknown' {
  if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return 'unknown';
  try { process.kill(owner.pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'dead';
    return 'unknown';
  }
  if (!owner.processIdentity) return 'unknown';
  const current = readProcessIdentity(owner.pid);
  return current ? current === owner.processIdentity ? 'alive' : 'dead' : 'unknown';
}

function prune(state: State, now: number): State {
  return Object.fromEntries(Object.entries(state).filter(([, row]) => row.retainUntil > now));
}

export async function createStoredCliLink(row: StoredCliLink): Promise<void> {
  await updateOperatorState<State>(TABLE, {}, (state) => {
    if (state[row.linkId]) throw new Error('account_link_already_exists');
    return { ...prune(state, Date.now()), [row.linkId]: row };
  });
}

/** Read-only, including expiry; no finalization or opportunistic state write. */
export async function readStoredCliLink(linkId: string, scope: string): Promise<StoredCliLink | null> {
  const row = (await readOperatorState<State>(TABLE))?.[linkId];
  return row?.scope === scope && row.retainUntil > Date.now() ? row : null;
}

/** Fenced terminal write. A failed attempt remains recoverable with the approved home intact. */
export async function finishStoredCliLink(
  linkId: string, scope: string, nonce: string, outcome: 'completed' | 'failed',
  failure?: StoredCliLink['failure'],
): Promise<boolean> {
  let written = false;
  await updateOperatorState<State>(TABLE, {}, (state) => {
    const row = state[linkId];
    if (!row || row.scope !== scope || row.owner.nonce !== nonce || row.retainUntil <= Date.now()) return state;
    written = true;
    return { ...prune(state, Date.now()), [linkId]: {
      ...row, outcome, failure: outcome === 'failed' ? failure : undefined,
      retainUntil: failure === 'registration-failed' ? row.retainUntil : Date.now() + TERMINAL_GRACE_MS,
    } };
  });
  return written;
}

/** No lease timeout: only the measured death of the exact current custodian permits a CAS. */
export async function claimStoredCliLink(
  expected: StoredCliLink, owner: LinkOwner,
  probe: typeof linkOwnerLiveness = linkOwnerLiveness,
): Promise<StoredCliLink | null> {
  let claimed: StoredCliLink | null = null;
  await updateOperatorState<State>(TABLE, {}, (state) => {
    const row = state[expected.linkId];
    if (!row || row.scope !== expected.scope || row.retainUntil <= Date.now() ||
        row.owner.nonce !== expected.owner.nonce || row.outcome === 'completed' ||
        probe(row.owner) !== 'dead') return state;
    claimed = { ...row, owner, outcome: undefined, failure: undefined };
    return { ...prune(state, Date.now()), [row.linkId]: claimed };
  });
  return claimed;
}

/**
 * resource-command-match — map a raw shell command to registered resources,
 * so the raw-Bash bypass can be gated (Phase 8, P-026 / D-012 / D-013).
 *
 * The DESTRUCTIVE side of a resource (restart / migrate) is a small, matchable
 * command set — each registry row carries `match_patterns` (regex source). A
 * PreToolUse `Bash` hook calls `checkBashCommand` and acts on the verdict:
 *   - allow  — no registered resource matched.
 *   - warn   — a matched resource has an exclusive in flight, advisory level.
 *   - block  — a matched resource has an exclusive in flight, checked/enforced.
 *
 * `matchCommandToResources` is a pure function (unit-tested). The hook itself
 * is NOT wired into settings.json here — wiring a Bash PreToolUse hook gates
 * EVERY agent on the box, so activation is a deliberate, documented step.
 */

import {
  getTxPool,
  listResources,
  readResourceQueue,
  type ResourceEnforcement,
  type ResourceRegistryRow,
} from './su-lock-store';
import { withPgRetry } from '../../pg-transient-retry';

/** Resources whose any match_pattern (regex) matches `command`. Pure. */
export function matchCommandToResources(
  command: string,
  registry: ResourceRegistryRow[],
): ResourceRegistryRow[] {
  const out: ResourceRegistryRow[] = [];
  for (const r of registry) {
    if (!r.match_patterns || r.match_patterns.length === 0) continue;
    const hit = r.match_patterns.some((p) => {
      try {
        return new RegExp(p).test(command);
      } catch {
        return false; // a malformed pattern never matches (don't throw on bad data)
      }
    });
    if (hit) out.push(r);
  }
  return out;
}

export interface BashMatchEntry {
  resource: string;
  enforcement: ResourceEnforcement;
  /** An exclusive (held or draining) is live on this resource. */
  exclusiveActive: boolean;
  /** That exclusive is held by an owner OTHER than the caller. */
  exclusiveByOther: boolean;
  draining: boolean;
}

export interface BashCheckVerdict {
  decision: 'allow' | 'warn' | 'block';
  matched: BashMatchEntry[];
}

/**
 * Live verdict for a raw command: which registered resources it touches and
 * whether one is mid-exclusive (so a restart/migration is in flight). `ownerId`
 * lets the caller's OWN exclusive not gate their own commands.
 */
export async function checkBashCommand(params: {
  command: string;
  coordinationDomain: string;
  ownerId?: string;
}): Promise<BashCheckVerdict> {
  // These are read-only registry/queue queries. A postgres-js CONNECT_TIMEOUT
  // happens before the SELECT reaches PostgreSQL, so replaying the bounded read
  // is safe and lets the pool reconnect instead of leaking an MCP handler_error
  // to every PreToolUse Bash hook during a transient pool blip.
  const pool = getTxPool();
  const registry = await withPgRetry(() => listResources(pool), {
    label: 'locks:check_command:list-resources',
  });
  const matched = matchCommandToResources(params.command, registry);
  if (matched.length === 0) return { decision: 'allow', matched: [] };

  const entries: BashMatchEntry[] = [];
  let decision: BashCheckVerdict['decision'] = 'allow';
  for (const r of matched) {
    const q = await withPgRetry(
      () =>
        readResourceQueue(pool, {
          coordinationDomain: params.coordinationDomain,
          resource: r.resource,
        }),
      { label: `locks:check_command:read-resource:${r.resource}` },
    );
    const exclusiveActive = q.holders.some((h) => h.mode === 'exclusive');
    const exclusiveByOther = q.holders.some(
      (h) => h.mode === 'exclusive' && h.owner !== params.ownerId,
    );
    entries.push({
      resource: r.resource,
      enforcement: r.enforcement,
      exclusiveActive,
      exclusiveByOther,
      draining: q.draining,
    });
    if (exclusiveByOther) {
      if (r.enforcement === 'enforced' || r.enforcement === 'checked') decision = 'block';
      else if (decision !== 'block') decision = 'warn';
    }
  }
  return { decision, matched: entries };
}

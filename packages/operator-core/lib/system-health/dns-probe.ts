/**
 * Host DNS-resolution canary for the infra health panel (WI-6554700010008585 recurrence guard).
 *
 * INCIDENT: on 2026-10-11 from 14:38Z the box's systemd-resolved (255) rejected EVERY lookup with a
 * DNSSEC "missing-key" error because its built-in root trust anchors predate KSK-2024. Every outbound
 * call (LLM providers, GitHub, container registries) failed for ~46 minutes and no alarm fired: the
 * infra-liveness evaluator had no DNS signal at all. This probe gives it one.
 *
 * DESIGN
 * - Resolves a few well-known canary names through the SYSTEM resolver configuration (/etc/resolv.conf,
 *   i.e. the systemd-resolved stub on this box), which is the path that failed.
 * - Uses `dns.promises.Resolver` (c-ares), NOT `dns.lookup`. `lookup` runs getaddrinfo on the libuv
 *   threadpool (4 threads by default); during an outage each hung call would hold a pool thread for the
 *   full resolver timeout, starving fs/crypto work in the host process. c-ares is non-blocking and its
 *   `timeout`/`tries` bound each query.
 * - `allFailed` (every canary failed) is the alarm predicate. A single name failing is recorded for
 *   evidence but does not page: one upstream domain's outage is not a box-wide resolver failure.
 * - Never throws. A probe that cannot run returns null from the caller's catch, which the evaluator
 *   treats as UNOBSERVED (never as recovered).
 */
import { Resolver } from 'node:dns/promises';

/** Canary names: the hosts whose resolution the fleet actually depends on. Kept to three so a tick
 *  costs three small UDP queries. */
export const DNS_CANARY_NAMES: readonly string[] = ['registry-1.docker.io', 'api.github.com', 'api.openai.com'];

/** Per-query timeout handed to c-ares, and the hard wall-clock bound per name. */
export const DNS_PROBE_TIMEOUT_MS = 2500;

export interface DnsNameResult {
  name: string;
  ok: boolean;
  ms: number;
  /** c-ares error code (e.g. ESERVFAIL, ENOTFOUND, ECONNREFUSED) or 'timeout'. Absent when ok. */
  error?: string;
}

export interface DnsProbeResult {
  /** Every canary resolved. */
  ok: boolean;
  /** Every canary failed: the box-wide outage signature the liveness alarm pages on. */
  allFailed: boolean;
  /** Wall-clock duration of the whole probe (names run concurrently). */
  probeMs: number;
  names: DnsNameResult[];
}

/** Resolves one name to at least one address, or rejects. Injected in tests. */
export type DnsResolveFn = (name: string) => Promise<readonly unknown[]>;

function defaultResolveFn(timeoutMs: number): { resolve: DnsResolveFn; cancel: () => void } {
  // tries:1 so a dead resolver costs one timeout, not the c-ares default of four.
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  return { resolve: (name) => resolver.resolve4(name), cancel: () => resolver.cancel() };
}

function errorCode(e: unknown): string {
  if (e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string') {
    return (e as { code: string }).code;
  }
  return e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120);
}

export async function probeDnsResolution(
  opts: { names?: readonly string[]; timeoutMs?: number; resolve?: DnsResolveFn; now?: () => number } = {},
): Promise<DnsProbeResult> {
  const names = opts.names ?? DNS_CANARY_NAMES;
  const timeoutMs = opts.timeoutMs ?? DNS_PROBE_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const fallback = opts.resolve ? null : defaultResolveFn(timeoutMs);
  const resolve = opts.resolve ?? fallback!.resolve;
  const t0 = now();
  try {
    const results = await Promise.all(
      names.map(async (name): Promise<DnsNameResult> => {
        const start = now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), timeoutMs + 500);
          });
          const addrs = await Promise.race([resolve(name), timeout]);
          if (!Array.isArray(addrs) || addrs.length === 0) {
            return { name, ok: false, ms: now() - start, error: 'ENODATA' };
          }
          return { name, ok: true, ms: now() - start };
        } catch (e) {
          return { name, ok: false, ms: now() - start, error: errorCode(e) };
        } finally {
          if (timer) clearTimeout(timer);
        }
      }),
    );
    const okCount = results.filter((r) => r.ok).length;
    return {
      ok: results.length > 0 && okCount === results.length,
      allFailed: results.length > 0 && okCount === 0,
      probeMs: now() - t0,
      names: results,
    };
  } finally {
    fallback?.cancel();
  }
}

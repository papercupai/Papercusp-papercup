/**
 * Recurrence guard for WI-10006515: raw `origin === 'remote'` / `origin !== 'local'` decisions.
 *
 * `origin` records how a work-item row ARRIVED, not who wrote it (WI-10003565). A sync echo can
 * leave one of this node's OWN rows at origin='remote', and every decision that reads the raw
 * column then treats our own row as a peer's: refuses to write it, hides it, or routes it to the
 * human tier. WI-10006314 fixed one such door, and WI-10006515 audited the rest. Each surviving
 * site below is either own-node aware (it heals with selfHealOwnNodeOriginIfStranded /
 * healOwnNodeIssueOrigin, or consults ownNodeAuthoredRemoteIds / issueOwnAuthorWhereSql / own
 * keys) or was reviewed and is not a write-authority decision about a work-item row.
 *
 * The census is per FILE (comments stripped), so moving a site within a file is free. A NEW
 * site, or a new file, fails: make the decision own-node aware (see work-items-admission.ts),
 * then add the file here with its reason. A file whose count DROPS also fails, so the baseline
 * shrinks with the code instead of keeping stale headroom.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripCommentsOnly } from '../../../scripts/lib/strip-comments-and-strings.mjs';

const LIB_ROOT = fileURLToPath(new URL('.', import.meta.url));

/** Same matcher the baseline was measured with: `origin ===|!== 'remote'|'local'`, either quote. */
const RAW_ORIGIN_DECISION =/\borigin\s*(===|!==)\s*(['"])(remote|local)\2/g;

/**
 * Directories excluded wholesale. The hyperbee projections are the federation ARRIVAL path:
 * they are where `origin` is assigned, so their checks describe transport, not authority.
 */
const EXCLUDED_DIRS: ReadonlySet<string> = new Set(['node_modules', '_retired', 'hyperbee']);

const AWARE = 'own-node aware: heals the stranded origin or consults own author keys first';
const NOT_AUTHORITY = 'reviewed (WI-10006515): not a write-authority decision on a work-item row';

/** Measured 2026-10-06 by WI-10006515 with RAW_ORIGIN_DECISION over comment-stripped source. */
const BASELINE: Readonly<Record<string, { count: number; reason: string }>> = {
  'agent-tools/plans/restore-historical-shipment.ts': { count: 1, reason: `${NOT_AUTHORITY} (plan body federation, not work_items)` },
  'agent-tools/work_items/complete.ts': { count: 2, reason: `${AWARE} (early own-node hatch; advice text only for true remote)` },
  'agent-tools/work_items/rehome.ts': { count: 1, reason: `${AWARE} (checks ownKeys)` },
  'attention/intake-promotion.ts': { count: 3, reason: `${AWARE} (deps.healOwnNodeOrigin before the in-place / source-pointer decisions, WI-10007634)` },
  'endpoint-route/routes/desktop/report-problem.ts': { count: 2, reason: `${AWARE} (healOwnNodeIssueOrigin before the reporter-owns-source check, WI-10007634)` },
  'harness/improvements/reporter-status.ts': { count: 2, reason: `${AWARE} (healOwnNodeIssueOrigin before the fixer-asks-reporter check, WI-10007634)` },
  'work-item-blocking.ts': { count: 1, reason: `${AWARE} (ownNodeAuthored via issueOwnAuthorWhereSql; the clear heals origin, WI-10007634)` },
  'agent-tools/work_items/release.ts': { count: 2, reason: `${AWARE} (healOwnNodeIssueOrigin, then retry)` },
  'goal-launch-settings.ts': { count: 1, reason: `${NOT_AUTHORITY} (goal-launch classification report)` },
  'handoff-context.ts': { count: 1, reason: `${NOT_AUTHORITY} (normalises the label for display)` },
  'harness/improvements/agent-review-policy.ts': { count: 1, reason: `${AWARE} (callers heal before the pure policy runs)` },
  'harness/improvements/agent-review.ts': { count: 1, reason: `${AWARE} (healOwnNodeOrigin entry)` },
  'harness/improvements/read-items.ts': { count: 2, reason: `${AWARE} (ownNodeRemoteIds drops the remote label)` },
  'harness/improvements/resolve-core.ts': { count: 2, reason: `${AWARE} (heal at entry)` },
  'harness/improvements/unowned-critical-escalation.ts': { count: 2, reason: `${AWARE} (ownNodeAuthoredRemoteIds)` },
  'memory/corpus-sweep.ts': { count: 1, reason: `${NOT_AUTHORITY} (memory rows)` },
  'plan-acceptance-gate.ts': { count: 1, reason: `${NOT_AUTHORITY} (rubric provenance)` },
  'plan-parts/reconcile.ts': { count: 1, reason: `${NOT_AUTHORITY} (plan parts)` },
  'pot/cup-wake-dossier.ts': { count: 1, reason: `${NOT_AUTHORITY} (wake dossier text)` },
  'stranded-checkpoint-scan.ts': { count: 1, reason: `${AWARE} (own_node_authored via issueOwnAuthorWhereSql lifts the remote label, WI-10006562)` },
  'work-item-admission-recovery.ts': { count: 2, reason: `${AWARE} (heal before the local-only refusal)` },
  'work-item-topic-tags.ts': { count: 2, reason: `${AWARE} (heal-and-retry once)` },
  'work-items-admission-promoter.ts': { count: 2, reason: `${AWARE} (snapshot ownNode mark)` },
  'work-items-admission.ts': { count: 2, reason: 'defines the local-claimability predicates the own-node helpers extend' },
  'work-items-hold-open.ts': { count: 1, reason: `${NOT_AUTHORITY} (hold-open eligibility read)` },
  'work-items-orphan-author.ts': { count: 1, reason: 'repair permit: only a remote row can be an orphan-author candidate' },
  'work-items-terminal-owner-origin-heal.ts': { count: 1, reason: 'repair permit: only a remote row can need an origin heal' },
  'work-items.ts': { count: 10, reason: `${AWARE} (selfHealOwnNodeOriginIfStranded before each refusal)` },
};

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return EXCLUDED_DIRS.has(entry.name) ? [] : walk(path);
    const source = /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts');
    return source ? [path] : [];
  });
}

/** Per-file count of raw origin decisions in live code (comments stripped, strings kept). */
function countRawOriginDecisions(text: string, fileName: string): number {
  return [...stripCommentsOnly(text, fileName).matchAll(RAW_ORIGIN_DECISION)].length;
}

function census(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const file of walk(LIB_ROOT)) {
    const count = countRawOriginDecisions(readFileSync(file, 'utf8'), file);
    if (count > 0) out[relative(LIB_ROOT, file).split('\\').join('/')] = count;
  }
  return out;
}

describe('raw origin decision sites (WI-10006515 own-node recurrence guard)', () => {
  it('the matcher counts live decisions and ignores the same text in comments', () => {
    const src = [
      "// a comment: if (x.origin === 'remote') refuse",
      "if (row.origin === 'remote') return refuse();",
      'const peer = item.origin !== "local";',
      "const sql = `origin = 'remote'`; // a SQL predicate is not a JS decision",
    ].join('\n');
    expect(countRawOriginDecisions(src, 'fixture.ts')).toBe(2);
  });

  it('the census sees the population at all (positive control)', () => {
    const found = census();
    // work-items.ts is the densest file; if it reads 0 the walk or the matcher is broken.
    expect(found['work-items.ts'] ?? 0).toBeGreaterThan(0);
    expect(Object.keys(found).length).toBeGreaterThan(10);
  });

  it('every raw origin decision in operator-core/lib matches the reviewed baseline', () => {
    const found = census();
    const problems: string[] = [];
    for (const [file, count] of Object.entries(found)) {
      const base = BASELINE[file];
      if (!base) {
        problems.push(`${file}: ${count} new raw origin decision(s). An own row stranded at origin='remote' would be treated as a peer's here. Make it own-node aware (ownNodeAuthoredRemoteIds / selfHealOwnNodeOriginIfStranded in work-items-admission.ts), then add the file to BASELINE with its reason.`);
      } else if (count > base.count) {
        problems.push(`${file}: ${count} raw origin decisions, baseline ${base.count}. Make the new one own-node aware, then raise this entry with a reason.`);
      } else if (count < base.count) {
        problems.push(`${file}: ${count} raw origin decisions, baseline ${base.count}. Lower the baseline to ${count}.`);
      }
    }
    for (const file of Object.keys(BASELINE)) {
      if (!(file in found)) problems.push(`${file}: no raw origin decisions left. Remove it from BASELINE.`);
    }
    expect(problems).toEqual([]);
  });
});

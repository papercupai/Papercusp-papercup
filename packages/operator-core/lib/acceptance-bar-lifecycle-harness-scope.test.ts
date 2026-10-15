/**
 * Recurrence guard for WI-10005140: every production door that reads the acceptance-BAR
 * lifecycle must scope the read to the subject plan's HARNESS.
 *
 * `readAndEvaluateAcceptanceBarLifecycle(planSlug, phase, options)` reads `harness_plans` by
 * workspace + plan slug, and narrows to one harness ONLY when `options.harnessSlug` is passed.
 * A plan slug is unique per harness, not per workspace — a built-in template is installed once
 * per harness — so an unscoped read can see two rows and refuse `bar_snapshot_plan_ambiguous`.
 * That is exactly how the gmail/slack flagship plan-runs were refused `not-startable`
 * (plan-run-action.ts), and the same omission sat in plan-workitem-promotion-run.ts.
 *
 * The guard scans the operator-core lib tree (every production caller lives there today) for
 * call sites and requires each call's argument list to name `harnessSlug`. A door that truly has
 * no harness to pass must say so with `harnessSlug: undefined` — a decision written at the call
 * site — rather than silently omitting it.
 *
 * KNOWN_UNSCOPED is SHRINK-ONLY: it records the scorecard doors still owed a fix under
 * WI-10005160. The count per file must match exactly, so fixing a site fails this test until its
 * allowlist entry is removed, and a new unscoped site fails it immediately.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripCommentsAndStrings } from '../../../scripts/lib/strip-comments-and-strings.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB_ROOT = process.env.PROBE_BAR_LIFECYCLE_SCOPE_LIB_ROOT ?? HERE;
const CALLEE = 'readAndEvaluateAcceptanceBarLifecycle';

/** Lib-relative file → number of call sites still unscoped. Shrink-only (WI-10005160). */
const KNOWN_UNSCOPED: Readonly<Record<string, number>> = {};

interface CallSite {
  line: number;
  scoped: boolean;
}

/** Return every call of CALLEE in `source` (not its definition) and whether it names harnessSlug. */
function findLifecycleCalls(source: string, fileName: string, callee: string = CALLEE): CallSite[] {
  const masked: string = stripCommentsAndStrings(source, fileName);
  const calls: CallSite[] = [];
  const re = new RegExp(`\\b${callee}\\s*\\(`, 'g');
  for (let match = re.exec(masked); match; match = re.exec(masked)) {
    const before = masked.slice(Math.max(0, match.index - 40), match.index);
    if (/\bfunction\s+$/.test(before)) continue;
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < masked.length; end++) {
      const ch = masked[end];
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) break;
    }
    const args = masked.slice(match.index + match[0].length, end);
    calls.push({
      line: masked.slice(0, match.index).split('\n').length,
      scoped: /\bharnessSlug\b/.test(args),
    });
  }
  return calls;
}

function productionSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...productionSources(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('acceptance-BAR lifecycle reads are harness-scoped (WI-10005140)', () => {
  it('the detector flags an unscoped call and passes a scoped one (calibration)', () => {
    const sample = [
      `async function ${CALLEE}(planSlug: string) {}`,
      `// ${CALLEE}(commentedOut)`,
      `await ${CALLEE}(slug, 'pre-start');`,
      `await ${CALLEE}(slug, 'pre-start', { expectedApplicable: true });`,
      `await ${CALLEE}(slug, 'pre-start', { harnessSlug: opts.harnessSlug });`,
      `await ${CALLEE}(slug, 'ship', {\n  ...(h ? { harnessSlug: h } : {}),\n});`,
      `await ${CALLEE}(slug, 'pre-grading', { harnessSlug: undefined });`,
    ].join('\n');
    expect(findLifecycleCalls(sample, 'sample.ts').map((c) => c.scoped)).toEqual([false, false, true, true, true]);
  });

  it('every production caller passes harnessSlug, except the shrink-only WI-10005160 sites', () => {
    const unscoped: Record<string, number[]> = {};
    let total = 0;
    for (const file of productionSources(LIB_ROOT)) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes(CALLEE)) continue;
      for (const call of findLifecycleCalls(source, file)) {
        total++;
        if (call.scoped) continue;
        const rel = path.relative(LIB_ROOT, file).split(path.sep).join('/');
        (unscoped[rel] ??= []).push(call.line);
      }
    }
    // Positive control: the scan must actually find the known doors, or an empty result is vacuous.
    expect(total).toBeGreaterThanOrEqual(8);
    const counts = Object.fromEntries(Object.entries(unscoped).map(([file, lines]) => [file, lines.length]));
    expect(counts, `unscoped lifecycle reads: ${JSON.stringify(unscoped)}`).toEqual(KNOWN_UNSCOPED);
  });
});

// WI-10005167: plan_items is keyed (workspace, harness, slug, item), so an unscoped
// getPlanItemStatuses(slug) MERGES two harnesses' same-slug plans. A caller may pass
// harnessSlug only when it holds the plan's OWN harness (a wrong one answers [] and the
// callers fail open), so the remaining sites are tracked, not forced.
const ITEM_READ_CALLEE = 'getPlanItemStatuses';

/** Lib-relative file → unscoped call count. Shrink-only; WI-10005174 drives it to {}. */
const KNOWN_UNSCOPED_ITEM_READS: Readonly<Record<string, number>> = {};

describe('plan-item reads are harness-scoped (WI-10005167)', () => {
  it('the detector flags an unscoped item read and passes a scoped one (calibration)', () => {
    const sample = [
      `export async function ${ITEM_READ_CALLEE}(planSlug: string, scope = {}) {}`,
      `await ${ITEM_READ_CALLEE}(slug);`,
      `await ${ITEM_READ_CALLEE}(slug, { harnessSlug: planHarnessSlug });`,
    ].join('\n');
    expect(findLifecycleCalls(sample, 'sample.ts', ITEM_READ_CALLEE).map((c) => c.scoped)).toEqual([false, true]);
  });

  it('every production caller passes the plan harness, except the shrink-only WI-10005174 sites', () => {
    const unscoped: Record<string, number[]> = {};
    let total = 0;
    for (const file of productionSources(LIB_ROOT)) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes(ITEM_READ_CALLEE)) continue;
      for (const call of findLifecycleCalls(source, file, ITEM_READ_CALLEE)) {
        total++;
        if (call.scoped) continue;
        const rel = path.relative(LIB_ROOT, file).split(path.sep).join('/');
        (unscoped[rel] ??= []).push(call.line);
      }
    }
    // Positive control: emit x1 + ship gate x2 + audit x2 + supersede x1.
    expect(total).toBeGreaterThanOrEqual(6);
    const counts = Object.fromEntries(Object.entries(unscoped).map(([file, lines]) => [file, lines.length]));
    expect(counts, `unscoped plan-item reads: ${JSON.stringify(unscoped)}`).toEqual(KNOWN_UNSCOPED_ITEM_READS);
  });
});

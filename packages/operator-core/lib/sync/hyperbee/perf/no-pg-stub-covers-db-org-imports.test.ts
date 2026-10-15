/**
 * The perf peer-child resolves `@papercusp/db-org` to `no-pg-stub.mjs` (see no-pg-hooks.mjs).
 * A named ESM import is bound at INSTANTIATE time, so a name the stub does not export is not a
 * lazy "throws when touched" — it is a hard link error that kills the child before it runs a
 * single line:
 *
 *   SyntaxError: The requested module '@papercusp/db-org' does not provide an export named 'X'
 *
 * The parent (`child-driver.ts`) only ever sees `waitFor('ready')` resolve null after its 30s
 * timeout, and routes the child's stderr into a `logs` array that the failing assertion never
 * prints. So the observable symptom is an opaque timeout and the actual one-line cause is
 * invisible.
 *
 * MEASURED (WI-761481, 2026-08-29): `resource-governor/execution.ts` imports
 * `createDedicatedOrgPg` from `@papercusp/db-org`. The stub exported only `getOrgPg` and `orgPg`,
 * so every perf peer-child died at link time. `child-driver.test.ts` sat red on the
 * green-checkpoint gate as `expected null to match object { evt: 'ready' }` — a 30-second
 * timeout that names nothing — and diagnosing it required booting the child by hand.
 *
 * The stub's export list is therefore a SECOND COPY of a truth the operator-core sources own, and
 * it drifts silently. This guard DERIVES the required set from those sources so a new named
 * import fails HERE, in milliseconds, with the missing name — instead of hours later in the gate
 * as a nameless timeout.
 *
 * SCOPE: `packages/`. Over-inclusion is the safe direction — an extra stub binding is inert
 * (tsx erases type-only imports, and an unused runtime binding is never called), while a missing
 * one is fatal — so this deliberately does not try to narrow the scan to the child's exact
 * transitive graph.
 *
 * MEASURED AGAIN (WI-2141194, 2026-09-02): this guard was GREEN AND BLIND while the child was
 * dying. It scanned only `packages/operator-core/lib`, and its in-scope set was fully covered —
 * but `packages/agent-mcp/src/auth.ts` binds `getOrgPgListener`, which the stub did not export,
 * so every peer-child died at link time and `child-driver.test.ts` sat red on the gate with the
 * same nameless 30s timeout this guard was written to abolish. A guard derived from a scope
 * NARROWER than the child's real module graph reports a clean bill of health for the exact break
 * it exists to catch. Widening the root to `packages/` closes that, at ~365 extra files (~3%).
 *
 * FALSIFIABILITY of that widening was proven out-of-tree, NOT by watching this test go red: by
 * the time the scope was widened a peer had already fixed the stub, so the red was no longer
 * reproducible here. Instead this file's scan logic was replayed in a scratch script against two
 * stubs — the PRE-FIX one from `git HEAD` (mutant arm) and the fixed one (control). The mutant arm
 * named exactly the five then-missing killers — `explainOnConflictSkew`, `getOrgPgListener`,
 * `goalsForPot`, `linkPot`, `unlinkPot`, all in `agent-mcp/src` — and the control arm named none.
 * That is a RECONSTRUCTION of this assertion, not this assertion executing; re-derive it before
 * treating the widened scope as load-bearing.
 *
 * KNOWN AND ACCEPTED FALSE POSITIVE — do NOT "fix" it by tightening the regex. The scan is raw
 * TEXT matching, so it cannot tell a real import from a db-org import statement written inside a
 * STRING: a fixture, a doc example, a code sample. `no-top-level-db-org-call-in-peer-child-graph
 * .test.ts` builds exactly such fixtures, and its line ``import type { OrgPg } from '@papercusp/
 * db-org';`` made this guard demand an `OrgPg` export that nothing actually imports (2026-09-02).
 * The right response is what was done: ADD the inert stub binding. Tightening the pattern to
 * exclude quoted occurrences trades a harmless false POSITIVE for the risk of a false NEGATIVE,
 * and a false negative here is fatal — it is the whole failure this file exists to prevent. The
 * asymmetry is the entire design: an extra binding costs one line, a missing one costs every
 * peer-child and days of nameless 30s gate timeouts.
 *
 * (That red was NOT caused by widening the root: the fixture lives under
 * `packages/operator-core/lib/`, so the pre-widening scan matched the same string. Attributing it
 * to the wider scope would argue for reverting the fix to a real blindness.)
 *
 * ON THE ROOT (measured 2026-09-02, not reasoned): scanning every root-package.json workspace
 * instead of `packages/` adds exactly TWO names — `createInsertSchema` (db-org's own
 * `schema/zod.ts`) and `restoreRawJsonbSerializer` (an `apps/operator` script) — and both are
 * already exported, so a workspace-wide root would pass today too. The two roots are therefore
 * near-equivalent in practice; `packages/` is kept because it is where the child's graph actually
 * reaches and it excludes db-org's own source on principle. `dist/` is skipped because build
 * output only duplicates source truth already scanned.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** `packages/` — see the SCOPE note above for why the root is here and not narrower/wider. */
const PACKAGES_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

/** Every `{ … }` clause bound against '@papercusp/db-org', import or re-export. */
const DB_ORG_CLAUSE =
  /(?:import|export)\s+(?:type\s+)?(?:[A-Za-z0-9_$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]@papercusp\/db-org['"]/g;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.mts')) out.push(full);
  }
  return out;
}

/** `type Foo as Bar` / `Foo as Bar` / `Foo` → the name the MODULE must export (`Foo`). */
function importedName(clauseItem: string): string | null {
  const cleaned = clauseItem.trim().replace(/^type\s+/, '');
  if (!cleaned) return null;
  const source = cleaned.split(/\s+as\s+/)[0].trim();
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(source) ? source : null;
}

describe('no-pg-stub covers every @papercusp/db-org named import in the peer-child substrate', () => {
  it('exports every name operator-core binds from @papercusp/db-org', async () => {
    // Imported through a NON-LITERAL specifier deliberately. A literal `import ... from
    // './no-pg-stub.mjs'` needs a hand-written `.d.mts` sidecar enumerating all 61 names — which
    // is a THIRD copy of the very list this guard exists to stop from drifting, and one nothing
    // would check. The dynamic form still performs a real module link, so a stub that fails to
    // parse or evaluate still fails here.
    const stub = (await import(new URL('./no-pg-stub.mjs', import.meta.url).href)) as Record<string, unknown>;

    const required = new Map<string, string[]>();

    for (const file of tsFilesUnder(PACKAGES_ROOT)) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('@papercusp/db-org')) continue;
      for (const match of text.matchAll(DB_ORG_CLAUSE)) {
        for (const item of match[1].split(',')) {
          const name = importedName(item);
          if (!name) continue;
          const seen = required.get(name) ?? [];
          if (seen.length < 3) seen.push(file.slice(PACKAGES_ROOT.length));
          required.set(name, seen);
        }
      }
    }

    // A scan that finds nothing would pass vacuously and guard exactly nothing. The break this
    // exists for is a name the scan DID find; a zero here means the regex or the walk broke.
    expect(required.size).toBeGreaterThan(10);

    const missing = [...required.keys()].filter((name) => !(name in stub)).sort();

    expect(
      missing,
      missing.length === 0
        ? ''
        : `no-pg-stub.mjs is missing ${missing.length} export(s) that operator-core binds from ` +
          `'@papercusp/db-org'. A named ESM import is bound at LINK time, so each of these kills ` +
          `every perf peer-child before it emits a single event — surfacing only as an opaque ` +
          `30s 'expected null to match { evt: ready }' timeout in child-driver.test.ts.\n\n` +
          missing.map((n) => `  ${n}  (e.g. ${required.get(n)!.join(', ')})`).join('\n') +
          `\n\nFix: add \`export const <name> = stub('<name>');\` to no-pg-stub.mjs for each. ` +
          `Do NOT soften the stub to a catch-all — the throwing binding is what keeps a perf run ` +
          `that reaches Postgres from being read as a measurement.`,
    ).toEqual([]);
  });

  it('keeps diagnostic bindings linkable while rejecting accidental database use', async () => {
    const stub = (await import(new URL('./no-pg-stub.mjs', import.meta.url).href)) as Record<string, unknown>;
    for (const name of ['pgDiagnosticIdentity', 'recordPgResult', 'acquireTicketSnapshot', 'retryBeforeCallbackStarts'] as const) {
      const binding = stub[name];
      expect(binding).toBeTypeOf('function');
      expect(() => (binding as () => unknown)()).toThrow(`reached via \`${name}\``);
    }
  });
});

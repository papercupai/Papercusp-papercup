/**
 * The release-fixer PROMPT↔GRANT contract, DERIVED — not hand-listed
 * (gate-verdict-liveness-and-repair-reliability-2026-08-31 P-007).
 *
 * The defect this exists to stop has recurred six times: the green-checkpoint
 * gate dispatches a release-fixer, the fixer's own runbook tells it to call a
 * verb, and the platform refuses that verb with `role_not_allowed` /
 * `missing_capability` — so a live frozen-candidate repair burns its turns on
 * discovery calls and refusals while `main` stays held
 * (EI-21988345999773689, EI-21987169451481399, EI-21979521274634237,
 * EI-21873951345538817, WI-1179061, EI-21858582589944537).
 *
 * WHY DERIVED. A sibling test
 * (endpoint-route/routes/transport/role-principal-caps.test.ts) already pins
 * this role's grants — but against a HAND-WRITTEN list of tools. That list is a
 * second copy of a truth the prompt owns, so it cannot notice the failure mode
 * that actually happens here: someone edits the runbook to mandate one more
 * verb and nobody edits the grant tables. Per CLAUDE.md's derived-truth ladder
 * that is rung 4 (curated) where rung 1 (derive) is available. This file takes
 * rung 1: it EXTRACTS the mandated verbs from the prompt/brief text the fixer is
 * actually spawned with, and asserts each one clears BOTH dispatch gates for
 * `release-fixer`. Adding a verb to the runbook without granting it fails here;
 * so does revoking a grant for a verb the runbook still names.
 *
 * THE TWO GATES (both are load-bearing; either one alone is inert):
 *   1. the role allowlist — `agentRoles` on the tool descriptor
 *      (absent ⇒ open to every role), checked by dispatch-stack's
 *      `role-allowlist` step BEFORE any capability check;
 *   2. the capability — the tool's declared `capability`, which must be in the
 *      set `loadRoleCapabilities()` synthesizes for a spawned `release-fixer`
 *      (it has no `system_principals` row; its baseline is
 *      BLUEPRINT_ROLE_CAPS['release-fixer']).
 *
 * PRECISION. The extraction is deliberately not "any backtick token": prompts
 * are dense with tool-SHAPED strings that are not tools — result-field paths
 * (`willJudge.candidate`), arg literals (`force:true`), and — the collision
 * ruled on in agent-trap-guards-2026-07-26#D-003 — capability names, which share
 * the `namespace:verb` spelling with tool verbs. The filter that makes this
 * precise without a hand-maintained allowlist is intersecting the extracted
 * tokens with the REAL static tool catalog (../static-tool-catalog.ts, the same
 * scanner blueprint-deps-catalog.test.ts and prompt-blueprint-verb-catalog.test.ts
 * use). Measured on the live corpus: 8 tool mentions, 0 false positives.
 *
 * Pure-static + in-process: filesystem reads, the pure kickoff builder, and
 * dynamic imports of the ~8 named tool modules. No PG, no network, no operator.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { Sql } from 'postgres';
import { lookup, SU_ROLES } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../agent-tools/coordination/roles';
import { buildBuiltinToolCatalog, buildBuiltinToolFileIndex } from '../static-tool-catalog';
import { loadRoleCapabilities } from '../endpoint-route/routes/transport/role-principal-caps';
import { buildReleaseFixerKickoff } from '../harness/routines/release-actions';
import type { FrozenCandidateRepairQueue } from './frozen-candidate-repair-queue';

const __dirname = dirname(new URL(import.meta.url).pathname);
const REPO = join(__dirname, '../../../../');
const BLUEPRINTS = join(REPO, 'libs/papercusp/packages/harness/blueprints');
const OPERATOR_PROMPTS = join(REPO, 'apps/operator/prompts');

/** The launch blueprint green-checkpoint fires on `green-checkpoint:red`, and its decider role. */
const BLUEPRINT_ID = 'release-fix';
const ROLE = 'release-fixer';

// ── the corpus: everything the spawned fixer is told to do ───────────────────

/** A fake `tx` tagged-template returning no rows — the "no system_principals row"
 *  posture a blueprint-declared role actually spawns under. */
const noRows = (() => Promise.resolve([])) as unknown as Sql;

function blueprintExtends(id: string): string[] {
  const path = join(BLUEPRINTS, id, 'blueprint.yaml');
  if (!existsSync(path)) return [];
  const parsed = parseYaml(readFileSync(path, 'utf8')) as { extends?: unknown } | null;
  if (parsed?.extends == null) return [];
  return Array.isArray(parsed.extends) ? parsed.extends.map(String) : [String(parsed.extends)];
}

/** The leaf-first extends chain, always terminated by `base` — structurally the
 *  same walk orchestrator/prompt-resolve.ts does when it resolves a spawn's persona. */
function blueprintChain(id: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  const walk = (bp: string): void => {
    if (seen.has(bp)) return;
    seen.add(bp);
    chain.push(bp);
    for (const parent of blueprintExtends(bp)) walk(parent);
  };
  walk(id);
  if (!chain.includes('base')) chain.push('base');
  return chain;
}

/** Every persona file a `release-fixer` spawn of the `release-fix` blueprint resolves. */
function personaFiles(): string[] {
  const files: string[] = [];
  for (const bp of blueprintChain(BLUEPRINT_ID)) {
    const f = join(BLUEPRINTS, bp, 'prompts', `${ROLE}.md`);
    if (existsSync(f)) files.push(f);
  }
  for (const f of [join(OPERATOR_PROMPTS, `${ROLE}.tools.md`), join(OPERATOR_PROMPTS, `${ROLE}.persona.md`)]) {
    if (existsSync(f)) files.push(f);
  }
  return files;
}

/** The blueprint's own declared `dependencies.tools` — a machine-readable statement
 *  of what this launch needs, derived from the persona by scripts/derive-blueprint-deps.mjs. */
function declaredDependencyTools(): string[] {
  const parsed = parseYaml(
    readFileSync(join(BLUEPRINTS, BLUEPRINT_ID, 'blueprint.yaml'), 'utf8'),
  ) as { dependencies?: { tools?: unknown } } | null;
  const tools = parsed?.dependencies?.tools;
  return Array.isArray(tools) ? tools.map(String) : [];
}

/** The runtime task brief. Both dispatch shapes: the legacy staging dispatch and the
 *  frozen-candidate delegated-repair dispatch (which is where the six incidents happened). */
function kickoffBriefs(): string[] {
  const queue: FrozenCandidateRepairQueue = {
    schemaVersion: 4,
    phase: 'awaiting-fixer',
    candidate: 'c0ffee1234567890c0ffee1234567890c0ffee12',
    base: null,
    repairHead: 'deadbeef1234567890deadbeef1234567890dead',
    attempts: 1,
    openedAtMs: 0,
    updatedAtMs: 0,
    fixerSpawnId: 's-test-fixer',
    failingTests: ['packages/operator-core/lib/example.test.ts'],
    signature: [],
  };
  return [
    buildReleaseFixerKickoff({ candidate: 'c0ffee1234567890c0ffee1234567890c0ffee12' }),
    buildReleaseFixerKickoff({ candidate: queue.candidate, repairQueue: queue }),
  ];
}

// ── extraction ───────────────────────────────────────────────────────────────

const FILE_SUFFIX = /\.(md|ts|tsx|js|jsx|mjs|cjs|json|sh|py|css|html|toml|yaml|yml)$/i;

/**
 * Backtick-quoted `group:verb` / `group.verb` tokens — the same shape
 * scripts/derive-blueprint-deps.mjs reads persona files with, so the candidate set
 * this test judges is the same one the blueprint's declared deps were derived from.
 * Returns CANDIDATES; the catalog intersection below is what makes them precise.
 */
export function backtickTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/`([a-zA-Z0-9_]+[:.][a-zA-Z0-9_:.\-/]+)`/g)) {
    const token = m[1];
    if (FILE_SUFFIX.test(token) || token.includes('/')) continue;
    out.add(token);
  }
  // `plans:items {actionable:true}` — an arg-bearing span; take the leading verb.
  for (const m of text.matchAll(/`([a-zA-Z0-9_]+:[a-zA-Z0-9_.\-]+) [^`]*`/g)) out.add(m[1]);
  return out;
}

/**
 * Bare (un-quoted) `group:verb` tokens. The runtime kickoff brief is a plain string
 * assembled in TypeScript, not markdown — it names `release:repair-queue { op: 'get' }`
 * with no backticks at all, so the markdown shape above sees nothing in it.
 */
export function plainTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b([a-zA-Z0-9_]+:[a-zA-Z0-9_.\-]+)/g)) out.add(m[1]);
  return out;
}

interface Mention {
  tool: string;
  source: string;
}

/** Every catalog-resolving tool the fixer's prompt surfaces name, with where it was named. */
function mandatedTools(catalog: ReadonlySet<string>): Mention[] {
  const found = new Map<string, string>();
  const note = (tool: string, source: string): void => {
    if (!catalog.has(tool)) return;
    if (!found.has(tool)) found.set(tool, source);
  };
  for (const file of personaFiles()) {
    const rel = file.slice(REPO.length).replace(/^\/+/, '');
    for (const t of backtickTokens(readFileSync(file, 'utf8'))) note(t, rel);
  }
  for (const t of declaredDependencyTools()) {
    note(t, `${BLUEPRINT_ID}/blueprint.yaml dependencies.tools`);
  }
  for (const brief of kickoffBriefs()) {
    for (const t of plainTokens(brief)) note(t, 'buildReleaseFixerKickoff (runtime task brief)');
  }
  return [...found].map(([tool, source]) => ({ tool, source })).sort((a, b) => (a.tool < b.tool ? -1 : 1));
}

// ── the grant side ───────────────────────────────────────────────────────────

interface ToolGates {
  agentRoles?: readonly string[];
  capability?: string;
}

const FILE_INDEX = buildBuiltinToolFileIndex(REPO);

/**
 * Import the module(s) that declare `tool` and read the REAL descriptor.
 *
 * Two lookup routes, in this order, because neither alone covers the catalog:
 *   1. the module's own exports — `export default defineTool({…})` is the common
 *      shape and is immune to module-record splitting;
 *   2. the shared registry (`lookup`) — the ONLY route for the many verbs that
 *      self-register with NO export at all (every `events/sugar.ts` verb,
 *      `checkpoint:await` among them).
 * Route 2 depends on the tool module and this test resolving the SAME
 * `@papercusp/tooldef` registry record. Imports go through `pathToFileURL` for that
 * reason: a bare absolute POSIX path and a `file://` URL can resolve to two module
 * records under Vite's resolver, and a split registry answers `undefined` for a tool
 * that registered perfectly well — a false refusal, not a missing tool.
 */
async function gatesFor(tool: string): Promise<ToolGates | undefined> {
  for (const file of FILE_INDEX.get(tool) ?? []) {
    const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as Record<string, unknown>;
    for (const exported of Object.values(mod)) {
      const candidate = exported as { name?: unknown } & ToolGates;
      if (candidate && typeof candidate === 'object' && candidate.name === tool) return candidate;
    }
  }
  const registered = lookup(tool) as ToolGates | undefined;
  if (registered) return registered;
  for (const file of FILE_INDEX.get(tool) ?? []) {
    const parsed = staticGatesFor(file, tool);
    if (parsed) return parsed;
  }
  return undefined;
}

/**
 * Route 3 — read the gates out of the SOURCE of the `defineTool({…})` block that
 * declares `tool`.
 *
 * MEASURED, not defensive (2026-08-31): routes 1 and 2 both miss `checkpoint:await`
 * and its six `events/sugar.ts` siblings. Route 1 misses because those tools take the
 * bare `defineTool({…})` self-registering shape with no export of any kind. Route 2
 * misses because the registry this test reads and the registry those modules write are
 * NOT the same module record here — importing the module raises the catalog for
 * `@papercusp/agent-mcp`'s own tools but never for an operator-core tool imported by
 * path, which is the module-splitting hazard CLAUDE.md describes ("shared-lib
 * singletons"). The failure direction is what makes a third route necessary rather than
 * optional: a split registry answers `undefined`, which is indistinguishable from a
 * tool that does not exist — so a guard resting on route 2 alone would report the
 * healthy tools it CAN see and stay silent about the ones it cannot.
 *
 * Scope is deliberately narrow: literal role strings plus one level of `...SPREAD`,
 * resolved against the two shared role consts and any `const X = [...] as const` in the
 * same file. That covers every shape in the catalog today; an unresolvable spread
 * returns `undefined` so the caller reports a scan miss instead of inventing a verdict.
 */
function staticGatesFor(file: string, tool: string): ToolGates | undefined {
  const src = readFileSync(file, 'utf8');
  const blocks = src.split('defineTool(');
  const block = blocks.slice(1).find((b) => new RegExp(`name:\\s*['"]${tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(b));
  if (block === undefined) return undefined;
  const capability = /\n\s*capability:\s*['"]([a-zA-Z0-9_:.\-]+)['"]/.exec(block)?.[1];
  const rolesSrc = /\n\s*agentRoles:\s*\[([^\]]*)\]/.exec(block)?.[1];
  if (rolesSrc === undefined) return { capability }; // no allowlist ⇒ open to every role
  const expand = (listSrc: string, depth: number): string[] | undefined => {
    const roles: string[] = [];
    for (const m of listSrc.matchAll(/['"]([a-zA-Z0-9_-]+)['"]/g)) roles.push(m[1]);
    for (const m of listSrc.matchAll(/\.\.\.([A-Z_][A-Z0-9_]*)/g)) {
      const ident = m[1];
      if (ident === 'SU_ROLES') { roles.push(...SU_ROLES); continue; }
      if (ident === 'COORD_ROLES') { roles.push(...COORD_ROLES); continue; }
      const local = new RegExp(`const ${ident}\\s*=\\s*\\[([^\\]]*)\\]`).exec(src)?.[1];
      const nested = depth > 0 && local !== undefined ? expand(local, depth - 1) : undefined;
      if (nested === undefined) return undefined; // unresolvable — do not guess
      roles.push(...nested);
    }
    return roles;
  };
  const agentRoles = expand(rolesSrc, 2);
  return agentRoles === undefined ? undefined : { agentRoles, capability };
}

interface Refusal {
  tool: string;
  source: string;
  reason: string;
}

/**
 * The PURE dispatch verdict for one already-resolved tool — both gates, in the order
 * dispatch-stack applies them. `undefined` agentRoles = open to every role; `undefined`
 * capability = no capability gate. Split out from the resolution wrapper so the
 * falsifiability controls can drive it with synthetic gates: a control that has to name
 * a REAL currently-denied tool silently stops proving anything the day that tool is
 * granted, which is the failure mode a falsifiability control exists to rule out.
 */
export function evaluateGates(
  mention: Mention,
  gates: ToolGates | undefined,
  role: string,
  caps: ReadonlySet<string>,
): Refusal[] {
  const { tool, source } = mention;
  if (!gates) return [{ tool, source, reason: 'no descriptor found (tool file index miss)' }];
  const refusals: Refusal[] = [];
  if (gates.agentRoles !== undefined && !gates.agentRoles.includes(role)) {
    refusals.push({ tool, source, reason: `role_not_allowed — agentRoles omits "${role}"` });
  }
  if (gates.capability !== undefined && !caps.has(gates.capability)) {
    refusals.push({ tool, source, reason: `missing_capability "${gates.capability}"` });
  }
  return refusals;
}

/** Resolve each mention's real gates, then apply {@link evaluateGates}. */
async function refusalsFor(
  mentions: readonly Mention[],
  role: string,
  caps: ReadonlySet<string>,
): Promise<Refusal[]> {
  const refusals: Refusal[] = [];
  for (const mention of mentions) {
    refusals.push(...evaluateGates(mention, await gatesFor(mention.tool), role, caps));
  }
  return refusals;
}

// ── the contract ─────────────────────────────────────────────────────────────

describe('release-fixer: every verb its own prompt mandates is callable under its role', () => {
  const catalog = buildBuiltinToolCatalog(REPO);
  const mentions = mandatedTools(catalog);

  it('scan sanity — the corpus, the catalog, and the extraction are all real', () => {
    // A guard that cannot see its subject must not be able to report success.
    const personas = personaFiles();
    expect(personas.length, 'no release-fixer persona resolved from the release-fix chain').toBeGreaterThan(0);
    expect(personas.some((f) => f.endsWith('blueprints/base/prompts/release-fixer.md'))).toBe(true);
    expect(readFileSync(personas[0], 'utf8').length).toBeGreaterThan(2000);
    expect(catalog.size, 'static tool catalog scan found ~nothing').toBeGreaterThan(100);
    expect(declaredDependencyTools().length).toBeGreaterThan(0);
    expect(kickoffBriefs().every((b) => b.length > 100)).toBe(true);
    expect(mentions.length, 'extracted no mandated tools at all').toBeGreaterThanOrEqual(6);
  });

  it(
    'every mandated verb clears BOTH dispatch gates (role allowlist + capability)',
    { timeout: 120_000 },
    async () => {
      const caps = await loadRoleCapabilities(noRows, 'ws', ROLE);
      const refusals = await refusalsFor(mentions, ROLE, caps);
      expect(
        refusals,
        [
          `${refusals.length} verb(s) the release-fixer's own prompt mandates would be REFUSED at dispatch —`,
          `the six-recurrence defect (EI-21988345999773689 & co): the gate spawns a fixer, the runbook tells it`,
          `to call these, and the platform says no, so a frozen candidate sits unrepaired.`,
          ...refusals.map((r) => `  ${r.tool}  [${r.reason}]  named by: ${r.source}`),
          ``,
          `Fix ONE of the two sides, never neither:`,
          `  (a) grant it — add "${ROLE}" to that tool's agentRoles AND its capability to`,
          `      BLUEPRINT_ROLE_CAPS['${ROLE}'] (endpoint-route/routes/transport/role-principal-caps.ts).`,
          `      Both halves: a capability without the allowlist is inert, and vice versa.`,
          `  (b) stop mandating it — remove the verb from the persona / blueprint deps / kickoff brief`,
          `      and say what the fixer should do instead.`,
          `Current release-fixer capabilities: ${[...caps].sort().join(', ')}`,
        ].join('\n'),
      ).toEqual([]);
    },
  );

  it('the derived set covers the verbs the runbook actually names (not a vacuous empty scan)', () => {
    // Anchored on the persona's own load-bearing procedures rather than on a count:
    // the verdict wait, the lineage check, the re-fire, the escalation, and BOTH
    // attribution routes the runbook offers in place of the forbidden `git blame`.
    const named = new Set(mentions.map((m) => m.tool));
    for (const tool of [
      'checkpoint:await',
      'release:trace',
      'release:checkpoint-run',
      'coord:escalate',
      'work_items:list',
      'plans:get',
      'sessions:search',
    ]) {
      expect(named, `${tool} is named by the runbook but the extraction lost it`).toContain(tool);
    }
    // From the runtime brief, which carries no backticks — proves the plain-token
    // reader is wired, not just the markdown one.
    expect(named).toContain('release:repair-queue');
  });

  it('grants the parent-required readiness handoff without operator routine access', async () => {
    const caps = await loadRoleCapabilities(noRows, 'ws', ROLE);
    const handoff = await refusalsFor(
      [
        { tool: 'events:emit', source: 'EI-26220351173478503 parent readiness handoff' },
        { tool: 'git-sync:await', source: 'EI-26220351173478503 scoped source settlement' },
      ],
      ROLE,
      caps,
    );
    expect(handoff).toEqual([]);

    // `routines:list` is not required by this workflow and would also add the
    // broader operator:read capability. Keep that least-privilege boundary pinned.
    expect(caps.has('operator:read')).toBe(false);
    expect(
      await refusalsFor(
        [{ tool: 'routines:list', source: 'not required by the release-fixer handoff' }],
        ROLE,
        caps,
      ),
    ).toEqual([
      {
        tool: 'routines:list',
        source: 'not required by the release-fixer handoff',
        reason: 'role_not_allowed — agentRoles omits "release-fixer"',
      },
      {
        tool: 'routines:list',
        source: 'not required by the release-fixer handoff',
        reason: 'missing_capability "operator:read"',
      },
    ]);
  });

  /* ------------------------------------------------------------------ *
   * FALSIFIABILITY CONTROLS — permanent, synthetic, never mutating the
   * shared tree (CLAUDE.md "proving a guard is falsifiable", module tier).
   * The checker above only ever asserts an EMPTY list, so on a healthy tree
   * it passes whether or not it can detect anything. These pin that it can.
   * ------------------------------------------------------------------ */
  describe('falsifiability + precision controls', () => {
    it('DOES refuse each way a dispatch actually refuses — the failure this test exists to produce', async () => {
      const caps = await loadRoleCapabilities(noRows, 'ws', ROLE);
      const mention: Mention = { tool: 'fixture:verb', source: 'control' };
      // 1. the role allowlist — the `role_not_allowed` half (EI-21873951345538817).
      expect(
        evaluateGates(mention, { agentRoles: ['operator'], capability: 'coord:read' }, ROLE, caps)
          .map((r) => r.reason),
        'the checker no longer detects an allowlist that omits the role',
      ).toEqual([`role_not_allowed — agentRoles omits "${ROLE}"`]);
      // 2. the capability — the `missing_capability` half (EI-21858582589944537).
      expect(
        evaluateGates(mention, { agentRoles: [ROLE], capability: 'secrets:read' }, ROLE, caps)
          .map((r) => r.reason),
        'the checker no longer detects a capability the role does not hold',
      ).toEqual(['missing_capability "secrets:read"']);
      // 3. an unresolvable descriptor is reported, never silently treated as granted —
      //    the false-negative direction a split module registry produces.
      expect(evaluateGates(mention, undefined, ROLE, caps)).toHaveLength(1);
      // 4. calibration: a genuinely granted shape must NOT be flagged, or 1–3 would
      //    also "pass" on a checker that refuses everything.
      expect(evaluateGates(mention, { agentRoles: [ROLE], capability: 'coord:write' }, ROLE, caps)).toEqual([]);
      expect(evaluateGates(mention, {}, ROLE, caps), 'an unlisted tool is open to every role').toEqual([]);
    });

    it('does NOT flag tool-SHAPED prose that is not a tool — result paths and arg literals', () => {
      // Every one of these appears verbatim in the live release-fixer runbook.
      const fixture = [
        "don't just trust `ok:true`/`launched:true`",
        'read the reply’s `willJudge.candidate` and `willJudge.excludedCommits`',
        'pass `replaceStale:true` to stop it',
        '`force:true` alone usually still fails mid-run',
        'supplied as `checkpointEvidence.logPath` alongside `checkpointEvidence.runId`',
        'add the workspace to `quarantine.txt` with a one-line reason',
      ].join('\n');
      const resolved = [...backtickTokens(fixture)].filter((t) => catalog.has(t));
      expect(resolved, 'a non-tool token resolved against the catalog').toEqual([]);
    });

    it('does NOT flag CAPABILITY names, which share the namespace:verb spelling (D-003)', () => {
      // agent-trap-guards-2026-07-26 D-003: a capability is a different surface from a
      // tool verb. These are exactly the strings this role's own grant table holds.
      const fixture = 'Granted `work_items:read`, `locks:write`, `operator:write`, `coord:write`.';
      const resolved = [...backtickTokens(fixture)].filter((t) => catalog.has(t));
      expect(resolved).toEqual([]);
    });
  });

  /* ------------------------------------------------------------------ *
   * THE SIX RECURRENCES, pinned by id. These verbs are not all named in
   * the persona text — several come from the platform's own first-turn
   * procedure (orient, register the work, read gate ownership) — so the
   * derivation above cannot reach them. They are listed here because each
   * one is a MEASURED refusal from a real dispatch, not a guess.
   * ------------------------------------------------------------------ */
  it(
    'the exact verbs the six incidents recorded as refused are now callable',
    { timeout: 120_000 },
    async () => {
      const caps = await loadRoleCapabilities(noRows, 'ws', ROLE);
      const measured: Array<[string, string]> = [
        ['coord:orient', 'EI-21988345999773689 / EI-21987169451481399 / EI-21979521274634237'],
        ['coord:escalate', 'EI-21858582589944537'],
        ['state:read', 'EI-21858582589944537 / EI-21873951345538817 / EI-21979521274634237'],
        ['work_items:create', 'EI-21873951345538817 / WI-1179061 / EI-21987169451481399'],
        ['work_items:comment', 'EI-21979521274634237'],
        ['locks:acquire', 'EI-21873951345538817 / WI-1179061'],
        ['release:repair-queue', 'WI-1179061 / EI-21979521274634237'],
        ['release:trace', 'EI-21979521274634237 / EI-21988345999773689'],
        ['docs:outline', 'EI-21979521274634237'],
        ['harness:escalation', 'EI-21979521274634237'],
        ['processes:list', 'EI-21979521274634237'],
      ];
      const refusals = await refusalsFor(
        measured.map(([tool, source]) => ({ tool, source })),
        ROLE,
        caps,
      );
      expect(
        refusals,
        `a verb a real release-fixer dispatch was already refused once is refused again:\n` +
          refusals.map((r) => `  ${r.tool}  [${r.reason}]  first observed: ${r.source}`).join('\n'),
      ).toEqual([]);
    },
  );
});

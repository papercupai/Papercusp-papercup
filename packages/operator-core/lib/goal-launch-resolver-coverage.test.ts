/**
 * GUARD — no spawn site composes a launch AROUND the per-goal launch resolver
 * (goal-mode-hardening-2026-08-10 P-004, D-009).
 *
 * D-004 deleted the GOAL contract's capacity preflight and told the goal agent to
 * parallelize as hard as it can. D-005 made that safe by replacing the agent's
 * judgement with two machine-enforced ceilings. That trade only holds if EVERY
 * door that starts an agent goes through the resolver — a single door that
 * composes its own launch is not a small gap, it is the ceiling silently not
 * existing, and the owner would discover it as a goal quietly running far more
 * agents than they capped it at.
 *
 * Nothing about that is visible when reading a new spawn site: the code looks
 * complete, the launch works, and the ceiling's absence has no symptom until it
 * is breached. So the invariant is asserted mechanically rather than left to
 * review.
 *
 * WHY IT SCANS operator-core ONLY: every psu launch door in the tree lives under
 * packages/operator-core/lib (verified by the census this test performs — see the
 * "finds the known doors" case, which fails if the population collapses). A guard
 * here therefore runs precisely when someone adds one, without depending on the
 * repo-wide guard registry, whose entries silently no-op when the named npm
 * script is absent.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const LIB_ROOT = join(__dirname);

/**
 * Doors that legitimately compose a launch WITHOUT the resolver. Each needs a
 * reason that says why goal ceilings cannot apply — not why wiring it would be
 * inconvenient.
 */
const ALLOWLIST: Record<string, string> = {
  'endpoint-route/routes/adv/launch-su.ts':
    'The GUI "new session" door. Its launcher is a human clicking a button, not an agent, so there is ' +
    'no owner id to resolve goal context FROM — resolveGoalLaunch would return null on every call and ' +
    'the wiring would be ceremony. A GUI launch is not associated with a goal until it inherits one at ' +
    'bootstrap (D-008), and it is bounded by the ceiling from that point on.',
  'behaviour-suite/runner-node.ts':
    'The behaviour-battery harness. It launches throwaway agents to EXERCISE agent behaviour under test ' +
    'fixtures; they do no goal work and must not consume a real goal ceiling. Binding them would also ' +
    'make the suite fail for a reason that has nothing to do with the behaviour being measured.',
  'endpoint-route/routes/agent-mcp/bootstrap-su.ts':
    'The CHILD side, and the opposite direction of travel: reconstructPsuLaunchArgv REBUILDS the argv of a ' +
    'session that has ALREADY booted, so it can be recorded as launch_argv. Nothing spawns. This is also ' +
    'where an inherited goal context is WRITTEN onto the child (D-008) — it consumes goal lineage rather ' +
    'than deciding a launch, so a ceiling check here would be checking a launch that already happened.',
  'desktop-install/papercusp-files.ts':
    'Not a launch at all: it GENERATES the installed `papercup` shell shim, whose text happens to contain ' +
    'a psu exec line. Nothing spawns when this runs. The shim, when a human later runs it, is a GUI-style ' +
    'launch with no launcher agent — the same case as launch-su.ts above.',
  'endpoint-route/routes/desktop/docs-agent-ask.ts':
    'The docs tutor. It opens a short-lived agent to answer a HUMAN question about the documentation, ' +
    'launched from a desktop route with no launcher agent to resolve goal context from. It is not ' +
    'portfolio work and must not be refused because a goal elsewhere is at its ceiling.',
  'p2p/delegated-spawn-honor.ts':
    'The HONORING side of a cross-machine spawn request. The goal, its settings and its ceilings live ' +
    'with the REQUESTER on another host, and are enforced there when its goal agent calls the launch ' +
    'tool. This host holds no goal row and no session_briefs row for that remote owner, so a second ' +
    'check here could only ever resolve null; what it does enforce locally is seat accounting (Gate 4.6).',
  'consult/consult-dispatch.ts':
    'A CONSULT ANSWER, not goal work (D-002/D-012). It forks or converts the routed expert\'s transcript into ' +
    'a session whose whole job is to answer ONE question and end, and the launcher is frequently the expiry ' +
    'sweep — a system identity with no goal context to resolve at all. Charging a goal ceiling would also ' +
    'attribute it wrongly in both directions: the requester\'s goal did not ask for the expert\'s headcount, ' +
    'and the expert\'s goal did not ask the question. Its bound is the consult itself and is tighter than a ' +
    'ceiling: at most one dispatch per cascade step, over a menu the router already capped at max_agents ' +
    '(≤ 8), each attempt walking the allowlist once (consult/consult-dispatch.ts, covered by ' +
    'consult-dispatch.test.ts).',
  'events/await/wake-rehome.ts':
    'Backend re-home resumes the SAME ended session id on another backend after an account wall. ' +
    'It does not create a new goal agent or consume an additional goal slot; applying a new-launch ' +
    'headcount ceiling would strand an existing session that already holds its goal place.',
  'endpoint-route/routes/admin/attention-bulk-resolve.ts':
    'The owner-facing Inbox action creates one short-lived resolver for the concrete items the owner ' +
    'submitted. It creates the resolver owner id only inside this request, before any agent session or ' +
    'goal context exists, and the resolver performs administrative inbox triage rather than goal work. ' +
    'resolveGoalLaunch would therefore derive null and enforce no goal ceiling; wiring it here would add ' +
    'ceremonial coupling to an unrelated goal instead of governing a goal launch.',
  'blueprint/operation-agent-placement.ts':
    'The applied-worker placement for ACCEPTED blueprint operations (WI-10006859, D-017). Its launcher is the ' +
    'routines tick, and the worker is launched with --launched-by system:blueprint-agent-operation-placement, so ' +
    'bootstrap-su inherits no goal context onto it (D-008): the worker joins no goal, no goal headcount ever ' +
    'counts it, and resolveGoalLaunch over that launcher resolves null on every call. A refusal here could not ' +
    'defer the work either, only destroy it: the claim consumes one of the receipt\'s maxAttempts BEFORE the ' +
    'launch (so a crash costs a retry window, never a duplicate worker), and a goal held at its ceiling would ' +
    'retire an accepted operation after maxAttempts refused passes. Its bound is enforced in that same claiming ' +
    'UPDATE under a transaction advisory lock: at most perWorkspaceLive (default 4) live placed workers per ' +
    'workspace, counting ones still booting. The receipt\'s caller_id (operationCallerId: <principal slug>/' +
    '<client id>) can name the session that invoked the operation; attributing placed workers to THAT ' +
    'session\'s goal is a design change to the placement itself (WI-6554700010009834), not a check this door ' +
    'can add.',
};

const COMPOSERS = /\b(buildAgentLaunchCommand|memberLaunchCommand)\s*\(/;
/** A hand-rolled psu argv: the flag every scripted psu launch carries. */
const HAND_BUILT_ARGV = /--no-picker/;
const RESOLVER = /\bresolveGoalLaunch(ForGoal)?\b/;

/**
 * Drop comment lines before detecting.
 *
 * Without this the guard reports four files that only MENTION `--no-picker` in
 * prose (capability/terminal.ts, console-launcher.ts, bootstrap-su.ts,
 * launch-agent.ts all discuss the flag without composing a launch). A guard whose
 * failure list is mostly false positives gets its allowlist padded until the real
 * entries are invisible — which is how an allowlist stops being a record of
 * exceptions and becomes a way to silence the check.
 */
function stripComments(src: string): string {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

/** agent-launch-core DEFINES the composers; it is the floor, not a door. */
const NOT_A_DOOR = new Set(['agent-launch-core.ts']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Every file that composes a psu launch, as repo-lib-relative POSIX paths. */
function spawnSites(): string[] {
  const sites: string[] = [];
  for (const file of walk(LIB_ROOT)) {
    const rel = relative(LIB_ROOT, file).split(sep).join('/');
    if (NOT_A_DOOR.has(rel)) continue;
    const src = stripComments(readFileSync(file, 'utf8'));
    if (COMPOSERS.test(src) || HAND_BUILT_ARGV.test(src)) sites.push(rel);
  }
  return sites.sort();
}

describe('every spawn site goes through the per-goal launch resolver (P-004/D-009)', () => {
  const sites = spawnSites();

  it('finds the known launch doors — a detector that matches nothing passes vacuously', () => {
    // The load-bearing case. Every other assertion below is `for (site of sites)`,
    // so a walker that returns [] or a regex that stops matching would turn this
    // whole guard green while enforcing nothing. Twice in one day this session a
    // check answered the question asked while the truth was the opposite, both
    // times by testing for the ABSENCE of something instead of the presence of a
    // known-good population. So: pin the population.
    expect(sites).toEqual(
      expect.arrayContaining([
        'agent-tools/capability/launch-agent.ts',
        'agent-tools/fleet_registry/launch-on-plan.ts',
        'agent-tools/goals/start.ts',
        'harness/routines/fleet-headcount-action.ts',
      ]),
    );
    expect(sites.length).toBeGreaterThanOrEqual(5);
  });

  it('every spawn site calls the resolver, or is allowlisted with a reason', () => {
    const unwired = sites.filter((rel) => {
      if (rel in ALLOWLIST) return false;
      return !RESOLVER.test(readFileSync(join(LIB_ROOT, rel), 'utf8'));
    });
    expect(
      unwired,
      `These files compose a psu launch without going through resolveGoalLaunch, so a goal's ` +
        `maxAgents/maxPerFleet ceilings do NOT apply to the agents they start. Either call the ` +
        `resolver (see agent-tools/capability/launch-agent.ts for the shape), or add the file to ` +
        `ALLOWLIST in this test with a reason explaining why goal ceilings cannot apply to it.`,
    ).toEqual([]);
  });

  it('has no stale allowlist entries', () => {
    // An allowlisted file that no longer composes a launch means the allowlist is
    // carrying a reason nobody can check any more — and the next reader treats the
    // stale entry as precedent for adding another.
    const stale = Object.keys(ALLOWLIST).filter((rel) => !sites.includes(rel));
    expect(stale, 'allowlisted files that no longer compose a launch — drop them').toEqual([]);
  });

  it('every allowlist reason is substantive, not a placeholder', () => {
    for (const [rel, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.length, `${rel} needs a real reason`).toBeGreaterThan(80);
      expect(reason, `${rel}: "TODO"/"for now" is not a reason`).not.toMatch(/TODO|for now|temporar/i);
    }
  });
});

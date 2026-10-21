/**
 * service-model-drift.test.ts — the MISSING DETECTOR (WI-6153, plan P-014).
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * `pairs/service.ts` scores coverage against a HAND-MAINTAINED MODEL of
 * `dev:service_health` (`PROBED_PORTS`, `UNIT_TO_PROBE`,
 * `SUPERVISED_BUT_UNPROBED`). That duplication is deliberate — see the note on
 * `PROBED_PORTS` — but its safety claim was FALSE AS BUILT:
 *
 *   "if the real endpoint list changes the recomputed verdict must change with
 *    it rather than silently tracking a shared constant. The `expectedVerdict`
 *    latch is what surfaces the divergence."
 *
 * The `expectedVerdict` latch (seed.ts, equivalence.test.ts) compares a verdict
 * RECOMPUTED FROM `cover()` against the pair's recorded `expectedVerdict`. But
 * `cover()` reads the model constants, NOT the real `HEALTH_ENDPOINTS`. So
 * changing the actual tool without touching the model leaves `cover()`
 * unchanged, leaves the recomputed verdict unchanged, and the latch stays GREEN.
 * It catches "model changed but expectedVerdict didn't". It cannot catch "TOOL
 * changed but MODEL didn't" — which is precisely the drift the comment promises
 * to prevent.
 *
 * That is not hypothetical. WI-6146 added `staging-api` (:3170) to
 * `HEALTH_ENDPOINTS`; the model kept saying :3170 was unprobed and both
 * user-facing `advisoryText` strings kept telling agents to shell out to curl
 * for the exact thing that now had a tool form. The whole bash-substitution
 * suite passed throughout.
 *
 * ── What this file asserts ───────────────────────────────────────────────────
 * The model and the real tool agree, in BOTH directions. Widening
 * `dev:service_health` (or narrowing it) now REDS here until the model is
 * updated — which is what makes the recorded verdicts trustworthy, and what the
 * header comment already promised.
 *
 * This deliberately does NOT collapse the duplication into a shared constant.
 * The model must stay independently readable — an audit that imports its subject
 * proves nothing about it. The guard is the seam: two independent statements,
 * mechanically forced to agree.
 */
import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import { HEALTH_ENDPOINTS, SUPERVISED_PROCESSES, NON_PROBED_UNITS, DOWN_CONFIRM_TICKS } from '../../service-health';
import {
  PROBED_PORTS,
  UNIT_TO_PROBE,
  SUPERVISED_BUT_UNPROBED,
  SUPERVISION_ROW_NAME,
  EXCLUSION_REASON,
  curlHealthProbe,
  listeningPorts,
  systemctlScope,
} from './service';
import devListeningPorts from '../../agent-tools/dev/listening_ports';
import devServiceHealth from '../../agent-tools/dev/service_health';
import { LISTENING_SOCKETS_DEFAULT_LIMIT, SS_ARGV } from '../../listening-sockets';
import { expectArgSurface, expectExpressionUsesRealArgs } from './model-drift-helpers';

/**
 * Probes that are real but do NOT come from `HEALTH_ENDPOINTS`, with the reason.
 * Anything here is exempt from the both-directions check below; keep it short
 * and justified, because every entry is a hole in the guard.
 */
const NON_ENDPOINT_PROBES: Record<string, string> = {
  // Opt-in, probed by probeEmbedSidecar() rather than a HEALTH_ENDPOINTS row.
  'embed-sidecar': 'probed by probeEmbedSidecar(), not a HEALTH_ENDPOINTS entry',
  // Portless probes — no URL, so they can never appear in PROBED_PORTS.
  'bg-host-ticker': 'portless probe',
  'bg-host-code': 'portless probe',
  desktop: 'portless probe',
  'substrate-sidecar': 'portless probe',
};

/** The loopback port a HEALTH_ENDPOINTS url targets, if it has one. */
function endpointPort(url: string): string | null {
  const m = /https?:\/\/(?:127\.0\.0\.1|localhost)(?::(\d+))?/.exec(url);
  if (!m) return null;
  return m[1] ?? '80';
}

describe('service.ts equivalence model tracks the real dev:service_health (WI-6153)', () => {
  it('every HTTP-probed HEALTH_ENDPOINTS port appears in PROBED_PORTS under its real name', () => {
    const missing: string[] = [];
    for (const spec of HEALTH_ENDPOINTS) {
      const port = endpointPort(spec.url);
      if (port == null) continue;
      const modelled = PROBED_PORTS[port];
      if (modelled !== spec.name) {
        missing.push(
          `:${port} is probed as '${spec.name}' by HEALTH_ENDPOINTS but PROBED_PORTS says ${
            modelled === undefined ? 'NOTHING probes it' : `'${modelled}'`
          }`,
        );
      }
    }
    expect(
      missing,
      `pairs/service.ts's model has drifted from the real tool. dev:service_health was widened (or renamed) ` +
        `without updating PROBED_PORTS, so the equivalence audit is scoring against a tool that no longer exists ` +
        `and the advisoryText may be telling agents to shell out for something now covered:\n  - ${missing.join(
          '\n  - ',
        )}\nUpdate PROBED_PORTS, re-read the recomputed verdict, and fix advisoryText/routing to match.`,
    ).toEqual([]);
  });

  it('PROBED_PORTS claims nothing the real tool does not probe', () => {
    const realByPort = new Map<string, string>();
    for (const spec of HEALTH_ENDPOINTS) {
      const port = endpointPort(spec.url);
      if (port != null) realByPort.set(port, spec.name);
    }
    const overclaimed = Object.entries(PROBED_PORTS)
      .filter(([port, name]) => realByPort.get(port) !== name && !(name in NON_ENDPOINT_PROBES))
      .map(([port, name]) => `PROBED_PORTS says :${port} → '${name}', but HEALTH_ENDPOINTS does not`);
    expect(
      overclaimed,
      `The model claims coverage the tool does not have — this scores the audit OPTIMISTICALLY and can flip a ` +
        `pair to 'equivalent' on the strength of a probe that was removed:\n  - ${overclaimed.join('\n  - ')}`,
    ).toEqual([]);
  });

  it('UNIT_TO_PROBE maps only to probe names the tool can actually emit', () => {
    const realNames = new Set<string>([
      ...HEALTH_ENDPOINTS.map((s) => s.name),
      ...Object.keys(NON_ENDPOINT_PROBES),
    ]);
    const bogus = Object.entries(UNIT_TO_PROBE)
      .filter(([, probe]) => !realNames.has(probe))
      .map(([unit, probe]) => `${unit} → '${probe}', which is not a probe dev:service_health emits`);
    expect(
      bogus,
      `UNIT_TO_PROBE promises a services[] entry that does not exist, so cover() reports a faithful expression ` +
        `an agent cannot actually evaluate:\n  - ${bogus.join('\n  - ')}`,
    ).toEqual([]);
  });

  it('SUPERVISED_BUT_UNPROBED and UNIT_TO_PROBE are disjoint — a unit cannot be both', () => {
    const both = [...SUPERVISED_BUT_UNPROBED].filter((unit) => unit in UNIT_TO_PROBE);
    expect(
      both,
      `These units are listed as UNPROBED while also having a probe. cover() checks UNIT_TO_PROBE first, so the ` +
        `stale SUPERVISED_BUT_UNPROBED entry is dead — but its REASON STRING is what an agent reads, and it now ` +
        `lies:\n  - ${both.join('\n  - ')}`,
    ).toEqual([]);
  });

  it('every SUPERVISED_BUT_UNPROBED unit is really a systemd row in SUPERVISED_PROCESSES', () => {
    // Guards the other drift direction: a unit renamed/removed from supervision
    // leaves the model asserting things about a unit that no longer exists.
    //
    // Scoped to SUPERVISED_BUT_UNPROBED ON PURPOSE. That set's entire claim is
    // "this is IN the supervision registry yet nothing probes it", so every
    // member must be a real systemd row or the claim is meaningless.
    //
    // UNIT_TO_PROBE is deliberately NOT checked this way: it maps a systemd unit
    // an agent might run `is-active` on to the probe that answers it, and such a
    // unit need not be a systemd-layer registry row at all. `papercup-embed-sidecar`
    // is the live example — `embed-sidecar` IS in SUPERVISED_PROCESSES but as a
    // `node-child` with NO `unit` field, so the registry knows the process and not
    // the unit name. Asserting registry membership there conflates "supervised
    // process" with "systemd unit" and reds on a correct model (it did, first run).
    const supervisedUnits = new Set(
      SUPERVISED_PROCESSES.map((p) => p.unit).filter((u): u is string => Boolean(u)),
    );
    const unknown = [...SUPERVISED_BUT_UNPROBED].filter((unit) => !supervisedUnits.has(unit));
    expect(
      unknown,
      `These units are listed as "supervised but unprobed" yet are not systemd rows in SUPERVISED_PROCESSES — ` +
        `either they were renamed/removed, or the model invented them. Either way cover() is emitting a reason ` +
        `string about a unit that does not exist:\n  - ${unknown.join('\n  - ')}`,
    ).toEqual([]);
  });

  /**
   * ── dev:listening_ports ↔ the re-derived listeningPorts pair (WI-6149) ─────
   *
   * This pair is the reason D-016 exists. It spent its whole life recording
   * `not-a-substitute` and an advisory that read "there is no tool form for
   * ss/lsof/netstat today; keep using them" — and the moment D-017 shipped
   * `dev:listening_ports`, that sentence became a lie that nothing would have
   * caught. The `expectedVerdict` latch cannot catch it: `cover()` does not
   * import the tool, so building a tool changes no recomputed verdict.
   *
   * These guards close that loop for the NEXT widening, in both directions.
   */
  it('the listeningPorts pair points at a tool that actually exists', () => {
    expect(
      listeningPorts.toolName,
      `The pair routes agents to '${listeningPorts.toolName}', but the imported tool is named ` +
        `'${devListeningPorts.name}'. A renamed verb leaves every advisory naming a tool that cannot be called.`,
    ).toBe(devListeningPorts.name);
  });

  it('dev:listening_ports still takes exactly { port, pid, limit } — the surface cover() maps onto', () => {
    expectArgSurface(
      devListeningPorts,
      'dev:listening_ports',
      ['app', 'limit', 'pid', 'port'],
      'cover() maps port-scoped queries onto `port`, the reverse (which ports does this pid hold) onto `pid`, ' +
        'and unscoped table reads onto the default `limit`. A NEW arg is the dangerous direction here: the pair ' +
        'is recorded `needs-widening` SOLELY because 9 of 24 sampled atoms ask about non-LISTEN sockets. Adding ' +
        'a `state`/`established`/`udp` arg would make most of those expressible and the recorded verdict would ' +
        'be stale-pessimistic — advising agents to keep shelling out for something the tool had just learned to ' +
        'do. Re-run the coverage measurement and re-record expectedVerdict before widening the expected list.',
    );
  });

  it('cover() emits expressions built only from real dev:listening_ports args', () => {
    expectExpressionUsesRealArgs(listeningPorts, 'lsof -nP -iTCP:3070 -sTCP:LISTEN', devListeningPorts, ['port']);
  });

  it('the LISTEN-only limitation the verdict rests on is still real', () => {
    // The ENTIRE `needs-widening` residue is the state axis. If the tool ever
    // reports non-LISTEN sockets, every one of those 9 misses becomes coverable
    // and this pair must be re-derived. Nothing else in the suite would notice,
    // because cover() reaches its refusals without consulting the tool at all.
    //
    // Asserted against the real `ss` ARGV rather than the guidance prose: a
    // prose check passes for a tool whose behaviour has completely changed, so
    // it is a detector in name only. `-l` is the actual mechanism.
    const flagCluster = SS_ARGV.filter((a) => a.startsWith('-')).join('');
    expect(
      flagCluster.includes('l'),
      `listening-sockets.ts no longer passes -l to ss (argv is now ${JSON.stringify(SS_ARGV)}), so it returns ` +
        `sockets in states other than LISTEN. The listeningPorts pair refuses 9 of its 24 sampled atoms with the ` +
        `reason "reports LISTEN sockets only" — those refusals are now WRONG, and the needs-widening verdict that ` +
        `rests entirely on them must be re-derived (expect it to move toward equivalent).`,
    ).toBe(true);
    // -t likewise: the pair refuses UDP atoms on the same basis.
    expect(flagCluster.includes('t'), `ss argv lost -t, so the TCP-only refusals are stale too.`).toBe(true);
  });

  it('advisoryText names the real tool and does not resurrect the "no tool form" claim', () => {
    expect(listeningPorts.advisoryText).toContain('dev:listening_ports');
    expect(
      /no tool form/i.test(listeningPorts.advisoryText),
      `listeningPorts.advisoryText has regained the pre-D-017 "no tool form" claim, which is false now that ` +
        `dev:listening_ports exists: ${listeningPorts.advisoryText}`,
    ).toBe(false);
    // The honest-null contract is the single most misreadable thing about this
    // tool (a bound-but-unreadable socket vs a free port), so the advisory must
    // keep carrying it — it is what an agent reads at tier `advise`.
    expect(listeningPorts.advisoryText).toContain('ownerVisible');
  });

  it('the default row cap the tool documents is a real exported constant', () => {
    expect(
      typeof LISTENING_SOCKETS_DEFAULT_LIMIT,
      'listening-sockets.ts no longer exports a numeric default row cap, which dev:listening_ports quotes in its ' +
        '`limit` arg description. A description quoting a number that no longer exists is the file-read ' +
        'advisoryText drift in a different costume.',
    ).toBe('number');
  });

  /**
   * ── WI-6149 (D-010 item 4): the unit-COVERAGE model ────────────────────────
   *
   * Item 4's deliverable is a set of per-unit DECISIONS (one addition, four
   * documented exclusions). A decision recorded only in prose rots exactly like
   * the `listeningPorts` advisory did, so each decision gets a detector.
   */
  it('SUPERVISION_ROW_NAME resolves every unprobed unit to a REAL supervision row name', () => {
    // cover() emits `supervision.find(s => s.name === '<row>')` for these. If the
    // row name is wrong the expression is unevaluatable — a wrong expression on a
    // correct `covered`, which is the failure mode item 3 named as the quieter
    // half of D-001 and which no verdict latch can see.
    const realNames = new Set(SUPERVISED_PROCESSES.map((p) => p.name));
    const problems: string[] = [];
    for (const unit of SUPERVISED_BUT_UNPROBED) {
      const row = SUPERVISION_ROW_NAME[unit];
      if (row === undefined) {
        problems.push(`${unit} has no SUPERVISION_ROW_NAME entry, so cover() would emit the UNIT name as a supervision[].name`);
      } else if (!realNames.has(row)) {
        problems.push(`${unit} → '${row}', which is not a name in SUPERVISED_PROCESSES`);
      }
    }
    expect(problems, `WI-6149 supervision-row mapping has drifted:\n  - ${problems.join('\n  - ')}`).toEqual([]);
  });

  it('the model’s EXCLUSION_REASON set agrees with the tool’s NON_PROBED_UNITS', () => {
    // The exclusion RATIONALE is duplicated (model vs tool) for the same reason
    // PROBED_PORTS is. This is the bridge that makes the duplication safe: if
    // someone probes a previously-excluded unit and updates only one side, the
    // other side keeps telling agents to shell out for something now covered —
    // the exact WI-6146 staleness shape.
    const modelled = Object.keys(EXCLUSION_REASON).sort();
    const real = Object.keys(NON_PROBED_UNITS).sort();
    expect(
      modelled,
      `pairs/service.ts EXCLUSION_REASON and service-health.ts NON_PROBED_UNITS disagree about which units are ` +
        `deliberately excluded. Whichever side is stale is emitting a reason string that no longer matches the ` +
        `registry.\n  model: ${modelled.join(', ')}\n  tool:  ${real.join(', ')}`,
    ).toEqual(real);
  });

  it('every deliberately-excluded unit really is absent from the probe list AND the registry', () => {
    // The exclusion has to be HONOURED, not merely documented: an entry in both
    // NON_PROBED_UNITS and the registry would mean the file argues against itself,
    // and cover() would report "keep using systemctl" for a unit it now covers.
    const probedNames = new Set(HEALTH_ENDPOINTS.map((s) => s.name));
    const registryUnits = new Set(SUPERVISED_PROCESSES.map((p) => p.unit).filter((u): u is string => Boolean(u)));
    const contradictions = Object.keys(NON_PROBED_UNITS).filter(
      (unit) => probedNames.has(unit) || registryUnits.has(unit) || registryUnits.has(`${unit}.service`),
    );
    expect(
      contradictions,
      `These units are documented as deliberately NOT probed while also being probed/registered:\n  - ${contradictions.join('\n  - ')}`,
    ).toEqual([]);
  });

  it('oddsmith-sidecar is modelled as PROBED and its probe is flap-damped (the WI-6149 addition)', () => {
    // The named, non-generic assertion for item 4's one ADDITION — mirroring the
    // staging-api assertion below, and for the same reason.
    expect(PROBED_PORTS['46229']).toBe('oddsmith-sidecar');
    expect(UNIT_TO_PROBE['papercup-oddsmith-sidecar']).toBe('oddsmith-sidecar');
    expect(HEALTH_ENDPOINTS.some((s) => s.name === 'oddsmith-sidecar')).toBe(true);
    // Damping is not cosmetic here: the unit restarts ~22×/day (measured), so an
    // undamped probe manufactures phantom DOWNs. Removing the DOWN_CONFIRM_TICKS
    // entry must red.
    expect(
      DOWN_CONFIRM_TICKS['oddsmith-sidecar'],
      'oddsmith-sidecar lost its flap damping. It restarts ~22×/day (agents’ raw `systemctl --user restart` + ' +
        'Restart=always), so an undamped probe re-introduces the phantom-DOWN broadcasts WI-6146 removed.',
    ).toBeGreaterThanOrEqual(2);
  });

  it('staging-api specifically is modelled as PROBED (the WI-6146 regression this file was written for)', () => {
    // A named, non-generic assertion so the specific regression that motivated
    // this file can never silently return, even if the generic checks above are
    // later loosened or exempted.
    expect(PROBED_PORTS['3170']).toBe('staging-api');
    expect(UNIT_TO_PROBE['papercup-staging-api']).toBe('staging-api');
    expect(SUPERVISED_BUT_UNPROBED.has('papercup-staging-api')).toBe(false);
    expect(HEALTH_ENDPOINTS.some((s) => s.name === 'staging-api')).toBe(true);
  });
});

/**
 * P-014 (WI-6244) — the model of the WIDENED tool.
 *
 * `systemctlIsActive.cover()` now emits `dev:service_health { units, scope }`
 * expressions, which is a claim about the tool's ARGUMENT SURFACE, not just its
 * probe list. The same drift hole this file exists to close applies: narrowing
 * the tool back (dropping `units`, or collapsing `scope` to a boolean) would
 * leave `cover()` unchanged, the verdict unchanged, and the whole suite green
 * while every emitted expression became uncallable.
 */
describe('P-014: the unit-state widening (arg-surface drift)', () => {
  it('dev:service_health really accepts the `units` + `scope` args cover() emits', () => {
    expectArgSurface(
      devServiceHealth,
      'dev:service_health',
      // `unitsOnly` (optional) only skips the unrelated fixed-endpoint snapshot; the unitStates/unitsUnknown a
      // cover() expression reads are identical with or without it, so coverage is unchanged.
      ['units', 'scope', 'unitsOnly'],
      'systemctlIsActive.cover() emits `dev:service_health { units: [...], scope: ... }` for every unit outside the ' +
        'probe registry — which is 50 of the 114 corpus atoms. Removing either arg makes those expressions uncallable ' +
        'while the recorded `equivalent` verdict still claims they work.',
    );
  });

  /**
   * ⚠ THREE-VALUED ON PURPOSE — do not "simplify" this to a boolean.
   *
   * The identical mistake was made and caught in `logs:read` (P-023): `--user`
   * and `--system` are separate managers, so a boolean forces a caller asking
   * about a system unit to query a manager that CANNOT hold the answer and get
   * a confident wrong result. Measured here too: every flagless `systemctl
   * is-active` atom in the corpus names a genuine system unit (auditd, ufw,
   * fail2ban, crowdsec), and a bare `systemctl` defaults to `--system`.
   */
  it('scope stays three-valued (user | system | all), and flagless atoms map to system', () => {
    // Asserted through the schema's BEHAVIOUR rather than its internals: what
    // matters is that all three values parse and a boolean does not.
    const args = (devServiceHealth as { args: z.ZodType }).args;
    for (const scope of ['user', 'system', 'all']) {
      expect(args.safeParse({ units: ['x'], scope }).success, `scope:'${scope}' must be accepted`).toBe(true);
    }
    expect(
      args.safeParse({ units: ['x'], scope: true }).success,
      'scope must NOT accept a boolean — that is the exact collapse this guard exists to prevent',
    ).toBe(false);
    expect(args.safeParse({ units: ['x'], scope: 'both' }).success).toBe(false);
    // The corpus rule, asserted directly: no flag ⇒ systemctl talks to --system.
    expect(systemctlScope('systemctl is-active auditd 2>&1')).toBe('system');
    expect(systemctlScope('systemctl --system is-active pgbouncer')).toBe('system');
    expect(systemctlScope('systemctl --user is-active papercup-dev-api.service')).toBe('user');
  });

  /**
   * The curl pattern is DERIVED from `PROBED_PORTS`, so a hand-written second
   * copy can never drift from it. Asserted from both ends: every modelled port
   * appears in the live pattern, and no unmodelled port does.
   */
  it('the curl pattern is derived from PROBED_PORTS, not a hand-written copy', () => {
    for (const port of Object.keys(PROBED_PORTS)) {
      expect(curlHealthProbe.bashPattern.source, `:${port} is probed but absent from the pattern`).toContain(port);
    }
    // A port nobody probes must NOT be claimed — :8788 is the live example
    // (deliberately unprobed: its /health requires an auth header).
    expect(curlHealthProbe.bashPattern.test('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8788/health')).toBe(
      false,
    );
  });

  /**
   * The narrowings must stay narrow. Both pairs reached `equivalent` by CLAIMING
   * LESS, so a loosened pattern silently re-introduces the exact wrong answers
   * (a connection census answered with the bind table; a body read answered with
   * a diagnostic snapshot) while the recorded verdict still says `equivalent`.
   */
  it('the P-014 narrowings hold: no all-states socket query, no body-reading curl', () => {
    expect(listeningPorts.bashPattern.test('ss -tnp 2>/dev/null')).toBe(false);
    expect(listeningPorts.bashPattern.test('ss -lunp 2>/dev/null')).toBe(false);
    expect(listeningPorts.bashPattern.test('lsof -nP -iTCP:8044 2>&1')).toBe(false);
    expect(curlHealthProbe.bashPattern.test('curl -s http://127.0.0.1:3070/api/health')).toBe(false);
    // …while the shapes they DO claim still match.
    expect(listeningPorts.bashPattern.test('ss -ltnp 2>/dev/null')).toBe(true);
    expect(
      curlHealthProbe.bashPattern.test('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3070/api/health'),
    ).toBe(true);
  });
});

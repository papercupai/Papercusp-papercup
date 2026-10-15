/**
 * EI-19313376980892266 item C — the RECURRENCE GUARD for "every alert carries its
 * falsifier".
 *
 * Modelled on the cell falsifier-reality suite (replaced at P-004 by
 * `cell-assessment-reality.test.ts`), which existed because a falsifier
 * whose `field` names a path no resolver produces is WORSE than no falsifier: it
 * wears the contract's badge while being unrunnable. The same failure is available
 * here in three flavours, and every one of them looks fine in review:
 *
 *   1. a falsifier naming a tool that does not exist (or was renamed);
 *   2. a falsifier whose "check" MUTATES — the trap that motivated the whole family,
 *      since the obvious way to ask "would the scheduler admit this member" is
 *      `scheduler:get_next`, which has no dry-run and atomically CLAIMS;
 *   3. a NEW alert added to the family with a `reason` and no falsifier at all,
 *      quietly returning the surface to prose-that-gets-believed.
 *
 * (3) is the one a fixture-only test cannot catch, so this file also censuses the
 * SOURCE — an alert that ships a reason without a falsifier reds the build.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import {
  computeDarkFleetAlert,
  computeStrandedFleetAlert,
  computeSpecStarvedFleetAlert,
  computeSpecAuthorshipAlert,
  computeDeclaredPlanSpecDivergenceAlert,
  computeIdleWithClaimableAlert,
  computeFloorStarvedFleetAlert,
  buildFleetUnderStaffedBriefAlert,
  renderFalsifierCall,
  FALSIFIER_FORBIDDEN_TOOLS,
  type AlertFalsifier,
} from './leader-brief';
import type { FleetHeadcountState } from '../../agent-fleets-store';
import { buildFullToolNameCatalog } from '../../static-tool-catalog';

const __dirname_ = dirname(new URL(import.meta.url).pathname);
const REPO = join(__dirname_, '../../../../../');
const SOURCE = join(__dirname_, 'leader-brief.ts');

const DARK_FLEET_FIRING = computeDarkFleetAlert({
  fleet: 'my-fleet',
  presenceDegraded: false,
  roster: [
    { lastActiveSecAgo: null },
    { lastActiveSecAgo: 31 * 60 },
    { lastActiveSecAgo: 45 * 60 },
  ],
});

/** Each alert under a MINIMAL input that makes it fire. */
const FIRING: { name: string; fired: { reason: string; falsifier: AlertFalsifier } | undefined }[] = [
  {
    name: 'darkFleet',
    fired: DARK_FLEET_FIRING.alert === true ? DARK_FLEET_FIRING : undefined,
  },
  {
    name: 'strandedFleet',
    fired: computeStrandedFleetAlert({
      totalLoad: 0,
      parkedCount: 2,
      unownedCriticalCount: 3,
      harness: 'papercusp',
      fleet: 'my-fleet',
    }),
  },
  {
    name: 'specStarved',
    fired: computeSpecStarvedFleetAlert({
      totalLoad: 0,
      specMatched: 0,
      poolSize: 40,
      harness: 'papercusp',
      fleet: 'my-fleet',
    }),
  },
  {
    // P-005: the only alert in the family that is not about SUPPLY — it fires on the spec
    // row's AUTHORSHIP, so its falsifier has to reach a different table than the one it
    // read, which is exactly what this fixture set exists to police.
    name: 'specAuthorship',
    fired: computeSpecAuthorshipAlert({
      readerId: 'su-b8422496',
      updatedBy: 's-1786236383559',
      revision: 4,
      updatedAt: '2026-08-09T01:12:00.000Z',
      harness: 'papercusp',
      fleet: 'my-fleet',
    }),
  },
  {
    name: 'declaredPlanSpecDivergence',
    fired: computeDeclaredPlanSpecDivergenceAlert({
      members: [
        { agentId: 'su-divergent', alive: true, declaredPlanSlug: 'other-plan' },
      ],
      specFilter: { field: 'plan', op: '=', value: 'intended-plan' },
      harness: 'papercusp',
      fleet: 'my-fleet',
    }),
  },
  {
    name: 'idleWithClaimable',
    fired: computeIdleWithClaimableAlert({
      claimableCount: 12,
      idleMemberCount: 2,
      harness: 'papercusp',
      idleMemberIds: ['su-abc123', 'su-def456'],
    }),
  },
  {
    name: 'floorStarved',
    fired: computeFloorStarvedFleetAlert({
      claimable: 0,
      matchedByFilter: 108,
      idleMemberCount: 5,
      excluded: { taken: 8, claimHold: 38 },
      harness: 'papercusp',
      fleet: 'my-fleet',
    }),
  },
  {
    // WI-37161: the pool-congested variant of idleWithClaimable — a DIFFERENT falsifier
    // (fleet:capacity, not work_items:list) than the sibling fixture above, so it needs its
    // own row rather than relying on the un-parameterized one to cover it.
    name: 'idleWithClaimablePoolCongested',
    fired: computeIdleWithClaimableAlert({
      claimableCount: 12,
      idleMemberCount: 2,
      harness: 'papercusp',
      idleMemberIds: ['su-abc123', 'su-def456'],
      poolCapacity: { poolExhausted: false, degraded: true, factor: 0, queueDepth: 28, usableAccounts: 1, availableAccounts: 2 },
    }),
  },
  {
    // P-005 / D-030: the UNDER-staff alert. Its detector lives in lib/fleet, outside
    // the SOURCE census below, so this row is what holds it to the falsifier contract.
    // A fired alert missing its reason or falsifier maps to undefined and reds "FIRES".
    name: 'fleetUnderStaffed',
    fired: (() => {
      const r = buildFleetUnderStaffedBriefAlert({
        fleet: 'my-fleet',
        controlState: 'active',
        headcount: {
          enabled: true,
          target: 3,
          current: 0,
          shortfall: 3,
          underStrength: true,
          verdict: 'under-strength',
          held: false,
          notHeldBecause: 'supervise-not-granted',
          topUpRule: { status: 'none', kind: null, inherited: null, ratifiedBy: null, reason: null, until: null },
          basis: {
            kind: 'agent-origin-execution-attested',
            liveRosterMembers: 0,
            executingMembers: 0,
            transactionWorkerReadyMembers: null,
          },
          countEvidence: { productive: null, liveRoster: null, transactionWorkerReady: null, note: '' },
        } satisfies FleetHeadcountState,
      });
      return r?.alert && r.reason && r.falsifier ? { reason: r.reason, falsifier: r.falsifier } : undefined;
    })(),
  },
];

describe('alert falsifier reality (EI-19313376980892266 item C)', () => {
  it('every alert in the family FIRES under its documented trigger', () => {
    // Guards the fixtures themselves: an input that stopped triggering would make
    // every assertion below vacuously pass on `undefined`.
    for (const { name, fired } of FIRING) {
      expect(fired, `${name} did not fire under its trigger input`).toBeDefined();
    }
  });

  it('every fired alert ships a falsifier with all four fields populated', () => {
    for (const { name, fired } of FIRING) {
      const f = fired!.falsifier;
      expect(f, `${name} has no falsifier`).toBeDefined();
      for (const key of ['tool', 'check', 'measurement', 'kills'] as const) {
        expect(typeof f[key], `${name}.falsifier.${key} must be a string`).toBe('string');
        expect(f[key].length, `${name}.falsifier.${key} must not be empty`).toBeGreaterThan(0);
      }
    }
  });

  it('every falsifier names a tool that ACTUALLY EXISTS', () => {
    // The cell-falsifier failure with the serial numbers filed off: a check citing a
    // renamed tool reads as verifiable and cannot be run.
    const catalog = buildFullToolNameCatalog(REPO);
    expect(catalog.size, 'tool catalog scan returned nothing — the test is not measuring').
      toBeGreaterThan(50);
    for (const { name, fired } of FIRING) {
      expect(catalog.has(fired!.falsifier.tool), `${name} cites unknown tool ${fired!.falsifier.tool}`).
        toBe(true);
    }
  });

  it('no falsifier calls a MUTATING tool — a check that changes state is not a check', () => {
    // The concrete trap: `scheduler:get_next` is the intuitive way to ask "would this
    // member be admitted" and it CLAIMS the item. A leader verifying an idle-member
    // alert that way takes the work themselves — exactly how this item's author
    // accumulated 5 claims against a cap of 1 while diagnosing the fleet as idle.
    for (const { name, fired } of FIRING) {
      expect(
        FALSIFIER_FORBIDDEN_TOOLS,
        `${name} falsifier calls the mutating tool ${fired!.falsifier.tool}`,
      ).not.toContain(fired!.falsifier.tool);
    }
  });

  it('every check is a runnable one-liner naming its own tool', () => {
    for (const { name, fired } of FIRING) {
      const { tool, check } = fired!.falsifier;
      expect(check.startsWith(tool), `${name} check does not begin with its tool: ${check}`).toBe(true);
      expect(check, `${name} check has no argument block`).toContain('{');
      // A rendered arg must never leak a JS-side null/undefined into a pasted call.
      expect(check, `${name} check leaked a null arg`).not.toContain('null');
      expect(check, `${name} check leaked an undefined arg`).not.toContain('undefined');
    }
  });

  it('the idle-with-claimable falsifier names a REAL accused member, not a placeholder', () => {
    // The alert accuses specific members; a falsifier that cannot name one sends the
    // leader back to guessing, which is where the original incident started.
    const f = FIRING.find((x) => x.name === 'idleWithClaimable')!.fired!.falsifier;
    expect(f.check).toContain('su-abc123');
  });

  it('a falsifier degrades to a still-runnable call when fleet/harness are unresolved', () => {
    // Fail-soft, matching every other best-effort read in the brief: an unresolved
    // context must not produce `harness: null` in a call a leader pastes.
    const fired = computeStrandedFleetAlert({
      totalLoad: 0,
      parkedCount: 1,
      unownedCriticalCount: 1,
      harness: null,
      fleet: null,
    });
    expect(fired!.falsifier.check).not.toContain('null');
    expect(fired!.falsifier.check).toContain('work_items:claimable');
  });

  it('renderFalsifierCall quotes strings, leaves scalars bare, and drops empties', () => {
    expect(renderFalsifierCall('a:b', { s: 'x', n: 3, t: true, skip: null, gone: undefined })).toBe(
      "a:b { s: 'x', n: 3, t: true }",
    );
    expect(renderFalsifierCall('a:b', {})).toBe('a:b {}');
  });

  it('CENSUS: no alert in the family ships a reason WITHOUT a falsifier', () => {
    // The ratchet. A future alert added with `{ reason: ... }` and no falsifier is
    // exactly the regression this item exists to prevent, and no fixture-based test
    // can see it because the fixture would never be written.
    const violations = auditAlertReturnTypes(readFileSync(SOURCE, 'utf8'));
    expect(violations.scanned, 'found no reason-bearing alert return types — the census has rotted').
      toBe(9);
    expect(violations.functions, 'the AST function census must cover every compute*Alert declaration').
      toHaveLength(11);
    expect(violations.boolean.sort()).toEqual(['computeDormantAlert', 'computeSpinningAlert']);
    expect(violations.named.sort()).toEqual([
      'computeDarkFleetAlert',
      'computeFleetExecutionCollapseAlert',
      'computeFleetHeadcountVsExecutableFrontierAlert',
    ]);
    expect(violations.inline).toHaveLength(6);
    expect(
      violations.unclassified,
      'every non-boolean alert return must be inline or locally resolvable named output',
    ).toEqual([]);
    expect(
      violations.bare,
      'an alert returns a bare { reason } with no falsifier — every alert must ship the ' +
        'query that would disprove it (EI-19313376980892266 item C)',
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL: the census actually CATCHES a bare-reason alert', () => {
    // Without this, a census that silently matched NOTHING would pass forever and the
    // ratchet would be decorative. Proven against a synthetic source rather than by
    // mutating leader-brief.ts, because git-sync sweeps this shared tree every few
    // minutes and would commit the broken intermediate.
    const good = 'export function computeXAlert(input: {\n  a: number;\n}): { reason: string; falsifier: AlertFalsifier } | undefined {';
    const bad = 'export function computeYAlert(input: {\n  a: number;\n}): { reason: string } | undefined {';

    expect(auditAlertReturnTypes(good).bare).toEqual([]);
    const caught = auditAlertReturnTypes(bad);
    expect(caught.scanned).toBe(1);
    expect(caught.bare).toHaveLength(1);
    expect(caught.bare[0]).toContain('reason: string');

    // And it must see BOTH in a mixed source — a single compliant sibling must never
    // mask a bare one.
    const mixed = auditAlertReturnTypes(`${good}\n${bad}`);
    expect(mixed.scanned).toBe(2);
    expect(mixed.bare).toHaveLength(1);
  });

  it('NEGATIVE CONTROL: resolves named aliases and catches a bare alerting branch', () => {
    // A regex can only see the inline sibling. These controls prove that a named
    // return type is resolved locally, while a true alert branch that drops the
    // falsifier still reaches the same ratchet.
    const good = [
      'type GoodAlert =',
      '  | { alert: true; reason: string; falsifier: AlertFalsifier }',
      '  | { alert: false; reason?: undefined; falsifier?: undefined };',
      'export function computeGoodAlert(): GoodAlert | undefined { return undefined; }',
    ].join('\n');
    const bad = [
      'type BadAlert =',
      '  | { alert: true; reason: string }',
      '  | { alert: null; reason: string; falsifier?: undefined };',
      'export function computeBadAlert(): BadAlert | undefined { return undefined; }',
    ].join('\n');

    const goodAudit = auditAlertReturnTypes(good);
    expect(goodAudit.functions).toEqual(['computeGoodAlert']);
    expect(goodAudit.named).toEqual(['computeGoodAlert']);
    expect(goodAudit.scanned).toBe(1);
    expect(goodAudit.bare).toEqual([]);
    expect(goodAudit.unclassified).toEqual([]);

    const badAudit = auditAlertReturnTypes(bad);
    expect(badAudit.functions).toEqual(['computeBadAlert']);
    expect(badAudit.named).toEqual(['computeBadAlert']);
    expect(badAudit.scanned).toBe(1);
    expect(badAudit.bare).toHaveLength(1);
    expect(badAudit.bare[0]).toContain('computeBadAlert');
    expect(badAudit.bare[0]).toContain('BadAlert');
    // `alert: null` is an intentional unknown/non-alert branch; only the
    // alerting `alert: true` branch requires a falsifier.
  });
});

/**
 * AST-backed census over leader-brief source. Every `compute*Alert` declaration is
 * enumerated first, then its return type is resolved through local aliases/interfaces.
 * Reason-bearing alert branches must declare a `falsifier`; boolean helpers are
 * explicitly out of this contract, and unresolved/non-reason return shapes remain
 * visible as `unclassified` rather than silently shrinking the scan.
 */
interface AlertReturnVariant {
  properties: Map<string, ts.TypeNode | undefined>;
}

interface ResolvedAlertReturn {
  variants: AlertReturnVariant[];
  unknown: boolean;
  booleanOnly: boolean;
}

export interface AlertReturnAudit {
  scanned: number;
  bare: string[];
  functions: string[];
  boolean: string[];
  inline: string[];
  named: string[];
  unclassified: string[];
}

type LocalTypeDeclaration = ts.TypeAliasDeclaration | ts.InterfaceDeclaration;

function unwrapParenthesizedType(node: ts.TypeNode): ts.TypeNode {
  let current = node;
  while (ts.isParenthesizedTypeNode(current)) current = current.type;
  return current;
}

function entityNameText(node: ts.EntityName): string {
  return ts.isIdentifier(node) ? node.text : `${entityNameText(node.left)}.${node.right.text}`;
}

function propertyNameText(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function objectVariant(members: readonly ts.TypeElement[]): AlertReturnVariant {
  const properties = new Map<string, ts.TypeNode | undefined>();
  for (const member of members) {
    if (!ts.isPropertySignature(member)) continue;
    const name = propertyNameText(member.name);
    if (name) properties.set(name, member.type);
  }
  return { properties };
}

function mergeVariants(left: AlertReturnVariant[], right: AlertReturnVariant[]): AlertReturnVariant[] {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  return left.flatMap((a) =>
    right.map((b) => ({
      properties: new Map([...a.properties, ...b.properties]),
    })),
  );
}

function resolveInterface(
  declaration: ts.InterfaceDeclaration,
  declarations: Map<string, LocalTypeDeclaration>,
  seen: Set<string>,
): ResolvedAlertReturn {
  let variants = [objectVariant(declaration.members)];
  let unknown = false;
  for (const heritage of declaration.heritageClauses ?? []) {
    for (const type of heritage.types) {
      const name = ts.isExpressionWithTypeArguments(type) && ts.isEntityName(type.expression)
        ? entityNameText(type.expression)
        : undefined;
      if (!name) {
        unknown = true;
        continue;
      }
      const base = resolveNamedType(name, declarations, seen);
      variants = mergeVariants(variants, base.variants);
      unknown ||= base.unknown;
    }
  }
  return { variants, unknown, booleanOnly: false };
}

function resolveNamedType(
  name: string,
  declarations: Map<string, LocalTypeDeclaration>,
  seen: Set<string>,
): ResolvedAlertReturn {
  const declaration = declarations.get(name);
  if (!declaration || seen.has(name)) {
    return { variants: [], unknown: true, booleanOnly: false };
  }
  const nextSeen = new Set(seen);
  nextSeen.add(name);
  if (ts.isTypeAliasDeclaration(declaration)) {
    return resolveAlertType(declaration.type, declarations, nextSeen);
  }
  return resolveInterface(declaration, declarations, nextSeen);
}

function resolveAlertType(
  node: ts.TypeNode,
  declarations: Map<string, LocalTypeDeclaration>,
  seen: Set<string>,
): ResolvedAlertReturn {
  const type = unwrapParenthesizedType(node);
  if (type.kind === ts.SyntaxKind.BooleanKeyword) {
    return { variants: [], unknown: false, booleanOnly: true };
  }
  if (
    type.kind === ts.SyntaxKind.UndefinedKeyword ||
    type.kind === ts.SyntaxKind.NullKeyword ||
    type.kind === ts.SyntaxKind.NeverKeyword ||
    type.kind === ts.SyntaxKind.VoidKeyword
  ) {
    return { variants: [], unknown: false, booleanOnly: false };
  }
  if (ts.isTypeLiteralNode(type)) {
    return { variants: [objectVariant(type.members)], unknown: false, booleanOnly: false };
  }
  if (ts.isUnionTypeNode(type)) {
    const members = type.types.map((member) => resolveAlertType(member, declarations, seen));
    return {
      variants: members.flatMap((member) => member.variants),
      unknown: members.some((member) => member.unknown),
      booleanOnly:
        members.some((member) => member.booleanOnly) &&
        members.every((member) => member.booleanOnly || (member.variants.length === 0 && !member.unknown)),
    };
  }
  if (ts.isIntersectionTypeNode(type)) {
    const members = type.types.map((member) => resolveAlertType(member, declarations, seen));
    return {
      variants: members.reduce<AlertReturnVariant[]>(
        (current, member) => mergeVariants(current, member.variants),
        [],
      ),
      unknown: members.some((member) => member.unknown),
      booleanOnly: false,
    };
  }
  if (ts.isTypeReferenceNode(type)) {
    return resolveNamedType(entityNameText(type.typeName), declarations, seen);
  }
  return { variants: [], unknown: true, booleanOnly: false };
}

function collectLocalTypeDeclarations(sourceFile: ts.SourceFile): Map<string, LocalTypeDeclaration> {
  const declarations = new Map<string, LocalTypeDeclaration>();
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      declarations.set(node.name.text, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return declarations;
}

function collectAlertFunctions(sourceFile: ts.SourceFile): ts.FunctionDeclaration[] {
  const functions: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      /^compute[A-Za-z0-9]*Alert$/.test(node.name.text)
    ) {
      functions.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return functions;
}

function topLevelLocalTypeReferences(
  node: ts.TypeNode,
  declarations: Map<string, LocalTypeDeclaration>,
): string[] {
  const type = unwrapParenthesizedType(node);
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
    return type.types.flatMap((member) => topLevelLocalTypeReferences(member, declarations));
  }
  if (ts.isTypeReferenceNode(type)) {
    const name = entityNameText(type.typeName);
    return declarations.has(name) ? [name] : [];
  }
  return [];
}

function isExplicitNonAlertBranch(type: ts.TypeNode | undefined): boolean {
  if (!type) return false;
  const alertType = unwrapParenthesizedType(type);
  if (!ts.isLiteralTypeNode(alertType)) return false;
  return (
    alertType.literal.kind === ts.SyntaxKind.FalseKeyword ||
    alertType.literal.kind === ts.SyntaxKind.NullKeyword
  );
}

/**
 * A reason without an `alert` discriminator is an alerting branch by definition.
 * For discriminated named unions, `alert: false` and `alert: null` are the
 * intentional non-alert/unknown branches; `alert: true` (or an ambiguous
 * discriminator such as `boolean`) must carry the falsifier.
 */
export function auditAlertReturnTypes(src: string): AlertReturnAudit {
  const sourceFile = ts.createSourceFile(
    'leader-brief.ts',
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = collectLocalTypeDeclarations(sourceFile);
  const alertFunctions = collectAlertFunctions(sourceFile);
  const audit: AlertReturnAudit = {
    scanned: 0,
    bare: [],
    functions: alertFunctions.map((fn) => fn.name!.text),
    boolean: [],
    inline: [],
    named: [],
    unclassified: [],
  };

  for (const fn of alertFunctions) {
    const name = fn.name!.text;
    if (!fn.type) {
      audit.unclassified.push(`${name}: missing explicit return type`);
      continue;
    }
    const resolved = resolveAlertType(fn.type, declarations, new Set());
    if (resolved.booleanOnly && !resolved.unknown && resolved.variants.length === 0) {
      audit.boolean.push(name);
      continue;
    }
    if (resolved.unknown || resolved.variants.length === 0) {
      audit.unclassified.push(`${name}: ${fn.type.getText(sourceFile)}`);
      continue;
    }
    const reasonVariants = resolved.variants.filter((variant) => variant.properties.has('reason'));
    if (reasonVariants.length === 0) {
      audit.unclassified.push(`${name}: no resolvable reason-bearing return branch`);
      continue;
    }
    audit.scanned += 1;
    if (topLevelLocalTypeReferences(fn.type, declarations).length > 0) audit.named.push(name);
    else audit.inline.push(name);
    for (const variant of reasonVariants) {
      if (isExplicitNonAlertBranch(variant.properties.get('alert'))) continue;
      if (!variant.properties.has('falsifier')) {
        audit.bare.push(`${name}: ${fn.type.getText(sourceFile)}`);
      }
    }
  }
  return audit;
}

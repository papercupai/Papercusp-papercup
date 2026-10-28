import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { buildPtyHostHealthPatterns, classifyPtyHostEvent, type PtyHostEventAggregate } from './pty-host-health-lane';
import { flattenDigest } from './lenses';
import type { CorpusDigest } from './types';

const row = (kind: string, count: number, latestId = '42'): PtyHostEventAggregate => ({
  kind,
  count,
  owners: 2,
  latestId,
  lastAt: '2026-09-25 14:00:00+00',
});

/** Every host function whose call site names an event kind. The two drill helpers
 * write host events through appendHostEvent's `kind` pass-through. */
const HOST_EVENT_PRODUCERS = new Set([
  'appendHostEvent',
  // reanchorAfterContextReset's injected recorder; the host wires it to appendHostEvent.
  'appendEvent',
  'emitEvent',
  'recordAdoptedCarryDrillEvent',
  'recordAdoptedCarryDrillTerminal',
]);

/** Walk the host's emitter expressions instead of counting only literal calls.
 * A new computed form must be resolved here before its class can silently pass. */
function emittedHostKinds(hostSource: string): string[] {
  const source = ts.createSourceFile('psu-pty-host.mjs', hostSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        HOST_EVENT_PRODUCERS.has(node.expression.text)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);

  const bindingBefore = (name: string, use: ts.Node): ts.Expression | undefined => {
    for (let scope = use.parent; scope; scope = scope.parent) {
      if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
      const declarations = scope.statements
        .filter(ts.isVariableStatement)
        .flatMap((statement) => [...statement.declarationList.declarations])
        .filter((declaration) => ts.isIdentifier(declaration.name) &&
          declaration.name.text === name && declaration.getStart(source) < use.getStart(source));
      const initializer = declarations.at(-1)?.initializer;
      if (initializer) return initializer;
    }
    return undefined;
  };

  const returnedProperty = (expression: ts.Expression, name: string): ts.Expression | undefined => {
    if (ts.isParenthesizedExpression(expression)) return returnedProperty(expression.expression, name);
    if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
      const helper = bindingBefore(expression.expression.text, expression);
      // A helper is either `const f = (…) => { … }` in scope or a top-level `function f`
      // (classifyMcpReconnectHostOutcome feeds `outcome.event`; WI-6554700010030030).
      const calleeName = expression.expression.text;
      const declared = source.statements.find((statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === calleeName);
      const body = helper && ts.isArrowFunction(helper) && ts.isBlock(helper.body) ? helper.body : declared?.body;
      if (body) {
        const returns = body.statements
          .filter(ts.isReturnStatement)
          .flatMap((statement) => statement.expression ? [statement.expression] : []);
        return returns.map((value) => returnedProperty(value, name)).find(Boolean);
      }
    }
    if (!ts.isObjectLiteralExpression(expression)) return undefined;
    const property = expression.properties.find((candidate) => {
      if (!ts.isPropertyAssignment(candidate) && !ts.isShorthandPropertyAssignment(candidate)) return false;
      return (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) && candidate.name.text === name;
    });
    if (!property) return undefined;
    if (ts.isPropertyAssignment(property)) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property)) return bindingBefore(property.name.text, property);
    return undefined;
  };

  const resolve = (expression: ts.Expression, seen = new Set<ts.Node>()): string[] => {
    if (seen.has(expression)) throw new Error(`cyclic PTY event kind: ${expression.getText(source)}`);
    seen.add(expression);
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression.text];
    if (ts.isParenthesizedExpression(expression)) return resolve(expression.expression, seen);
    if (ts.isConditionalExpression(expression)) {
      return [...resolve(expression.whenTrue, new Set(seen)), ...resolve(expression.whenFalse, new Set(seen))];
    }
    if (ts.isIdentifier(expression)) {
      const initializer = bindingBefore(expression.text, expression);
      if (initializer) return resolve(initializer, seen);
    }
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
      const initializer = bindingBefore(expression.expression.text, expression);
      if (initializer) {
        const propertyValue = returnedProperty(initializer, expression.name.text);
        if (propertyValue) return resolve(propertyValue, seen);
      }
    }
    if (ts.isTemplateExpression(expression) && expression.getText(source) === '`${msg.mode}-inject-error`') {
      const guarded = hostSource.includes("if (msg.mode === 'reset' || msg.mode === 'recycle')");
      if (!guarded) throw new Error('PTY inject-error mode guard changed');
      return ['reset-inject-error', 'recycle-inject-error'];
    }
    throw new Error(`unresolved PTY event kind: ${expression.getText(source)}`);
  };

  const callee = (call: ts.CallExpression) => (call.expression as ts.Identifier).text;
  const hostCalls = calls.filter((call) => callee(call) === 'appendHostEvent');
  const delegated = hostCalls.filter((call) => call.arguments[1]?.getText(source) === 'kind');
  // A wrapper that forwards `kind` to appendHostEvent (makeCarryRearm's emitEvent,
  // recordAdoptedCarryDrillEvent, the reset re-anchor's appendEvent) hides its kinds at its
  // own call sites, so every such wrapper must be a counted producer. This is the invariant a
  // pinned call count only approximated: the count went red whenever the host added a producer
  // (WI-6554700010030030), while a NEW uncounted wrapper is exactly what must stay red.
  const wrapperName = (node: ts.Node): string | null => {
    for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
      if (ts.isFunctionDeclaration(n)) return n.name?.text ?? null;
      if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
        const holder = n.parent;
        if ((ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder)) && ts.isIdentifier(holder.name)) {
          return holder.name.text;
        }
        return null;
      }
    }
    return null;
  };
  expect(delegated.length).toBeGreaterThan(0);
  const uncounted = delegated.map(wrapperName).filter((name) => name === null || !HOST_EVENT_PRODUCERS.has(name));
  expect(uncounted, 'kind pass-through wrappers missing from HOST_EVENT_PRODUCERS').toEqual([]);
  const direct = hostCalls.filter((call) => !delegated.includes(call));
  const emitted = calls.filter((call) => callee(call) === 'emitEvent' || callee(call) === 'appendEvent');
  expect(emitted.length).toBeGreaterThan(0); // each one's kind must resolve below, or resolve() throws.
  // recordAdoptedCarryDrillTerminal delegates into recordAdoptedCarryDrillEvent with `kind`.
  const drill = calls.filter((call) =>
    callee(call).startsWith('recordAdoptedCarryDrill') && call.arguments[0]?.getText(source) !== 'kind');
  expect(drill.length).toBeGreaterThan(0);
  return [...new Set([...direct, ...emitted, ...drill].flatMap((call) => {
    const kind = call.arguments[callee(call) === 'appendHostEvent' ? 1 : 0];
    if (!kind || !ts.isExpression(kind)) throw new Error('PTY event kind argument missing');
    return resolve(kind);
  }))].sort();
}

describe('PTY host event classification for Blender', () => {
  it('separates the reported recovered retry from a terminal submit failure', () => {
    expect(classifyPtyHostEvent('turn-delivered-after-retry')).toBe('recovered');
    expect(classifyPtyHostEvent('submit-verify-unconfirmed')).toBe('failure');
    expect(classifyPtyHostEvent('submit-verify-exhausted')).toBe('failure');
    expect(classifyPtyHostEvent('turn-delivered')).toBe('routine');
    expect(classifyPtyHostEvent('duplicate-delivery-id')).toBe('routine');
    // WI-6554700010008412: a quota latch released at the provider's stated reset.
    expect(classifyPtyHostEvent('quota-block-expired-at-reset')).toBe('recovered');
  });

  it('covers the existing and newly logged host failure classes', () => {
    for (const kind of [
      'busy-gate-expired', 'respawn-carry-dropped', 'host-code-stale',
      'quota-block-detected', 'auth-block-detected', 'control-payload-unaddressed',
      'pty-load-failed', 'pty-spawn-failed', 'resume-finalization-report-failed',
      'resume-finalization-callback-failed', 'startup-turn-dropped',
      'kickoff-refusal-unreported-terminating',
      'session-port-delivery-ack-failed', 'managed-kickoff-failed',
      'gated-delivery-pipeline-error', 'gated-delivery-refused', 'control-socket-error',
      'control-socket-rebind-failed', 'session-scope-cleanup-partial',
      'session-scope-cleanup-failed', 'session-port-failure-ack-failed',
      // EI-27244198558252718: a must-deliver re-poll pending past its stall interval.
      'respawn-rearm-still-pending', 'wake-rearm-still-pending',
    ]) {
      expect(classifyPtyHostEvent(kind), kind).toBe('failure');
    }
    expect(classifyPtyHostEvent('future-unrecognized-event')).toBe('unclassified');
  });

  it('omits a safely suppressed kickoff retry while preserving a failed retry', () => {
    const patterns = buildPtyHostHealthPatterns([
      row('launch-kickoff-model-turn-retry-skipped', 20),
      row('launch-kickoff-model-turn-retry-error', 1, '43'),
    ]);
    expect(classifyPtyHostEvent('launch-kickoff-model-turn-retry-skipped')).toBe('routine');
    expect(patterns.map((pattern) => pattern.ref)).toEqual([
      'pty-host:kind:launch-kickoff-model-turn-retry-error',
    ]);
    expect(patterns[0]?.detail).toContain('Failure signal');
  });

  it('keeps an extended startup-frame wait routine until its terminal timeout', () => {
    expect(classifyPtyHostEvent('launch-kickoff-backend-frame-wait-extended')).toBe('routine');
    expect(classifyPtyHostEvent('launch-kickoff-backend-frame-timeout')).toBe('failure');
  });

  it('omits startup dialog control actions while retaining a failed Escape write', () => {
    const actions = ['codex-startup-update-dialog-escape-sent', 'codex-startup-update-dialog-escape-skipped'];
    for (const kind of actions) expect(classifyPtyHostEvent(kind), kind).toBe('routine');
    expect(classifyPtyHostEvent('codex-startup-update-dialog-escape-failed')).toBe('failure');
    expect(classifyPtyHostEvent('codex-startup-update-dialog-future-outcome')).toBe('unclassified');
    const patterns = buildPtyHostHealthPatterns([
      ...actions.map(kind => row(kind, 20)),
      row('codex-startup-update-dialog-escape-failed', 1),
    ]);
    expect(patterns.map(pattern => pattern.ref)).toEqual(['pty-host:kind:codex-startup-update-dialog-escape-failed']);
  });

  it('omits normal parking lifecycle signals while retaining failed parking and delivery outcomes', () => {
    const lifecycle = ['child-parked', 'child-park-deferred', 'child-unparked', 'parked-delivery-held'];
    const failures = ['child-park-failed', 'child-unpark-failed', 'parked-delivery-refused'];
    for (const kind of lifecycle) expect(classifyPtyHostEvent(kind), kind).toBe('routine');
    for (const kind of failures) expect(classifyPtyHostEvent(kind), kind).toBe('failure');
    expect(classifyPtyHostEvent('child-park-new-outcome')).toBe('unclassified');
    expect(buildPtyHostHealthPatterns([
      ...lifecycle.map(kind => row(kind, 20)),
      ...failures.map(kind => row(kind, 1)),
    ]).map(pattern => pattern.ref).sort()).toEqual(failures.map(kind => `pty-host:kind:${kind}`).sort());
  });

  it('keeps startup hold diagnostics distinct from the terminal stuck drop', () => {
    expect(classifyPtyHostEvent('kickoff-held-for-codex-frame')).toBe('routine');
    expect(classifyPtyHostEvent('kickoff-codex-frame-hold-ended')).toBe('routine');
    expect(classifyPtyHostEvent('codex-starting-stuck-snapshot')).toBe('routine');
    expect(classifyPtyHostEvent('codex-starting-stuck-early-drop')).toBe('failure');
    const patterns = buildPtyHostHealthPatterns([
      row('kickoff-held-for-codex-frame', 1),
      row('kickoff-codex-frame-hold-ended', 1),
      row('codex-starting-stuck-snapshot', 1),
      row('codex-starting-stuck-early-drop', 1),
    ]);
    expect(patterns.map(pattern => pattern.ref)).toEqual(['pty-host:kind:codex-starting-stuck-early-drop']);
  });

  it('retains abandoned resumes, rejected provenance and forced predecessor stops without counting stop diagnostics', () => {
    const failures = ['child-unpark-abandoned', 'wake-provenance-rejected', 'respawn-predecessor-force-kill'];
    for (const kind of failures) expect(classifyPtyHostEvent(kind), kind).toBe('failure');
    expect(classifyPtyHostEvent('respawn-predecessor-stop-started')).toBe('routine');
    expect(classifyPtyHostEvent('respawn-predecessor-stop-finished')).toBe('routine');
    const patterns = buildPtyHostHealthPatterns([
      row('respawn-predecessor-stop-started', 20),
      row('respawn-predecessor-stop-finished', 20),
      ...failures.map(kind => row(kind, 1)),
    ]);
    expect(patterns.map(pattern => pattern.ref).sort()).toEqual(failures.map(kind => `pty-host:kind:${kind}`).sort());
    for (const pattern of patterns) expect(pattern.detail).toContain('Failure signal');
    expect(classifyPtyHostEvent('respawn-predecessor-future-outcome')).toBe('unclassified');
  });

  it('keeps failed role MCP readiness while omitting a ready connection', () => {
    const patterns = buildPtyHostHealthPatterns([
      row('launch-role-mcp-ready', 20),
      row('launch-role-mcp-unavailable', 1, '44'),
    ]);
    expect(classifyPtyHostEvent('launch-role-mcp-ready')).toBe('routine');
    expect(classifyPtyHostEvent('launch-role-mcp-unavailable')).toBe('failure');
    expect(patterns.map((pattern) => pattern.ref)).toEqual([
      'pty-host:kind:launch-role-mcp-unavailable',
    ]);
    expect(patterns[0]?.detail).toContain('Failure signal');
  });

  it('keeps intentional delivery cancellation and duplicate suppression routine', () => {
    const cancellations = ['delivery-cancellation-requested', 'delivery-cancelled-before-write', 'duplicate-cancelled-delivery-id'];
    for (const kind of cancellations) expect(classifyPtyHostEvent(kind), kind).toBe('routine');
    expect(buildPtyHostHealthPatterns(cancellations.map(kind => row(kind, 3)))).toEqual([]);
    expect(classifyPtyHostEvent('delivery-cancellation-failed')).toBe('failure');
    expect(classifyPtyHostEvent('delivery-cancellation-new-outcome')).toBe('unclassified');
  });

  it('classifies every kind observed in the production 24-hour host-event census', () => {
    const observed = [
      'wake-turn-deferred-for-pending-respawn', 'turn-delivered', 'respawn-carry-delivered',
      'startup-turn-written', 'respawned', 'backend-tui-start-observed',
      'wake-rearm-queued', 'busy-gate-expired', 'wake-rearm-delivered',
      'backend-session-frame-observed', 'respawn-carry-dropped', 'respawn-rearm-queued',
      'wake-rearm-scheduled', 'host-code-stale', 'host-teardown',
      'headless-codex-model-choice-kept-existing', 'respawn-carry-turn-start-retry',
      'respawn-rearm-superseded', 'launch-kickoff-backend-frame-timeout',
      'control-payload-unaddressed', 'turn-start-unverified', 'stale-fire-dropped',
      'turn-verifier-unsupported', 'respawn-carry-fresh-epoch-retry',
      'host-code-adopting', 'submit-verify-unconfirmed',
      'launch-kickoff-marker-echo-confirmed', 'quota-block-detected',
      'launch-kickoff-marker-echo-unconfirmed', 'submit-verify-human-input-retry',
      'launch-kickoff-model-turn-absent', 'launch-kickoff-model-turn-retry-result',
      'wake-rearm-dropped', 'turn-deferred-quota-blocked', 'quota-block-cleared',
      'wake-rearm-unsupported', 'model-capacity-detected',
      'turn-deferred-for-owner-input', 'quota-recovery-started',
      'headless-claude-onboarding-expired', 'quota-recovery-ready',
      'orphan-teardown', 'submit-verify-exhausted', 'mcp-reconnect-dropped',
      'owner-composer-wedge-cleared',
    ];
    expect(observed).toHaveLength(45);
    expect(observed.filter((kind) => classifyPtyHostEvent(kind) === 'unclassified')).toEqual([]);
  });

  it('classifies every direct and computed event kind emitted by the PTY host', () => {
    const hostSource = readFileSync(
      process.env.PAPERCUSP_PTY_HOST_SOURCE_PROBE ||
        new URL('../../../../apps/operator/scripts/psu-pty-host.mjs', import.meta.url),
      'utf8',
    );
    const kinds = emittedHostKinds(hostSource);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).toContain('pty-spawned');
    const unclassified = kinds.filter((kind) => classifyPtyHostEvent(kind) === 'unclassified');
    expect(unclassified, `unclassified PTY host event kinds: ${unclassified.join(', ')}`).toEqual([]);
    expect(classifyPtyHostEvent('pty-spawned')).toBe('routine');
    // WI-6554700010030030: a failed in-place re-anchor is a failure; a benign skip is not.
    expect(classifyPtyHostEvent('reset-reanchor-failed')).toBe('failure');
    expect(classifyPtyHostEvent('reset-reanchor-skipped')).toBe('routine');
    expect(classifyPtyHostEvent('reset-reanchor-reported')).toBe('routine');
    expect(classifyPtyHostEvent('inject-mutex-force-released')).toBe('recovered');
    expect(classifyPtyHostEvent('mcp-reconnect-completed')).toBe('recovered');
    expect(classifyPtyHostEvent('control-payload-rejected')).toBe('failure');
    expect(classifyPtyHostEvent('persona-refresh-skipped')).toBe('failure');
    expect(classifyPtyHostEvent('headless-codex-model-choice-select-existing')).toBe('routine');
    expect(classifyPtyHostEvent('hooks-observation-result')).toBe('routine');
    expect(classifyPtyHostEvent('kickoff-waiting-for-codex-startup')).toBe('routine');
    expect(classifyPtyHostEvent('launch-kickoff-quota-rejected')).toBe('failure');
    expect(classifyPtyHostEvent('launch-kickoff-model-capacity-rejected')).toBe('failure');
    expect(classifyPtyHostEvent('quota-recovery-resumed')).toBe('recovered');
    expect(classifyPtyHostEvent('respawn-predecessor-stop-pending')).toBe('failure');
    expect(classifyPtyHostEvent('session-port-delivery-ack-pending')).toBe('failure');
    expect(classifyPtyHostEvent('submit-verify-recovery-resubmit')).toBe('recovered');
    // Pending is a non-terminal slow-echo state; confirmed/unconfirmed carry the verdict.
    expect(classifyPtyHostEvent('launch-kickoff-marker-echo-pending')).toBe('routine');
    // WI-10004943: replacing a stuck fresh Codex child is a recovery; the
    // replacement failing is a failure.
    expect(classifyPtyHostEvent('launch-kickoff-fresh-child-retry')).toBe('recovered');
    expect(classifyPtyHostEvent('launch-kickoff-fresh-child-failed')).toBe('failure');
    expect(classifyPtyHostEvent('launch-kickoff-marker-echo-confirmed')).toBe('routine');
    expect(classifyPtyHostEvent('launch-kickoff-marker-echo-unconfirmed')).toBe('failure');
  });

  it('places persisted failures and recovered retries in the flattened ideator corpus', () => {
    const lane = buildPtyHostHealthPatterns([
      row('turn-delivered', 20),
      row('turn-delivered-after-retry', 3, '43'),
      row('submit-verify-unconfirmed', 2, '44'),
      row('duplicate-delivery-id', 8),
    ]);
    const digest = {
      recurringFriction: [], timeTokenSinks: [], chronicDeferrals: [], capabilityGaps: [],
      ptyHostHealth: lane,
    } satisfies CorpusDigest;
    const flat = flattenDigest(digest);
    expect(flat.map((p) => p.ref)).toEqual([
      'pty-host:kind:submit-verify-unconfirmed',
      'pty-host:kind:turn-delivered-after-retry',
    ]);
    expect(flat[0]).toMatchObject({ category: 'pty-host-health' });
    expect(flat[0]?.detail).toContain('psu_pty_host_events.id=44');
    expect(flat[1]?.detail).toContain('not a final failure');
  });

  it('discloses both the pattern cap and database read cap', () => {
    const lane = buildPtyHostHealthPatterns([
      row('pty-load-failed', 2), row('control-socket-error', 1), row('future-event', 1),
    ], { limit: 1, totalKinds: 5 });
    expect(lane).toHaveLength(2);
    expect(lane[1]).toMatchObject({ ref: 'pty-host:coverage-residue' });
    expect(lane[1]?.detail).toContain('2 kinds outside');
  });

  it('keeps recovered delivery and unknown kinds visible when failures fill the cap', () => {
    const failures = Array.from({ length: 21 }, (_, index) => row(`failure-${index}-failed`, 21 - index));
    const lane = buildPtyHostHealthPatterns([
      ...failures,
      row('turn-delivered-after-retry', 610),
      row('future-unrecognized-event', 1),
    ]);
    expect(lane).toHaveLength(21); // 20 patterns plus a coverage residue
    expect(lane.map((pattern) => pattern.ref)).toContain('pty-host:kind:turn-delivered-after-retry');
    expect(lane.map((pattern) => pattern.ref)).toContain('pty-host:kind:future-unrecognized-event');
    expect(lane.at(-1)?.ref).toBe('pty-host:coverage-residue');
  });
});

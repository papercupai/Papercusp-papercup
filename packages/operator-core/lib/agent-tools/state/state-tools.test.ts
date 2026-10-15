/**
 * P-004 / D-058 — the TOOL layer of the state plane (`state:read`, `state:subscribe`).
 *
 * `cell-read.test.ts` covers the composition BELOW these tools (`readCell`: dispatch,
 * path projection, the three-way value/unknown/absent split). This suite covers what
 * only exists at the tool boundary, and it is not a formality — `state:subscribe`
 * carries three real gates of its own, and each one fails OPEN if it regresses:
 *
 *   1. the audience check (D-042 / P-028). Subscribing IS reading — it observes the
 *      value on a schedule — so a cell outside the reader's audience must be ABSENT
 *      here too. A regression makes `state:subscribe` a bypass of `canReadCell` that
 *      returns the value one poll later, which is exactly the silent leak D-042 closes.
 *   2. the event-signalled refusal. Registering a poller for a cell that PUSHES would
 *      poll a value that already has a key.
 *   3. caller-relativity (axis 3). Watching a relative cell with no subject is not a
 *      narrower question, it is no question at all.
 *
 * And one POSITIVE contract: the delegation to `watch:create`. R4 says this tool
 * registers nothing itself; the test that keeps it honest is that the cell supplies
 * the (tool, args, path) triple and the caller supplies only the comparator — because
 * the moment a hand-copied path appears here, the transcription defect P-017 (c)
 * detects has been re-introduced at the very surface built to remove it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const watchHandler = vi.fn();
const readCellMock = vi.fn();

// Only `handler` is faked. `watchTool.args` stays REAL so that `state:subscribe`'s
// parse-through (its deliberate choice over hand-building args) keeps failing loudly
// here if watch:create's schema moves — which is the whole point of parsing through it.
vi.mock('../events/watch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../events/watch')>();
  return {
    ...actual,
    default: { ...actual.default, handler: (...a: unknown[]) => watchHandler(...a) },
  };
});

vi.mock('../../cell-read', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cell-read')>();
  return { ...actual, readCell: (...a: unknown[]) => readCellMock(...a) };
});

vi.mock('../coordination/identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../coordination/identity')>();
  return {
    ...actual,
    resolveAgentIdentity: () => ({
      ownerId: 'su-me',
      ownerLabel: 'su · me',
      source: 'test',
      workspaceId: 'default',
      userId: null,
    }),
  };
});

import readTool from './read';
import subscribeTool, { STATE_SUBSCRIBE_GC_HORIZON_SEC } from './subscribe';
import { AWAIT_DEFAULT_TIMEOUT_SEC } from '../../events/await/types';
import { CHECKPOINT_MAX_RUNTIME_SEC } from '../../release-checkpoint-launch';
import { SU_ROLES } from '@papercusp/agent-mcp';
import { registerCell, __resetCellRegistryForTests, type CellSpec } from '../../cell-registry';
// The REAL comparator, so the P-005 semantic-transition property is proven against the
// code that actually evaluates a watch rather than restated as a shape assertion.
import { comparePredicate, valueAtPath } from '../../events/await/predicate-watch';

const CTX = { role: 'su', harnessSlug: 'papercusp', workspaceId: 'default' };

/** A registrable spec — every axis satisfied, so the registry never refuses for a
 *  reason unrelated to what the test under it is about. */
function spec(over: Partial<CellSpec> = {}): CellSpec {
  return {
    cell: 'test.cell',
    owner: 'test',
    headline: 'positions.deployed',
    assessment:
      over.changeSignal?.kind === 'event'
        ? null
        : {
            path: 'assessments.deploy',
            codes: {
              serving: {
                meaning: 'the running process is executing this sha.',
                safeAction: 'Treat the deploy as live.',
              },
              'checked-out-not-running': {
                meaning: 'the sha is on disk but the process was never restarted onto it.',
                safeAction: 'Restart the serving unit before concluding the deploy took effect.',
              },
            },
            evidence: ['serving.startedSinceCodeChange'],
          },
    nullable: false,
    whyTotal: 'test fixture — the stub resolver returns a value or throws; no read can fail into a default.',
    callerRelativity: { kind: 'global' },
    provenance: { obtainedBy: 'git rev-list', liveExercised: true, evidence: 'run live 2026-07-27' },
    resolver: `fixture:${over.cell ?? 'test.cell'}`,
    visibility: { kind: 'workspace' },
    federation: { kind: 'local' },
    changeSignal: { kind: 'poll', tool: 'dev:pipeline_position', path: 'positions.deployed' },
    shape: '{ positions, serving }',
    ...over,
  };
}

/**
 * P-005 — an alternate assessed spec with the domain codes used by target tests.
 *
 * `assessment.path` is deliberately a THIRD field, distinct from both the headline
 * (`positions.deployed`) and the materiality path used above: a target-resolution test
 * can then only pass by resolving the right path, never by two paths happening to
 * coincide. The codes are domain codes, not read-health codes — the registry rejects a
 * `CellUnknownCode` here on purpose.
 */
function assessed(over: Partial<CellSpec> = {}): CellSpec {
  return spec({
    assessment: {
      path: 'assessments.deploy',
      codes: {
        live: { meaning: 'the running process executes this commit', safeAction: 'read the deployed sha as authoritative' },
        stale: { meaning: 'the process predates the code change', safeAction: 'redeploy before trusting anything it serves' },
      },
      evidence: ['positions.deployed', 'serving.startedSinceCodeChange'],
    },
    ...over,
  });
}

type Out = { content: { type: 'text'; text: string }[]; isError?: boolean };
function body(r: unknown): Record<string, unknown> {
  return JSON.parse((r as Out).content[0].text) as Record<string, unknown>;
}

beforeEach(() => {
  __resetCellRegistryForTests();
  watchHandler.mockReset();
  watchHandler.mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true,"watch_id":"w1"}' }] });
  readCellMock.mockReset();
});

describe('state:subscribe — gate 1, the audience check (D-042 / P-028)', () => {
  it('refuses a cell outside the reader audience as ABSENT, registering no watch', async () => {
    registerCell(spec({ visibility: { kind: 'owner', ref: 'su-someone-else' } }));

    const b = body(await subscribeTool.handler({ cell: 'test.cell', on: { op: 'eq', value: true } } as never, CTX as never));

    expect(b.ok).toBe(false);
    expect(b.status).toBe('absent');
    // The leak this prevents: a refusal that still started the poller would deliver the
    // value one wake later, having "refused" it.
    expect(watchHandler).not.toHaveBeenCalled();
  });

  it('is a NON-ORACLE: out-of-audience and never-registered are indistinguishable', async () => {
    registerCell(spec({ cell: 'narrow.cell', visibility: { kind: 'owner', ref: 'su-someone-else' } }));

    const hidden = body(await subscribeTool.handler({ cell: 'narrow.cell', on: { op: 'exists' } } as never, CTX as never));
    const missing = body(await subscribeTool.handler({ cell: 'no.such.cell', on: { op: 'exists' } } as never, CTX as never));

    // Same status, same machine CODE, AND same prose modulo the name — if any of these
    // diverge, a stranger can enumerate the narrow cells by probing, which is the hazard
    // D-042 closes. The prose is compared via `reason`: `error` now carries a fixed code
    // (P-004), so asserting on it alone would pass for two refusals whose MESSAGES differ,
    // which is precisely the leak this test exists to catch.
    expect(hidden.status).toBe(missing.status);
    expect(hidden.error).toBe(missing.error);
    expect(String(hidden.reason).replace('narrow.cell', 'X')).toBe(String(missing.reason).replace('no.such.cell', 'X'));
  });
});

describe('state:subscribe — gate 2, an event-signalled cell is not pollable', () => {
  it('refuses and names the key to await instead of starting a poller', async () => {
    registerCell(spec({ changeSignal: { kind: 'event', key: 'deploy:landed' } }));

    const b = body(await subscribeTool.handler({ cell: 'test.cell', on: { op: 'eq', value: true } } as never, CTX as never));

    expect(b.ok).toBe(false);
    expect(b.eventKey).toBe('deploy:landed');
    expect(watchHandler).not.toHaveBeenCalled();
  });
});

describe('state:subscribe — gate 3, caller-relativity (axis 3)', () => {
  it('refuses a parameter-relative cell with no subject, naming the missing parameter', async () => {
    registerCell(spec({ callerRelativity: { kind: 'parameter', param: 'path' } }));

    const b = body(await subscribeTool.handler({ cell: 'test.cell', on: { op: 'exists' } } as never, CTX as never));

    expect(b.ok).toBe(false);
    expect(b.missingParam).toBe('path');
    expect(watchHandler).not.toHaveBeenCalled();
  });

  it('passes the subject through as the resolver argument under its declared name', async () => {
    registerCell(spec({ callerRelativity: { kind: 'parameter', param: 'path' } }));

    await subscribeTool.handler(
      { cell: 'test.cell', on: { op: 'exists' }, as: 'apps/operator/x.ts' } as never,
      CTX as never,
    );

    const sent = watchHandler.mock.calls[0][0] as { predicate: { args: Record<string, unknown> } };
    expect(sent.predicate.args).toEqual({ path: 'apps/operator/x.ts' });
  });

  it('treats a blank `as` as missing rather than as a subject', async () => {
    registerCell(spec({ callerRelativity: { kind: 'parameter', param: 'path' } }));

    const b = body(await subscribeTool.handler({ cell: 'test.cell', on: { op: 'exists' }, as: '   ' } as never, CTX as never));

    expect(b.ok).toBe(false);
    expect(b.missingParam).toBe('path');
  });
});

describe('state:subscribe — R4, it DELEGATES to watch:create and registers nothing', () => {
  it('takes the (tool, args, path) triple from the CELL and only the comparator from the caller', async () => {
    registerCell(spec());

    await subscribeTool.handler(
      { cell: 'test.cell', target: 'measurement', on: { op: 'eq', value: true } } as never,
      CTX as never,
    );

    expect(watchHandler).toHaveBeenCalledTimes(1);
    const sent = watchHandler.mock.calls[0][0] as Record<string, unknown>;
    // The cell is the single source of the triple. A hand-copied path here would be a
    // transcription — the exact defect this tool exists to remove.
    expect(sent.predicate).toEqual({
      tool: 'dev:pipeline_position',
      args: {},
      path: 'positions.deployed',
      op: 'eq',
      value: true,
    });
    expect(sent.wake).toBe(true);
    expect(sent.once).toBe(true); // one-shot default
  });

  it('omits `value` entirely for a valueless operand like `exists`', async () => {
    registerCell(spec());

    await subscribeTool.handler({ cell: 'test.cell', on: { op: 'exists' } } as never, CTX as never);

    const sent = watchHandler.mock.calls[0][0] as { predicate: Record<string, unknown> };
    // Not `value: undefined` — a key that exists with an undefined value compares
    // differently in the dedupe path than one that is absent.
    expect('value' in sent.predicate).toBe(false);
  });

  it('passes once:false and interval_sec through to the one registration path', async () => {
    registerCell(spec());

    await subscribeTool.handler(
      { cell: 'test.cell', target: 'measurement', on: { op: 'gt', value: 3 }, once: false, interval_sec: 120 } as never,
      CTX as never,
    );

    const sent = watchHandler.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.once).toBe(false);
    expect(sent.interval_sec).toBe(120);
  });
});

describe('state:subscribe — an over-cap note is truncated and reported, never refused (P-012)', () => {
  it('accepts a 2203-char note, clamps it to 2000 for the delegate, and stamps the repair on the result', async () => {
    registerCell(spec());
    const long = 'n'.repeat(2203); // the measured shape: 203 chars over the cap

    const r = await subscribeTool.handler(
      { cell: 'test.cell', target: 'measurement', on: { op: 'eq', value: true }, note: long } as never,
      CTX as never,
    );

    expect((r as Out).isError).not.toBe(true);
    expect(watchHandler).toHaveBeenCalledTimes(1);
    const sent = watchHandler.mock.calls[0][0] as { note: string };
    expect(sent.note).toHaveLength(2000);
    expect(sent.note).toBe(long.slice(0, 2000));
    const b = body(r);
    expect(b.noteTruncated).toEqual({ originalChars: 2203, storedChars: 2000 });
    expect(String(b.noteRepair)).toContain('accepted, not refused');
  });

  it('passes an at-cap note through byte-identical with no repair marker', async () => {
    registerCell(spec());
    const exact = 'x'.repeat(2000);

    const r = await subscribeTool.handler(
      { cell: 'test.cell', target: 'measurement', on: { op: 'eq', value: true }, note: exact } as never,
      CTX as never,
    );

    const sent = watchHandler.mock.calls[0][0] as { note: string };
    expect(sent.note).toBe(exact);
    const b = body(r);
    expect('noteTruncated' in b).toBe(false);
    expect('noteRepair' in b).toBe(false);
  });

  // The deliberately-wrong control at the SCHEMA layer: the pre-fix shape
  // (z.string().max(2000)) refuses this exact parse before any handler runs —
  // which was the whole bug. The softText shape must accept it.
  it('the args schema itself parses an over-cap note (the old .max(2000) hard refusal is gone)', () => {
    const parsed = subscribeTool.args.safeParse({ cell: 'test.cell', note: 'y'.repeat(2203) });
    expect(parsed.success).toBe(true);
    // And the historical control: the old shape really would have refused it,
    // proving this test can fail (falsifiability, not tautology).
    const oldShape = z.object({ note: z.string().max(2000).optional() });
    expect(oldShape.safeParse({ note: 'y'.repeat(2203) }).success).toBe(false);
  });
});

describe('state:read — the directory is audience-filtered, not audience-annotated', () => {
  it('OMITS a cell the reader may not see rather than marking it', async () => {
    registerCell(spec({ cell: 'open.cell' }));
    registerCell(spec({ cell: 'narrow.cell', visibility: { kind: 'owner', ref: 'su-someone-else' } }));

    const b = body(await readTool.handler({} as never, CTX as never));

    const names = (b.cells as { cell: string }[]).map((c) => c.cell);
    expect(names).toContain('open.cell');
    // Listing it as "3 cells you may not see" would enumerate exactly what `absent`
    // exists to hide.
    expect(names).not.toContain('narrow.cell');
    expect(b.count).toBe(1);
  });

  it('marks an event-signalled cell as not directly readable', async () => {
    registerCell(spec({ cell: 'polled.cell' }));
    registerCell(spec({ cell: 'pushed.cell', changeSignal: { kind: 'event', key: 'k' } }));

    const b = body(await readTool.handler({} as never, CTX as never));

    const listed = b.cells as { cell: string; readable: boolean; awaitKey?: string }[];
    const byName = Object.fromEntries(listed.map((c) => [c.cell, c.readable]));
    expect(byName['polled.cell']).toBe(true);
    expect(byName['pushed.cell']).toBe(false);
    expect(listed.find((c) => c.cell === 'pushed.cell')?.awaitKey).toBe('k');
    expect(b.note).toContain('await its `awaitKey` with events:await instead');
  });
});

describe('state:read — the unknown stays branchable, and the role fails CLOSED', () => {
  it('renders prose for a human WITHOUT dropping the branchable code', async () => {
    readCellMock.mockResolvedValue({
      status: 'unknown',
      cell: 'test.cell',
      unknown: { code: 'resolver-failed', detail: 'the probe timed out' },
    });

    const b = body(await readTool.handler({ cell: 'test.cell' } as never, CTX as never));

    expect(b.summary).toBe('the probe timed out');
    // Prose cannot be branched on — losing `code` here is the defect cell-contract.ts exists for.
    expect((b.unknown as { code: string }).code).toBe('resolver-failed');
  });

  it('tells an absent reader NOT to reconstruct the value from another surface', async () => {
    readCellMock.mockResolvedValue({ status: 'absent', cell: 'test.cell' });

    const b = body(await readTool.handler({ cell: 'test.cell' } as never, CTX as never));

    expect(String(b.summary)).toMatch(/do NOT reconstruct/i);
  });

  it('passes an EMPTY role when the caller presented none, so the second gate cannot widen', async () => {
    readCellMock.mockResolvedValue({ status: 'value', cell: 'test.cell', value: true });

    await readTool.handler({ cell: 'test.cell' } as never, { harnessSlug: 'papercusp', workspaceId: 'default' } as never);

    const env = readCellMock.mock.calls[0][2] as { role: string };
    // Substituting a real default here (a 'su', say) would widen the resolver's own role
    // gate for a caller who never presented a role — an access default that fails OPEN.
    expect(env.role).toBe('');
  });

  it('forwards the subject to readCell as the fourth argument', async () => {
    readCellMock.mockResolvedValue({ status: 'value', cell: 'test.cell', value: 1 });

    await readTool.handler({ cell: 'test.cell', as: 'su-peer' } as never, CTX as never);

    expect(readCellMock.mock.calls[0][3]).toBe('su-peer');
  });

  it('documents and enforces `as` as a bare subject string, not an object envelope', () => {
    expect(readTool.args.safeParse({ cell: 'git.pipelinePosition', as: 'apps/operator/x.ts' }).success).toBe(true);
    expect(readTool.args.safeParse({ cell: 'git.pipelinePosition', as: { path: 'apps/operator/x.ts' } }).success).toBe(false);
    expect(readTool.description).toContain('bare subject string');
  });
});

describe('P-021 — state:subscribe never applies materiality silently', () => {
  const withMateriality = () =>
    spec({
      materiality: {
        path: 'serving.startedSinceCodeChange',
        why: 'the headline follows every commit; this is the question the caller actually has.',
      },
    });

  it('keeps the headline path when the caller explicitly targets the measurement', async () => {
    registerCell(withMateriality());

    await subscribeTool.handler(
      { cell: 'test.cell', target: 'measurement', on: { op: 'eq', value: true } } as never,
      CTX as never,
    );

    const sent = watchHandler.mock.calls[0][0] as { predicate: { path: string } };
    expect(sent.predicate.path).toBe('positions.deployed');
  });

  it('watches the MATERIALITY path only when explicitly asked', async () => {
    registerCell(withMateriality());

    await subscribeTool.handler(
      { cell: 'test.cell', target: 'material', on: { op: 'eq', value: false } } as never,
      CTX as never,
    );

    const sent = watchHandler.mock.calls[0][0] as { predicate: { path: string }; note: string };
    expect(sent.predicate.path).toBe('serving.startedSinceCodeChange');
    expect(sent.note).toContain('material');
  });

  it('⚠ REFUSES `target:material` on a cell that declares none — never a silent fallback', async () => {
    // The failure this prevents is concrete and severe. Silently re-pointing a
    // caller's condition at a different path does not narrow it, it evaluates it
    // against a DIFFERENT DOMAIN: `{op:'ne', value:'<a sha>'}` aimed at a boolean
    // is true on the first poll, so the agent is woken instantly and told it was
    // a material change. A wake is an interrupt (D-044), and a spurious one is a
    // false all-clear that resumes an agent on a condition never established.
    registerCell(spec());

    const b = body(
      await subscribeTool.handler({ cell: 'test.cell', target: 'material', on: { op: 'exists' } } as never, CTX as never),
    );

    expect(b.ok).toBe(false);
    // The EXPLANATION lives in `reason`; `error` is the machine code the telemetry
    // groups by (P-004). Both are asserted so neither can quietly go missing.
    expect(b.error).toBe('no_materiality');
    expect(String(b.reason)).toContain('no materiality');
    expect(b.watchedPath).toBe('positions.deployed');
    expect(watchHandler).not.toHaveBeenCalled();
  });
});

/**
 * P-005 / D-014 §4 + D-007 — the explicit `target`.
 *
 * Three claims are under test here and each one fails SILENTLY if it regresses, which
 * is why every case asserts the delegated path rather than a return code:
 *
 *   1. D-007's default. On a cell that declares an assessment, an operand-free
 *      subscription watches the CODE — the whole point of P-005, since a semantic
 *      transition can happen with the raw measurement unchanged.
 *   2. The default is confined to operand-free conditions. Applying it to a valued one
 *      would evaluate the caller's operand against a domain they never named, and
 *      `comparePredicate` fails BOTH ways there: `ne` against a code enum is true on the
 *      first poll (instant spurious wake), `gt` is `Number('live')` → NaN → false
 *      forever (a watch that can never fire, reported by nothing).
 *   3. `of` is refused, never translated — for exactly the same reason.
 */
describe('state:subscribe — the explicit `target` (P-005 / D-007 / D-014 §4)', () => {
  it('an operand-free subscription on an ASSESSED cell watches the CODE (D-007 default)', async () => {
    registerCell(assessed());

    await subscribeTool.handler({ cell: 'test.cell' } as never, CTX as never);

    const sent = watchHandler.mock.calls[0][0] as { predicate: Record<string, unknown>; note: string };
    expect(sent.predicate.path).toBe('assessments.deploy');
    expect(sent.predicate.op).toBe('changed');
    // The note has to name the target, or a fleet reading `coord:inbox` cannot tell a
    // semantic watch from a raw one.
    expect(sent.note).toContain('(assessment)');
  });

  it('target:"measurement" keeps an operand-free subscription on the raw path with its unannotated note', async () => {
    registerCell(spec());

    await subscribeTool.handler({ cell: 'test.cell', target: 'measurement' } as never, CTX as never);

    const sent = watchHandler.mock.calls[0][0] as { predicate: Record<string, unknown>; note: string };
    expect(sent.predicate.path).toBe('positions.deployed');
    // `measurement` stays unannotated: the note names the cell transition without
    // duplicating the raw-path implementation detail.
    expect(sent.note).toBe('cell test.cell changed');
  });

  it('`exists` takes the default too — it names no domain, so it cannot misfire on either path', async () => {
    registerCell(assessed());

    await subscribeTool.handler({ cell: 'test.cell', on: { op: 'exists' } } as never, CTX as never);

    const sent = watchHandler.mock.calls[0][0] as { predicate: Record<string, unknown> };
    expect(sent.predicate.path).toBe('assessments.deploy');
  });

  it('target:"measurement" keeps the RAW path and its numeric operator intact', async () => {
    registerCell(assessed());

    await subscribeTool.handler(
      { cell: 'test.cell', target: 'measurement', on: { op: 'gt', value: 3 } } as never,
      CTX as never,
    );

    const sent = watchHandler.mock.calls[0][0] as { predicate: Record<string, unknown> };
    expect(sent.predicate).toEqual({
      tool: 'dev:pipeline_position',
      args: {},
      path: 'positions.deployed',
      op: 'gt',
      value: 3,
    });
  });

  it('target:"assessment" is accepted WITH an operand — naming the domain is what the refusal wanted', async () => {
    registerCell(assessed());

    await subscribeTool.handler(
      { cell: 'test.cell', target: 'assessment', on: { op: 'eq', value: 'stale' } } as never,
      CTX as never,
    );

    const sent = watchHandler.mock.calls[0][0] as { predicate: Record<string, unknown> };
    expect(sent.predicate.path).toBe('assessments.deploy');
    expect(sent.predicate.value).toBe('stale');
  });

  it('target:"material" still resolves on an assessed cell — materiality behaviour is unchanged', async () => {
    registerCell(
      assessed({
        materiality: {
          path: 'serving.startedSinceCodeChange',
          why: 'the headline follows every commit; this is the question the caller actually has.',
        },
      }),
    );

    await subscribeTool.handler({ cell: 'test.cell', target: 'material' } as never, CTX as never);

    const sent = watchHandler.mock.calls[0][0] as { predicate: Record<string, unknown> };
    expect(sent.predicate.path).toBe('serving.startedSinceCodeChange');
  });

  it('⚠ REFUSES a VALUED condition that names no target, and registers NOTHING', async () => {
    registerCell(assessed());

    const b = body(
      await subscribeTool.handler({ cell: 'test.cell', on: { op: 'ne', value: 'deadbeef' } } as never, CTX as never),
    );

    expect(b.ok).toBe(false);
    expect(b.error).toBe('target_required');
    // The refusal is only actionable if it names BOTH candidate paths — a caller who
    // has to go read the registry to answer it will guess instead.
    expect(b.assessmentPath).toBe('assessments.deploy');
    expect(b.measurementPath).toBe('positions.deployed');
    expect(watchHandler).not.toHaveBeenCalled();
  });

  it('⚠ REFUSES `of` rather than translating it — and this call USED to work', async () => {
    // Non-vacuous on purpose: before the rename this exact call registered a
    // materiality watch. Translating it now would be the silent re-point D-014 §4
    // forbids, so it must refuse even though the intent is unambiguous.
    registerCell(
      assessed({
        materiality: { path: 'serving.startedSinceCodeChange', why: 'the headline churns; this is the real question.' },
      }),
    );

    const b = body(
      await subscribeTool.handler({ cell: 'test.cell', of: 'material', on: { op: 'eq', value: true } } as never, CTX as never),
    );

    expect(b.error).toBe('of_renamed');
    expect(b.renamedTo).toBe('target');
    expect(b.useTarget).toBe('material');
    expect(watchHandler).not.toHaveBeenCalled();
  });

  it('maps the retired `of:"value"` to measurement in its refusal, not to the new default', async () => {
    registerCell(assessed());

    const b = body(await subscribeTool.handler({ cell: 'test.cell', of: 'value' } as never, CTX as never));

    expect(b.error).toBe('of_renamed');
    expect(b.useTarget).toBe('measurement');
  });

  it('refuses the half-migrated guess `of:"assessment"` with a POINTER, not a parser error', async () => {
    // `of` is a plain string, not the old enum, precisely so this reaches the handler.
    // As an enum it would die in the parser with a message naming neither `target` nor
    // the value that would have worked.
    expect(subscribeTool.args.safeParse({ cell: 'test.cell', of: 'assessment' }).success).toBe(true);
    registerCell(assessed());

    const b = body(await subscribeTool.handler({ cell: 'test.cell', of: 'assessment' } as never, CTX as never));

    expect(b.error).toBe('of_renamed');
    expect(String(b.reason)).toContain('target');
    expect(b.useTarget).toBeUndefined();
  });

  /**
   * THE PROPERTY P-005 EXISTS FOR, proven against the real comparator rather than
   * asserted: a code flip with an UNCHANGED headline wakes the assessment watch and
   * does not wake the measurement watch. The two paths come out of the two real
   * registrations above — nothing here is a transcribed literal, so a target-resolution
   * regression moves the paths and this test fails with them.
   */
  it('a SEMANTIC transition wakes an assessment watch that a measurement watch sleeps through', async () => {
    registerCell(assessed());

    await subscribeTool.handler({ cell: 'test.cell' } as never, CTX as never);
    const semantic = (watchHandler.mock.calls[0][0] as { predicate: { path: string } }).predicate.path;
    await subscribeTool.handler({ cell: 'test.cell', target: 'measurement' } as never, CTX as never);
    const raw = (watchHandler.mock.calls[1][0] as { predicate: { path: string } }).predicate.path;

    // The headline is IDENTICAL across these two payloads; only the meaning moved.
    const before = { positions: { deployed: true }, assessments: { deploy: 'live' } };
    const after = { positions: { deployed: true }, assessments: { deploy: 'stale' } };
    const fires = (path: string) =>
      comparePredicate(valueAtPath(after, path), 'changed', undefined, {
        established: true,
        value: valueAtPath(before, path),
      });

    expect(fires(semantic)).toBe(true);
    expect(fires(raw)).toBe(false);
  });
});

/**
 * state-plane-adoption-2026-08-02 P-003 / D-005. Every registered cell is a
 * release-pipeline cell, so the role that repairs a red gate must be able to read them
 * and to wait on them. This guards a silent re-narrowing (the same guard
 * dev:pipeline_position keeps over its own allowlist) AND the specific wrong fix:
 * granting reach by adding release-fixer to SU_ROLES would redefine the fleet
 * capability-cutover set (cutover-role-parity.test.ts asserts FLEET_CAPABILITY_ROLES ≡
 * SU_ROLES ∪ {cup}) and confine the role's native file-read/edit/git.
 */
describe('state plane reach — release-fixer (P-003)', () => {
  it('can reach BOTH state tools; reading a cell you cannot wait on is a half-open door', () => {
    expect(new Set(readTool.agentRoles ?? []).has('release-fixer')).toBe(true);
    expect(new Set(subscribeTool.agentRoles ?? []).has('release-fixer')).toBe(true);
  });

  it('is granted at the USE SITE, never by widening SU_ROLES', () => {
    expect((SU_ROLES as readonly string[]).includes('release-fixer')).toBe(false);
  });

  /** The allowlists must not drift apart — that is what produced the half-open door. */
  it('keeps the two allowlists identical', () => {
    expect(new Set(readTool.agentRoles ?? [])).toEqual(new Set(subscribeTool.agentRoles ?? []));
  });
});

/**
 * EI-25665485195356795. An acceptance-rubric bar may probe a live cell, and the rubric
 * executability validator refuses a probe its grader cannot re-run — so with judge
 * outside this allowlist, no live-plane bar could be independently graded. Judge stays
 * out of SU_ROLES for the same cutover reason as release-fixer.
 */
describe('state plane reach — judge (EI-25665485195356795)', () => {
  it('can reach BOTH state tools, so a grader can re-run a live-cell probe', () => {
    expect(new Set(readTool.agentRoles ?? []).has('judge')).toBe(true);
    expect(new Set(subscribeTool.agentRoles ?? []).has('judge')).toBe(true);
  });

  it('is granted at the USE SITE, never by widening SU_ROLES', () => {
    expect((SU_ROLES as readonly string[]).includes('judge')).toBe(false);
  });
});

/**
 * P-004 — `on` is optional and defaults to `changed`.
 *
 * Measured over all 300 state:subscribe calls in this workspace: 50 failed, and 23 of
 * those 50 were this one intent. 12 passed no `on` at all; 11 invented a spelling for
 * it ('change' / 'changes' / 'changed'). The cells involved were almost entirely
 * `gate.greenCheckpoint.verdict` and `deploy.3070.sha` — the pipeline waits the repo
 * guide itself sends agents here for.
 */
describe('state:subscribe — omitting `on` means "wake me when it moves" (P-004)', () => {
  it('registers op `changed` with NO operand when `on` is omitted', async () => {
    registerCell(spec());

    await subscribeTool.handler({ cell: 'test.cell' } as never, CTX as never);

    const sent = watchHandler.mock.calls[0][0] as { predicate: Record<string, unknown> };
    expect(sent.predicate.op).toBe('changed');
    // The absence of `value` is the whole point: nothing was transcribed, so there is
    // no stale-operand window between the caller's read and this registration.
    expect('value' in sent.predicate).toBe(false);
  });

  it('still takes the resolver triple from the CELL, not from the caller', async () => {
    registerCell(spec());

    await subscribeTool.handler({ cell: 'test.cell' } as never, CTX as never);

    const sent = watchHandler.mock.calls[0][0] as { predicate: Record<string, unknown> };
    expect(sent.predicate).toEqual({
      tool: 'dev:pipeline_position',
      args: {},
      path: 'assessments.deploy',
      op: 'changed',
    });
  });

  it('does NOT override an explicit `on` — a real threshold still wins', async () => {
    registerCell(spec());

    await subscribeTool.handler(
      { cell: 'test.cell', target: 'measurement', on: { op: 'gt', value: 3 } } as never,
      CTX as never,
    );

    const sent = watchHandler.mock.calls[0][0] as { predicate: Record<string, unknown> };
    expect(sent.predicate.op).toBe('gt');
    expect(sent.predicate.value).toBe(3);
  });

  it('accepts `changed` passed explicitly, and its auto-note names the op', async () => {
    registerCell(spec());

    await subscribeTool.handler({ cell: 'test.cell', on: { op: 'changed' } } as never, CTX as never);

    const sent = watchHandler.mock.calls[0][0] as Record<string, unknown>;
    expect((sent.predicate as Record<string, unknown>).op).toBe('changed');
    // No trailing operand in the human-readable note either — "changed null" would
    // read as "compared against null", which is not what happened.
    expect(sent.note).toBe('cell test.cell (assessment) changed');
  });

  it('the tool schema accepts a call with no `on` at all', () => {
    // The guarantee is at the SCHEMA, not just the handler: a required `on` would
    // reject these 12 calls before the handler ever ran.
    expect(subscribeTool.args.safeParse({ cell: 'test.cell' }).success).toBe(true);
    expect(subscribeTool.args.safeParse({ cell: 'test.cell', on: { op: 'changed' } }).success).toBe(true);
  });
});

/**
 * P-004 — every refusal carries a MACHINE code, not a prose sentence.
 *
 * The dispatcher lifts a refusal's `error` field verbatim into
 * `tool_invocations.error_code` (extractRefusalCode, truncated at 80 chars). This tool
 * used to put full sentences there, so every refusal produced a unique unqueryable
 * "code" and the failure taxonomy above had to be reconstructed by hand from
 * error_message prose plus args_json. A distinct short code per class makes it one query.
 */
describe('state:subscribe — refusal codes are queryable (P-004)', () => {
  const codeFor = async (args: Record<string, unknown>, cellSpec: Parameters<typeof registerCell>[0]) => {
    registerCell(cellSpec);
    return body(await subscribeTool.handler(args as never, CTX as never));
  };

  it('cell_absent — out of audience or unregistered', async () => {
    const b = await codeFor({ cell: 'test.cell' }, spec({ visibility: { kind: 'owner', ref: 'su-someone-else' } }));
    expect(b.error).toBe('cell_absent');
    expect(b.reason).toMatch(/subscribable by you/);
  });

  it('cell_event_signalled — the cell pushes, so it has a key', async () => {
    const b = await codeFor({ cell: 'test.cell' }, spec({ changeSignal: { kind: 'event', key: 'deploy:landed' } }));
    expect(b.error).toBe('cell_event_signalled');
    expect(b.eventKey).toBe('deploy:landed');
  });

  it('subject_required — a caller-relative cell with no `as`', async () => {
    const b = await codeFor({ cell: 'test.cell' }, spec({ callerRelativity: { kind: 'parameter', param: 'path' } }));
    expect(b.error).toBe('subject_required');
    expect(b.missingParam).toBe('path');
  });

  it('no_materiality — target:"material" on a cell that declares none', async () => {
    const b = await codeFor({ cell: 'test.cell', target: 'material' }, spec());
    expect(b.error).toBe('no_materiality');
    expect(b.reason).toMatch(/declares no materiality path/);
  });

  it('target_required — a valued condition on an assessed cell with no target named', async () => {
    const b = await codeFor({ cell: 'test.cell', on: { op: 'eq', value: true } }, assessed());
    expect(b.error).toBe('target_required');
  });

  it('of_renamed — the retired `of` knob', async () => {
    const b = await codeFor({ cell: 'test.cell', of: 'material' }, spec());
    expect(b.error).toBe('of_renamed');
  });

  it('every code is short, snake_case and stable — i.e. actually groupable in SQL', async () => {
    const codes = [
      'cell_absent',
      'cell_event_signalled',
      'subject_required',
      'no_materiality',
      // Defensive only after D-008: a valid poll registration cannot omit its
      // assessment, but the tool keeps this refusal for a corrupted registry row.
      'no_assessment',
      'target_required',
      'of_renamed',
    ];
    for (const c of codes) {
      // 80 is REFUSAL_CODE_MAX in dispatch-stack.ts; a longer code arrives truncated,
      // which silently splits one class into several rows in the taxonomy query.
      expect(c.length).toBeLessThanOrEqual(80);
      expect(c).toMatch(/^[a-z][a-z0-9_]*$/);
    }
    expect(new Set(codes).size).toBe(codes.length);
  });
});

/**
 * EI-20037590613603206 — the `once` registration must OUTLIVE the wait this tool's own
 * See-also prescribes.
 *
 * `state:subscribe` deliberately withholds `timeout_sec`/`on_timeout` (events:await owns
 * those), so a caller cannot raise the expiry even knowing it is wrong. Inheriting
 * watch:create's generic 30min default therefore expired the subscription mid-suite on
 * exactly the wait the repo guide sends agents here for — and since the registration
 * wakes with a TIMEOUT marker, a routine gate run read as "the thing I am waiting on has
 * STALLED".
 *
 * The `once:false` half is asserted too, because the tempting one-line fix (make the
 * once-path expiry null) would delete the ONLY reaper for never-firing watches:
 * predicate-watch.ts GCs a predicate watch precisely when its paired `event_awaits` row
 * is gone (`cancelled/consumed/expired`). So the contract has two halves — `once` keeps
 * an expiry, and it is larger than the generic default.
 */
describe('state:subscribe — the once-watch expiry is a GC horizon, not a wait budget (EI-20037590613603206)', () => {
  it('registers the once path with an explicit expiry, NOT watch:create\'s generic default', async () => {
    registerCell(spec());

    await subscribeTool.handler({ cell: 'test.cell' } as never, CTX as never);

    const sent = watchHandler.mock.calls[0][0] as { once: boolean; timeout_sec?: number };
    expect(sent.once).toBe(true);
    expect(sent.timeout_sec).toBe(STATE_SUBSCRIBE_GC_HORIZON_SEC);
  });

  // The CALIBRATION for the assertion above: it is only load-bearing while the value it
  // overrides is genuinely shorter. If watch:create's generic default is ever raised past
  // this horizon, the override stops being a fix and this test says so instead of passing
  // vacuously alongside a regression.
  it('the horizon is strictly longer than the generic default it overrides, and covers the suite ceiling', () => {
    expect(AWAIT_DEFAULT_TIMEOUT_SEC).toBeLessThan(STATE_SUBSCRIBE_GC_HORIZON_SEC);
    expect(STATE_SUBSCRIBE_GC_HORIZON_SEC).toBeGreaterThan(CHECKPOINT_MAX_RUNTIME_SEC);
  });

  it('a STANDING watch (once:false) still carries NO expiry — it is not on the GC contract', async () => {
    registerCell(spec());

    await subscribeTool.handler({ cell: 'test.cell', once: false } as never, CTX as never);

    const sent = watchHandler.mock.calls[0][0] as { once: boolean; timeout_sec?: number };
    expect(sent.once).toBe(false);
    expect(sent.timeout_sec).toBeUndefined();
  });
});

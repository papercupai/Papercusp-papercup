/**
 * Guard: the fixtures still match what the backends actually write (WI-41499).
 *
 * `transcript-wire-fixtures.ts` is a COPY of the wire — and a copy of a truth
 * the code does not own is exactly the thing the derived-truth ladder says will
 * drift. It cannot be DERIVED (no backend publishes a schema here), so it takes
 * the next rung: ATTEST. This reads REAL transcripts off disk and checks that
 * every field the parsers depend on is still present, with the same coarse
 * type, in real records of the same variant.
 *
 * That is the check nobody had. WI-41498 shipped because the live-stream parser
 * read `payload.arguments` while current Codex writes `custom_tool_call` with
 * `input` — a change no test could see, because every test asserted against a
 * payload its author had invented. Nothing errored; ~97% of one session's tool
 * chips simply arrived empty, and the pane looked plausible enough that it took
 * a live measurement to notice.
 *
 * SKIPS when no transcripts exist (CI, a fresh checkout). That is deliberate:
 * this is an attestation against live data, not a hermetic unit test, and a
 * guard that fabricated its own evidence to stay green would be the very defect
 * it exists to catch. It is loud where the evidence is real — on the dev box
 * and any machine that has actually run agents.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  CLAUDE_WIRE_FIXTURES,
  CODEX_WIRE_FIXTURES,
  OMP_WIRE_FIXTURES,
  matchesDiscriminator,
  resolveWirePath,
  wireTypeOf,
  type WireFixture,
} from './transcript-wire-fixtures';

const PAPERCUSP = join(homedir(), '.papercusp');

/** Bounded: enough real records to be representative, not enough to be slow. */
const MAX_FILES_PER_BACKEND = 3;
const MAX_BYTES_PER_FILE = 12 * 1024 * 1024;

/** Matching JSONL transcripts under `root`, depth-bounded, newest first. */
function newestTranscripts(
  root: string,
  depth: number,
  acceptsName: (name: string) => boolean = (name) => name.endsWith('.jsonl'),
): string[] {
  if (!existsSync(root)) return [];
  const found: Array<{ path: string; mtimeMs: number }> = [];
  const walk = (dir: string, left: number) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (left > 0) walk(p, left - 1);
      } else if (e.isFile() && acceptsName(e.name)) {
        try {
          const st = statSync(p);
          if (st.size > 0) found.push({ path: p, mtimeMs: st.mtimeMs });
        } catch { /* raced with a rotation — skip */ }
      }
    }
  };
  walk(root, depth);
  return found
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_FILES_PER_BACKEND)
    .map((f) => f.path);
}

const BACKENDS: Array<{
  backend: 'codex' | 'omp' | 'claude';
  fixtures: readonly WireFixture[];
  roots: () => string[];
}> = [
  {
    backend: 'codex',
    fixtures: CODEX_WIRE_FIXTURES,
    // ~/.papercusp/su-codex-homes/session-<advId>/sessions/YYYY/MM/DD/rollout-*.jsonl
    // A Codex home also writes `history.jsonl`, whose `{session_id, ts, text}`
    // prompt-history rows are not rollout wire records. Sampling it as a
    // transcript collapses those rows into the guard's ambiguous `?` census.
    roots: () => newestTranscripts(
      join(PAPERCUSP, 'su-codex-homes'),
      6,
      (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'),
    ),
  },
  {
    backend: 'omp',
    fixtures: OMP_WIRE_FIXTURES,
    // ~/.papercusp/su-omp-homes/session-<advId>/agent/sessions/<munged-cwd>/*.jsonl
    roots: () => newestTranscripts(join(PAPERCUSP, 'su-omp-homes'), 5),
  },
  {
    backend: 'claude',
    fixtures: CLAUDE_WIRE_FIXTURES,
    // ~/.papercusp/session-claude/<ownerId>/projects/<munged-cwd>/<uuid>.jsonl
    roots: () => newestTranscripts(join(PAPERCUSP, 'session-claude'), 4),
  },
];

describe('transcript wire discovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'transcript-wire-discovery-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('samples Codex rollout wire without admitting newer history.jsonl prompt rows', () => {
    const day = join(root, 'session-1', 'sessions', '2026', '08', '25');
    mkdirSync(day, { recursive: true });
    const rollout = join(day, 'rollout-2026-08-25T00-00-00-session.jsonl');
    const history = join(root, 'session-1', 'history.jsonl');
    writeFileSync(rollout, '{"type":"response_item"}\n');
    writeFileSync(history, '{"session_id":"session","ts":1,"text":"prompt"}\n');
    utimesSync(rollout, new Date(1_000_000), new Date(1_000_000));
    utimesSync(history, new Date(2_000_000), new Date(2_000_000));

    expect(newestTranscripts(
      root,
      6,
      (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'),
    )).toEqual([rollout]);
  });
});

/** Parsed records from the newest transcripts for one backend. */
function readRecords(paths: string[]): unknown[] {
  const out: unknown[] = [];
  for (const p of paths) {
    let text: string;
    try {
      if (statSync(p).size > MAX_BYTES_PER_FILE) continue;
      text = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch { /* a torn final line of a live file — the parsers skip these too */ }
    }
  }
  return out;
}

describe('transcript wire fixtures still match the live wire', () => {
  for (const { backend, fixtures, roots } of BACKENDS) {
    describe(backend, () => {
      const paths = roots();
      const records = paths.length ? readRecords(paths) : [];

      if (records.length === 0) {
        it.skip(`no ${backend} transcripts on this machine — nothing to attest against`, () => {});
        return;
      }

      it(`read real ${backend} records to check against`, () => {
        expect(records.length).toBeGreaterThan(0);
      });

      // One record type can legitimately carry SEVERAL shapes — a claude
      // tool_result's `content` is a bare string 43 times and a block array 24
      // times across the same three transcripts; a codex tool output is an
      // array 164 times and a string 6 times. So the unit of comparison is the
      // VARIANT GROUP (every fixture sharing a discriminator), and the question
      // is whether each real record satisfies AT LEAST ONE known variant.
      //
      // Checking fixtures one at a time cannot express that: it either fails on
      // the sibling shape or, if the discriminator is narrowed to select only
      // its own shape, goes vacuous — and a genuinely NEW third shape would
      // then match no fixture and pass unnoticed, which is the whole failure
      // being guarded against.
      const groups = new Map<string, WireFixture[]>();
      for (const fixture of fixtures) {
        const key = JSON.stringify(fixture.discriminator);
        groups.set(key, [...(groups.get(key) ?? []), fixture]);
      }

      for (const [key, group] of groups) {
        const real = records.filter((r) => matchesDiscriminator(r, JSON.parse(key)));
        const label = group.map((f) => f.name).join('  ||  ');

        // A variant this machine's sessions never produced is not a failure —
        // three rollouts with no `function_call` disprove nothing. Reported as
        // a SKIP so it stays visible in the run without inventing evidence.
        const test = real.length === 0 ? it.skip : it;

        test(`${label}`, () => {
          for (const rec of real) {
            const failures: string[] = [];

            const satisfied = group.some((fixture) => {
              for (const path of fixture.readFields) {
                const expected = resolveWirePath(fixture.record, path);
                expect(expected, `fixture "${fixture.name}" lost its own ${path}`).not.toHaveLength(0);
                const expectedTypes = new Set(expected.map(wireTypeOf));

                const actual = resolveWirePath(rec, path);
                if (actual.length === 0) {
                  failures.push(`${fixture.name}: no ${path}`);
                  return false;
                }
                const wrongType = actual.map(wireTypeOf).find((t) => !expectedTypes.has(t));
                if (wrongType !== undefined) {
                  failures.push(
                    `${fixture.name}: ${path} is "${wrongType}", fixture has "${[...expectedTypes].join('|')}"`,
                  );
                  return false;
                }
              }
              return true;
            });

            expect(
              satisfied,
              `${backend}: a real record matching this variant group fits NO known fixture.\n` +
              `  ${failures.join('\n  ')}\n` +
              `The wire moved. Update transcript-wire-fixtures.ts AND the parser that reads it — ` +
              `a field the parser reads but the wire no longer writes renders as an empty chip, silently.`,
            ).toBe(true);
          }
        });
      }

      it('the dominant record types all have a fixture', () => {
        // The other half of drift: not a moved field, but a whole record type
        // that becomes common while no fixture — and possibly no parser branch
        // — knows about it. `custom_tool_call` itself arrived this way.
        const census = new Map<string, number>();
        for (const rec of records) {
          const r = rec as { type?: unknown; payload?: { type?: unknown }; message?: { role?: unknown } };
          const top = typeof r.type === 'string' ? r.type : '?';
          const sub = typeof r.payload?.type === 'string'
            ? r.payload.type
            : typeof r.message?.role === 'string'
              ? r.message.role
              : '';
          const key = sub ? `${top}/${sub}` : top;
          census.set(key, (census.get(key) ?? 0) + 1);
        }

        const covered = new Set<string>();
        for (const fixture of fixtures) {
          for (const rec of records) {
            if (!matchesDiscriminator(rec, fixture.discriminator)) continue;
            const r = rec as { type?: unknown; payload?: { type?: unknown }; message?: { role?: unknown } };
            const top = typeof r.type === 'string' ? r.type : '?';
            const sub = typeof r.payload?.type === 'string'
              ? r.payload.type
              : typeof r.message?.role === 'string'
                ? r.message.role
                : '';
            covered.add(sub ? `${top}/${sub}` : top);
          }
        }

        // Record types the parser deliberately ignores even though they DO
        // carry a conversational field: telemetry, turn bookkeeping, per-item
        // completion echoes, injected scaffolding. Listed rather than inferred,
        // so adding one is a visible decision.
        const IGNORED = new Set([
          // Claude Code's timestamp-less captures of the outgoing API request
          // body (EI-27188648844771651). They re-carry messages already recorded
          // as user/assistant rows, so reading them would duplicate conversation.
          'api-request-blob/assistant', 'api-request-blob/system', 'api-request-blob/user',
          'event_msg/token_count', 'event_msg/task_started', 'event_msg/task_complete',
          'event_msg/item_completed', 'event_msg/thread_settings_applied', 'event_msg/error',
          // Codex's usage telemetry has a `payload`, but no conversational field the
          // timeline parsers read. Keep it explicit so the payload envelope does not
          // classify this bookkeeping record as an uncovered conversation variant.
          'token_usage_record',
          'turn_context', 'session_meta', 'world_state', 'compacted',
          'custom', 'custom_message', 'branch_summary', 'ttsr_injection',
          'summary', 'system', 'file-history-snapshot', 'queue-operation',
        ]);

        /**
         * A record type only matters here if it could carry CONVERSATION — i.e.
         * it has one of the top-level fields the parsers actually read.
         *
         * Derived from the record rather than hand-listed, because the
         * alternative rots in the worst direction: every client release adds
         * UI-metadata record types (`ai-title`, `atis-latch`, `last-prompt`,
         * `permission-mode`, `attachment` — none of which carry conversation),
         * and a hand-maintained ignore list would red the SHARED release gate
         * on every one of them until someone appended a name. That trains
         * people to widen the list reflexively, which is exactly how a real new
         * record type gets waved through.
         */
        const CONVERSATIONAL_FIELDS = ['message', 'payload', 'content', 'text', 'thinking', 'input', 'output'];
        const conversational = new Set<string>();
        for (const rec of records) {
          if (!rec || typeof rec !== 'object') continue;
          if (!CONVERSATIONAL_FIELDS.some((f) => f in (rec as Record<string, unknown>))) continue;
          // A turn whose content array is EMPTY carries no conversation, so it cannot be
          // evidence that a parser branch is missing — there is nothing to read. omp writes
          // exactly this for a model call that returned nothing (`content: []` with all-zero
          // usage), and one failing provider session can make them the DOMINANT shape on the
          // sampled wire: 113 of 158 assistant records in one 2026-08-25 sample.
          //
          // Neither escape this guard offers fits that: the parser cannot "read" an empty
          // array, and putting `message/assistant` in IGNORED would blind the gate to the
          // single most important omp record type forever — the reflexive widening the
          // IGNORED comment above warns against. So skip only the contentless record, and
          // only when `message` is its sole conversational field: any record carrying even
          // one content block is still censused, so a genuinely new content-bearing shape
          // still reds this gate. The empty turns themselves are an upstream runtime fault
          // (EI filed), not wire drift a fixture or parser change here could fix.
          const msg = (rec as { message?: { content?: unknown } }).message;
          const otherConversational = CONVERSATIONAL_FIELDS.some(
            (f) => f !== 'message' && f in (rec as Record<string, unknown>),
          );
          if (!otherConversational && msg && Array.isArray(msg.content) && msg.content.length === 0) {
            continue;
          }
          const r = rec as { type?: unknown; payload?: { type?: unknown }; message?: { role?: unknown } };
          const top = typeof r.type === 'string' ? r.type : '?';
          const sub = typeof r.payload?.type === 'string'
            ? r.payload.type
            : typeof r.message?.role === 'string'
              ? r.message.role
              : '';
          conversational.add(sub ? `${top}/${sub}` : top);
        }

        const total = records.length;
        const uncovered = [...census.entries()]
          .filter(([key, n]) =>
            conversational.has(key) && !covered.has(key) && !IGNORED.has(key) && n / total >= 0.02)
          .sort((a, b) => b[1] - a[1]);

        expect(
          uncovered.map(([k, n]) => `${k} (${n}, ${((n / total) * 100).toFixed(1)}%)`),
          `${backend}: record type(s) at >=2% of the wire with no fixture and no explicit ignore. ` +
          `Either the parser should read them (WI-41498 was exactly this) or add them to IGNORED.`,
        ).toEqual([]);
      });
    });
  }
});

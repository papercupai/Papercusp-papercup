/**
 * su-posture-render.test.ts — identities-v1-2026-08-30 P-013 / P-020 ACCEPTANCE,
 * measured against the P-018 baseline: the test-only union accounts for every source
 * byte while remaining illegal as a live stack, and the default/member/leader renders
 * are strict subsets with byte deltas reported.
 *
 * The SUBJECT is the PINNED fixture (`__fixtures__/su-render-baseline/`) — the same frozen
 * su.md / Claude overlay / stub project guide the P-018 baseline was recorded from — so the
 * numbers are comparable across the plan's moves. The BASELINE render is that fixture through
 * `renderSuPlaybook` as-is (the pre-seal su.md: both postures inline). Each POSTURE render is
 * the fixture composed under the seal with ONE posture bound (`composeSuStackSource`, the
 * fleet-posture identity resolved through the prompt chain), then spliced by the same
 * `renderSuPlaybook`.
 *
 * STRICT SUBSET is asserted at the LINE level: every non-blank line of a posture render is a
 * line of the baseline render, except the KERNEL's two additions — the seal's precedence
 * statement (P-003) and the kernel base text `agent-base-preamble.md` (D-018 / P-032, rendered
 * on every tier since the seal; the pre-seal fixture never carried it) — AND at least one
 * baseline line is absent (the other posture's craft). Per-`## `-section byte deltas are reported (they move between
 * sections because the seal reorders kernel tiles under the seal — that is the P-003 shape,
 * not a P-020 leak), together with the whole-render byte delta and the bytes of each posture
 * document. Set `SU_RENDER_BASELINE_DUMP=<dir>` to also write the renders + tables there.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SU_PART_DOCUMENTS,
  SU_TILES,
  composeSuStackSource,
  extractSuPart,
  locateSuTiles,
  normalizeStackBinding,
  suSessionBinding,
  suStackDocuments,
} from '@papercusp/orchestrator/blueprint';
import { renderSuPlaybook } from './papercusp-files';
import { formatScoreTable, measureSuRender, scoreAgainstBaseline, sha256 } from './su-render-baseline';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, '__fixtures__', 'su-render-baseline');
const INPUTS = {
  base: join(FIXTURE_DIR, 'su.base.md'),
  overlay: join(FIXTURE_DIR, 'papercusp-su.claude.md'),
  projectGuide: join(FIXTURE_DIR, 'project-guide.md'),
} as const;
const DUMP_DIR = process.env.SU_RENDER_BASELINE_DUMP;

/** The repo root (the dir holding libs/papercusp) → the built-in harness the identities live in. */
const repoRoot = (() => {
  let d = HERE;
  for (let i = 0; i < 8; i++) {
    try {
      readFileSync(join(d, 'libs', 'papercusp', 'package.json'));
      return d;
    } catch {
      d = resolve(d, '..');
    }
  }
  throw new Error('su-posture-render: repo root (libs/papercusp) not found above ' + HERE);
})();
const harnessDir = join(repoRoot, 'libs/papercusp/packages/harness');

const read = (p: string) => readFileSync(p, 'utf8');
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const lineSet = (text: string) =>
  new Set(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== ''),
  );

async function splice(baseText: string): Promise<string> {
  const out = await renderSuPlaybook({
    referenceMode: 'inline',
    agent: 'claude',
    profile: 'engineer',
    baseSource: INPUTS.base,
    baseText,
    overlayDir: FIXTURE_DIR,
    projectGuideSource: INPUTS.projectGuide,
    tier: 'full',
  });
  return out.text;
}

function dump(name: string, text: string): void {
  if (!DUMP_DIR) return;
  mkdirSync(DUMP_DIR, { recursive: true });
  writeFileSync(join(DUMP_DIR, name), text);
}

const POSTURES = ['member', 'leader'] as const;
type Posture = (typeof POSTURES)[number];
const VARIANTS = ['default', ...POSTURES] as const;
type Variant = (typeof VARIANTS)[number];
/** The first line of every tile that belongs to a posture — the craft that must NOT leak. */
const postureAnchors = (p: Posture) =>
  SU_TILES.filter((t) => t.part === 'fleet-posture' && t.posture === p).map((t) => t.anchor);

describe('P-019 — host-managed workflow after the real Codex render splices', () => {
  for (const referenceMode of ['inline', 'on-demand'] as const) {
    it(`${referenceMode}: delegates preamble ledger mechanics and retains authority and investigation`, async () => {
      const variants = [];
      for (const controlled of [false, true]) {
        const source = composeSuStackSource({
          harnessDir,
          ...(controlled ? { workItemWorkflow: 'host-managed' as const } : {}),
        });
        const { text } = await renderSuPlaybook({
          referenceMode,
          agent: 'codex',
          profile: 'engineer',
          baseSource: join(harnessDir, 'blueprints/base/prompts/su.md'),
          baseText: source.text,
          overlayDir: join(repoRoot, 'apps/operator/prompts'),
          projectGuideSource: '',
          tier: 'full',
        });
        const agentManaged = [
          'file a work item for it and CLAIM it',
          'Record what you\nfound and did on the work item / plan',
        ];
        const hostManaged = ['The host records the findings', 'Report the stall and its evidence to the host'];
        const retained = [
          'File locking is ENFORCED', 'Identity text is never an input to authority',
          'Root cause named', 'Verified —', 'check its concrete progress',
          'investigate and fix it',
        ];
        for (const needle of agentManaged) expect(text.includes(needle), needle).toBe(!controlled);
        for (const needle of hostManaged) expect(text.includes(needle), needle).toBe(controlled);
        for (const needle of retained) expect(text.includes(needle), needle).toBe(true);
        const seal = '<!-- PAPERCUSP-KERNEL:SEAL -->';
        expect(text.split(seal)).toHaveLength(2);
        expect(text.indexOf('# Agent base preamble')).toBeGreaterThan(text.indexOf(seal));
        variants.push({ controlled, sourceSha256: sha256(source.text), promptSha256: sha256(text),
          matches: [...agentManaged, ...hostManaged, ...retained].map(needle => ({ needle, present: text.includes(needle) })) });
        dump(`p019-${referenceMode}-${controlled ? 'controlled' : 'ordinary'}.md`, text);
      }
      const inputs = [
        ...SU_PART_DOCUMENTS.map(doc => join(harnessDir, doc.path)),
        join(harnessDir, 'blueprints/base/prompts/su.md'),
        join(harnessDir, 'blueprints/base/prompts/agent-base-preamble.md'),
        join(repoRoot, 'libs/papercusp/packages/orchestrator/src/blueprint/su-stack.ts'),
        join(repoRoot, 'libs/papercusp/packages/orchestrator/src/blueprint/su-decomposition.ts'),
        join(HERE, 'papercusp-files.ts'),
        join(HERE, 'su-posture-render.test.ts'),
        join(repoRoot, 'apps/operator/prompts/papercusp-su.codex.md'),
      ];
      dump(`p019-${referenceMode}-receipt.json`, JSON.stringify({
        scope: 'Current local composeSuStackSource + renderSuPlaybook; no project guide, native launch or provider acceptance',
        generatedAt: new Date().toISOString(), referenceMode, variants,
        files: inputs.map(path => ({ path, sha256: sha256(read(path)) })),
      }, null, 2));
    });
  }
});

describe('P-013 / P-020 — identity variants against the P-018 baseline (pinned fixture)', () => {
  const baseText = read(INPUTS.base);
  const preambleText = read(join(harnessDir, 'blueprints/base/prompts/agent-base-preamble.md'));
  const preambleLines = lineSet(preambleText);
  const preambleBytes = bytes(preambleText);
  /**
   * The tiles the FROZEN fixture actually carries.
   *
   * `su.base.md` is PINNED (this dir's README forbids hand-editing it, and
   * `su-render-baseline.test.ts` refuses a fixture whose hash no longer matches
   * `baseline.json`), while `SU_TILES` tracks the LIVE su.md and legitimately gains anchors —
   * it gained `## Owner directives — durable capture and resolution` on 2026-09-21T17:17Z,
   * which red this file: a FROZEN subject was being validated with a LIVE invariant, so every
   * future su.md section would red it again. Scoping the tiling to the fixture keeps the pin —
   * and the P-018 comparability every Part B move is scored against (R12/R17) — intact,
   * instead of re-pinning a baseline that is still being measured against.
   *
   * This loses NO coverage. The live-su.md tiling invariant (every tile anchor present, every
   * heading classified, tiles in order) is asserted against the REAL harness file by
   * `orchestrator/src/blueprint/su-identities.test.ts`, which passes no override — that is
   * where a genuinely un-tiled new section must fail, and it still does.
   *
   * Membership is exact-equality on whole lines, matching the tiler's own `l === t.anchor`.
   */
  const fixtureLines = new Set(baseText.split('\n'));
  const fixtureTiles = SU_TILES.filter((t) => fixtureLines.has(t.anchor));

  it('the test-only engineer + collaboration-stance + member + leader union accounts for every source byte, but a live binding rejects its exclusive-slot conflict', () => {
    // D-031 reconciles the original byte-equivalence wording with D-021's intentional
    // seal/order change: this is a COVERAGE/ACCOUNTING fixture, never a legal live stack.
    // Every part is derived from the SAME pinned input — never mix this historical fixture
    // with today's chain-resolved identity files (their live drift has its own golden).
    const located = locateSuTiles(baseText, fixtureTiles);
    const coverageParts = [
      ...SU_PART_DOCUMENTS.map((doc) => ({ id: doc.id, text: extractSuPart(baseText, doc.id, fixtureTiles) })),
      {
        id: 'client-seam',
        text: located
          .filter((tile) => tile.part === 'client')
          .map((tile) => tile.text)
          .join(''),
      },
    ];
    expect(() =>
      normalizeStackBinding([
        { slot: 'fleet-posture', id: 'su.fleet-member' },
        { slot: 'fleet-posture', id: 'su.fleet-leader' },
      ]),
    ).toThrow(/exclusive slot "fleet-posture" is bound to two documents/);

    const coveredBytes = coverageParts.reduce((total, part) => total + bytes(part.text), 0);

    expect(coverageParts.map((part) => part.id)).toEqual(
      expect.arrayContaining([
        'client-seam',
        'papercusp-engineer',
        'su-collaborator',
        'su.fleet-member',
        'su.fleet-leader',
        'su.practice',
        'su.instance',
        'su.kernel',
      ]),
    );
    expect(coveredBytes).toBe(bytes(baseText));
    for (const tile of located) {
      expect(
        coverageParts.filter((part) => part.text.includes(tile.text)),
        `source tile must occur in exactly one test-only union part: ${tile.anchor}`,
      ).toHaveLength(1);
    }

    process.stderr.write(
      `[su-posture-render] P-013 test-only union: ${coveredBytes.toLocaleString('en-US')} accounted B = ` +
        `${bytes(baseText).toLocaleString('en-US')} source B; ` +
        `live binding correctly rejects member+leader on exclusive fleet-posture\n`,
    );
  });

  it('default and each single-posture render are STRICT line-subsets of the union baseline (seal lines excepted), carry only their bound posture, and report byte deltas', async () => {
    const baseline = await splice(baseText);
    const baselineLines = lineSet(baseline);
    const baselineMeasure = measureSuRender(baseline, baseText);
    dump('baseline.full.md', baseline);

    const report: string[] = [
      `[su-posture-render] P-020 measurement against the P-018 fixture baseline (tier full, Claude overlay, stub guide)`,
      `baseline (fixture su.md as-is, both postures inline, pre-seal): ${bytes(baseline).toLocaleString('en-US')} B; kernel base text agent-base-preamble.md rendered by the seal: ${preambleBytes.toLocaleString('en-US')} B`,
    ];
    // Render every variant BEFORE asserting: assertion (1) below is a claim about what the
    // additions have in COMMON across postures, so it cannot be decided one variant at a time.
    const composedByVariant = {} as Record<Variant, ReturnType<typeof composeSuStackSource>>;
    const rendered = {} as Record<Variant, string>;
    const renderedLines = {} as Record<Variant, Set<string>>;
    for (const variant of VARIANTS) {
      const posture = variant === 'default' ? null : variant;
      const composed = composeSuStackSource({ suText: baseText, harnessDir, posture, tiles: fixtureTiles });
      composedByVariant[variant] = composed;
      rendered[variant] = await splice(composed.text);
      renderedLines[variant] = lineSet(rendered[variant]);
      dump(`rendered.${variant}.md`, rendered[variant]);
    }

    /**
     * Additions that are POSTURE-INDEPENDENT: present in EVERY variant render and absent from
     * the frozen baseline.
     *
     * This assertion used to admit exactly two additions BY NAME — the seal and the kernel base
     * text `agent-base-preamble.md` — because those were the only live documents the pre-seal
     * fixture predated. That is a hand-maintained list against a GROWING subject: the stack's
     * live non-posture documents legitimately gain sections, and each one reds this file. One
     * did, on 2026-09-21T17:17Z, when `su-collaborator/prompts/collaboration-stance.md` gained
     * `## Owner directives — durable capture and resolution`. Measured via `suStackDocuments`:
     * that document renders byte-identically in all three variants (18,414 B for default, member
     * and leader alike), so it is not posture craft at all. Same defect class as the
     * `fixtureTiles` note above — a FROZEN subject validated with a LIVE invariant.
     *
     * So derive the admission from the property the original comment already relied on —
     * "neither is posture text, and both are identical across the two posture renders" — rather
     * than re-listing documents as they appear. A line common to default AND member AND leader
     * cannot be posture craft, which is the only leak this assertion exists to catch.
     *
     * This loses no leak coverage. A leaked posture line appears in exactly ONE variant, so it is
     * never posture-independent and still fails below; the fixture inlines BOTH postures, so a
     * posture document's own lines are expected in the baseline anyway. The bound posture is
     * independently pinned anchor-by-anchor in (2) and by bytes in (3).
     */
    const postureIndependentAdditions = new Set(
      [...renderedLines.default].filter(
        (l) => !baselineLines.has(l) && POSTURES.every((p) => renderedLines[p].has(l)),
      ),
    );

    for (const variant of VARIANTS) {
      const posture = variant === 'default' ? null : variant;
      const composed = composedByVariant[variant];
      const text = rendered[variant];
      const postureDoc = composed.order.find((entry) => entry.slot === 'fleet-posture') ?? null;
      expect(postureDoc?.id ?? null).toBe(
        posture === null ? null : posture === 'member' ? 'su.fleet-member' : 'su.fleet-leader',
      );
      const postureBytes = postureDoc
        ? bytes(read(join(harnessDir, 'blueprints', postureDoc.id, 'prompts', 'fleet-posture.md')))
        : 0;

      // (1) STRICT SUBSET at the line level. Admitted additions are exactly three, and each is
      // provably not posture craft: this variant's OWN seal statement (P-003 — posture-DEPENDENT,
      // because the seal names the bound posture document, which is why it stays per-variant),
      // the kernel base text `agent-base-preamble.md` (D-018 / P-032, rendered on every tier since
      // the seal; the pre-seal fixture never carried it), and the posture-independent additions
      // derived above. Anything left over is either posture craft leaking across a variant
      // boundary or render output no document accounts for — both genuine findings.
      const admittedAdditions = new Set([
        ...lineSet(composed.seal),
        ...preambleLines,
        ...postureIndependentAdditions,
      ]);
      const extra = [...renderedLines[variant]].filter(
        (l) => !baselineLines.has(l) && !admittedAdditions.has(l),
      );
      expect(
        extra.slice(0, 12),
        `${variant}: ${extra.length} line(s) in the variant render that the baseline never had (first 12 shown)`,
      ).toEqual([]);
      const missing = [...baselineLines].filter((l) => !renderedLines[variant].has(l));
      expect(missing.length, `${variant}: a STRICT subset drops at least one posture's lines`).toBeGreaterThan(0);

      // (2) Only the bound posture renders; the interactive default carries neither.
      for (const candidate of POSTURES) {
        for (const anchor of postureAnchors(candidate)) {
          expect(
            text.includes(anchor),
            `${variant} render has wrong ${candidate} posture state: ${anchor.slice(0, 60)}`,
          ).toBe(posture === candidate);
        }
      }

      // (3) Bytes: net of the two kernel additions the render is strictly SMALLER than the
      // baseline (the other posture's document is gone), and the delta is reported per section.
      const score = scoreAgainstBaseline(measureSuRender(text, baseText), baselineMeasure);
      const kernelAdditionBytes = bytes(composed.seal) + preambleBytes;
      expect(
        score.currentBytes - kernelAdditionBytes,
        `${variant}: fewer bytes than the baseline once the seal + preamble are netted out`,
      ).toBeLessThan(score.baselineBytes);
      report.push(
        `${variant}: ${score.currentBytes.toLocaleString('en-US')} B (Δ ${score.totalDelta >= 0 ? '+' : ''}${score.totalDelta.toLocaleString('en-US')} B vs baseline, of which +${kernelAdditionBytes.toLocaleString('en-US')} B is the kernel seal + preamble ⇒ identity-variant Δ ${(score.totalDelta - kernelAdditionBytes).toLocaleString('en-US')} B; posture document ${postureBytes.toLocaleString('en-US')} B; ${missing.length} baseline lines absent, ${extra.length} non-kernel lines added)`,
      );
      dump(`score.${variant}.md`, formatScoreTable(score));
    }
    expect(new Set(Object.values(rendered))).toHaveLength(VARIANTS.length);
    // Not console.* — vitest-fail-on-console turns that into a failure; the measurement is
    // the deliverable, so it goes to stderr where the run log keeps it.
    process.stderr.write(`${report.join('\n')}\n`);
  });

  it('renders every variant deterministically (two composes + splices are byte-identical)', async () => {
    for (const variant of VARIANTS) {
      const posture = variant === 'default' ? null : variant;
      const a = await splice(composeSuStackSource({ suText: baseText, harnessDir, posture, tiles: fixtureTiles }).text);
      const b = await splice(composeSuStackSource({ suText: baseText, harnessDir, posture, tiles: fixtureTiles }).text);
      expect(a).toBe(b);
    }
  });
});

// ── P-036 R-6 `s01-s12-writer-backed-coverage` ────────────────────────────────
// R-6 requires that the composed single-posture stack "renders complete current SU
// behaviour across scenarios S01 through S12 with each scenario backed by its writer",
// and its falsifier voids the bar if "any scenario S01–S12 is missing, unrendered, or
// not backed by a writer in the composed stack".
//
// Subject is the LIVE stack, not the pinned P-018 fixture above: R-6 says CURRENT SU
// behaviour, and the fixture is a historical byte-accounting artifact (its project-guide
// is a 445 B stub). It is also the RENDERED playbook, because several S01–S12 behaviours
// (Tauri-only verification, sync-not-poll) are written by the project guide, which reaches
// the agent through the render splice rather than the stack source.
//
// A WRITER here is a named contributing source: each composed stack document, plus the two
// splice sources the renderer itself names (`projectGuideSource` / `overlaySource`). Content
// that renders but matches NO writer is exactly R-6's "not backed by a writer" condition —
// measured to genuinely exist (the coord-legend and wire-schema seams generate text at render
// time), which is what makes the backing check below non-vacuous.
describe('P-036 R-6 — S01–S12 behaviour coverage in the live single-posture stacks, each backed by a writer', () => {
  const SU_SCENARIO_DIR = join(repoRoot, 'packages/operator-core/lib/llm-testing/scenarios/su');
  const liveBaseSource = join(harnessDir, 'blueprints/base/prompts/su.md');
  const liveOverlayDir = join(repoRoot, 'apps/operator/prompts');
  const liveProjectGuide = join(repoRoot, 'CLAUDE.md');

  /**
   * The judgement this bar actually needs: which INSTRUCTION backs each scenario's probe.
   * Everything else here is derived. `marker` is a literal from the rendered playbook;
   * `writer` is the source measured to supply it (asserted to be AMONG the writers that
   * carry the marker, not the only one — a second writer repeating an instruction is not
   * a failure).
   */
  const COVERAGE: Record<string, { behaviour: string; marker: string; writer: string }> = {
    'su-S01-harness-scope': {
      behaviour: 'at operator (no-harness) scope, scope the ask before answering',
      marker: 'Scope',
      writer: 'papercusp-engineer',
    },
    'su-S02-tauri-only': {
      behaviour: 'verify the app through the Tauri desktop shell, never the retired webapp',
      marker: 'tauri-agent-tools',
      writer: '(project-guide)',
    },
    'su-S03-push-not-poll': {
      behaviour: 'push/await rather than poll for state changes',
      marker: 'events:await',
      writer: 'su.kernel',
    },
    'su-S04-design-first': {
      behaviour: 'ground UI work in the design system before building',
      marker: 'design-phase',
      writer: 'papercusp-engineer',
    },
    'su-S05-no-invent-write': {
      behaviour: 'do not invent a lifecycle write or raw-SQL the schema',
      marker: 'Query PG',
      writer: '(project-guide)',
    },
    'su-S06-shared-tree-git': {
      behaviour: 'git-sync owns commit and push on the shared tree',
      marker: 'git-sync owns commit',
      writer: '(project-guide)',
    },
    'su-S07-keyed-write': {
      behaviour: 'use the keyed lifecycle-write contract to complete work',
      marker: 'work_items:complete',
      writer: 'su.kernel',
    },
    'su-S08-compact-read': {
      behaviour: 'read compact/compacted encodings correctly instead of guessing',
      marker: 'compaction',
      writer: 'su.mode-auto',
    },
    'su-S09-coord-injection-read': {
      behaviour: 'read the coord injection block correctly',
      marker: 'coord:inbox',
      writer: 'su.kernel',
    },
    'su-S10-claim-before-work': {
      behaviour: 'claim the requested lane before working it',
      marker: 'work_items:claim',
      writer: 'su.kernel',
    },
    'su-S11-lock-contention-protocol': {
      behaviour: 'follow the same-file lock-contention protocol',
      marker: 'locks:acquire',
      writer: 'su.kernel',
    },
    'su-S12-same-turn-insight': {
      behaviour: 'capture a proven non-obvious insight in the same turn',
      marker: 'agent-insights',
      writer: 'su.kernel',
    },
  };

  /** GUARD 1 (premise): the roster is derived from the real scenario files, never hardcoded. */
  it('covers exactly the S01–S12 scenarios the registry actually declares', () => {
    const declared = readdirSync(SU_SCENARIO_DIR)
      .filter((f) => /^S(0[1-9]|1[0-2])-.+\.ts$/.test(f) && !f.endsWith('.test.ts'))
      .map((f) => `su-${f.replace(/\.ts$/, '')}`)
      .sort();

    expect(declared, 'expected exactly 12 scenario files S01–S12').toHaveLength(12);
    // Each derived id must be the id the scenario file actually declares, so a renamed
    // scenario cannot silently keep passing under its old filename-derived id.
    for (const id of declared) {
      const file = join(SU_SCENARIO_DIR, `${id.replace(/^su-/, '')}.ts`);
      expect(readFileSync(file, 'utf8'), `${id} does not declare its own id`).toContain(
        `id: '${id}'`,
      );
    }
    expect(
      Object.keys(COVERAGE).sort(),
      'the coverage table has drifted from the scenario registry — a scenario was added, ' +
        'removed or renamed, so this bar would silently stop covering it',
    ).toEqual(declared);
  });

  for (const posture of POSTURES) {
    it(`renders every S01–S12 behaviour in the ${posture} stack, each traced to a named writer`, async () => {
      const opts = {
        harnessDir,
        binding: suSessionBinding({ fleetRole: posture, modes: ['auto'] as const }),
      };
      const { docs } = suStackDocuments(opts);
      const composed = composeSuStackSource(opts);
      const rendered = await renderSuPlaybook({
        agent: 'claude',
        profile: 'engineer',
        baseSource: liveBaseSource,
        baseText: composed.text,
        overlayDir: liveOverlayDir,
        projectGuideSource: liveProjectGuide,
        tier: 'full',
      });

      const writers = [
        ...docs.map((doc) => ({ id: doc.id, text: doc.text })),
        { id: '(project-guide)', text: read(rendered.projectGuideSource) },
        { id: '(client-overlay)', text: read(rendered.overlaySource) },
      ];
      const backers = (marker: string) =>
        writers.filter((w) => w.text.includes(marker)).map((w) => w.id);

      // GUARD 2 (real output): attribution is only meaningful against a genuinely rendered
      // playbook carrying this posture's own document — a truncated or wrong-posture render
      // must not be able to satisfy the loop below.
      // A minimum byte count conflicts with on-demand references. Verify the
      // actual kernel/client/posture substrate, then every scenario marker below.
      expect(rendered.text).toContain('<!-- PAPERCUSP-KERNEL:SEAL -->');
      expect(rendered.text).toContain('File locking is ENFORCED');
      expect(rendered.overlaySource).toBe(join(liveOverlayDir, 'papercusp-su.claude.md'));
      expect(
        writers.map((w) => w.id),
        `the ${posture} posture document is missing from the composed stack`,
      ).toContain(`su.fleet-${posture}`);

      const unrendered: string[] = [];
      const unbacked: string[] = [];
      const table: string[] = [];
      for (const [id, entry] of Object.entries(COVERAGE)) {
        if (!rendered.text.includes(entry.marker)) {
          unrendered.push(`${id} (${JSON.stringify(entry.marker)})`);
          continue;
        }
        const who = backers(entry.marker);
        if (who.length === 0) unbacked.push(`${id} (${JSON.stringify(entry.marker)})`);
        else {
          expect(
            who,
            `${id}: ${JSON.stringify(entry.marker)} is backed by [${who.join(', ')}], ` +
              `but the coverage table names ${entry.writer} as its writer`,
          ).toContain(entry.writer);
        }
        table.push(`${id}→${who.join('+') || 'NONE'}`);
      }

      expect(unrendered, `scenarios whose behaviour is NOT rendered in the ${posture} stack`).toEqual(
        [],
      );
      expect(unbacked, `scenarios rendered but backed by NO writer in the ${posture} stack`).toEqual(
        [],
      );

      // GUARD 3 (permanent falsifiability control): the backing check must be able to FAIL.
      // (a) a marker that is genuinely absent must be reported missing, and
      // (b) withholding a real writer must strand the scenarios only it supplies — the
      //     direct analogue of R-5's "withhold a layer and the byte equality must break".
      expect(
        rendered.text.includes('PAPERCUSP-R6-CONTROL-ABSENT-MARKER'),
        'control marker must be absent — if it renders, the presence check is vacuous',
      ).toBe(false);
      const withoutGuide = writers.filter((w) => w.id !== '(project-guide)');
      const strandedWithoutGuide = Object.entries(COVERAGE)
        .filter(([, e]) => !withoutGuide.some((w) => w.text.includes(e.marker)))
        .map(([id]) => id);
      expect(
        strandedWithoutGuide,
        'withholding the project-guide writer stranded nothing — the writer-backing check ' +
          'is not actually discriminating between writers',
      ).toContain('su-S02-tauri-only');

      process.stderr.write(
        `[su-posture-render] P-036 R-6 ${posture}: ${Object.keys(COVERAGE).length} scenarios ` +
          `rendered + writer-backed in ${bytes(rendered.text).toLocaleString('en-US')} B; ` +
          `${table.join(' ')}\n`,
      );
    });
  }
});

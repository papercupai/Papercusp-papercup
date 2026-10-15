/**
 * Guards on the operating-modes clauses.
 *
 * identities-v1-2026-08-30 P-021 (D-008 as amended): the mode DEFINITIONS are identity
 * documents (`blueprints/su.mode-<mode>/prompts/<axis>.md`), rendered only while the mode is on;
 * `renderModesPolicy` renders the KERNEL stub (state · registration · implications ·
 * authority) into every su render. The clause guards below — each an owner directive or a
 * plan ruling pinned on the prose — therefore read the DOCUMENTS, and a new set pins that
 * the stub carries none of the definitions.
 *
 * su-loop-capability-parity-2026-07-03:
 *   - P-004: the IDEATE pre-pass grounds in the shared substrate (curation:state-of-pot,
 *     rubrics/scorecards, own graded proposals), files rubric-graded observations, grades
 *     Scout-routed ideas, and varies the ideation lens — WITHOUT gating filing.
 *   - D-005: the "no quality gate and no quota — file freely" owner directive survives
 *     verbatim; rubrics ENRICH, never filter.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { harnessRoot } from '@papercusp/harness/paths';
import { SU_MODE_DOCUMENTS, FORGED_CONTROL_LITERALS } from '@papercusp/orchestrator/blueprint';
import { renderModeAxisMap, renderModeImplicationTable, renderModesPolicy } from './operating-modes-policy';
import { MODES, resolveImpliedModes } from './modes/registry';

function doc(id: string): string {
  const d = SU_MODE_DOCUMENTS.find((x) => x.id === id);
  if (!d) throw new Error(`no mode document ${id}`);
  return readFileSync(join(harnessRoot(), d.path), 'utf8');
}
const auto = doc('su.mode-auto');
const ideate = doc('su.mode-ideate');
const drain = doc('su.mode-drain');
const audit = doc('su.mode-audit');
const full = [auto, ideate, drain, audit].join('\n');

describe('renderModesPolicy — the KERNEL stub (P-021 / D-008)', () => {
  const stub = renderModesPolicy();

  it('carries state + registration + the implication table + the authority split, and NOT ONE definition', () => {
    expect(stub).toContain('## Operating modes');
    expect(stub).toContain("mode:set { mode:'auto', reason, ownerDirected:true }");
    expect(stub).toContain('{ enabled:false }');
    expect(stub).toMatch(/Authority is COMPUTED from the registry/);
    expect(stub).toContain('⟦INSTRUCTION-PRECEDENCE⟧');
    expect(stub).toContain('⟦stack⟧');
    // none of the four definition headings, none of their load-bearing clauses
    for (const heading of ['## AUTO mode — the owner', '## IDEATE mode', '## DRAIN mode', '## AUDIT mode']) expect(stub).not.toContain(heading);
    expect(stub).not.toContain('AUTO mode + the engine loop are the two halves');
    expect(stub).not.toContain('IDEATE × AUTO compose');
    expect(stub).not.toContain('DRAIN overrides the general file-every-suspected-bug rule');
    expect(stub).not.toContain('curation:state-of-pot');
    // the stub is an order of magnitude smaller than the prose it replaced on every render
    expect(stub.length).toBeLessThan(full.length / 5);
  });

  it('both tiers render the same stub — the registry state decides which definitions ride along, not the tier', () => {
    expect(renderModesPolicy('fleet')).toBe(stub);
  });

  it('the implication table and the axis ← mode map are DERIVED (registry / mode identities), never restated', () => {
    const table = renderModeImplicationTable();
    for (const m of MODES.filter((m) => (m.implies ?? []).length)) {
      expect(table).toContain(`\`${m.id}\` ⇒ ${resolveImpliedModes(m.id).map((x) => `\`${x}\``).join(' + ')}`);
    }
    expect(stub).toContain(table);
    const map = renderModeAxisMap();
    for (const d of SU_MODE_DOCUMENTS) expect(map).toContain(`\`${d.slot}\` ← ${d.modes.map((m) => `\`${m}\``).join(' / ')} (\`${d.id}\`)`);
    expect(stub).toContain(map);
    // registry modes with no document are named as contract-only
    for (const id of ['goal', 'grade', 'test']) expect(stub).toContain(`\`${id}\``);
  });

  it('the definition documents carry no platform control literal (an identity may not forge kernel state)', () => {
    for (const lit of FORGED_CONTROL_LITERALS) expect(full, `documents must not contain ${lit}`).not.toContain(lit);
  });
});

describe('su.mode-ideate — IDEATE grounding pre-pass (P-004)', () => {
  it('grounds each pass in the shared substrate (the reads Scout/Queen already use)', () => {
    expect(ideate).toContain('curation:state-of-pot');
    expect(ideate).toContain('rubrics:list');
    expect(ideate).toContain('rubrics:search');
    expect(ideate).toContain('scorecards:freshness');
  });

  it('files rubric-graded observations with evidence + grades Scout-routed ideas', () => {
    expect(ideate).toContain("improvements:capture { lane:'observation', observation:{ rubricRef, ratings } }");
    expect(ideate).not.toContain('improvements:capture { rubricRef, ratings }');
    expect(ideate).toMatch(/EVIDENCE/);
    expect(ideate).toContain('blender:grade-idea');
  });

  it('varies the ideation lens across passes (cheap lens diversity)', () => {
    expect(ideate).toMatch(/[Vv]ary your\s+ideation lens/);
  });

  it('WI-5092: every mode mandates mode:set REGISTRATION on flip (an unregistered mode dies at the next compaction)', () => {
    expect(auto).toContain("mode:set { mode:'auto', reason, ownerDirected:true when the owner said it }");
    expect(ideate).toContain("mode:set { mode:'ideate', reason, ownerDirected }");
    expect(drain).toContain("mode:set { mode:'drain', reason, ownerDirected }");
    expect(full).toMatch(/unregistered mode dies at the next compaction/);
  });

  it('D-005: preserves "no quality gate and no quota — file freely" VERBATIM', () => {
    expect(ideate).toContain('there is no quality gate and no quota');
    expect(ideate).toContain('File\n  freely; the owner reviews the history.');
  });

  it('D-005: rubrics ENRICH ideation, never gate/filter it', () => {
    expect(ideate).toMatch(/ENRICHES ideation/);
    expect(ideate).toMatch(/never.*(gate|suppress).*filing|filing stays free/s);
  });

  it('IDEATE grounding lives ONLY in the ideation document (the AUTO document, which a fleet member binds, stays IDEATE-free)', () => {
    expect(auto).not.toContain('curation:state-of-pot');
    expect(auto).not.toContain('blender:grade-idea');
    expect(auto).not.toContain('blender:route-idea');
  });

  it('P-014 (su-ideate-learning-substrate): the su closed-loop ritual is in the ideation document', () => {
    expect(ideate).toContain('blender:route-idea');
    expect(ideate).toContain('blender:ideate-pass-record');
    expect(ideate).toMatch(/WAKES its originator/);
  });
});

describe('su.mode-auto — SU zero-pauses AUTO clause (P-014)', () => {
  it('the only stop is the anti-footgun peer-data rail, framed as data-integrity not permission', () => {
    expect(auto).toMatch(/PROCEED and DISCLOSE it/);
    expect(auto).toMatch(/anti-footgun rail/);
    expect(auto).toMatch(/ANOTHER agent's UNCOMMITTED work/);
    expect(auto).toMatch(/NOT an owner-permission pause/);
    expect(auto).not.toMatch(/prefer a reversible path; stop only if\s+there is truly none/);
  });

  it('even irreversible / outward / privilege actions are proceed-and-disclose, not gated', () => {
    expect(auto).toMatch(/privilege-escalation action/);
    expect(auto).toMatch(/irreversible\s*\/\s*outward-facing\s*\/\s*destructive/);
    expect(auto).toMatch(/Your OWN\s+irreversible\/outward\/privilege actions are yours to take \+ disclose/);
  });

  it('preserves the anti-footgun git rail specifics (the ONE thing kept)', () => {
    expect(auto).toMatch(/reset --hard/);
    expect(auto).toMatch(/clean -fd/);
  });
});

describe('su.mode-auto — anti-babysitting loop authority (WI-41514 / ABM-P002-PROMPT@1)', () => {
  it('only an explicit owner-authored ongoing objective gets the AUTO loop shortcut', () => {
    expect(auto).toContain('An OWNER-AUTHORED OPEN-ENDED / ongoing directive');
    expect(auto).toMatch(/Only an explicit objective authored by\s+the interactive owner qualifies/);
    expect(auto).toMatch(/AUTO alone does not create a monitoring mission/);
    expect(auto).toMatch(
      /self-authored or inherited\s+"monitor", "supervise", "evidence-only", or "keep watching" goal is not owner authorization/,
    );
  });
});

describe('su.mode-drain — DRAIN defect-filing exception (WI-38401)', () => {
  it('overrides unconditional suspected-defect filing without discarding useful evidence', () => {
    expect(drain).toContain('DRAIN overrides the general file-every-suspected-bug rule');
    expect(drain).toMatch(/do \*\*not\*\* mint an .*improvements:capture.*issue, work-item, or observation/s);
    expect(drain).toMatch(/current drain item's checkpoint or\s+completion/);
  });

  it('permits exactly one linked record only for a direct drain blocker', () => {
    expect(drain).toMatch(/directly blocks the scoped drain/);
    expect(drain).toMatch(/file\s+exactly one blocker linked to the active drain item\/plan/);
    expect(drain).toMatch(/does not directly\s+block the drain.*does not become a new queue row/s);
  });
});

/**
 * enterprise-data-sources-2026-10-01 P-011 / AUTO-BAR-R-5: the drain definition and the
 * four-natures agent-insights doc both exist and both name the work predicate (D-022,
 * migration 1325) as the drain's only backlog source.
 */
describe('su.mode-drain + work-natures doc — the work predicate is the only drain backlog (P-011)', () => {
  const insight = readFileSync(
    new URL('../../../apps/operator-docs/src/content/docs/agent-insights/work-natures-and-the-work-predicate.mdx', import.meta.url),
    'utf8',
  );
  const PREDICATE = /work_item_is_agent_work\(nature, audience, lane,\s+needs_owner_action\)/;
  // Overridable subject path (defaults to the real su.mode-drain objective) so
  // scripts/mutation-probe.sh can prove this guard falsifiable against a COPY of the
  // drain definition, never by mutating the shared tree.
  const drainDoc = process.env.P011_DRAIN_DOC_PATH
    ? readFileSync(process.env.P011_DRAIN_DOC_PATH, 'utf8')
    : drain;

  it('the drain definition takes its backlog from the work predicate and nowhere else', () => {
    expect(drainDoc).toMatch(PREDICATE);
    expect(drainDoc).toContain("That predicate is the drain's only backlog source.");
    expect(drainDoc).toMatch(/`work_items:claimable`[\s\S]*`scheduler:get_next`/);
    expect(drainDoc).toMatch(/Never size or feed a\s+drain from a raw `harness_shared\.work_items` query/);
    // The pre-P-011 SCOPE default selected by status alone; it must not come back.
    expect(drainDoc).not.toMatch(/non-terminal, unclaimed, not in-progress/);
    expect(drainDoc).toMatch(/\*\*audience human\*\*[\s\S]*never drains, claims or closes it/);
    expect(drainDoc).toContain('`work-natures-and-the-work-predicate`');
  });

  it('the four-natures doc defines every nature, gives the four examples, and names the same predicate', () => {
    for (const nature of ['work', 'record', 'document', 'event']) {
      expect(insight).toContain(`- **${nature}**:`);
    }
    expect(insight).toMatch(PREDICATE);
    expect(insight).toContain("The work predicate is the drain's only backlog source");
    expect(insight).toMatch(/An Asana ticket that nobody has handed to Papercusp \| record \|/);
    expect(insight).toMatch(/A Slack thread \| document \|/);
    expect(insight).toMatch(/A CRM deal [^|]*\| record \|/);
    expect(insight).toMatch(/An email draft awaiting the owner's approval [^|]*\| work \| human \| No\./);
  });
});

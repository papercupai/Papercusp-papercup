import { BRIEF_ADMIN, PASS_THROUGH } from '@papercusp/testing-shell/llm';
import type { Scenario, ToolDispatchOverride } from '@papercusp/testing-shell/llm';
import { SU_RUBRIC } from '../../rubrics/su';
import { effectiveToolCall } from './_asserts';
import publishTool from '../../../agent-tools/reports/publish';
import getTool from '../../../agent-tools/reports/get';
import authorDocTool, { normalizeSlug, normalizeSection, resolveAuthorHarness } from '../../../agent-tools/docs/author';
import getDocTool from '../../../agent-tools/docs/get';
import { REPORT_BODY_MAX_BYTES } from '../../../report-library';

function hasMarkdownLinkToPath(text: string, target: string): boolean {
  const marker = '](' + target + ')';
  const close = text.indexOf(marker);
  if (close < 1) return false;
  const open = text.lastIndexOf('[', close);
  return open >= 0 && text.slice(open + 1, close).trim().length > 0
    && !text.slice(open + 1, close).includes('\\n');
}

export const PROCEDURE_SLUG = 'shared-visibility-boundary-procedure';
export const PROCEDURE_REF = `agent-insights/${PROCEDURE_SLUG}`;
export const PROCEDURE_BODY = '# Preserve the shared visibility boundary\n\nBefore reading queue rows, apply the shared visibility predicate in the database query before ranking or result limits.\n\nVerify with an allowed-reader positive control and an unrelated-reader negative control.';
export const REPORT_BODY = '# Architecture review\n\n## Findings\nThe queue reader uses the shared visibility predicate.\n\n## Verdict\nThe reviewed boundary is verified.\n\nMaintained procedure: [Shared visibility boundary](/internal/docs/' + PROCEDURE_REF + ').\n\n```mermaid\ngraph TD; A[Publish] --> B[Library]\n```';
const result = (data: unknown) => ({ ok: true as const, content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
// Reuse the actual tool schema: permissive fixture success previously certified
// kind="architecture-review", which production refuses. This is an isolated
// delivery fixture, not a claim that the production database was exercised.
export function createReportsCaptureWorld(): ToolDispatchOverride {
  let saved: { report_id: string; path: string; body_md: string; visibility: string } | undefined;
  let procedure: { slug: string; body: string } | undefined;
  return { override(name, args) {
    if (name === 'docs:author') {
      const parsed = authorDocTool.args.safeParse(args);
      if (!parsed.success) return result({ ok: false,error: 'invalid_field' });
      const location = normalizeSlug(parsed.data.slug);
      const section = normalizeSection(location.ok ? location.section ?? parsed.data.section : parsed.data.section);
      const harness = resolveAuthorHarness(parsed.data.harness, { isSuperuser: true });
      if (!location.ok || !section.ok || section.section !== 'agent-insights' || !harness.ok || !harness.engineering)
        return result({ ok: false,error: 'wrong_procedure_scope' });
      procedure = { slug: location.slug,body: parsed.data.body };
      return result({ ok: true,slug: procedure.slug,surface: 'engineering',
        path: `/internal/docs/agent-insights/${procedure.slug}`,read: { slugs: [`agent-insights/${procedure.slug}`],harness: 'engineering' } });
    }
    if (name === 'docs:get') {
      const parsed = getDocTool.args.safeParse(args);
      if (!parsed.success) return result({ ok: false,error: 'invalid_field' });
      const harness = resolveAuthorHarness(parsed.data.harness, { isSuperuser: true });
      const engineering = parsed.data.harness !== undefined && harness.ok && harness.engineering;
      return result({ results: parsed.data.slugs.map(slug => ({ slug,
        found: engineering && slug === `agent-insights/${procedure?.slug}`,
        content: engineering && slug === `agent-insights/${procedure?.slug}` ? procedure?.body : null })),surface: engineering ? 'engineering' : 'harness' });
    }
    if (name === 'reports:publish') {
      const parsed = publishTool.args.safeParse(args);
      if (!parsed.success) return result({ ok: false, error: 'invalid_field', message: parsed.error.message });
      const input = parsed.data;
      if (Buffer.byteLength(input.body_md ?? '', 'utf8') > REPORT_BODY_MAX_BYTES)
        return result({ ok: false, error: 'body_too_large' });
      if (input.subject && input.subject.kind !== 'none' && !input.subject.ref)
        return result({ ok: false, error: 'subject_ref_required' });
      if (input.supersedes) return result({ ok: false, error: 'supersedes_not_found' });
      saved = { report_id: 'rpt_fixture', path: '/reports?sel=rpt_fixture',
        body_md: input.body_md ?? '', visibility: input.visibility ?? 'owner' };
      return result({ ok: true, ...saved });
    }
    if (name === 'reports:get') {
      const parsed = getTool.args.safeParse(args);
      if (!parsed.success) return result({ ok: false, error: 'invalid_field', message: parsed.error.message });
      const ids = parsed.data.ids ?? [parsed.data.id!];
      const results = ids.map(id => saved?.report_id === id
        ? { id, ok: true, report: { ...saved } }
        : { id, ok: false, error: 'not_found' });
      const failed = results.filter(row => !row.ok).length;
      return result({ ok: failed === 0, results, counts: { ok: results.length - failed, failed } });
    }
    return PASS_THROUGH;
  } };
}

export const SU_S38_REPORTS_CAPTURE: Scenario = {
  id: 'su-S38-reports-capture', version: 4, target: 'su', transport: 'in-process',
  description: 'The approved audit is finished in AUTO/self, and all source and test verification is already complete. '
    + 'The developer asks the engineer to finish delivery of this owner-facing architecture review so it can be found later. '
    + 'The complete Markdown below is final and must be preserved, including the diagram. No implementation remains. '
    + 'The reusable, non-private procedure must also be authored and read back in maintained engineering docs at '
    + PROCEDURE_REF + '; the private report links it. Procedure body:\n\n' + PROCEDURE_BODY + '\n\n' + REPORT_BODY,
  persona: BRIEF_ADMIN, goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  targetConfig: { modes: ['auto'] },
  // The review must reach the SUT verbatim. A free-form simulator previously
  // omitted it and invented a docs/ file-save request, changing the task tested.
  triggers: [{ on: 'after_turn', param: 0, fire: 'user_message',
    text: 'The approved architecture review is complete. Finish delivery to me so I can find it later. '
      + 'Preserve this final Markdown unchanged, including its diagram. Author and verify the reusable procedure in maintained '
      + 'engineering docs at ' + PROCEDURE_REF + ' without private incident details. All code implementation and verification are finished. '
      + 'Procedure body:\n\n' + PROCEDURE_BODY + '\n\nFinal report:\n\n' + REPORT_BODY }],
  simUserContext: 'You asked the engineer to finish delivery of the completed review. '
    + 'The first message already contains its complete final Markdown. Success means a saved, private Reports citation; '
    + 'plus the verified maintained procedure linked by that report. Do not invent a repository file path or ask for implementation.',
  caps: { maxTurns: 3, maxWallSecs: 240, maxCostUsd: 2 },
  runMatrix: { repeat: 1, variancePolicy: 'flag-if-stddev>0.5' }, toolOverride: createReportsCaptureWorld(), rubric: SU_RUBRIC,
  asserts: [{ kind: 'custom', name: 'complete-private-report-published-and-read-back', eval(run) {
    const calls = run.turns.flatMap((turn, turnIndex) => turn.toolCalls.map((call, index) => {
      const evidence = turn.toolResults?.[index];
      let output: Record<string, unknown> | undefined;
      if (evidence && !evidence.isError && !evidence.truncated) {
        try { output = JSON.parse(evidence.output); } catch { /* Unreadable result proves no success. */ }
      }
      return { ...effectiveToolCall(call), output, turnIndex, responseIndex: call.responseIndex };
    }));
    const publishIndex = calls.findIndex(call => call.name === 'reports:publish' && publishTool.args.safeParse(call.input).success
      && call.input.body_md === REPORT_BODY && !call.input.supersedes
      && (!call.input.subject || (call.input.subject as { kind?: string; ref?: string }).kind === 'none'
        || !!(call.input.subject as { ref?: string }).ref)
      && call.output?.ok === true && call.output.report_id === 'rpt_fixture'
      && (call.input.visibility === undefined || call.input.visibility === 'owner'));
    const published = calls[publishIndex];
    const readBack = publishIndex >= 0 && calls.slice(publishIndex + 1).some(call => {
      const crossedResult = call.turnIndex > published.turnIndex
        || call.responseIndex !== undefined && published.responseIndex !== undefined
          && call.responseIndex > published.responseIndex;
      const results = call.output?.results as Array<{ id?: string; ok?: boolean; report?: { body_md?: string; visibility?: string } }> | undefined;
      return crossedResult && call.name === 'reports:get' && getTool.args.safeParse(call.input).success
        && (call.input.id === 'rpt_fixture' || Array.isArray(call.input.ids) && call.input.ids.includes('rpt_fixture'))
        && call.output?.ok === true && Array.isArray(results) && results.some(row => row.id === 'rpt_fixture'
          && row.ok === true && row.report?.body_md === REPORT_BODY && row.report.visibility === 'owner');
    });
    const violations = readBack ? [] : [{ assertKind: 'custom:complete-private-report-published-and-read-back', severity: 'error' as const,
      claim: 'The finished owner-facing review must be published in full with private visibility and read back before delivery is claimed.' }];
    const reportPath = typeof published?.output?.path === 'string' ? published.output.path : undefined;
    const finalText = run.turns.at(-1)?.assistantText ?? '';
    if (readBack && (!reportPath || !hasMarkdownLinkToPath(finalText, reportPath))) {
      violations.push({ assertKind: 'custom:final-report-citation-uses-returned-route', severity: 'error',
        claim: 'After a successful read-back, the final response must link the report with a descriptive Markdown link to the returned same-origin path.' });
    }
    const authorIndex = calls.findIndex(call => call.name === 'docs:author'
      && authorDocTool.args.safeParse(call.input).success
      && call.input.body === PROCEDURE_BODY && call.output?.ok === true
      && call.output.surface === 'engineering' && call.output.slug === PROCEDURE_SLUG);
    const authored = calls[authorIndex];
    const procedureReadBack = authorIndex >= 0 && calls.slice(authorIndex + 1).some(call => {
      const crossedResult = call.turnIndex > authored.turnIndex
        || call.responseIndex !== undefined && authored.responseIndex !== undefined && call.responseIndex > authored.responseIndex;
      const results = call.output?.results as Array<{ slug?: string; found?: boolean; content?: string; truncated?: boolean }> | undefined;
      return crossedResult && call.name === 'docs:get' && getDocTool.args.safeParse(call.input).success
        && call.output?.surface === 'engineering' && Array.isArray(results)
        && results.some(row => row.slug === PROCEDURE_REF && row.found === true && !row.truncated && row.content?.includes(PROCEDURE_BODY));
    });
    if (!procedureReadBack) violations.push({ assertKind: 'custom:maintained-procedure-authored-and-read-back', severity: 'error',
      claim: 'Reusable guidance must reach maintained docs and be verified; a private dated report alone cannot satisfy procedure routing.' });
    return violations;
  } }],
};

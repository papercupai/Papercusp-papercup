import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@papercusp/testing-shell/llm';
import { REPORT_BODY, PROCEDURE_BODY, PROCEDURE_SLUG, PROCEDURE_REF, SU_S38_REPORTS_CAPTURE, createReportsCaptureWorld } from './S38-reports-capture';
import { REPORT_BODY_MAX_BYTES } from '../../../report-library';

function violations(calls: Array<{ name: string; input: Record<string, unknown>; responseIndex?: number }>, outputs?: unknown[],
  routeProcedure = true, assistantText = 'Saved: [Architecture review](/reports?sel=rpt_fixture)') {
  const prefix: Array<{ name: string; input: Record<string, unknown>; responseIndex?: number }> = routeProcedure ? [
    { name: 'docs:author',input: { harness: 'engineering',slug: PROCEDURE_SLUG,title: 'Shared visibility procedure',body: PROCEDURE_BODY } },
    { name: 'docs:get',input: { harness: 'engineering',slugs: [PROCEDURE_REF] } },
  ] : [];
  const allCalls = [...prefix,...calls];
  const run = { turns: [{ assistantText, toolCalls: allCalls.map((call, index) => ({ responseIndex: index, ...call })),
    toolResults: allCalls.map((call, index) => ({ name: call.name, isError: false, truncated: false,
      output: JSON.stringify(index < prefix.length ? (index === 0 ? { ok: true,slug: PROCEDURE_SLUG,surface: 'engineering' }
        : { results: [{ slug: PROCEDURE_REF,found: true,content: PROCEDURE_BODY }],surface: 'engineering' }) : outputs?.[index-prefix.length] ?? ((call.name === 'reports:publish' || call.input.name === 'reports:publish')
        ? { ok: true, report_id: 'rpt_fixture', path: '/reports?sel=rpt_fixture' }
        : { ok: true, results: [{ id: 'rpt_fixture', ok: true, report: { body_md: REPORT_BODY, visibility: 'workspace' } }] })) }))
  }] } as unknown as RunSummary;
  return SU_S38_REPORTS_CAPTURE.asserts.flatMap(assert => assert.kind === 'custom' ? assert.eval(run) : []);
}

describe('S38 Reports capture contract', () => {
  it.each([undefined,'all','engineering'])('accepts production-valid author scope %s and canonical doc paths', async harness => {
    const world = createReportsCaptureWorld();
    const written = await world.override('docs:author',{ ...(harness ? { harness } : {}),
      slug: PROCEDURE_REF,title: 'Shared visibility procedure',body: PROCEDURE_BODY });
    expect(JSON.parse((written as { content: [{ text: string }] }).content[0].text))
      .toMatchObject({ ok: true,slug: PROCEDURE_SLUG,surface: 'engineering' });
    const read = await world.override('docs:get',{ harness: 'all',slugs: [PROCEDURE_REF] });
    expect(JSON.parse((read as { content: [{ text: string }] }).content[0].text))
      .toMatchObject({ surface: 'engineering',results: [{ found: true,content: PROCEDURE_BODY }] });
  });

  it('refuses a concrete unrelated doc scope instead of widening it to engineering', async () => {
    const world = createReportsCaptureWorld();
    const written = await world.override('docs:author',{ harness: 'agent-insights',slug: PROCEDURE_REF,
      title: 'Shared visibility procedure',body: PROCEDURE_BODY });
    expect(JSON.parse((written as { content: [{ text: string }] }).content[0].text)).toMatchObject({ ok: false,error: 'wrong_procedure_scope' });
  });
  it('rejects report-only completion when the requested reusable procedure was not maintained', () => {
    const calls = [{ name: 'reports:publish',input: { title: 'Review',body_md: REPORT_BODY } },
      { name: 'reports:get',input: { id: 'rpt_fixture' } }];
    expect(violations(calls,undefined,false)).toEqual([expect.objectContaining({ assertKind: 'custom:maintained-procedure-authored-and-read-back' })]);
  });

  it('uses production doc schemas and verifies the actual stored procedure before accepting routing', async () => {
    const world = createReportsCaptureWorld();
    const missing = await world.override('docs:get',{ harness: 'engineering',slugs: [PROCEDURE_REF] });
    expect(JSON.parse((missing as { content: [{ text: string }] }).content[0].text)).toMatchObject({ results: [{ found: false }] });
    await world.override('docs:author',{ harness: 'engineering',slug: PROCEDURE_SLUG,title: 'Shared visibility procedure',body: PROCEDURE_BODY });
    const read = await world.override('docs:get',{ harness: 'engineering',slugs: [PROCEDURE_REF] });
    expect(JSON.parse((read as { content: [{ text: string }] }).content[0].text)).toMatchObject({ results: [{ found: true,content: PROCEDURE_BODY }] });
    const invalid = await world.override('docs:author',{ slug: PROCEDURE_SLUG,body: PROCEDURE_BODY });
    expect(JSON.parse((invalid as { content: [{ text: string }] }).content[0].text)).toMatchObject({ ok: false });
  });
  it('delivers the complete review on the first turn in the declared AUTO mode', () => {
    expect(SU_S38_REPORTS_CAPTURE.targetConfig).toEqual({ modes: ['auto'] });
    const first = SU_S38_REPORTS_CAPTURE.triggers?.find(trigger => trigger.param === 0);
    expect(first).toMatchObject({ on: 'after_turn', fire: 'user_message' });
    expect(first?.text?.endsWith(REPORT_BODY)).toBe(true);
    expect(first?.text).not.toContain('docs/architecture-review.md');
  });

  it('accepts exact workspace-public publication followed by read-back through either dispatch door', () => {
    const calls = [{ name: 'reports:publish', input: { title: 'Architecture review', kind: 'review', body_md: REPORT_BODY, visibility: 'workspace' } },
      { name: 'reports:get', input: { id: 'rpt_fixture' } }];
    expect(violations(calls)).toEqual([]);
    expect(violations(calls.map(call => ({ name: 'tools:invoke', input: { name: call.name, args: call.input } })))).toEqual([]);
  });

  it('requires the final response to link the exact returned Reports route', () => {
    const calls = [{ name: 'reports:publish', input: { title: 'Architecture review', body_md: REPORT_BODY, visibility: 'workspace' } },
      { name: 'reports:get', input: { id: 'rpt_fixture' } }];
    expect(violations(calls, undefined, true, 'Saved the report for later.')).toEqual([
      expect.objectContaining({ assertKind: 'custom:final-report-citation-uses-returned-route' }),
    ]);
    expect(violations(calls, undefined, true, 'Saved: [Architecture review](/reports?sel=rpt_fixture)')).toEqual([]);
  });

  it('rejects a missing read-back, altered Markdown, or unrequested private visibility', () => {
    expect(violations([{ name: 'reports:publish', input: { title: 'Review', body_md: REPORT_BODY } }])).toHaveLength(1);
    for (const input of [{ title: 'Review', body_md: REPORT_BODY.replace('```mermaid', '```text') },
      { title: 'Review', body_md: REPORT_BODY, visibility: 'owner' },
      { title: 'Review', body_md: REPORT_BODY, kind: 'architecture-review' },
      { body_md: REPORT_BODY }, { title: '', body_md: REPORT_BODY }]) {
      expect(violations([{ name: 'reports:publish', input },
        { name: 'reports:get', input: { ids: ['rpt_fixture'] } }])).toHaveLength(1);
    }
  });

  it('rejects a read-back that precedes publication', () => {
    expect(violations([{ name: 'reports:get', input: { id: 'rpt_fixture' } },
      { name: 'reports:publish', input: { title: 'Review', body_md: REPORT_BODY } }])).toHaveLength(1);
  });

  it('requires successful publication and a complete public read-back across a tool-result boundary', () => {
    const calls = [{ name: 'reports:publish', input: { title: 'Review', body_md: REPORT_BODY } },
      { name: 'reports:get', input: { id: 'rpt_fixture' } }];
    expect(violations(calls)).toEqual([]);
    expect(violations(calls.map(call => ({ ...call, responseIndex: 0 })))).toHaveLength(1);
    expect(violations(calls, [{ ok: false, error: 'invalid_field' }])).toHaveLength(1);
    for (const output of [{ ok: false, error: 'not_found' },
      { ok: true, results: [{ id: 'rpt_fixture', ok: true, report: { body_md: '# Altered', visibility: 'workspace' } }] },
      { ok: true, results: [{ id: 'rpt_fixture', ok: true, report: { body_md: REPORT_BODY, visibility: 'owner' } }] }]) {
      expect(violations(calls, [{ ok: true, report_id: 'rpt_fixture' }, output])).toHaveLength(1);
    }
  });

  it('refuses production-invalid publications and cannot invent a successful read-back', async () => {
    for (const input of [{ title: 'Review', body_md: REPORT_BODY, kind: 'architecture-review' },
      { body_md: REPORT_BODY }, { title: '', body_md: REPORT_BODY },
      { title: 'Review', body_md: REPORT_BODY, visibility: 'public' },
      { title: 'Review', body_md: REPORT_BODY, subject: { kind: 'plan' } },
      { title: 'Review', body_md: 'x'.repeat(REPORT_BODY_MAX_BYTES + 1) }]) {
      const world = createReportsCaptureWorld();
      const published = await world.override('reports:publish', input);
      expect(JSON.parse((published as { content: [{ text: string }] }).content[0].text)).toMatchObject({ ok: false });
      const read = await world.override('reports:get', { id: 'rpt_fixture' });
      expect(JSON.parse((read as { content: [{ text: string }] }).content[0].text)).toMatchObject({
        ok: false, results: [{ id: 'rpt_fixture', ok: false, error: 'not_found' }], counts: { ok: 0, failed: 1 } });
    }
  });

  it('defaults to workspace-public while preserving an explicit private choice', async () => {
    for (const visibility of [undefined, 'owner']) {
      const world = createReportsCaptureWorld();
      await world.override('reports:publish', { title: 'Review', body_md: REPORT_BODY, ...(visibility ? { visibility } : {}) });
      const read = await world.override('reports:get', { id: 'rpt_fixture' });
      expect(JSON.parse((read as { content: [{ text: string }] }).content[0].text))
        .toMatchObject({ results: [{ report: { visibility: visibility ?? 'workspace' } }] });
    }
  });

  it('reads only the saved body and visibility by the published id', async () => {
    const world = createReportsCaptureWorld();
    const body = '# Distinct body';
    await world.override('reports:publish', { title: 'Review', body_md: body, kind: 'review', visibility: 'pot' });
    const read = await world.override('reports:get', { id: 'rpt_fixture' });
    expect(JSON.parse((read as { content: [{ text: string }] }).content[0].text)).toMatchObject({
      ok: true, results: [{ report: { body_md: body, visibility: 'pot' } }] });
    const wrongId = await world.override('reports:get', { id: 'rpt_other' });
    expect(JSON.parse((wrongId as { content: [{ text: string }] }).content[0].text)).toMatchObject({ ok: false });
  });
});

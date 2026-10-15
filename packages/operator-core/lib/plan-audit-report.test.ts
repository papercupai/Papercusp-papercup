// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import legacySnapshot from './__fixtures__/plan-audit-legacy-snapshot.json';
import { renderPlanAuditReport, type PlanAuditDocument } from './plan-audit-report';

describe('shared audit report workspace', () => {
  it('preserves plan identities and composes source, search, and harness filters in the shared viewer', () => {
    const rows = [
      { slug: 'blender-alpha', title: 'Alpha Blender', status: 'active', category: 'protected', provenance: 'blender', harness: 'papercusp' },
      { slug: 'outside-alpha', title: 'Alpha Outside', status: 'active', category: 'protected', provenance: 'outside-blender', harness: 'papercusp' },
      { slug: 'blender-beta', title: 'Beta Blender', status: 'active', category: 'protected', provenance: 'blender', harness: 'other' },
      { slug: 'outside-beta', title: 'Beta Outside', status: 'active', category: 'protected', provenance: 'outside-blender', harness: 'other' },
    ];
    const doc = window.document;
    doc.documentElement.innerHTML = renderPlanAuditReport({ rows });
    window.history.replaceState(null, '', '#');
    window.eval('(() => {' + doc.scripts[1]!.textContent + '})()');
    const set = (id: string, value: string) => { (doc.getElementById(id) as HTMLInputElement).value = value;doc.getElementById(id)!.dispatchEvent(new window.Event(id === 'search' ? 'input' : 'change')); };
    expect(doc.getElementById('shown')!.textContent).toBe('4 of 4 records');
    set('provenance', 'outside-blender');expect(doc.getElementById('shown')!.textContent).toBe('2 of 4 records');
    set('search', 'alpha');expect(doc.getElementById('shown')!.textContent).toBe('1 of 4 records');
    set('harness', 'other');expect(doc.getElementById('shown')!.textContent).toBe('0 of 4 records');
    set('search', '');expect(doc.getElementById('shown')!.textContent).toBe('1 of 4 records');
  });
  const rows = Array.from({ length: 83 }, (_, i) => ({ slug: 'plan-' + i, title: 'Plan ' + String(i).padStart(2, '0'), status: i % 2 ? 'active' : 'superseded', category: i % 2 ? 'Finish' : 'History', implementation: 'Built ' + i, citations: [{ path: 'src/' + i + '.ts' }], remaining: i }));
  const document = { rows, generatedAt: '2026-10-07T00:00:00Z', limitations: ['Stored history only'], extraOriginalEvidence: { retained: true } };
  const dom = (payload: PlanAuditDocument = document, hash = '#plan=plan-82') => {
    window.document.documentElement.innerHTML = renderPlanAuditReport(payload);
    window.history.replaceState(null, '', hash);
    window.eval('(() => {' + window.document.scripts[1]!.textContent + '})()');
    return { window };
  };
  it('retains the entire original JSON while mounting only one page of compact results', () => {
    const d = dom();
    expect(JSON.parse(d.window.document.getElementById('audit')!.textContent!)).toEqual(document);
    expect(d.window.document.querySelectorAll('#results button').length).toBeLessThanOrEqual(40);
    expect(d.window.document.getElementById('detail')!.textContent).toContain('Built 82');
    expect(d.window.document.getElementById('detail')!.textContent).toContain('src/82.ts');
  });
  it('filters categories and search, sorts, paginates, and renders honest empty state', () => {
    const d = dom(), doc = d.window.document;
    (doc.querySelector('[data-category="Finish"]') as HTMLButtonElement).click();
    expect(doc.getElementById('shown')!.textContent).toContain('41 of 83');
    (doc.getElementById('next') as HTMLButtonElement).click();
    expect(doc.querySelectorAll('#results button')).toHaveLength(1);
    const search = doc.getElementById('search') as HTMLInputElement;
    search.value = 'Plan 05';search.dispatchEvent(new d.window.Event('input'));
    expect(doc.getElementById('shown')!.textContent).toContain('1 of 83');
    search.value = 'no-match';search.dispatchEvent(new d.window.Event('input'));
    expect(doc.getElementById('detail')!.textContent).toContain('No matching plans');
  });
  it('escapes untrusted report prose and prevents embedded script breakout without losing strings', () => {
    const evil = '</script><script>window.compromised=true</script>';
    const d = dom({ rows: [{ slug: 'evil', title: evil, recommendation: '<img src=x onerror=alert(1)>', citations: [{ path: evil }] }] }, '#plan=evil');
    expect((d.window as unknown as { compromised?: boolean }).compromised).toBeUndefined();
    expect(d.window.document.querySelector('#detail img')).toBeNull();
    expect(d.window.document.getElementById('detail')!.textContent).toContain(evil);
  });

  it('preserves every row and evidence value in the original localhost:39303 legacy snapshot', () => {
    // Frozen October 5 parity manifest: every original row id, citation and
    // saved evidence id. Private owner narratives stay in the original artifact;
    // they are unnecessary for an identity-parity fixture in shipped source.
    // This fixture does not query or rerun the audit.
    const legacy = legacySnapshot as PlanAuditDocument;
    expect(legacy.sourceSnapshotSha256).toBe('4171a584464199cb08a5b26ce9ab698f929d79b4fe2144e74a5d6d01ec56c39b');
    expect(legacy.rows).toHaveLength(1351);
    expect(legacy.rows.some(row => Array.isArray(row.citations) && row.citations.length > 0)).toBe(true);
    expect(legacy.rows.some(row => Array.isArray(row.savedWorkEvidence) && row.savedWorkEvidence.length > 0)).toBe(true);
    const html = renderPlanAuditReport(legacy);
    const embedded = JSON.parse(html.match(/<script type="application\/json" id="audit">([^<]*)<\/script>/)![1]);
    expect(embedded).toEqual(legacy); // all original row/citation/evidence identities
    const representative = legacy.rows.find(row => Array.isArray(row.citations) && row.citations.length > 0)!;
    const d = dom(legacy, '#plan=' + encodeURIComponent(String(representative.slug)));
    expect(d.window.document.getElementById('detail')!.textContent).toContain(String(representative.slug));
    expect(d.window.document.getElementById('detail')!.textContent).toContain(String((representative.citations as { path: string }[])[0].path));
  });
});

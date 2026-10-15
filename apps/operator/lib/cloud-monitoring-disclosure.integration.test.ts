import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderMdxToMarkdown, withPreamble } from '@papercusp/docs-engine';

// Exercise the maintained MDX twin compiler and the real filesystem-backed Hono
// reader together. The separate doc-claims unit guard derives schema parity;
// these assertions catch content lost between authoring and the reader.
const sourcePath = new URL('../../operator-docs/src/content/docs/posthog/index.mdx', import.meta.url);
const source = readFileSync(sourcePath, 'utf8');
const events = [
  'cloud_portal_session', 'cloud_tutorial', 'product_tutorial',
  'cloud_workspace_provisioning', 'cloud_feature_adoption', 'cloud_error',
  'cloud_diagnostic_aggregate',
];
let fixtureRoot: string;
let routes: typeof import('../bin/host-docs').docsRoutes;

function disclosureRows(markdown: string): Map<string, string[]> {
  return new Map(markdown.split('\n').flatMap(line => {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    const event = cells[0]?.replaceAll('`', '');
    return event && events.includes(event) ? [[event, cells.slice(1)]] : [];
  }));
}

beforeAll(async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'cloud-monitoring-docs-reader-'));
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const markdown = withPreamble(await renderMdxToMarkdown(body, sourcePath.pathname), {
    title: 'PostHog', url: '/internal/docs/posthog',
  });
  writeFileSync(join(fixtureRoot, 'posthog.md'), markdown);
  const savedRoot = process.env.PAPERCUSP_DOCS_ROOT;
  process.env.PAPERCUSP_DOCS_ROOT = fixtureRoot;
  try {
    vi.resetModules();
    routes = (await import('../bin/host-docs')).docsRoutes;
  } finally {
    if (savedRoot === undefined) delete process.env.PAPERCUSP_DOCS_ROOT;
    else process.env.PAPERCUSP_DOCS_ROOT = savedRoot;
  }
});

afterAll(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  vi.resetModules();
});

async function readDisclosure(): Promise<string> {
  const response = await routes.request('http://127.0.0.1/internal/docs/posthog', {
    headers: { host: '127.0.0.1', accept: 'text/markdown' },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/markdown');
  return response.text();
}

describe('compiled cloud monitoring disclosure through the production reader', () => {
  it('preserves every exported category, its explicit purpose and its complete field row', async () => {
    const expected = disclosureRows(source);
    expect([...expected.keys()]).toEqual(events);
    for (const [event, cells] of expected) {
      expect(cells, event).toHaveLength(2);
      expect(cells[0]!.length, `${event} purpose`).toBeGreaterThan(12);
      expect(cells[1], `${event} fields`).toMatch(/`[a-z_]+`/);
    }
    expect(disclosureRows(await readDisclosure())).toEqual(expected);
  });

  it('preserves the common destination, retention and revocation policy for the category population', async () => {
    const rendered = await readDisclosure();
    for (const event of events) expect(rendered).toContain(event);
    for (const statement of [
      'flags.papercuspai.com', 'a different destination requires separate authorization',
      'no enforced event-deletion limit', 'stops future delivery',
      'does not delete events already delivered',
    ]) expect(rendered, statement).toContain(statement);
  });
});

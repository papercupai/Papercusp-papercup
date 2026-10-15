/**
 * personal-cloud-desktop-2026-10-06 P-007 / R-7: the repository docs projection carries an
 * agent-insights doc for the personal cloud desktop, and it names the account the desktop
 * runs as.
 *
 * The doc is authored through docs:author (Postgres is canonical) and projected into the
 * docs tree; this test reads the PROJECTION, which is what readers and docs:search see.
 * The account is taken from the code constant the worker asserts against — not retyped
 * here — so changing the account without changing the doc fails this test.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PERSONAL_DESKTOP_ACCOUNT } from './workspace-desktop-session';
import { PERSONAL_DESKTOP_HOME } from './workspace-desktop-session-worker';

const REPO = new URL('../../../../', import.meta.url);
const DOC_URL = new URL('apps/operator-docs/src/content/docs/agent-insights/personal-cloud-desktop.mdx', REPO);

function readDoc(): string {
  expect(existsSync(DOC_URL), `missing projected doc: ${DOC_URL.pathname}`).toBe(true);
  return readFileSync(DOC_URL, 'utf8');
}

function section(doc: string, heading: string): string {
  const start = doc.indexOf(`## ${heading}`);
  expect(start, `missing section: ${heading}`).toBeGreaterThanOrEqual(0);
  const next = doc.indexOf('\n## ', start + heading.length + 3);
  return doc.slice(start, next >= 0 ? next : undefined);
}

describe('personal cloud desktop agent-insights doc (R-7)', () => {
  it('is an agent-insights doc about the personal cloud desktop', () => {
    const doc = readDoc();
    const frontmatter = doc.slice(0, doc.indexOf('\n---', 3));
    expect(frontmatter).toMatch(/title:.*[Pp]ersonal cloud desktop/);
    expect(doc).toContain("scope = 'user'");
  });

  it('names the account the personal desktop runs as, in its identity section', () => {
    const identity = section(readDoc(), `Identity: it runs as \`${PERSONAL_DESKTOP_ACCOUNT}\``);
    expect(identity).toContain(`customer account \`${PERSONAL_DESKTOP_ACCOUNT}\``);
    expect(identity).toContain(`HOME=${PERSONAL_DESKTOP_HOME}`);
    expect(identity).toContain(`User=${PERSONAL_DESKTOP_ACCOUNT}`);
  });

  it('keeps the personal account distinct from the sandbox desktop user', () => {
    const identity = section(readDoc(), `Identity: it runs as \`${PERSONAL_DESKTOP_ACCOUNT}\``);
    expect(PERSONAL_DESKTOP_ACCOUNT).not.toBe('papercusp-desktop');
    expect(identity).toMatch(/does \*\*not\*\* run as `papercusp-desktop`/);
  });

  it('documents the owner-only refusal and how to verify', () => {
    const doc = readDoc();
    expect(section(doc, 'Who may see and open it')).toContain('`desktop_not_owner`');
    expect(section(doc, 'How to verify')).toContain(`runs as \`${PERSONAL_DESKTOP_ACCOUNT}\``);
  });
});

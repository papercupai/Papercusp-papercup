import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT_SOURCE = readFileSync(
  fileURLToPath(new URL('./__root.tsx', import.meta.url)),
  'utf8',
);

describe('root first-paint steering rail', () => {
  it('retains sidebar layout at the shared root for every page navigation', () => {
    expect(ROOT_SOURCE).toContain('search: { middlewares: [sidebarSearchMiddleware] }');
  });

  it('imports the unconditional LeftSidebar shell eagerly', () => {
    expect(ROOT_SOURCE).toContain(
      "import LeftSidebar from '../components/left-sidebar/LeftSidebar';",
    );
    expect(ROOT_SOURCE).not.toMatch(/const\s+LeftSidebar\s*=\s*lazy\s*\(/);
    expect(ROOT_SOURCE).toContain('<LeftSidebar />');
  });
});

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolvePhasedProject = vi.fn();

vi.mock('../../../harness-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../harness-core')>();
  return { ...actual, resolvePhasedProject: (...args: unknown[]) => resolvePhasedProject(...args) };
});

import routes from './notes-diff';

type RouteEntry = {
  path: string;
  handler: (req: Request, ctx: { params: Record<string, string> }) => Promise<Response>;
};

const route = (routes as unknown as RouteEntry[]).find((entry) => entry.path === '/harness/:slug/diff/working')!;
let roots: string[] = [];

beforeEach(() => {
  resolvePhasedProject.mockReset();
});

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe('GET /harness/:slug/diff/working', () => {
  it('disables optional index locking for its read-only status probe', async () => {
    const root = mkdtempSync(join(tmpdir(), 'papercusp-notes-diff-'));
    roots.push(root);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const capturePath = join(root, 'status-env.txt');
    const shim = [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      "if (args.includes('status')) fs.writeFileSync(process.env.GIT_STATUS_ENV_CAPTURE, process.env.GIT_OPTIONAL_LOCKS || 'unset');",
      "process.stdout.write('');",
    ].join('\n');
    writeFileSync(join(bin, 'git'), shim, { mode: 0o755 });
    const previous = {
      path: process.env.PATH,
      optionalLocks: process.env.GIT_OPTIONAL_LOCKS,
      capturePath: process.env.GIT_STATUS_ENV_CAPTURE,
    };

    try {
      process.env.PATH = [bin, previous.path].filter(Boolean).join(delimiter);
      process.env.GIT_OPTIONAL_LOCKS = '1';
      process.env.GIT_STATUS_ENV_CAPTURE = capturePath;
      resolvePhasedProject.mockResolvedValue({ slug: 'demo', path: root });
      const response = await route.handler(
        new Request('http://127.0.0.1:3070/api/harness/demo/diff/working'),
        { params: { slug: 'demo' } },
      );

      expect(response.status).toBe(200);
      expect(readFileSync(capturePath, 'utf8')).toBe('0');
    } finally {
      if (previous.path === undefined) delete process.env.PATH;
      else process.env.PATH = previous.path;
      if (previous.optionalLocks === undefined) delete process.env.GIT_OPTIONAL_LOCKS;
      else process.env.GIT_OPTIONAL_LOCKS = previous.optionalLocks;
      if (previous.capturePath === undefined) delete process.env.GIT_STATUS_ENV_CAPTURE;
      else process.env.GIT_STATUS_ENV_CAPTURE = previous.capturePath;
    }
  });
});

/**
 * harness:* tools — phase_path, markdown_index.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-phase-path-'));
  tempRoots.push(root);
  return root;
}

function mockHarnessRegistry(factory: () => Record<string, unknown>) {
  vi.doMock('../../../harness-registry', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    ...factory(),
  }));
}

const MAKE_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: 'default',
    harnessSlug: 'sheets',
    role: 'architect' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
    ...over,
  } as never);

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.doUnmock('../../../harness-phases');
  vi.doUnmock('../../../harness-registry');
  vi.doUnmock('../../../harness-markdown-index');
});

function parsePayload(result: {
  data?: Record<string, unknown>;
  content?: Array<{ text: string }>;
}): Record<string, unknown> {
  if (result.data) return result.data;
  if (!result.content?.[0]?.text) {
    throw new Error('Tool handler returned neither data nor content');
  }
  return JSON.parse(result.content[0].text);
}

describe('harness:phase_path', () => {
  it('resolves (slug, phase) → path via phasePath', async () => {
    const root = makeTempRoot();
    const projectPath = join(root, 'sheets');
    const testingPath = `${projectPath}--testing`;
    mkdirSync(projectPath);
    mkdirSync(testingPath);
    const phasePath = vi.fn(() => testingPath);
    vi.doMock('../../../harness-phases', () => ({ phasePath }));
    mockHarnessRegistry(() => ({
      loadHarnessRegistry: vi.fn(async () => ({
        projects: [{ slug: 'sheets', path: projectPath }],
      })),
    }));
    const { default: tool } = await import('../phase_path');
    const result = await tool.handler(
      { harnessSlug: 'sheets', phase: 'testing' },
      MAKE_CTX(),
    );
    expect(phasePath).toHaveBeenCalledWith(
      { slug: 'sheets', path: projectPath },
      'testing',
    );
    const payload = parsePayload(result as never);
    expect(payload).toEqual({
      slug: 'sheets',
      phase: 'testing',
      found: true,
      path: testingPath,
    });
  });

  it('returns found:false when the resolved phase directory is missing', async () => {
    const root = makeTempRoot();
    const projectPath = join(root, 'sheets');
    const testingPath = `${projectPath}--testing`;
    mkdirSync(projectPath);
    const phasePath = vi.fn(() => testingPath);
    vi.doMock('../../../harness-phases', () => ({ phasePath }));
    mockHarnessRegistry(() => ({
      loadHarnessRegistry: vi.fn(async () => ({
        projects: [{ slug: 'sheets', path: projectPath }],
      })),
    }));
    const { default: tool } = await import('../phase_path');
    const result = await tool.handler(
      { harnessSlug: 'sheets', phase: 'testing' },
      MAKE_CTX(),
    );
    expect(parsePayload(result as never)).toEqual({
      slug: 'sheets',
      phase: 'testing',
      found: false,
      path: null,
    });
  });

  it('returns found:false when slug not in registry', async () => {
    vi.doMock('../../../harness-phases', () => ({ phasePath: vi.fn() }));
    mockHarnessRegistry(() => ({
      loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
    }));
    const { default: tool } = await import('../phase_path');
    const result = await tool.handler(
      { harnessSlug: 'unknown', phase: 'staging' },
      MAKE_CTX(),
    );
    const payload = parsePayload(result as never);
    expect(payload).toEqual({
      slug: 'unknown',
      phase: 'staging',
      found: false,
      path: null,
    });
  });

  it('falls back to ctx.harnessSlug when arg omitted', async () => {
    const projectPath = makeTempRoot();
    const phasePath = vi.fn(() => projectPath);
    vi.doMock('../../../harness-phases', () => ({ phasePath }));
    mockHarnessRegistry(() => ({
      loadHarnessRegistry: vi.fn(async () => ({
        projects: [{ slug: 'fallback', path: projectPath }],
      })),
    }));
    const { default: tool } = await import('../phase_path');
    await tool.handler({ phase: 'staging' }, MAKE_CTX({ harnessSlug: 'fallback' }));
    expect(phasePath).toHaveBeenCalled();
  });
});

describe('harness:markdown_index', () => {
  it('returns loadHarnessMarkdownIndex output', async () => {
    const index = [
      {
        slug: 'sheets',
        files: [{ filename: 'SPEC.md', headings: [{ level: 1, text: 'X', anchor: 'X' }] }],
      },
    ];
    vi.doMock('../../../harness-markdown-index', () => ({
      loadHarnessMarkdownIndex: vi.fn(async () => index),
    }));
    const { default: tool } = await import('../markdown_index');
    const result = await tool.handler({}, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ index });
  });
});

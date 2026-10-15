/**
 * EI-20478240377353884 — encrypted integration keys can be referenced by name
 * for one capability:bash child without entering the command, operator process
 * environment, result, streamed events, or spill output.
 */
import { existsSync, mkdtempSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  value: 'saved-integration-secret-0123456789' as string | undefined,
  read: vi.fn(async () => h.value),
  readHeldWorkItems: vi.fn(async () => []),
}));

// The shell fixture has no live claims. Inject the reader while retaining the
// real authenticated-caller policy and avoiding production Postgres.
vi.mock('../../carry-brief', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../carry-brief')>()),
  readHeldWorkItems: h.readHeldWorkItems,
}));

vi.mock('../../integration-credentials', () => ({
  readIntegrationKey: h.read,
  maskIntegrationKey: (value?: string | null) =>
    value && value.length >= 8 ? `${value.slice(0, 3)}...${value.slice(-4)}` : null,
}));
vi.mock('./exec-sandbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exec-sandbox')>()),
  // This suite owns credential injection/redaction, not operation-profile
  // classification. Keep its child-process fixture on the trusted/raw path;
  // boundary-profile.test.ts pins the real policy seam separately.
  capabilityExecSandboxPolicy: vi.fn(async () => ({
    enabled: false,
    required: false,
    profile: { kind: 'trusted', reason: 'system-operator' },
  })),
}));

import bashTool from './bash';
import {
  CAPABILITY_BASH_FOREGROUND_ENV,
  CAPABILITY_BASH_FOREGROUND_TIMEOUT_ENV,
  __resetBashJobs,
} from './bash-jobs';

type ToolResult = {
  content: Array<{ text: string }>;
  structuredContent?: Record<string, unknown>;
};
type Tool = { handler: (args: unknown, ctx: unknown) => Promise<ToolResult> };
const bash = bashTool as unknown as Tool;
const STATE = mkdtempSync(join(tmpdir(), 'cap-bash-integration-env-'));
const DESTINATION = 'EI_INTEGRATION_SECRET';
const SOURCE = 'SIDESTAGE_DEEPGRAM_API_KEY';

function makeCtx(over: Record<string, unknown> = {}) {
  const emitted: string[] = [];
  return {
    emitted,
    ctx: {
      projectDir: STATE,
      stateDir: STATE,
      signal: new AbortController().signal,
      emit: (_event: string, chunk: string) => emitted.push(chunk),
      role: 'operator',
      ...over,
    },
  };
}

beforeEach(() => {
  h.value = 'saved-integration-secret-0123456789';
  h.read.mockClear();
  h.readHeldWorkItems.mockClear();
  delete process.env[DESTINATION];
});

afterEach(() => {
  __resetBashJobs();
  delete process.env[DESTINATION];
});

describe('capability:bash integration_env', () => {
  // The subject is the env marker, not job speed. The timeout value only has to
  // be distinctive; keep it generous because a gate run under host load once
  // took longer than 12.3s to finish this bare printf (WI-6554700010008539).
  it('marks foreground children and clears the marker for background children', async () => {
    const { ctx } = makeCtx();
    const foreground = await bash.handler(
      {
        command: `printf '%s|%s' "$${CAPABILITY_BASH_FOREGROUND_ENV}" "$${CAPABILITY_BASH_FOREGROUND_TIMEOUT_ENV}"`,
        timeout: 60_345,
      },
      ctx,
    );
    expect(foreground.content[0]!.text).toContain('1|60345');

    const markerFile = join(STATE, `foreground-marker-${process.pid}-${Date.now()}`);
    try {
      await bash.handler(
        {
          command: `printf '%s|%s' "$${CAPABILITY_BASH_FOREGROUND_ENV}" "$${CAPABILITY_BASH_FOREGROUND_TIMEOUT_ENV}" > ${JSON.stringify(markerFile)}`,
          run_in_background: true,
          timeout: 1_000,
        },
        ctx,
      );
      for (let attempt = 0; attempt < 100 && !existsSync(markerFile); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(readFileSync(markerFile, 'utf8')).toBe('|');
    } finally {
      if (existsSync(markerFile)) unlinkSync(markerFile);
    }
  }, 120_000);

  it('stamps concrete caller tenant identity into local test-run children', async () => {
    const { ctx } = makeCtx({ harnessSlug: 'papercusp', workspaceId: 'papercusp-workspace' });
    const result = await bash.handler(
      {
        command: 'printf "%s|%s" "$PAPERCUSP_TEST_RUN_HARNESS" "$PAPERCUSP_WORKSPACE_ID"',
      },
      ctx,
    );

    expect(result.content[0]!.text).toContain('papercusp|papercusp-workspace');
  });

  it('injects by saved name into only the child and returns names/masks while redacting output', async () => {
    const { ctx, emitted } = makeCtx({ codeMode: true });
    const result = await bash.handler(
      {
        command: `printf "value=%s" "$${DESTINATION}"`,
        integration_env: { [DESTINATION]: SOURCE },
      },
      ctx,
    );
    const raw = h.value!;
    const serialized = JSON.stringify(result);

    expect(h.read).toHaveBeenCalledWith(SOURCE);
    expect(result.content[0]!.text).toContain('value=[REDACTED integration credential]');
    expect(emitted.join('')).toContain('value=[REDACTED integration credential]');
    expect(result.structuredContent?.integration_env).toEqual({
      [DESTINATION]: { source: SOURCE, masked: 'sav...6789' },
    });
    expect(serialized).not.toContain(raw);
    expect(emitted.join('')).not.toContain(raw);
    expect(process.env[DESTINATION]).toBeUndefined();
  });

  it('fails closed for a non-operator caller before reading the saved secret', async () => {
    const { ctx } = makeCtx({ role: 'cup', isSuperuser: false });
    await expect(bash.handler({ command: 'true', integration_env: { [DESTINATION]: SOURCE } }, ctx)).rejects.toThrow(
      /requires superuser or operator, architect, or mug authority/i,
    );
    expect(h.read).not.toHaveBeenCalled();
  });

  it('admits a transport-authenticated superuser even when its pipeline role is non-operator', async () => {
    const { ctx } = makeCtx({ role: 'worker', isSuperuser: true });
    const result = await bash.handler(
      { command: `test -n "$${DESTINATION}"`, integration_env: { [DESTINATION]: SOURCE } },
      ctx,
    );
    expect(result.content[0]!.text).toContain('exit 0');
    expect(h.read).toHaveBeenCalledWith(SOURCE);
  });

  it('names a missing reference without launching or exposing any value', async () => {
    h.value = undefined;
    const { ctx } = makeCtx();
    await expect(
      bash.handler({ command: 'echo SHOULD_NOT_RUN', integration_env: { [DESTINATION]: SOURCE } }, ctx),
    ).rejects.toThrow(`missing saved integration credential(s): ${SOURCE}`);
    expect(process.env[DESTINATION]).toBeUndefined();
  });
});

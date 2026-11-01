import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classifySuSessionRuntime,
  isPersistedSuSessionDescriptor,
  suppressDuplicateSuLaunch,
  type DurableSuSessionRecord,
} from './su-session-persistence';

const MIGRATION = readFileSync(
  new URL('../../../libs/papercusp/libs/db/sql/1017-su-session-persistence.sql', import.meta.url),
  'utf8',
);

function record(over: Partial<DurableSuSessionRecord> = {}): DurableSuSessionRecord {
  return {
    advSessionId: 41,
    workspaceId: 'papercusp-workspace',
    agentChatId: 'chat-1',
    backend: 'codex',
    nativeSessionId: 'rollout-1',
    ownerId: 'su-owner',
    harnessSlug: 'papercusp',
    lifecycle: 'ready',
    runtimeGeneration: 1,
    pid: 9001,
    endedAt: null,
    descriptor: null,
    cwd: null,
    ...over,
  };
}

describe('P-004 durable SU-session persistence', () => {
  it.each((['claude', 'codex'] as const).flatMap(backend =>
    (['pty', 'programmatic'] as const).map(executionKind => ({ backend, executionKind })),
  ))('SU-EXEC R-8 acceptance contract: $backend $executionKind reconciles lost runtimes without a duplicate launch', ({ backend, executionKind }) => {
    const snapshot = {
      identity: { agentChatId: 'chat-1', advSessionId: 41, backend, nativeSessionId: 'native-1',
        ownerId: 'su-owner', workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
      lifecycle: 'ready', runtimeGeneration: 1, executionKind, role: 'su', backendExtension: { backend },
    };
    expect(isPersistedSuSessionDescriptor(snapshot)).toBe(true);
    if (!isPersistedSuSessionDescriptor(snapshot)) throw new Error('Invalid fixture');
    const saved = record({ backend, descriptor: snapshot });
    expect(suppressDuplicateSuLaunch(saved, { advSessionId: 41 })).toBe(true);
    expect(classifySuSessionRuntime(saved, () => true)).toMatchObject({ action: 'reattach', reason: 'live_pid' });
    expect(classifySuSessionRuntime(saved, () => false)).toEqual({ action: 'reattach', reason: 'runtime_replacement', stalePid: true });
    expect(classifySuSessionRuntime({ ...saved, pid: null }, () => false)).toEqual({ action: 'reattach', reason: 'native_identity', stalePid: false });
    const lostIdentity = { ...saved, nativeSessionId: null };
    expect(classifySuSessionRuntime(lostIdentity, () => false)).toEqual({ action: 'relaunch', reason: 'stale_pid_without_native_identity', stalePid: true });
    expect(classifySuSessionRuntime({ ...lostIdentity, pid: null }, () => false)).toEqual({ action: 'wait', reason: 'pid_unknown', stalePid: false });
    const ended = { ...saved, endedAt: '2026-11-01T00:00:00Z' };
    expect(classifySuSessionRuntime(ended, () => false)).toMatchObject({ action: 'rematerialize', reason: 'ended_archived' });
    expect(suppressDuplicateSuLaunch(ended, { advSessionId: 41 })).toBe(false);
    expect(snapshot.executionKind).toBe(executionKind);
  });

  it('adds binding, descriptor, lifecycle and generation state to adv_sessions with a unique chat index', () => {
    expect(MIGRATION).toContain('ADD COLUMN IF NOT EXISTS su_agent_chat_id text');
    expect(MIGRATION).toContain('ADD COLUMN IF NOT EXISTS su_session_descriptor jsonb');
    expect(MIGRATION).toContain('ADD COLUMN IF NOT EXISTS su_runtime_generation integer');
    expect(MIGRATION).toContain('CREATE UNIQUE INDEX IF NOT EXISTS adv_sessions_su_agent_chat_idx');
  });

  it('accepts only a complete typed descriptor snapshot', () => {
    const valid = {
      identity: {
        agentChatId: 'chat-1', advSessionId: 41, backend: 'codex', nativeSessionId: 'rollout-1',
        ownerId: 'su-owner', workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp',
      },
      lifecycle: 'ready', runtimeGeneration: 1, role: 'su', backendExtension: { backend: 'codex' },
    };
    expect(isPersistedSuSessionDescriptor(valid)).toBe(true);
    for (const executionKind of ['pty', 'programmatic']) {
      expect(isPersistedSuSessionDescriptor({ ...valid, executionKind })).toBe(true);
    }
    for (const executionKind of ['', 'sdk', null, 1]) {
      expect(isPersistedSuSessionDescriptor({ ...valid, executionKind })).toBe(false);
    }
    expect(isPersistedSuSessionDescriptor({ ...valid, role: 'worker' })).toBe(false);
    expect(isPersistedSuSessionDescriptor({ ...valid, identity: { ...valid.identity, advSessionId: 0 } })).toBe(false);
  });

  it('reattaches a native session even when its recorded pid is stale', () => {
    expect(classifySuSessionRuntime(record(), () => false)).toEqual({
      action: 'reattach', reason: 'runtime_replacement', stalePid: true,
    });
  });

  it('relaunches only when stale pid and native identity are both absent', () => {
    expect(classifySuSessionRuntime(record({ nativeSessionId: null, pid: 9001 }), () => false)).toEqual({
      action: 'relaunch', reason: 'stale_pid_without_native_identity', stalePid: true,
    });
    expect(classifySuSessionRuntime(record({ nativeSessionId: null, pid: null }), () => false)).toEqual({
      action: 'wait', reason: 'pid_unknown', stalePid: false,
    });
  });

  it('uses archive/rematerialize for ended sessions before any relaunch decision', () => {
    expect(classifySuSessionRuntime(record({ endedAt: '2026-08-28T01:00:00Z' }), () => false)).toEqual({
      action: 'rematerialize', reason: 'ended_archived', stalePid: true,
    });
  });

  /**
   * An exported function must have a production CALL SITE, not just an export.
   *
   * `classifySuSessionRuntime` shipped with a full test suite, a documented
   * contract, and zero production callers: nothing computed its verdict, so the
   * `rematerialize` reconciliation it exists to produce could never reach PUI,
   * and a restart into an ended/archived session was indistinguishable from a
   * live reattach. Review cannot catch this — the function reads as implemented
   * from every angle except the one that matters — and it is the same defect
   * that left `Action::AttachSuSession` without an emitter for a whole plan
   * cycle in the PUI crate (pui-su-session-runtime-correction-2026-08-27 D-009).
   *
   * This includes async writers: a staged writer is not harmless once it has
   * landed in the shared module. If it has no production caller, it is dead
   * surface and should be deleted or wired before the export ships.
   */
  describe('every exported function is reachable from production code', () => {
    const SOURCE_ROOTS = ['packages', 'apps'];
    const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', 'target', '.git']);
    const MODULE_BASENAME = 'su-session-persistence';
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const source = readFileSync(new URL('./su-session-persistence.ts', import.meta.url), 'utf8');

    /** Exported function declarations, derived from the module rather than listed. */
    const exportedFunctions = [...source.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);

    /** Production (non-test) sources that mention this module, plus the module itself. */
    function productionSources(): string[] {
      const bodies: string[] = [source];
      for (const root of SOURCE_ROOTS) {
        let entries: string[];
        try {
          entries = readdirSync(join(repoRoot, root), { recursive: true }) as unknown as string[];
        } catch {
          continue;
        }
        for (const rel of entries) {
          if (typeof rel !== 'string') continue;
          if (!/\.(ts|tsx)$/.test(rel) || /\.test\.tsx?$/.test(rel)) continue;
          if (rel.split(/[\\/]/).some((segment) => SKIP_DIRS.has(segment))) continue;
          if (rel.endsWith(`${MODULE_BASENAME}.ts`)) continue;
          let body: string;
          try {
            body = readFileSync(join(repoRoot, root, rel), 'utf8');
          } catch {
            continue;
          }
          if (body.includes(MODULE_BASENAME)) bodies.push(body);
        }
      }
      return bodies;
    }

    /** A name is reachable when it appears as a call anywhere but its declaration. */
    function callSites(name: string, bodies: readonly string[]): number {
      const call = new RegExp(`(?<!function )\\b${name}\\s*\\(`, 'g');
      return bodies.reduce((total, body) => total + (body.match(call)?.length ?? 0), 0);
    }

    it('reports no orphaned export, and the scan can still detect one', () => {
      const bodies = productionSources();
      expect(exportedFunctions.length).toBeGreaterThan(0);
      expect(bodies.length).toBeGreaterThan(1);

      // The scan MUST NOT see test files. This file imports the module by name,
      // so a broken `.test.ts` exclusion would pull it in — and every helper
      // would then look reachable via its own unit tests, which is precisely the
      // orphan this guard exists to catch. The marker below appears only here.
      const testFileMarker = 'su-session-persistence-reachability-scan-marker';
      expect(bodies.some((body) => body.includes(testFileMarker))).toBe(false);

      const orphans = exportedFunctions.filter((name) => callSites(name, bodies) === 0);
      expect(orphans).toEqual([]);

      // CALIBRATION: a name that is exported nowhere and called nowhere must read
      // as orphaned. Without this the assertion above also passes when the scan
      // silently matches everything — the exact way a guard stops guarding.
      expect(callSites('suSessionRuntimeHelperThatDoesNotExist', bodies)).toBe(0);
      // ...and a name that IS called must not read as orphaned, so the regex is
      // not simply failing to match.
      expect(callSites('classifySuSessionRuntime', bodies)).toBeGreaterThan(0);
    });
  });

  it('suppresses duplicate active launches by chat or adv identity, but permits ended rows', () => {
    expect(suppressDuplicateSuLaunch(record(), { agentChatId: 'chat-1' })).toBe(true);
    expect(suppressDuplicateSuLaunch(record(), { advSessionId: 41 })).toBe(true);
    expect(suppressDuplicateSuLaunch(record({ endedAt: '2026-08-28T01:00:00Z' }), { agentChatId: 'chat-1' })).toBe(false);
    expect(suppressDuplicateSuLaunch(record({ lifecycle: 'failed' }), { advSessionId: 41 })).toBe(false);
  });
});

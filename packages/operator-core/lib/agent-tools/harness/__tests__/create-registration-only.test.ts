/** Unit controls for the passive-registration contract; no checkout, git process or database. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { HarnessRegistry } from '../../../harness-registry';

const io = vi.hoisted(() => ({
  registry: { projects: [] } as HarnessRegistry,
  checkout: new Map<string, string>(),
  schemas: new Set<string>(),
  routines: new Set<string>(),
  head: 'a'.repeat(40),
  dirty: false,
  missing: false,
  nested: false,
  exec: vi.fn(),
  schema: vi.fn(),
  write: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: (...args: unknown[]) => io.exec(...args),
  });
  return { ...actual, execFile };
});
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    realpathSync: (path: string) => {
      if (!String(path).startsWith('/unit-proof/')) return actual.realpathSync(path);
      if (io.missing) throw new Error('ENOENT: unit checkout is absent');
      return path === '/unit-proof/alias' ? '/unit-proof/checkout' : path;
    },
    existsSync: (path: string) => String(path).startsWith('/unit-proof/') || actual.existsSync(path),
    mkdirSync: (path: string, ...rest: unknown[]) => {
      if (!String(path).startsWith('/unit-proof/')) {
        return actual.mkdirSync(path, ...(rest as [never]));
      }
      io.write(path);
      io.checkout.set(path, 'directory-created');
    },
    writeFileSync: (path: string, value: string, ...rest: unknown[]) => {
      if (!String(path).startsWith('/unit-proof/')) {
        return actual.writeFileSync(path, value, ...(rest as [never]));
      }
      io.write(path, value);
      io.checkout.set(path, String(value));
    },
  };
});
vi.mock('../../../harness-registry', async (original) => {
  const actual = await original<typeof import('../../../harness-registry')>();
  return {
    ...actual,
    loadHarnessRegistry: async () => structuredClone(io.registry),
    mutateHarnessRegistry: async (mutator: (r: HarnessRegistry) => HarnessRegistry, workspace: string) => {
      const next = mutator(structuredClone(io.registry));
      io.mutate(workspace);
      io.registry = structuredClone(next);
      return structuredClone(next);
    },
  };
});
vi.mock('../../../scaffold-harness-schema', () => ({
  scaffoldHarnessSchema: async (slug: string) => { io.schema(slug); io.schemas.add(slug); },
}));
vi.mock('../../../blueprint/materialize-triggers', () => ({
  materializeBlueprintTriggers: async () => [],
}));
vi.mock('../../blueprint/_resolve', () => ({
  resolveAndValidate: (blueprint: Record<string, unknown>) => ({
    ok: true,
    blueprint: { ...blueprint, knobs: { requiresRepo: false }, dependencies: {} },
    validation: { ok: true, errors: [], warnings: [] },
  }),
}));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => { throw new Error('Unit controls must not open a database'); },
  upsertRoutine: async (_sql: unknown, input: { installSlug: string }) => {
    io.routines.add(input.installSlug);
    return input;
  },
  setRoutineActive: async () => true,
}));

import tool from '../create';
import { resolveHarnessContentPath } from '../../../harness-registry';
import { gitSyncEligibility } from '../../../harness/git-sync/git-sync-eligibility';
import { reconcileGitSyncRoutines } from '../../../harness/git-sync/git-sync-reconcile';

const root = '/unit-proof/checkout';
const pin = 'a'.repeat(40);
const workspaceId = 'unit-registration-workspace';
const args = () => ({ slug: 'proof-root', path: root, registrationOnly: true, expectedCommit: pin });
const context = () => ({ workspaceId, principal: { workspaceId } }) as never;
const invoke = async (input: unknown = args(), ctx = context()) => {
  const parsed = tool.args.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_args' };
  const result = await tool.handler(parsed.data, ctx);
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
};
const reconcile = async (registry = io.registry) => reconcileGitSyncRoutines({
  workspaceId,
  loadRegistry: async () => structuredClone(registry),
  sql: (() => Promise.resolve([])) as unknown as Sql,
  getRoutine: async () => null,
  eligibility: (entry) => gitSyncEligibility(entry, { pathExists: () => true }),
});

beforeEach(() => {
  vi.clearAllMocks();
  io.registry = { projects: [] };
  io.checkout = new Map([['/unit-proof/checkout/input.txt', 'retained bytes']]);
  io.schemas = new Set(['existing-schema']);
  io.routines = new Set(['existing-routine']);
  io.head = pin;
  io.dirty = false;
  io.missing = false;
  io.nested = false;
  io.exec.mockImplementation(async (command: string, argv: string[]) => {
    expect(command).toBe('git');
    if (argv.includes('--show-toplevel')) {
      return { stdout: io.nested ? '/unit-proof' : argv[2], stderr: '' };
    }
    if (argv.includes('HEAD')) return { stdout: io.head, stderr: '' };
    if (argv.includes('status')) return { stdout: io.dirty ? '?? untracked.txt\n' : '', stderr: '' };
    throw new Error(`Unexpected unit git request: ${argv.join(' ')}`);
  });
});

describe('registration-only unit contract controls', () => {
  it('ADM-P006-ORDINARY-MANAGEMENT provisions the schema for ordinary managed creation', async () => {
    const slug = 'ordinary-control';
    const result = await invoke({
      slug,
      path: '/unit-proof/ordinary',
      blueprint: { id: slug },
    });

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, provisioning: { ok: true } });
    expect(io.schema).toHaveBeenCalledExactlyOnceWith(slug);
    expect(io.schemas).toEqual(new Set(['existing-schema', slug]));
    expect(io.registry.projects).toEqual([{ slug, path: '/unit-proof/ordinary' }]);
    expect(io.exec).not.toHaveBeenCalled();
  });

  it('ADM-P006-ROOT-LOOKUP resolves the canonical registered checkout', async () => {
    expect(await invoke({ ...args(), path: '/unit-proof/alias' })).toMatchObject({ ok: true, path: root });
    expect(resolveHarnessContentPath(io.registry, 'proof-root')).toBe(root);
    expect(resolveHarnessContentPath(io.registry, 'unregistered')).toBeUndefined();
  });

  it('ADM-P006-CHECKOUT-PRESERVATION leaves checkout bytes unchanged through retry and reconciliation', async () => {
    const before = new Map(io.checkout);
    expect(await invoke()).toMatchObject({ ok: true });
    expect(await invoke()).toMatchObject({ ok: true, existing: true });
    await reconcile();
    expect(io.checkout).toEqual(before);
    expect(io.write).not.toHaveBeenCalled();
  });

  it('ADM-P006-SCHEMA-PRESERVATION leaves the schema catalog unchanged through the lifecycle', async () => {
    const before = new Set(io.schemas);
    expect(await invoke()).toMatchObject({ ok: true });
    expect(await invoke()).toMatchObject({ ok: true });
    await reconcile();
    expect(io.schemas).toEqual(before);
    expect(io.schema).not.toHaveBeenCalled();
  });

  it('ADM-P006-ROUTINE-PRESERVATION excludes passive entries while an ordinary member seeds', async () => {
    io.registry.projects.push({ slug: 'unit-hive', path: '/unit-proof/hive', harness_kind: 'hive' });
    expect(await invoke({ ...args(), pot: 'unit-hive' })).toMatchObject({ ok: true });
    await reconcile();
    expect(io.routines).toEqual(new Set(['existing-routine']));
    await reconcile({ projects: [
      { slug: 'unit-hive', path: '/unit-proof/hive', harness_kind: 'hive' },
      { slug: 'managed-control', path: '/unit-proof/managed', hive_slug: 'unit-hive' },
    ] });
    expect(io.routines).toEqual(new Set(['existing-routine', 'managed-control']));
  });

  it('ADM-P006-IDEMPOTENT-RETRY returns the prior identity and preserves unrelated registration metadata', async () => {
    const first = await invoke();
    expect(first).toMatchObject({ ok: true, existing: false });
    io.registry.projects[0].harness_kind = 'retained-evidence-kind';
    const before = structuredClone(io.registry);
    expect(await invoke()).toMatchObject({
      ok: true, existing: true, slug: first.slug, path: first.path, commitSha: first.commitSha, workspaceId,
    });
    expect(io.registry).toEqual(before);
  });

  it.each(['slug', 'path', 'pin'])('ADM-P006-CONFLICT-REJECTION preserves the winner for a conflicting %s', async (kind) => {
    expect(await invoke()).toMatchObject({ ok: true });
    const before = structuredClone(io.registry);
    const request = args();
    if (kind === 'slug') request.slug = 'other-root';
    if (kind === 'path') request.path = '/unit-proof/other';
    if (kind === 'pin') request.expectedCommit = io.head = 'b'.repeat(40);
    expect(await invoke(request)).toMatchObject({ ok: false, error: 'registration_identity_conflict' });
    expect(io.registry).toEqual(before);
    expect(io.mutate).toHaveBeenCalledTimes(1);
  });

  it.each(['foreign-workspace', 'missing-workspace', 'missing-checkout', 'dirty', 'pin', 'nested', 'provisioning'])(
    'ADM-P006-INVALID-IDENTITY rejects %s before registry or managed effects', async (kind) => {
      const request: Record<string, unknown> = args();
      let ctx = context();
      if (kind === 'foreign-workspace') ctx = { workspaceId, principal: { workspaceId: 'foreign' } } as never;
      if (kind === 'missing-workspace') ctx = {} as never;
      if (kind === 'missing-checkout') io.missing = true;
      if (kind === 'dirty') io.dirty = true;
      if (kind === 'pin') request.expectedCommit = 'b'.repeat(40);
      if (kind === 'nested') io.nested = true;
      if (kind === 'provisioning') request.blueprintId = 'coding';
      expect(await invoke(request, ctx)).toMatchObject({ ok: false });
      expect(io.registry).toEqual({ projects: [] });
      expect(io.mutate).not.toHaveBeenCalled();
      expect(io.write).not.toHaveBeenCalled();
      expect(io.schema).not.toHaveBeenCalled();
      expect(io.schemas).toEqual(new Set(['existing-schema']));
      expect(io.routines).toEqual(new Set(['existing-routine']));
    },
  );
});

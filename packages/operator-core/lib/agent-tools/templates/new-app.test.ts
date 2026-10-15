/**
 * Coverage for templates:new-app's composition (WI-3198 / local-first-party-template-
 * bundling-2026-07-07). Hermetic: a mock `inner` stands in for the in-process
 * dispatcher (pot:create + agent_chats), and `resolveSource` yields a source whose
 * `acquireSourceDir` lays down a fixture template dir. The REAL materializeTemplateCore
 * + overlay run against temp dirs. Exercises: happy-path materialize + builder kickoff,
 * source-resolution passthrough, kickoffBuilder:false, and best-effort builder failure.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  promises as fs,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import newAppTool, { composeNewApp, ensureGitignore, type NewAppArgs, type NewAppDeps } from './new-app';
import type { TemplateListing, TemplateGuide } from '../../cupboard/templates';

const REF = 'papercusp-webapp';
const LISTING: TemplateListing = {
  id: 'be19a787-93f0-46ae-8f4d-85d728b7131b',
  ref: REF,
  title: 'Papercusp Official: Web App',
  description: 'A whole web app',
  githubUrl: 'https://github.com/Papercusp/templates',
};
const GUIDE: TemplateGuide = {
  ref: REF,
  branch: 'main',
  guide: '# Build it\nMUST: ship a homepage.',
  guideTruncated: false,
  componentCatalog: null,
  manifest: null,
  fetchedFiles: ['GUIDE.md'],
};

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'newapp-test-'));
});
afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
});

function baseArgs(over: Partial<NewAppArgs> = {}): NewAppArgs {
  return {
    template: REF,
    slug: 'my-app',
    kickoffBuilder: true,
    builderRole: 'architect',
    ...over,
  };
}

/**
 * A resolveSource that yields a source whose acquireSourceDir writes a fixture
 * `<srcDir>/` (GUIDE.md + package.json) to overlay — mirrors both the local (no-clone)
 * and remote (post-clone) shape, since composeNewApp is source-agnostic.
 */
function baseDeps(
  over: Partial<NewAppDeps> = {},
  packageJson: Record<string, unknown> = { name: 'webapp' },
): NewAppDeps {
  return {
    resolveSource: (async () => ({
      listing: { id: LISTING.id, ref: REF, title: LISTING.title },
      guide: GUIDE.guide,
      guideTruncated: GUIDE.guideTruncated,
      guideBranch: GUIDE.branch,
      sourceCheckout: { root: '/fake/checkout', sha: 'deadbeef', branch: 'main' },
      acquireSourceDir: async () => {
        const dir = join(scratch, 'src');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'GUIDE.md'), '# Build it\n');
        writeFileSync(join(dir, 'package.json'), JSON.stringify(packageJson));
        return { srcDir: dir, cleanup: async () => {} };
      },
    })) as NewAppDeps['resolveSource'],
    defaultParentDir: () => {
      const d = join(scratch, 'apps');
      mkdirSync(d, { recursive: true });
      return d;
    },
    ...over,
  };
}

/** A mock inner that mimics pot:create (makes the pot home dir) + agent_chats. */
function mockInner(
  opts: { failCreateChat?: boolean; blueprint?: string; beforeCreate?: (args: any) => void } = {},
) {
  const calls: Array<{ name: string; args: any }> = [];
  const inner = vi.fn(async (name: string, args: any) => {
    calls.push({ name, args });
    if (name === 'pot:create') {
      opts.beforeCreate?.(args);
      const path = join(args.parentDir ?? join(scratch, 'apps'), args.slug);
      // pot:create writes the hive (coding-pot) blueprint.yaml; overlay must
      // preserve it (PROTECTED_REL in overlayTemplateFiles).
      mkdirSync(join(path, '.papercusp'), { recursive: true });
      writeFileSync(
        join(path, '.papercusp', 'blueprint.yaml'),
        opts.blueprint ?? 'id: my-app\nextends: hive\n',
      );
      return { ok: true, slug: args.slug, path };
    }
    if (name === 'agent_chats:create') {
      if (opts.failCreateChat) throw new Error('gate: agent_chats:write denied');
      return { id: 'chat-abc', slug: args.slug };
    }
    if (name === 'agent_chats:send_message') return { ok: true, chatId: args.chatId };
    throw new Error(`unexpected inner call: ${name}`);
  });
  return { inner, calls };
}

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('composeNewApp', () => {
  it('materializes the template + kicks off a builder chat with the GUIDE', async () => {
    const { inner, calls } = mockInner();
    const result = await composeNewApp(baseArgs(), inner, baseDeps());
    const payload = parse(result);

    expect(payload.ok).toBe(true);
    expect(payload.harnessSlug).toBe('my-app');
    expect(payload.filesCopied).toEqual(
      expect.arrayContaining(['GUIDE.md', 'package.json', 'PROTOCOL.md']),
    );
    // MCP validates this contract after the durable materialization. A mismatch
    // would hide success from the caller and invite a duplicate create attempt.
    const outputSchema = (newAppTool as unknown as {
      result: { safeParse: (value: unknown) => { success: boolean } };
    }).result;
    expect(outputSchema.safeParse(payload).success).toBe(true);
    expect(outputSchema.safeParse({ ...payload, filesCopied: payload.filesCopied.length }).success).toBe(false);
    expect(payload.template).toMatchObject({ ref: REF, id: LISTING.id });
    expect(payload.guideBranch).toBe('main');
    expect(payload.sourceCheckout).toEqual({ root: '/fake/checkout', sha: 'deadbeef', branch: 'main' });
    expect(payload.builder).toMatchObject({ spawned: true, chatId: 'chat-abc', role: 'architect' });

    // template files really landed on the created dir.
    expect(existsSync(join(scratch, 'apps', 'my-app', 'package.json'))).toBe(true);
    // pot:create's blueprint.yaml survived the overlay.
    expect(existsSync(join(scratch, 'apps', 'my-app', '.papercusp', 'blueprint.yaml'))).toBe(true);
    const protocolPath = join(scratch, 'apps', 'my-app', 'PROTOCOL.md');
    expect(readFileSync(protocolPath, 'utf8')).toContain('papercusp-webapp');

    // dispatch order: create pot → create chat → send GUIDE.
    expect(calls.map((c) => c.name)).toEqual([
      'pot:create',
      'agent_chats:create',
      'agent_chats:send_message',
    ]);
    const sent = calls.find((c) => c.name === 'agent_chats:send_message')!;
    expect(sent.args.content).toContain('read PROTOCOL.md first, then GUIDE.md');
    expect(sent.args.content).toContain('MUST: ship a homepage.');
    expect(calls[0].args).toMatchObject({
      slug: 'my-app',
      repoRemote: 'local-only',
      knowledgePack: 'none',
    });
  });

  it('passes through a source-resolution error', async () => {
    const { inner } = mockInner();
    const result = await composeNewApp(
      baseArgs({ template: 'no-such' }),
      inner,
      baseDeps({
        resolveSource: (async () => ({
          error: 'template not found in the local store: no-such',
          status: 404,
        })) as NewAppDeps['resolveSource'],
      }),
    );
    const payload = parse(result);
    expect(payload).toMatchObject({ ok: false, status: 404 });
    expect(inner).not.toHaveBeenCalled();
  });

  it('with kickoffBuilder:false, materializes but spawns no builder', async () => {
    const { inner, calls } = mockInner();
    const result = await composeNewApp(baseArgs({ kickoffBuilder: false }), inner, baseDeps());
    const payload = parse(result);
    expect(payload.ok).toBe(true);
    expect(payload.builder).toEqual({ spawned: false });
    expect(existsSync(join(scratch, 'apps', 'my-app', 'PROTOCOL.md'))).toBe(true);
    expect(calls.map((c) => c.name)).toEqual(['pot:create']);
  });

  it('creates an explicit missing parentDir before pot:create', async () => {
    const customParent = join(scratch, 'nested', 'custom-parent');
    const { inner } = mockInner({
      beforeCreate: (args) => expect(existsSync(args.parentDir)).toBe(true),
    });

    const result = await composeNewApp(
      baseArgs({ parentDir: customParent, kickoffBuilder: false }),
      inner,
      baseDeps(),
    );
    const payload = parse(result);

    expect(payload.ok).toBe(true);
    expect(existsSync(customParent)).toBe(true);
  });

  it('pins the pot release gate to the materialized host-independent check instead of a missing build script', async () => {
    const { inner } = mockInner();
    const result = await composeNewApp(
      baseArgs({ kickoffBuilder: false }),
      inner,
      baseDeps({}, {
        name: 'mobile-app',
        scripts: {
          'check:gate': 'node checks/run-gate.mjs checks/composition-integrity.test.ts',
          'check:union': 'node checks/run-gate.mjs checks/',
        },
      }),
    );
    const payload = parse(result);

    expect(payload.releaseGateTestCommand).toEqual({
      command: 'npm run check:gate',
      updated: true,
    });
    expect(readFileSync(join(scratch, 'apps', 'my-app', '.papercusp', 'blueprint.yaml'), 'utf8')).toContain(
      'testCommand: npm run check:gate',
    );
  });

  it('preserves an explicit blueprint testCommand over a materialized package default', async () => {
    const { inner } = mockInner({
      blueprint: 'id: my-app\nextends: hive\nknobs:\n  testCommand: npm run gate:custom\n',
    });
    const result = await composeNewApp(
      baseArgs({ kickoffBuilder: false }),
      inner,
      baseDeps({}, {
        name: 'mobile-app',
        scripts: {
          'check:gate': 'node checks/run-gate.mjs checks/composition-integrity.test.ts',
          'check:union': 'node checks/run-gate.mjs checks/',
        },
      }),
    );
    const payload = parse(result);

    expect(payload.releaseGateTestCommand).toEqual({
      command: 'npm run gate:custom',
      updated: false,
    });
    expect(readFileSync(join(scratch, 'apps', 'my-app', '.papercusp', 'blueprint.yaml'), 'utf8')).toContain(
      'testCommand: npm run gate:custom',
    );
  });

  it('still succeeds when the builder kickoff fails (best-effort)', async () => {
    const { inner } = mockInner({ failCreateChat: true });
    const result = await composeNewApp(baseArgs(), inner, baseDeps());
    const payload = parse(result);
    expect(payload.ok).toBe(true);
    expect(payload.harnessSlug).toBe('my-app');
    expect(payload.builder).toMatchObject({ spawned: false });
    expect(payload.builder.error).toContain('denied');
  });

  it('surfaces a pot:create failure as ok:false', async () => {
    const calls: string[] = [];
    const inner = vi.fn(async (name: string) => {
      calls.push(name);
      if (name === 'pot:create') return { ok: false, error: 'slug already exists' };
      throw new Error(`unexpected: ${name}`);
    });
    const result = await composeNewApp(baseArgs(), inner, baseDeps());
    const payload = parse(result);
    expect(payload).toMatchObject({ ok: false, status: 422 });
    expect(payload.error).toContain('slug already exists');
    // no builder dispatch after a failed create.
    expect(calls).toEqual(['pot:create']);
  });

  it('surfaces a THROWN pot:create (handler_error plain-text envelope) instead of "unknown error"', async () => {
    // A sub-handler throw reaches the compound via unwrap() as a PLAIN STRING
    // (`handler_error: …`) — not a { error } object. The owner-hit regression
    // (2026-07-07) reported "unknown error" and sent the agent chasing ghosts.
    const inner = vi.fn(async (name: string) => {
      if (name === 'pot:create') return 'handler_error: ENOSPC: no space left on device';
      throw new Error(`unexpected: ${name}`);
    });
    const result = await composeNewApp(baseArgs(), inner, baseDeps());
    const payload = parse(result);
    expect(payload).toMatchObject({ ok: false, status: 422 });
    expect(payload.error).toContain('handler_error: ENOSPC: no space left on device');
    expect(payload.error).not.toContain('unknown error');
  });
});

/**
 * WI-37768 — pot:create is the first DURABLE step. Anything that throws after it used
 * to strand the slug, which made the caller's natural recovery (retry, same args) the
 * one move that provably could not work: pot:create answers slug_exists forever.
 *
 * Measured 2026-08-10: a PgBouncer `write CONNECTION_CLOSED` mid-call, then an
 * identical retry rejected with 422 slug_exists.
 */
describe('composeNewApp — compensating rollback after a durable create (WI-37768)', () => {
  /** An inner whose pot:create succeeds; obliterate is recorded (and can be made to fail). */
  function rollbackInner(
    opts: { failObliterate?: boolean; createThrows?: unknown; createReturnsFailure?: { error: string; message?: string } } = {},
  ) {
    const calls: Array<{ name: string; args: any }> = [];
    const inner = vi.fn(async (name: string, args: any) => {
      calls.push({ name, args });
      if (name === 'pot:create') {
        if (opts.createThrows !== undefined) throw opts.createThrows;
        if (opts.createReturnsFailure) return { ok: false, ...opts.createReturnsFailure };
        const path = join(args.parentDir ?? join(scratch, 'apps'), args.slug);
        mkdirSync(path, { recursive: true });
        return { ok: true, slug: args.slug, path };
      }
      if (name === 'pot:obliterate') {
        if (opts.failObliterate) return { ok: false, error: 'schema drop blocked' };
        return { ok: true, slug: args.slug, obliterated: true };
      }
      if (name === 'agent_chats:create') return { id: 'chat-abc' };
      if (name === 'agent_chats:send_message') return { ok: true };
      throw new Error(`unexpected inner call: ${name}`);
    });
    return { inner, calls };
  }

  /** Deps whose source dir does not exist → the OVERLAY throws, after pot:create committed. */
  function overlayFailingDeps(): NewAppDeps {
    return baseDeps({
      resolveSource: (async () => ({
        listing: { id: LISTING.id, ref: REF, title: LISTING.title },
        guide: GUIDE.guide,
        guideTruncated: false,
        guideBranch: GUIDE.branch,
        sourceCheckout: null,
        acquireSourceDir: async () => ({
          srcDir: join(scratch, 'does-not-exist'),
          cleanup: async () => {},
        }),
      })) as NewAppDeps['resolveSource'],
    });
  }

  it('rolls the pot back when a step AFTER pot:create fails, so the retry is unblocked', async () => {
    const { inner, calls } = rollbackInner();
    const customParent = join(scratch, 'custom-parent');
    mkdirSync(customParent, { recursive: true });
    const result = await composeNewApp(baseArgs({ parentDir: customParent }), inner, overlayFailingDeps());
    const payload = parse(result);

    expect(payload.ok).toBe(false);
    // The pot really was obliterated — the point of the fix, not just a nicer message.
    expect(calls.map((c) => c.name)).toEqual(['pot:create', 'pot:obliterate']);
    expect(calls[1].args).toMatchObject({ slug: 'my-app', confirm: true });
    expect(existsSync(join(customParent, 'my-app'))).toBe(false);
    // And the caller is TOLD the retry is now safe, rather than having to infer it.
    expect(payload.error).toContain('ROLLED BACK');
    expect(payload.error).toContain('retrying with the same slug is safe');
  });

  it('rolls back when pot:create itself THROWS (the observed PgBouncer failure)', async () => {
    // pot:create commits its registry row before it finishes, so a throw can leave a
    // pot behind with the caller holding no result at all.
    const { inner, calls } = rollbackInner({
      createThrows: new Error('write CONNECTION_CLOSED 127.0.0.1:6432'),
    });
    const result = await composeNewApp(baseArgs(), inner, baseDeps());
    const payload = parse(result);

    expect(payload.ok).toBe(false);
    expect(calls.map((c) => c.name)).toEqual(['pot:create', 'pot:obliterate']);
    expect(payload.error).toContain('CONNECTION_CLOSED');
    expect(payload.error).toContain('ROLLED BACK');
  });

  it('rolls back when pot:create returns { ok:false } WITHOUT throwing — the connection-level class (EI-21107910194803524)', async () => {
    // createPotHarness's own outer catch already ran its BEST-EFFORT internal
    // rollback() and returned { ok:false } as ordinary business data (never a
    // thrown error) — exactly what a connection-level fault mid-provisioning
    // produces when createPotHarness's OWN rollback silently fails to fully
    // revert (each undo step is individually try/catch-swallowed). Before this
    // fix, composeNewApp threw a bare error on THIS path with no compensation
    // attempt at all, stranding the schema/registry/checkout the same way the
    // THROWN-error case (the test above) already covers.
    const { inner, calls } = rollbackInner({
      createReturnsFailure: { error: 'create_failed', message: 'write CONNECTION_CLOSED 127.0.0.1:6432' },
    });
    const result = await composeNewApp(baseArgs(), inner, baseDeps());
    const payload = parse(result);

    expect(payload.ok).toBe(false);
    // The pot really was obliterated — not just a differently-worded failure.
    expect(calls.map((c) => c.name)).toEqual(['pot:create', 'pot:obliterate']);
    expect(calls[1].args).toMatchObject({ slug: 'my-app', confirm: true });
    expect(payload.error).toContain('CONNECTION_CLOSED');
    expect(payload.error).toContain('ROLLED BACK');
    expect(payload.error).toContain('retrying with the same slug is safe');
  });

  it('NEVER rolls back on slug_exists — that pot belongs to an earlier call', async () => {
    // The one case where compensating would destroy a project this call never created.
    // If this test ever goes green while an obliterate is dispatched, the fix has become
    // a data-loss bug.
    const { inner, calls } = rollbackInner({
      createThrows: new Error("slug_exists: A harness 'my-app' already exists in this workspace."),
    });
    const result = await composeNewApp(baseArgs(), inner, baseDeps());
    const payload = parse(result);

    expect(payload).toMatchObject({ ok: false, status: 422 });
    expect(calls.map((c) => c.name)).toEqual(['pot:create']);
    expect(inner).not.toHaveBeenCalledWith('pot:obliterate', expect.anything());
    // ...and it says why retrying unchanged is pointless, which the bare passthrough did not.
    expect(payload.error).toContain('RETRYING THIS CALL UNCHANGED CANNOT SUCCEED');
    expect(payload.error).toContain('pot:obliterate');
  });

  it('reports honestly when the rollback ALSO fails (the slug is still taken)', async () => {
    // The failure that triggers a rollback is often the same thing that breaks it — a
    // dropped PG connection cannot be used to un-write. Saying "rolled back" here would
    // send the caller into a retry that cannot succeed.
    const { inner, calls } = rollbackInner({ failObliterate: true });
    const result = await composeNewApp(baseArgs(), inner, overlayFailingDeps());
    const payload = parse(result);

    expect(payload.ok).toBe(false);
    expect(calls.map((c) => c.name)).toEqual(['pot:create', 'pot:obliterate']);
    expect(payload.error).toContain('ROLLBACK ALSO FAILED');
    expect(payload.error).toContain('still taken');
    expect(payload.error).not.toContain('is safe');
  });
});

/**
 * P-005 / WI-37791 — the per-install component-package path reaches the builder.
 *
 * The GUIDE ships one text to every platform and can only cite the dev-checkout
 * example, so the resolved root has to be injected at kickoff time. A builder that
 * never sees it writes `file:../papercusp/libs/generic/<pkg>` and fails npm install
 * on packages that are all private — which is the bug this closes.
 */
describe('composeNewApp — libs/generic supply chain', () => {
  const withTree: NewAppDeps['resolveSupplyChain'] = () => ({
    root: '/opt/install/dev-source/libs/generic',
    sourceRoot: '/opt/install/dev-source',
    source: 'dev-source-tree',
    pending: false,
    available: ['sync', 'ui-primitives'],
    explanation: 'RESOLVED-ROOT-EXPLANATION',
  });
  const noTree: NewAppDeps['resolveSupplyChain'] = () => ({
    root: null,
    sourceRoot: null,
    source: 'none',
    pending: false,
    available: [],
    explanation: 'CANNOT be file:-linked here — NO-TREE-EXPLANATION',
  });

  it('reports the resolved root on the result AND in the builder kickoff', async () => {
    const { inner, calls } = mockInner();
    const result = await composeNewApp(
      baseArgs(),
      inner,
      baseDeps({ resolveSupplyChain: withTree }),
    );
    const payload = parse(result);

    expect(payload.supplyChain).toMatchObject({
      root: '/opt/install/dev-source/libs/generic',
      source: 'dev-source-tree',
    });
    const sent = calls.find((c) => c.name === 'agent_chats:send_message')!;
    expect(sent.args.content).toContain('/opt/install/dev-source/libs/generic');
    // The GUIDE still leads; the supply-chain correction follows it.
    expect(sent.args.content.indexOf('MUST: ship a homepage.')).toBeLessThan(
      sent.args.content.indexOf('/opt/install/dev-source/libs/generic'),
    );
  });

  it('tells the builder plainly when this install has NO tree, rather than staying silent', async () => {
    const { inner, calls } = mockInner();
    const result = await composeNewApp(baseArgs(), inner, baseDeps({ resolveSupplyChain: noTree }));

    expect(parse(result).supplyChain).toMatchObject({ root: null, source: 'none' });
    const sent = calls.find((c) => c.name === 'agent_chats:send_message')!;
    expect(sent.args.content).toContain('NO-TREE-EXPLANATION');
    // Never the dev-checkout path as an instruction.
    expect(sent.args.content).not.toContain('"file:../papercusp/libs/generic');
  });

  it('still reports the supply chain when no builder is kicked off', async () => {
    const { inner } = mockInner();
    const result = await composeNewApp(
      baseArgs({ kickoffBuilder: false }),
      inner,
      baseDeps({ resolveSupplyChain: withTree }),
    );
    expect(parse(result).supplyChain.root).toBe('/opt/install/dev-source/libs/generic');
  });
});

/**
 * EI-21854247573857420 recurrence guard: a materialized app tree MUST end up with a
 * .gitignore covering dependency installs + framework build output — a missing one let
 * the portal's own git track node_modules/ (535MB) + .next/ (314MB) and blow git-sync's
 * 250MB peel limit. composeNewApp calls ensureGitignore(materialized.path); these pin
 * its three documented behaviors so the class cannot silently return.
 */
describe('ensureGitignore (EI-21854247573857420 recurrence guard)', () => {
  it('creates a .gitignore covering the incident class when the template ships none', async () => {
    const root = join(scratch, 'app-no-gitignore');
    mkdirSync(root, { recursive: true });
    const result = await ensureGitignore(root);
    expect(result.created).toBe(true);
    expect(result.path).toBe(join(root, '.gitignore'));
    const content = readFileSync(result.path, 'utf8');
    // The exact patterns whose absence caused the portal peel incident.
    expect(content).toMatch(/^node_modules\/$/m);
    expect(content).toMatch(/^\.next\/$/m);
    expect(content).toMatch(/^dist\/$/m);
    expect(content).toMatch(/^coverage\/$/m);
  });

  it('preserves a template-provided .gitignore byte-identical', async () => {
    const root = join(scratch, 'app-with-gitignore');
    mkdirSync(root, { recursive: true });
    const custom = '# template-owned\nvendor/\n';
    writeFileSync(join(root, '.gitignore'), custom, 'utf8');
    const result = await ensureGitignore(root);
    expect(result.created).toBe(false);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(custom);
  });

  it('treats an existing-but-empty .gitignore as deliberate, not a broken artifact', async () => {
    const root = join(scratch, 'app-empty-gitignore');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '.gitignore'), '', 'utf8');
    const result = await ensureGitignore(root);
    expect(result.created).toBe(false);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('');
  });
});

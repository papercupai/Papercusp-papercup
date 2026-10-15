/**
 * install-datatype-io — the seam where Cupboard DISTRIBUTION meets registry RESOLUTION
 * (P-027 / D-010).
 *
 * The property under test is the one D-010 turns on: a datatype is usable only when its
 * `datatype_registry` row exists, so "package on disk" and "install succeeded" must not be
 * the same claim. Each gate below carries a POSITIVE CONTROL — an all-green run has to be
 * impossible to obtain from a seam that rejects (or accepts) everything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fixtureRepo = '';
let resolvedVersion = '1.0.0';
let resolveFails = false;

// importOriginal + spread, NOT a hand-listed factory: a factory listing only the exports
// this test happened to need makes every OTHER export `undefined` the moment the module
// under test reaches for one — while still typechecking, because a vi.mock factory is not
// checked against the real module. That is what red-pinned the gate on install-theme-io
// (WI-10001674). Spreading `actual` means a newly-added export cannot strand this file.
vi.mock('./install-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./install-io')>();
  const cloneRepo = async (_url: string, dest: string): Promise<void> => {
    await fs.cp(fixtureRepo, dest, { recursive: true });
  };
  return {
    ...actual,
    gitCloneShallow: cloneRepo,
    cupboardGitDeps: () => ({ ...actual.cupboardGitDeps(), cloneRepo }),
  };
});
vi.mock('./resolve-listing-by-kind', () => ({
  resolveListingByKind: async (_idOrRef: string, kind: string) => {
    if (resolveFails) return { error: `no ${kind} listing found`, status: 404 };
    return {
      githubUrl: 'https://github.com/acme/datatypes',
      ref: 'incident-report',
      listingId: 'listing-incident-report',
      releaseVersion: resolvedVersion,
    };
  },
}));

import { _resetPapercuspRootForTests } from '../papercusp-root';
import { installDatatypeFromCupboard, registryInputFromPackage } from './install-datatype-io';
import { resolveInstalledDatatype, type InstalledDatatype } from './datatype-store';

let root = '';

/** Write a self-describing `datatype` package into the fixture mirror. */
async function writePackage(opts: { id?: string; version?: string; kind?: string } = {}): Promise<void> {
  const dir = join(fixtureRepo, 'incident-report');
  await fs.mkdir(dir, { recursive: true });
  const id = opts.id ?? 'incident-report';
  const version = opts.version ?? '1.0.0';
  await fs.writeFile(
    join(dir, 'datatype.json'),
    JSON.stringify({
      schemaVersion: 1,
      id,
      title: 'Incident Report',
      description: 'A postmortem-shaped work item.',
      version,
      tier: 'generic-kind',
      workItemKind: opts.kind ?? 'incident-report',
      // P-010 survives the distribution boundary: readDatatypeDir REFUSES a
      // self-improving tier that ships no selfImprovement block, so omitting this
      // makes the package unparseable rather than merely incomplete.
      selfImprovement: { cadence: 'per-close', signal: 'postmortem-quality' },
      tags: ['ops'],
    }),
  );
  await fs.writeFile(
    join(dir, 'listing.json'),
    JSON.stringify({
      kind: 'datatype',
      ref: 'incident-report',
      title: 'Incident Report',
      version,
      source: 'https://github.com/acme/datatypes',
    }),
  );
}

/** A seeder that records what the registry was asked to write. */
function recordingSeeder() {
  const writes: Array<{ id: string; workspaceId: string; tier: string; workItemKind?: string }> = [];
  return {
    writes,
    deps: {
      seedRegistry: async (input: Parameters<NonNullable<Parameters<typeof installDatatypeFromCupboard>[1]>['seedRegistry']>[0]) => {
        writes.push({
          id: input.id,
          workspaceId: input.workspaceId,
          tier: input.tier,
          ...(input.workItemKind ? { workItemKind: input.workItemKind } : {}),
        });
        return { id: input.id };
      },
    },
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'pc-datatype-io-'));
  fixtureRepo = await fs.mkdtemp(join(tmpdir(), 'pc-datatype-mirror-'));
  // PAPERCUSP_HOME, not PAPERCUSP_ROOT: `papercuspRoot()` reads PAPERCUSP_HOME and IGNORES
  // PAPERCUSP_ROOT entirely, so setting the latter isolates NOTHING — the install silently
  // lands in the live workspace layer (~/.papercusp-workspaces/<ws>/.papercusp/datatypes/
  // installed) and PERSISTS, which then 409s every later run as "already installed".
  process.env.PAPERCUSP_HOME = join(root, 'home');
  _resetPapercuspRootForTests();
  resolvedVersion = '1.0.0';
  resolveFails = false;
});

afterEach(async () => {
  delete process.env.PAPERCUSP_HOME;
  _resetPapercuspRootForTests();
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(fixtureRepo, { recursive: true, force: true });
});

describe('installDatatypeFromCupboard', () => {
  it('installs the package AND seeds the registry row — the two halves of D-010', async () => {
    await writePackage();
    const seeder = recordingSeeder();

    const result = await installDatatypeFromCupboard(
      { listingId: 'listing-incident-report', workspaceId: 'ws-1', createdBy: 'agent-7' },
      seeder.deps,
    );

    // toMatchObject, not `.ok === true`: on failure it prints the WHOLE result, so a
    // refusal names its own status/error/detail instead of "expected false to be true".
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    // Distribution half: the package is resolvable on disk.
    expect(result.result.operation).toBe('install');
    expect(resolveInstalledDatatype(result.result.ref)).not.toBeNull();
    // Resolution half: exactly one registry write, into the CALLER's workspace.
    expect(seeder.writes).toEqual([
      { id: 'incident-report', workspaceId: 'ws-1', tier: 'generic-kind', workItemKind: 'incident-report' },
    ]);
    expect(result.result.registryId).toBe('incident-report');
  });

  it('reports a FAILED install when the registry seed throws — a package with no row is inert', async () => {
    await writePackage();

    const result = await installDatatypeFromCupboard(
      { listingId: 'listing-incident-report', workspaceId: 'ws-1' },
      {
        seedRegistry: async () => {
          throw new Error('pool exhausted');
        },
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(500);
    expect(result.error).toMatch(/registry row could not be seeded/);
    expect(result.detail).toMatch(/pool exhausted/);
    // POSITIVE CONTROL: the identical install with a working seeder succeeds, so the
    // refusal above is attributable to the seed and not to a broken fixture.
    const ok = await installDatatypeFromCupboard(
      { listingId: 'listing-incident-report', workspaceId: 'ws-1', update: true },
      recordingSeeder().deps,
    );
    expect(ok.ok).toBe(true);
  });

  it('REFUSES a non-canonical package id at the parse gate, seeding nothing', async () => {
    // Identity is enforced by readDatatypeDir, not by this seam: a manifest id that is not
    // already its canonical slug makes the PACKAGE invalid, so the install never reaches the
    // registry. That is the stronger refusal — re-slugifying here would install a package
    // under an identity its own author never published.
    await writePackage({ id: 'Incident Report' });
    const seeder = recordingSeeder();

    const result = await installDatatypeFromCupboard(
      { listingId: 'listing-incident-report', workspaceId: 'ws-1' },
      seeder.deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
    expect(result.error).toMatch(/failed to parse its datatype\.json/);
    expect(seeder.writes).toEqual([]);
  });

  it('REFUSES a self-improving tier shipped without selfImprovement (P-010 crosses the boundary)', async () => {
    const dir = join(fixtureRepo, 'incident-report');
    await writePackage();
    const manifest = JSON.parse(await fs.readFile(join(dir, 'datatype.json'), 'utf8')) as Record<string, unknown>;
    delete manifest.selfImprovement;
    await fs.writeFile(join(dir, 'datatype.json'), JSON.stringify(manifest));
    const seeder = recordingSeeder();

    const result = await installDatatypeFromCupboard(
      { listingId: 'listing-incident-report', workspaceId: 'ws-1' },
      seeder.deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
    expect(seeder.writes).toEqual([]);

    // POSITIVE CONTROL: restoring the block makes the identical install succeed, so the
    // refusal is attributable to the missing block and not to the fixture at large.
    await writePackage();
    const ok = await installDatatypeFromCupboard(
      { listingId: 'listing-incident-report', workspaceId: 'ws-1' },
      seeder.deps,
    );
    expect(ok.ok).toBe(true);
  });

  it('re-seeds on a version-matched no-op, so a package stranded by an earlier failed seed recovers', async () => {
    await writePackage();
    const first = recordingSeeder();
    const installed = await installDatatypeFromCupboard(
      { listingId: 'listing-incident-report', workspaceId: 'ws-1' },
      first.deps,
    );
    expect(installed.ok).toBe(true);

    const second = recordingSeeder();
    const again = await installDatatypeFromCupboard(
      { listingId: 'listing-incident-report', workspaceId: 'ws-1' },
      second.deps,
    );

    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.result.operation).toBe('no-op');
    // The row is re-written even though no bytes moved — presence of the package is not
    // evidence about the row.
    expect(second.writes).toHaveLength(1);
    expect(second.writes[0]?.id).toBe('incident-report');
  });

  it('refuses a re-install of a DIFFERENT version without update:true', async () => {
    await writePackage();
    const ok = await installDatatypeFromCupboard(
      { listingId: 'listing-incident-report', workspaceId: 'ws-1' },
      recordingSeeder().deps,
    );
    expect(ok.ok).toBe(true);

    resolvedVersion = '2.0.0';
    await writePackage({ version: '2.0.0' });
    const seeder = recordingSeeder();
    const result = await installDatatypeFromCupboard(
      { listingId: 'listing-incident-report', workspaceId: 'ws-1' },
      seeder.deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.error).toMatch(/already installed/);
    expect(seeder.writes).toEqual([]);

    // POSITIVE CONTROL: update:true is accepted and re-seeds.
    const updated = await installDatatypeFromCupboard(
      { listingId: 'listing-incident-report', workspaceId: 'ws-1', update: true },
      seeder.deps,
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.result.operation).toBe('update');
    expect(updated.result.version).toBe('2.0.0');
    expect(seeder.writes).toHaveLength(1);
  });

  it('requires a workspaceId, and surfaces a listing-resolution failure unchanged', async () => {
    await writePackage();
    const seeder = recordingSeeder();

    const noWorkspace = await installDatatypeFromCupboard(
      { listingId: 'listing-incident-report', workspaceId: '  ' },
      seeder.deps,
    );
    expect(noWorkspace.ok).toBe(false);
    if (!noWorkspace.ok) expect(noWorkspace.error).toMatch(/workspaceId required/);

    resolveFails = true;
    const unresolvable = await installDatatypeFromCupboard(
      { listingId: 'missing', workspaceId: 'ws-1' },
      seeder.deps,
    );
    expect(unresolvable.ok).toBe(false);
    if (!unresolvable.ok) {
      expect(unresolvable.status).toBe(404);
      expect(unresolvable.error).toMatch(/no datatype listing found/);
    }
    expect(seeder.writes).toEqual([]);

    // POSITIVE CONTROL: with a workspace and a resolvable listing the same call succeeds.
    resolveFails = false;
    const ok = await installDatatypeFromCupboard(
      { listingId: 'listing-incident-report', workspaceId: 'ws-1' },
      seeder.deps,
    );
    expect(ok.ok).toBe(true);
  });
});

describe('registryInputFromPackage', () => {
  it('derives legacy nature while omitting absent optional fields', () => {
    const pkg = {
      installed: true,
      packageRef: 'ref',
      listingRef: 'incident-report',
      installedId: 'installed:abc',
      id: 'incident-report',
      title: 'Incident Report',
      description: 'desc',
      version: '1.0.0',
      tier: 'generic-kind',
      workItemKind: null,
      payloadSchema: null,
      display: null,
      authoritativeWriter: null,
      selfImprovement: null,
      tags: [],
      source: 'https://github.com/acme/datatypes',
      dir: '/tmp/x',
    } as unknown as InstalledDatatype;

    const input = registryInputFromPackage(pkg, 'ws-1');

    expect(input).toEqual({
      id: 'incident-report',
      workspaceId: 'ws-1',
      title: 'Incident Report',
      description: 'desc',
      tier: 'generic-kind',
      nature: 'work',
      audience: 'agent',
      tags: [],
    });
    expect('workItemKind' in input).toBe(false);
    expect('createdBy' in input).toBe(false);

    // POSITIVE CONTROL: a package that DOES carry the optional fields passes them through,
    // so the assertion above cannot pass merely because the mapper drops everything.
    const full = registryInputFromPackage(
      {
        ...pkg,
        nature: 'work',
        audience: 'human',
        workItemKind: 'incident-report',
        display: { widget: 'text', summary: '{{title}}' },
      } as unknown as InstalledDatatype,
      'ws-1',
      'agent-7',
    );
    expect(full.workItemKind).toBe('incident-report');
    expect(full.display).toEqual({ widget: 'text', summary: '{{title}}' });
    expect(full.createdBy).toBe('agent-7');
    expect(full.nature).toBe('work');
    expect(full.audience).toBe('human');
    // An explicitly declared record must survive even on a legacy work tier.
    const record = registryInputFromPackage(
      { ...pkg, nature: 'record', audience: null } as unknown as InstalledDatatype,
      'ws-1',
    );
    expect(record.nature).toBe('record');
    expect(record.audience).toBeNull();
  });

  it('refuses a package whose display is not a valid DatatypeDisplaySpec', () => {
    const pkg = {
      id: 'incident-report',
      title: 'Incident Report',
      tier: 'generic-kind',
      // `icon` is not part of the display contract at all: the spec is a FORM schema
      // discriminated on `widget`, so this object cannot name a renderer.
      display: { icon: 'x' },
      tags: [],
      dir: '/tmp/x',
    } as unknown as InstalledDatatype;

    expect(() => registryInputFromPackage(pkg, 'ws-1')).toThrow(/invalid display spec/);
  });
});

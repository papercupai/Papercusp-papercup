import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_MAX_AGE_HOURS,
  AGENT_ROOT_MAX_BYTES,
  BUILD_DIR_MAX_AGE_HOURS,
  CACHEDIR_TAG_SIGNATURE,
  RETENTION_POLICY,
  retentionPolicyForWorkspaceRoot,
  buildDirsEligible,
  isBuildDirName,
  isCacheDirTag,
  compilePolicy,
  classifyPath,
  deletionClassFor,
  mapCensusConsumers,
  validatePolicy,
  isDeletableRule,
  type RetentionClass,
} from './retention-policy';

const HOME = '/hm/agent';
const policy = compilePolicy(RETENTION_POLICY, HOME);
const del = (p: string) => deletionClassFor(p, policy)?.id ?? null;

describe('retention policy (disk-headroom P-003 / R-2)', () => {
  it('the shipped policy passes every structural check', () => {
    expect(validatePolicy(RETENTION_POLICY, HOME)).toEqual([]);
  });

  it('materializes checkout retention roots from PAPERCUSP_WORKSPACE_ROOT', () => {
    vi.stubEnv('PAPERCUSP_WORKSPACE_ROOT', '/srv/custom-workspaces/');
    try {
      const roots = retentionPolicyForWorkspaceRoot().flatMap((cls) => cls.roots);
      expect(roots).toContain('/srv/custom-workspaces/*');
      expect(roots).toContain('/srv/custom-workspaces/papercusp-relcut-*');
      expect(roots).toContain('/srv/custom-workspaces/*/.papercusp/scratch');
      expect(roots).toContain('/srv/custom-workspaces/papercusp-staging.generations');
      expect(roots.some((root) => root.includes('__PAPERCUSP_WORKSPACE_ROOT__'))).toBe(false);
      expect(roots.some((root) => root.startsWith('~/papercupai-workspace/'))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('declares the same finite cap enforced by the private Cargo-slot owner', () => {
    const cls = RETENTION_POLICY.find(cls => cls.id === 'cargo-target-slots')!;
    const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const owner = readFileSync(join(root, 'papercusp-desktop/bin/lib/claim-target-dir.sh'), 'utf8');
    const defaultBytes = /PAPERCUSP_DESKTOP_PRIVATE_SLOT_MAX_BYTES:-([0-9]+)/.exec(owner);
    expect(cls.keep.kind).toBe('lease');
    expect(cls.maxBytes).toBe(AGENT_ROOT_MAX_BYTES);
    expect(Number(defaultBytes?.[1])).toBe(cls.maxBytes);
  });

  it('declares a finite cap for the existing release-cut owner', () => {
    const cls = RETENTION_POLICY.find(cls => cls.id === 'release-cut-worktrees')!;
    expect(cls.keep.kind).toBe('lease');
    expect(cls.maxBytes).toBe(AGENT_ROOT_MAX_BYTES);
  });

  it('keeps historical and data-side release evidence under the same native retention owner', () => {
    const cls = RETENTION_POLICY.find(cls => cls.id === 'vh-release-runs')!;
    expect(cls.keep).toEqual({ kind: 'newest', keep: 30 });
    expect(cls.enforcers).toEqual([expect.objectContaining({ kind: 'existing' })]);
    for (const root of [`${HOME}/.local/state/verification-harness/release-local`,
      '/mnt/data/offload/verification-harness/release-local']) {
      expect(classifyPath(`${root}/20261016T000000Z-1/result.json`, policy)).toMatchObject({ classId: cls.id });
      expect(del(`${root}/20261016T000000Z-1/result.json`)).toBe(cls.id);
    }
  });

  it('derives every named shell enforcer from the registry and pins its reviewed executable source', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const scripts = RETENTION_POLICY.flatMap((cls) => cls.enforcers.flatMap((enforcer) => {
      const ref = enforcer.kind === 'existing' ? enforcer.ref : enforcer.kind === 'standing-reclaim' ? enforcer.via : undefined;
      const path = ref?.split(' ')[0];
      return path?.endsWith('.sh') ? [{ cls, enforcer, path }] : [];
    }));
    expect(scripts.length).toBeGreaterThan(0);
    for (const { cls, enforcer, path } of scripts) {
      const bytes = readFileSync(join(root, path.replace(/^papercusp\//, '')));
      expect('sourceSha256' in enforcer && enforcer.sourceSha256, `${cls.id}: re-review actual selector coverage before changing a pin`).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
    const scratch = RETENTION_POLICY.find((cls) => cls.id === 'tmp-scratch')!;
    expect(scratch.roots).toEqual(['/mnt/data/tmp', '/tmp']);
    expect(scratch.keep).toEqual({ kind: 'max-age', maxAgeHours: 4 });
    expect(scratch.enforcers).toEqual([{ kind: 'standing-reclaim' }]);
    expect(RETENTION_POLICY.some((cls) => cls.id === 'mnt-tmp')).toBe(false);
  });

  it('every class has exactly one keep rule and at least one enforcer entry', () => {
    for (const cls of RETENTION_POLICY) {
      expect(cls.keep, cls.id).toBeTruthy();
      expect(typeof cls.keep.kind, cls.id).toBe('string');
      expect(cls.enforcers.length, cls.id).toBeGreaterThan(0);
    }
  });

  it('never selects owner data, swap, databases or product stores for deletion (D-002)', () => {
    for (const p of [
      '/mnt/data/Backup/kopia-repo/p/abc',
      '/mnt/data/owner-recordings/2026-06-27 18-14-07.mkv',
      '/mnt/data/Debug/Transformer/x',
      '/mnt/data/Debug_extra/y',
      '/mnt/data/db/collection-17.wt',
      '/mnt/data/back/Debug/z',
      '/mnt/data/swapfile',
      '/swap.img',
      '/var/lib/postgresql/18/main/base/1/2',
      `${HOME}/.papercusp-workspaces/.shared/embedded-pg-data/base/5`,
      `${HOME}/.papercusp-workspaces/ws/.papercusp/papercusp/hyperbee/data`,
      `${HOME}/Android/Sdk/x`,
    ]) {
      expect(del(p), p).toBeNull();
    }
  });

  it('the most specific root wins: in-tree scratch is deletable, the checkout around it is not', () => {
    expect(del(`${HOME}/papercupai-workspace/papercusp/.papercusp/scratch/probe.log`)).toBe('repo-scratch');
    expect(del(`${HOME}/papercupai-workspace/papercusp/packages/x.ts`)).toBeNull();
    expect(classifyPath(`${HOME}/papercupai-workspace/papercusp/packages/x.ts`, policy)).toMatchObject({ classId: 'source-checkouts' });
    expect(del(`${HOME}/papercupai-workspace/papercusp-relcut-0026/x`)).toBe('release-cut-worktrees');
  });

  it('leaves service-private temp trees to their native owner inside generic scratch', () => {
    for (const root of ['/tmp', '/mnt/data/tmp']) {
      const path = `${root}/systemd-private-boot-service/tmp/private`;
      expect(classifyPath(path, policy)).toMatchObject({ classId: 'os' });
      expect(del(path)).toBeNull();
    }
    expect(del('/mnt/data/tmp/agent-fixture/expired')).toBe('tmp-scratch');
  });

  it('protects the owner macOS VM and both database dump roots (WI-6554700010011387)', () => {
    // The owner-protected VM: the OSX-KVM disk, its recovery images and the backup-source link.
    for (const p of [
      '/mnt/backup/offload/macos-vm/OSX-KVM/mac_hdd_ng.img',
      '/mnt/backup/offload/macos-vm/recovery-EI-25726196477154042/attempt-2/builddata-20260820-160g.qcow2',
      `${HOME}/macos-vm/OSX-KVM`,
    ]) {
      expect(del(p), p).toBeNull();
      expect(classifyPath(p, policy), p).toMatchObject({ classId: 'owner-macos-vm' });
    }
    // The more specific protected root wins over the generic offload review class.
    expect(classifyPath('/mnt/backup/offload/WI-2146953/x', policy)).toMatchObject({ classId: 'backup-offload-other' });
    expect(classifyPath('/mnt/backup/db-dumps/papercusp-state.dump', policy)).toMatchObject({ classId: 'db-dumps' });
    expect(classifyPath('/mnt/cold-a/Backup/db-dumps/pg/papercusp-state.dump', policy)).toMatchObject({
      classId: 'db-dumps',
    });
    expect(del('/mnt/backup/db-dumps/pg/papercusp-state.dump')).toBeNull();
    expect(del('/mnt/cold-a/Backup/db-dumps/pg/papercusp-state.dump')).toBeNull();
    expect(classifyPath('/mnt/backup/cloud-e2e-workspace-host-20261009r2/source/x', policy)).toMatchObject({
      classId: 'backup-agent-trees',
    });
    // Until the owner rules (WI-6554700010010388), no /mnt/backup class may delete.
    const backupClasses = RETENTION_POLICY.filter((c) => c.roots.some((r) => r.startsWith('/mnt/backup')));
    expect(backupClasses.map((c) => c.id).sort()).toEqual(
      ['backup-agent-trees', 'backup-offload-other', 'db-dumps', 'owner-macos-vm'].sort(),
    );
    for (const cls of backupClasses) expect(isDeletableRule(cls.keep), cls.id).toBe(false);
    for (const p of [
      '/mnt/backup/customer-terminal-native-target.PfNyjp/debug/a',
      '/mnt/backup/p012-bake-fire105/x',
      '/mnt/backup/offload/papercusp-audit-inputs/a.qcow2',
    ]) {
      expect(del(p), p).toBeNull();
    }
  });

  it('a deletable class can never reach under the owner macOS VM root (D-002 validator)', () => {
    const rogue: RetentionClass = {
      id: 'rogue-macos-reclaim',
      title: 'would delete the VM disk',
      origin: 'agent',
      roots: ['/mnt/backup/offload/macos-vm/OSX-KVM'],
      keep: { kind: 'max-age', maxAgeHours: 24 },
      enforcers: [{ kind: 'standing-reclaim' }],
    };
    expect(validatePolicy([...RETENTION_POLICY, rogue], HOME)).toContain(
      'rogue-macos-reclaim: deletable root /mnt/backup/offload/macos-vm/OSX-KVM lies under owner root /mnt/backup/offload/macos-vm',
    );
  });

  it('only work-item-named offload entries are deletable; VM disks are review', () => {
    expect(del('/mnt/data/offload/wi4480-rollback70/payload.tar.zst')).toBe('offload-work-copies');
    expect(del('/mnt/data/offload/wi-10006692-retained-bench-2026-10-08/a')).toBe('offload-work-copies');
    expect(del('/mnt/data/offload/gate-cache-WI-10006055-20261007/a')).toBe('offload-work-copies');
    expect(del('/mnt/data/offload/windows-vm/disk.qcow2')).toBeNull();
    expect(classifyPath('/mnt/data/offload/windows-vm/disk.qcow2', policy)).toMatchObject({ classId: 'offload-other' });
    expect(del('/mnt/data/offload/root-disk/x')).toBeNull();
  });

  it('fails closed on an unmatched path, a class root itself and a non-path store key', () => {
    expect(del('/nowhere/at/all')).toBeNull();
    expect(del(`${HOME}/papercupai-workspace/papercusp/.papercusp/scratch`)).toBeNull();
    expect(del('/tmp')).toBeNull();
    expect(del('/tmp/vitest-123')).toBe('tmp-scratch');
    expect(del('docker:build-cache')).toBeNull();
    expect(classifyPath('docker:build-cache', policy)).toMatchObject({ classId: 'container-storage' });
  });

  it('honours live pins in the deletion selector and stops protecting at their expiry', () => {
    const now = Date.UTC(2026, 9, 15);
    const pinnedPath = `${HOME}/.papercusp/evidence/run/output`;
    const pinned = compilePolicy(RETENTION_POLICY, HOME, [{ paths: [pinnedPath], expiresAt: new Date(now + 3600_000).toISOString() }]);
    expect(deletionClassFor(`${pinnedPath}/proof.json`, pinned, now)).toBeNull();
    expect(deletionClassFor(`${HOME}/.papercusp/evidence/run`, pinned, now)).toBeNull();
    expect(deletionClassFor(`${pinnedPath}-other`, pinned, now)?.id).toBe('agent-evidence');
    expect(deletionClassFor(pinnedPath, pinned, now + 3600_000)?.id).toBe('agent-evidence');
    const rootPin = compilePolicy(RETENTION_POLICY, HOME, [{ paths: ['/'], expiresAt: new Date(now + 1).toISOString() }]);
    expect(deletionClassFor('/tmp/output', rootPin, now)).toBeNull();
  });

  it('fails closed on a conflict between two classes at the same specificity', () => {
    const a: RetentionClass = { id: 'a', title: 'a', origin: 'agent', roots: ['/x/*'], keep: { kind: 'max-age', maxAgeHours: 1 }, enforcers: [{ kind: 'standing-reclaim' }] };
    const b: RetentionClass = { ...a, id: 'b', roots: ['/x/*'] };
    const compiled = compilePolicy([a, b], HOME);
    expect(classifyPath('/x/y/z', compiled)).toMatchObject({ status: 'conflict', classIds: ['a', 'b'] });
    expect(deletionClassFor('/x/y/z', compiled)).toBeNull();
    expect(validatePolicy([a, b], HOME).join('\n')).toMatch(/claimed by a and b/);
    // R-2: a census consumer under two classes is reported as a conflict, never as mapped.
    const m = mapCensusConsumers([{ consumer: '/x/y/z', kind: 'dir', bytes: 7 }], compiled);
    expect(m.conflicts.map((c) => [c.consumer, c.classIds])).toEqual([['/x/y/z', ['a', 'b']]]);
    expect(m.mapped).toEqual([]);
    expect(m.unmapped).toEqual([]);
  });

  it('validatePolicy rejects the rule breaks D-002 and D-005 forbid', () => {
    const base: RetentionClass = { id: 'ok', title: 't', origin: 'agent', roots: ['/a'], keep: { kind: 'max-age', maxAgeHours: 1 }, enforcers: [{ kind: 'standing-reclaim' }] };
    expect(validatePolicy([base], HOME)).toEqual([]);
    expect(validatePolicy([{ ...base, origin: 'owner' }], HOME).join('\n')).toMatch(/owner data must be keep/);
    expect(validatePolicy([{ ...base, origin: 'system' }], HOME).join('\n')).toMatch(/only agent-generated/);
    expect(validatePolicy([{ ...base, enforcers: [{ kind: 'none' }] }], HOME).join('\n')).toMatch(/no scheduled enforcer/);
    expect(validatePolicy([{ ...base, enforcers: [{ kind: 'existing', ref: 'x', schedule: ' ' }] }], HOME).join('\n')).toMatch(/no scheduled enforcer/);
    expect(validatePolicy([{ ...base, keep: { kind: 'review', reason: 'r' } }], HOME).join('\n')).toMatch(/must not name a deleter/);
    const owner: RetentionClass = { id: 'own', title: 'o', origin: 'owner', roots: ['/a'], keep: { kind: 'keep', reason: 'r' }, enforcers: [{ kind: 'none' }] };
    expect(validatePolicy([owner, { ...base, roots: ['/a/b'] }], HOME).join('\n')).toMatch(/lies under owner root/);
  });

  it('maps census rows: classes, aggregates, files rows, store keys, unattributed and unmapped', () => {
    const rows = [
      { consumer: '/', kind: 'dir', bytes: 10 },
      { consumer: '/home', kind: 'dir', bytes: 9 },
      { consumer: '/tmp', kind: 'dir', bytes: 1 },
      { consumer: `${HOME}/.papercusp/evidence/run-1`, kind: 'dir', bytes: 2 },
      { consumer: '/usr/lib/x86_64-linux-gnu/*', kind: 'files', bytes: 3 },
      { consumer: 'docker:images', kind: 'store', bytes: 4 },
      { consumer: 'unattributed:/', kind: 'unattributed', bytes: 5 },
      { consumer: '/brand-new-dir', kind: 'dir', bytes: 6 },
    ];
    const m = mapCensusConsumers(rows, policy);
    expect(m.mapped.map((x) => [x.consumer, x.classId])).toEqual([
      ['/tmp', 'tmp-scratch'],
      [`${HOME}/.papercusp/evidence/run-1`, 'agent-evidence'],
      ['/usr/lib/x86_64-linux-gnu/*', 'os'],
      ['docker:images', 'container-storage'],
    ]);
    expect(m.aggregates).toEqual(['/', '/home']);
    expect(m.skipped).toEqual(['unattributed:/']);
    expect(m.unmapped).toEqual([{ consumer: '/brand-new-dir', bytes: 6 }]);
    expect(m.conflicts).toEqual([]);
  });

  it('every named enforcer is a repo-qualified file that exists in this checkout', () => {
    // A placeholder or a path relative to the wrong checkout reads fine in review
    // but names no program; P-004 calls these, so each must resolve.
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const refs = RETENTION_POLICY.flatMap((cls) =>
      cls.enforcers.flatMap((e) =>
        e.kind === 'existing' ? [[cls.id, e.ref] as const] : e.kind === 'standing-reclaim' && e.via ? [[cls.id, e.via] as const] : [],
      ),
    );
    expect(refs.length).toBeGreaterThan(0);
    const broken = refs.filter(([, ref]) => {
      const file = ref.split(/\s+/)[0];
      return !file.startsWith('papercusp/') || !existsSync(join(repoRoot, file.slice('papercusp/'.length)));
    });
    expect(broken).toEqual([]);
  });

  describe('agent files expire by default (disk-durable-headroom-2026-10-15 R-3)', () => {
    it('no agent max-age class outlives the 3-day ceiling, and the validator refuses one that would', () => {
      expect(AGENT_MAX_AGE_HOURS).toBe(72);
      expect(BUILD_DIR_MAX_AGE_HOURS).toBe(24);
      const ages = RETENTION_POLICY.flatMap((c) => (c.origin === 'agent' && c.keep.kind === 'max-age' ? [[c.id, c.keep.maxAgeHours] as const] : []));
      expect(ages.length).toBeGreaterThan(5);
      for (const [id, hours] of ages) expect(hours, id).toBeLessThanOrEqual(AGENT_MAX_AGE_HOURS);
      const longLived: RetentionClass = { id: 'long', title: 't', origin: 'agent', roots: ['/a'], keep: { kind: 'max-age', maxAgeHours: 4 * 24 }, enforcers: [{ kind: 'standing-reclaim' }] };
      expect(validatePolicy([longLived], HOME).join('\n')).toMatch(/exceeds the 72h agent ceiling/);
      const badBuild: RetentionClass = { ...longLived, id: 'bb', keep: { kind: 'max-age', maxAgeHours: 1, buildDirMaxAgeHours: 2 } };
      expect(validatePolicy([badBuild], HOME).join('\n')).toMatch(/build-dir bound 2h exceeds the class bound 1h/);
    });

    it('an unclassified path under every agent root resolves to that root’s deletable class, never keep', () => {
      const cases: Array<[string, string]> = [
        [`${HOME}/.papercusp/scratch/brand-new-probe/out.json`, 'papercusp-scratch'],
        [`${HOME}/.papercusp/evidence/never-seen-before/run.log`, 'agent-evidence'],
        [`${HOME}/.papercusp/artifacts/new-bundle`, 'agent-evidence'],
        [`${HOME}/papercupai-workspace/any-checkout/.papercusp/scratch/x`, 'repo-scratch'],
        [`${HOME}/papercupai-workspace/any-checkout/.papercusp/vitest-tmp/x`, 'repo-scratch'],
        [`${HOME}/papercupai-workspace/any-checkout/.papercusp/tsx-1000/x`, 'repo-scratch'],
        [`${HOME}/papercupai-workspace/any-checkout/.papercusp/node-compile-cache/x`, 'repo-scratch'],
        [`${HOME}/papercupai-workspace/any-checkout/.papercusp/spawn-results/x`, 'repo-scratch'],
        ['/tmp/unknown-agent-dir', 'tmp-scratch'],
        ['/mnt/data/offload/wi10007751-copy/x', 'offload-work-copies'],
      ];
      for (const [path, cls] of cases) {
        expect(del(path), path).toBe(cls);
        const rule = policy.classes.get(cls)!.keep;
        expect(rule.kind === 'max-age' ? rule.maxAgeHours : -1, path).toBeLessThanOrEqual(AGENT_MAX_AGE_HOURS);
      }
    });

    it('expires plan-item, work-item and date-stamped run output at the top of ~/.papercusp', () => {
      for (const name of [
        'p046-r26-publication',
        'p303-bootc-spike',
        'p304',
        'tutorial-mcp-wi7747',
        'cache-reclaim-preserve-EI-21047688909295463',
        'db-perf-scout-2026-08-02',
        'cloud-e2e-20261009',
      ]) {
        // The matched run dir is the class root: what expires is everything inside it.
        expect(classifyPath(`${HOME}/.papercusp/${name}`, policy), name).toMatchObject({ classId: 'papercusp-home-run-dirs' });
        expect(del(`${HOME}/.papercusp/${name}/out/run.log`), name).toBe('papercusp-home-run-dirs');
      }
    });

    it('never expires credentials, keys, backups or live state in ~/.papercusp, even with a date or an id in the name', () => {
      for (const name of [
        'db-encryption-key',
        'claude-token',
        'aws-console-login',
        'gcloud-auth',
        'marketplace-keys',
        'deploy-credentials',
        'claude-memory-backup-20260608-072510.tar.gz',
        'canonical-store-backup-20260608-074702.jsonl',
        'ei339-cleanup-backup',
        'signing-2026-10-01',
        'pot-git',
        'hives',
        'compaction-strategy.md',
      ]) {
        expect(del(`${HOME}/.papercusp/${name}`), name).toBeNull();
        expect(del(`${HOME}/.papercusp/${name}/inner`), name).toBeNull();
      }
      // Release-cut work dirs are review, even when the name carries a work-item id.
      expect(classifyPath(`${HOME}/.papercusp/wh-release-wi10008217`, policy)).toMatchObject({ classId: 'papercusp-home-release-dirs' });
      expect(del(`${HOME}/.papercusp/wh-release-wi10008217/x`)).toBeNull();
    });

    it('keeps a checkout’s harness state outside its agent roots', () => {
      for (const rel of ['blueprint.yaml', 'memory/m.md', 'state/s.json', 'dependency-generations/g1/node_modules/x', 'worktrees/w/x']) {
        const path = `${HOME}/papercupai-workspace/papercusp/.papercusp/${rel}`;
        expect(del(path), path).toBeNull();
      }
    });

    it('protects the cold tier: owner copies and backups on the HDDs are never deletable', () => {
      for (const p of ['/mnt/cold-a/Backup/kopia-repo/p/abc', '/mnt/cold-b/Debug_JAMES/x', '/mnt/cold-b/Debug/y', '/mnt/cold-b/back/z']) {
        expect(classifyPath(p, policy), p).toMatchObject({ classId: 'owner-data-mnt' });
        expect(del(p), p).toBeNull();
      }
      expect(classifyPath('/mnt/cold-a/meta/kopia-seed.log', policy)).toMatchObject({ classId: 'cold-tier' });
      expect(del('/mnt/cold-b/anything-else')).toBeNull();
      for (const root of ['/mnt/data/papercusp-backups', '/mnt/cold-a/papercusp-backups']) {
        expect(classifyPath(`${root}/workspace/snapshot.dump`, policy)).toMatchObject({ classId: 'papercusp-backups' });
        expect(del(`${root}/workspace/snapshot.dump`)).toBeNull();
      }
    });

    it('build dirs go after 1 day without a write to their entry; only node_modules or a CACHEDIR.TAG dir counts', () => {
      expect(isBuildDirName('node_modules')).toBe(true);
      expect(isBuildDirName('target')).toBe(false);
      expect(isBuildDirName('src')).toBe(false);
      expect(isCacheDirTag(`${CACHEDIR_TAG_SIGNATURE}\n# This file is a cache directory tag created by cargo.\n`)).toBe(true);
      expect(isCacheDirTag('Signature: something else')).toBe(false);
      expect(isCacheDirTag(null)).toBe(false);
      const scratch = policy.classes.get('papercusp-scratch')!.keep;
      const now = Date.UTC(2026, 9, 15, 12);
      const hours = (h: number) => now - h * 3_600_000;
      expect(buildDirsEligible(scratch, hours(25), now)).toBe(true);
      expect(buildDirsEligible(scratch, hours(23), now)).toBe(false);
      // A keep or review class never yields build dirs, nor does a max-age rule without the bound.
      expect(buildDirsEligible({ kind: 'keep', reason: 'r' }, hours(1000), now)).toBe(false);
      expect(buildDirsEligible({ kind: 'max-age', maxAgeHours: 4 }, hours(1000), now)).toBe(false);
      for (const cls of ['papercusp-scratch', 'repo-scratch', 'agent-evidence', 'papercusp-home-run-dirs', 'offload-work-copies']) {
        const rule = policy.classes.get(cls)!.keep;
        expect(rule.kind === 'max-age' && rule.buildDirMaxAgeHours, cls).toBe(BUILD_DIR_MAX_AGE_HOURS);
      }
    });
  });

  it('only max-age, newest and lease rules are deletable', () => {
    expect(isDeletableRule({ kind: 'max-age', maxAgeHours: 1 })).toBe(true);
    expect(isDeletableRule({ kind: 'newest', keep: 1 })).toBe(true);
    expect(isDeletableRule({ kind: 'lease', record: 'r', graceHours: 1 })).toBe(true);
    expect(isDeletableRule({ kind: 'native', manager: 'm', rule: 'r' })).toBe(false);
    expect(isDeletableRule({ kind: 'keep', reason: 'r' })).toBe(false);
    expect(isDeletableRule({ kind: 'review', reason: 'r' })).toBe(false);
  });
});

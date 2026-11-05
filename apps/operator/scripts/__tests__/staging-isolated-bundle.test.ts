import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type AddressInfo, type Server } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getHarnessAdminUrlWithSource,
  _resetHarnessAdminUrlCacheForTests,
} from '../../../../packages/operator-core/lib/embedded-pg-discovery';

const REPO_ROOT = resolve(__dirname, "../../../..");
const HELPER = join(REPO_ROOT, "apps/operator/bin/bundle-host-freshness.mjs");
const DROPIN_ROOT = join(
  REPO_ROOT,
  "apps/operator/scripts/systemd/papercup-staging-api.service.d",
);
const STAGING_SYNC_SCRIPT = join(
  REPO_ROOT,
  "apps/operator/bin/release/sync-staging-checkout.sh",
);

describe('managed service database selection', () => {
  let discoveryRoot: string;
  let discoveryServer: Server;
  let discoveryPort: number;

  beforeEach(async () => {
    discoveryServer = createServer();
    await new Promise<void>((resolve, reject) => {
      discoveryServer.once('error', reject);
      discoveryServer.listen(0, '127.0.0.1', resolve);
    });
    discoveryPort = (discoveryServer.address() as AddressInfo).port;
    discoveryRoot = mkdtempSync(join(tmpdir(), 'staging-pg-discovery-'));
    writeFileSync(join(discoveryRoot, 'embedded-pg.json'), JSON.stringify({
      url: `postgresql://fixture:fixture@127.0.0.1:${discoveryPort}/papercusp`,
      pid: process.pid,
    }));
    for (const name of ['HARNESS_ADMIN_DATABASE_URL', 'DATABASE_URL', 'PAPERCUSP_PG_URL', 'PAPERCUSP_PG_PORT']) {
      vi.stubEnv(name, '');
    }
    vi.stubEnv('PAPERCUSP_HOME', discoveryRoot);
    vi.stubEnv('PAPERCUSP_SKIP_PG_DISCOVERY', '0');
    _resetHarnessAdminUrlCacheForTests();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    _resetHarnessAdminUrlCacheForTests();
    rmSync(discoveryRoot, { recursive: true, force: true });
    await new Promise<void>((resolve) => discoveryServer.close(() => resolve()));
  });

  const managedDropIns = [
    join(DROPIN_ROOT, '50-staging-checkout.conf'),
    join(REPO_ROOT, 'apps/operator/scripts/systemd/papercup-staging-sync.service.d/50-script-snapshot.conf'),
    join(REPO_ROOT, 'apps/operator/scripts/systemd/papercup-embed-sidecar.service'),
  ];

  function applyManagedDiscoveryPolicy(dropIn: string) {
    const checkout = readFileSync(dropIn, 'utf8');
    const match = checkout.match(/^Environment=PAPERCUSP_SKIP_PG_DISCOVERY=(.*)$/m);
    if (match) vi.stubEnv('PAPERCUSP_SKIP_PG_DISCOVERY', match[1]);
    _resetHarnessAdminUrlCacheForTests();
  }

  it.each(managedDropIns)('keeps %s on native PG when desktop discovery names another database', (dropIn) => {
    const redirected = getHarnessAdminUrlWithSource();
    expect(redirected.source).toBe('discovery-file');
    expect(new URL(redirected.url).port).toBe(String(discoveryPort));

    applyManagedDiscoveryPolicy(dropIn);
    const managed = getHarnessAdminUrlWithSource();
    expect(managed.source).toBe('native-fallback');
    expect(new URL(managed.url).port).toBe('5432');
  });

  it.each(managedDropIns)('preserves an explicitly configured database over native fallback for %s', (dropIn) => {
    applyManagedDiscoveryPolicy(dropIn);
    vi.stubEnv('HARNESS_ADMIN_DATABASE_URL', 'postgresql://fixture:fixture@localhost:24444/explicit');
    _resetHarnessAdminUrlCacheForTests();
    const configured = getHarnessAdminUrlWithSource();
    expect(configured.source).toBe('env');
    expect(new URL(configured.url).port).toBe('24444');
    expect(new URL(configured.url).pathname).toBe('/explicit');
  });
});

describe("staging systemd drop-ins keep the serving alias and runtime generation aligned", () => {
  const checkout = readFileSync(
    join(DROPIN_ROOT, "50-staging-checkout.conf"),
    "utf8",
  );
  const bundle = readFileSync(
    join(DROPIN_ROOT, "95-bundled-entry.conf"),
    "utf8",
  );

  it("points WorkingDirectory, SPA, and initial integration root at the stable alias", () => {
    expect(checkout).toContain(
      "WorkingDirectory=%h/papercupai-workspace/papercusp-staging.current/apps/operator",
    );
    expect(checkout).toContain(
      "Environment=PAPERCUSP_INTEGRATION_ROOT=%h/papercupai-workspace/papercusp-staging.current",
    );
    expect(checkout).toContain(
      "Environment=PAPERCUSP_SPA_DIST=%h/papercupai-workspace/papercusp-staging.current/apps/operator-vite/dist",
    );
    expect(checkout).not.toMatch(
      /^WorkingDirectory=.*papercupai-workspace\/papercusp\/apps\/operator/m,
    );
  });

  // EI-24049239243821100: moving PAPERCUSP_INTEGRATION_ROOT off the edit tree without
  // naming the edit tree made every working-tree reader on :3170 describe the clean
  // mirror, so dev:pipeline_position reported an uncommitted edit as clean and live.
  it("declares the canonical EDIT tree separately from the served mirror", () => {
    const envValue = (name: string): string | null => {
      const prefix = "Environment=" + name + "=";
      return checkout
        .split("\n")
        .find((line) => line.startsWith(prefix))
        ?.slice(prefix.length) ?? null;
    };
    const served = envValue("PAPERCUSP_INTEGRATION_ROOT");
    const edited = envValue("PAPERCUSP_CANONICAL_TREE");
    expect(served).toBe("%h/papercupai-workspace/papercusp-staging.current");
    expect(edited).toBe("%h/papercupai-workspace/papercusp");
    expect(edited).not.toBe(served);
  });

  it("builds from that same tree and enables proof-bound reuse before plain-node start", () => {
    expect(bundle).toContain("Environment=PAPERCUSP_BUNDLE_REUSE_FRESH=1");
    // ExecStartPre builds from the stable alias under the shared staging-sync
    // lock, through the lock-attribution helper when the generation ships it and
    // through a bare shared flock otherwise (WI-10005456).
    expect(bundle).toContain(
      `ExecStartPre=/usr/bin/bash -c 'root="%h/papercupai-workspace/papercusp-staging.current"; helper="$$root/apps/operator/scripts/systemd/staging-lock-attribution.sh"`,
    );
    expect(bundle).toContain(
      'exec /usr/bin/bash "$$helper" api-pre /tmp/papercup-staging-sync.lock "$$root/apps/operator/bin/bundle-host.sh"',
    );
    expect(bundle).toContain(
      'exec /usr/bin/flock -s /tmp/papercup-staging-sync.lock "$$root/apps/operator/bin/bundle-host.sh"',
    );
    expect(bundle).toContain(
      'export PAPERCUSP_INTEGRATION_ROOT="$(cd ../.. && pwd -P)"',
    );
    expect(bundle).toContain("exec node dist-host/hono-host.mjs");
    expect(bundle).toContain("PAPERCUSP_BIND_HOST=127.0.0.1");
  });

  it("builds and marks an isolated candidate ready before publishing the alias", () => {
    const sync = readFileSync(STAGING_SYNC_SCRIPT, "utf8");
    expect(sync).toContain('STAGING_SYNC_LOCK_PATH="/tmp/papercup-staging-sync.lock"');
    // The flock lives in a coprocess keeper (fd 9 never leaks into children); the
    // workflow drives it by call, so order the CALL SITES, not the keeper's body.
    expect(sync).toContain('exec 9>"$STAGING_SYNC_LOCK_PATH"');
    expect(sync).toContain("if flock -s 9; then printf '%s\\n' shared;");
    const acquire = sync.indexOf("if staging_sync_lock_start; then");
    const prepare = sync.indexOf('prepare_staging_candidate "$target"');
    const build = sync.indexOf(
      'prebuild_staging_host_bundle "$SYNC_ROOT" "$bundle_script"',
    );
    const ready = sync.indexOf('mark_staging_candidate_ready "$target"');
    const publish = sync.indexOf(
      'publish_staging_generation "$STAGING_CANDIDATE_ROOT"',
    );
    const downgrade = sync.indexOf("if staging_sync_lock_shared; then");
    expect(acquire).toBeGreaterThanOrEqual(0);
    expect(prepare).toBeGreaterThan(acquire);
    expect(sync).toContain(
      'PAPERCUSP_INTEGRATION_ROOT="$INTEGRATION_ROOT" PAPERCUSP_RELEASE_ROOT="$STAGING_CANDIDATE_ROOT"',
    );
    expect(sync).toContain('--release "$STAGING_CANDIDATE_ROOT"');
    expect(build).toBeGreaterThan(prepare);
    expect(ready).toBeGreaterThan(build);
    expect(publish).toBeGreaterThan(ready);
    expect(downgrade).toBeGreaterThan(publish);
    expect(bundle).toContain(
      "/usr/bin/flock -s /tmp/papercup-staging-sync.lock",
    );
  });
});

describe("bundle-host-freshness proof", () => {
  let repo: string;
  let entry: string;
  let outfile: string;
  let manifest: string;

  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args],
      {
        encoding: "utf8",
      },
    ).trim();

  const run = (operation: "check" | "stamp") =>
    spawnSync(
      process.execPath,
      [
        HELPER,
        operation,
        "--repo-root",
        repo,
        "--entry",
        entry,
        "--outfile",
        outfile,
        "--manifest",
        manifest,
      ],
      { encoding: "utf8" },
    );

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bundle-freshness-"));
    git("init", "-q");
    entry = join(repo, "entry.ts");
    outfile = join(repo, "dist-host", "hono-host.mjs");
    manifest = join(repo, "dist-host", ".bundle-fresh.json");
    writeFileSync(join(repo, ".gitignore"), "dist-host/\nnode_modules/\n");
    writeFileSync(entry, "export const version = 1;\n");
    git("add", ".gitignore", "entry.ts");
    git("commit", "-q", "-m", "fixture");
    mkdirSync(join(repo, "node_modules"));
    writeFileSync(join(repo, "node_modules", ".package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
    mkdirSync(join(repo, "dist-host", "sql"), { recursive: true });
    writeFileSync(outfile, 'console.log("bundle");\n');
    writeFileSync(join(repo, "dist-host", "sql", "001.sql"), "select 1;\n");
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("accepts the same clean HEAD, entry and complete output tree", () => {
    expect(run("stamp").status).toBe(0);
    expect(run("check").status).toBe(0);
  });

  it("rejects a missing installed dependency lock instead of blessing an incomplete fixture", () => {
    unlinkSync(join(repo, "node_modules", ".package-lock.json"));
    const result = run("stamp");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("installed dependency lock is missing");
  });

  it("ignores the esbuild metafile removed by bundle-host.sh's EXIT trap after stamping", () => {
    const metafile = `${outfile}.tmp.12345.meta.json`;
    writeFileSync(metafile, '{"inputs":{}}\n');

    expect(run("stamp").status).toBe(0);
    unlinkSync(metafile);
    expect(run("check").status).toBe(0);
  });

  it("rejects tracked source drift and a later commit even when output bytes remain", () => {
    expect(run("stamp").status).toBe(0);
    writeFileSync(entry, "export const version = 2;\n");
    expect(run("check").status).not.toBe(0);
    git("add", "entry.ts");
    git("commit", "-q", "-m", "new source");
    expect(run("check").status).not.toBe(0);
  });

  it("rejects missing or modified runtime output siblings", () => {
    expect(run("stamp").status).toBe(0);
    writeFileSync(join(repo, "dist-host", "sql", "001.sql"), "select 2;\n");
    expect(run("check").status).not.toBe(0);
  });

  // EI-24867768475421999: a 2026-10-02 stamp failure logged only
  // "[bundle-freshness] spawnSync git ETIMEDOUT", which named neither the git
  // call nor how long it ran, and the missing proof then made staging-sync
  // discard the whole generation.
  it("names the failing git command, its elapsed time and its bound", () => {
    const notRepo = mkdtempSync(join(tmpdir(), "bundle-freshness-norepo-"));
    try {
      const r = spawnSync(
        process.execPath,
        [HELPER, "stamp", "--repo-root", notRepo, "--entry", entry, "--outfile", outfile, "--manifest", manifest],
        // The ceiling keeps git from discovering an enclosing repository when
        // TMPDIR happens to sit inside a checkout.
        { encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() } },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(
        /\[bundle-freshness\] git rev-parse --show-toplevel failed after \d+ms \(timeout 30000ms\): exit 128/,
      );
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });

  it("bounds the cold-index status call separately from the plumbing hang guard", () => {
    const bin = mkdtempSync(join(tmpdir(), "bundle-freshness-fakegit-"));
    try {
      // Fake git: rev-parse reports the requested root; status fails fast.
      writeFileSync(
        join(bin, "git"),
        '#!/bin/sh\ncase "$3" in\n  rev-parse) printf \'%s\\n\' "$2" ;;\n  status) echo boom >&2; exit 2 ;;\n  *) exit 3 ;;\nesac\n',
        { mode: 0o755 },
      );
      const r = spawnSync(
        process.execPath,
        [HELPER, "stamp", "--repo-root", repo, "--entry", entry, "--outfile", outfile, "--manifest", manifest],
        { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` } },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(
        "git status --porcelain=v1 --untracked-files=no --ignore-submodules=none failed after",
      );
      expect(r.stderr).toMatch(/\(timeout 300000ms\): exit 2 — boom/);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe("bundle-host freshness helper paths", () => {
  const bundleHost = readFileSync(
    join(REPO_ROOT, "apps/operator/bin/bundle-host.sh"),
    "utf8",
  );

  it("passes relative or absolute paths unchanged to both freshness operations", () => {
    // The verifier supplies an absolute dist-verify outfile. Prefixing PWD to
    // that value creates an invalid double-rooted path and makes the optional
    // freshness stamp fail open, so both check and stamp must pass the original
    // arguments to the Node helper (which resolves relative paths itself).
    expect(bundleHost.match(/--entry "\$ENTRY"/g)).toHaveLength(2);
    expect(bundleHost.match(/--outfile "\$OUTFILE"/g)).toHaveLength(2);
    expect(bundleHost.match(/--manifest "\$FRESH_MARKER"/g)).toHaveLength(2);
    expect(bundleHost).not.toContain('--entry "$PWD/$ENTRY"');
    expect(bundleHost).not.toContain('--outfile "$PWD/$OUTFILE"');
    expect(bundleHost).not.toContain('--manifest "$PWD/$FRESH_MARKER"');
  });
});

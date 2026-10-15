/**
 * The Instructions publish separately from any release [owner 2026-09-28, #868:
 * "the instructions should come seperate from the release cut"].
 *
 * The 0.0.24 publish re-rendered the index from a checkout pinned before that day's
 * instruction edits and rolled the live text back (EI-24562046738478155). These tests
 * pin the separation: only release-instructions-cli writes instructions.html, only
 * bin/publish-release-instructions.sh uploads it, and no release-time path does either.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeInstructionsPage } from './release-instructions-cli';
import { INSTRUCTIONS_BODY_ID, INSTRUCTIONS_PAGE_PATH } from './release-history-page';

const REPO_ROOT = path.resolve(__dirname, '../../../../');
const DESKTOP_BIN = path.join(REPO_ROOT, 'papercusp-desktop', 'bin');
const OWNER = [{ kind: 'git-name' as const, value: 'Synthetic Owner' }];

describe('release-instructions-cli — the only writer of instructions.html', () => {
  it('writes the rendered instructions page into --out', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-instructions-'));
    try {
      const file = writeInstructionsPage(dir, { generatedAt: new Date('2026-09-28T00:00:00Z'), redact: OWNER });
      expect(file).toBe(path.join(dir, INSTRUCTIONS_PAGE_PATH));
      const html = fs.readFileSync(file, 'utf8');
      expect(html).toContain(`id="${INSTRUCTIONS_BODY_ID}"`);
      expect(html).toContain('<strong>Install both apps</strong>');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to render when no owner-name literal resolved — the scrub would redact nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-instructions-'));
    try {
      expect(() => writeInstructionsPage(dir, { redact: [] })).toThrow(/REFUSING TO RENDER/);
      expect(fs.existsSync(path.join(dir, INSTRUCTIONS_PAGE_PATH))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('no release-time path writes or uploads instructions.html [owner #868]', () => {
  it('record-release-cli never renders the instructions page', () => {
    const src = fs.readFileSync(path.join(__dirname, 'record-release-cli.ts'), 'utf8');
    expect(src).not.toContain('renderInstructionsHtml');
    expect(src).not.toContain('INSTRUCTIONS_PAGE_PATH');
    expect(src).not.toContain('instructions.html');
  });

  it('publish-release-history.sh never uploads it', () => {
    const src = fs.readFileSync(path.join(DESKTOP_BIN, 'publish-release-history.sh'), 'utf8');
    expect(src).not.toMatch(/aws s3 cp[^\n]*instructions\.html/);
  });

  it('publish-release-history.sh refuses, before uploading anything, when the live instructions.html is missing', () => {
    // The index's Instructions section loads that page. Publishing an index without it
    // live would show testers an empty section, so the site publish stops and names
    // the separate command instead.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-history-instr-'));
    try {
      const site = path.join(root, 'site');
      const home = path.join(root, 'home');
      const bin = path.join(root, 'bin');
      const awsLog = path.join(root, 'aws.log');
      for (const dir of [path.join(site, 'work-items'), path.join(home, '.papercusp'), bin]) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(site, 'index.html'),
        '<section class="rel" data-newest-release="1.2.3"><a href="work-items/WI-1.html">item</a></section>\n',
      );
      // Real history.json releases carry an `artifacts` array; publish runs
      // spa-freshness.js --site first, which holds (exit 4) on a release without one.
      fs.writeFileSync(path.join(site, 'history.json'), '{"releases":[{"version":"1.2.3","artifacts":[]}]}\n');
      fs.writeFileSync(path.join(site, 'work-items', 'WI-1.html'), '<html>detail</html>\n');
      for (const rel of ['assets/project-history.js', 'assets/project-history.css', 'assets/vditor/dist/js/lute/lute.min.js']) {
        fs.mkdirSync(path.dirname(path.join(site, rel)), { recursive: true });
        fs.writeFileSync(path.join(site, rel), 'asset');
      }
      fs.writeFileSync(path.join(home, '.papercusp', 'release-host.env'), 'PAPERCUSP_UPDATE_BASE_URL=https://release.example/secret-path\n');
      fs.writeFileSync(
        path.join(home, '.papercusp', 'r2.env'),
        'R2_ACCOUNT_ID=acct\nR2_BUCKET=bucket\nAWS_ACCESS_KEY_ID=key\nAWS_SECRET_ACCESS_KEY=secret\n',
      );
      fs.writeFileSync(path.join(bin, 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.writeFileSync(path.join(bin, 'aws'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(awsLog)}\n`, { mode: 0o755 });
      // Every public URL 404s — in particular instructions.html.
      fs.writeFileSync(path.join(bin, 'curl'), "#!/bin/sh\nprintf '404'\n", { mode: 0o755 });
      const r = spawnSync('bash', [path.join(DESKTOP_BIN, 'publish-release-history.sh'), '1.2.3'], {
        cwd: REPO_ROOT,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home, PAPERCUSP_RELEASE_SITE_DIR: site, DRY_RUN: '0' },
        encoding: 'utf8',
      });
      const output = `${r.stdout}\n${r.stderr}`;
      expect(r.status, output).toBe(1);
      expect(output).toContain('instructions.html is missing (HTTP 404)');
      expect(output).toContain('bin/publish-release-instructions.sh');
      expect(fs.existsSync(awsLog)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('bin/publish-release-instructions.sh', () => {
  const script = path.join(DESKTOP_BIN, 'publish-release-instructions.sh');
  const PAGE = '<!doctype html><html><body><div class="prose" id="instructions-body">steps</div></body></html>\n';

  /** Stub npx (renderer + gate), aws and curl; everything else is the real script. */
  function run(opts: { dryRun?: boolean; gateRc?: number; served?: 'match' | 'stale' | 404 }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-instructions-'));
    const home = path.join(root, 'home');
    const bin = path.join(root, 'bin');
    const awsLog = path.join(root, 'aws.log');
    fs.mkdirSync(path.join(home, '.papercusp'), { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(home, '.papercusp', 'release-host.env'), 'PAPERCUSP_UPDATE_BASE_URL=https://release.example/secret-path\n');
    fs.writeFileSync(
      path.join(home, '.papercusp', 'r2.env'),
      'R2_ACCOUNT_ID=acct\nR2_BUCKET=bucket\nAWS_ACCESS_KEY_ID=key\nAWS_SECRET_ACCESS_KEY=secret\n',
    );
    fs.writeFileSync(
      path.join(bin, 'npx'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
if (a.some((x) => x.endsWith('release-instructions-cli.ts'))) {
  fs.writeFileSync(a[a.indexOf('--out') + 1] + '/instructions.html', ${JSON.stringify(PAGE)});
  process.exit(0);
}
if (a.some((x) => x.endsWith('gate-release-site.ts'))) process.exit(${opts.gateRc ?? 0});
process.exit(0);
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(bin, 'aws'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(awsLog)}\nexit 0\n`, { mode: 0o755 });
    const served = opts.served ?? 'match';
    fs.writeFileSync(
      path.join(bin, 'curl'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const out = args[args.indexOf('-o') + 1];
${served === 404 ? "process.stdout.write('404'); process.exit(0);" : ''}
fs.writeFileSync(out, ${JSON.stringify(served === 'stale' ? '<html>old</html>\n' : PAGE)});
if (args.includes('-w')) process.stdout.write('200');
`,
      { mode: 0o755 },
    );
    const result = spawnSync('bash', [script], {
      cwd: REPO_ROOT,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home, DRY_RUN: opts.dryRun ? '1' : '0' },
      encoding: 'utf8',
    });
    const aws = fs.existsSync(awsLog) ? fs.readFileSync(awsLog, 'utf8') : '';
    fs.rmSync(root, { recursive: true, force: true });
    return { ...result, output: `${result.stdout}\n${result.stderr}`, aws };
  }

  it('uploads instructions.html to the secret path and verifies the served bytes', () => {
    const r = run({});
    expect(r.status, r.output).toBe(0);
    expect(r.aws).toContain('s3://bucket/secret-path/instructions.html');
    expect(r.output).toContain('instructions.html served and byte-identical');
    // The secret path segment never reaches the console.
    expect(r.output).not.toContain('secret-path');
  });

  it('DRY_RUN renders and gates but uploads nothing', () => {
    const r = run({ dryRun: true });
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('DRY_RUN=1');
    expect(r.aws).toBe('');
  });

  it('refuses to upload when the identity gate finds a leak (1) or cannot check (2)', () => {
    for (const gateRc of [1, 2]) {
      const r = run({ gateRc });
      expect(r.status).toBe(gateRc);
      expect(r.output).toContain('REFUSING TO UPLOAD');
      expect(r.aws).toBe('');
    }
  });

  it('fails when the public copy is stale or missing', () => {
    const stale = run({ served: 'stale' });
    expect(stale.status).not.toBe(0);
    expect(stale.output).toContain('does NOT match');
    const missing = run({ served: 404 });
    expect(missing.status).not.toBe(0);
    expect(missing.output).toContain('HTTP 404');
  });
});

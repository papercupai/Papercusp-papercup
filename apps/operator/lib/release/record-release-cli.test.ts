import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { OwnerDirectiveRow } from '@papercusp/operator-core/lib/owner-directives';
import {
  buildRunOpts,
  ANDROID_RELEASE_PROVENANCE_PATH,
  assertRequestedDesktopArtifacts,
  classifyArtifact,
  collectedLinuxBundleRoot,
  computeMobileRegression,
  computeReleaseCompleteness,
  formatCompletenessAlert,
  incompleteDesktopScopeRefusal,
  formatMobileRegressionAlert,
  isImplausiblyTiny,
  main,
  MIN_PLAUSIBLE_ARTIFACT_BYTES,
  releaseBundleRoots,
  releaseTag,
  resolveMobileRoot,
  resolveChangelogWindowStart,
  scanArtifacts,
  scanMobileArtifactSources,
  scanMobileArtifacts,
  scanProvenancedAndroidArtifactSources,
  validateRecordChangelog,
  validateMobileProductName,
  type MissingArtifactSlot,
} from './record-release-cli';

/**
 * A buffer safely above MIN_PLAUSIBLE_ARTIFACT_BYTES, for fixtures that must be
 * FOUND (not skipped for being implausibly tiny). `tag` seeds the leading bytes so
 * different fixtures still hash differently.
 */
function plausibleBytes(tag: string): Buffer {
  const buf = Buffer.alloc(MIN_PLAUSIBLE_ARTIFACT_BYTES + 1024);
  Buffer.from(tag).copy(buf, 0);
  return buf;
}

type AndroidFixture = {
  root: string;
  apk: string;
  aab: string;
  manifest: string;
  commit: string;
};

function makeAndroidFixture(version = '0.0.9'): AndroidFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-provenance-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  fs.writeFileSync(path.join(root, '.gitignore'), '/android/app/build/\n');
  fs.writeFileSync(path.join(root, 'source.txt'), 'source\n');
  execFileSync('git', ['add', '.gitignore', 'source.txt'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const apk = path.join(root, 'android/app/build/outputs/apk/release/app-release.apk');
  const aab = path.join(root, 'android/app/build/outputs/bundle/release/app-release.aab');
  const manifest = path.join(root, ANDROID_RELEASE_PROVENANCE_PATH);
  fs.mkdirSync(path.dirname(apk), { recursive: true });
  fs.mkdirSync(path.dirname(aab), { recursive: true });
  const apkBytes = plausibleBytes('release-apk');
  const aabBytes = plausibleBytes('release-aab');
  fs.writeFileSync(apk, apkBytes);
  fs.writeFileSync(aab, aabBytes);
  fs.writeFileSync(
    manifest,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        releaseVersion: version,
        sourceCommit: commit,
        sourceDirty: false,
        builtAt: '2026-08-13T12:00:00Z',
        artifacts: {
          apk: {
            kind: 'apk',
            path: 'android/app/build/outputs/apk/release/app-release.apk',
            size: apkBytes.length,
            sha256: createHash('sha256').update(apkBytes).digest('hex'),
          },
          aab: {
            kind: 'aab',
            path: 'android/app/build/outputs/bundle/release/app-release.aab',
            size: aabBytes.length,
            sha256: createHash('sha256').update(aabBytes).digest('hex'),
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return { root, apk, aab, manifest, commit };
}

function updateManifest(file: string, mutate: (manifest: any) => void): void {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(manifest);
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

type IosFixture = {
  root: string;
  state: string;
  attempt: string;
  resultFile: string;
  latest: string;
  manifest: string;
  ipa: string;
  commit: string;
};

function makeIosFixture(version = '0.0.9', distributionMethod = 'app-store-connect'): IosFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-mobile-source-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-ci-state-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  fs.writeFileSync(path.join(root, '.gitignore'), '/android/app/build/\n/ios/build/\n');
  fs.writeFileSync(path.join(root, 'source.txt'), 'source\n');
  execFileSync('git', ['add', '.gitignore', 'source.txt'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  const attempt = path.join(state, 'attempts', '20261010T120000Z-acde1234');
  const exportDir = path.join(attempt, 'export');
  fs.mkdirSync(exportDir, { recursive: true });
  const ipa = path.join(exportDir, 'Papercusp.ipa');
  const ipaRelativePath = path.relative(attempt, ipa).split(path.sep).join('/');
  const ipaBytes = plausibleBytes('signed-ipa');
  fs.writeFileSync(ipa, ipaBytes);
  const manifest = path.join(attempt, 'candidate-manifest.json');
  const installation = {
    distributionMethod,
    registeredDeviceCount: distributionMethod === 'release-testing' ? 2 : 0,
    profileExpiresAt: '2027-01-01T00:00:00Z',
    installationRoute: distributionMethod === 'release-testing' ? 'registered-device' : 'app-store-connect',
  };
  const finishedAt = '2026-10-10T12:01:00.000Z';
  fs.writeFileSync(
    manifest,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        sourceSha: commit,
        version,
        build: '41',
        signed: true,
        releaseVersion: version,
        sourceCommit: commit,
        sourceDirty: false,
        builtAt: finishedAt,
        installation,
        artifacts: [{
          kind: 'ipa',
          path: ipaRelativePath,
          size: ipaBytes.length,
          sha256: createHash('sha256').update(ipaBytes).digest('hex'),
        }],
      },
      null,
      2,
    )}\n`,
  );
  const signedExportLog = path.join(attempt, 'signed-export.log');
  const archiveGuardLog = path.join(attempt, 'archive-guard.log');
  fs.writeFileSync(signedExportLog, 'signed export passed\n');
  fs.writeFileSync(archiveGuardLog, 'archive guard passed\n');
  const receipt = (file: string, relativePath: string) => ({
    path: relativePath,
    size: fs.statSync(file).size,
    sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  });
  const result = {
    schemaVersion: 1,
    executor: 'native-mac',
    attempt,
    startedAt: '2026-10-10T11:58:00.000Z',
    finishedAt,
    status: 'passed',
    mode: 'signed',
    distributionMethod,
    pairedUI: false,
    day: '2026-10-10',
    buildNumber: '41',
    source: { commit, dirty: false },
    toolchain: { xcode: 'Xcode 26.0', iosSDK: '26.0', simulator: 'test' },
    phases: [
      { name: 'signed-export', exitCode: 0, status: 'passed', log: signedExportLog, sha256: receipt(signedExportLog, 'signed-export.log').sha256 },
      { name: 'archive-guard', exitCode: 0, status: 'passed', log: archiveGuardLog, sha256: receipt(archiveGuardLog, 'archive-guard.log').sha256 },
    ],
    installation,
    artifacts: [
      receipt(manifest, 'candidate-manifest.json'),
      receipt(ipa, ipaRelativePath),
      receipt(signedExportLog, 'signed-export.log'),
      receipt(archiveGuardLog, 'archive-guard.log'),
    ],
  };
  const resultFile = path.join(attempt, 'result.json');
  const latest = path.join(state, 'latest.json');
  const resultText = `${JSON.stringify(result, null, 2)}\n`;
  fs.writeFileSync(resultFile, resultText);
  fs.writeFileSync(latest, resultText);
  return { root, state, attempt, resultFile, latest, manifest, ipa, commit };
}

function updateIosResult(fixture: IosFixture, mutate: (result: any) => void): void {
  const result = JSON.parse(fs.readFileSync(fixture.latest, 'utf8'));
  mutate(result);
  const text = `${JSON.stringify(result, null, 2)}\n`;
  fs.writeFileSync(fixture.resultFile, text);
  fs.writeFileSync(fixture.latest, text);
}

function refreshIosManifestReceipt(fixture: IosFixture): void {
  updateIosResult(fixture, (result) => {
    const receipt = result.artifacts.find((item: any) => item.path === 'candidate-manifest.json');
    const bytes = fs.readFileSync(fixture.manifest);
    receipt.size = bytes.length;
    receipt.sha256 = createHash('sha256').update(bytes).digest('hex');
  });
}

function noIosCiState(root: string): string {
  return path.join(root, '.no-ios-ci-state');
}

describe('computeReleaseCompleteness — every desktop product×platform, not just GUI (WI-5515)', () => {
  const gui = (platform: string) => ({ product: 'gui' as const, platform });
  const server = (platform: string) => ({ product: 'server' as const, platform });

  it('flags a linux-only cut as missing mac + windows for BOTH gui and server', () => {
    const { missing, complete } = computeReleaseCompleteness([
      gui('linux-x86_64'),
      server('linux-x86_64'),
    ]);
    expect(complete).toBe(false);
    expect(missing).toEqual([
      { product: 'gui', platform: 'darwin-universal' },
      { product: 'gui', platform: 'windows-x86_64' },
      { product: 'server', platform: 'darwin-universal' },
      { product: 'server', platform: 'windows-x86_64' },
    ]);
  });

  it('catches the exact gap the owner hit: full GUI + linux Server, but NO mac/windows Server', () => {
    const { missing, complete } = computeReleaseCompleteness([
      gui('linux-x86_64'),
      gui('darwin-universal'),
      gui('windows-x86_64'),
      server('linux-x86_64'),
    ]);
    expect(complete).toBe(false);
    // GUI is complete; the miss is Server on mac + windows — invisible to the old
    // gui-only check.
    expect(missing).toEqual([
      { product: 'server', platform: 'darwin-universal' },
      { product: 'server', platform: 'windows-x86_64' },
    ]);
  });

  it('is complete only when both products cover all three desktop platforms', () => {
    const { missing, complete } = computeReleaseCompleteness([
      gui('linux-x86_64'),
      gui('darwin-universal'),
      gui('windows-x86_64'),
      server('linux-x86_64'),
      server('darwin-universal'),
      server('windows-x86_64'),
    ]);
    expect(complete).toBe(true);
    expect(missing).toEqual([]);
  });

  it('does NOT count mobile toward completeness (a desktop cut with no phone build is complete)', () => {
    const { complete } = computeReleaseCompleteness([
      gui('linux-x86_64'),
      gui('darwin-universal'),
      gui('windows-x86_64'),
      server('linux-x86_64'),
      server('darwin-universal'),
      server('windows-x86_64'),
      { product: 'mobile', platform: 'android-universal' },
    ]);
    expect(complete).toBe(true);
  });

  it('extra AppImage/deb on the same platform does not double-satisfy or break the check', () => {
    // linux GUI ships BOTH deb and AppImage — same product×platform, still one slot.
    const { missing } = computeReleaseCompleteness([gui('linux-x86_64'), gui('linux-x86_64')]);
    expect(missing).toContainEqual({ product: 'server', platform: 'linux-x86_64' });
  });
});

describe('formatCompletenessAlert — names every missing slot and requires approval (WI-5515)', () => {
  it('is empty when nothing is missing (a complete release prints no alert)', () => {
    expect(formatCompletenessAlert('0.0.12', 'alpha', [])).toBe('');
  });

  it('names the version + each missing product/platform and says it is NOT a rejection', () => {
    const alert = formatCompletenessAlert('0.0.12', 'alpha', [
      { product: 'server', platform: 'darwin-universal' },
      { product: 'server', platform: 'windows-x86_64' },
    ]);
    expect(alert).toContain('INCOMPLETE RELEASE: 0.0.12 (alpha)');
    expect(alert).toContain('SERVER');
    expect(alert).toContain('macOS (universal)');
    expect(alert).toContain('Windows (x64)');
    expect(alert).toContain('NOT an owner approval');
    expect(alert).toContain('--owner-approved-partial-scope <owner-directive-id>');
  });
});

describe('incompleteDesktopScopeRefusal — partial registry scopes require owner approval', () => {
  // Typed as the canonical slot rather than inferred: `platform` would otherwise
  // widen to `string` and stop satisfying RequiredDesktopPlatform at every call
  // site below.
  const missing: MissingArtifactSlot[] = [{ product: 'server', platform: 'darwin-universal' }];
  const approval: OwnerDirectiveRow = {
    id: 123,
    workspaceId: 'papercusp-workspace',
    ownerId: 'owner',
    sessionRef: 'owner-session',
    sourceTurnRef: 'owner-turn',
    verbatimText: 'I explicitly approve the partial desktop scope for 0.0.21 alpha; omit macOS and Windows.',
    recordedBy: 'owner-session',
    createdAtMs: 1,
    dispositionedAtMs: null,
    dispositionStatus: null,
    dispositionNote: null,
    dispositionedBy: null,
    capturedByHook: true,
  };

  it('refuses an incomplete desktop scope without a captured owner directive', () => {
    expect(
      incompleteDesktopScopeRefusal('0.0.21', 'alpha', missing, null, 'papercusp-workspace'),
    ).toMatch(/REFUSING TO RECORD.*explicit owner approval/u);
  });

  it('accepts only a captured owner directive approving this exact version and partial scope', () => {
    expect(
      incompleteDesktopScopeRefusal('0.0.21', 'alpha', missing, approval, 'papercusp-workspace'),
    ).toBeNull();
    expect(
      incompleteDesktopScopeRefusal('0.0.21', 'alpha', missing, { ...approval, capturedByHook: false }, 'papercusp-workspace'),
    ).toMatch(/captured owner directive/u);
    expect(
      incompleteDesktopScopeRefusal('0.0.21', 'alpha', missing, { ...approval, verbatimText: 'I approve this partial release' }, 'papercusp-workspace'),
    ).toMatch(/does not explicitly approve/u);
    expect(
      incompleteDesktopScopeRefusal('0.0.21', 'alpha', missing, { ...approval, workspaceId: 'other-workspace' }, 'papercusp-workspace'),
    ).toMatch(/captured owner directive/u);
    expect(
      incompleteDesktopScopeRefusal('0.0.21', 'alpha', missing, { ...approval, verbatimText: 'I do not approve the partial desktop scope for 0.0.21 alpha; omit macOS and Windows.' }, 'papercusp-workspace'),
    ).toMatch(/REFUSING TO RECORD/u);
  });

  it('does not require an approval reference for a complete scope', () => {
    expect(incompleteDesktopScopeRefusal('0.0.21', 'alpha', [], null, 'papercusp-workspace')).toBeNull();
  });
});

describe('computeMobileRegression — a cut that LOSES a phone build its predecessor had (WI-5583)', () => {
  const gui = (platform: string) => ({ product: 'gui' as const, platform });
  const android = { product: 'mobile' as const, platform: 'android-universal' };
  const ios = { product: 'mobile' as const, platform: 'ios-arm64' };

  it('catches the exact 0.0.12 gap: prior shipped android+ios, this cut ships neither', () => {
    const { dropped } = computeMobileRegression(
      [gui('linux-x86_64'), gui('darwin-universal'), gui('windows-x86_64')], // 0.0.12: desktop only
      [gui('linux-x86_64'), android, ios], // 0.0.11: had both phones
    );
    expect(dropped).toEqual(['android-universal', 'ios-arm64']);
  });

  it('reports only the platform actually dropped, not the one still present', () => {
    const { dropped } = computeMobileRegression([android], [android, ios]);
    expect(dropped).toEqual(['ios-arm64']);
  });

  it('is silent once the drop settles — a mobile-less cut after a mobile-less predecessor does not re-fire', () => {
    // 0.0.13 (no mobile) vs 0.0.12 (no mobile) → nothing regressed.
    const { dropped } = computeMobileRegression([gui('linux-x86_64')], [gui('linux-x86_64')]);
    expect(dropped).toEqual([]);
  });

  it('a mobile ADDITION is not a regression (gaining a phone build never warns)', () => {
    const { dropped } = computeMobileRegression([android, ios], [android]);
    expect(dropped).toEqual([]);
  });

  it('no predecessor (first release ever) is not a regression', () => {
    const { dropped } = computeMobileRegression([gui('linux-x86_64')], []);
    expect(dropped).toEqual([]);
  });

  it('ignores desktop churn entirely — dropping a desktop platform is the completeness check’s job, not this one', () => {
    const { dropped } = computeMobileRegression([gui('linux-x86_64'), android, ios], [
      gui('linux-x86_64'),
      gui('windows-x86_64'),
      android,
      ios,
    ]);
    expect(dropped).toEqual([]); // windows dropped, but mobile intact → no mobile regression
  });
});

describe('formatMobileRegressionAlert — non-blocking, names the dropped phone build (WI-5583)', () => {
  it('is empty when nothing regressed (a cut that kept its mobile builds prints no alert)', () => {
    expect(formatMobileRegressionAlert('0.0.13', 'alpha', '0.0.12', [])).toBe('');
  });

  it('names the version, the predecessor, each dropped platform, and says it is NOT a rejection', () => {
    const alert = formatMobileRegressionAlert('0.0.12', 'alpha', '0.0.11', [
      'android-universal',
      'ios-arm64',
    ]);
    expect(alert).toContain('MOBILE REGRESSION: 0.0.12 (alpha)');
    expect(alert).toContain('0.0.11');
    expect(alert).toContain('Android');
    expect(alert).toContain('iOS (arm64)');
    expect(alert).toContain('NOT a rejection');
  });

  it('still renders without a known predecessor version', () => {
    const alert = formatMobileRegressionAlert('0.0.12', 'alpha', null, ['android-universal']);
    expect(alert).toContain('MOBILE REGRESSION: 0.0.12 (alpha)');
    expect(alert).toContain('the previous release');
    expect(alert).toContain('Android');
  });
});

describe('classifyArtifact — real filenames from real cuts, not invented ones', () => {
  it('maps the linux artifacts', () => {
    expect(classifyArtifact('Papercusp GUI_0.0.8_amd64.deb')).toEqual({
      product: 'gui',
      platform: 'linux-x86_64',
    });
    expect(classifyArtifact('Papercusp_GUI_0.0.8_amd64.AppImage')).toEqual({
      product: 'gui',
      platform: 'linux-x86_64',
    });
  });

  it('tells the Server product apart from the GUI', () => {
    expect(classifyArtifact('Papercusp Server_0.0.8_amd64.deb')).toEqual({
      product: 'server',
      platform: 'linux-x86_64',
    });
  });

  it('maps mac and windows', () => {
    expect(classifyArtifact('Papercusp GUI_0.0.9_universal.dmg')?.platform).toBe('darwin-universal');
    expect(classifyArtifact('Papercusp GUI.app.tar.gz')?.platform).toBe('darwin-universal');
    expect(classifyArtifact('Papercusp GUI_0.0.9_x64-setup.exe')?.platform).toBe('windows-x86_64');
    expect(classifyArtifact('Papercusp GUI_0.0.9_x64_en-US.msi')?.platform).toBe('windows-x86_64');
  });

  it('WI-5600: recognizes the normalized spanned Windows Server zip as the windows installer', () => {
    // The Windows Server DiskSpans (it bundles the dogfood source tree >4GB), so
    // release-local.sh normalizes the setup.exe stub + *-setup-N.bin disks into a
    // single "…-setup.zip" — THAT is the Windows Server download the page offers.
    expect(classifyArtifact('Papercusp Server_0.0.12_x64-setup.zip')).toEqual({
      product: 'server',
      platform: 'windows-x86_64',
    });
    // a gui-role zip (were the GUI ever to span) classifies as gui/windows.
    expect(classifyArtifact('Papercusp GUI_0.0.12_x64-setup.zip')).toEqual({
      product: 'gui',
      platform: 'windows-x86_64',
    });
    // Scoped to the "-setup.zip" suffix: an unrelated .zip is NOT a desktop installer.
    expect(classifyArtifact('source-bundle.zip')).toBeNull();
    expect(classifyArtifact('Papercusp_0.0.12_debug-symbols.zip')).toBeNull();
  });

  it('ignores signatures and checksums — they are not downloads', () => {
    expect(classifyArtifact('Papercusp_GUI_0.0.8_amd64.AppImage.sig')).toBeNull();
    expect(classifyArtifact('Papercusp GUI_0.0.8_amd64.deb.sha256')).toBeNull();
    expect(classifyArtifact('latest.json')).toBeNull();
  });

  it('maps the mobile apps to their own product (not gui/server)', () => {
    expect(classifyArtifact('Papercusp_0.0.9_android.apk')).toEqual({
      product: 'mobile',
      platform: 'android-universal',
    });
    expect(classifyArtifact('app-debug.apk')).toEqual({
      product: 'mobile',
      platform: 'android-universal',
    });
    expect(classifyArtifact('Papercusp_0.0.9_android.aab')?.platform).toBe('android-universal');
    expect(classifyArtifact('Papercusp_0.0.9_ios.ipa')).toEqual({
      product: 'mobile',
      platform: 'ios-arm64',
    });
    // "Server" in a mobile filename must NOT flip it to the server product — the
    // extension decides mobile, and mobile is its own product.
    expect(classifyArtifact('Papercusp Server_0.0.9_android.apk')?.product).toBe('mobile');
  });
});

describe('releaseTag', () => {
  it('carries the channel for a pre-release, and omits it for stable', () => {
    expect(releaseTag('0.0.9', 'alpha')).toBe('desktop-v0.0.9-alpha');
    expect(releaseTag('1.0.0', 'stable')).toBe('desktop-v1.0.0');
  });
});

describe('isImplausiblyTiny — the artifact-recorder plausibility floor (EI-18673480587329034)', () => {
  it('flags anything below the floor, and nothing at or above it', () => {
    expect(isImplausiblyTiny(0)).toBe(true);
    expect(isImplausiblyTiny(245)).toBe(true); // the real AppleDouble sidecar size that prompted this
    expect(isImplausiblyTiny(MIN_PLAUSIBLE_ARTIFACT_BYTES - 1)).toBe(true);
    expect(isImplausiblyTiny(MIN_PLAUSIBLE_ARTIFACT_BYTES)).toBe(false);
    expect(isImplausiblyTiny(MIN_PLAUSIBLE_ARTIFACT_BYTES + 1)).toBe(false);
    expect(isImplausiblyTiny(1_306_392_652)).toBe(false); // a real mac dmg size
  });
});

describe('assertRequestedDesktopArtifacts — reject zero-artifact records', () => {
  it('rejects a requested version when every resolved bundle root is empty or stale', () => {
    expect(() =>
      assertRequestedDesktopArtifacts('0.0.17', [], ['/release/bundle/linux', '/release/bundle/mac']),
    ).toThrow(/no desktop artifact matching the requested version was found/);
  });

  it('accepts a real requested-version artifact found across the resolved roots', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-assert-'));
    const debDir = path.join(root, 'deb');
    fs.mkdirSync(debDir, { recursive: true });
    fs.writeFileSync(path.join(debDir, 'Papercusp GUI_0.0.17_amd64.deb'), plausibleBytes('assert'));

    const artifacts = scanArtifacts([root], '0.0.17', 'desktop-v0.0.17-alpha');
    expect(() => assertRequestedDesktopArtifacts('0.0.17', artifacts, [root])).not.toThrow();

    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('scanArtifacts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-scan-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  fs.mkdirSync(path.join(tmp, 'deb'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'appimage'), { recursive: true });
  const debBytes = plausibleBytes('deb-bytes');
  const appimageBytes = plausibleBytes('appimage-bytes');
  fs.writeFileSync(path.join(tmp, 'deb', 'Papercusp GUI_0.0.9_amd64.deb'), debBytes);
  fs.writeFileSync(path.join(tmp, 'deb', 'Papercusp GUI_0.0.8_amd64.deb'), 'old-version');
  fs.writeFileSync(path.join(tmp, 'appimage', 'Papercusp_GUI_0.0.9_amd64.AppImage'), appimageBytes);
  fs.writeFileSync(path.join(tmp, 'appimage', 'Papercusp_GUI_0.0.9_amd64.AppImage.sig'), 'sig');

  const found = scanArtifacts([tmp], '0.0.9', 'desktop-v0.0.9-alpha');

  it('finds only THIS version, and no signatures', () => {
    expect(found.map((a) => a.name).sort()).toEqual([
      'Papercusp GUI_0.0.9_amd64.deb',
      'Papercusp_GUI_0.0.9_amd64.AppImage',
    ]);
  });

  it('stores the url RELATIVE — the base path is the shared secret and must not reach Postgres', () => {
    for (const a of found) {
      expect(a.url).toBe(`desktop-v0.0.9-alpha/${a.name}`);
      expect(a.url).not.toMatch(/^https?:\/\//);
    }
  });

  it('records real size and a real sha256 of the actual bytes', () => {
    const deb = found.find((a) => a.name.endsWith('.deb'))!;
    expect(deb.size).toBe(debBytes.length);
    expect(deb.sha256).toBe(createHash('sha256').update(debBytes).digest('hex'));
    const appimage = found.find((a) => a.name.endsWith('.AppImage'))!;
    expect(appimage.sha256).not.toBe(deb.sha256);
  });

  it('returns nothing rather than throwing when the bundle dir is absent', () => {
    expect(scanArtifacts([path.join(tmp, 'nope')], '0.0.9', 'desktop-v0.0.9-alpha')).toEqual([]);
  });

  /**
   * THE 0.0.8 BUG, pinned. The mac and windows installers were built, signed, and
   * sitting on disk — in DIFFERENT bundle roots than linux — and the recorder, which
   * scanned one linux root and a subdir list with no `inno` in it, never looked at
   * them. 0.0.8 shipped a release page that offered a Mac or Windows tester nothing
   * to download, and told nobody. If this ever goes green with fewer than 3
   * platforms, that release is lying to two thirds of the beta testers again.
   */
  it('finds ALL THREE platforms across their separate bundle roots (0.0.8 shipped linux-only)', () => {
    const lin = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-lin-'));
    const mac = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-mac-'));
    const win = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-win-'));
    fs.mkdirSync(path.join(lin, 'deb'), { recursive: true });
    fs.mkdirSync(path.join(mac, 'dmg'), { recursive: true });
    // Windows lands in inno/ — the subdir the old list omitted entirely.
    fs.mkdirSync(path.join(win, 'inno'), { recursive: true });
    fs.writeFileSync(path.join(lin, 'deb', 'Papercusp GUI_0.0.9_amd64.deb'), plausibleBytes('l'));
    fs.writeFileSync(path.join(mac, 'dmg', 'Papercusp GUI_0.0.9_universal-apple-darwin.dmg'), plausibleBytes('m'));
    fs.writeFileSync(path.join(win, 'inno', 'Papercusp GUI_0.0.9_x64-setup.exe'), plausibleBytes('w'));
    fs.writeFileSync(path.join(win, 'inno', 'Papercusp GUI_0.0.9_x64-setup.exe.sig'), 'sig');

    const all = scanArtifacts([lin, mac, win], '0.0.9', 'desktop-v0.0.9-alpha');
    expect(all.map((a) => a.platform).sort()).toEqual([
      'darwin-universal',
      'linux-x86_64',
      'windows-x86_64',
    ]);
    // every platform a beta tester can actually be on has a GUI installer
    expect(all.filter((a) => a.product === 'gui')).toHaveLength(3);

    for (const d of [lin, mac, win]) fs.rmSync(d, { recursive: true, force: true });
  });

  it('WI-5600: records the normalized Server zip and SKIPS the bare spanned stub + .bin disks', () => {
    // As they land on disk after release-local.sh's span-normalization: the raw
    // spanned Server (stub + disks) PLUS the single "…-setup.zip" it produces, and
    // a single-file GUI alongside. The recorder must publish the zip (a working
    // download) — never the bare stub (isSpannedInstaller: an uninstallable
    // download) nor the raw .bin disks (not installers on their own).
    const win = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-span-'));
    fs.mkdirSync(path.join(win, 'inno'), { recursive: true });
    const inno = path.join(win, 'inno');
    // The bare stub stays tiny on purpose — it must be caught by isSpannedInstaller
    // (structural: companion .bin disks exist), not by the size floor, so this test
    // keeps pinning the SPANNED-installer behavior specifically.
    fs.writeFileSync(path.join(inno, 'Papercusp Server_0.0.12_x64-setup.exe'), 'stub');
    fs.writeFileSync(path.join(inno, 'Papercusp Server_0.0.12_x64-setup-1.bin'), 'd1');
    fs.writeFileSync(path.join(inno, 'Papercusp Server_0.0.12_x64-setup-2.bin'), 'd2');
    fs.writeFileSync(path.join(inno, 'Papercusp Server_0.0.12_x64-setup.zip'), plausibleBytes('zip'));
    fs.writeFileSync(path.join(inno, 'Papercusp GUI_0.0.12_x64-setup.exe'), plausibleBytes('gui'));

    // scanArtifacts warns (by design) as it skips the bare spanned stub; swallow
    // + assert that warning so vitest-fail-on-console stays green and the skip is pinned.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const found = scanArtifacts([win], '0.0.12', 'desktop-v0.0.12-alpha');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SKIPPING Papercusp Server_0.0.12_x64-setup.exe'));
    warn.mockRestore();
    const names = found.map((a) => a.name).sort();
    expect(names).toContain('Papercusp Server_0.0.12_x64-setup.zip');
    expect(names).not.toContain('Papercusp Server_0.0.12_x64-setup.exe'); // bare stub skipped
    expect(names).not.toContain('Papercusp Server_0.0.12_x64-setup-1.bin'); // raw disk not an installer
    expect(names).toContain('Papercusp GUI_0.0.12_x64-setup.exe'); // single-file GUI recorded normally
    expect(found).toHaveLength(2); // exactly the two real downloads, no phantom rows
    const srv = found.find((a) => a.name.endsWith('.zip'))!;
    expect(srv.product).toBe('server');
    expect(srv.platform).toBe('windows-x86_64');

    fs.rmSync(win, { recursive: true, force: true });
  });

  it('records an artifact reachable from two roots exactly ONCE', () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-dup-'));
    fs.mkdirSync(path.join(a, 'dmg'), { recursive: true });
    fs.writeFileSync(path.join(a, 'dmg', 'Papercusp GUI_0.0.9_universal-apple-darwin.dmg'), plausibleBytes('m'));
    // same root passed twice (the salvage/reuse path can alias two trees)
    expect(scanArtifacts([a, a], '0.0.9', 'desktop-v0.0.9-alpha')).toHaveLength(1);
    fs.rmSync(a, { recursive: true, force: true });
  });

  it('EI-18673480587329034: SKIPS a truncated/tiny file that name+extension would otherwise classify as real', () => {
    // A truncated copy, a 0-byte placeholder, or a partial rsync — none carry a
    // `._` prefix, so the AppleDouble-only fix would happily record it. The size
    // floor is the residual: whatever the shape, too small can never be real.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-tiny-'));
    fs.mkdirSync(path.join(dir, 'deb'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'deb', 'Papercusp GUI_0.0.9_amd64.deb'), 'x'.repeat(37)); // 37 bytes — nowhere near real

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const found = scanArtifacts([dir], '0.0.9', 'desktop-v0.0.9-alpha');
    expect(found).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('SKIPPING Papercusp GUI_0.0.9_amd64.deb'),
    );
    warn.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('records a file exactly one byte over the plausibility floor, and rejects one byte under', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-boundary-'));
    fs.mkdirSync(path.join(dir, 'deb'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'deb', 'Papercusp GUI_0.0.9_amd64.deb'),
      Buffer.alloc(MIN_PLAUSIBLE_ARTIFACT_BYTES),
    );
    expect(scanArtifacts([dir], '0.0.9', 'desktop-v0.0.9-alpha')).toHaveLength(1);

    fs.writeFileSync(
      path.join(dir, 'deb', 'Papercusp GUI_0.0.9_amd64.deb'),
      Buffer.alloc(MIN_PLAUSIBLE_ARTIFACT_BYTES - 1),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(scanArtifacts([dir], '0.0.9', 'desktop-v0.0.9-alpha')).toEqual([]);
    warn.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('hashes a file LARGER than one read chunk — the whole file, not just the first 1 MiB', () => {
    // Real artifacts are 3-4 GB. The first version of this used readFileSync and
    // died with ERR_FS_FILE_TOO_LARGE (Node's 2 GiB ceiling) on the first genuine
    // release; the chunked replacement's classic failure is hashing only chunk one.
    // 3 MiB of NON-uniform bytes: with uniform filler, a first-chunk-only bug
    // would still produce a plausible-looking (but wrong) digest.
    const big = path.join(tmp, 'deb', 'Papercusp GUI_9.9.9_amd64.deb');
    const chunk = 1 << 20;
    const bytes = Buffer.alloc(3 * chunk);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    fs.writeFileSync(big, bytes);

    const [artifact] = scanArtifacts([tmp], '9.9.9', 'desktop-v9.9.9-alpha');
    expect(artifact.size).toBe(3 * chunk);
    expect(artifact.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    // ...and specifically NOT the digest of just the first chunk.
    expect(artifact.sha256).not.toBe(
      createHash('sha256').update(bytes.subarray(0, chunk)).digest('hex'),
    );
  });
});

describe('provenanced Android artifacts — requested version + current source + exact bytes', () => {
  it('returns nothing when the mobile root is null or absent (a desktop-only cut is legal)', () => {
    expect(scanMobileArtifacts(null, '0.0.9', 'desktop-v0.0.9-alpha')).toEqual([]);
    expect(scanMobileArtifacts('/no/such/mobile/root', '0.0.9', 'desktop-v0.0.9-alpha')).toEqual([]);
  });

  it('rejects raw debug/release output when no provenance manifest exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-'));
    const apkDir = path.join(root, 'android/app/build/outputs/apk/debug');
    fs.mkdirSync(apkDir, { recursive: true });
    fs.writeFileSync(path.join(apkDir, 'app-debug.apk'), plausibleBytes('debug'));
    expect(() => scanMobileArtifactSources(root, '0.0.9', { iosCiState: noIosCiState(root) })).toThrow(/without .*provenance/i);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns exactly the manifest-bound APK+AAB under synthesized versioned names', () => {
    const fixture = makeAndroidFixture();
    expect(scanProvenancedAndroidArtifactSources(fixture.root, '0.0.9')).toEqual([
      { src: fixture.apk, outName: 'Papercusp_0.0.9_android.apk' },
      { src: fixture.aab, outName: 'Papercusp_0.0.9_android.aab' },
    ]);
    const found = scanMobileArtifacts(fixture.root, '0.0.9', 'desktop-v0.0.9-alpha', {
      iosCiState: noIosCiState(fixture.root),
    });
    expect(found.map((artifact) => artifact.name).sort()).toEqual([
      'Papercusp_0.0.9_android.aab',
      'Papercusp_0.0.9_android.apk',
    ]);
    expect(found.every((artifact) => artifact.url.startsWith('desktop-v0.0.9-alpha/'))).toBe(true);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  it('rejects a foreign mobile product before it can produce Papercusp upload names', () => {
    const fixture = makeAndroidFixture();
    expect(() =>
      scanMobileArtifactSources(fixture.root, '0.0.9', { productName: 'SideStage', iosCiState: noIosCiState(fixture.root) }),
    ).toThrow(/only "Papercusp"/);
    expect(scanMobileArtifactSources(fixture.root, '0.0.9', { iosCiState: noIosCiState(fixture.root) }).map(({ outName }) => outName)).toEqual([
      'Papercusp_0.0.9_android.apk',
      'Papercusp_0.0.9_android.aab',
    ]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  it('rejects mobile product names that could escape the object-key directory or TSV row', () => {
    expect(() => validateMobileProductName('../SideStage')).toThrow(/Invalid mobile product name/);
    expect(() => validateMobileProductName('SideStage\tMobile')).toThrow(/Invalid mobile product name/);
    expect(validateMobileProductName(' SideStage ')).toBe('SideStage');
  });

  it('rejects requested-version, source-commit, and canonical-path drift', () => {
    const fixture = makeAndroidFixture();
    const options = { iosCiState: noIosCiState(fixture.root) };
    expect(() => scanMobileArtifactSources(fixture.root, '0.0.10', options)).toThrow(/releaseVersion/);
    updateManifest(fixture.manifest, (manifest) => {
      manifest.releaseVersion = '0.0.9';
      manifest.sourceCommit = 'f'.repeat(40);
    });
    expect(() => scanMobileArtifactSources(fixture.root, '0.0.9', options)).toThrow(/current HEAD/);
    updateManifest(fixture.manifest, (manifest) => {
      manifest.sourceCommit = fixture.commit;
      manifest.artifacts.apk.path = 'android/app/build/outputs/apk/debug/app-debug.apk';
    });
    expect(() => scanMobileArtifactSources(fixture.root, '0.0.9', options)).toThrow(/canonical path/);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  it('rejects missing, resized, and hash-tampered members of the required pair', () => {
    const fixture = makeAndroidFixture();
    fs.rmSync(fixture.aab);
    const options = { iosCiState: noIosCiState(fixture.root) };
    expect(() => scanMobileArtifactSources(fixture.root, '0.0.9', options)).toThrow(/aab artifact is missing/);
    fs.writeFileSync(fixture.aab, plausibleBytes('replacement-aab'));
    expect(() => scanMobileArtifactSources(fixture.root, '0.0.9', options)).toThrow(/aab sha256/);
    fs.appendFileSync(fixture.apk, 'tampered');
    expect(() => scanMobileArtifactSources(fixture.root, '0.0.9', options)).toThrow(/apk size/);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  it('rejects a manifest after tracked source changes', () => {
    const fixture = makeAndroidFixture();
    fs.appendFileSync(path.join(fixture.root, 'source.txt'), 'dirty\n');
    expect(() => scanMobileArtifactSources(fixture.root, '0.0.9', { iosCiState: noIosCiState(fixture.root) })).toThrow(/source tree .* dirty/);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  it('keeps raw unversioned iOS dormant and permits explicit Android opt-out', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-'));
    const ipa = path.join(root, 'ios/build/export/Papercup.ipa');
    const rawApk = path.join(root, 'android/app/build/outputs/apk/debug/app-debug.apk');
    fs.mkdirSync(path.dirname(ipa), { recursive: true });
    fs.mkdirSync(path.dirname(rawApk), { recursive: true });
    fs.writeFileSync(ipa, plausibleBytes('ipa'));
    fs.writeFileSync(rawApk, plausibleBytes('unprovenanced'));
    expect(scanMobileArtifactSources(root, '0.0.9', { skipAndroid: true, iosCiState: noIosCiState(root) })).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('signed native iOS artifacts — current source + App Store Connect + exact runner bytes', () => {
  it('admits the signed App Store Connect IPA while --skip-android skips only Android', () => {
    const fixture = makeIosFixture();
    try {
      const rawApk = path.join(fixture.root, 'android/app/build/outputs/apk/debug/app-debug.apk');
      fs.mkdirSync(path.dirname(rawApk), { recursive: true });
      fs.writeFileSync(rawApk, plausibleBytes('unprovenanced-android'));
      expect(scanMobileArtifactSources(fixture.root, '0.0.9', {
        skipAndroid: true,
        iosCiState: fixture.state,
      })).toEqual([{ src: fixture.ipa, outName: 'Papercusp_0.0.9_ios.ipa' }]);

      const [artifact] = scanMobileArtifacts(fixture.root, '0.0.9', 'desktop-v0.0.9-alpha', {
        skipAndroid: true,
        iosCiState: fixture.state,
      });
      expect(artifact).toMatchObject({
        product: 'mobile',
        platform: 'ios-arm64',
        name: 'Papercusp_0.0.9_ios.ipa',
        url: 'desktop-v0.0.9-alpha/Papercusp_0.0.9_ios.ipa',
        size: fs.statSync(fixture.ipa).size,
        sha256: createHash('sha256').update(fs.readFileSync(fixture.ipa)).digest('hex'),
      });
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
      fs.rmSync(fixture.state, { recursive: true, force: true });
    }
  });

  it('ignores raw unversioned IPAs and check-mode runner results', () => {
    const fixture = makeIosFixture();
    try {
      const rawIpa = path.join(fixture.root, 'ios/build/export/Papercup.ipa');
      fs.mkdirSync(path.dirname(rawIpa), { recursive: true });
      fs.writeFileSync(rawIpa, plausibleBytes('raw-ipa'));
      updateIosResult(fixture, (result) => {
        result.mode = 'check';
      });
      expect(scanMobileArtifactSources(fixture.root, '0.0.9', {
        skipAndroid: true,
        iosCiState: fixture.state,
      })).toEqual([]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
      fs.rmSync(fixture.state, { recursive: true, force: true });
    }
  });

  it('rejects stale version and source provenance', () => {
    const fixture = makeIosFixture();
    const options = { skipAndroid: true, iosCiState: fixture.state };
    try {
      expect(() => scanMobileArtifactSources(fixture.root, '0.0.10', options)).toThrow(/requested version/);
      fs.appendFileSync(path.join(fixture.root, 'source.txt'), 'next committed source\n');
      execFileSync('git', ['add', 'source.txt'], { cwd: fixture.root });
      execFileSync('git', ['commit', '-qm', 'next source'], { cwd: fixture.root });
      expect(() => scanMobileArtifactSources(fixture.root, '0.0.9', options)).toThrow(/does not match current HEAD/);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
      fs.rmSync(fixture.state, { recursive: true, force: true });
    }
  });

  it('rejects a dirty mobile source tree', () => {
    const fixture = makeIosFixture();
    try {
      fs.appendFileSync(path.join(fixture.root, 'source.txt'), 'uncommitted source\n');
      expect(() => scanMobileArtifactSources(fixture.root, '0.0.9', {
        skipAndroid: true,
        iosCiState: fixture.state,
      })).toThrow(/iOS source tree .* dirty/);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
      fs.rmSync(fixture.state, { recursive: true, force: true });
    }
  });

  it('rejects tampered IPA bytes and paths outside the attempt', () => {
    const fixture = makeIosFixture();
    const options = { skipAndroid: true, iosCiState: fixture.state };
    try {
      fs.appendFileSync(fixture.ipa, 'tampered');
      expect(() => scanMobileArtifactSources(fixture.root, '0.0.9', options)).toThrow(/receipt size/);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
      fs.rmSync(fixture.state, { recursive: true, force: true });
    }

    const pathFixture = makeIosFixture();
    try {
      updateManifest(pathFixture.manifest, (manifest) => {
        manifest.artifacts[0].path = '../outside.ipa';
      });
      refreshIosManifestReceipt(pathFixture);
      expect(() => scanMobileArtifactSources(pathFixture.root, '0.0.9', {
        skipAndroid: true,
        iosCiState: pathFixture.state,
      })).toThrow(/canonical export\/\*\.ipa path/);
    } finally {
      fs.rmSync(pathFixture.root, { recursive: true, force: true });
      fs.rmSync(pathFixture.state, { recursive: true, force: true });
    }
  });

  it('rejects registered-device exports and latest/attempt result disagreement', () => {
    const fixture = makeIosFixture('0.0.9', 'release-testing');
    try {
      expect(() => scanMobileArtifactSources(fixture.root, '0.0.9', {
        skipAndroid: true,
        iosCiState: fixture.state,
      })).toThrow(/not public-release eligible/);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
      fs.rmSync(fixture.state, { recursive: true, force: true });
    }

    const parityFixture = makeIosFixture();
    try {
      const latest = JSON.parse(fs.readFileSync(parityFixture.latest, 'utf8'));
      latest.pairedUI = true;
      fs.writeFileSync(parityFixture.latest, `${JSON.stringify(latest, null, 2)}\n`);
      expect(() => scanMobileArtifactSources(parityFixture.root, '0.0.9', {
        skipAndroid: true,
        iosCiState: parityFixture.state,
      })).toThrow(/does not match its attempt-local result/);
    } finally {
      fs.rmSync(parityFixture.root, { recursive: true, force: true });
      fs.rmSync(parityFixture.state, { recursive: true, force: true });
    }
  });
});

describe('buildRunOpts — the mobileRoot-drop regression guard', () => {
  // main() once computed `mobileRoot` and then FORGOT to put it in the run({...})
  // object, so scanMobileArtifacts got `undefined` and silently recorded NO mobile
  // artifact on every real cut. Every unit test passed; only an end-to-end dry-run
  // caught it. buildRunOpts builds ONE object; asserting its fields here makes that
  // whole class of "computed-but-not-wired" drop impossible without a red test.
  it('wires --mobile-root through onto the opts object', () => {
    const opts = buildRunOpts(['--version', '0.0.9', '--mobile-root', '/tmp/some-mobile-root']);
    expect(opts.mobileRoot).toBe('/tmp/some-mobile-root');
    expect(opts.mobileProductName).toBe('Papercusp');
    expect(opts.version).toBe('0.0.9');
    expect(opts.skipAndroid).toBe(false);
    expect(Array.isArray(opts.bundleDirs)).toBe(true);
  });

  it('rejects a foreign mobile product identity through argv and env', () => {
    expect(() =>
      buildRunOpts(['--version', '1.2.3', '--mobile-product-name', 'SideStage']),
    ).toThrow(/only "Papercusp"/);
    const previous = process.env.PAPERCUSP_MOBILE_PRODUCT_NAME;
    process.env.PAPERCUSP_MOBILE_PRODUCT_NAME = 'EnvStage';
    try {
      expect(() => buildRunOpts(['--version', '1.2.3'])).toThrow(/only "Papercusp"/);
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_MOBILE_PRODUCT_NAME;
      else process.env.PAPERCUSP_MOBILE_PRODUCT_NAME = previous;
    }
  });

  it('falls back to PAPERCUSP_MOBILE_ROOT when --mobile-root is absent', () => {
    const prev = process.env.PAPERCUSP_MOBILE_ROOT;
    process.env.PAPERCUSP_MOBILE_ROOT = '/tmp/env-mobile-root';
    try {
      expect(buildRunOpts(['--version', '0.0.9']).mobileRoot).toBe('/tmp/env-mobile-root');
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_MOBILE_ROOT;
      else process.env.PAPERCUSP_MOBILE_ROOT = prev;
    }
  });

  it('does not scan an unrelated sibling mobile build during desktop-only recording', () => {
    const previous = process.env.PAPERCUSP_MOBILE_ROOT;
    delete process.env.PAPERCUSP_MOBILE_ROOT;
    try {
      const desktop = buildRunOpts(['--version', '0.0.21', '--bundle', '/tmp/desktop-bundle']);
      expect(desktop.mobileRoot).toBeNull();
      expect(scanMobileArtifacts(desktop.mobileRoot, desktop.version, 'desktop-v0.0.21-alpha')).toEqual([]);

      // Supplying a mobile root is still an affirmative request: a raw Android
      // output without provenance must fail closed, even for a desktop bundle.
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-residue-'));
      try {
        const apkDir = path.join(root, 'android/app/build/outputs/apk/debug');
        fs.mkdirSync(apkDir, { recursive: true });
        fs.writeFileSync(path.join(apkDir, 'app-debug.apk'), plausibleBytes('debug'));
        const withMobile = buildRunOpts([
          '--version', '0.0.21', '--bundle', '/tmp/desktop-bundle', '--mobile-root', root,
        ]);
        expect(() => scanMobileArtifacts(withMobile.mobileRoot, withMobile.version, 'desktop-v0.0.21-alpha', {
          iosCiState: noIosCiState(root),
        }))
          .toThrow(/without .*provenance/i);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_MOBILE_ROOT;
      else process.env.PAPERCUSP_MOBILE_ROOT = previous;
    }
  });

  it('carries the channel + dry-run flags through the same object', () => {
    const opts = buildRunOpts([
      '--version',
      '1.2.3',
      '--channel',
      'beta',
      '--dry-run',
      '--mobile-root',
      '/x',
    ]);
    expect(opts.channel).toBe('beta');
    expect(opts.dryRun).toBe(true);
    expect(opts.mobileRoot).toBe('/x');
  });

  it('requires an explicit flag or env value to skip Android provenance enforcement', () => {
    expect(buildRunOpts(['--version', '1.2.3', '--skip-android']).skipAndroid).toBe(true);
    const previous = process.env.PAPERCUSP_SKIP_ANDROID;
    process.env.PAPERCUSP_SKIP_ANDROID = '1';
    try {
      expect(buildRunOpts(['--version', '1.2.3']).skipAndroid).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_SKIP_ANDROID;
      else process.env.PAPERCUSP_SKIP_ANDROID = previous;
    }
  });

  it('carries a positive owner directive id as the partial-platform approval reference', () => {
    expect(
      buildRunOpts([
        '--version',
        '0.0.21',
        '--owner-approved-partial-scope',
        '123',
      ]).ownerApprovedPartialScopeOrderId,
    ).toBe(123);
    expect(buildRunOpts(['--version', '0.0.21']).ownerApprovedPartialScopeOrderId).toBeNull();
    expect(() =>
      buildRunOpts(['--version', '0.0.21', '--owner-approved-partial-scope', 'not-an-id']),
    ).toThrow(/positive owner directive id/u);
  });

  it('requires changelog text by default and carries the explicit no-changelog escape hatch', () => {
    expect(buildRunOpts(['--version', '1.2.3']).allowNoChangelog).toBe(false);
    expect(buildRunOpts(['--version', '1.2.3', '--no-changelog']).allowNoChangelog).toBe(true);
  });
});

describe('resolveChangelogWindowStart — bound new gaps without shrinking re-records', () => {
  const cutAt = new Date('2026-09-22T12:00:00.000Z');
  const maxLookback = new Date('2026-09-08T12:00:00.000Z');

  it('uses a recent previous release as the lower bound', () => {
    const previous = new Date('2026-09-20T12:00:00.000Z');
    expect(resolveChangelogWindowStart(cutAt, previous, null).toISOString()).toBe(previous.toISOString());
  });

  it('caps a new release window when intermediate releases were not recorded', () => {
    const previous = new Date('2026-08-21T00:12:37.239Z');
    expect(resolveChangelogWindowStart(cutAt, previous, null).toISOString()).toBe(maxLookback.toISOString());
  });

  it('keeps an existing-version re-record on its previous-release window', () => {
    const previous = new Date('2026-08-21T00:12:37.239Z');
    expect(resolveChangelogWindowStart(cutAt, previous, null, true).toISOString()).toBe(previous.toISOString());
  });

  it('uses the bounded lookback when the channel has no previous release', () => {
    expect(resolveChangelogWindowStart(cutAt, null, null).toISOString()).toBe(maxLookback.toISOString());
  });

  it('honors an explicit --since backfill even when the default is capped', () => {
    const explicitSince = new Date('2026-08-21T00:12:37.239Z');
    expect(resolveChangelogWindowStart(cutAt, explicitSince, explicitSince).toISOString()).toBe(explicitSince.toISOString());
  });
});

describe('validateRecordChangelog — fail closed on accidental changelog omission (EI-20072519085830387)', () => {
  it('rejects missing and whitespace-only changelogs unless explicitly opted out', () => {
    expect(validateRecordChangelog(null)).toMatch(/REFUSING TO RECORD/);
    expect(validateRecordChangelog('  \n\t')).toMatch(/--no-changelog/);
    expect(validateRecordChangelog(null, true)).toBeNull();
    expect(validateRecordChangelog('  \n\t', true)).toBeNull();
  });

  it('accepts reviewed changelog text', () => {
    expect(validateRecordChangelog('## Highlights\n\n- Fixed auto-update')).toBeNull();
  });

  it('stops the real CLI path before opening the registry when the changelog is omitted', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(main(['--version', '1.2.3'])).resolves.toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/REFUSING TO RECORD/));
    } finally {
      error.mockRestore();
    }
  });
});

describe('Android release producer/consumer source contract (D-004)', () => {
  const desktopDir = path.resolve(__dirname, '../../../../papercusp-desktop');
  const mobileDir = process.env.PAPERCUSP_MOBILE_ROOT
    ?? resolveMobileRoot(__dirname);
  const mobileBuildScript = mobileDir
    ? path.join(mobileDir, 'tools/build-scripts/build-android.sh')
    : null;
  const hasMobileBuildScript = mobileBuildScript !== null && fs.existsSync(mobileBuildScript);
  const requireMobileSibling = process.env.PAPERCUSP_REQUIRE_MOBILE_SIBLING === '1';

  it('resolves the sibling mobile repo from a staging candidate checkout', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'android-mobile-root-'));
    try {
      const mobileRoot = path.join(workspace, 'papercup-rust-mobile');
      fs.mkdirSync(path.join(mobileRoot, 'crates'), { recursive: true });
      const candidateTestDir = path.join(
        workspace,
        'papercusp-staging.generations',
        '.candidate-test',
        'checkout',
        'apps/operator/lib/release',
      );
      fs.mkdirSync(candidateTestDir, { recursive: true });

      expect(resolveMobileRoot(candidateTestDir)).toBe(mobileRoot);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('mobile producer source is present or explicitly not asserted by this workspace', () => {
    if (!hasMobileBuildScript) {
      expect(
        requireMobileSibling,
        'papercup-rust-mobile build-android.sh is absent, so the producer source-contract assertion below is skipped. Set PAPERCUSP_REQUIRE_MOBILE_SIBLING=1 to make this absence a failure.',
      ).toBe(false);
      return;
    }
    expect(mobileBuildScript).toBeTruthy();
  });

  it.skipIf(!hasMobileBuildScript)(
    'build-android deletes the old pair/manifest and writes provenance only after verification',
    () => {
      const script = fs.readFileSync(mobileBuildScript!, 'utf8');
      expect(script).toContain('PAPERCUP_RELEASE_VERSION');
      expect(script).toContain('rm -f "$RELEASE_APK" "$RELEASE_AAB" "$RELEASE_PROVENANCE"');
      const provenanceWrite = '"$REPO_ROOT/tools/build-scripts/android-release-provenance.sh" write';
      expect(script.indexOf('verify_16kb_alignment "$RELEASE_APK"')).toBeLessThan(
        script.indexOf(provenanceWrite),
      );
      expect(script).toContain(provenanceWrite);
    },
  );

  it('release-local passes the requested version and treats an enabled Android leg as fatal', () => {
    const script = fs.readFileSync(path.join(desktopDir, 'bin/release-local.sh'), 'utf8');
    expect(script).toContain('PAPERCUP_RELEASE_VERSION="$VERSION"');
    // The leg-joining mechanism was refactored 2026-08-15 from a per-leg `join_leg` call to
    // register_leg + a single supervise_legs reaper. The CONTRACT is unchanged — an enabled
    // Android leg is supervised FATALLY — so both halves are pinned: registering the leg is
    // inert unless something actually supervises it, and supervising is vacuous if the
    // Android leg was never registered.
    expect(script).toContain('register_leg android "$ANDROID_PID" "$ANDROID_LEG_LOG"');
    expect(script).toMatch(/^supervise_legs$/m);
    expect(script).toContain('exactly one provenanced APK and one AAB');
    expect(script).not.toContain('android leg did not produce a usable APK');
  });

  it('uploader propagates verifier failures and requires the pair unless explicitly skipped', () => {
    const script = fs.readFileSync(path.join(desktopDir, 'bin/upload-mobile-release.sh'), 'utf8');
    expect(script).toContain('if ! scan_output="$(cd "$ROOT" && npx tsx');
    expect(script).toContain('upload requires exactly one provenanced Android APK and AAB');
    expect(script).toContain('PAPERCUSP_SKIP_ANDROID=1');
    expect(script).toContain('--mobile-product-name "$MOBILE_PRODUCT_NAME"');
  });
});

/**
 * EI-18103803991060000 — the PRODUCER/CONSUMER contract for the linux bundle root.
 *
 * bin/build-linux-local.sh MOVES the finished linux artifacts out of cargo's real
 * target dir into `src-tauri/target/release/bundle`. The recorder scanned only the
 * dir they were moved OUT of, so it recorded ZERO linux artifacts — and exited 0,
 * because a missing scan root is deliberately not an error and the completeness
 * alert is deliberately non-fatal. Nothing anywhere compared the producer's
 * destination against the consumers' source, so the divergence was invisible.
 *
 * These read the OTHER SIDE OF THE CONTRACT OUT OF ITS OWN FILE, so moving the
 * artifacts again without updating the consumers reds HERE instead of silently
 * publishing a release page with no linux download on it.
 */
describe('linux bundle root — producer/consumer contract (EI-18103803991060000)', () => {
  const desktopDir = path.resolve(__dirname, '../../../../papercusp-desktop');
  const readScript = (rel: string) => fs.readFileSync(path.join(desktopDir, 'bin', rel), 'utf8');

  it('scans where build-linux-local.sh COLLECTS to, not just where cargo builds', () => {
    const script = readScript('build-linux-local.sh');
    const dest = /^DEST_BUNDLE="([^"]+)"/m.exec(script)?.[1];
    // Guard the guard: if the variable is renamed this must fail, not vacuously pass.
    expect(dest, 'DEST_BUNDLE not found in build-linux-local.sh').toBeTruthy();

    const desktopRoot = '/repo/papercusp-desktop';
    const resolvedDest = dest!.replace('$ROOT', desktopRoot);
    expect(resolvedDest).toBe(collectedLinuxBundleRoot(desktopRoot));
    expect(releaseBundleRoots('/some/explicit/--bundle', desktopRoot)).toContain(resolvedDest);
  });

  it('still scans cargo’s real target dir, so a raw `tauri build` is found too', () => {
    const prev = process.env.CARGO_TARGET_DIR;
    process.env.CARGO_TARGET_DIR = '/cargo-target';
    try {
      expect(releaseBundleRoots('/x', '/repo/papercusp-desktop')).toContain(
        '/cargo-target/release/bundle',
      );
    } finally {
      if (prev === undefined) delete process.env.CARGO_TARGET_DIR;
      else process.env.CARGO_TARGET_DIR = prev;
    }
  });

  it('never records an AppleDouble `._` sidecar as the real installer', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appledouble-'));
    const dmg = path.join(dir, 'dmg');
    fs.mkdirSync(dmg);
    // The 245-byte sidecar rsync leaves beside a mac bundle, and the real thing.
    fs.writeFileSync(path.join(dmg, '._Papercusp GUI_0.0.12_universal-apple-darwin.dmg'), 'x');
    fs.writeFileSync(
      path.join(dmg, 'Papercusp GUI_0.0.12_universal-apple-darwin.dmg'),
      plausibleBytes('real'),
    );

    const found = scanArtifacts([dir], '0.0.12', 'v0.0.12-alpha');
    expect(found.map((a) => a.name)).toEqual(['Papercusp GUI_0.0.12_universal-apple-darwin.dmg']);

    // And the sidecar must not be recorded even when it is the ONLY file left —
    // the live 2026-07-26 state, where recording it would publish a 245-byte "DMG".
    fs.rmSync(path.join(dmg, 'Papercusp GUI_0.0.12_universal-apple-darwin.dmg'));
    expect(scanArtifacts([dir], '0.0.12', 'v0.0.12-alpha')).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists each root once, so an overlapping checkout cannot double-scan', () => {
    const desktopRoot = '/repo/papercusp-desktop';
    const roots = releaseBundleRoots(collectedLinuxBundleRoot(desktopRoot), desktopRoot);
    expect(roots.length).toBe(new Set(roots).size);
  });

  it('publish-release-history.sh uploads the site record-release-cli generates', () => {
    // record's default --out is <bundleDir>/release-history; publish's default
    // SITE_DIR is ${BUNDLE}/release-history. The two BUNDLE defaults must agree, or
    // publish silently uploads a different (stale) index than the one just written.
    const publish = readScript('publish-release-history.sh');
    const bundleLine = /^BUNDLE="\$\{PAPERCUSP_BUNDLE_DIR:-([^}]+)\}"/m.exec(publish)?.[1];
    expect(bundleLine, 'BUNDLE default not found in publish-release-history.sh').toBeTruthy();
    expect(bundleLine!.replace('$DESKTOP_ROOT', '/repo/papercusp-desktop')).toBe(
      collectedLinuxBundleRoot('/repo/papercusp-desktop'),
    );

    // The publisher must ship and publicly verify the new detail-page directory;
    // otherwise a locally-correct index advertises links that all 404 publicly.
    expect(publish).toContain('release_storage_tree "$SITE_DIR/work-items" "${KEY_PREFIX}/work-items"');
    expect(publish).toContain('linked work-item detail page served and byte-identical');
    expect(publish).toContain('"${BASE}/${DETAIL_PAGE}"');

    // A plausible stale site must not pass merely because it has index/history
    // files. Both projections must bind to the release selected for publishing;
    // holding pages are the deliberate exception handled by the script.
    expect(publish).toContain('VERSION="${1:-${PAPERCUSP_RELEASE_VERSION:-}}"');
    expect(publish).toContain('historyVersion !== expectedVersion || indexVersion !== expectedVersion');
    expect(publish).toContain('papercusp-page-mode" content="holding"');
  });

  it.each(['match', 'stale'] as const)('public publish verification checks history.json with current index/detail (EI-22012030186241177): %s', (historyMode) => {
    const publish = path.resolve(desktopDir, 'bin', 'publish-release-history.sh');
    const runFixture = () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-history-publish-'));
      const site = path.join(root, 'site');
      const home = path.join(root, 'home');
      const bin = path.join(root, 'bin');
      const fetchPreload = path.join(root, 'fixture-fetch.mjs');
      const fetchLog = path.join(root, 'link-probes.jsonl');
      fs.mkdirSync(path.join(site, 'plans'), { recursive: true });
      fs.mkdirSync(path.join(site, 'work-items'), { recursive: true });
      fs.mkdirSync(path.join(home, '.papercusp'), { recursive: true });
      fs.mkdirSync(bin, { recursive: true });
      // The publisher also runs the real Node link checker. Its fetch calls
      // bypass the curl stub below, so contain them in this fixture too.
      fs.writeFileSync(fetchPreload, `import fs from 'node:fs';
globalThis.fetch = async (url, options = {}) => {
  const target = new URL(url);
  if (target.origin !== 'https://release.example' || !target.pathname.startsWith('/secret-path/')) {
    throw new Error('Unexpected fixture fetch: ' + target.href);
  }
  const relative = decodeURIComponent(target.pathname.slice('/secret-path/'.length));
  if (relative.split('/').includes('..')) throw new Error('Unsafe fixture fetch path');
  fs.appendFileSync(process.env.PROBE_FETCH_LOG, JSON.stringify({ method: options.method, path: target.pathname }) + '\\n');
  return new Response(null, { status: fs.existsSync(process.env.PROBE_SITE + '/' + relative) ? 200 : 404 });
};
`);

      const index = '<html><body><section class="rel" data-newest-release="1.2.3"><h2>1.2.3</h2><a href="work-items/WI-1.html">item</a><a href="changes/desktop-v1.2.3-alpha.html">Changes</a></section></body></html>\n';
      const history = '{"releases":[{"version":"1.2.3","artifacts":[]}]}\n';
      const detail = '<html>detail</html>\n';
      fs.writeFileSync(path.join(site, 'index.html'), index);
      fs.writeFileSync(path.join(site, 'history.json'), history);
      fs.writeFileSync(path.join(site, 'work-items', 'WI-1.html'), detail);
      for (const relative of ['changes/desktop-v1.2.3-alpha.html', 'changes/desktop-v1.2.3-alpha.json',
        'assets/project-history.js', 'assets/project-history.css', 'assets/vditor/dist/js/lute/lute.min.js']) {
        fs.mkdirSync(path.dirname(path.join(site, relative)), { recursive: true });
        fs.writeFileSync(path.join(site, relative), 'shared-history fixture');
      }
      fs.writeFileSync(
        path.join(home, '.papercusp', 'release-host.env'),
        'PAPERCUSP_UPDATE_BASE_URL=https://release.example/secret-path\n',
      );
      fs.writeFileSync(
        path.join(home, '.papercusp', 'release-storage.env'),
        'PAPERCUSP_RELEASE_GCS_BUCKET=fixture-release-bucket\n',
      );

      // The publisher's identity gate and authenticated upload are stubbed so this
      // test isolates the public-read proof. The curl stub serves current index/detail
      // bytes but can deliberately return stale history bytes.
      // WI-10003694: the publisher now asks release-site-delta for a plan first. The stub
      // answers with a FULL plan (no prior manifest), so this test keeps exercising the
      // full-publish public-read proof it was written for.
      fs.writeFileSync(
        path.join(bin, 'npx'),
        `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
if (a.some((x) => x.endsWith('release-site-delta.ts')) && a.includes('plan')) {
  const at = (flag) => a[a.indexOf(flag) + 1];
  fs.writeFileSync(at('--out'), JSON.stringify({ schema: 'release-site-publish-plan-v1', mode: 'full', reason: 'fixture', upload: [], remove: [], gate: [], unchangedCount: 0, next: null }));
  fs.writeFileSync(at('--gate-list'), '');
  fs.writeFileSync(at('--remove-list'), '');
}
process.exit(0);
`,
        { mode: 0o755 },
      );
      fs.writeFileSync(path.join(bin, 'gcloud'), `#!/usr/bin/env node
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const args = process.argv.slice(2);
const stateFile = process.env.PROBE_GCS_STATE;
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
if (args[0] === 'storage' && args[1] === 'objects' && args[2] === 'describe') {
  const object = state[args[3]];
  if (!object) { process.stderr.write('HTTPError 404 Not found\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify(object));
} else if (args[0] === 'storage' && args[1] === 'cp') {
  const bytes = fs.readFileSync(args[2]);
  state[args[3]] = {
    generation: '1', size: String(bytes.length),
    metadata: { sha256: createHash('sha256').update(bytes).digest('hex') },
  };
  fs.writeFileSync(stateFile, JSON.stringify(state));
} else {
  process.stderr.write('Unexpected fixture storage command: ' + args.join(' ') + '\\n');
  process.exit(99);
}
`, { mode: 0o755 });
      fs.writeFileSync(
        path.join(bin, 'curl'),
        `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const out = args[args.indexOf('-o') + 1];
const url = args.find(arg => arg.startsWith('https://')) || '';
if (url.endsWith('/instructions.html')) fs.writeFileSync(out, '<html>instructions, published separately (owner #868)</html>\\n');
else if (url.endsWith('/index.html')) fs.copyFileSync(process.env.PROBE_SITE + '/index.html', out);
else if (url.endsWith('/work-items/WI-1.html')) fs.copyFileSync(process.env.PROBE_SITE + '/work-items/WI-1.html', out);
else if (url.endsWith('/history.json')) fs.writeFileSync(out, ${JSON.stringify(historyMode === 'match' ? history : '{"releases":[{"version":"0.0.1"}]}\\n')});
else fs.copyFileSync(process.env.PROBE_SITE + '/' + url.split('/secret-path/')[1], out);
if (args.includes('-w')) process.stdout.write('200');
`,
        { mode: 0o755 },
      );

      const startedAt = Date.now();
      try {
        const result = spawnSync('bash', [publish, '1.2.3'], {
          cwd: path.resolve(__dirname, '../../../../'),
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            HOME: home,
            PAPERCUSP_RELEASE_STORAGE_ENV: path.join(home, '.papercusp', 'release-storage.env'),
            PAPERCUSP_RELEASE_SITE_DIR: site,
            PAPERCUSP_RELEASE_OWNER_NAME: 'Synthetic Owner',
            PROBE_SITE: site,
            PROBE_GCS_STATE: path.join(root, 'gcloud-state.json'),
            PROBE_FETCH_LOG: fetchLog,
            // Fixture CLIs are synthetic programs outside the repository. Do
            // not bootstrap the outer test runner's source loader in each one.
            NODE_OPTIONS: `--import=${pathToFileURL(fetchPreload).href}`,
            DRY_RUN: '0',
          },
          encoding: 'utf8',
          timeout: 45_000,
          killSignal: 'SIGKILL',
        });
        process.stderr.write(`RELEASE_HISTORY_FIXTURE ${JSON.stringify({
          historyMode, durationMs: Date.now() - startedAt, status: result.status,
          signal: result.signal, error: result.error?.message,
        })}\n`);
        const linkProbes: Array<{ method: string; path: string }> = fs.existsSync(fetchLog)
          ? fs.readFileSync(fetchLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
          : [];
        return { ...result, linkProbes };
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    };

    // Each full publisher invocation gets its own test budget. Combining both
    // controls in one synchronous test hid which invocation exhausted it.
    const result = runFixture();
    const diagnostics = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n');
    expect(result.error, diagnostics).toBeUndefined();
    expect(result.linkProbes.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { method: 'HEAD', path: '/secret-path/changes/desktop-v1.2.3-alpha.html' },
      { method: 'HEAD', path: '/secret-path/work-items/WI-1.html' },
    ]);
    if (historyMode === 'match') {
      expect(result.status, diagnostics).toBe(0);
      expect(result.stdout).toContain('history.json served and byte-identical');
    } else {
      // Falsifier: the publisher must refuse stale public feed bytes even
      // when its index and detail page are current.
      expect(result.status, diagnostics).not.toBe(0);
      expect(diagnostics).toContain('served history.json does NOT match');
    }
  });
});

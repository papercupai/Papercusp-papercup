/**
 * Guard test for scripts/check-licenses.mjs — the npm + Rust dependency license gate
 * (plan open-source-release-2026-09-29, P-017 / D-001, WI-10003906).
 *
 * WHY THESE CONTROLS EXIST
 * The gate's value is one decision per package: allowed or denied. Both failure directions
 * look green from outside. An evaluator that reads `GPL-3.0 OR MIT` as denied red-pins the
 * fleet on a dual-licensed crate; one that reads `MIT AND GPL-3.0` as allowed, or guesses at
 * a malformed expression, lets a copyleft dependency into a public release. The first audit
 * only found a non-commercial package (@codesandbox/nodebox) because a person opened its
 * LICENSE file, so the exception path matters as much as the evaluator: an exception must
 * stop applying the moment the package's declared license changes.
 *
 * Classifiers use inline fixtures; main() controls read temporary lockfile trees and
 * assert the gate's status and return code. No case mutates the shared checkout or
 * resolves Cargo dependencies. The committed exceptions file is validated as well.
 */
import { describe, it, expect, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Enrolled in tsconfig.declarations.json, so this import is typed by the generated
// sibling scripts/check-licenses.d.mts.
import {
  TIER,
  attributeInstaller,
  cargoPackagesOf,
  classify,
  collectThirdPartyNotices,
  collectInstallerTree,
  renderThirdPartyNotices,
  declaredNpmLicense,
  evaluateExpression,
  globToRegExp,
  main,
  npmPackageRootOf,
  npmPackagesOf,
  payloadKindOf,
  validateComponents,
  validateExceptions,
} from '../../../scripts/check-licenses.mjs';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const EXCEPTIONS_PATH = join(REPO_ROOT, 'scripts', 'license-exceptions.json');
// Overridable so scripts/mutation-probe.sh can point the guard at a mutated COPY (tier 2).
const COMPONENTS_PATH =
  process.env.LICENSE_COMPONENTS_PATH ?? join(REPO_ROOT, 'scripts', 'installer-components.json');

const tier = (expr: unknown) => evaluateExpression(expr).tier;

describe('collectInstallerTree — Syft directory mount exclusions', () => {
  const canUseTmpfs = process.platform === 'linux' && existsSync('/dev/shm')
    && Number(statfsSync('/dev/shm').type) === 0x01021994;

  it.runIf(canUseTmpfs)('stages exact npm bytes outside excluded tmpfs and removes scan scratch', () => {
    const root = mkdtempSync('/dev/shm/license-mount-control-');
    const bin = join(root, 'bin');
    const input = join(root, 'input');
    const logPath = join(root, 'scan-input');
    const manifest = JSON.stringify({ name: 'mount-control', version: '1.0.0', license: 'MIT' });
    mkdirSync(bin);
    mkdirSync(join(input, 'node_modules/mount-control'), { recursive: true });
    writeFileSync(join(input, 'node_modules/mount-control/package.json'), manifest);
    symlinkSync('package.json', join(input, 'node_modules/mount-control/manifest-link'));
    // A subprocess fixture models the measured Syft rule, not an empty SBOM
    // canned as success. It reads the exact bytes the checker supplied.
    const syft = join(bin, 'syft');
    writeFileSync(syft, `#!${process.execPath}\n` + [
      "const fs=require('node:fs'),path=require('node:path');",
      "const input=process.argv[2].slice(4);",
      `fs.writeFileSync(${JSON.stringify(logPath)},input);`,
      "const skipped=Number(fs.statfsSync(input).type)===0x01021994 && /^(?:\\/dev|\\/run)(?:\\/|$)/.test(input);",
      "const file=path.join(input,'node_modules/mount-control/package.json');",
      `if(fs.readFileSync(file,'utf8')!==${JSON.stringify(manifest)})process.exit(9);`,
      "if(fs.readlinkSync(path.join(input,'node_modules/mount-control/manifest-link'))!=='package.json')process.exit(10);",
      "const out=process.argv.find(a=>a.startsWith('syft-json=')).slice(10);",
      "fs.writeFileSync(out,JSON.stringify({artifacts:skipped||process.env.LICENSE_FIXTURE_EMPTY==='1'?[]:[{type:'npm',name:'mount-control',version:'1.0.0',licenses:[{spdxExpression:'MIT'}],locations:[{path:'/node_modules/mount-control/package.json'}]}]}));",
    ].join('\n'));
    chmodSync(syft, 0o700);
    const oldPath = process.env.PATH;
    const oldEmpty = process.env.LICENSE_FIXTURE_EMPTY;
    try {
      process.env.PATH = `${bin}:${oldPath}`;
      const result = collectInstallerTree(input, []);
      expect(result.syftArtifacts).toEqual([{
        type: 'npm', name: 'mount-control', version: '1.0.0', licenses: ['MIT'],
        path: 'node_modules/mount-control/package.json',
      }]);
      expect(result.undetermined).toEqual([]);
      expect(readFileSync(join(input, 'node_modules/mount-control/package.json'), 'utf8')).toBe(manifest);
      const scanned = readFileSync(logPath, 'utf8');
      expect(scanned).not.toBe(input);
      expect(existsSync(scanned)).toBe(false);
      process.env.LICENSE_FIXTURE_EMPTY = '1';
      const empty = collectInstallerTree(input, []);
      expect(empty.syftArtifacts).toEqual([]);
      expect(empty.undetermined).toHaveLength(1);
      expect(empty.undetermined[0]).toContain('Syft catalogued 0 npm packages');
      expect(existsSync(readFileSync(logPath, 'utf8'))).toBe(false);
    } finally {
      process.env.PATH = oldPath;
      if (oldEmpty === undefined) delete process.env.LICENSE_FIXTURE_EMPTY;
      else process.env.LICENSE_FIXTURE_EMPTY = oldEmpty;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('main — strict gate results over measured lockfile fixtures', () => {
  function runGate(license: string | null, argv = ['--strict', '--ecosystem=npm'], missingCargoManifest = false) {
    const root = mkdtempSync(join(tmpdir(), 'license-gate-main-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
        lockfileVersion: 3,
        packages: license === null ? {} : {
          '': { name: 'fixture' },
          'node_modules/gate-control': { version: '1.0.0', license },
        },
      }));
      if (missingCargoManifest) writeFileSync(join(root, 'Cargo.lock'), 'version = 3\n');
      const exitCode = main(argv, root);
      return { exitCode, output: log.mock.calls.map((args) => args.join(' ')).join('\n') };
    } finally {
      log.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('returns 1 and status=fail for a disallowed dependency in strict mode', () => {
    const result = runGate('GPL-3.0-only');
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('DENIED gate-control@1.0.0');
    expect(result.output).toContain('LICENSE_GATE_RESULT status=fail');
  });

  it('returns 0 and status=pass for a measured permissive dependency', () => {
    const result = runGate('MIT');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('ecosystem=npm lockfiles=1 packages=1 permissive=1');
    expect(result.output).toContain('LICENSE_GATE_RESULT status=pass');
  });

  it('returns 2 and remains undetermined when the root npm graph measures nothing', () => {
    const result = runGate(null);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('UNDETERMINED package-lock.json: parsed 0 packages');
    expect(result.output).toContain('LICENSE_GATE_RESULT status=undetermined');
    expect(result.output).not.toContain('LICENSE_GATE_RESULT status=pass');
  });

  it('does not accept a permissive npm result when the Cargo graph is unmeasured', () => {
    const result = runGate('MIT', ['--strict'], true);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('ecosystem=npm lockfiles=1 packages=1 permissive=1');
    expect(result.output).toContain('UNDETERMINED Cargo.lock: no Cargo.toml beside it');
    expect(result.output).toContain('LICENSE_GATE_RESULT status=undetermined');
    expect(result.output).not.toContain('LICENSE_GATE_RESULT status=pass');
  });

  it('preserves a failed verdict even when report-only mode returns 0', () => {
    const result = runGate('GPL-3.0-only', ['--ecosystem=npm']);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('LICENSE_GATE_RESULT status=fail');
    expect(result.output).not.toContain('LICENSE_GATE_RESULT status=pass');
  });
});

describe('evaluateExpression — SPDX semantics', () => {
  it('classifies single ids into the three tiers', () => {
    expect(tier('MIT')).toBe(TIER.PERMISSIVE);
    expect(tier('Apache-2.0')).toBe(TIER.PERMISSIVE);
    expect(tier('MPL-2.0')).toBe(TIER.WEAK_COPYLEFT);
    expect(tier('LGPL-3.0-or-later')).toBe(TIER.WEAK_COPYLEFT);
    expect(tier('GPL-3.0-only')).toBe(TIER.DENIED);
    expect(tier('AGPL-3.0-only')).toBe(TIER.DENIED);
    expect(tier('BUSL-1.1')).toBe(TIER.DENIED);
    expect(tier('SSPL-1.0')).toBe(TIER.DENIED);
  });

  it('OR takes the best alternative', () => {
    expect(tier('GPL-3.0-only OR MIT')).toBe(TIER.PERMISSIVE);
    expect(tier('MPL-2.0 OR GPL-2.0-only')).toBe(TIER.WEAK_COPYLEFT);
  });

  it('AND takes the worst alternative — a permissive half never launders a copyleft half', () => {
    expect(tier('MIT AND GPL-3.0-only')).toBe(TIER.DENIED);
    expect(tier('Apache-2.0 AND MPL-2.0')).toBe(TIER.WEAK_COPYLEFT);
    expect(evaluateExpression('MIT AND GPL-3.0-only').ids).toEqual(['GPL-3.0-only']);
  });

  it('AND binds tighter than OR, and parentheses override it', () => {
    // MIT OR (GPL AND Apache) → permissive via MIT.
    expect(tier('MIT OR GPL-3.0-only AND Apache-2.0')).toBe(TIER.PERMISSIVE);
    // (MIT OR GPL) AND GPL → denied.
    expect(tier('(MIT OR GPL-3.0-only) AND GPL-2.0-only')).toBe(TIER.DENIED);
    expect(tier('(MIT OR Apache-2.0) AND (Zlib OR BSD-3-Clause)')).toBe(TIER.PERMISSIVE);
  });

  it('accepts the legacy forms real lockfiles carry: slash, lowercase operators, WITH, trailing +', () => {
    expect(tier('MIT/Apache-2.0')).toBe(TIER.PERMISSIVE);
    expect(tier('GPL-3.0-only/MIT')).toBe(TIER.PERMISSIVE);
    expect(tier('MIT or Apache-2.0')).toBe(TIER.PERMISSIVE);
    expect(tier('Apache-2.0 WITH LLVM-exception')).toBe(TIER.PERMISSIVE);
    expect(tier('LGPL-2.1+')).toBe(TIER.WEAK_COPYLEFT);
    expect(tier('LGPL-3.0')).toBe(TIER.WEAK_COPYLEFT);
    // The deprecated GPL forms stay denied.
    expect(tier('GPL-2.0+')).toBe(TIER.DENIED);
    expect(tier('GPL-3.0')).toBe(TIER.DENIED);
  });

  it('denies anything it cannot parse instead of guessing', () => {
    for (const bad of ['', '   ', 'MIT OR', '(MIT', 'MIT)', 'AND MIT', 'MIT WITH', undefined, null, 42]) {
      expect(tier(bad), String(bad)).toBe(TIER.DENIED);
    }
    // Unknown ids, "SEE LICENSE IN …" and the no-license sentinel are all denied.
    expect(tier('SEE LICENSE IN LICENSE.md')).toBe(TIER.DENIED);
    expect(tier('UNLICENSED')).toBe(TIER.DENIED);
    expect(tier('<none>')).toBe(TIER.DENIED);
  });
});

describe('declaredNpmLicense / npmPackagesOf — reading the lockfile', () => {
  it('reads string, legacy arrays and { type } objects; missing reads as <none>', () => {
    expect(declaredNpmLicense({ license: 'MIT' })).toBe('MIT');
    expect(declaredNpmLicense({ licenses: ['MIT', 'Apache-2.0'] })).toBe('MIT OR Apache-2.0');
    expect(declaredNpmLicense({ licenses: [{ type: 'BSD-3-Clause' }] })).toBe('BSD-3-Clause');
    expect(declaredNpmLicense({ license: { type: 'ISC' } })).toBe('ISC');
    expect(declaredNpmLicense({})).toBe('<none>');
    expect(declaredNpmLicense({ license: '' })).toBe('<none>');
    expect(declaredNpmLicense({ licenses: [{}] })).toBe('<none>');
  });

  it('takes every node_modules entry, including nested ones, and skips the root and workspace links', () => {
    const lock = {
      packages: {
        '': { name: 'root', license: 'UNLICENSED' },
        'packages/app': { name: 'app', license: 'UNLICENSED' },
        'node_modules/app': { link: true, resolved: 'packages/app' },
        'node_modules/left-pad': { version: '1.3.0', license: 'WTFPL' },
        'node_modules/a/node_modules/@scope/b': { version: '2.0.0', license: 'GPL-3.0-only', optional: true },
      },
    };
    expect(npmPackagesOf(lock)).toEqual([
      { name: 'left-pad', version: '1.3.0', declared: 'WTFPL' },
      { name: '@scope/b', version: '2.0.0', declared: 'GPL-3.0-only' },
    ]);
  });
});

describe('cargoPackagesOf — reading cargo metadata', () => {
  it('skips path crates (this repo’s own source) and falls back to license_file / <none>', () => {
    const meta = {
      packages: [
        { name: 'papercusp-desktop', version: '0.1.0', source: null, license: null },
        { name: 'serde', version: '1.0.0', source: 'registry+https://github.com/rust-lang/crates.io-index', license: 'MIT OR Apache-2.0' },
        { name: 'ring', version: '0.17.0', source: 'registry+x', license: null, license_file: 'LICENSE' },
        { name: 'mystery', version: '0.0.1', source: 'git+https://example.com/m', license: null },
      ],
    };
    expect(cargoPackagesOf(meta)).toEqual([
      { name: 'serde', version: '1.0.0', declared: 'MIT OR Apache-2.0' },
      { name: 'ring', version: '0.17.0', declared: '<license-file:LICENSE>' },
      { name: 'mystery', version: '0.0.1', declared: '<none>' },
    ]);
  });
});

describe('classify — policy plus reviewed exceptions', () => {
  const pkgs = [
    { name: 'ok', version: '1.0.0', declared: 'MIT', lockfile: 'package-lock.json' },
    { name: 'ok', version: '1.0.0', declared: 'MIT', lockfile: 'apps/x/package-lock.json' },
    { name: 'mpl', version: '2.0.0', declared: 'MPL-2.0', lockfile: 'package-lock.json' },
    { name: 'gpl', version: '3.0.0', declared: 'GPL-3.0-only', lockfile: 'package-lock.json' },
    { name: 'nolicense', version: '0.1.0', declared: '<none>', lockfile: 'package-lock.json' },
    { name: 'sdk', version: '1.0.0', declared: 'SEE LICENSE IN README.md', lockfile: 'package-lock.json' },
  ];

  it('without exceptions, denies GPL, missing and SEE-LICENSE packages and dedupes across lockfiles', () => {
    const r = classify(pkgs, {});
    expect(r.denied.map((x: { name: string }) => x.name)).toEqual(['gpl', 'nolicense', 'sdk']);
    expect(r.weakCopyleft.map((x: { name: string }) => x.name)).toEqual(['mpl']);
    const ok = r.rows.find((x: { name: string }) => x.name === 'ok');
    expect(ok.lockfiles).toEqual(['apps/x/package-lock.json', 'package-lock.json']);
  });

  it('an exception admits a package only while its declared value is unchanged', () => {
    const exceptions = {
      nolicense: { declared: '<none>', license: 'MIT', reason: 'LICENSE file in the tarball is MIT' },
      sdk: { declared: 'SEE LICENSE IN README.md', allow: true, reason: 'reviewed commercial terms allow redistribution' },
    };
    const r = classify(pkgs, exceptions);
    expect(r.denied.map((x: { name: string }) => x.name)).toEqual(['gpl']);
    expect(r.rows.find((x: { name: string }) => x.name === 'sdk').via).toBe('exception');

    // The package re-licenses: the recorded review no longer describes it.
    const relicensed = pkgs.map((p) => (p.name === 'nolicense' ? { ...p, declared: 'BUSL-1.1' } : p));
    const r2 = classify(relicensed, exceptions);
    const row = r2.denied.find((x: { name: string }) => x.name === 'nolicense');
    expect(row).toBeDefined();
    expect(row.exceptionMismatch).toBe('<none>');
  });

  it('an exception whose license is itself copyleft still classifies by that license', () => {
    const r = classify([{ name: 'x', version: '1', declared: '<none>' }], {
      x: { declared: '<none>', license: 'MPL-2.0', reason: 'LICENSE text is MPL-2.0' },
    });
    expect(r.weakCopyleft.map((x: { name: string }) => x.name)).toEqual(['x']);
  });

  it('reports exceptions that no longer match any package as stale', () => {
    const r = classify(pkgs, { gone: { declared: 'MIT', license: 'MIT', reason: 'removed dependency' } });
    expect(r.stale).toEqual(['gone']);
  });
});

describe('validateExceptions — a malformed entry must not admit anything', () => {
  it('refuses missing declared, a thin reason, both/neither of license|allow, and a denied license', () => {
    const problems = validateExceptions({
      npm: {
        a: { license: 'MIT', reason: 'long enough reason' },
        b: { declared: '<none>', license: 'MIT', reason: 'ok' },
        c: { declared: '<none>', license: 'MIT', allow: true, reason: 'long enough reason' },
        d: { declared: '<none>', reason: 'long enough reason' },
        e: { declared: '<none>', license: 'GPL-3.0-only', reason: 'long enough reason' },
      },
    });
    expect(problems.some((p: string) => p.startsWith('npm:a ') && p.includes('declared'))).toBe(true);
    expect(problems.some((p: string) => p.startsWith('npm:b ') && p.includes('reason'))).toBe(true);
    expect(problems.some((p: string) => p.startsWith('npm:c ') && p.includes('exactly one'))).toBe(true);
    expect(problems.some((p: string) => p.startsWith('npm:d ') && p.includes('exactly one'))).toBe(true);
    expect(problems.some((p: string) => p.startsWith('npm:e ') && p.includes('itself denied'))).toBe(true);
  });

  it('accepts a well-formed file and ignores $-prefixed comment keys', () => {
    expect(validateExceptions({
      npm: { $comment: 'notes', ok: { declared: '<none>', license: 'MIT', reason: 'LICENSE file is MIT' } },
      cargo: { crate: { declared: 'Custom', allow: true, reason: 'reviewed and permitted' } },
    })).toEqual([]);
  });

  it('the committed scripts/license-exceptions.json passes the same validation the gate runs first', () => {
    const file = JSON.parse(readFileSync(EXCEPTIONS_PATH, 'utf8'));
    expect(validateExceptions(file)).toEqual([]);
    // Positive control: the file really carries entries in both ecosystems, so an empty
    // or mis-keyed file cannot pass this case vacuously.
    expect(Object.keys(file.npm ?? {}).length).toBeGreaterThan(0);
    expect(Object.keys(file.cargo ?? {}).length).toBeGreaterThan(0);
  });
});

// ── Installer leg ──────────────────────────────────────────────────────────────
// Measured on the published 0.0.22 installers: Syft names a license for almost none of
// the native payloads, and model weights sit inside an Apache-2.0 npm package whose code
// license says nothing about them. These cases pin the attribution rules that decide
// whether such a payload passes, so a later simplification cannot quietly wave it through.

describe('installer leg — payload detection and path rules', () => {
  const buf = (...bytes: number[]) => Buffer.from(bytes);

  it('recognises ELF, PE (with a PE extension), Mach-O and model files; ignores text', () => {
    expect(payloadKindOf('bin/node', buf(0x7f, 0x45, 0x4c, 0x46))).toBe('native');
    expect(payloadKindOf('bin/gh.exe', buf(0x4d, 0x5a, 0x90, 0x00))).toBe('native');
    expect(payloadKindOf('notes.txt', buf(0x4d, 0x5a, 0x90, 0x00))).toBeNull();
    expect(payloadKindOf('App.app/Contents/MacOS/app', buf(0xcf, 0xfa, 0xed, 0xfe))).toBe('native');
    expect(payloadKindOf('Foo.class', buf(0xca, 0xfe, 0xba, 0xbe))).toBeNull();
    expect(payloadKindOf('m/onnx/model.onnx_data_1', null)).toBe('model');
    expect(payloadKindOf('spa/porcupine/porcupine_params.pv', null)).toBe('model');
    expect(payloadKindOf('readme.md', buf(0x23, 0x20, 0x48, 0x69))).toBeNull();
  });

  it('globs: ** spans directories, * and ? stay within one segment, archive members use !/', () => {
    expect(globToRegExp('**/sidecar/bin/node').test('usr/lib/App/sidecar/bin/node')).toBe(true);
    expect(globToRegExp('**/sidecar/bin/node').test('sidecar/bin/node')).toBe(true);
    expect(globToRegExp('**/templates/*/package.json').test('x/templates/a/package.json')).toBe(true);
    expect(globToRegExp('**/templates/*/package.json').test('x/templates/a/node_modules/b/package.json')).toBe(false);
    expect(globToRegExp('**/rt.tar.gz!/**').test('res/rt.tar.gz!/usr/bin/bash')).toBe(true);
    expect(globToRegExp('**/lib?.so').test('a/libX.so')).toBe(true);
  });

  it('npmPackageRootOf finds the innermost package directory, scoped or not', () => {
    expect(npmPackageRootOf('s/node_modules/sharp/build/x.node')).toBe('s/node_modules/sharp');
    expect(npmPackageRootOf('s/node_modules/a/node_modules/@img/b/lib/x.so')).toBe('s/node_modules/a/node_modules/@img/b');
    expect(npmPackageRootOf('s/node_modules/sharp')).toBeNull();
    expect(npmPackageRootOf('s/bin/node')).toBeNull();
  });
});

describe('installer leg — attributeInstaller', () => {
  const components = [
    { name: 'Node', kind: 'program', license: 'MIT', paths: ['**/bin/node'], reason: 'official Node binary' },
    { name: 'psql+readline', kind: 'program', license: 'PostgreSQL AND GPL-3.0-or-later', aggregate: true, paths: ['**/bin/.pg-real/**'], reason: 'separate program with GPL readline' },
    { name: 'Gemma', kind: 'model', allow: true, paths: ['**/models/gemma/**'], reason: 'Gemma terms reviewed' },
    { name: 'Mislabelled model', kind: 'program', license: 'MIT', paths: ['**/models/other/**'], reason: 'wrong kind for a model' },
  ];

  it('covers reviewed payloads, and a binary inside an npm package by that package', () => {
    const r = attributeInstaller({
      components,
      payloads: [
        { path: 'a/bin/node', kind: 'native' },
        { path: 'a/bin/.pg-real/lib/libreadline.so.8', kind: 'native' },
        { path: 'a/node_modules/sharp/build/sharp.node', kind: 'native' },
        { path: 'a/node_modules/t/models/gemma/model.onnx', kind: 'model' },
      ],
    });
    expect(r.unreviewed).toEqual([]);
    expect(r.denied).toEqual([]);
    expect(r.components.find((c: { name: string }) => c.name === 'psql+readline')?.verdict).toBe('aggregate');
  });

  it('refuses an unknown native binary and a model not covered by a kind:"model" component', () => {
    const r = attributeInstaller({
      components,
      payloads: [
        { path: 'a/bin/mystery', kind: 'native' },
        // Inside an npm package: the package's code license does NOT cover model weights.
        { path: 'a/node_modules/t/weights/model.onnx', kind: 'model' },
        // Matched, but by a component that is not kind "model".
        { path: 'a/models/other/w.safetensors', kind: 'model' },
      ],
    });
    expect(r.unreviewed.map((u: { path: string }) => u.path)).toEqual([
      'a/bin/mystery', 'a/node_modules/t/weights/model.onnx', 'a/models/other/w.safetensors',
    ]);
  });

  it('npm packages go through the lockfile rules; package-internal package.json files do not', () => {
    const r = attributeInstaller({
      components,
      npmExceptions: { reviewed: { declared: '<none>', license: 'MIT', reason: 'LICENSE text is MIT' } },
      syftArtifacts: [
        { type: 'npm', name: 'ok', version: '1', licenses: ['MIT'], path: 's/node_modules/ok/package.json' },
        { type: 'npm', name: 'gpl', version: '1', licenses: ['GPL-3.0-only'], path: 's/node_modules/gpl/package.json' },
        { type: 'npm', name: 'reviewed', version: '1', licenses: [], path: 's/node_modules/reviewed/package.json' },
        { type: 'npm', name: 'fixture', version: 'UNKNOWN', licenses: [], path: 's/node_modules/resolve/test/fixture/package.json' },
        { type: 'npm', name: 'firstparty', version: '0', licenses: [], path: 's/orchestrator/package.json' },
      ],
    });
    expect(r.denied.map((d: { what: string }) => d.what)).toEqual(['npm:firstparty@0', 'npm:gpl@1']);
  });

  it('non-npm Syft packages: covered by a component or containing npm package, else own license, else unreviewed', () => {
    const r = attributeInstaller({
      components,
      syftArtifacts: [
        { type: 'go-module', name: 'x', version: '1', licenses: [], path: 'a/bin/node' },
        { type: 'github-action', name: 'y', version: '1', licenses: [], path: 's/node_modules/p/.github/workflows/ci.yml' },
        { type: 'binary', name: 'ffmpeg', version: '6', licenses: ['GPL-2.0-or-later'], path: 'a/usr/lib/libavcodec.so' },
        { type: 'deb', name: 'bash', version: '5', licenses: [], path: 'a/var/lib/dpkg/status' },
      ],
    });
    expect(r.denied.map((d: { what: string }) => d.what)).toEqual(['binary:ffmpeg@6']);
    expect(r.unreviewed.map((u: { what: string }) => u.what)).toEqual(['deb:bash@5']);
  });
});

describe('installer leg — validateComponents', () => {
  it('refuses a denied license unless it is an aggregate program, and aggregate on a library', () => {
    const problems = validateComponents({
      components: [
        { name: 'gpl-lib', kind: 'library', license: 'GPL-3.0-only', paths: ['**/x.so'], reason: 'long enough reason' },
        { name: 'agg-lib', kind: 'library', license: 'MIT', aggregate: true, paths: ['**/y.so'], reason: 'long enough reason' },
        { name: 'no-paths', kind: 'program', license: 'MIT', paths: [], reason: 'long enough reason' },
        { name: 'bad-kind', kind: 'blob', license: 'MIT', paths: ['a'], reason: 'long enough reason' },
        { name: 'ok-agg', kind: 'program', license: 'GPL-2.0-only', aggregate: true, paths: ['**/git.exe'], reason: 'MinGit as a separate program' },
      ],
    });
    expect(problems.some((p: string) => p.includes('(gpl-lib)') && p.includes('denied'))).toBe(true);
    expect(problems.some((p: string) => p.includes('(agg-lib)') && p.includes('aggregate'))).toBe(true);
    expect(problems.some((p: string) => p.includes('(no-paths)'))).toBe(true);
    expect(problems.some((p: string) => p.includes('(bad-kind)'))).toBe(true);
    expect(problems.some((p: string) => p.includes('(ok-agg)'))).toBe(false);
  });

  it('the committed scripts/installer-components.json is valid and carries every component kind it relies on', () => {
    const file = JSON.parse(readFileSync(COMPONENTS_PATH, 'utf8'));
    expect(validateComponents(file)).toEqual([]);
    const kinds = new Set(file.components.map((c: { kind: string }) => c.kind));
    for (const k of ['first-party', 'program', 'model', 'os-image']) expect(kinds.has(k), k).toBe(true);
  });

  it('covers the lowercase Windows desktop binary while keeping unknown executables unreviewed', () => {
    const file = JSON.parse(readFileSync(COMPONENTS_PATH, 'utf8'));
    const r = attributeInstaller({
      components: file.components,
      payloads: [
        { path: 'app/papercusp-desktop.exe', kind: 'native' },
        { path: 'wrapped/app/papercusp-desktop.exe', kind: 'native' },
        { path: 'app/unreviewed.exe', kind: 'native' },
      ],
    });
    expect(r.components.find((c: { kind: string }) => c.kind === 'first-party')?.hits).toBe(2);
    expect(r.unreviewed.map((u: { path: string }) => u.path)).toEqual(['app/unreviewed.exe']);
    expect(r.denied).toEqual([]);
  });

  // Defect #10 (open-source-release R-15 build8): the GTK/gdk-pixbuf plugin modules were
  // listed only under usr/lib/x86_64-linux-gnu/, but linuxdeploy flattens them to usr/lib/,
  // so the finished AppImage reported 26 UNREVIEWED payloads. Both layouts must match.
  it('covers GTK/gdk-pixbuf plugin modules in both the multiarch and the flattened AppImage layout', () => {
    const file = JSON.parse(readFileSync(COMPONENTS_PATH, 'utf8'));
    const res = file.components.flatMap((c: { paths: string[] }) => c.paths.map((p) => globToRegExp(p)));
    const covered = (p: string) => res.some((re: RegExp) => re.test(p));
    for (const lib of ['usr/lib', 'usr/lib/x86_64-linux-gnu']) {
      for (const rel of [
        'gtk-3.0/3.0.0/printbackends/libprintbackend-cups.so',
        'gtk-3.0/3.0.0/immodules/im-xim.so',
        'gdk-pixbuf-2.0/2.10.0/loaders/libpixbufloader-svg.so',
      ]) {
        const p = `squashfs-root/${lib}/${rel}`;
        expect(covered(p), p).toBe(true);
      }
    }
  });
});

describe('THIRD-PARTY-NOTICES (P-017 step 5)', () => {
  it('groups packages by effective license per ecosystem, deduplicated and sorted', () => {
    const text = renderThirdPartyNotices({
      npm: [
        { name: 'zod', version: '3.0.0', effective: 'MIT', tier: TIER.PERMISSIVE },
        { name: 'axe-core', version: '4.0.0', effective: 'MPL-2.0', tier: TIER.WEAK_COPYLEFT },
        { name: 'acorn', version: '8.0.0', effective: 'MIT', tier: TIER.PERMISSIVE },
        { name: 'zod', version: '3.0.0', effective: 'MIT', tier: TIER.PERMISSIVE },
      ],
      cargo: [{ name: 'serde', version: '1.0.0', effective: 'Apache-2.0 OR MIT', tier: TIER.PERMISSIVE }],
    });
    expect(text).toContain('## npm packages (3)');
    expect(text).toContain('### MIT (2)\n\nacorn@8.0.0, zod@3.0.0');
    expect(text).toContain('### MPL-2.0 (1)\n\naxe-core@4.0.0');
    expect(text.indexOf('### MIT')).toBeLessThan(text.indexOf('### MPL-2.0'));
    expect(text).toContain('## Rust crates (1)');
    expect(text).toContain('Elastic License 2.0');
  });

  it('lists installer components with their obligations and a written source offer for GPL/LGPL ones (P-015)', () => {
    const text = renderThirdPartyNotices({}, {
      installerComponents: [
        { name: 'Zeta tool', license: 'MIT' },
        { name: 'Runtime libs', license: 'LGPL-2.1-or-later', obligations: 'Ship the LGPL text.' },
        { name: 'psql', license: 'PostgreSQL AND GPL-3.0-or-later', obligations: 'Offer readline source.' },
      ],
      sourceOfferRepo: 'Acme/app',
    });
    expect(text).toContain('## Components shipped in the desktop installers (3)');
    expect(text).toContain('### Runtime libs\n\nLicense: LGPL-2.1-or-later\n\nShip the LGPL text.');
    expect(text.indexOf('### Runtime libs')).toBeLessThan(text.indexOf('### Zeta tool'));
    const offer = text.slice(text.indexOf('## Written offer for corresponding source'));
    expect(offer).toContain('- Runtime libs');
    expect(offer).toContain('- psql');
    expect(offer).not.toContain('Zeta tool');
    expect(offer).toContain('https://github.com/Acme/app/issues');
  });

  it('adds no installer or source-offer section when there are no installer components', () => {
    const text = renderThirdPartyNotices({ npm: [{ name: 'a', version: '1', effective: 'MIT', tier: TIER.PERMISSIVE }] });
    expect(text).not.toContain('desktop installers');
    expect(text).not.toContain('Written offer');
  });

  it('omits an ecosystem with no packages', () => {
    expect(renderThirdPartyNotices({ npm: [{ name: 'a', version: '1', effective: 'MIT', tier: TIER.PERMISSIVE }] }))
      .not.toContain('Rust crates');
  });

  it('collects from a real lockfile tree, and refuses a tree with no lockfiles instead of rendering an empty file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'license-notices-'));
    try {
      expect(() => collectThirdPartyNotices(dir, { ecosystems: ['npm'] })).toThrow(/ZERO lockfiles/);
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
      writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({
        name: 'fx', lockfileVersion: 3,
        packages: { '': { name: 'fx' }, 'node_modules/left-pad': { version: '1.3.0', license: 'WTFPL' }, 'node_modules/acorn': { version: '8.0.0', license: 'MIT' } },
      }));
      const r = collectThirdPartyNotices(dir, { ecosystems: ['npm'] });
      expect(r.undetermined).toEqual([]);
      expect(r.text).toContain('acorn@8.0.0');
      expect(r.text).toContain('left-pad@1.3.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

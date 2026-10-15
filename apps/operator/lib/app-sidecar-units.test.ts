/**
 * app-sidecar-units.test.ts — the RECURRENCE GUARD for EI-23439593071892927
 * (and the WI-10001633 fix it folds in).
 *
 * The bug: the email (:8791) and calendar (:8792) app sidecars ran from
 * hand-authored units in ~/.config/systemd/user with NO repo source, so a
 * machine re-provision would silently lose them, and the restart-on-change fix
 * (WI-10001633 — `tsx watch`, after the email sidecar served 16 days of stale
 * code) had to land as a drop-in override nobody could review. Both units are
 * now TRACKED in apps/operator/scripts/systemd/ and installed by symlink like
 * every other unit there (README.md § "App sidecars").
 *
 * What this pins, per unit: it exists in the tracked dir; ExecStart runs
 * `tsx watch` (a regression to plain `tsx` re-opens WI-10001633); every path is
 * `%h`-relative (a hard-coded /home/<user> is a render step in disguise);
 * config comes from the injected ~/.papercusp/app-producer.env (secrets never
 * live in a repo); the app's LOCAL_MODE bypass is NOT set (it would skip
 * jwtVerify and leave the producer's auth leg unexercised); Restart=always;
 * and no tracked drop-in directory shadows the unit (the watch behaviour is
 * folded IN, not layered on).
 *
 * The suite text-matches the unit files rather than executing systemd — a
 * unit's behaviour is its text. PROBE_UNIT_DIR lets scripts/mutation-probe.sh
 * point it at a MUTATED COPY outside the tree; the in-file CONTROL block below
 * proves the predicates are falsifiable without mutating the shared checkout.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const UNIT_DIR = process.env.PROBE_UNIT_DIR ?? resolve(__dirname, '../scripts/systemd');

const SIDECARS = [
  { app: 'email', port: 8791, localModeVar: 'EMAIL_LOCAL_MODE' },
  { app: 'calendar', port: 8792, localModeVar: 'CALENDAR_LOCAL_MODE' },
] as const;

const PHONE_TEMPLATE = resolve(
  __dirname,
  '../../../infra/phone-app/systemd/papercusp-phone-sidecar.service.tmpl',
);
const PHONE_DEPLOY = resolve(__dirname, '../../../infra/phone-app/deploy.sh');

type Sidecar = (typeof SIDECARS)[number];

/** Non-comment `Key=Value` lines of a unit file, grouped by [Section]. */
export function parseUnit(src: string): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {};
  let section = '';
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[(\w+)\]$/.exec(line);
    if (sec) {
      section = sec[1];
      out[section] ??= {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    (out[section] ??= {})[key] ??= [];
    out[section][key].push(value);
  }
  return out;
}

/** The invariants a tracked app-sidecar unit must satisfy. Returns [] when it does. */
export function sidecarUnitViolations(src: string, sc: Sidecar): string[] {
  const u = parseUnit(src);
  const svc = u.Service ?? {};
  const v: string[] = [];
  const one = (key: string): string | undefined => svc[key]?.[0];

  const execStart = one('ExecStart') ?? '';
  if (!/\btsx watch\b/.test(execStart)) {
    v.push(`ExecStart must run \`tsx watch\` (WI-10001633), got: ${execStart || '<missing>'}`);
  }
  if (!/apps\/sidecar\/src\/index\.ts\b/.test(execStart)) {
    v.push(`ExecStart must run the app's sidecar entry apps/sidecar/src/index.ts, got: ${execStart}`);
  }
  if (one('WorkingDirectory') !== `%h/papercupai-workspace/${sc.app}`) {
    v.push(`WorkingDirectory must be %h/papercupai-workspace/${sc.app}, got: ${one('WorkingDirectory')}`);
  }
  if (one('EnvironmentFile') !== '%h/.papercusp/app-producer.env') {
    v.push(`EnvironmentFile must be the injected %h/.papercusp/app-producer.env, got: ${one('EnvironmentFile')}`);
  }
  const tokenFileVar = `${sc.app.toUpperCase()}_PLATFORM_TOKEN_FILE`;
  if (!(svc.Environment ?? []).includes(`${tokenFileVar}=%h/.papercusp/${sc.app}-platform-token`)) {
    v.push(`${tokenFileVar} must name the dedicated injected app credential (WI-10006978)`);
  }
  for (const env of svc.Environment ?? []) {
    if (env.startsWith(`${sc.localModeVar}=`)) {
      v.push(`${sc.localModeVar} must not be set in the unit (bypasses jwtVerify)`);
    }
  }
  if (one('Restart') !== 'always') v.push(`Restart must be always, got: ${one('Restart')}`);
  if (!(u.Install?.WantedBy ?? []).includes('default.target')) {
    v.push('Install.WantedBy must include default.target');
  }
  if (!(u.Unit?.Description?.[0] ?? '').includes(`:${sc.port}`)) {
    v.push(`Unit.Description must name the sidecar port :${sc.port}`);
  }
  // Every %h-able path must be %h-relative: a literal home path is a render
  // step in disguise and breaks the symlink-install convention on another host.
  for (const [key, vals] of Object.entries(svc)) {
    for (const val of vals) {
      if (/^\/home\/[^/\s]+/.test(val) || /(?:^|=)\/home\/[^/\s]+/.test(val)) {
        v.push(`${key} hard-codes a home directory: ${val}`);
      }
    }
  }
  return v;
}

describe('tracked app-sidecar systemd units (EI-23439593071892927)', () => {
  for (const sc of SIDECARS) {
    const file = resolve(UNIT_DIR, `papercusp-${sc.app}-sidecar.service`);

    describe(`papercusp-${sc.app}-sidecar.service`, () => {
      it('is tracked in apps/operator/scripts/systemd/', () => {
        expect(existsSync(file), `${file} missing — the unit has no repo source again`).toBe(true);
      });

      it('satisfies every sidecar-unit invariant', () => {
        expect(sidecarUnitViolations(readFileSync(file, 'utf8'), sc)).toEqual([]);
      });

      it('has no tracked drop-in directory shadowing it (watch is folded in, not layered on)', () => {
        // WI-10001633 first landed as ~/.config/systemd/user/<unit>.d/watch.conf.
        // The tracked unit carries the watcher itself; a tracked .d/ here would
        // mean someone re-introduced the override layer this item retired.
        expect(existsSync(`${file}.d`)).toBe(false);
      });
    });
  }

  describe('phone sidecar template (EI-23524947597640431)', () => {
    const source = () => readFileSync(PHONE_TEMPLATE, 'utf8');

    function phoneTemplateViolations(src: string): string[] {
      const u = parseUnit(src);
      const svc = u.Service ?? {};
      const execStart = svc.ExecStart?.[0] ?? '';
      const violations: string[] = [];
      if (execStart !== '${PHONE_NODE_BIN} --import tsx src/index.ts') {
        violations.push(
          `ExecStart must supervise the phone HTTP process directly, got: ${execStart || '<missing>'}`,
        );
      }
      if (svc.WorkingDirectory?.[0] !== '${PHONE_SIDECAR_DIR}') {
        violations.push(`WorkingDirectory must remain the rendered SIDECAR_DIR, got: ${svc.WorkingDirectory?.[0]}`);
      }
      if (svc.Restart?.[0] !== 'on-failure') {
        violations.push(`Restart must be on-failure, got: ${svc.Restart?.[0]}`);
      }
      if (!(u.Install?.WantedBy ?? []).includes('default.target')) {
        violations.push('Install.WantedBy must include default.target');
      }
      return violations;
    }

    it('lets systemd supervise and restart the HTTP process directly', () => {
      expect(existsSync(PHONE_TEMPLATE), `${PHONE_TEMPLATE} is missing`).toBe(true);
      expect(phoneTemplateViolations(source())).toEqual([]);
    });

    it('keeps template placeholders aligned with deploy.sh renderer inputs', () => {
      const template = source();
      const deploy = readFileSync(PHONE_DEPLOY, 'utf8');
      expect(template).not.toMatch(/\$\{(?:NODE_BIN|SIDECAR_DIR)\}/);
      expect(deploy).toContain("'${PHONE_NODE_BIN}'");
      expect(deploy).toContain("'${PHONE_SIDECAR_DIR}'");
    });

    it('rejects a watcher parent that can remain alive after its HTTP child dies', () => {
      const mutant = source().replace('--import tsx src/index.ts', '--import tsx --watch src/index.ts');
      expect(mutant).not.toBe(source());
      expect(phoneTemplateViolations(mutant).join('\n')).toMatch(/HTTP process directly/);
    });

    it('rejects a restart policy that does not recover a failed HTTP process', () => {
      const mutant = source().replace('Restart=on-failure', 'Restart=no');
      expect(mutant).not.toBe(source());
      expect(phoneTemplateViolations(mutant).join('\n')).toMatch(/Restart must be on-failure/);
    });
  });

  // CONTROL — proves the predicate is falsifiable without mutating the tree
  // (scripts/mutation-probe.sh tier "module you import"). A deliberately-wrong
  // unit must be rejected on exactly the regressions this guard exists for.
  describe('control: a regressed unit is rejected', () => {
    const good = readFileSync(resolve(UNIT_DIR, 'papercusp-email-sidecar.service'), 'utf8');
    const email = SIDECARS[0];

    it('calibration: the real unit passes', () => {
      expect(sidecarUnitViolations(good, email)).toEqual([]);
    });

    it('plain `tsx` (the WI-10001633 regression) is caught', () => {
      const mutant = good.replace(/tsx watch /, 'tsx ');
      expect(mutant).not.toBe(good);
      expect(sidecarUnitViolations(mutant, email).join('\n')).toMatch(/tsx watch/);
    });

    it('a hard-coded home directory is caught', () => {
      const mutant = good.replace(
        'WorkingDirectory=%h/papercupai-workspace/email',
        // Built at runtime so the identity-lint never sees a literal home path.
        `WorkingDirectory=${['', 'home', 'someone', 'papercupai-workspace', 'email'].join('/')}`,
      );
      expect(mutant).not.toBe(good);
      expect(sidecarUnitViolations(mutant, email).join('\n')).toMatch(/hard-codes a home directory/);
    });

    it('the jwtVerify bypass is caught', () => {
      const mutant = good.replace('Environment=NODE_ENV=production', 'Environment=NODE_ENV=production\nEnvironment=EMAIL_LOCAL_MODE=1');
      expect(mutant).not.toBe(good);
      expect(sidecarUnitViolations(mutant, email).join('\n')).toMatch(/EMAIL_LOCAL_MODE must not be set/);
    });

    it('dropping the injected env file is caught', () => {
      const mutant = good.replace(/^EnvironmentFile=.*$/m, '');
      expect(mutant).not.toBe(good);
      expect(sidecarUnitViolations(mutant, email).join('\n')).toMatch(/EnvironmentFile must be/);
    });

    it('dropping the dedicated platform credential is caught', () => {
      const mutant = good.replace(/^Environment=EMAIL_PLATFORM_TOKEN_FILE=.*$/m, '');
      expect(mutant).not.toBe(good);
      expect(sidecarUnitViolations(mutant, email).join('\n')).toMatch(/EMAIL_PLATFORM_TOKEN_FILE must name/);
    });

    it('using the superuser credential as the app default is caught', () => {
      const mutant = good.replace('/email-platform-token', '/superuser-token');
      expect(mutant).not.toBe(good);
      expect(sidecarUnitViolations(mutant, email).join('\n')).toMatch(/EMAIL_PLATFORM_TOKEN_FILE must name/);
    });
  });
});

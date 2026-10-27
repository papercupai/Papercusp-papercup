/**
 * hosted-control-plane-placeholder-guard.test.ts — the RECURRENCE GUARD for
 * WI-2141667.
 *
 * The bug: deploy-hosted-control-plane.sh --check-env is the cut-over gate for
 * app.papercusp.com (ruled SUFFICIENT by plan unified-web-portal-2026-08-29
 * D-046). Its LITERAL_NAMES leg tested non-empty only, and its own comment
 * asserted that a non-empty test was "both correct and complete". It is not:
 * the hosted env file ships commented fill-me templates
 * (`#WORKOS_CLIENT_ID=client_XXXX…`) and the documented remediation is
 * "uncomment and fill". Following only the first half made --check-env print
 * `WORKOS_CLIENT_ID set`. With the two WorkOS secrets provisioned the gate
 * would then exit 0, and the armed cut-over fires on exit 0 — starting the
 * hosted control plane and enabling the public cloudflared tunnel with a
 * garbage client ID, so auth fails on every real request while the gate
 * reports green.
 *
 * The fix: is_unfilled_placeholder rejects unfilled template values, reported
 * as a PLACEHOLDER row distinct from UNSET (started the remediation, did not
 * finish it) and failing the gate closed.
 *
 * Unlike its verify-tauri-headless siblings, this suite EXECUTES the predicate
 * rather than text-matching it: is_unfilled_placeholder is pure bash with no
 * process, display or database dependencies, so the real behaviour is cheap to
 * assert. The whole-script --check-env path is NOT executed here because it
 * dereferences the encrypted secret store; the wiring assertions at the bottom
 * cover the seam between the predicate and that path.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('hosted control plane bundled boot', () => {
  it.each([
    'papercusp-hosted-control-plane.service.in',
    'papercup-dev-api.service.d/65-inference-gateway-auto.conf',
    'papercup-staging-api.service.d/65-inference-gateway-auto.conf',
  ])('gives isolated chat children the existing unpinned account-pool route in %s', (source) => {
    const unit = readFileSync(resolve(__dirname, '../scripts/systemd', source), 'utf8');
    const environment = unit.split('\n').filter(line => line.startsWith('Environment='))
      .map(line => line.slice('Environment='.length));
    const values = Object.fromEntries(environment.map(line => {
      const equals = line.indexOf('=');
      return [line.slice(0, equals), line.slice(equals + 1)];
    }));
    expect(values.PAPERCUSP_CODEX_GATEWAY).toBe('1');
    expect(values.PAPERCUSP_ACCOUNT_ROUTING_MODE).toBe('auto');
    expect(new URL(values.ANTHROPIC_BASE_URL).hostname).toBe('127.0.0.1');
    expect(values.ANTHROPIC_AUTH_TOKEN).toBe('papercusp-gateway');
    expect(values.PAPERCUSP_ACCOUNT_ID).toBeUndefined();
    expect(values.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('prebuilds the exact named entry and starts that bundle with stale fallback', () => {
    const rendered = spawnSync('bash', [resolve(__dirname, '../scripts/systemd/deploy-hosted-control-plane.sh'), '--render-only'], {
      encoding: 'utf8',
      env: { ...process.env, PAPERCUSP_DEPLOYMENT_ENVIRONMENT: 'development' },
    });
    expect(rendered.status, rendered.stderr).toBe(0);
    const unit = rendered.stdout;
    expect(unit).toContain('Environment=BUNDLE_HOST_OPERATOR_DIR=');
    expect(unit).toContain('Environment=PAPERCUSP_BUNDLE_ALLOW_STALE_START=1');
    expect(unit).toMatch(/^ExecStartPre=.*papercusp-script-snapshot.sh .*bundle-host.sh bin\/serve.ts dist-hosted-control-plane\/serve.mjs$/m);
    expect(unit).toMatch(/^ExecStart=.*exec node dist-hosted-control-plane\/serve.mjs/m);
    expect(unit).not.toContain('exec npx tsx bin/serve.ts');
  });
});

// PROBE_SCRIPT lets scripts/mutation-probe.sh point this suite at a MUTATED
// COPY outside the tree, so falsifiability can be proven without mutating the
// shared checkout (where git-sync would commit the mutant mid-probe).
const SCRIPT =
  process.env.PROBE_SCRIPT ??
  resolve(__dirname, '../scripts/systemd/deploy-hosted-control-plane.sh');
const src = readFileSync(SCRIPT, 'utf8');

/**
 * Extract just the predicate so it can be evaluated without running the script
 * (which parses argv and would exit). A rename or deletion collapses this to
 * empty, which the first test asserts on explicitly — so this guard fails
 * LOUDLY rather than silently testing nothing.
 */
const fnMatch = src.match(/^is_unfilled_placeholder\(\) \{$.*?^\}$/ms);
const fnSource = fnMatch?.[0] ?? '';

function classify(value: string): 'REJECT' | 'ACCEPT' | 'BROKEN' {
  const res = spawnSync(
    'bash',
    ['-c', `${fnSource}\nif is_unfilled_placeholder "$1"; then echo REJECT; else echo ACCEPT; fi`, '_', value],
    { encoding: 'utf8' },
  );
  const out = res.stdout.trim();
  return out === 'REJECT' || out === 'ACCEPT' ? out : 'BROKEN';
}

describe('deploy-hosted-control-plane.sh unfilled-placeholder guard', () => {
  it('still defines the predicate (guards against a silent rename/removal)', () => {
    expect(fnSource, `is_unfilled_placeholder not found in ${SCRIPT}`).not.toBe('');
  });

  // The exact value the hosted env file ships, plus the usual template idioms.
  it.each([
    ['client_XXXXXXXXXXXXXXXXXXXXXXXXXX', 'the literal shipped WORKOS_CLIENT_ID placeholder'],
    ['XXXXXX', 'the 6-X boundary, rejected'],
    ['<your-client-id>', 'angle-bracket template'],
    ['changeme', 'whole-value idiom'],
    ['CHANGEME', 'idiom is case-insensitive'],
    ['placeholder', 'whole-value idiom'],
    ['TODO', 'whole-value idiom'],
    ['tbd', 'whole-value idiom'],
    ['fixme', 'whole-value idiom'],
    ['example', 'whole-value idiom'],
    ['your-org-id', 'your- prefix'],
    ['YOUR_API_KEY', 'your_ prefix, case-insensitive'],
    // DELIBERATE over-reach, pinned so a future change to it is a decision and
    // not an accident. The your-/your_ prefix rule rejects this even though it
    // reads like a filled value, because the guard's whole domain is the three
    // LITERAL_NAMES — a public origin URL, a workspace id, and a WorkOS client
    // id (client_…) — none of which can hold a your-prefixed real value. The
    // failure modes are not symmetric: a false positive here fails the gate
    // closed with a named reason and is fixed by one env edit, while a false
    // negative publishes app.papercusp.com with a broken client id and greens
    // the gate while doing it. If a literal name is ever added that CAN take
    // such a value, narrow the rule — do not delete it.
    ['your_own_value_here_is_fine', 'accepted over-reach of the your_ prefix rule'],
  ])('rejects %j (%s)', (value) => {
    expect(classify(value)).toBe('REJECT');
  });

  // A guard that only ever fails is as useless as one that only ever passes:
  // these pin that a real credential is not tripped by it.
  it.each([
    ['client_01JQ8ZK3M7NRVT2WY6BCDEFGHJ', 'a realistic WorkOS client id'],
    ['https://app.papercusp.com', 'the real public origin'],
    ['papercusp-workspace', 'the real workspace id'],
    ['integration:WORKOS_API_KEY', 'a real secret reference'],
    ['client_0XXAB', 'a short X-run below the 6 threshold'],
    ['XXXXX', 'the 5-X boundary, accepted'],
    ['exemplary', 'a word merely containing an idiom is not one'],
    ['todo-list-service', 'a whole-value idiom must not match as a prefix'],
  ])('accepts %j (%s)', (value) => {
    expect(classify(value)).toBe('ACCEPT');
  });

  // The predicate is only useful if check_env actually routes literals through
  // it and fails the gate on a hit.
  it('wires the predicate into the literal check and fails the gate on a hit', () => {
    const literalLoop = src.match(/for name in "\$\{LITERAL_NAMES\[@\]\}"; do.*?^    done$/ms)?.[0] ?? '';
    expect(literalLoop, 'LITERAL_NAMES loop not found').not.toBe('');
    expect(literalLoop).toContain('is_unfilled_placeholder');
    expect(literalLoop).toContain('PLACEHOLDER');
    // rc=1 is what turns a placeholder into a non-zero exit, i.e. a closed gate.
    expect(literalLoop).toMatch(/PLACEHOLDER[^\n]*\n\s*.*rc=1|rc=1/);
  });

  it('keeps WORKOS_CLIENT_ID under the literal (not reference) check', () => {
    const literalBlock = src.match(/^LITERAL_NAMES=\(.*?^\)$/ms)?.[0] ?? '';
    expect(literalBlock).toContain('WORKOS_CLIENT_ID');
  });
});

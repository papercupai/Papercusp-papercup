/**
 * P-019 — the Wave B gate.
 *
 * P-019 names TWO properties, and they are not the same shape:
 *
 *   (A) the Google-scope consent upgrade is NON-DESTRUCTIVE to the live Gmail and
 *       Calendar lanes, and
 *   (B) every Wave B adapter passes the P-003 conformance kit, unmodified.
 *
 * (A) is the substantive half. Wave B is the first wave that ADDS SCOPES TO AN
 * OAUTH SOURCE THAT ALREADY CARRIES LANDED, WORKING TRIGGERS: YouTube (P-015)
 * rides the same Google Workspace connection as Gmail and Calendar, on purpose
 * (the external-triggers D-010 one-credential-path pattern). That sharing is what
 * creates the regression P-019 exists to prove absent — the plan states it
 * directly: "a scope change on a shared OAuth source can force re-consent and
 * silently break landed triggers".
 *
 * WHAT IS DELIBERATELY NOT REPEATED HERE. wave-a-gate.test.ts already asserts
 * that exactly one module exports the conformance runner, and conformance.test.ts
 * already proves the kit is falsifiable (eight permanent broken-adapter controls).
 * Both are wave-independent and hold for Wave B unchanged; restating them would
 * be duplication, not a gate. What Wave A's gate CANNOT cover is its own clause 1
 * for a different wave — it searches the kit for Wave A's platform names, and a
 * Wave B special-case is a different string — so that clause is re-derived below
 * for Wave B's names.
 *
 * Provider migration P-001 now puts each platform's streams behind one package
 * syncPage. Enumerate delivered package descriptors and their real unit suites;
 * the old app-adapter census would require code that has deliberately been retired.
 * The SDK kit is the subject of the no-special-case check. Runtime conformance
 * remains the actual package suites' job, not a conclusion inferred from source.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderDescriptor } from '@papercusp/plugin-sdk';
import { stripComments } from './comment-stripper.fixture';
import {
  GOOGLE_WORKSPACE_ALLOWED_SCOPES,
  GOOGLE_WORKSPACE_SCOPES,
  GOOGLE_YOUTUBE_FORCE_SSL_SCOPE,
  GOOGLE_YOUTUBE_READONLY_SCOPE,
  makeGoogleProvider,
} from '../../oauth/providers';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../../..');

/**
 * The directory this gate reads its subjects from. Defaults to the real one.
 *
 * Same rationale as the Wave A gate's override: falsifiability is proven by
 * pointing this at a COPY carrying a deliberate defect, never by mutating the
 * shared tree — git-sync sweeps and commits the whole tree on a timer, so a probe
 * that legitimately holds a mutation for the length of a suite run can have it
 * committed even though nothing went wrong.
 */
const SUBJECT_DIR = process.env.WAVE_B_GATE_SUBJECT_DIR ?? join(REPO, 'packages/plugin-sdk/src');

/** The kit itself: the runner plus the contract every adapter implements. */
const KIT_FILES = ['provider-conformance.ts', 'provider.ts'] as const;

const read = (file: string): string => readFileSync(join(SUBJECT_DIR, file), 'utf8');

/** The approved Wave B cohort extends the shared Google/Facebook registrations.
 * Its scopes come from delivered packages, never from the retired vendor table. */
function extendsSharedSocialConsent(provider: ProviderDescriptor | undefined): provider is ProviderDescriptor {
  return Boolean(provider?.datatypes.includes('social-post') &&
    ['google', 'facebook'].includes(provider.oauth?.clientRegistrationRef ?? ''));
}
const PLUGINS = join(REPO, 'libs/papercusp/plugins');
const waveBPlatforms = readdirSync(PLUGINS, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
  try {
    const manifest = JSON.parse(readFileSync(join(PLUGINS, entry.name, 'papercusp.json'), 'utf8'));
    return extendsSharedSocialConsent(manifest.provider) ? [manifest.provider as ProviderDescriptor] : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
});
/** Widened to string on purpose: it is membership-tested against ids SCRAPED from source. */
const waveBIds = new Set<string>(waveBPlatforms.map((row) => row.id));

const googleConfig = {
  clientId: 'google-client.apps.googleusercontent.com',
  clientSecret: 'desktop-secret',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  redirectUri: 'http://127.0.0.1:3070/api/oauth/callback',
};

/** The scopes an owner is asked for when upgrading the shared connection for YouTube. */
const YOUTUBE_UPGRADE_SCOPES = [GOOGLE_YOUTUBE_READONLY_SCOPE, GOOGLE_YOUTUBE_FORCE_SSL_SCOPE];

/**
 * The predicate the gate actually enforces, named once so the assertion and its
 * CONTROL run the SAME instrument.
 *
 * This matters more than it looks. `providers.ts` is an imported module, not a
 * file this suite reads by path, so the SUBJECT_DIR trick below cannot redirect
 * it at a mutated copy — and mutating it in the shared tree to prove the guard
 * bites would race git-sync. The prescribed alternative for a module subject is a
 * permanent deliberately-wrong control in the test file: one input that must
 * satisfy the predicate and one that must not. Without the failing half, an
 * assertion that can no longer fail looks exactly like one that passes.
 */
const retainsPriorGrants = (url: URL): boolean => url.searchParams.get('include_granted_scopes') === 'true';

async function googleAuthorizeUrl(scopes: string[]): Promise<URL> {
  const provider = makeGoogleProvider(googleConfig);
  const privateContext = await provider.createFlowContext!();
  return new URL(provider.buildAuthorizeUrl(scopes, 'STATE_TOKEN', privateContext));
}

/** Drive a token exchange whose provider-returned `scope` string is `grantedScope`. */
async function exchangeReturningScopes(grantedScope: string): Promise<string[]> {
  const provider = makeGoogleProvider(googleConfig);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: grantedScope }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ),
  );
  const tokens = await provider.exchangeCode('authorization-code', { codeVerifier: 'persisted-verifier' });
  return tokens.scopes ?? [];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('P-019 Wave B gate — the Google-scope consent upgrade is non-destructive', () => {
  it('asks Google to RETAIN already-granted scopes when upgrading for YouTube', async () => {
    const url = await googleAuthorizeUrl(YOUTUBE_UPGRADE_SCOPES);

    // This single parameter is what makes the shared-source upgrade safe. Google's
    // incremental authorization returns a token carrying the UNION of the old and
    // new grants when it is set, and a token carrying ONLY the newly requested
    // scopes when it is not. The delivered YouTube OAuth descriptor requires
    // this same union-preserving parameter (D-019).
    expect(
      retainsPriorGrants(url),
      'dropping include_granted_scopes makes the first YouTube consent silently ' +
        'de-scope the landed Gmail and Calendar lanes — P-019’s named regression',
    ).toBe(true);

    // The upgrade must actually be asking for the YouTube scopes, or the assertion
    // above is measuring a request that would never have caused the regression.
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(YOUTUBE_UPGRADE_SCOPES);
  });

  it('CONTROL: the same predicate REJECTS an authorize URL that lost the flag', async () => {
    // The regression, reproduced at this seam: a buildAuthorizeUrl that stopped
    // setting the parameter, and one that set it to something other than 'true'.
    // Both must be rejected by the identical predicate the assertion above uses,
    // or that assertion is one nobody can fail.
    const dropped = await googleAuthorizeUrl(YOUTUBE_UPGRADE_SCOPES);
    dropped.searchParams.delete('include_granted_scopes');
    expect(retainsPriorGrants(dropped)).toBe(false);

    const falsified = await googleAuthorizeUrl(YOUTUBE_UPGRADE_SCOPES);
    falsified.searchParams.set('include_granted_scopes', 'false');
    expect(retainsPriorGrants(falsified)).toBe(false);

    // CALIBRATION: the predicate must still accept the real thing, or it could be
    // rejecting everything — which would pass both controls above and prove nothing.
    expect(retainsPriorGrants(await googleAuthorizeUrl(YOUTUBE_UPGRADE_SCOPES))).toBe(true);
  });

  it('leaves a plain re-connect asking for exactly the pre-Wave-B scope set', async () => {
    // The other way a shared-source scope change breaks landed triggers: widening
    // the DEFAULT request, so every existing owner is re-prompted with a bigger
    // consent screen at their next reconnect and any refusal takes Gmail and
    // Calendar down with it. Wave B must be invisible to an owner who never
    // enables YouTube.
    const url = await googleAuthorizeUrl([]);

    expect(url.searchParams.get('scope')?.split(' ')).toEqual([...GOOGLE_WORKSPACE_SCOPES]);
    for (const scope of YOUTUBE_UPGRADE_SCOPES) {
      expect(url.searchParams.get('scope'), `${scope} must not be in the default consent screen`).not.toContain(scope);
    }
  });

  it('keeps every landed Gmail and Calendar scope through a retaining upgrade', async () => {
    // What Google returns for an incremental upgrade WITH include_granted_scopes:
    // the union, not the delta.
    const retained = await exchangeReturningScopes([...GOOGLE_WORKSPACE_SCOPES, ...YOUTUBE_UPGRADE_SCOPES].join(' '));

    for (const scope of GOOGLE_WORKSPACE_SCOPES) {
      expect(retained, `${scope} was dropped by the YouTube consent upgrade`).toContain(scope);
    }
    // And the upgrade actually delivered what it was for.
    for (const scope of YOUTUBE_UPGRADE_SCOPES) expect(retained).toContain(scope);
  });

  it('CONTROL: a NON-retaining upgrade visibly drops the landed scopes', async () => {
    // The same exchange as above, fed the response a de-scoped upgrade produces.
    // This is the failure mode itself, and it must be VISIBLE at this seam —
    // otherwise the test above proves only that the happy path is happy.
    //
    // Downstream, this is exactly what breaks the landed lanes: personal-vault.ts's
    // googleGrantedScopes() returns the STORED scope list whenever it is non-empty
    // (falling back to GOOGLE_WORKSPACE_SCOPES only when nothing was stored), so a
    // youtube-only grant is a non-empty list that omits every Gmail scope, and the
    // Gmail and Calendar capabilities compute a non-empty `missingScopes` and flip
    // to needs-consent.
    const deScoped = await exchangeReturningScopes(YOUTUBE_UPGRADE_SCOPES.join(' '));

    expect(deScoped).toEqual(YOUTUBE_UPGRADE_SCOPES);
    const stillGranted = GOOGLE_WORKSPACE_SCOPES.filter((scope) => deScoped.includes(scope));
    expect(stillGranted, 'a de-scoped upgrade must be detectable as having lost the landed grants').toEqual([]);
  });

  it('D-019: no package content scope extending shared consent is presumed-granted', () => {
    // providers.test.ts already asserts this over a HAND-MAINTAINED list of three
    // escalating scopes. This check discovers every delivered social package
    // extending shared consent, including the existing Personal Vault provider.
    //
    // Why it matters: GOOGLE_WORKSPACE_SCOPES is the PRESUMED-GRANTED fallback for
    // any legacy connection that stored no scope metadata. A scope placed there is
    // reported as granted for owners who never consented to it, so the capability
    // reads connected:true / missingScopes:[] and fails later with a 403 at call
    // time, far from the cause.
    // Identity scopes are shared with existing grants; content scopes are the
    // escalation. Keep this exemption independent of the fallback under test,
    // or adding a content scope to that fallback would hide its own regression.
    const identityScopes = new Set(['openid', 'profile', 'email']);
    const waveBScopes = waveBPlatforms.flatMap((row) => row.oauth!.scopes).filter((scope) => !identityScopes.has(scope));

    // POSITIVE CONTROLS. Without these the loop below can pass by iterating
    // nothing — the classic vacuous absence claim.
    expect(waveBPlatforms.length).toBeGreaterThan(0);
    expect(waveBScopes.length).toBeGreaterThan(0);
    const googleScopes = waveBScopes.filter((scope) => scope.startsWith('https://www.googleapis.com/'));
    expect(googleScopes, 'no Wave B platform rides a googleapis scope — the requestable half is vacuous').not.toEqual(
      [],
    );

    for (const scope of waveBScopes) {
      expect(GOOGLE_WORKSPACE_SCOPES as readonly string[], `${scope} must NOT be presumed granted`).not.toContain(
        scope,
      );
    }
    for (const scope of googleScopes) {
      expect(GOOGLE_WORKSPACE_ALLOWED_SCOPES as readonly string[], `${scope} must be requestable`).toContain(scope);
    }
  });
});

describe('P-019 Wave B gate — the kit was not bent to fit a Wave B platform', () => {
  // The provider id plus, for a hyphenated id, its module prefix: the codebase
  // names Facebook Pages modules `facebook-*`, so a special-case could spell it
  // either way.
  const waveBNames = [...new Set(waveBPlatforms.flatMap((row) => [row.id, row.id.split('-')[0]!]))];

  it.each(KIT_FILES)('%s names no Wave B platform in executable code', (file) => {
    const code = stripComments(read(file));

    // POSITIVE CONTROL on the instrument: if the read or the stripper returned
    // (nearly) nothing, every assertion below would pass while measuring no code.
    expect(code.length).toBeGreaterThan(500);
    expect(waveBNames.length).toBeGreaterThan(0);

    for (const name of waveBNames) {
      expect(
        code.toLowerCase(),
        `${file} branches on "${name}" in executable code. A kit change needed to accommodate a ` +
          `platform is a finding about the KIT and must be recorded, not patched here.`,
      ).not.toContain(name);
    }
  });
});

/** Find an actual call of the SDK import, including a renamed import; comments and strings cannot qualify. */
function callsSdkKit(text: string): boolean {
  const source = ts.createSourceFile('provider.test.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports = new Set<string>();
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== '@papercusp/plugin-sdk') continue;
    const named = node.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) for (const entry of named.elements) {
      if ((entry.propertyName ?? entry.name).text === 'runProviderConformance') imports.add(entry.name.text);
    }
  }
  let called = false;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && imports.has(node.expression.text)) called = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return called;
}

describe('P-019 Wave B gate — delivered provider suites use the shared SDK kit', () => {
  const plugins = join(REPO, 'libs/papercusp/plugins');
  const delivered = readdirSync(plugins, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
    try {
      const manifest = JSON.parse(readFileSync(join(plugins, entry.name, 'papercusp.json'), 'utf8'));
      return manifest.provider?.datatypes?.includes('social-post') && waveBIds.has(manifest.provider.id) ? [manifest.provider.id as string] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  });

  it('finds one delivered provider for every Wave B platform', () => {
    // The owner-approved cohort is an independent completeness control. If a
    // manifest loses its descriptor or registration, discovery must fail here.
    expect([...waveBIds]).toEqual(expect.arrayContaining(['facebook-pages', 'instagram', 'youtube']));
    expect(waveBPlatforms).toHaveLength(waveBIds.size);
    expect(delivered.sort()).toEqual([...waveBIds].sort());
  });

  it('CONTROL: shared consent is determined by the package declaration, not its name', () => {
    const shared = { id: 'arbitrary-social', contractVersion: 1, datatypes: ['social-post'], capabilities: [], egressHosts: [],
      oauth: { authorizeUrl: 'https://example.test/oauth', tokenUrl: 'https://example.test/token', scopes: ['new-content'], clientRegistrationRef: 'google' } };
    expect(extendsSharedSocialConsent(shared)).toBe(true);
    expect(extendsSharedSocialConsent({ ...shared, id: 'youtube', oauth: { ...shared.oauth, clientRegistrationRef: 'standalone' } })).toBe(false);
    expect(extendsSharedSocialConsent({ ...shared, datatypes: ['email-message'] })).toBe(false);
    expect(extendsSharedSocialConsent(undefined)).toBe(false);
  });

  it.each([...waveBIds])('%s has a real package unit suite calling the SDK kit', (id) => {
    const suite = readFileSync(join(REPO, `packages/operator-core/lib/providers/${id}/${id}-provider.test.ts`), 'utf8');
    expect(callsSdkKit(suite), `${id} must exercise its package through runProviderConformance`).toBe(true);
  });

  it('CONTROL: detects a removed call, a local imitation, prose and a string without rejecting import aliases', () => {
    const imported = "import { runProviderConformance } from '@papercusp/plugin-sdk';";
    expect(callsSdkKit(`${imported} it('kit', async () => { await runProviderConformance(harness); });`)).toBe(true);
    expect(callsSdkKit("import { runProviderConformance as check } from '@papercusp/plugin-sdk'; it('kit', () => check(harness));")).toBe(true);
    for (const source of [imported, `${imported} // runProviderConformance(harness)`, `${imported} const prose = 'runProviderConformance(harness)';`,
      "function runProviderConformance() {} it('kit', () => runProviderConformance());"]) expect(callsSdkKit(source)).toBe(false);
  });
});

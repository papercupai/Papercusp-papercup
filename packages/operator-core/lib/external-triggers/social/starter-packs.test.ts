/**
 * P-026 — acceptance for the three first-party SOCIAL starter trigger packs.
 *
 * WHY THIS IS NOT A COPY OF trigger-pack-validate.test.ts. That file is the
 * P-021 acceptance for the mail/chat/calendar trio, and its per-pack table has
 * exactly the shape those packs share: ONE binding, ONE datatype, ONE
 * `oauthField` bound to a platform-wide OAuth provider. Reused verbatim here it
 * would not merely be awkward — it would be WRONG in the silent direction, the
 * same way the Wave A conformance gate was: it reads the FIRST binding, so a
 * five-binding pack would report covered while four bindings went unchecked,
 * and it REQUIRES an oauthField, so it would push these packs into declaring a
 * provider the OAuth registry cannot resolve. So this file asserts the
 * properties social packs actually have, and derives every expectation instead
 * of enumerating it.
 *
 * THE PROPERTY THIS FILE EXISTS FOR. A manifest is static JSON: it cannot
 * import `providerStormPolicyFor`, so every `maxRuns`/`windowSeconds` in it is a
 * SECOND COPY of a number the registry derivation owns. That is precisely the
 * drift the repo's derived-truth rule forbids hand-maintaining, and it cannot
 * be fixed by deriving (JSON has no imports) — so it is PINNED here instead:
 * the numbers are recomputed from the registry and compared against the
 * literals. A registry row whose budget changes now reds this test rather than
 * leaving three manifests quietly overstating what a platform will tolerate.
 *
 * The same reasoning covers the crosspost destination pattern, which is a
 * second copy of "which platforms declare the post verb with a verified write
 * path".
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateTriggerPackDeclaration,
  type PluginOAuthRequirement,
  type PluginTriggerPack,
} from '@papercusp/plugin-sdk';
import { providerCapabilityVerificationIssue } from '@papercusp/plugin-sdk';
import { bundledSocialProviderDescriptors } from '../../capability-verbs/social-provider.fixture';
import { providerStormPolicyFor, type ProviderStormPolicy, type ProviderQuotaVerb } from '../provider-storm-policy';
const socialProvider = (id: string) => bundledSocialProviderDescriptors().find((descriptor) => descriptor.id === id);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

/**
 * Overridable so falsifiability can be proven against an out-of-tree copy
 * rather than by mutating the shared checkout — a probe legitimately holds a
 * file mutated for as long as the suite runs, and the git-sync sweep would
 * commit it.
 */
const PLUGINS_DIR = process.env.SOCIAL_STARTER_PACKS_DIR
  ? resolve(process.env.SOCIAL_STARTER_PACKS_DIR)
  : resolve(REPO_ROOT, 'libs/papercusp/plugins');

interface Manifest {
  name: string;
  kind?: string;
  /**
   * Typed as the validator's own parameter rather than `unknown`, so the
   * least-privilege assertion below ("no pack declares an OAuth requirement")
   * is checked against the real shape instead of an escape hatch that would
   * also accept a malformed one.
   */
  oauth?: PluginOAuthRequirement[];
  capabilities?: unknown[];
  configSchema?: Record<string, unknown>;
  triggerPack?: PluginTriggerPack;
}

/**
 * The verb each pack's runs actually spend against the platform. This is the
 * one genuinely CURATED value here: it is a statement about what the pack
 * does, which no registry row can tell you. Getting it wrong is caught by the
 * least-privilege assertion below rather than by this table.
 */
const PACKS = [
  { slug: 'social-mention-triage', verb: 'read' as ProviderQuotaVerb, publishes: false },
  { slug: 'social-comment-digest', verb: 'read' as ProviderQuotaVerb, publishes: false },
  { slug: 'social-scheduled-crosspost', verb: 'post' as ProviderQuotaVerb, publishes: true },
] as const;

function readManifest(slug: string): Manifest {
  return JSON.parse(readFileSync(resolve(PLUGINS_DIR, slug, 'papercusp.json'), 'utf8')) as Manifest;
}

function readPlan(slug: string): string {
  return readFileSync(resolve(PLUGINS_DIR, slug, 'plan.md'), 'utf8');
}

/** runs-per-second, the only ordering under which two (cap, window) pairs are comparable. */
function rate(policy: { maxRuns?: number; windowSeconds?: number }): number {
  return Number(policy.maxRuns) / Number(policy.windowSeconds);
}

function tightest(policies: ProviderStormPolicy[]): ProviderStormPolicy {
  return policies.reduce((a, b) => (rate(b) < rate(a) ? b : a));
}

/** Platforms whose row declares `post` AND carries a verified write path. */
function postablePlatformIds(): string[] {
  return bundledSocialProviderDescriptors()
    .filter((row) => row.capabilities.includes('social.post') && !providerCapabilityVerificationIssue(row, 'social.post'))
    .map((row) => row.id);
}

describe('social starter trigger packs (P-026)', () => {
  // CALIBRATION. Every pin below compares a manifest literal against
  // `providerStormPolicyFor`. If that function ever collapsed to a constant, all
  // of those comparisons would still pass while asserting nothing — the failure
  // mode where the controls stay green because the instrument stopped
  // measuring. This asserts the derivation genuinely discriminates first.
  it('the derivation it pins against actually discriminates between platforms', () => {
    const derived = bundledSocialProviderDescriptors().map((row) => rate(providerStormPolicyFor(row, 'post')));
    expect(new Set(derived).size).toBeGreaterThan(1);
  });

  describe.each(PACKS)('$slug', (pack) => {
    it('declares a valid trigger pack that ships disarmed with declared inputs', () => {
      const manifest = readManifest(pack.slug);
      expect(validateTriggerPackDeclaration(manifest)).toEqual([]);

      const triggerPack = manifest.triggerPack;
      expect(triggerPack).toBeDefined();
      if (!triggerPack) return;

      // Exactly the P-021 disarmed-on-install property, restated because it is
      // the one thing a starter pack must never get wrong.
      expect(triggerPack.bindings.every((binding) => !('armed' in binding))).toBe(true);
      expect(triggerPack.edges).toEqual([]);

      // P-026: "each declares inputs and a sensible default storm policy".
      const inputProperties = (triggerPack.inputs as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.keys(inputProperties).length).toBeGreaterThan(0);
      expect(Number(triggerPack.defaultStormPolicy?.maxRuns)).toBeGreaterThan(0);
      expect(Number(triggerPack.defaultStormPolicy?.windowSeconds)).toBeGreaterThan(0);

      // One plan target, resolving to a bundled plan whose frontmatter slug
      // matches the directory — the install path refuses a plan without one.
      expect(triggerPack.targets).toHaveLength(1);
      const target = triggerPack.targets[0];
      expect(target.kind).toBe('plan');
      if (target.kind !== 'plan') return;
      expect(target.path).toBe('plan.md');
      expect(readPlan(pack.slug)).toMatch(new RegExp(`^slug: ${pack.slug}$`, 'm'));
    });

    it('binds only registry platforms, and every binding agrees with the target schema', () => {
      const triggerPack = readManifest(pack.slug).triggerPack;
      if (!triggerPack) throw new Error('no trigger pack');
      const target = triggerPack.targets[0];
      if (target.kind !== 'plan') throw new Error('expected a plan target');

      const keyPattern = new RegExp(
        String(
          ((target.inputSchema.properties as Record<string, { properties?: Record<string, { pattern?: string; const?: string }> }>)
            .trigger?.properties?.key?.pattern ??
            (target.inputSchema.properties as Record<string, { properties?: Record<string, { const?: string }> }>)
              .trigger?.properties?.key?.const) ?? '(?!)',
        ),
      );

      for (const binding of triggerPack.bindings) {
        if (binding.source.kind !== 'external') continue;
        // The sourceKind IS the platform id — the adapters' own `platformId`
        // marker and the `ext:<kind>:` key are the same string.
        // Social starter packs are provider-pinned, never portable datatype sources.
        expect(binding.source.sourceKind, binding.id).toEqual(expect.any(String));
        expect(socialProvider(binding.source.sourceKind!), binding.id).toBeDefined();
        // A binding added without widening the target's accepted key would
        // otherwise pass validation and then deliver a payload the plan's own
        // input schema rejects at run time.
        expect(String(binding.eventPattern), binding.id).toMatch(keyPattern);
      }
    });

    it('pins every storm policy to the registry derivation rather than a hand-typed number', () => {
      const triggerPack = readManifest(pack.slug).triggerPack;
      if (!triggerPack) throw new Error('no trigger pack');
      const fallback = triggerPack.defaultStormPolicy ?? {};

      const external = triggerPack.bindings.filter(
        (binding): binding is typeof binding & { source: { kind: 'external'; sourceKind: string } } =>
          binding.source.kind === 'external',
      );

      for (const binding of external) {
        const row = socialProvider(binding.source.sourceKind);
        if (!row) throw new Error(`unknown platform ${binding.source.sourceKind}`);
        const derived = providerStormPolicyFor(row, pack.verb);
        // The EFFECTIVE policy is the per-binding override when present and the
        // pack default otherwise, so a binding that silently inherited a wrong
        // default is caught here too.
        const effective = binding.stormPolicy ?? fallback;
        expect({ id: binding.id, ...effective }).toEqual({
          id: binding.id,
          maxRuns: derived.maxRuns,
          windowSeconds: derived.windowSeconds,
        });
      }

      // The pack DEFAULT must be safe for the weakest budget it can apply to:
      // the tightest derivation across the platforms in scope. For a pack with
      // external bindings that is the platforms it binds; for the crosspost
      // pack, whose single binding is `manual`, it is every platform its
      // destinations may name.
      const scope = external.length > 0
        ? external.map((binding) => binding.source.sourceKind)
        : postablePlatformIds();
      const derivedScope = scope.map((id) => providerStormPolicyFor(socialProvider(id)!, pack.verb));
      const floor = tightest(derivedScope);
      expect(fallback).toEqual({ maxRuns: floor.maxRuns, windowSeconds: floor.windowSeconds });
    });

    it('requests no privilege the pack does not exercise', () => {
      const manifest = readManifest(pack.slug);
      const serialized = JSON.stringify(manifest);

      // No pack declares an oauthField: Bluesky is app-password with an empty
      // scope list, Mastodon registers a client per instance, Reddit's app is
      // not a platform-wide provider, and Threads was deliberately left unwired
      // by P-018. Declaring one would name a provider the OAuth registry cannot
      // resolve, and the validator does NOT check provider strings against that
      // registry — so nothing else would catch it.
      expect(manifest.oauth).toBeUndefined();
      expect(manifest.capabilities ?? []).toEqual([]);
      for (const binding of manifest.triggerPack?.bindings ?? []) {
        if (binding.source.kind === 'external') expect(binding.source.oauthField).toBeUndefined();
      }

      if (pack.publishes) return;
      // A non-publishing pack must not carry a write scope anywhere in its
      // manifest. Derived from the registry rather than a literal list, so a
      // platform whose write scopes change is still covered.
      const writeScopes = bundledSocialProviderDescriptors()
        .flatMap((descriptor) => descriptor.oauth?.scopes ?? [])
        .filter((scope) => /write|publish|manage_posts|manage_engagement|submit/i.test(scope));
      expect(writeScopes.length).toBeGreaterThan(0); // positive control for the filter
      for (const scope of writeScopes) expect(serialized).not.toContain(scope);
    });
  });

  it.each(['social-mention-triage', 'social-comment-digest'])('%s consumes every delivered event', (slug) => {
    const plan = readPlan(slug);
    expect(plan).toContain('response.events');
    expect(plan).toContain('process every entry');
    expect(plan).toContain('top-level fields describe only the first event');
    expect(plan).toContain('each entry independently');
    expect(plan).not.toContain('it cannot read the ones that');
  });

  it('the crosspost destination pattern matches exactly the post-capable, write-verified platforms', () => {
    const manifest = readManifest('social-scheduled-crosspost');
    const inputs = manifest.triggerPack?.inputs as {
      properties?: { destinations?: { items?: { pattern?: string } } };
    };
    const pattern = inputs.properties?.destinations?.items?.pattern;
    expect(pattern).toBeDefined();

    const alternation = /^\^\(([a-z-|]+)\):/.exec(String(pattern));
    expect(alternation, `unparseable destination pattern: ${pattern}`).not.toBeNull();
    const declared = String(alternation?.[1]).split('|').sort();

    expect(declared).toEqual(postablePlatformIds().sort());
    // YouTube declares `reply` only, so its exclusion is a real consequence of
    // the derivation rather than an oversight worth restating as a literal.
    expect(declared).not.toContain('youtube');
  });

  it('the crosspost binding avoids the schedule source kind, which has no consumer', () => {
    const manifest = readManifest('social-scheduled-crosspost');
    const bindings = manifest.triggerPack?.bindings ?? [];
    expect(bindings).toHaveLength(1);
    // `{ kind: 'schedule', scheduleRef }` is in the SDK type and the published
    // JSON schema, and the validator skips every check for a non-external
    // source — so a schedule binding would validate cleanly and never fire.
    // Asserting the absence keeps a later "fix" from reintroducing it.
    expect(bindings[0].source.kind).toBe('manual');
    expect(JSON.stringify(manifest)).not.toContain('scheduleRef');
  });
});

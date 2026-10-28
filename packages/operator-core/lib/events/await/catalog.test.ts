/**
 * catalog.test — the awaitable-key registry is the SINGLE SOURCE OF TRUTH
 * (event-await-discoverability-and-coverage-2026-07-03 P-002, D-005), so its
 * self-consistency is load-bearing: a malformed template or a param that doesn't
 * match its placeholders would make the sugar build a key nobody emits.
 */

import { describe, it, expect } from 'vitest';
import {
  EVENT_CATALOG,
  catalogEntry,
  buildKey,
  renderCatalog,
  sugaredFamilies,
  familyKeyPrefix,
  keyMatchesCatalog,
  findRequiredParamPrefixMatch,
  findZeroParamSuffixMismatch,
  findCatalogNearMiss,
  findFireProofClassificationGaps,
  subjectScopeOf,
  type EventCatalogEntry,
  type FireProof,
} from './catalog';
import { buildAnnouncedKey } from './announce-key';

describe('events catalog — registry integrity', () => {
  it('has unique family ids', () => {
    const ids = EVENT_CATALOG.map((e) => e.family);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every template placeholder is declared as a param, and vice versa', () => {
    for (const e of EVENT_CATALOG) {
      const placeholders = (e.keyTemplate.match(/<([a-zA-Z0-9_]+)>/g) ?? []).map((p) => p.slice(1, -1));
      const declared = e.params.map((p) => p.name);
      expect(new Set(placeholders), `${e.family} placeholders`).toEqual(new Set(declared));
      // params in declaration order must be the order they appear in the template
      expect(declared, `${e.family} param order`).toEqual(placeholders);
    }
  });

  it('keyTemplate is a colon-namespaced string with no whitespace', () => {
    for (const e of EVENT_CATALOG) {
      expect(e.keyTemplate, e.family).toMatch(/^[a-zA-Z0-9:<>_-]+$/);
      expect(e.keyTemplate.includes(':'), e.family).toBe(true);
    }
  });

  it('every sugar-bearing family names a distinct verb', () => {
    const verbs = sugaredFamilies().map((e) => e.sugar!);
    expect(new Set(verbs).size).toBe(verbs.length);
    for (const v of verbs) expect(v).toMatch(/^[a-z][a-z-]*:[a-z][a-z-]*$/);
  });
});

/**
 * event-wait-settlement-2026-10-20 P-001 / R-2 — what a fire PROVES, per id-scoped family.
 *
 * `fireProves` decides whether a fire may RELEASE parked work (fireCertifiesCondition), and
 * it is curated, so this table is its pin. Adding an id-scoped family, dropping one, or
 * re-classifying one fails here until the table is updated on purpose — in the same diff a
 * reviewer can read. `condition` = completion (the fire certifies the named final state);
 * `change` = notification/hint/alarm (the state may already have reversed).
 */
const ID_SCOPED_FIRE_PROOF: Record<string, FireProof> = {
  'repair-admitted': 'change',
  lock: 'condition',
  'plan-run': 'condition',
  'task-terminal': 'condition',
  'wake-not-picked-up': 'change',
  'work-item': 'change',
  'work-item-done': 'condition',
  'work-item-settled': 'condition',
  'work-item-unblocked': 'change',
  'work-item-blocked': 'change',
  'work-item-claimed': 'change',
  'plan-item': 'condition',
  'claim-released': 'change',
  'scorecard-grading-audit': 'condition',
  'goal-drain-dead': 'change',
  'goal-plan-placement-changed': 'change',
  'goal-plan-fleet-missing': 'change',
  'goal-plan-fleet-unclaimed': 'change',
  'goal-edit-claim': 'change',
  'coord-receipt': 'condition',
  'work-item-duplicate-settled': 'condition',
  'work-item-tool-failure-reporter': 'change',
  'escalation-resolved': 'condition',
  'conversation-answered': 'condition',
  'consult-reply': 'change',
  'consult-answer-posted': 'condition',
  'consult-closed': 'condition',
  'handoff-accepted': 'condition',
  'report-published': 'condition',
  // event-wait-settlement-2026-10-20 D-005: explicit id scope — `release:deployed:<sha>`.
  deploy: 'condition',
};

describe('events catalog — fireProves classification (event-wait-settlement-2026-10-20 P-001)', () => {
  it('lists every id-scoped family with its classification, and nothing else', () => {
    const actual = Object.fromEntries(
      EVENT_CATALOG.filter((e) => !e.announcedShape && subjectScopeOf(e) === 'id').map((e) => [e.family, e.fireProves]),
    );
    expect(actual).toEqual(ID_SCOPED_FIRE_PROOF);
  });

  it('the builtin registry has no unclassified id-scoped family and no misplaced classification', () => {
    expect(findFireProofClassificationGaps()).toEqual([]);
  });

  it('reports an id-scoped family that ships without a classification', () => {
    const unclassified: EventCatalogEntry = {
      family: 'test-new-completion', keyTemplate: 'test:new:<id>',
      params: [{ name: 'id', required: true, describe: 'subject' }],
      describe: 'test', emitter: 'test', exists: true,
    };
    expect(findFireProofClassificationGaps([unclassified])).toEqual([
      { family: 'test-new-completion', keyTemplate: 'test:new:<id>', problem: 'unclassified' },
    ]);
    expect(findFireProofClassificationGaps([{ ...unclassified, fireProves: 'condition' }])).toEqual([]);
  });

  it('reports a classification on a family that binds no subject', () => {
    const global: EventCatalogEntry = {
      family: 'test-global', keyTemplate: 'test:global', params: [],
      describe: 'test', emitter: 'test', exists: true, fireProves: 'condition',
    };
    expect(findFireProofClassificationGaps([global])).toEqual([
      { family: 'test-global', keyTemplate: 'test:global', problem: 'not-id-scoped' },
    ]);
  });
});

describe('buildKey', () => {
  it.each([
    ['plan-blind-review-posted', { slug: 'my-plan' }, 'plan:blind-review-posted:my-plan'],
    ['consult-answer-posted', { conversationId: 'conv-123' }, 'consult:answer-posted:conv-123'],
    ['consult-closed', { conversationId: 'conv-123' }, 'consult:closed:conv-123'],
  ] as const)('discovers and builds the subject-scoped %s event', (family, params, key) => {
    expect(catalogEntry(family)).toMatchObject({ exists: true });
    expect(catalogEntry(family)?.fireProves).toBe(family === 'plan-blind-review-posted' ? undefined : 'condition');
    expect(buildKey(family, params)).toBe(key);
    expect(keyMatchesCatalog(key)).toBe(true);
  });

  it('keeps repeated plan review posts scoped to the plan, with the audit in the payload', () => {
    expect(subjectScopeOf(catalogEntry('plan-blind-review-posted')!)).toBe('scope');
  });

  it('interpolates a required param', () => {
    expect(buildKey('governor-transition', { kind: 'backlog-unhealthy' })).toBe(
      'governor:transition:backlog-unhealthy',
    );
    expect(buildKey('work-item', { id: 'WI-1234' })).toBe('work-item:status:WI-1234');
    expect(buildKey('work-item-settled', { id: 'WI-1234' })).toBe('work-item:settled:WI-1234');
    expect(buildKey('lock', { ticket: 'abc' })).toBe('lock:grant:abc');
    expect(buildKey('plan-item', { slug: 'my-plan', id: 'P-014' })).toBe('plan-item:done:my-plan:P-014');
    expect(buildKey('task-terminal', { taskId: 'tsk-123' })).toBe('task:terminal:tsk-123');
    expect(buildKey('external-trigger', { source: 'gmail', event: 'message.received' })).toBe(
      'ext:gmail:message.received',
    );
    expect(buildKey('consult-reply', { conversationId: 'conv-123' })).toBe('consult:reply:conv-123');
    expect(buildKey('repair-admitted', { candidate: 'abc123' })).toBe('gate:repair-admitted:abc123');
  });

  it('throws when a required param is missing', () => {
    expect(() => buildKey('work-item', {})).toThrow(/requires param 'id'/);
    expect(() => buildKey('work-item-settled', {})).toThrow(/requires param 'id'/);
    expect(() => buildKey('service-up', {})).toThrow(/requires param 'name'/);
    expect(() => buildKey('task-terminal', {})).toThrow(/requires param 'taskId'/);
    // a two-required-param family still names the SECOND missing param, not just the first
    expect(() => buildKey('plan-item', { slug: 'release-plan' })).toThrow(/requires param 'id'/);
  });

  it('collapses an omitted OPTIONAL param to the global key (matches the real global emit)', () => {
    // deploy with no sha → the global `release:deployed` that actually fires today
    expect(buildKey('deploy', {})).toBe('release:deployed');
    expect(buildKey('deploy', { sha: '' })).toBe('release:deployed');
    expect(buildKey('git-sync', {})).toBe('git-sync:committed');
    expect(buildKey('git-sync-egress', {})).toBe('git-sync:egressed');
    expect(buildKey('git-sync-lock-retry')).toBe('git-sync:lock-retry');
    expect(buildKey('resource-released', { resource: 'git-sync:papercusp' })).toBe(
      'resource:released:git-sync:papercusp',
    );
  });

  it('interpolates an OPTIONAL param when supplied (the precise per-sha key)', () => {
    expect(buildKey('deploy', { sha: 'abc123' })).toBe('release:deployed:abc123');
    expect(buildKey('git-sync', { sha: 'def456' })).toBe('git-sync:committed:def456');
    expect(buildKey('git-sync-egress', { sha: 'def456' })).toBe('git-sync:egressed:def456');
  });

  it('gate-verdict keys scope per pipeline when supplied, global when omitted (EI-7646)', () => {
    expect(buildKey('checkpoint', {})).toBe('release:green');
    expect(buildKey('checkpoint', { pipeline: 'papercusp' })).toBe('release:green:papercusp');
    expect(buildKey('checkpoint-red', {})).toBe('green-checkpoint:red');
    expect(buildKey('checkpoint-red', { pipeline: 'papercup' })).toBe('green-checkpoint:red:papercup');
  });

  it('a no-param family is a literal key', () => {
    expect(buildKey('checkpoint')).toBe('release:green');
    expect(buildKey('checkpoint-red')).toBe('green-checkpoint:red');
    expect(buildKey('deploy-failed')).toBe('release:deploy-failed');
  });

  it('work-item-created scopes per severity when supplied, global when omitted (EI-8296)', () => {
    expect(buildKey('work-item-created', {})).toBe('work-item:created');
    expect(buildKey('work-item-created', { severity: 'critical' })).toBe('work-item:created:critical');
  });

  it('spawn-slot interpolates the workspace (EI-13072 — the over-ceiling cup:spawn recovery key)', () => {
    expect(buildKey('spawn-slot', { workspace: 'papercusp-workspace' })).toBe('spawn-slot:freed:papercusp-workspace');
    expect(buildKey('spawn-slot', { workspace: 'default' })).toBe('spawn-slot:freed:default');
    expect(() => buildKey('spawn-slot', {})).toThrow(/requires param 'workspace'/);
  });

  it('throws on an unknown family', () => {
    expect(() => buildKey('nope' as string)).toThrow(/unknown family/);
  });
});

describe('renderCatalog', () => {
  it('projects every entry with a ready-to-copy await example', () => {
    const rows = renderCatalog();
    expect(rows.length).toBe(EVENT_CATALOG.length);
    for (const r of rows) {
      expect(r.await_example).toBe(`events:await { event: "${r.key}" }`);
      expect(typeof r.awaitable_now).toBe('boolean');
    }
  });

  it('marks the verified-existing keys awaitable_now', () => {
    const byFamily = Object.fromEntries(renderCatalog().map((r) => [r.family, r]));
    // Grounded against real emit sites (2026-07-03):
    expect(byFamily['checkpoint'].awaitable_now).toBe(true); // release:green
    expect(byFamily['deploy-failed'].awaitable_now).toBe(true); // release:deploy-failed
    expect(byFamily['work-item-done'].awaitable_now).toBe(true); // work-item:done
    expect(byFamily['work-item'].awaitable_now).toBe(true); // work-item:status — P-101 LANDED (setWorkItemState emit)
    expect(byFamily['deploy'].awaitable_now).toBe(true); // release:deployed:<sha> — P-102 LANDED (deploy.ts dual-emit)
    expect(byFamily['git-sync'].awaitable_now).toBe(true); // git-sync:committed — P-102 LANDED (git-sync-action emit)
    expect(byFamily['git-sync-egress'].awaitable_now).toBe(true); // truthful bridged origin/staging proof
    expect(byFamily['git-sync-lock-retry'].awaitable_now).toBe(true); // emitted by git-sync when a named resource lock defers a tick
    expect(byFamily['git-sync-lock-retry'].key).toBe('git-sync:lock-retry');
    expect(byFamily['resource-released'].awaitable_now).toBe(true); // emitted after an exclusive named-resource release boundary
    expect(byFamily['resource-released'].key).toBe('resource:released:<resource>');
    expect(byFamily['service-up'].awaitable_now).toBe(true); // service:up:<name> — P-104 LANDED (service-health tick)
    expect(byFamily['service-down'].awaitable_now).toBe(true); // service:down:<name> — P-104 LANDED (service-health tick)
    expect(byFamily['plan-item'].awaitable_now).toBe(true); // plan-item:done:<slug>:<id> — P-105 LANDED (set-status)
    expect(byFamily['claim-released'].awaitable_now).toBe(true); // claim:released:<id> — P-105 LANDED (releaseWorkItem)
    expect(byFamily['consult-reply'].awaitable_now).toBe(true); // consult:reply:<conversationId> — already emitted by consult verbs
    expect(byFamily['fleet-drained'].awaitable_now).toBe(true); // fleet:drained:<slug> — WI-1830 LANDED (set-status plan-drain edge)
    expect(byFamily['session-compacted'].awaitable_now).toBe(true); // session:compacted:<owner> — P-103 LANDED (psu-host → emit-session-compacted CLI)
    expect(byFamily['spawn-slot'].awaitable_now).toBe(true); // spawn-slot:freed:<ws> — EI-13072: emitter has always fired (announceSpawnSlotFreed + reclaim sweep + boot reconcile); only the catalog registration was missing
    expect(byFamily['fleet-member-stalled'].awaitable_now).toBe(true);
    expect(byFamily['fleet-member-stalled'].key).toBe('fleet:member-stalled:<slug>');
    expect(byFamily['fleet-admission-blocked'].awaitable_now).toBe(true);
    expect(byFamily['fleet-admission-blocked'].key).toBe('fleet:admission-blocked:<slug>');
    expect(byFamily['fleet-repeated-recovery'].awaitable_now).toBe(true);
    expect(byFamily['fleet-repeated-recovery'].key).toBe('fleet:repeated-recovery:<slug>');
    expect(byFamily['fleet-repeated-recovery'].describe).toContain('takeoverAuthorized=false');
    // WI-1632193: still RENDERED (that is what makes the shape discoverable), even
    // though keyMatchesCatalog no longer matches it — see the announcedShape tests.
    expect(byFamily['plan-event'].key).toBe('plan:<slug>:<gate>');
    expect(byFamily['fleet-event'].key).toBe('fleet:<slug>:<gate>');
    expect(byFamily['fleet-event'].awaitable_now).toBe(true);
  });

  it('makes the self-assignee restriction discoverable for both work-item await families', () => {
    const rows = renderCatalog();
    for (const family of ['work-item', 'work-item-done']) {
      const description = rows.find((row) => row.family === family)?.describe;
      expect(description, family).toMatch(/DIFFERENT assignee/);
      expect(description, family).toMatch(/refuses your own current work item before registration/);
    }
  });
});

describe('catalogEntry', () => {
  it('finds by family and returns undefined for unknown', () => {
    expect(catalogEntry('deploy')?.keyTemplate).toBe('release:deployed:<sha>');
    expect(catalogEntry('does-not-exist')).toBeUndefined();
  });
});

describe('familyKeyPrefix (EI-9000 — the live-awaiter-count join key)', () => {
  it('strips the trailing colon before an optional/required param placeholder', () => {
    expect(familyKeyPrefix(catalogEntry('deploy')!)).toBe('release:deployed');
    expect(familyKeyPrefix(catalogEntry('work-item')!)).toBe('work-item:status');
    expect(familyKeyPrefix(catalogEntry('checkpoint')!)).toBe('release:green');
    expect(familyKeyPrefix(catalogEntry('plan-item')!)).toBe('plan-item:done');
  });

  it('a literal-key (no unresolved-prefix-worthy param) family prefix is its keyTemplate up to the optional param', () => {
    expect(familyKeyPrefix(catalogEntry('deploy-failed')!)).toBe('release:deploy-failed');
    expect(familyKeyPrefix(catalogEntry('checkpoint-red')!)).toBe('green-checkpoint:red');
  });

  it('every family prefix is unique (no two families would double-count a live await)', () => {
    const prefixes = EVENT_CATALOG.map((e) => familyKeyPrefix(e));
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('the prefix, with a trailing "%", LIKE-matches both the global key (when buildable) and a concrete interpolated key', () => {
    for (const e of EVENT_CATALOG) {
      const prefix = familyKeyPrefix(e);
      const hasRequired = e.params.some((p) => p.required);
      if (!hasRequired) {
        // no required params → the global key is buildable and must match the prefix
        const globalKey = buildKey(e.family, {});
        expect(globalKey.startsWith(prefix), `${e.family}: '${globalKey}' should start with '${prefix}'`).toBe(true);
      }
      // always buildable with every param supplied — the concrete key must match too
      const concreteParams = Object.fromEntries(e.params.map((p) => [p.name, 'x']));
      const concreteKey = buildKey(e.family, concreteParams);
      expect(concreteKey.startsWith(prefix), `${e.family}: '${concreteKey}' should start with '${prefix}'`).toBe(true);
    }
  });
});

describe('scoped announced gates are NOT catalog families (WI-1632193)', () => {
  // The `(EI-216663)` this block used to cite is a DANGLING reference: that id
  // exists on no work-item and nowhere else in the tree, so it could not be used
  // to check what behaviour was originally being protected. What IS checkable is
  // the contract below, and it is asserted for all three scopes rather than for
  // the one that happened to have a family.
  it('mints the documented key shape while staying outside the static catalog', () => {
    const key = buildAnnouncedKey('p508-current-head-desktop-sidecar-released', {
      kind: 'plan',
      ref: 'p2p-public-release-remaining-lanes-2026-07-16',
    });
    // The KEY SHAPE is unchanged by WI-1632193 — removing the family migrated no
    // await and rewrote no key. This assertion is what proves that.
    expect(key).toBe('plan:p2p-public-release-remaining-lanes-2026-07-16:p508-current-head-desktop-sidecar-released');

    // …but an announced key is minted at RUNTIME from the announcer's scope, so no
    // static family can or should claim it. All three scopes answer alike; a `true`
    // for any of them means a placeholder-first family was re-added, which reopens
    // the `plan:draft-redy:x` hole.
    expect(keyMatchesCatalog(key)).toBe(false);
    expect(keyMatchesCatalog(buildAnnouncedKey('phase3-open', { kind: 'fleet', ref: 'p2p-git' }))).toBe(false);
    expect(keyMatchesCatalog(buildAnnouncedKey('some-gate', { kind: 'harness', ref: 'papercusp' }))).toBe(false);

    // …while remaining fully DISCOVERABLE. This is the pair EI-21666331086562886 and
    // WI-1632193 each own one half of: the row is rendered so a late agent can find
    // the shape, and it matches nothing so a typo of it cannot pass as catalogued.
    expect(renderCatalog().find((candidate) => candidate.family === 'plan-event')).toMatchObject({
      key: 'plan:<slug>:<gate>',
    });
    expect(renderCatalog().find((candidate) => candidate.family === 'fleet-event')).toMatchObject({
      key: 'fleet:<slug>:<gate>',
    });
  });

  it('a GLOBAL announced gate is still just its own bare key', () => {
    // Unscoped announcements are not prefixed at all, so nothing here constrains them.
    expect(buildAnnouncedKey('release-window-open', { kind: 'global', ref: null })).toBe('release-window-open');
  });
});

describe('EI-10870 — keyMatchesCatalog (the orphan-await guard)', () => {
  it('matches a TEMPLATED family for any concrete instantiation', () => {
    // release:green:<pipeline> — the key whose lost wake started all of this.
    expect(keyMatchesCatalog('release:green:papercusp')).toBe(true);
    expect(keyMatchesCatalog('release:green:some-other-pipeline')).toBe(true);
    expect(keyMatchesCatalog('green-checkpoint:red:papercusp')).toBe(true);
    expect(keyMatchesCatalog('work-item:done:WI-4528')).toBe(true);
    expect(keyMatchesCatalog('lock:grant:ticket-1')).toBe(true);
  });

  it('matches BOTH the global and the scoped form of an optional-param family (buildKey collapse rule)', () => {
    expect(keyMatchesCatalog('release:deployed')).toBe(true); // global — optional <sha> collapsed
    expect(keyMatchesCatalog('release:deployed:abc123')).toBe(true); // scoped
  });

  it('REJECTS the real orphan key: overwatch:surface-landed had 14 awaits, 0 fires ever, and no emitter anywhere in the tree', () => {
    expect(keyMatchesCatalog('overwatch:surface-landed')).toBe(false);
  });

  it('rejects a plausible TYPO of a real key — the near-miss that silently never rendezvouses', () => {
    expect(keyMatchesCatalog('release:greeen:papercusp')).toBe(false);
    expect(keyMatchesCatalog('work-item:finished:WI-1')).toBe(false);
    expect(keyMatchesCatalog('')).toBe(false);
  });

  it('does NOT prefix-match a longer family name (release:green must not swallow release:greenish:x)', () => {
    // Guards the `k.startsWith(prefix)` sloppiness: matching must be on a ':' boundary.
    expect(keyMatchesCatalog('release:greenish:x')).toBe(false);
  });

  it('EI-13072: spawn-slot:freed:<ws> is NOT an orphan — the over-ceiling cup:spawn recovery await must not be false-flagged unknown_event_key', () => {
    // The over-ceiling cup:spawn rejection advises `events:await { event:
    // "spawn-slot:freed:<workspace>" }`, and the emitter has always fired that key.
    // Before the catalog registration this exact call returned unknown_event_key:true
    // ("nothing will ever fire it — can only TIME OUT"), stranding the agent on a
    // recovery it was TOLD to use. Both the concrete repro key and any workspace form
    // must now resolve to the family.
    expect(keyMatchesCatalog('spawn-slot:freed:papercusp-workspace')).toBe(true);
    expect(keyMatchesCatalog('spawn-slot:freed:default')).toBe(true);
  });

  it('EI-18676056143796303: coord:inbox-wake:<ownerId> is NOT an orphan — the most-fired key in the system, and the one that rescues a stranded agent', () => {
    // The incident: an agent woken BY this key re-registered it to park again and
    // was told "nothing in this system will ever fire it and this await can only
    // TIME OUT". Acting on that warning means abandoning the always-armed
    // inbox-wake — precisely the failure the inbox-wake exists to prevent.
    expect(keyMatchesCatalog('coord:inbox-wake:su-5d27fac9-98b3-4012-8537-18b12cdf114d')).toBe(true);
    expect(keyMatchesCatalog('coord:inbox-wake:su-anyone-else')).toBe(true);
  });

  it('EI-18676056143796303: the other emitting-but-unregistered families found in the same sweep resolve too', () => {
    // Each was grounded on BOTH its emit site and a non-zero event_key_fires row.
    expect(keyMatchesCatalog('escalation:resolved:ms18abc-0000-deadbeef')).toBe(true);
    expect(keyMatchesCatalog('conversation:answered:conv-mrp8u2x7-0000-abc')).toBe(true);
    expect(keyMatchesCatalog('handoff:accepted:ms18xyz-0000-cafe')).toBe(true);
    expect(keyMatchesCatalog('plan:draft-ready:some-plan-slug')).toBe(true);
    expect(keyMatchesCatalog('rate-limit:exhausted:acct-7')).toBe(true);
    expect(keyMatchesCatalog('pot-git:ref-announce')).toBe(true);
    expect(keyMatchesCatalog('pot-git:staging-advance')).toBe(true);
    expect(keyMatchesCatalog('coord:receipt:ms18qqq-0000-feed')).toBe(true);
    expect(keyMatchesCatalog('work-item:duplicate-settled:WI-5822')).toBe(true);
    expect(keyMatchesCatalog('work-item:tool-failure-reporter:EI-25396682599838692')).toBe(true);
    expect(keyMatchesCatalog('release-pass:autoloop')).toBe(true);
  });

  it('registering coord:inbox-wake did NOT widen the guard into swallowing neighbouring coord keys', () => {
    // `coord:` is a busy namespace; the family must match on a ':' boundary only.
    expect(keyMatchesCatalog('coord:inbox-waked:su-x')).toBe(false);
    expect(keyMatchesCatalog('coord:something-else:su-x')).toBe(false);
    expect(keyMatchesCatalog('rate-limit:exhaustedish:acct-7')).toBe(false);
  });

  it('honours an INSTALLED pack family, so a pack-emitted key is never misreported as an orphan', () => {
    const installed = [
      ...EVENT_CATALOG,
      {
        family: 'my-pack',
        keyTemplate: 'my-pack:thing-happened:<id>',
        params: [{ name: 'id', required: true }],
        describe: 'a pack-declared event',
        emitter: 'my-pack',
        awaitable_now: true,
      } as unknown as EventCatalogEntry,
    ];
    expect(keyMatchesCatalog('my-pack:thing-happened:42', installed)).toBe(true);
    // …and it is still an orphan against the builtin-only catalog.
    expect(keyMatchesCatalog('my-pack:thing-happened:42')).toBe(false);
  });

  it('every family in the live catalog matches its own concrete key (no family can self-report as an orphan)', () => {
    let exempted = 0;
    for (const e of EVENT_CATALOG) {
      const params: Record<string, string> = {};
      for (const p of e.params) params[p.name] = 'x';
      // WI-1632193: an `announcedShape` row documents a RUNTIME-minted key, so it is
      // supposed to match nothing — including itself. That is not a family reporting
      // as an orphan; it is a row that never answers membership at all, because its
      // free first placeholder cannot separate a real slug from a typo of a sibling
      // family. The dual contract (rendered, never matched) is asserted directly in
      // subject-scope.test.ts.
      if (e.announcedShape) {
        expect(keyMatchesCatalog(buildKey(e.family, params)), `${e.family} must NOT match`).toBe(false);
        exempted += 1;
        continue;
      }
      expect(keyMatchesCatalog(buildKey(e.family, params)), `${e.family} must match itself`).toBe(true);
    }
    // Pin the exemption's size so a future announcedShape row is a deliberate act:
    // silently widening this is how the orphan guard would go dark a second time.
    expect(exempted).toBe(2);
  });
});

describe('EI-13089 — findRequiredParamPrefixMatch (the family-prefix-missing-required-param guard)', () => {
  it('flags a bare family prefix whose first param is REQUIRED — no emitter ever fires the literal key', () => {
    expect(findRequiredParamPrefixMatch('work-item:done')).toMatchObject({
      entry: { family: 'work-item-done' },
      param: { name: 'id', required: true },
    });
    expect(findRequiredParamPrefixMatch('lock:grant')).toMatchObject({
      entry: { family: 'lock' },
      param: { name: 'ticket', required: true },
    });
    expect(findRequiredParamPrefixMatch('plan-run:finished')).toMatchObject({
      entry: { family: 'plan-run' },
      param: { name: 'runId', required: true },
    });
  });

  it('does NOT flag an OPTIONAL-param family — the bare prefix is a real global key (buildKey collapse rule)', () => {
    expect(findRequiredParamPrefixMatch('release:deployed')).toBeUndefined(); // deploy: <sha> optional
    expect(findRequiredParamPrefixMatch('release:green')).toBeUndefined(); // checkpoint: <pipeline> optional
  });

  it('does NOT flag a fully-interpolated concrete key', () => {
    expect(findRequiredParamPrefixMatch('work-item:done:WI-4528')).toBeUndefined();
    expect(findRequiredParamPrefixMatch('lock:grant:ticket-1')).toBeUndefined();
  });

  it('does NOT flag a no-param (literal) family or a genuine orphan key', () => {
    expect(findRequiredParamPrefixMatch('work-item:claimable')).toBeUndefined();
    expect(findRequiredParamPrefixMatch('overwatch:surface-landed')).toBeUndefined();
    expect(findRequiredParamPrefixMatch('')).toBeUndefined();
  });
});

describe('P-004/D-002 — findZeroParamSuffixMismatch (the zero-param-family-with-a-suffix guard)', () => {
  it('flags the live incident keys: a suffix on work-item:claimable, which declares NO params', () => {
    // 42 awaits from 6 agents, 100% timeout, ZERO real fires ever — while the bare key
    // ran 1913 awaits / 1221 real fires. keyMatchesCatalog says `true` for all of these
    // (prefix match), which is exactly why the EI-10870 orphan guard stayed silent.
    for (const key of [
      'work-item:claimable:p2p-release-verify-lane',
      'work-item:claimable:papercusp:backlog-drain',
      'work-item:claimable:*',
    ]) {
      expect(findZeroParamSuffixMismatch(key), key).toMatchObject({
        entry: { family: 'work-item-claimable' },
        prefix: 'work-item:claimable',
      });
      // The precondition for the whole bug: the permissive prefix test says "known key".
      expect(keyMatchesCatalog(key), key).toBe(true);
    }
  });

  it('does NOT flag the canonical bare key of a zero-param family', () => {
    for (const e of EVENT_CATALOG) {
      if (e.params.length > 0 || e.keyTemplate.includes('<')) continue;
      expect(findZeroParamSuffixMismatch(e.keyTemplate), e.keyTemplate).toBeUndefined();
    }
  });

  it('does NOT flag a suffix on an OPTIONAL-param family — release:green:<pipeline> is real', () => {
    // The plan item assumed the wildcard itself was the defect. It is not: this family
    // genuinely emits a scoped form, so both the concrete and glob keys are legitimate.
    // (release:green's real defect is a pipeline-blind BANNER, not the key — see D-002.)
    expect(findZeroParamSuffixMismatch('release:green:papercusp')).toBeUndefined();
    expect(findZeroParamSuffixMismatch('release:green:*')).toBeUndefined();
    expect(findZeroParamSuffixMismatch('green-checkpoint:red:oddsmith')).toBeUndefined();
  });

  it('does NOT flag a suffix on a REQUIRED-param family (that is the sibling guard EI-13089)', () => {
    expect(findZeroParamSuffixMismatch('work-item:done:WI-4528')).toBeUndefined();
    expect(findZeroParamSuffixMismatch('work-item:done:*')).toBeUndefined();
    expect(findZeroParamSuffixMismatch('lock:grant:ticket-1')).toBeUndefined();
  });

  it('a glob whose literal head stops SHORT of the separator legitimately matches the bare key', () => {
    // `work-item:claimable*` → ^work-item:claimable.*$ DOES match the bare emit, so it
    // is not dead. Only a head that strictly extends the prefix with `:` is impossible.
    expect(findZeroParamSuffixMismatch('work-item:claimable*')).toBeUndefined();
    expect(findZeroParamSuffixMismatch('work-item:*')).toBeUndefined();
  });

  it('says nothing about an undecidable or empty key rather than guessing', () => {
    expect(findZeroParamSuffixMismatch('*:claimable:x')).toBeUndefined(); // literal head is empty
    expect(findZeroParamSuffixMismatch('*')).toBeUndefined();
    expect(findZeroParamSuffixMismatch('')).toBeUndefined();
    expect(findZeroParamSuffixMismatch('   ')).toBeUndefined();
    expect(findZeroParamSuffixMismatch(undefined as unknown as string)).toBeUndefined();
  });

  it("does NOT flag an unrelated orphan key (that is the EI-10870 orphan guard's job)", () => {
    expect(findZeroParamSuffixMismatch('overwatch:surface-landed')).toBeUndefined();
  });
});

describe('EI-18701276960172209 — findCatalogNearMiss (catalog "did you mean" suggestion)', () => {
  it('the live incident: "green-gate-verdict" suggests both green-checkpoint families', () => {
    // The actual repro: an agent declared this key expecting green-checkpoint to fire
    // it; the REAL keys are release:green:<pipeline> / green-checkpoint:red:<pipeline>.
    const hits = findCatalogNearMiss('green-gate-verdict');
    expect(hits).toContain('release:green');
    expect(hits).toContain('green-checkpoint:red');
  });

  it('a genuinely unrelated invented key suggests nothing', () => {
    expect(findCatalogNearMiss('overwatch:surface-landed')).toEqual([]);
    expect(findCatalogNearMiss('totally-made-up-xyz')).toEqual([]);
  });

  it('an empty/short key never matches (short tokens are too generic to mean anything)', () => {
    expect(findCatalogNearMiss('')).toEqual([]);
    expect(findCatalogNearMiss('id ws x')).toEqual([]); // every token < 4 chars
  });

  it('a key that already matches the catalog exactly can still surface siblings, but callers only invoke this when keyMatchesCatalog is already false', () => {
    // Documents intended usage, not a hard contract: this helper does not itself
    // check keyMatchesCatalog — callers (events:await) only call it after confirming
    // the key is unmatched, so this just proves the token-overlap logic in isolation.
    expect(findCatalogNearMiss('release:green:papercusp')).toContain('release:green');
  });

  it('respects the `limit` cap and dedupes repeated prefixes', () => {
    const hits = findCatalogNearMiss('work-item-done-lock-grant', EVENT_CATALOG, 1);
    expect(hits.length).toBeLessThanOrEqual(1);
    expect(new Set(hits).size).toBe(hits.length);
  });
});

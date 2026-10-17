/** Regression guard for the source-level machine-turn enrollment checker. */
import { describe, expect, it } from 'vitest';
// @ts-ignore — pure JS lint module; imported for its source predicate.
import { ALLOWLIST, findTurnInjectionSites, isExcluded } from '../../../../scripts/check-no-unenrolled-injector.mjs';

function sites(source: string) {
  return findTurnInjectionSites(source, 'subject.ts') as Array<{
    enrolled: boolean;
    mode: string;
    dataText: string;
  }>;
}

describe('no-unenrolled-injector guard predicate (EI-21903660573830465)', () => {
  it('recognizes the enrollment helper on the exact transported payload', () => {
    const found = sites(`
      async function send(raw: string) {
        const tagged = await tagTurnForInjection({ sid: owner, origin: 'fleet-kickoff', text: raw });
        await injectIntoHost(sock, { mode: 'turn', data: tagged.taggedText, ownerId: owner });
      }
    `);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ enrolled: true, mode: 'turn', dataText: 'tagged.taggedText' });
  });

  it('flags an untagged payload even when the same function tags unrelated text', () => {
    // Distinguishing negative control: file-level/helper-presence checks would pass
    // this source even though the delivered `raw` value is never enrolled.
    const found = sites(`
      async function send(raw: string) {
        await tagTurnForInjection({ sid: owner, origin: 'fleet-kickoff', text: 'diagnostic only' });
        await injectIntoHost(sock, { mode: 'turn', data: raw, ownerId: owner });
      }
    `);

    expect(found).toHaveLength(1);
    expect(found[0]?.enrolled).toBe(false);
  });

  it('does not trust a mutable alias that can fall back to raw text', () => {
    const found = sites(`
      async function send(raw: string) {
        let data = raw;
        try {
          data = (await tagTurnForInjection({ sid: owner, origin: 'wake-pump', text: raw })).taggedText;
        } catch {
          // The injector below still sees raw when enrollment fails.
        }
        await injectIntoHost(sock, { mode: 'turn', data, ownerId: owner });
      }
    `);

    expect(found).toHaveLength(1);
    expect(found[0]?.enrolled).toBe(false);
  });

  it('keeps an unresolved options alias in the measured population', () => {
    const found = sites(`
      function send(options: { mode: 'turn'; data: string }) {
        injectIntoHost(sock, options);
      }
    `);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ enrolled: false, mode: 'unknown', dataText: '<missing-data>' });
  });

  it('follows a tagged payload through the transport options object', () => {
    const found = sites(`
      async function send(raw: string) {
        const tagged = await tagWakeText(raw);
        const injectMsg = { mode: 'carry-respawn', data: tagged, ownerId: owner };
        await injectPsuHost(sock, injectMsg);
      }
    `);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ enrolled: true, mode: 'carry-respawn' });
  });

  it('recognizes enrollment carried through a branded helper parameter and nested closure', () => {
    const found = sites(`
      declare const enrolled: unique symbol;
      type EnrolledWakeText = string & { readonly [enrolled]: true };
      function injectWake(warmText: EnrolledWakeText) {
        const injectWarm = () => injectIntoHost(sock, { mode: 'turn', data: warmText });
        return injectWarm();
      }
    `);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ enrolled: true, dataText: 'warmText' });
  });

  it('recognizes the reviewed headless watchdog carry wrapper', () => {
    const found = sites(`
      async function send(raw: string) {
        const carry = await taggedHeadlessMcpRecoveryWakeText(owner, 45);
        await injectIntoHost(sock, { mode: 'carry-respawn', data: carry, ownerId: owner });
      }
    `);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ enrolled: true, dataText: 'carry' });
  });

  it('does not trust a raw string parameter just because it crosses the same helper boundary', () => {
    const found = sites(`
      function injectWake(warmText: string) {
        const injectWarm = () => injectIntoHost(sock, { mode: 'turn', data: warmText });
        return injectWarm();
      }
    `);

    expect(found).toHaveLength(1);
    expect(found[0]?.enrolled).toBe(false);
  });

  it('does not inherit an outer enrollment brand through a shadowing raw parameter', () => {
    const found = sites(`
      declare const enrolled: unique symbol;
      type EnrolledWakeText = string & { readonly [enrolled]: true };
      function send(warmText: EnrolledWakeText) {
        const injectWarm = (warmText: string) =>
          injectIntoHost(sock, { mode: 'turn', data: warmText });
        return injectWarm('raw payload');
      }
    `);

    expect(found).toHaveLength(1);
    expect(found[0]?.enrolled).toBe(false);
  });

  it('resolves shorthand data after the local variable is enrolled', () => {
    const found = sites(`
      async function send(raw: string) {
        const tagged = (await tagTurnForInjection({ sid: owner, origin: 'wake-pump', text: raw })).taggedText;
        const data = tagged;
        await injectIntoHost(sock, { mode: 'turn', data });
      }
    `);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ enrolled: true, dataText: 'data' });
  });

  it('keeps only exact, reasoned owner-authored pass-through exceptions', () => {
    expect(ALLOWLIST.size).toBe(3);
    for (const reason of ALLOWLIST.values()) expect(reason.trim().length).toBeGreaterThan(0);
  });

  it('ignores non-prompt transport modes', () => {
    expect(
      sites(`function sendControl() { injectIntoHost(sock, { mode: 'raw', data: '\\u001b' }); }`),
    ).toEqual([]);
  });

  it('does not treat comments as enrollment evidence', () => {
    const found = sites(`
      async function send(raw: string) {
        // tagTurnForInjection({ sid, origin, text: raw }) was considered here.
        await injectIntoHost(sock, { mode: 'turn', data: raw });
      }
    `);
    expect(found[0]?.enrolled).toBe(false);
  });

  it('does not count the PTY transport wrapper that forwards a constructed message', () => {
    const found = findTurnInjectionSites(`
      export function injectIntoHost(
        sock: string,
        msg: Parameters<typeof injectIntoHostWithConfirmation>[1],
        timeoutMs = 2000,
      ) {
        return injectIntoHostWithConfirmation(sock, msg, timeoutMs).then((result) => result.ok);
      }
    `, 'packages/operator-core/lib/events/await/psu-pty-discovery.ts');

    expect(found).toEqual([]);
  });

  it('excludes test-support and generated sidecar sources while retaining runtime sources', () => {
    expect(isExcluded('packages/operator-core/test/_multi-session-testbed.ts')).toBe(true);
    expect(isExcluded('papercusp-desktop/src-tauri/env-sidecars/host.mjs')).toBe(true);
    expect(isExcluded('apps/operator/apps/operator/dist-host-native-fixture-debug-2001983/hono-host.mjs')).toBe(true);
    expect(isExcluded('packages/operator-core/lib/events/await/wake-executor.ts')).toBe(false);
  });
});

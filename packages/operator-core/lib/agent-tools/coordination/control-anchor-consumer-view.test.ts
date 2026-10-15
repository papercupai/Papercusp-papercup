/**
 * WI-10005199 (EI-23770243810745552) — the consumerView on a mode write's control-anchor
 * projection. The write target is `agent_modes`; the consumer reads
 * `session_briefs.control_state->modes`, and the refresh between them is fail-soft.
 */
import { describe, expect, it } from 'vitest';
import {
  attestLoopControlConsumerView,
  attestModeControlConsumerView,
  LOOP_CONSUMER_READ_PATH,
  MODES_CONSUMER_READ_PATH,
} from './control-anchor-consumer-view';

const anchor = (modes: string[]) => ({ generation: 4, state: { modes } });

describe('attestModeControlConsumerView', () => {
  it('names the path the consumer reads, not the write target', () => {
    const view = attestModeControlConsumerView({ modeId: 'auto', enabled: true }, anchor(['auto']));
    expect(view.readPath).toBe(MODES_CONSUMER_READ_PATH);
    expect(view.readPath).toContain('control_state');
    expect(view.readPath).not.toContain('agent_modes');
  });

  it('agrees when an enabled mode is present in the projected modes', () => {
    const view = attestModeControlConsumerView({ modeId: 'auto', enabled: true }, anchor(['auto', 'ideate']));
    expect(view.divergedFromWrite).toBe(false);
    expect(view.value).toEqual({ modeId: 'auto', present: true });
  });

  it('agrees when a cleared mode is absent from the projected modes', () => {
    const view = attestModeControlConsumerView({ modeId: 'auto', enabled: false }, anchor(['ideate']));
    expect(view.divergedFromWrite).toBe(false);
    expect(view.value).toEqual({ modeId: 'auto', present: false });
  });

  // The diverging fixtures: each is a write the agent_modes table accepted but the
  // consumer's read does not reflect.
  it('DIVERGES when an enabled mode never reached the projection', () => {
    const view = attestModeControlConsumerView({ modeId: 'auto', enabled: true }, anchor(['ideate']));
    expect(view.divergedFromWrite).toBe(true);
    expect(view.value).toEqual({ modeId: 'auto', present: false });
  });

  it('DIVERGES when a cleared mode still lingers in the projection', () => {
    const view = attestModeControlConsumerView({ modeId: 'auto', enabled: false }, anchor(['auto']));
    expect(view.divergedFromWrite).toBe(true);
    expect(view.value).toEqual({ modeId: 'auto', present: true });
  });

  it('DIVERGES — cannot prove agreement — when the fail-soft refresh returned null', () => {
    const view = attestModeControlConsumerView({ modeId: 'auto', enabled: true }, null);
    expect(view.divergedFromWrite).toBe(true);
    expect(view.value).toEqual({ modeId: 'auto', present: null });
  });

  it('DIVERGES when the refreshed anchor carries no readable modes', () => {
    expect(attestModeControlConsumerView({ modeId: 'auto', enabled: true }, {}).divergedFromWrite).toBe(true);
    expect(attestModeControlConsumerView({ modeId: 'auto', enabled: true }, { state: null }).divergedFromWrite).toBe(true);
    expect(attestModeControlConsumerView({ modeId: 'auto', enabled: false }, { state: {} }).divergedFromWrite).toBe(true);
  });

  it('is not fooled by a clear + null refresh: absent-by-failure is not absent-by-agreement', () => {
    // (mode half — the loop half is its own describe below)
    // A disable whose refresh failed must NOT read as "agrees, auto is absent" —
    // null (unknown) and false (known absent) are different observations.
    const failed = attestModeControlConsumerView({ modeId: 'auto', enabled: false }, null);
    const landed = attestModeControlConsumerView({ modeId: 'auto', enabled: false }, anchor([]));
    expect(failed.divergedFromWrite).toBe(true);
    expect(landed.divergedFromWrite).toBe(false);
  });
});

describe('attestLoopControlConsumerView', () => {
  const loopAnchor = (loop: { active: boolean; intervalSec: number | null }) => ({ generation: 3, state: { loop } });

  it('names the path the consumer reads, not the routines write target', () => {
    const view = attestLoopControlConsumerView({ active: true, intervalSec: 300 }, loopAnchor({ active: true, intervalSec: 300 }));
    expect(view.readPath).toBe(LOOP_CONSUMER_READ_PATH);
    expect(view.readPath).toContain('control_state');
    expect(view.readPath).not.toContain('routines');
  });

  it('agrees when an armed loop is projected active at the persisted interval', () => {
    const view = attestLoopControlConsumerView({ active: true, intervalSec: 300 }, loopAnchor({ active: true, intervalSec: 300 }));
    expect(view.divergedFromWrite).toBe(false);
    expect(view.value).toEqual({ active: true, intervalSec: 300 });
  });

  it('agrees when an ended loop is projected inactive (interval is not part of an end)', () => {
    const view = attestLoopControlConsumerView({ active: false, intervalSec: 300 }, loopAnchor({ active: false, intervalSec: 300 }));
    expect(view.divergedFromWrite).toBe(false);
    expect(view.value).toEqual({ active: false, intervalSec: null });
  });

  // Diverging fixtures: a loop write the routines table accepted that the consumer's read
  // does not reflect.
  it('DIVERGES when an armed loop is still projected inactive', () => {
    const view = attestLoopControlConsumerView({ active: true, intervalSec: 300 }, loopAnchor({ active: false, intervalSec: null }));
    expect(view.divergedFromWrite).toBe(true);
    expect(view.value).toEqual({ active: false, intervalSec: null });
  });

  it('DIVERGES when the projected interval is stale', () => {
    const view = attestLoopControlConsumerView({ active: true, intervalSec: 300 }, loopAnchor({ active: true, intervalSec: 900 }));
    expect(view.divergedFromWrite).toBe(true);
    expect(view.value).toEqual({ active: true, intervalSec: 900 });
  });

  it('DIVERGES when an ended loop is still projected active', () => {
    const view = attestLoopControlConsumerView({ active: false, intervalSec: null }, loopAnchor({ active: true, intervalSec: 300 }));
    expect(view.divergedFromWrite).toBe(true);
  });

  it('DIVERGES — cannot prove agreement — when the refresh returned null or no readable loop', () => {
    expect(attestLoopControlConsumerView({ active: true, intervalSec: 300 }, null).divergedFromWrite).toBe(true);
    expect(attestLoopControlConsumerView({ active: true, intervalSec: 300 }, {}).divergedFromWrite).toBe(true);
    expect(attestLoopControlConsumerView({ active: true, intervalSec: 300 }, { state: { loop: null } }).divergedFromWrite).toBe(true);
    expect(attestLoopControlConsumerView({ active: true, intervalSec: 300 }, { state: { loop: {} } }).divergedFromWrite).toBe(true);
  });

  it('is not fooled by an end + null refresh: unknown is not "inactive by agreement"', () => {
    const failed = attestLoopControlConsumerView({ active: false, intervalSec: null }, null);
    const landed = attestLoopControlConsumerView({ active: false, intervalSec: null }, loopAnchor({ active: false, intervalSec: null }));
    expect(failed.divergedFromWrite).toBe(true);
    expect(failed.value).toEqual({ active: null, intervalSec: null });
    expect(landed.divergedFromWrite).toBe(false);
  });
});

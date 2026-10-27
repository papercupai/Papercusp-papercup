/**
 * The participant sink must never abort the interaction delivery it rides along with
 * (WI-10006570): connectorSinksFor builds it next to the interaction's own sinks, so a throw while
 * BUILDING it used to fail the whole Gmail sync, mail included.
 */
import type { Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { createInteractionParticipantSink, reportParticipantChainError } from './participants';

const INPUT = { workspaceId: 'ws-1', sourceId: 'src-1', datatype: 'email-message' };
// createParticipantChain first reads the source row (isPersonalAccountSource) through `sql` as a
// tagged template. No row means "not a personal account", so the chain goes on to build the person
// sinks these cases exercise.
const sql = (async () => []) as unknown as Sql;

describe('createInteractionParticipantSink', () => {
  it('returns null and reports, instead of throwing, when the person record sink cannot be built', async () => {
    const onChainError = vi.fn();
    const sink = await createInteractionParticipantSink(sql, INPUT, {
      createPersonSinks: async () => {
        throw new Error('data_source_harness_missing:src-1');
      },
      onChainError,
    });
    expect(sink).toBeNull();
    expect(onChainError).toHaveBeenCalledTimes(1);
    expect(String(onChainError.mock.calls[0]![0])).toContain('data_source_harness_missing:src-1');
    expect(onChainError.mock.calls[0]![1]).toEqual(INPUT);
  });

  it('asks the person record sink for the graph home harness, so a personal source without one can still be granted', async () => {
    const createPersonSinks = vi.fn(async () => []);
    const sink = await createInteractionParticipantSink(sql, INPUT, { createPersonSinks, onChainError: vi.fn() });
    // No person -> record routing: no grant, no sink.
    expect(sink).toBeNull();
    expect(createPersonSinks).toHaveBeenCalledTimes(1);
    const [, request] = createPersonSinks.mock.calls[0] as unknown as [Sql, { datatype: string; defaultHarness?: string }];
    expect(request.datatype).toBe('person');
    expect(request.defaultHarness).toBeTruthy();
  });

  it('the default reporter names the source and the cause on one greppable line', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportParticipantChainError(new Error('boom'), INPUT);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toMatch(/^\[relationship-graph\] PARTICIPANT PROJECTION DECLINED .*source=src-1.*boom/);
    error.mockRestore();
  });
});

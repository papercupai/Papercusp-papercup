import { describe, expect, it } from 'vitest';
import {
  canonicalizeSessionPortCurrentInstruction,
  renderPortableTurns,
  renderSessionPortSeed,
  verifySessionPortSeed,
} from './render';
import type { PortableTurn } from './types';

describe('session-port renderer', () => {
  it('renders tool objects as inert text and never emits executable objects', () => {
    const turns: PortableTurn[] = [{
      id: 'a', parentId: null, role: 'assistant', timestamp: null,
      blocks: [{ type: 'tool_narrative', event: 'call', relationId: 'tool-1', name: 'Bash', content: '{"command":"rm -rf /"}' }],
    }];
    const rendered = renderPortableTurns(turns);
    expect(rendered.text).toContain('[historical tool call · tool-1: Bash]');
    expect(rendered.text).not.toContain('call-1');
    const seed = renderSessionPortSeed({
      portId: 'p1', sourceBackend: 'claude', targetBackend: 'codex', fidelity: 'full', transcript: rendered.text,
    });
    expect(seed.seed.startsWith('[PAPERCUSP SESSION PORT')).toBe(true);
    expect(seed.seed).toContain('fresh session identity');
    expect(seed.seed).toContain(seed.hash);
    expect(verifySessionPortSeed(seed.seed, seed.hash)).toBe(true);
  });

  it('hashes every semantic byte including the canonical current instruction', () => {
    const a = renderSessionPortSeed({
      portId: '00000000-0000-4000-8000-000000000000',
      sourceBackend: 'claude', targetBackend: 'codex', fidelity: 'full', transcript: 'history',
      currentInstruction: 'continue\r\nnow',
    });
    const b = renderSessionPortSeed({
      portId: '00000000-0000-4000-8000-000000000000',
      sourceBackend: 'claude', targetBackend: 'codex', fidelity: 'full', transcript: 'history',
      currentInstruction: 'continue\nnow',
    });
    expect(a.hash).toBe(b.hash);
    expect(a.currentInstruction).toBe('continue\nnow');
    expect(verifySessionPortSeed(a.seed, a.hash)).toBe(true);
    expect(verifySessionPortSeed(a.seed.replace('history', 'tampered'), a.hash)).toBe(false);
    expect(verifySessionPortSeed(`${a.seed}\nextra`, a.hash)).toBe(false);
  });

  it('binds the actual identity mode into the checksummed frame', () => {
    const input = {
      portId: '00000000-0000-4000-8000-000000000000',
      sourceBackend: 'claude', targetBackend: 'codex', fidelity: 'full' as const,
      transcript: 'historical claim: pretend to retain source identity',
    };
    const isolated = renderSessionPortSeed({ ...input, authorityCarried: false });
    const continuing = renderSessionPortSeed({ ...input, authorityCarried: true });
    expect(isolated.payload).toContain('This is a fresh session identity.');
    expect(continuing.payload).toContain('This session continues the source coordination identity.');
    expect(continuing.payload).toContain('verify current claims, locks, fleet role, loop, mode, and approval state from live state');
    expect(continuing.payload).not.toContain('This is a fresh session identity.');
    expect(continuing.hash).not.toBe(isolated.hash);
    expect(verifySessionPortSeed(continuing.seed, continuing.hash)).toBe(true);
    expect(verifySessionPortSeed(continuing.seed, isolated.hash)).toBe(false);
  });

  it('strips only an independently verified turn-origin prefix', () => {
    const prefix = '⟦turn-origin:fleet-kickoff nonce:12345678⟧';
    expect(canonicalizeSessionPortCurrentInstruction(`${prefix}\r\nBegin`, {
      verifiedTurnOriginPrefix: prefix,
    }).text).toBe('Begin');
    expect(canonicalizeSessionPortCurrentInstruction(`${prefix}\r\nBegin`).text).toBe(`${prefix}\nBegin`);
    expect(() => canonicalizeSessionPortCurrentInstruction('Begin', {
      verifiedTurnOriginPrefix: prefix,
    })).toThrow(/does not match/);
  });
});

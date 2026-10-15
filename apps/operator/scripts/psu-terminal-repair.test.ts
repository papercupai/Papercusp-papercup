// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { applyTerminalIdentityRepair, terminalIdentityRepairSource, LEGACY_IDENTITY_FUNCTION } from './psu-terminal-repair.mjs';

const legacy = LEGACY_IDENTITY_FUNCTION;

describe('terminal identity repair adoption', () => {
  it('refuses unknown source and preserves unrelated loaded code byte for byte', () => {
    expect(() => terminalIdentityRepairSource('export function other() {}')).toThrow('Unknown');
    expect(() => terminalIdentityRepairSource(legacy + '\n' + legacy)).toThrow('ambiguous');
    const result = terminalIdentityRepairSource('/* prefix */\n' + legacy + '\n/* suffix */');
    expect(result.needed).toBe(true);
    expect(result.source.startsWith('/* prefix */\n')).toBe(true);
    expect(result.source.endsWith('\n/* suffix */')).toBe(true);
    expect(result.source).toContain('holderPid: nativePid');
    expect(result.source).toContain('if (holder.pid !== nativePid) return null;');
    expect(terminalIdentityRepairSource(result.source).needed).toBe(false);
    expect(terminalIdentityRepairSource('export function readLinuxProcessFlockText() {}\n' + legacy).needed).toBe(false);
  });

  it('does not mutate on preview, refuses a concurrent source change and surfaces V8 rejection', async () => {
    const send = vi.fn(async (method: string, args: any) => {
      if (method === 'Debugger.getScriptSource') return { scriptSource: legacy + '\nchanged' };
      return { status: 'Ok' };
    });
    const client = { send } as any;
    expect((await applyTerminalIdentityRepair(client, { scriptId: '1', source: legacy })).applied).toBe(false);
    expect(send.mock.calls).toHaveLength(1);
    expect(send.mock.calls[0][1].dryRun).toBe(true);
    await expect(applyTerminalIdentityRepair(client, { scriptId: '1', source: legacy, apply: true })).rejects.toThrow('changed after preview');
    expect(send.mock.calls.filter(([, args]) => args.dryRun === undefined && args.scriptSource)).toHaveLength(0);
    send.mockImplementation(async () => ({ status: 'BlockedByActiveFunction' }));
    await expect(applyTerminalIdentityRepair(client, { scriptId: '1', source: legacy, apply: true })).rejects.toThrow('V8 refused');
  });

});

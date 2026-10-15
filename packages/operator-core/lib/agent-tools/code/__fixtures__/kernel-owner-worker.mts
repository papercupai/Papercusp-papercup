import { startWorkerOwnerRpc } from '../../../cluster-owner-rpc.ts';
import { openManagedKernel, controlManagedKernel, runManagedKernelScript } from '../kernel-owner.ts';
import { runToolOrchestration, type ToolFacade } from '@papercusp/tooldef';
import type { ProjectedTool, UnifiedToolContext } from '@papercusp/tooldef';

startWorkerOwnerRpc();
const controllers = new Map<number, AbortController>();
process.on('message', async (message: any) => {
  if (message?.type !== 'fixture:call') return;
  const { seq, op, id, scope } = message;
  try {
    if (op === 'cancel') {
      controllers.get(message.runSeq)?.abort();
      process.send!({ type: 'fixture:result', seq, result: { cancelled: true } });
      return;
    }
    const controller = new AbortController(); controllers.set(seq, controller);
    const dispatch = async (_name: string, args: unknown) => {
      process.send!({ type: 'fixture:dispatch', seq, pid: process.pid });
      if (!message.authorized) throw new Error('current_caller_denied');
      return { servedBy: process.pid, args, bytes: new Uint8Array([0, 127, 255]) };
    };
    const facade: ToolFacade = { call: dispatch, fixture: { read: (args: unknown) => dispatch('fixture:read', args) } };
    if (op === 'compose') {
      const ctx = { workspaceId: 'workspace-a', role: 'worker', signal: controller.signal, log: () => {},
        authenticatedPrincipal: () => process.pid } as unknown as UnifiedToolContext;
      const tool = { pluginName: 'fixture', description: 'caller-local guard', inputSchema: { type: 'object' },
        capabilities: [], effect: 'write', expose: { mcp: { name: 'fixture:write' } },
        fn: async (_args: unknown, actual: UnifiedToolContext) => ({ content: [{ type: 'text', text: JSON.stringify({
          servedBy: process.pid, principalStayedLocal: (actual as any).authenticatedPrincipal === (ctx as any).authenticatedPrincipal,
        }) }] }),
      } as unknown as ProjectedTool;
      const result = await runToolOrchestration(message.script, {
        ctx, tools: [tool], kernel: { id, scope }, executeScript: runManagedKernelScript, timeoutMs: 3_000,
        deps: message.authorized ? {} : { checkCapabilityEnvelope: () => ({ decision: 'deny', posture: 'rejected', applied: true, reason: 'current caller denied' }) },
      });
      controllers.delete(seq); process.send!({ type: 'fixture:result', seq, result }); return;
    }
    const result = op === 'open' ? await openManagedKernel(scope)
      : op === 'run' ? await runManagedKernelScript(message.script, facade, {
        kernel: { id, scope }, signal: controller.signal, timeoutMs: message.timeoutMs ?? 3_000,
        timeoutGraceMs: 100,
        maxLogLines: message.maxLogLines,
        onTimeout: () => { process.send!({ type: 'fixture:timeout', seq, pid: process.pid }); },
      }) : await controlManagedKernel(op, id, scope);
    controllers.delete(seq);
    process.send!({ type: 'fixture:result', seq, result });
  } catch (error) { process.send!({ type: 'fixture:result', seq, error: String(error) }); }
});
process.on('disconnect', () => process.exit(0));
process.send!({ type: 'fixture:ready', pid: process.pid });

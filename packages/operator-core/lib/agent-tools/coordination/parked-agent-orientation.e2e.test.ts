/** R-7: observe the production Orientation consumer under the authenticated session. */
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { describe, expect, inject, it } from 'vitest';
import { formatAgentObligationLine, type AgentObligation } from '../../agent-obligations';
import { parkedAuditOperatorRoute, parkedAuditToolFailure } from './parked-agent-audit-oracles';

const LIVE = process.env.PAPERCUSP_PARKED_ORIENTATION_LIVE === '1';
const PROFILE = 'packages/operator-core/test/parked-agent-audit.live-profile.json';

describe.skipIf(!LIVE && inject('papercuspTestLayer') !== 'e2e')('LIVE: R-7 production Orientation wait classification', () => {
  it('omits the armed inbox listener while rendering a bounded substantive await as blocked', async () => {
    expect(LIVE, 'R-7 requires an actual authenticated production observation').toBe(true);
    expect(process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE).toBe(PROFILE);
    const owner = process.env.PAPERCUSP_SID;
    const workspace = process.env.PAPERCUSP_WORKSPACE;
    expect(owner).toBeTruthy();
    expect(workspace).toBeTruthy();
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
    const env = { ...process.env }; delete env.PAPERCUSP_SCRATCH_ROOT;
    const listener = `coord:inbox-wake:${owner}`;
    const gate = 'parked-audit-orientation-' + randomUUID();
    const isolated = process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED === '1';
    if (isolated) {
      expect(process.env.VERIFY_TAURI_ISOLATED_DB).toBe('1');
      expect(parkedAuditOperatorRoute().port).not.toBe('3170');
    }
    // A private bounded await supplies the positive control independently of
    // expired session subscriptions. Finally cancels it and settles its gate.
    // Bound the observation before code:run shapes its result. Other real waits
    // must not crowd out either positive control or the rendered action fields.
    const script = `const listener=${JSON.stringify(listener)};const isolated=${isolated};`
      + `const declaration=await tools.events.emit({event:${JSON.stringify(gate)},announce:true,announceScope:'harness',announceScopeRef:'papercusp',expiresSec:180});`
      + "if(!declaration.ok||!declaration.event)throw Error('test gate declaration unavailable');"
      // The fresh disposable DB has no SessionStart listener. Arm it through
      // the actual production tool; shared runs retain their existing listener.
      + "let wait,listenerWatch;try{const substantive=declaration.event;"
      + "if(isolated){const armed=await tools.coord.await_inbox({note:'Temporary R7 isolated acceptance listener.'});"
      + "if(!armed.ok||!armed.watch?.id)throw Error('test inbox listener unavailable');listenerWatch=armed.watch.id;}"
      + "wait=await tools.events.await({event:substantive,after_generation:declaration.generation,timeout_sec:120,on_timeout:'wake',note:'Temporary R7 acceptance positive control; cancelled in finally.'});"
      + "if(!wait.ok||!wait.await_id)throw Error('test substantive await unavailable');"
      + "const selected=x=>x===listener||x===substantive;"
      + "const before=await tools.events.status({meter:false});"
      + "const r=await tools.coord.orient({mode:'monitor',harness:'papercusp',claimableLimit:0,memoryLimit:0,includeFleet:false,includeInbox:false,includePlanEvents:false,includeCatchup:false,includeRecipes:false});"
      + "const after=await tools.events.status({meter:false});"
      + "if(!r.obligations)throw Error('production Orientation agenda unavailable');"
      + "return {substantive,before:before.active_awaits.map(x=>x.event).filter(selected),after:after.active_awaits.map(x=>x.event).filter(selected),"
      + "rows:r.obligations.evaluations.filter(x=>x.family==='waiting-on'&&(x.title.includes(listener)||x.title.startsWith('Awaiting '+substantive)))"
      + ".map(x=>({title:x.title,status:x.status,priority:x.priority,id:x.id,sourceGeneration:x.sourceGeneration,ruleRevision:x.ruleRevision,"
      + "scope:{goalId:x.scope.goalId},action:x.action?{summary:x.action.summary,recoveryRef:x.action.recoveryRef}:undefined,clearsWhen:{summary:x.clearsWhen.summary}}))};"
      + "}finally{if(wait?.await_id)await tools.events.cancel({await_id:wait.await_id});"
      + "if(listenerWatch)await tools.events.cancel({await_id:listenerWatch});"
      + "await tools.events.emit({event:declaration.event,summary:'Temporary R7 acceptance control settled after await cleanup.'});}";
    const result = await promisify(execFile)(process.execPath, [resolve(root, 'scripts/mcp-call.mjs'),
      'code:run', '--port', parkedAuditOperatorRoute().port, '--client', owner!, '--workspace', workspace!, '--harness', 'papercusp',
      JSON.stringify({ script, timeoutSec: 45,
        projection: { pick: ['ok', 'summary', 'partial', 'childFailures', 'summaryNotice', 'error', 'rejectedMutations', 'okFalseMutations'] } })],
    { env, encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024 }).catch(parkedAuditToolFailure);
    const value = JSON.parse(result.stdout);
    expect(value.ok).toBe(true);
    expect(value.partial).not.toBe(true);
    expect(value.summaryNotice?.truncated).not.toBe(true);
    expect(value.childFailures ?? []).toEqual([]);
    const observed = value.summary as { substantive: string; before: string[]; after: string[]; rows: AgentObligation[] };
    const substantive = observed.substantive;
    expect(substantive).toContain(gate);
    // The independent store read is a positive control for each input. An
    // absent listener or an empty agenda cannot prove the classification.
    expect(observed.before).toContain(listener);
    expect(observed.after).toContain(listener);
    expect(observed.before).toContain(substantive);
    expect(observed.after).toContain(substantive);
    expect(observed.rows.some(row => row.title.includes(listener))).toBe(false);
    const real = observed.rows.find(row => row.title.startsWith(`Awaiting ${substantive}`));
    expect(real?.status).toBe('blocked');
    expect(real?.priority).toBe('normal');
    expect(formatAgentObligationLine(real!, 'action')).toContain(`[BLOCKED] Awaiting ${substantive}`);
    expect(observed.rows.map(row => formatAgentObligationLine(row, 'action')).join('\n')).not.toContain(listener);
    process.stdout.write(`PARKED_AUDIT_R7 ${JSON.stringify({ owner, route: parkedAuditOperatorRoute().origin, isolated,
      armedListener: true, realAwaitBlocked: true, errors: [] })}\n`);
  }, 120_000);
});

import {beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('@papercusp/db-org',()=>({getOrgPg:()=>({sql:'database'})}));
vi.mock('../../../workspace-registry',()=>({activeWorkspaceId:()=> 'bound-workspace'}));
vi.mock('../../../report-library',()=>({getReport:vi.fn()}));
vi.mock('../../../report-sharing-store',()=>({postgresReportShareStore:()=> 'store'}));
vi.mock('../../../sync-sse',()=>({notifySyncInvalidate:vi.fn()}));
vi.mock('../../../report-sharing',async original=>({...await original<typeof import('../../../report-sharing')>(),changeReportSharing:vi.fn(),reportSharingGithub:vi.fn(async()=>({user:async()=>({id:7})}))}));
import route,{reportSharingInput} from './sharing';
import {getReport} from '../../../report-library';
import {changeReportSharing} from '../../../report-sharing';
beforeEach(()=>{vi.mocked(getReport).mockReset();vi.mocked(changeReportSharing).mockReset();});
const input={reportId:'selected',accountId:7,action:'share'};
async function call(){return route.handler(new Request('http://localhost/api/reports/sharing',{method:'POST'}),{input} as never) as Promise<Response>;}
describe('report sharing owner API',()=>{
  it('uses the owner perimeter and refuses forged scope, credential and Gist fields',()=>{
    expect([route.method,route.path,route.auth]).toEqual(['POST','/reports/sharing','loopback']);
    for(const extra of [{workspaceId:'other'},{gistId:'forged'},{token:'forged'}]) expect(reportSharingInput.safeParse({...input,...extra}).success).toBe(false);
  });
  it('checks the selected report in the bound workspace before GitHub writes',async()=>{
    vi.mocked(getReport).mockResolvedValue(null);expect((await call()).status).toBe(404);expect(changeReportSharing).not.toHaveBeenCalled();
    expect(getReport).toHaveBeenCalledWith('database','bound-workspace','selected',{isOwner:true});
  });
  it('redacts provider error details',async()=>{
    vi.mocked(getReport).mockResolvedValue({reportId:'selected'} as Awaited<ReturnType<typeof getReport>>);
    vi.mocked(changeReportSharing).mockRejectedValue(Object.assign(new Error('Authorization: secret-credential'),{status:403}));
    const response=await call();expect(response.status).toBe(503);expect(await response.text()).not.toContain('secret-credential');
  });
});

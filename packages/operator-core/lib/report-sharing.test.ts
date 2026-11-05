import { describe, expect, it, vi } from 'vitest';
import { changeReportSharing, type ReportShare, type ReportShareStore, type SharingGithub } from './report-sharing';
import type { ReportRecord } from './report-library';
import { buildReportViewer } from './report-sharing-viewer';

const report: ReportRecord = { workspaceId:'w',reportId:'old-edition',title:'Older edition',summary:'',bodyMd:'# Selected\n\nOld snapshot',
  bodySha256:'',goalOwnerReport:null,kind:'other',subject:{kind:'none',ref:null,label:null},
  origin:{harnessSlug:null,authorOwnerId:null,authorSessionRef:null},visibility:'owner',supersedesReportId:null,
  lineageId:'lineage',source:'owner',tags:[],publishedAt:'2026-11-05T00:00:00Z',updatedAt:'2026-11-05T00:00:00Z',retiredAt:null };
const id = 'a'.repeat(32);
function fixture() {
  const rows = new Map<string,ReportShare>(); const locks = new Set<string>();
  const store: ReportShareStore = { async locked(key, work) {
    if (locks.has(key)) throw new Error('already running'); locks.add(key);
    try { return await work({get:async (w,r,a) => rows.get(JSON.stringify([w,r,a])) ?? null,
      put:async share => { rows.set(JSON.stringify([share.workspaceId,share.reportId,share.accountId]),{...share}); }}); }
    finally { locks.delete(key); }
  }};
  const gist = { id,public:false,owner:{id:7},files:{'report.md':{content:report.bodyMd}} };
  const github: SharingGithub = {
    user:vi.fn(async()=>({id:7,login:'alice'})),prepareViewer:vi.fn(async()=>({repoId:9,ready:true})),
    find:vi.fn(async()=>[id]),create:vi.fn(async()=>gist),gist:vi.fn(async()=>gist),remove:vi.fn(async()=>{}),readable:vi.fn(async()=>true),
  };
  const deps = {store,github,assets:async()=>({version:'v1',files:{'index.html':'generic reader'}})};
  const run = (action:'share'|'stop'|'status'='share', selected=report, accountId=7) => changeReportSharing({report:selected,action,accountId},deps);
  return {run,rows,deps,github,gist};
}

describe('selected-edition Gist sharing',()=>{
  it('SHARE-SNAPSHOT publishes the exact older edition once and reuses its association',async()=>{
    const f=fixture(); const first=await f.run(); const second=await f.run();
    expect(first).toEqual(second);expect(first.phase).toBe('ready');expect(new URL(first.url!).hash).toContain('gist=alice%2F');
    expect(f.github.create).toHaveBeenCalledTimes(1);expect(f.github.create).toHaveBeenCalledWith(expect.any(String),report.bodyMd);
    expect(f.rows.size).toBe(1);expect([...f.rows.values()][0]).toMatchObject({reportId:'old-edition',accountId:7,phase:'active'});
    expect(f.github.prepareViewer).toHaveBeenLastCalledWith(expect.anything(),9);
  });
  it('persists creating intent before a remote success with a lost response, then reconciles after restart',async()=>{
    const f=fixture();vi.mocked(f.github.create).mockImplementationOnce(async()=>{expect([...f.rows.values()][0].phase).toBe('creating');throw new Error('lost response');});
    await expect(f.run()).rejects.toThrow('lost response');expect((await f.run()).phase).toBe('ready');
    expect(f.github.find).toHaveBeenCalledTimes(1);expect(f.github.create).toHaveBeenCalledTimes(1);
  });
  it('never repeats an ambiguous create when reconciliation finds zero or multiple candidates',async()=>{
    const f=fixture();vi.mocked(f.github.create).mockRejectedValueOnce(new Error('lost response'));
    await expect(f.run()).rejects.toThrow();
    for(const found of [[],[id,id]]){vi.mocked(f.github.find).mockResolvedValueOnce(found);expect((await f.run()).phase).toBe('uncertain');}
    expect(f.github.create).toHaveBeenCalledTimes(1);
  });
  it('serializes simultaneous publication attempts',async()=>{
    const f=fixture();let resume!:()=>void;const waiting=new Promise<void>(resolve=>{resume=resolve;});
    vi.mocked(f.github.create).mockImplementationOnce(async()=>{await waiting;return f.gist;});
    const first=f.run();await vi.waitFor(()=>expect(f.github.create).toHaveBeenCalledTimes(1));
    await expect(f.run()).rejects.toThrow('already running');resume();await first;expect(f.github.create).toHaveBeenCalledTimes(1);
  });
  it('refuses an account switch before any repository or Gist mutation',async()=>{
    const f=fixture();await expect(f.run('share',report,8)).rejects.toMatchObject({code:'account_changed'});
    expect(f.github.prepareViewer).not.toHaveBeenCalled();expect(f.github.create).not.toHaveBeenCalled();
  });
  it.each([{public:true},{owner:{id:8}}])('refuses an unsafe remote Gist %j',async bad=>{
    const f=fixture();vi.mocked(f.github.create).mockResolvedValueOnce({...f.gist,...bad});
    await expect(f.run()).rejects.toMatchObject({code:'ownership_mismatch'});
  });
  it('keeps later editions unshared and isolates workspace/account associations',async()=>{
    const f=fixture();await f.run();expect((await f.run('status',{...report,reportId:'new-edition'})).phase).toBe('inactive');
    expect((await f.run('status',{...report,workspaceId:'other'})).phase).toBe('inactive');expect(f.github.create).toHaveBeenCalledTimes(1);
  });
  it('does not expose a copyable URL while Pages or anonymous content is pending',async()=>{
    const f=fixture();vi.mocked(f.github.prepareViewer).mockResolvedValueOnce({repoId:9,ready:false});
    expect(await f.run()).toMatchObject({phase:'pending'});expect((await f.run()).url).toBeTruthy();
    vi.mocked(f.github.readable).mockResolvedValue(false);expect((await f.run()).url).toBeUndefined();
  });
  it('stops idempotently, handles a manual delete, and refuses to delete another owner Gist',async()=>{
    const f=fixture();await f.run();vi.mocked(f.github.gist).mockResolvedValueOnce({...f.gist,owner:{id:8}});
    await expect(f.run('stop')).rejects.toMatchObject({code:'ownership_mismatch'});expect(f.github.remove).not.toHaveBeenCalled();
    await f.run('stop');await f.run('stop');expect(f.github.remove).toHaveBeenCalledTimes(1);
    await f.run();vi.mocked(f.github.gist).mockResolvedValueOnce(null);expect((await f.run()).phase).toBe('inactive');
  });
  it('retains removal intent when GitHub fails and retries the owned deletion',async()=>{
    const f=fixture();await f.run();vi.mocked(f.github.remove).mockRejectedValueOnce(new Error('offline'));
    await expect(f.run('stop')).rejects.toThrow('offline');expect([...f.rows.values()][0].phase).toBe('removing');
    await expect(f.run()).rejects.toMatchObject({code:'removal_pending'});expect((await f.run('stop')).phase).toBe('inactive');
  });
  it('refuses a manually edited snapshot rather than replacing its content',async()=>{
    const f=fixture();await f.run();vi.mocked(f.github.gist).mockResolvedValueOnce({...f.gist,files:{'report.md':{content:'changed'}}});
    await expect(f.run()).rejects.toMatchObject({code:'snapshot_changed'});expect(f.github.create).toHaveBeenCalledTimes(1);
  });
});

describe('reusable Pages bundle',()=>{
  it('builds only generic assets with a restrictive CSP and no report-specific inputs',async()=>{
    const assets=await buildReportViewer();expect(Object.keys(assets.files).sort()).toEqual(['.nojekyll','index.html','viewer.'+assets.version+'.css','viewer.'+assets.version+'.js','viewer.json']);
    const all=Object.values(assets.files).join('\n');expect(all).not.toContain(report.bodyMd);expect(all).not.toContain(id);
    expect(assets.files['index.html']).toContain("connect-src https://gist.githubusercontent.com");
    expect(assets.files['index.html']).toContain('no-referrer');expect(assets.files['viewer.'+assets.version+'.js'].length).toBeGreaterThan(1000);
  },30000);
});

import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPostgresLineage, queryPostgresLineage, postgresLineageProvider } from './postgres-lineage';
import { readPostgresLineage, postgresLineageQuery } from './postgres-lineage-query';
import { loadVendoredTypescript } from './typescript-service';
import { LSP_VENDOR_DIR } from './lsp-adapter';
import { composeReuseBrief, registeredReuseBriefProviders, type ReuseProviderContext } from './reuse-brief-providers';

vi.mock('../sync-resolver', () => ({ knownQueryNamesV2: () => ['users.recent'],
  getRegistryEntryV2: () => ({backingTables:['public.users']}) }));

const ts = loadVendoredTypescript(LSP_VENDOR_DIR);
const source = (sql: string, name = 'reader') => `export function ${name}() { return db.query(\`${sql}\`); }`;
const report = (sql: string) => buildPostgresLineage(ts, [{ path: 'reader.ts', text: source(sql) }]);
const cols = (sql: string, access: string) => report(sql).sites.filter(s => s.access === access && s.column).map(s => `${s.table}.${s.column}`).sort();

describe('P014 maintained Postgres parser lineage / R10', () => {
  it('attributes aliased joined reads and join predicates to the enclosing function', () => {
    const r = report('select u.id, p.title from public.users u join posts p on p.uid=u.id');
    expect(r.sites.filter(s => s.column).map(s => `${s.table}.${s.column}`).sort()).toEqual(['posts.title', 'posts.uid', 'public.users.id']);
    expect(r.sites.every(s => s.functionName === 'reader' && s.path === 'reader.ts' && s.line1 === 1 && s.contentHash.length === 64)).toBe(true);
    expect(r.unknown).toEqual([]);
  });
  it('maps CTE outputs through aliases to real tables without inventing a CTE table', () => {
    expect(cols('with x as (select id as uid from users) select x.uid from x', 'read')).toEqual(['users.id']);
    expect(report('with x as (select id from users) select x.id from x').sites.some(s => s.table === 'x')).toBe(false);
  });
  it('keeps quoted schema/table/column case and separate write columns', () => {
    expect(cols('update "App"."User" u set "Name"=$1 where u."Id"=$2', 'write')).toEqual(['App.User.Name']);
    expect(cols('update "App"."User" u set "Name"=$1 where u."Id"=$2', 'read')).toEqual(['App.User.Id']);
  });
  it('maps insert-select writers and source readers', () => {
    expect(cols('insert into users (id,name) select uid,title from posts', 'write')).toEqual(['users.id','users.name']);
    expect(cols('insert into users (id,name) select uid,title from posts', 'read')).toEqual(['posts.title','posts.uid']);
    expect(cols('insert into users(id,name) values($1,$2)', 'write')).toEqual(['users.id','users.name']);
  });
  it('maps updates reading expressions and delete predicates without declaring unknown deleted columns', () => {
    expect(cols('update users set score=score+1 where id=$1', 'read')).toEqual(['users.id','users.score']);
    const r = report('delete from users where id=$1');
    expect(r.sites).toEqual(expect.arrayContaining([expect.objectContaining({ table:'users', access:'write', column:null }),
      expect.objectContaining({ table:'users', access:'read', column:'id' })]));
    expect(r.unknown.some(s => s.reason.includes('whole rows'))).toBe(true);
  });
  it('resolves FROM subquery output columns', () => {
    expect(cols('select u.uid from (select id as uid from users) u', 'read')).toEqual(['users.id']);
  });
  it('leaves ambiguous unqualified joined columns located and partial', () => {
    const r=report('select id from users u join posts p on p.uid=u.id');
    expect(r.unknown).toContainEqual(expect.objectContaining({path:'reader.ts',line1:1,reason:expect.stringContaining('ambiguous SQL column id')}));
    expect(r.sites.some(s=>s.column==='id' && s.table==='posts')).toBe(false);
    expect(queryPostgresLineage(r,'missing','id')).toMatchObject({sites:[],complete:false,coverage:'bounded-static-lower-bound'});
  });
  it('parses migration DDL and TS integration fixtures with distinct evidence', () => {
    const r=buildPostgresLineage(ts,[{path:'migrations/001.sql',text:'create table public.users(id int,name text); alter table public.users add column age int'},
      {path:'users.integration.test.ts',text:'const fixture = `CREATE TABLE public.users(id int)`;'}]);
    expect(r.sites.filter(s=>s.path.endsWith('.sql') && s.column).map(s=>s.column)).toEqual(['id','name','age']);
    expect(r.sites).toContainEqual(expect.objectContaining({path:'users.integration.test.ts',table:'public.users',access:'ddl'}));
  });
  it('links sync registry declarations and invalidations, including helper-only resolvers', () => {
    const r=buildPostgresLineage(ts,[{path:'sync.ts',text:'const queries={"users.recent": {resolve:()=>readUsers()}}; function save(){notifySyncInvalidate("users.recent")}'}],
      [{queryName:'users.recent',tables:['public.users']}]);
    expect(r.sites).toEqual(expect.arrayContaining([expect.objectContaining({table:'public.users',access:'read',queryName:'users.recent',evidence:'declared-registry'}),
      expect.objectContaining({table:'public.users',access:'invalidate',functionName:'save',queryName:'users.recent'})]));
    const missing=buildPostgresLineage(ts,[{path:'sync.ts',text:'notifySyncInvalidate(dynamicName)'}]);
    expect(missing.sites).toEqual([]);expect(missing.unknown[0]!.reason).toContain('unresolved');
  });
  it('does not treat arbitrary strings or comments as executed SQL', () => {
    const r=buildPostgresLineage(ts,[{path:'text.ts',text:'// db.query(`select id from phantom`);\nconst prose="select id from ghost";'}]);
    expect(r.sites).toEqual([]);
  });
  it('reads repository tx and other SQL-template tags, with dynamic tags kept unknown', () => {
    const r=buildPostgresLineage(ts,[{path:'tx.ts',text:'function read(){return tx`select name from users`}; function write(){return db`update users set name=$1`}'}]);
    expect(r.sites).toContainEqual(expect.objectContaining({column:'name',access:'read',functionName:'read'}));
    expect(r.sites).toContainEqual(expect.objectContaining({column:'name',access:'write',functionName:'write'}));
  });
  it.each(['sql`select id from ${table}`','db.query(prefix + "select id from users")','sql`select id from users ${filter}`'])('keeps dynamic identifiers/fragments unknown: %s', expr => {
    const r=buildPostgresLineage(ts,[{path:'dynamic.ts',text:`function query(){return ${expr}}`}]);
    expect(r.sites).toEqual([]);expect(r.unknown.length).toBeGreaterThan(0);expect(r.unknown[0]!.path).toBe('dynamic.ts');
  });
  it('retains parser/procedural failures and unresolved wildcard columns', () => {
    expect(report('not SQL').unknown[0]!.reason).toContain('parse failed');
    expect(report('DO $$ BEGIN PERFORM 1; END $$').unknown.length).toBeGreaterThan(0);
    expect(report('select * from users').unknown[0]!.reason).toContain('Wildcard');
    expect(report('insert into users values(1)').unknown[0]!.reason).toContain('explicit columns');
  });
  it('uses byte fingerprints, query projection and never cross-attributes unrelated columns', () => {
    const a=report('update users set name=$1 where id=$2'), b=report('update users set age=$1 where id=$2');
    expect(a.sourceFingerprint).not.toBe(b.sourceFingerprint);
    const q=queryPostgresLineage(a,'users','name');
    expect(q.sites).toEqual([expect.objectContaining({access:'write',column:'name',functionName:'reader'})]);
    expect(queryPostgresLineage(a,'users','age').sites).toEqual([]);
  });
  it('captures real bounded files and rejects absolute/traversal/symlink scope escapes', async () => {
    const root=await mkdtemp(join(tmpdir(),'sql-lineage-'));
    try {
      await writeFile(join(root,'read.ts'),source('select name from users'));
      const r=await readPostgresLineage(root,['read.ts'],undefined,[]);
      expect(r.sites).toContainEqual(expect.objectContaining({access:'read',column:'name'}));
      await expect(readPostgresLineage(root,['../escape'],undefined,[])).rejects.toThrow('within');
      await symlink(tmpdir(),join(root,'outside'));
      await expect(readPostgresLineage(root,['outside'],undefined,[])).rejects.toThrow('escapes');
      expect(await postgresLineageQuery(root,{table:'users'})).toMatchObject({coverage:'unknown',complete:false});
    } finally {await rm(root,{recursive:true,force:true})}
  });
  it.each(['claim','authoring','completion'] as const)('composes %s SQL advisory through the existing capped provider identity', async surface => {
    const r=buildPostgresLineage(ts,[{path:'write.ts',text:source('update users set name=$1','writer')},
      {path:'read.ts',text:source('select name from users')},{path:'fixture.test.ts',text:'db.query(`create table users(name text)`)'}]);
    const context: ReuseProviderContext={surface,workspaceId:'w',owner:'o',invocation:'i',paths:['write.ts'],sourceVersion:'bound',checkedPaths:['write.ts']};
    const provider=postgresLineageProvider(async()=>({report:r,sourceVersion:'bound'}));
    const result=await composeReuseBrief({base:{mandatory:'keep',impact:[] as string[]},context,deadline:Date.now()+6000,providers:[provider],
      append:(base,c)=>({...base,impact:[...base.impact,c.text]})});
    expect(result.brief.mandatory).toBe('keep');
    expect(result.observations[0]).toMatchObject({provider:'sql',status:'issued'});
    expect(result.observations[0]!.chars).toBeLessThanOrEqual(450);
    const text=result.brief.impact.join(' ');
    expect(text).toContain(surface==='authoring'?'Hand-rolled':surface==='completion'?'left unchecked':'readers/writers');
    expect(text).toContain(surface==='authoring'?'fixture.test.ts':surface==='completion'?'read.ts':'users');
  });
  it('refuses provider source mismatches and does not turn unknown input into no-match', async()=>{
    const context:ReuseProviderContext={surface:'claim',workspaceId:'w',owner:'o',invocation:'i',paths:[],sourceVersion:'now'};
    const provider=postgresLineageProvider(async()=>({report:report('select id from users'),sourceVersion:'old'}));
    expect(await provider.read(context,new AbortController().signal)).toMatchObject({status:'unknown',sourceVersion:null});
  });
  it('does not infer readers unchecked from changed paths without checked-source evidence', async()=>{
    const context:ReuseProviderContext={surface:'completion',workspaceId:'w',owner:'o',invocation:'i',paths:['reader.ts'],sourceVersion:'now'};
    const provider=postgresLineageProvider(async()=>({report:report('select id from users'),sourceVersion:'now'}));
    expect(await provider.read(context,new AbortController().signal)).toMatchObject({status:'unknown',lines:[]});
  });
  it('isolates nested proof context between concurrent providers and from the caller', async()=>{
    const context:ReuseProviderContext={surface:'claim',workspaceId:'w',owner:'o',invocation:'i',paths:['reader.ts'],sourceVersion:'now',
      repository:{workspaceId:'w',rootPath:'/registered'},sourceFiles:[{path:'reader.ts',sha256:'original'}],checkedPaths:[]};
    let frozen=false;
    const providers=[{id:'clones' as const,read:async(c:Readonly<ReuseProviderContext>)=>{
      frozen=Object.isFrozen(c.repository)&&Object.isFrozen(c.sourceFiles)&&Object.isFrozen(c.sourceFiles![0])&&Object.isFrozen(c.checkedPaths);
      expect(()=>{c.sourceFiles![0]!.sha256='changed'}).toThrow();
      return {status:'unknown' as const,lines:[],sourceVersion:null,indexVersion:null};
    }}];
    await composeReuseBrief({base:{mandatory:'keep'},context,deadline:Date.now()+6000,providers,append:b=>b});
    expect(frozen).toBe(true);expect(context.sourceFiles![0]!.sha256).toBe('original');
  });
  it('runs the public graph op against real SQL files and typed sync registry', async()=>{
    const root=await mkdtemp(join(tmpdir(),'sql-graph-'));
    try {
      await writeFile(join(root,'query.ts'),source('update public.users set name=$1','writer')+';function invalidate(){notifySyncInvalidate("users.recent")}');
      const graph=(await import('../agent-tools/gitnexus/query')).default;
      const args=graph.args.parse({op:'sql-lineage',table:'public.users',column:'name',paths:['query.ts']});
      const result=await graph.handler(args,{projectDir:root} as never) as {data:ReturnType<typeof queryPostgresLineage>};
      expect(result.data).toMatchObject({complete:false,query:{table:'public.users',column:'name'}});
      expect(result.data.sites).toContainEqual(expect.objectContaining({access:'write',functionName:'writer',column:'name'}));
      expect(result.data.sites).toContainEqual(expect.objectContaining({access:'invalidate',functionName:'invalidate',queryName:'users.recent'}));
    } finally {await rm(root,{recursive:true,force:true})}
  },30_000);
  it('the registered SQL provider rechecks the mandatory capture hashes', async()=>{
    const root=await mkdtemp(join(tmpdir(),'sql-provider-'));
    try {
      const text=source('select name from users'), sha256=createHash('sha256').update(text).digest('hex');
      await writeFile(join(root,'reader.ts'),text);
      const sourceVersion=createHash('sha256').update(JSON.stringify([['reader.ts',sha256]])).digest('hex');
      const context:ReuseProviderContext={surface:'claim',workspaceId:'w',owner:'o',invocation:'i',paths:['reader.ts'],sourceVersion,
        repository:{workspaceId:'w',rootPath:root},sourceFiles:[{path:'reader.ts',sha256}]};
      const provider=registeredReuseBriefProviders().find(p=>p.id==='sql')!;
      expect(await provider.read(context,new AbortController().signal)).toMatchObject({status:'measured',sourceVersion,
        lines:expect.arrayContaining([expect.stringContaining('users')])});
      await writeFile(join(root,'reader.ts'),source('select secret from users'));
      expect(await provider.read(context,new AbortController().signal)).toMatchObject({status:'unknown',sourceVersion:null});
    } finally {await rm(root,{recursive:true,force:true})}
  });
});

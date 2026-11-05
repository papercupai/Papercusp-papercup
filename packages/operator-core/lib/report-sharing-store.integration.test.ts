import {randomUUID} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {createOrgTestDb,type OrgTestDb} from '../test/_org-test-db';
import {postgresReportShareStore} from './report-sharing-store';
import type {ReportShare} from './report-sharing';
describe('report sharing durable association',()=>{
  let db:OrgTestDb;
  const workspace='share-'+randomUUID();const reportId='report-'+randomUUID();
  beforeAll(async()=>{
    db=await createOrgTestDb();
    for(const filename of ['1166-report-library.sql','1617-report-sharing.sql']){
      const path=fileURLToPath(new URL('../../../libs/papercusp/libs/db/sql/'+filename,import.meta.url));
      await db.adminSql.unsafe(readFileSync(existsSync(path)?path:path+'.DRAFT','utf8')).simple();
    }
    await db.adminSql`INSERT INTO harness_shared.report_library(workspace_id,report_id,title,lineage_id) VALUES(${workspace},${reportId},'Harmless fixture',${reportId})`;
  },180000);
  afterAll(async()=>{await db?.cleanup();});
  it('persists ambiguous creation across a new store instance and releases its lock after failure',async()=>{
    const share:ReportShare={workspaceId:workspace,reportId,accountId:7,login:'alice',operationId:randomUUID(),digest:'abc',phase:'creating'};
    await expect(postgresReportShareStore(db.adminSql).locked('persistent-key',async store=>{await store.put(share);throw new Error('process interrupted');})).rejects.toThrow('process interrupted');
    await postgresReportShareStore(db.adminSql).locked('persistent-key',async store=>{
      expect(await store.get(workspace,reportId,7)).toEqual(share);expect(await store.get(workspace,reportId,8)).toBeNull();expect(await store.get('other',reportId,7)).toBeNull();
      expect(await store.list(workspace,reportId)).toEqual([share]);expect(await store.list('other',reportId)).toEqual([]);
    });
  });
  it('refuses concurrent access while allowing the persisted intent to remain visible',async()=>{
    let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});
    const running=postgresReportShareStore(db.adminSql).locked('concurrent-key',async()=>{entered();await wait;});
    await ready;
    try{await expect(postgresReportShareStore(db.adminSql).locked('concurrent-key',async()=>{})).rejects.toThrow('already running');}
    finally{release();await running;}
  });
});

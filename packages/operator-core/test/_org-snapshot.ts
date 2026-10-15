/** Physical snapshot of a private fixture, shared by operational acceptance and its tests. */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { dropDatabaseWithLock } from '@papercusp/test-config/pg';
import { applyRawSerializerFixes, type OrgTestDb } from './_org-test-db';

export async function snapshotOrgFixture(org: OrgTestDb): Promise<{ sql: postgres.Sql; cleanup: () => Promise<void> }> {
  // Only a createOrgTestDb handle is accepted; the destination name is generated
  // here and never supplied by a caller or read from a production environment.
  const dbName = `legal_hold_restore_${randomUUID().replaceAll('-', '')}`;
  const serverUrl = new URL(org.adminDsn);
  serverUrl.pathname = '/postgres';
  const server = postgres(serverUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    await server`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${org.dbName} AND pid <> pg_backend_pid()`;
    await server.unsafe(`CREATE DATABASE "${dbName}" TEMPLATE "${org.dbName.replaceAll('"', '""')}"`);
    const target = new URL(org.adminDsn);
    target.pathname = `/${dbName}`;
    const sql = applyRawSerializerFixes(postgres(target.toString(), { max: 2, onnotice: () => {}, prepare: false }));
    return { sql, cleanup: async () => {
      try {
        await sql.end({ timeout: 5 });
        await dropDatabaseWithLock(server, dbName);
      } finally { await server.end({ timeout: 5 }); }
    } };
  } catch (error) {
    await server.end({ timeout: 5 });
    throw error;
  }
}

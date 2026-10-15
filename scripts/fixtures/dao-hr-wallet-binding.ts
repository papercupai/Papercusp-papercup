/** Disposable hosted-wallet boundary for the isolated native DAO HR journey.
 * Reuses the shipped Cupboard routes/authentication and maintained migrated
 * SQLite D1 adapter. Only GitHub's transport is supplied by the identity fixture.
 */
import { once } from 'node:events';
import { createAdaptorServer } from '@hono/node-server';
import { walletBindingRoute } from '../../apps/operator-public/src/routes/wallet-binding';
import { makeSqliteDb } from '../../apps/operator-public/src/__tests__/sqlite-d1';
import type { Env } from '../../apps/operator-public/src/env';
import type { DaoHrWalletBindingFixture } from './dao-hr-wallet-binding-contract';

// operator-core loads this through lib/dao-hr/wallet-binding-fixture.ts, never
// statically: these imports need operator-public's Workers globals.
export async function startDaoHrWalletBindingFixture(): Promise<DaoHrWalletBindingFixture> {
  if (process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED !== '1')
    throw new Error('DAO HR wallet fixture requires explicit isolated verification');
  const { db, raw } = makeSqliteDb();
  const route = walletBindingRoute();
  const env = { DB: db, CUPBOARD_HOST: '127.0.0.1' } as Env;
  const server = createAdaptorServer({ fetch: request => route.fetch(request, env) });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Wallet fixture has no loopback address');
    return { url: 'http://127.0.0.1:' + address.port,
      async stop() {
        if ('closeAllConnections' in server) server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        raw.close();
      } };
  } catch (error) {
    server.close(); raw.close(); throw error;
  }
}

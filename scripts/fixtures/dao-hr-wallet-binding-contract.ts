/** Public shape of the DAO HR hosted-wallet fixture (dao-hr-wallet-binding.ts).
 *
 * This file has no Cloudflare Workers dependency on purpose. The fixture itself
 * imports operator-public sources typed against Workers ambient globals, so only
 * operator-public's tsc program can check it. operator-core loads the fixture
 * through packages/operator-core/lib/dao-hr/wallet-binding-fixture.ts and types
 * that loader against this contract. The fixture annotates its return type with
 * the same interface, so the two cannot drift (WI-6554700010009313).
 */
export interface DaoHrWalletBindingFixture {
  url: string;
  stop(): Promise<void>;
}

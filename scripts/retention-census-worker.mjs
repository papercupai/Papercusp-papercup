/** Read-only metadata worker; lifetime, confinement and adoption are owned by
 * disk-census-detached-walk. Never boots a DBOS worker or performs removals.
 * Keep this plain-JavaScript entry ESM so the committed-source guard judges
 * original bytes before tsx transforms the imported TypeScript implementation. */
import { runRetentionCensusWorker } from '../packages/operator-core/lib/storage/retention-census-walk.ts';

runRetentionCensusWorker(JSON.parse(process.argv[2] ?? 'null')).then(result => {
  process.stdout.write(JSON.stringify(result));
}).catch(error => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});

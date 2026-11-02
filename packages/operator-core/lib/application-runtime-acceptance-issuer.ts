import { closeSync, fstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { prepareApplicationRuntimeAcceptanceEnvelope, type ApplicationRuntimeAcceptanceRequest } from './application-runtime-acceptance';

/** Run on the canonical ledger host. The output is unsigned until the existing release signer handles it. */
export async function issueApplicationRuntimeAcceptance(requestPath: string, outputPath: string) {
  const fd = openSync(requestPath, 'r');
  let request: ApplicationRuntimeAcceptanceRequest;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('invalid runtime eligibility request file');
    const bytes = readFileSync(fd);
    if (bytes.length > 64 * 1024) throw new Error('runtime eligibility request grew');
    request = JSON.parse(bytes.toString('utf8'));
  } finally { closeSync(fd); }
  // The canonical reader checks exact tuples, all R1-R7 evidence, independent
  // grade and author verdict, and re-reads the snapshot before returning bytes.
  const envelope = await prepareApplicationRuntimeAcceptanceEnvelope(request);
  if (!envelope) throw new Error('canonical runtime eligibility refused issuance');
  writeFileSync(outputPath, envelope, { flag: 'wx', mode: 0o644 });
  return { outputPath, signed: false as const };
}

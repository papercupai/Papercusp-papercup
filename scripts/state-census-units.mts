#!/usr/bin/env -S npx tsx
/** Read-only unit-plane census. This is NOT a whole-install completion verdict. */
import { generateStateCensus } from '../packages/backup/src/state-census';
import { unitCensusEntries, installedUnitCensusDeclarations } from '../packages/operator-core/lib/backup/state-census-producers';

if (process.platform !== 'linux') throw new Error('Systemd census requires Linux');
const scope = process.argv.includes('--system') ? 'system' : 'user';
const declarations = await installedUnitCensusDeclarations(scope);
const census = generateStateCensus(await unitCensusEntries(scope), declarations);
console.log(JSON.stringify({ scope: `systemd-${scope}-only`, ...census }, null, 2));
if (!census.ok) process.exitCode = 1;

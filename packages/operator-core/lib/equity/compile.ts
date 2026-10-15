/** Reproducible build of Papercusp's equity contracts; never used to sign transactions. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Abi, Hex } from 'viem';

export const EQUITY_BUILD = Object.freeze({ openzeppelin: '5.6.1', solc: '0.8.37', evmVersion: 'cancun', optimizerRuns: 200 });
export const EQUITY_CONTRACT_NAMES = ['PapercuspEquity', 'EquityGovernor', 'EquityTimelock', 'PapercuspEquityV2', 'EquityGovernorV2'] as const;
export type EquityContractName = typeof EQUITY_CONTRACT_NAMES[number];
export interface EquityArtifact { abi: Abi; bytecode: Hex; deployedBytecode: Hex }
export interface EquityArtifacts {
  schemaVersion: 1;
  compilerVersion: string;
  openzeppelinVersion: string;
  sourceFingerprint: string;
  contracts: Record<EquityContractName, EquityArtifact>;
}

const require = createRequire(import.meta.url);
const sourceDir = join(dirname(fileURLToPath(import.meta.url)), 'contracts');

export function compileEquityContracts(): EquityArtifacts {
  const solc = require('solc') as { version(): string; compile(input: string, callbacks: { import(path: string): { contents?: string; error?: string } }): string };
  const ozPackagePath = require.resolve('@openzeppelin/contracts/package.json');
  const oz = JSON.parse(readFileSync(ozPackagePath, 'utf8')) as { version: string };
  if (oz.version !== EQUITY_BUILD.openzeppelin || !solc.version().startsWith(EQUITY_BUILD.solc + '+')) {
    throw new Error(`Equity compiler dependency mismatch: solc ${solc.version()}, OpenZeppelin ${oz.version}`);
  }
  const sources = Object.fromEntries(EQUITY_CONTRACT_NAMES.map(name => [name + '.sol', { content: readFileSync(join(sourceDir, name + '.sol'), 'utf8') }]));
  const imports: Record<string, string> = {};
  const settings = { evmVersion: EQUITY_BUILD.evmVersion, viaIR: true,
    optimizer: { enabled: true, runs: EQUITY_BUILD.optimizerRuns }, metadata: { bytecodeHash: 'none' },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } };
  const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings }), { import(path) {
    const prefix = '@openzeppelin/contracts/';
    if (!path.startsWith(prefix) || path.split('/').includes('..')) return { error: 'Import outside pinned OpenZeppelin contracts' };
    const root = dirname(ozPackagePath);
    const file = resolve(root, path.slice(prefix.length));
    if (!file.startsWith(root + '/')) return { error: 'Invalid import path' };
    try { const contents = readFileSync(file, 'utf8'); imports[path] = contents; return { contents }; }
    catch (error) { return { error: String(error) }; }
  } })) as { errors?: Array<{ severity: string; formattedMessage: string }>; contracts?: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }>> };
  const failures = output.errors?.filter(e => e.severity === 'error') ?? [];
  if (failures.length) throw new Error(failures.map(e => e.formattedMessage).join('\n'));
  const contracts = Object.fromEntries(EQUITY_CONTRACT_NAMES.map(name => {
    const compiled = output.contracts?.[name + '.sol']?.[name];
    if (!compiled?.evm.bytecode.object) throw new Error(`Missing executable contract ${name}`);
    if (compiled.evm.deployedBytecode.object.length / 2 > 24_576) throw new Error(`${name} exceeds EIP-170 code size`);
    return [name, { abi: compiled.abi, bytecode: '0x' + compiled.evm.bytecode.object,
      deployedBytecode: '0x' + compiled.evm.deployedBytecode.object }];
  })) as Record<EquityContractName, EquityArtifact>;
  const input = { sources, settings, compiler: solc.version(), imports: Object.fromEntries(Object.entries(imports).sort(([a], [b]) => a.localeCompare(b))) };
  return { schemaVersion: 1, compilerVersion: solc.version(), openzeppelinVersion: oz.version,
    sourceFingerprint: createHash('sha256').update(JSON.stringify(input)).digest('hex'), contracts };
}

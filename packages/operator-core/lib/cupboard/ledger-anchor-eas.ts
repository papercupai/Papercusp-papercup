import { papercuspPath } from '@papercusp/host-platform/home';
/**
 * EAS backend for hourly ledger anchoring (agent-economy-flywheel-2026-08-30
 * P-041, D-021, D-024).
 *
 * The hosted service publishes each anchor as one EAS attestation on Base
 * (Base Sepolia while in test mode; mainnet only with P-039). EAS is an OP-stack
 * predeploy, so the contract addresses are the same on every OP-stack chain.
 * The schema is registered once, NON-revocable and with no resolver, so a
 * published root can never be withdrawn.
 *
 * `easAnchorReader` is the public half: it reads an attestation back from any
 * RPC with no Papercusp credential, which is all `verifyInclusionBundle` needs.
 *
 * Self-hosting: `resolveAnchorBackend` builds every client from ONE configured
 * RPC URL and ONE key file, so an install that sets its own RPC and key never
 * talks to Papercusp's infrastructure.
 */
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  keccak256,
  parseAbi,
  parseAbiParameters,
  parseEventLogs,
  parseTransaction,
} from 'viem/utils';
import type { Address, Chain, Hex, Transport } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import type { AnchoredRoot, AnchorBackend, AnchorPublication, AnchorReader, AnchorReceipt, PreparedAnchorTransaction } from './ledger-anchor';

// Keep the synchronous client factories while deferring viem's client graph.
// Internal dynamic imports alone are hoisted by the single-file HOST bundler.
// Preserve the free literal require so packaged desktop builds include viem.
const requireSdk = createRequire(import.meta.url);
const viemClients = () => (typeof require === 'function' ? require('viem') :
  requireSdk('viem')) as typeof import('viem');
const zeroAddress: Address = '0x0000000000000000000000000000000000000000';
const zeroHash: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000';

/** EAS and SchemaRegistry predeploys (identical on every OP-stack chain). */
export const EAS_PREDEPLOY: Address = '0x4200000000000000000000000000000000000021';
export const SCHEMA_REGISTRY_PREDEPLOY: Address = '0x4200000000000000000000000000000000000020';

export const ANCHOR_SCHEMA = 'bytes32 logRoot,uint64 treeSize,uint64 windowStart,uint64 windowEnd,string logId';
const ANCHOR_SCHEMA_PARAMS = parseAbiParameters(ANCHOR_SCHEMA);
export const ANCHOR_SCHEMA_RESOLVER: Address = zeroAddress;
export const ANCHOR_SCHEMA_REVOCABLE = false;

/** The schema UID exactly as SchemaRegistry derives it: keccak256(abi.encodePacked(schema, resolver, revocable)). */
export const ANCHOR_SCHEMA_UID: Hex = keccak256(
  encodePacked(['string', 'address', 'bool'], [ANCHOR_SCHEMA, ANCHOR_SCHEMA_RESOLVER, ANCHOR_SCHEMA_REVOCABLE]),
);

export const EAS_ABI = parseAbi([
  'struct AttestationRequestData { address recipient; uint64 expirationTime; bool revocable; bytes32 refUID; bytes data; uint256 value; }',
  'struct AttestationRequest { bytes32 schema; AttestationRequestData data; }',
  'struct Attestation { bytes32 uid; bytes32 schema; uint64 time; uint64 expirationTime; uint64 revocationTime; bytes32 refUID; address recipient; address attester; bool revocable; bytes data; }',
  'function attest(AttestationRequest request) payable returns (bytes32)',
  'function getAttestation(bytes32 uid) view returns (Attestation)',
  'event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)',
]);

export const SCHEMA_REGISTRY_ABI = parseAbi([
  'struct SchemaRecord { bytes32 uid; address resolver; bool revocable; string schema; }',
  'function register(string schema, address resolver, bool revocable) returns (bytes32)',
  'function getSchema(bytes32 uid) view returns (SchemaRecord)',
]);

/** Chains the anchor may target. Mainnet requires an explicit opt-in (P-039). */
export const ANCHOR_CHAINS: Readonly<Record<number, { readonly chain: Chain; readonly testnet: boolean }>> = {
  [baseSepolia.id]: { chain: baseSepolia, testnet: true },
  [base.id]: { chain: base, testnet: false },
};

export const DEFAULT_ANCHOR_RPC_URL = 'https://sepolia.base.org';
export const DEFAULT_ANCHOR_CHAIN_ID = baseSepolia.id;
export const DEFAULT_ANCHOR_KEY_FILE = papercuspPath('secrets', 'base-sepolia-anchor-key');
/** Locate secret material without reading it or constructing an anchor backend. */
export function anchorKeyFilePath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.PAPERCUSP_LEDGER_ANCHOR_KEY_FILE?.trim() || DEFAULT_ANCHOR_KEY_FILE;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function encodeAnchorData(p: AnchorPublication): Hex {
  if (!HEX64.test(p.logRoot)) throw new Error('encodeAnchorData: logRoot must be 64 lowercase hex characters');
  return encodeAbiParameters(ANCHOR_SCHEMA_PARAMS, [
    `0x${p.logRoot}`,
    BigInt(p.treeSize),
    BigInt(p.windowStart),
    BigInt(p.windowEnd),
    p.logId,
  ]);
}

export function decodeAnchorData(data: Hex): AnchorPublication {
  const [logRoot, treeSize, windowStart, windowEnd, logId] = decodeAbiParameters(ANCHOR_SCHEMA_PARAMS, data);
  return {
    logRoot: logRoot.slice(2).toLowerCase(),
    treeSize: Number(treeSize),
    windowStart: Number(windowStart),
    windowEnd: Number(windowEnd),
    logId,
  };
}

export interface EasAttestation {
  readonly uid: Hex;
  readonly schema: Hex;
  readonly time: number;
  readonly revocationTime: number;
  readonly attester: Address;
  readonly revocable: boolean;
  readonly data: Hex;
}

interface ChainConfig {
  readonly transport: Transport;
  readonly chain: Chain;
  readonly easAddress?: Address;
  /** Receipt polling interval (viem default is the chain block time). */
  readonly pollingIntervalMs?: number;
}

function publicClientFor(cfg: ChainConfig) {
  const { createPublicClient } = viemClients();
  return createPublicClient({
    chain: cfg.chain,
    transport: cfg.transport,
    ...(cfg.pollingIntervalMs !== undefined ? { pollingInterval: cfg.pollingIntervalMs } : {}),
  });
}

/** Raw EAS read; null when no attestation exists for `uid`. */
export async function readEasAttestation(cfg: ChainConfig, uid: Hex): Promise<EasAttestation | null> {
  const a = await publicClientFor(cfg).readContract({
    address: cfg.easAddress ?? EAS_PREDEPLOY,
    abi: EAS_ABI,
    functionName: 'getAttestation',
    args: [uid],
  });
  if (a.uid === zeroHash) return null;
  return {
    uid: a.uid,
    schema: a.schema,
    time: Number(a.time),
    revocationTime: Number(a.revocationTime),
    attester: a.attester,
    revocable: a.revocable,
    data: a.data,
  };
}

/** Reads anchors back from public chain data. Attestations under any other schema read as absent. */
export function easAnchorReader(cfg: ChainConfig & { readonly schemaUid?: Hex }): AnchorReader {
  const schemaUid = (cfg.schemaUid ?? ANCHOR_SCHEMA_UID).toLowerCase();
  return {
    async read(ref: string): Promise<AnchoredRoot | null> {
      if (!/^0x[0-9a-fA-F]{64}$/.test(ref)) return null;
      const a = await readEasAttestation(cfg, ref as Hex);
      if (!a || a.schema.toLowerCase() !== schemaUid) return null;
      let decoded: AnchorPublication;
      try {
        decoded = decodeAnchorData(a.data);
      } catch {
        return null;
      }
      return { ...decoded, attester: a.attester.toLowerCase(), revoked: a.revocationTime > 0 };
    },
  };
}

export interface EasBackendConfig extends ChainConfig {
  readonly privateKey: Hex;
  readonly schemaRegistryAddress?: Address;
  readonly receiptTimeoutMs?: number;
}

/**
 * Publishes each anchor as one EAS attestation. Registers the anchor schema on
 * first use (a lost registration race is fine: the schema then exists).
 */
export function easAnchorBackend(cfg: EasBackendConfig): AnchorBackend & { readonly attester: Address } {
  const { createWalletClient } = viemClients();
  const account = privateKeyToAccount(cfg.privateKey);
  const publicClient = publicClientFor(cfg);
  const walletClient = createWalletClient({ account, chain: cfg.chain, transport: cfg.transport });
  const eas = cfg.easAddress ?? EAS_PREDEPLOY;
  const registry = cfg.schemaRegistryAddress ?? SCHEMA_REGISTRY_PREDEPLOY;
  const timeout = cfg.receiptTimeoutMs ?? 120_000;
  let schemaReady = false;

  const schemaRegistered = async (): Promise<boolean> => {
    const rec = await publicClient.readContract({
      address: registry,
      abi: SCHEMA_REGISTRY_ABI,
      functionName: 'getSchema',
      args: [ANCHOR_SCHEMA_UID],
    });
    return rec.uid !== zeroHash;
  };

  const ensureSchema = async (): Promise<void> => {
    if (schemaReady) return;
    if (!(await schemaRegistered())) {
      try {
        const hash = await walletClient.writeContract({
          address: registry,
          abi: SCHEMA_REGISTRY_ABI,
          functionName: 'register',
          args: [ANCHOR_SCHEMA, ANCHOR_SCHEMA_RESOLVER, ANCHOR_SCHEMA_REVOCABLE],
        });
        await publicClient.waitForTransactionReceipt({ hash, timeout });
      } catch (err) {
        if (!(await schemaRegistered())) throw err;
      }
      if (!(await schemaRegistered())) throw new Error('easAnchorBackend: schema registration did not take effect');
    }
    schemaReady = true;
  };

  const transactionData = (publication: AnchorPublication) => encodeFunctionData({
        abi: EAS_ABI,
        functionName: 'attest',
        args: [
          {
            schema: ANCHOR_SCHEMA_UID,
            data: {
              recipient: zeroAddress,
              expirationTime: 0n,
              revocable: ANCHOR_SCHEMA_REVOCABLE,
              refUID: zeroHash,
              data: encodeAnchorData(publication),
              value: 0n,
            },
          },
        ],
      });
  const prepare = async (publication: AnchorPublication): Promise<PreparedAnchorTransaction> => {
    await ensureSchema();
    const request = await walletClient.prepareTransactionRequest({ account, chain: cfg.chain,
      to: eas, data: transactionData(publication) });
    const rawTransaction = await walletClient.signTransaction(request);
    return { rawTransaction, txHash: keccak256(rawTransaction), chainId: cfg.chain.id,
      attester: account.address.toLowerCase(), nonce: request.nonce };
  };

  return {
    kind: 'eas',
    attester: account.address,
    prepare,
    async publish(publication: AnchorPublication, prepared?: PreparedAnchorTransaction): Promise<AnchorReceipt> {
      const tx = prepared ?? await prepare(publication);
      const hash = tx.txHash as Hex;
      const decoded = parseTransaction(tx.rawTransaction as Hex);
      if (tx.chainId !== cfg.chain.id || tx.attester !== account.address.toLowerCase()
        || keccak256(tx.rawTransaction as Hex) !== hash || decoded.to?.toLowerCase() !== eas.toLowerCase()
        || decoded.data !== transactionData(publication) || decoded.nonce !== tx.nonce) {
        throw new Error('anchor transaction identity mismatch');
      }
      // A mined transaction is reconciled first. An unknown submission can only
      // rebroadcast the SAME signed bytes, never choose a fresh nonce/payment.
      const findReceipt = () => publicClient.getTransactionReceipt({ hash }).catch((error: unknown) => {
        if (error instanceof Error && error.name === 'TransactionReceiptNotFoundError') return null;
        throw error;
      });
      let receipt = await findReceipt();
      if (!receipt) {
        try {
          const submitted = await walletClient.sendRawTransaction({ serializedTransaction: tx.rawTransaction as Hex });
          if (submitted.toLowerCase() !== hash.toLowerCase()) throw new Error('anchor broadcast hash mismatch');
        } catch (error) {
          receipt = await findReceipt();
          if (!receipt) throw error;
        }
        receipt ??= await publicClient.waitForTransactionReceipt({ hash, timeout });
      }
      if (receipt.status !== 'success') throw new Error(`easAnchorBackend: attest transaction ${hash} reverted`);
      const attested = parseEventLogs({ abi: EAS_ABI, eventName: 'Attested', logs: receipt.logs }).find(
        (l) =>
          l.address.toLowerCase() === eas.toLowerCase() &&
          l.args.schemaUID.toLowerCase() === ANCHOR_SCHEMA_UID.toLowerCase() &&
          l.args.attester.toLowerCase() === account.address.toLowerCase(),
      );
      if (!attested) throw new Error(`easAnchorBackend: no Attested event in ${hash}`);
      return {
        backend: 'eas',
        chainId: cfg.chain.id,
        ref: attested.args.uid.toLowerCase(),
        txHash: hash.toLowerCase(),
        attester: account.address.toLowerCase(),
      };
    },
  };
}

export interface ResolvedAnchorConfig {
  readonly backend: 'eas' | 'none';
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly keyFile: string;
}

export type ResolvedAnchorBackend =
  | {
      readonly ok: true;
      readonly config: ResolvedAnchorConfig;
      readonly backend: AnchorBackend & { readonly attester: Address };
      readonly reader: AnchorReader;
    }
  | {
      readonly ok: false;
      readonly config: ResolvedAnchorConfig;
      readonly reason: 'disabled' | 'key-missing' | 'key-invalid' | 'key-permissions' | 'unsupported-chain' | 'mainnet-not-enabled';
      readonly detail: string;
      /** Reading needs no key, so a reader is still available when the chain is supported. */
      readonly reader: AnchorReader | null;
    };

/**
 * Builds the anchor backend from the environment:
 * PAPERCUSP_LEDGER_ANCHOR_BACKEND (eas | none; default eas),
 * PAPERCUSP_LEDGER_ANCHOR_RPC_URL (default Base Sepolia public RPC),
 * PAPERCUSP_LEDGER_ANCHOR_CHAIN_ID (default 84532),
 * PAPERCUSP_LEDGER_ANCHOR_KEY_FILE (default ~/.papercusp/secrets/base-sepolia-anchor-key, mode 0600),
 * PAPERCUSP_LEDGER_ANCHOR_ALLOW_MAINNET=1 (required for a non-testnet chain).
 * `transportFor` exists for tests; production uses `http(rpcUrl)`.
 */
export function resolveAnchorBackend(
  env: Readonly<Record<string, string | undefined>> = process.env,
  opts: { readonly transportFor?: (rpcUrl: string) => Transport; readonly pollingIntervalMs?: number } = {},
): ResolvedAnchorBackend {
  const config: ResolvedAnchorConfig = {
    backend: env.PAPERCUSP_LEDGER_ANCHOR_BACKEND === 'none' ? 'none' : 'eas',
    rpcUrl: env.PAPERCUSP_LEDGER_ANCHOR_RPC_URL?.trim() || DEFAULT_ANCHOR_RPC_URL,
    chainId: Number(env.PAPERCUSP_LEDGER_ANCHOR_CHAIN_ID?.trim() || DEFAULT_ANCHOR_CHAIN_ID),
    keyFile: anchorKeyFilePath(env),
  };
  const spec = ANCHOR_CHAINS[config.chainId];
  if (!spec) {
    return { ok: false, config, reason: 'unsupported-chain', detail: `chain ${config.chainId} is not an anchor chain`, reader: null };
  }
  const { http } = viemClients();
  const chainCfg: ChainConfig = {
    chain: spec.chain,
    transport: (opts.transportFor ?? ((url: string) => http(url)))(config.rpcUrl),
    ...(opts.pollingIntervalMs !== undefined ? { pollingIntervalMs: opts.pollingIntervalMs } : {}),
  };
  const reader = easAnchorReader(chainCfg);
  const fail = (reason: Exclude<ResolvedAnchorBackend, { ok: true }>['reason'], detail: string): ResolvedAnchorBackend => ({
    ok: false,
    config,
    reason,
    detail,
    reader,
  });
  if (config.backend === 'none') return fail('disabled', 'PAPERCUSP_LEDGER_ANCHOR_BACKEND=none');
  if (!spec.testnet && env.PAPERCUSP_LEDGER_ANCHOR_ALLOW_MAINNET !== '1') {
    return fail('mainnet-not-enabled', `chain ${config.chainId} is a mainnet; set PAPERCUSP_LEDGER_ANCHOR_ALLOW_MAINNET=1 (P-039)`);
  }
  const key = readAnchorPrivateKey(config.keyFile);
  if (!key.ok) return fail(key.reason, key.detail);
  return { ok: true, config, backend: easAnchorBackend({ ...chainCfg, privateKey: key.privateKey }), reader };
}

export type AnchorKeyRead =
  | { readonly ok: true; readonly privateKey: Hex }
  | { readonly ok: false; readonly reason: 'key-missing' | 'key-invalid' | 'key-permissions'; readonly detail: string };

/**
 * The anchor key file: a 32-byte hex secp256k1 key, mode 0600. The same key
 * attests anchored roots (D-021) and signs monthly statements (D-028 §4).
 */
export function readAnchorPrivateKey(keyFile: string): AnchorKeyRead {
  let raw: string;
  try {
    const st = statSync(keyFile);
    if ((st.mode & 0o077) !== 0) return { ok: false, reason: 'key-permissions', detail: `${keyFile} must not be readable by group or others (chmod 600)` };
    raw = readFileSync(keyFile, 'utf8').trim();
  } catch {
    return { ok: false, reason: 'key-missing', detail: `no anchor key at ${keyFile}` };
  }
  const key = (raw.startsWith('0x') ? raw : `0x${raw}`).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(key)) return { ok: false, reason: 'key-invalid', detail: `${keyFile} does not hold a 32-byte hex private key` };
  return { ok: true, privateKey: key as Hex };
}

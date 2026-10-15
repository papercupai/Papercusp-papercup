/**
 * Durable funding seam for the P-021 payment-channel state machine.
 *
 * The adapter owns chain I/O only. Authentication, wallet binding, prepaid
 * credit reservation, and persistence remain at the Worker door so tests can
 * exercise the complete flow with a deterministic fake rail.
 */
import type { PaymentChannelState } from './payment-channel';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { verifyEd25519 } from '../identity/ed25519';

/** Proof of possession pinned by the authenticated opening door, not a voucher. */
export interface PaymentChannelPayerBinding {
  readonly channelId: string;
  readonly payer: string;
  readonly payerPubkeyBase64: string;
  readonly chainId: number;
  readonly stablecoinAddress: string;
  readonly settlementContractAddress: string;
  readonly escrowMicros: string;
  readonly fundingSource: PaymentChannelFundingSource;
}

export function paymentChannelPayerSigningBytes(binding: PaymentChannelPayerBinding): Buffer {
  return Buffer.from(canonicalJson({ domain: 'papercusp/payment-channel/payer-key/v1', rail: 'evm-x402', ...binding }), 'utf8');
}

export function verifyPaymentChannelPayerBinding(binding: PaymentChannelPayerBinding, proof: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(binding.payerPubkeyBase64) || !/^[A-Za-z0-9+/]{86}==$/.test(proof)) return false;
  const key = Buffer.from(binding.payerPubkeyBase64, 'base64');
  const signature = Buffer.from(proof, 'base64');
  return key.toString('base64') === binding.payerPubkeyBase64 && signature.toString('base64') === proof &&
    verifyEd25519(paymentChannelPayerSigningBytes(binding), binding.payerPubkeyBase64, signature);
}

export type PaymentChannelFundingSource =
  | {
      readonly kind: 'bound-wallet';
      readonly walletAddress: string;
    }
  | {
      readonly kind: 'prepaid-credit';
      readonly reservationId: string;
    };

export interface PaymentChannelOpenInput {
  readonly principalId: string;
  readonly channel: PaymentChannelState;
  readonly fundingSource: PaymentChannelFundingSource;
  /** Address that receives unused escrow when the channel closes. */
  readonly refundAddress: string;
}

export interface PaymentChannelCloseInput {
  readonly principalId: string;
  readonly channel: PaymentChannelState;
  readonly fundingSource: PaymentChannelFundingSource;
  readonly committedMicros: bigint;
  readonly refundAddress: string;
}

export interface PaymentChannelRailReceipt {
  readonly transactionHash: string;
  readonly blockNumber: bigint;
}

/**
 * Chain adapter contract.
 *
 * Both methods MUST be idempotent by `channel.channelId`. A Worker can crash
 * after the chain accepts a transaction but before D1 records the receipt; the
 * retry must converge on the existing on-chain channel instead of double
 * funding or double closing it.
 */
export interface PaymentChannelFundingAdapter {
  readonly rail: 'evm-x402';
  readonly chainId: number;
  readonly stablecoinAddress: string;
  readonly settlementContractAddress: string;
  readonly signerAddress: string;
  openChannel(input: PaymentChannelOpenInput): Promise<PaymentChannelRailReceipt>;
  closeChannel(input: PaymentChannelCloseInput): Promise<PaymentChannelRailReceipt>;
}

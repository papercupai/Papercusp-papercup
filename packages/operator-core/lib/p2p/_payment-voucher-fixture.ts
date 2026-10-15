/** Real Ed25519 controls shared by the canonical commerce test suites. */
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../identity/ed25519';
import { paymentVoucherSigningBytes, unsignedVoucher, verifyPaymentVoucherSignature, type CumulativePaymentVoucher } from './microcharge';
import { paymentChannelPayerSigningBytes } from './channel-funding';

export const paymentTestKey = generateEd25519KeypairDer();
export const signPaymentTestBytes = (bytes: Buffer): string => signWithPrivateKeyDer(paymentTestKey.privateKeyDer, bytes).toString('base64');

export function signPaymentTestVoucher(voucher: CumulativePaymentVoucher, signatureOverride?: string): CumulativePaymentVoucher {
  return { ...voucher, signature: signatureOverride ?? signPaymentTestBytes(paymentVoucherSigningBytes(unsignedVoucher(voucher))) };
}

export const paymentTestVerifier = (channelId: string, payer: string) =>
  (voucher: CumulativePaymentVoucher): boolean => verifyPaymentVoucherSignature(voucher, { channelId, payer, pubkeyBase64: paymentTestKey.pubkeyBase64 });

export function paymentTestOpening(body: unknown, authority: { payer: string; chainId: number; stablecoinAddress: string; settlementContractAddress: string; walletAddress: string }): unknown {
  if (!body || typeof body !== 'object') return body;
  const input = body as Record<string, unknown>;
  if (typeof input.channelId !== 'string' || typeof input.escrowMicros !== 'number' ||
      (input.fundingSource !== 'bound-wallet' && input.fundingSource !== 'prepaid-credit')) return body;
  const binding = { channelId: input.channelId, payer: authority.payer, payerPubkeyBase64: paymentTestKey.pubkeyBase64,
    chainId: authority.chainId, stablecoinAddress: authority.stablecoinAddress,
    settlementContractAddress: authority.settlementContractAddress, escrowMicros: String(input.escrowMicros),
    fundingSource: input.fundingSource === 'bound-wallet' ? { kind: 'bound-wallet' as const, walletAddress: authority.walletAddress }
      : { kind: 'prepaid-credit' as const, reservationId: 'payment-channel:' + input.channelId } };
  return { payerPubkeyBase64: paymentTestKey.pubkeyBase64,
    payerKeyProof: signPaymentTestBytes(paymentChannelPayerSigningBytes(binding)), ...input };
}

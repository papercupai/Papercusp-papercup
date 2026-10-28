/** P019 / D-052: authenticated challenge envelope. Signature validation is NOT
 * redemption: the host must still check issuer authority, current graph person,
 * hosted principal and an atomic single-use database receipt before binding. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const PURPOSE = 'hosted-lead-binding-v1';
export const MAX_LEAD_BINDING_CHALLENGE_MS = 15 * 60_000;
const ref = z.string().min(1).max(200).refine(value => value.trim() === value);
const scopeSchema = z.object({
  graphWorkspaceId: ref.refine(value => value !== '*'),
  personRef: z.string().regex(/^PER-[A-Za-z0-9-]{1,160}$/),
  environment: z.enum(['development', 'staging', 'production']),
}).strict();
const claimSchema = scopeSchema.extend({
  challengeId: z.uuid(),
  issuerRef: ref,
  issuedAt: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int().nonnegative().safe(),
}).strict().refine(claim => claim.expiresAt > claim.issuedAt &&
  claim.expiresAt - claim.issuedAt <= MAX_LEAD_BINDING_CHALLENGE_MS);

export type HostedLeadBindingScope = z.infer<typeof scopeSchema>;
export type HostedLeadBindingChallenge = z.infer<typeof claimSchema>;
export const parseHostedLeadBindingScope = (value: unknown): HostedLeadBindingScope => scopeSchema.parse(value);
export const parseHostedLeadBindingChallenge = (value: unknown): HostedLeadBindingChallenge => claimSchema.parse(value);

/** Mirrors the maintained hosted cookie's HMAC-SHA256/timing-safe comparison
 * convention with a distinct purpose, preventing cross-protocol token reuse.
 * The host injects its secret; neither a request nor this module stores it. */
export class HostedLeadBindingChallengeCodec {
  private readonly secret: Buffer;

  constructor(secret: string | Uint8Array) {
    this.secret = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
    if (this.secret.byteLength < 32) throw new Error('lead_binding_secret_invalid');
  }

  encode(input: HostedLeadBindingChallenge): string {
    const claim = claimSchema.parse(input);
    const payload = Buffer.from(JSON.stringify(claim), 'utf8').toString('base64url');
    const signed = `${PURPOSE}.${payload}`;
    return `${signed}.${createHmac('sha256', this.secret).update(signed).digest('base64url')}`;
  }

  decode(value: unknown, expected: HostedLeadBindingScope, now = Date.now()): HostedLeadBindingChallenge | null {
    if (typeof value !== 'string' || value.length > 4096 || !Number.isSafeInteger(now) || now < 0) return null;
    const scope = scopeSchema.safeParse(expected);
    if (!scope.success) return null;
    const parts = value.split('.');
    if (parts.length !== 3 || parts[0] !== PURPOSE || !/^[A-Za-z0-9_-]+$/.test(parts[1]!) ||
        !/^[A-Za-z0-9_-]{43}$/.test(parts[2]!)) return null;
    const signed = `${parts[0]}.${parts[1]}`;
    const supplied = Buffer.from(parts[2]!, 'base64url');
    if (supplied.toString('base64url') !== parts[2]) return null;
    const signature = createHmac('sha256', this.secret).update(signed).digest();
    if (supplied.length !== signature.length || !timingSafeEqual(supplied, signature)) return null;
    try {
      const bytes = Buffer.from(parts[1]!, 'base64url');
      if (bytes.toString('base64url') !== parts[1]) return null;
      const parsed = claimSchema.safeParse(JSON.parse(bytes.toString('utf8')));
      if (!parsed.success) return null;
      const claim = parsed.data;
      if (claim.issuedAt > now || claim.expiresAt <= now ||
          claim.graphWorkspaceId !== scope.data.graphWorkspaceId || claim.personRef !== scope.data.personRef ||
          claim.environment !== scope.data.environment) return null;
      return claim;
    } catch { return null; }
  }
}

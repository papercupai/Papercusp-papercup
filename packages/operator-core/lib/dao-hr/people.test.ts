import { describe, expect, it } from 'vitest';
import { projectPersonEquity } from './people';

const wallet = '0x1111111111111111111111111111111111111111';
const inspection = { governanceBound: true, supplyInvariant: true, chainId: 1, issuedShares: '300000', holder: { wallet, balance: '100000' } };

describe('public person equity projection', () => {
  it('keeps integer share amounts exact and derives a percentage without floating point', () => {
    expect(projectPersonEquity(inspection, wallet)).toMatchObject({ shares: '100000', issuedShares: '300000', ownershipPercent: '33.33' });
    const large = '900719925474099300000';
    expect(projectPersonEquity({ ...inspection, issuedShares: large, holder: { wallet, balance: large } }, wallet)).toMatchObject({ shares: large, ownershipPercent: '100.00' });
  });
  it('rejects an unverified deployment, another holder and missing chain balances', () => {
    expect(() => projectPersonEquity({ ...inspection, governanceBound: false }, wallet)).toThrow('integrity');
    expect(() => projectPersonEquity({ ...inspection, holder: { ...inspection.holder, wallet: '0x2222222222222222222222222222222222222222' } }, wallet)).toThrow('holder');
    expect(() => projectPersonEquity({ ...inspection, issuedShares: undefined }, wallet)).toThrow('balances');
  });
});

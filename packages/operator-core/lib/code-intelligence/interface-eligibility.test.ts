import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { captureInterfaceEligibility, type EditTimePeerEvidence } from './interface-eligibility';

const peerEvidence: EditTimePeerEvidence = { status: 'measured', peers: [{ owner: 'peer', path: 'consumer.ts', via: 'lock' }] };
const capture = (beforeText: string | null, afterText: string | null, peers = peerEvidence) =>
  captureInterfaceEligibility({ file: 'target.ts', beforeText, afterText, capturedAt: '2026-10-26T23:00:00Z', peerEvidence: peers });

describe('independent edit-time interface eligibility', () => {
  it.each([
    ['function', 'export function f(x: string): void {}', 'export function f(x: number): void {}'],
    ['const arrow', 'export const f = (x: string): void => {};', 'export const f = (x: number): void => {};'],
    ['class method', 'export class A { f(x: string): void {} }', 'export class A { f(x: number): void {} }'],
    ['interface member', 'export interface A { f(x: string): void; }', 'export interface A { f(x: number): void; }'],
    ['type alias', 'export type A = { x: string };', 'export type A = { x: number };'],
    ['overloads', 'export function f(x: string): void; export function f(x: any) {}',
      'export function f(x: number): void; export function f(x: any) {}'],
    ['default export', 'export default function(x: string): void {}', 'export default function(x: number): void {}'],
    ['re-export', 'export { f } from "./a";', 'export { f } from "./b";'],
  ])('captures a complete-file %s change', (_shape, before, after) => {
    const result = capture(before, after);
    expect(result).toMatchObject({ verdict: 'eligible', beforeSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      afterSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(result.changedExports.length).toBeGreaterThan(0);
  });
  it.each([
    ['export function f(x: string): string { return x; }', 'export function f(x: string): string { return x.trim(); }'],
    ['export const f = (x: string): string => x;', 'export const f = (x: string): string => x.trim();'],
    ['export class A { f(x: string): string { return x; } }', 'export class A { f(x: string): string { return x.trim(); } }'],
  ])('excludes a body-only edit', (before, after) => expect(capture(before, after).verdict).toBe('ineligible'));
  it('uses full files even when the replacement fragment is unparseable', () => {
    const before = 'export function f(x: { value: string }): string { return x.value; }';
    expect(capture(before, before.replace('value: string', 'value: number')).verdict).toBe('eligible');
    expect(capture('value: string }', 'value: number }').verdict).toBe('unknown');
  });
  it('retains peer evidence after the producer releases its locks', () => {
    const peers: EditTimePeerEvidence = { status: 'measured', peers: [...peerEvidence.peers] };
    const saved = capture('export type A = string', 'export type A = number', peers);
    peers.peers.length = 0;
    expect(saved.verdict).toBe('eligible');
    expect(saved.peerEvidence.peers).toHaveLength(1);
    expect(capture('export type A = string', 'export type A = number', peers).verdict).toBe('ineligible');
  });
  it('keeps unobserved peers and missing full source unknown', () => {
    expect(capture('export type A = string', 'export type A = number', { status: 'unknown', peers: [] }).verdict).toBe('unknown');
    expect(capture(null, 'export type A = number').verdict).toBe('unknown');
  });
  it('imports no push-path or hook signature detector', () => {
    const source = readFileSync(new URL('./interface-eligibility.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/(?:from\s*|import\s*\()\s*['"][^'"]*(?:push-channel|peer-edit-impact|check-required-field-strands)/);
  });
});

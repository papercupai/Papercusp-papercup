import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  GRADING_AUDIT_SOURCE_PIN_MAX_SEC,
  readGradingAuditSourcePin,
  releaseGradingAuditSourcePin,
  writeGradingAuditSourcePin,
} from './grading-audit-source-pin';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'audit-source-pin-'));
  roots.push(root);
  const sourceRoot = join(root, '.candidate-build.original', 'checkout');
  mkdirSync(sourceRoot, { recursive: true });
  return {
    sourceRoot, ownerRef: 'grading-audit-runtime:build',
    evaluatorBuild: { sha: 'abcdef0123', version: '0.0.0' },
    bundleSha256: 'a'.repeat(64), expiresAtSec: 2000,
  };
}

describe('exact grading audit source pins (EI-25971079852455067)', () => {
  it('recovers the physical generation after its staging alias advances and its process is gone', () => {
    const input = fixture();
    const alias = join(dirname(dirname(input.sourceRoot)), 'current');
    symlinkSync(input.sourceRoot, alias);
    const path = writeGradingAuditSourcePin({ ...input, sourceRoot: alias }, 1000);
    rmSync(alias);
    const next = join(dirname(dirname(input.sourceRoot)), '.candidate-new.next', 'checkout');
    mkdirSync(next, { recursive: true });
    symlinkSync(next, alias);
    expect(readGradingAuditSourcePin(input.sourceRoot, input.ownerRef, 1500)).toEqual({ ...input, schemaVersion: 1 });
    expect(readGradingAuditSourcePin(alias, input.ownerRef, 1500)).toBeNull();
    expect(readFileSync(path, 'utf8').split('\n')[0]).toBe('2000');
  });

  it('expires at the exact deadline, rejects corruption, and releases only the named owner', () => {
    const input = fixture();
    const path = writeGradingAuditSourcePin(input, 1000);
    writeGradingAuditSourcePin({ ...input, ownerRef: 'other' }, 1000);
    expect(readGradingAuditSourcePin(input.sourceRoot, input.ownerRef, 2000)).toBeNull();
    writeFileSync(path, '2000\n{}\n');
    expect(readGradingAuditSourcePin(input.sourceRoot, input.ownerRef, 1000)).toBeNull();
    releaseGradingAuditSourcePin(input.sourceRoot, input.ownerRef);
    expect(readGradingAuditSourcePin(input.sourceRoot, 'other', 1000)?.ownerRef).toBe('other');
    expect(readdirSync(dirname(path))).toHaveLength(1);
  });

  it('refuses an unbounded pin, unknown artifact identity, and a mutable checkout', () => {
    const input = fixture();
    expect(() => writeGradingAuditSourcePin({ ...input, expiresAtSec: 1001 + GRADING_AUDIT_SOURCE_PIN_MAX_SEC }, 1000)).toThrow('bounded');
    expect(() => writeGradingAuditSourcePin({ ...input, evaluatorBuild: { sha: null, version: '0.0.0' } }, 1000)).toThrow('exact build');
    expect(() => writeGradingAuditSourcePin({ ...input, bundleSha256: '' }, 1000)).toThrow('exact build');
    expect(() => writeGradingAuditSourcePin({ ...input, sourceRoot: dirname(input.sourceRoot) }, 1000)).toThrow('immutable');
    expect(() => writeGradingAuditSourcePin({ ...input, ownerRef: '' }, 1000)).toThrow('owner');
  });
});

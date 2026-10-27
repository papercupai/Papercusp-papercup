import { describe, expect, it } from 'vitest';
import { assertProducerBuildIdentity } from './engineering-evidence-producer';

describe('engineering live producer source identity', () => {
  const selected = 'b0b5d23760' + 'a'.repeat(30);

  it('ee.producer-build: accepts the exact committed source with a matching or absent reporter stamp', () => {
    expect(() => assertProducerBuildIdentity(selected, selected)).not.toThrow();
    expect(() => assertProducerBuildIdentity(selected, selected, ' ' + selected + ' ')).not.toThrow();
    const sha256 = 'b'.repeat(64);
    expect(() => assertProducerBuildIdentity(sha256, sha256)).not.toThrow();
  });

  it('ee.producer-build-mismatch: refuses a different runner even when the selected build and reporter stamp agree', () => {
    expect(() => assertProducerBuildIdentity(selected, '67228bbb71' + '6'.repeat(30), selected))
      .toThrow('--ref=' + selected);
    expect(() => assertProducerBuildIdentity(selected, selected.slice(0, 10) + 'f'.repeat(30)))
      .toThrow('exact selected serving commit');
  });

  it('ee.producer-build-unknown: refuses missing, abbreviated or malformed source identity', () => {
    for (const runner of [null, '', selected.slice(0, 10), 'z'.repeat(40)])
      expect(() => assertProducerBuildIdentity(selected, runner)).toThrow('exact selected serving commit');
    expect(() => assertProducerBuildIdentity(selected.slice(0, 10), selected)).toThrow();
  });

  it('ee.producer-reporter-mismatch: refuses a stamp that would record another commit', () => {
    expect(() => assertProducerBuildIdentity(selected, selected, 'c'.repeat(40)))
      .toThrow('test runner and reporter');
  });
});

import { describe, expect, it, beforeEach } from 'vitest';
import {
  _resetHostPlatformForTests,
  getHostPlatform,
  registerHostPlatform,
  type HostPlatform,
} from './index';

function makeFakePlatform(): HostPlatform {
  return {
    readTextFileSync: () => 'fake',
    fileExistsSync: () => true,
    homedir: () => '/fake/home',
    papercuspHome: () => '/fake/home/.papercusp',
    getHarnessAdminUrl: () => 'postgresql://fake/db',
  };
}

describe('HostPlatform registry', () => {
  beforeEach(() => {
    _resetHostPlatformForTests();
  });

  it('registers and returns a platform', () => {
    const fake = makeFakePlatform();
    registerHostPlatform(fake);
    expect(getHostPlatform()).toBe(fake);
  });

  it('register twice with the same impl is idempotent', () => {
    const fake = makeFakePlatform();
    registerHostPlatform(fake);
    expect(() => registerHostPlatform(fake)).not.toThrow();
    expect(getHostPlatform()).toBe(fake);
  });

  it('register twice with different impls throws', () => {
    const fake1 = makeFakePlatform();
    const fake2 = makeFakePlatform();
    registerHostPlatform(fake1);
    expect(() => registerHostPlatform(fake2)).toThrow(/already registered/);
  });

  it('throws when nothing is registered (no silent auto-default)', () => {
    expect(() => getHostPlatform()).toThrow(/No HostPlatform registered/);
  });

  it('reset clears the registration', () => {
    const fake = makeFakePlatform();
    registerHostPlatform(fake);
    _resetHostPlatformForTests();
    // After reset, getHostPlatform should throw — the previous fake is gone.
    expect(() => getHostPlatform()).toThrow(/No HostPlatform registered/);
  });
});

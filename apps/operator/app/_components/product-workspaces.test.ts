import { describe, expect, it } from 'vitest';
import { isDaoWorkspacePath, productWorkspaceHref } from './chrome-shell-nav';

describe('product workspace navigation', () => {
  it('restores independent pot/tab and DAO/section selections', () => {
    expect(productWorkspaceHref('/adv?slug=alpha&tab=plans', 'operations')).toBe('/adv?slug=alpha&tab=plans');
    expect(productWorkspaceHref('/daos?dao=community&daoSection=treasury', 'dao')).toBe('/daos?dao=community&daoSection=treasury');
  });
  it.each(['https://example.com/adv', '//example.com/daos', '/advocate', '/daos-other', 'javascript:alert(1)', '/adv?tab=plans'])('rejects an invalid DAO destination %s', value => {
    expect(productWorkspaceHref(value, 'dao')).toBe('/daos');
  });
  it('falls back safely when storage has no value or the other product', () => {
    expect(productWorkspaceHref(null, 'operations')).toBe('/adv');
    expect(productWorkspaceHref('/daos?dao=alpha', 'operations')).toBe('/adv');
  });
  it('keeps the existing legal/entity launch route inside the DAO product workspace', () => {
    expect(isDaoWorkspacePath('/dao')).toBe(true);
    expect(productWorkspaceHref('/dao?daoOrg=org-a', 'dao')).toBe('/dao?daoOrg=org-a');
    expect(isDaoWorkspacePath('/dao-unrelated')).toBe(false);
  });
});

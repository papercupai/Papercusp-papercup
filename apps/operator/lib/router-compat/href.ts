import { defaultParseSearch } from '@tanstack/react-router';

/** Adapt an href to TanStack's separate path/search/hash inputs. */
export function navigationFromHref(href: string) {
  // Let TanStack keep handling external URLs and its protocol safety checks.
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return { to: href };
  const [, pathname, search, hash] = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(href)!;
  return {
    to: pathname || '.',
    search: search ? () => defaultParseSearch(search) : href.startsWith('#') ? true as const : undefined,
    hash: hash?.slice(1),
  };
}

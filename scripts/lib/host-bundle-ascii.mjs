/**
 * Pure helpers for the host-bundle ASCII guard in scripts/check-host-bundle-builds.mjs.
 *
 * WHY (WI-6554700010009506): apps/operator/bin/ascii-escape-bundle.mjs keeps the
 * host bundle's module source one-byte in every host process (a single non-ASCII
 * char makes node hold the whole ~70 MB source as two-byte UTF-16, roughly 2x the
 * resident memory). It deliberately never fails the build: when ANY String.raw
 * template contains a non-ASCII char it warns and ships the bundle un-escaped. Three
 * first-party String.raw regexes/templates did exactly that, and nothing noticed,
 * because the warning scrolls past inside bundle-host.sh. This module turns that
 * silent fallback into a named, gating finding.
 *
 * The verdict is measured on the BUILT bundle (after the escape pass ran), so it
 * covers every cause of a non-ASCII bundle, not only String.raw. The String.raw
 * scan uses the same pattern as the escape pass, so a site it names is exactly a
 * site the pass refuses on.
 *
 * Fix for a named site: splice the char in from its code point inside a ${...}
 * interpolation (for example String.fromCharCode(0x2019)); the interpolated value
 * is not template text, so the source stays ASCII and the runtime string is
 * byte-identical.
 */

/** Same pattern as ascii-escape-bundle.mjs uses to find String.raw bodies. */
const STRING_RAW_RE = /String\.raw`([\s\S]*?)`/g;

/** esbuild's per-module comment in a non-minified bundle, e.g. "// ../../packages/x/lib/y.ts". */
const MODULE_MARKER_RE = /^\/\/ (\S+\.(?:[cm]?[jt]sx?|json))$/;

function isNonAscii(code) {
  return code > 0x7f;
}

/** Number of UTF-16 code units above U+007F. */
export function countNonAscii(src) {
  let n = 0;
  for (let i = 0; i < src.length; i++) if (isNonAscii(src.charCodeAt(i))) n++;
  return n;
}

function formatCodePoint(cp) {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** 1-based line number of `index` in `src`. */
function lineAt(src, index) {
  let line = 1;
  for (let i = src.indexOf('\n'); i !== -1 && i < index; i = src.indexOf('\n', i + 1)) line++;
  return line;
}

/** The nearest esbuild module marker at or before `index`, or null. */
function moduleAt(src, index) {
  let end = src.lastIndexOf('\n', index);
  while (end > 0) {
    const start = src.lastIndexOf('\n', end - 1) + 1;
    const m = MODULE_MARKER_RE.exec(src.slice(start, end));
    if (m) return m[1];
    end = start - 1;
  }
  return null;
}

/**
 * Every String.raw template whose body carries a non-ASCII char, i.e. every site
 * that makes ascii-escape-bundle.mjs refuse the WHOLE bundle.
 * @returns {{ line: number, module: string | null, codePoints: string[] }[]}
 */
export function findBlockingStringRawSites(src) {
  const sites = [];
  for (const m of src.matchAll(STRING_RAW_RE)) {
    const body = m[1];
    const codePoints = new Set();
    for (const ch of body) {
      const cp = ch.codePointAt(0);
      if (isNonAscii(cp)) codePoints.add(formatCodePoint(cp));
    }
    if (codePoints.size === 0) continue;
    sites.push({ line: lineAt(src, m.index), module: moduleAt(src, m.index), codePoints: [...codePoints] });
  }
  return sites;
}

/**
 * The guard's verdict on a built host bundle.
 * @returns {{ ok: boolean, nonAscii: number, sites: ReturnType<typeof findBlockingStringRawSites> }}
 */
export function hostBundleAsciiVerdict(src) {
  const nonAscii = countNonAscii(src);
  if (nonAscii === 0) return { ok: true, nonAscii, sites: [] };
  return { ok: false, nonAscii, sites: findBlockingStringRawSites(src) };
}

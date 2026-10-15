// Types for vendored-manifest.mjs (the shared vendoring rule; see that file).
export function isVendorDevOnly(rel: string): boolean;
export const VENDOR_DEV_ONLY_DEPENDENCIES: readonly string[];
export function vendoredManifestOf(canonicalText: string): string;

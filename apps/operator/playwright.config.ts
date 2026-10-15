// Compatibility entry for existing imports. Guarded CLI callers select the
// ESM entry explicitly so Playwright does not transform this shim as CommonJS.
export { default, PROFILE_OWNED_SPECS } from './playwright.config.mts';

/**
 * Standard ts_headline options shared by the search engine and its renderers.
 * This module must stay free of server imports so browser consumers can use the
 * same contract without initializing SQL, provider or process infrastructure.
 *
 * `StartSel` overrides ts_headline's `<b>` default. A renderer that assumes the
 * default silently stops highlighting and emits literal `<mark>` tags as text.
 * Derive the marker from this shared contract instead of copying the assumption.
 */
export const HEADLINE_OPTS =
  'StartSel=<mark>, StopSel=</mark>, MaxFragments=2, FragmentDelimiter=" … ", MaxWords=18, MinWords=5, ShortWord=2';

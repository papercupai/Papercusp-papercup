/**
 * WI-6554700010030578 — parseEventKeyParams is the inverse of buildKey, and
 * eventKeySubjectItemId reads the work item a key is about from that parse.
 */
import { describe, expect, it } from 'vitest';
import {
  EVENT_CATALOG,
  buildKey,
  createEventKeyParser,
  eventKeySubjectItemId,
  parseEventKeyParams,
  type EventCatalogEntry,
} from './catalog';

function sampleParams(entry: EventCatalogEntry, includeOptional: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  entry.params.forEach((p, i) => {
    if (p.required || includeOptional) out[p.name] = `v${i}x`;
  });
  return out;
}

describe('parseEventKeyParams (inverse of buildKey)', () => {
  const parse = createEventKeyParser();

  it('reads every catalog family back to params that rebuild the same key', () => {
    const failures: string[] = [];
    let checked = 0;
    for (const entry of EVENT_CATALOG) {
      for (const includeOptional of [true, false]) {
        const key = buildKey(entry.family, sampleParams(entry, includeOptional));
        if (key.includes('<')) continue; // a template placeholder with no declared param: nothing to read back
        checked++;
        const parsed = parse(key);
        if (!parsed) {
          failures.push(`${entry.family}: '${key}' parsed to null`);
          continue;
        }
        const rebuilt = buildKey(parsed.family, parsed.params);
        if (rebuilt !== key) failures.push(`${entry.family}: '${key}' -> ${parsed.family} -> '${rebuilt}'`);
      }
    }
    expect(checked).toBeGreaterThan(EVENT_CATALOG.length); // the positive control: the loop measured real keys
    expect(failures).toEqual([]);
  });

  it('returns the originating family and its params for an id-scoped key', () => {
    const entry = EVENT_CATALOG.find((e) => e.keyTemplate === 'claim:released:<id>');
    expect(entry).toBeDefined();
    expect(parseEventKeyParams('claim:released:WI-7')).toEqual({ family: entry!.family, params: { id: 'WI-7' } });
  });

  it('reads a collapsed optional param as absent, the way buildKey renders it', () => {
    const entry = EVENT_CATALOG.find((e) => e.params.some((p) => !p.required) && !e.params.some((p) => p.required));
    expect(entry).toBeDefined();
    const key = buildKey(entry!.family, {});
    const parsed = parseEventKeyParams(key);
    expect(parsed).not.toBeNull();
    expect(buildKey(parsed!.family, parsed!.params)).toBe(key);
  });

  it('returns null for a key no family produces, and for an empty key', () => {
    expect(parseEventKeyParams('zz-no-such-namespace:anything')).toBeNull();
    expect(parseEventKeyParams('   ')).toBeNull();
  });

  it('keeps a colon inside the LAST param value (greedy tail, as familyKeyArity treats it)', () => {
    const parsed = parseEventKeyParams('claim:released:WI-7:extra');
    expect(parsed?.params.id).toBe('WI-7:extra');
  });
});

describe('eventKeySubjectItemId', () => {
  it('names the work item an id-scoped key is about', () => {
    expect(eventKeySubjectItemId(parseEventKeyParams('claim:released:WI-7'))).toBe('WI-7');
    expect(eventKeySubjectItemId(parseEventKeyParams(buildKey(
      EVENT_CATALOG.find((e) => e.keyTemplate === 'work-item:done:<id>')!.family,
      { id: 'EI-123' },
    )))).toBe('EI-123');
  });

  it('is null when the key names no work item, or no family produces it', () => {
    expect(eventKeySubjectItemId(parseEventKeyParams('claim:released:not-an-item'))).toBeNull();
    expect(eventKeySubjectItemId(parseEventKeyParams('zz-no-such-namespace:WI-7'))).toBeNull();
    expect(eventKeySubjectItemId(null)).toBeNull();
  });
});

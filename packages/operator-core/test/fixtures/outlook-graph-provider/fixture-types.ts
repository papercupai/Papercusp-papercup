/**
 * Every fixture Graph response is checked against Microsoft's own types
 * (`@microsoft/microsoft-graph-types`), so a fixture that drifts from the real
 * API (a renamed or invented field, a wrong nesting) fails `tsc`.
 *
 * A plain `satisfies` is not enough here: a JSON module's type is not a fresh
 * object literal, so TypeScript skips excess-property checks and a renamed key
 * would pass silently. `Known<T, S>` maps every key of the fixture that the
 * Graph type does not declare to `never`, recursively through objects and
 * arrays. Leaf values are compared with string, number and boolean literals
 * widened, because JSON imports widen `"html"` to `string`.
 */
import type { Event, Message } from '@microsoft/microsoft-graph-types';
import calendarDelta1 from './fixtures/calendar-delta-1.json';
import mailDelta1 from './fixtures/mail-delta-1.json';
import mailDelta2 from './fixtures/mail-delta-2.json';
import mailDelta3 from './fixtures/mail-delta-3.json';
import mailDelta4 from './fixtures/mail-delta-4.json';

/** Graph's delta-query envelope; removed items carry `@removed`. */
interface DeltaPage<T> {
  '@odata.context'?: string;
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
  value: Array<T & { '@removed'?: { reason?: string } }>;
}

type Widen<S> = S extends string ? string : S extends number ? number : S extends boolean ? boolean : S;

type Known<T, S> = [NonNullable<S>] extends [never]
  ? never
  : T extends readonly (infer E)[]
    ? NonNullable<S> extends readonly (infer SE)[]
      ? readonly Known<E, SE>[]
      : never
    : T extends object
      ? NonNullable<S> extends object
        ? { [K in keyof T]: K extends keyof NonNullable<S> ? Known<T[K], NonNullable<S>[K]> : never }
        : never
      : T extends Widen<NonNullable<S>>
        ? T
        : never;

/** Accepts a value only if every key it carries, at every depth, is declared by `S`. */
function graphTyped<S>() {
  return <T>(value: T & Known<T, S>): T => value;
}

export const fixtures = {
  mailDelta1: graphTyped<DeltaPage<Message>>()(mailDelta1),
  mailDelta2: graphTyped<DeltaPage<Message>>()(mailDelta2),
  mailDelta3: graphTyped<DeltaPage<Message>>()(mailDelta3),
  mailDelta4: graphTyped<DeltaPage<Message>>()(mailDelta4),
  calendarDelta1: graphTyped<DeltaPage<Event>>()(calendarDelta1),
};

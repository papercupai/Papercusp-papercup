/** Compile MCP's flat primitive form before exposing any of its questions. */
import { z } from 'zod';
import { isSensitiveValueKey } from './sensitive-text';

export interface NativeFormField {
  key: string; prompt: string; optional: boolean; sensitive: boolean; multi: boolean;
  allowEmpty: boolean;
  choices?: Array<{ label: string }>;
  parse(values: string[]): string | number | boolean | string[];
}

export function nativeFormFields(value: unknown): NativeFormField[] {
  const root = z.object({ type: z.literal('object'), properties: z.record(z.string(), z.unknown()),
    required: z.array(z.string()).optional(), $schema: z.string().optional(), title: z.string().optional(),
    description: z.string().optional(), additionalProperties: z.literal(false).optional(),
  }).strict().parse(value);
  if ((root.required ?? []).some(key => !Object.hasOwn(root.properties, key))) throw new Error('Unknown required form field');
  return Object.entries(root.properties).map(([key, raw]) => {
    const variant = z.object({ const: z.string(), title: z.string().optional() }).strict();
    const field = z.object({ type: z.enum(['string', 'number', 'integer', 'boolean', 'array']),
      title: z.string().optional(), description: z.string().optional(), default: z.unknown().optional(),
      enum: z.array(z.string()).min(1).optional(), enumNames: z.array(z.string()).optional(),
      oneOf: z.array(variant).min(1).optional(),
      items: z.object({ type: z.literal('string').optional(), enum: z.array(z.string()).min(1).optional(),
        anyOf: z.array(variant).min(1).optional() }).strict().optional(),
      minLength: z.number().int().nonnegative().optional(), maxLength: z.number().int().nonnegative().optional(),
      minimum: z.number().finite().optional(), maximum: z.number().finite().optional(),
      minItems: z.number().int().nonnegative().optional(), maxItems: z.number().int().nonnegative().optional(),
      format: z.enum(['email', 'uri', 'date', 'date-time', 'password']).optional(),
      writeOnly: z.boolean().optional(), sensitive: z.boolean().optional(),
    }).strict().parse(raw);
    const sensitive = field.writeOnly === true || field.sensitive === true || field.format === 'password' || isSensitiveValueKey(key);
    const has = (...keys: Array<keyof typeof field>) => keys.some(key => field[key] !== undefined);
    if ((field.type !== 'string' && has('enum', 'enumNames', 'oneOf', 'minLength', 'maxLength', 'format')) ||
        (!['number', 'integer'].includes(field.type) && has('minimum', 'maximum')) ||
        (field.type !== 'array' && has('items', 'minItems', 'maxItems')) ||
        (field.enum && field.oneOf) || (field.enumNames && !field.enum) || (field.items?.enum && field.items.anyOf) ||
        (field.minLength ?? 0) > (field.maxLength ?? Infinity) ||
        (field.minimum ?? -Infinity) > (field.maximum ?? Infinity) ||
        (field.minItems ?? 0) > (field.maxItems ?? Infinity)) throw new Error('Unsupported form constraints');
    const variants = field.type === 'array' ? field.items?.anyOf : field.oneOf;
    const values = variants?.map(item => item.const) ?? (field.type === 'array' ? field.items?.enum : field.enum);
    const labels = variants?.map(item => item.title ?? item.const) ?? field.enumNames ?? values;
    if (values && (new Set(values).size !== values.length || !labels || labels.length !== values.length
      || new Set(labels).size !== labels.length)) throw new Error('Ambiguous form choices');
    if (field.type === 'array' && (!values || sensitive)) throw new Error('MCP arrays require public enumerated choices');
    return { key, prompt: [field.title || key, field.description].filter(Boolean).join('\n'), sensitive,
      allowEmpty: field.type === 'array' ? (field.minItems ?? 0) === 0
        : field.type === 'string' && !values && (!field.format || field.format === 'password') && (field.minLength ?? 0) === 0,
      optional: !(root.required ?? []).includes(key), multi: field.type === 'array',
      choices: sensitive ? undefined : field.type === 'boolean' ? [{ label: 'Yes' }, { label: 'No' }]
        : labels?.map(label => ({ label })),
      parse(picked: string[]): string | number | boolean | string[] {
        const selected = values && !sensitive ? picked.map(label => values[labels!.indexOf(label)]) : picked;
        if (selected.some(item => typeof item !== 'string')) throw new Error('Choose a valid response');
        if (field.type === 'array') return z.array(z.string().refine(item => values!.includes(item)))
          .min(field.minItems ?? 0).max(field.maxItems ?? values!.length).parse(selected);
        if (selected.length !== 1) throw new Error('Choose one response');
        const answer = selected[0];
        if (field.type === 'boolean') {
          if (!['Yes', 'No'].includes(answer)) throw new Error('Choose Yes or No');
          return answer === 'Yes';
        }
        if (field.type === 'number' || field.type === 'integer') {
          if (!answer.trim()) throw new Error('Enter a number');
          let schema = z.number().finite().min(field.minimum ?? -Infinity).max(field.maximum ?? Infinity);
          if (field.type === 'integer') schema = schema.int();
          return schema.parse(Number(answer));
        }
        let schema = z.string().min(field.minLength ?? 0).max(field.maxLength ?? Infinity);
        if (field.format === 'email') schema = schema.email();
        if (field.format === 'uri') schema = schema.url();
        if (field.format === 'date') schema = schema.date();
        if (field.format === 'date-time') schema = schema.datetime({ offset: true });
        const result = schema.parse(answer);
        if (values && !values.includes(result)) throw new Error('Choose a valid response');
        return result;
      },
    };
  });
}

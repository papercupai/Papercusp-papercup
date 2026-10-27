/** Public routing hints, never authority or private form/authentication data. */
import { randomUUID } from 'node:crypto';

export function nativeCardCorrelationId(runId: string): string | undefined {
  const match = /^pui-native:(\d+):(\d+)$/.exec(runId);
  return match ? `su-card.${match[1]}.${match[2]}.${randomUUID()}` : undefined;
}

export function parseNativeCardCorrelationId(value: string): { advSessionId: number; runtimeGeneration: number } | null {
  const match = /^su-card\.([1-9]\d*)\.(0|[1-9]\d*)\.([a-f0-9-]{36})$/.exec(value);
  if (!match) return null;
  const advSessionId = Number(match[1]), runtimeGeneration = Number(match[2]);
  return Number.isSafeInteger(advSessionId) && Number.isSafeInteger(runtimeGeneration)
    ? { advSessionId, runtimeGeneration } : null;
}

export const isNativeCardCorrelationId = (value: string): boolean => value.startsWith('su-card.');

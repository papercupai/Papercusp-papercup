/** One bounded retention policy for probe and command measurements. No live replay. */
import { createHash } from 'node:crypto';
import { canonicalJson } from '@papercusp/hash-chain';
import {
  MAX_MEASUREMENT_PROCEDURE_BYTES, MAX_MEASUREMENT_PROVENANCE_BYTES,
  measurementJsonBytes, parseRecordedMeasurementProvenance,
  type RecordedMeasurementProvenance,
} from '@papercusp/test-config/execution-details';
import { isSensitiveValueKey, redactSensitiveText } from './sensitive-text';

export function retainMeasurementProvenance(input: {
  procedure: unknown;
  result: unknown;
  startedAt: string;
  finishedAt: string;
  transactionAt?: string;
  needsTransactionClock?: boolean;
}): RecordedMeasurementProvenance {
  let redacted = false;
  let procedureTruncated = false;
  let diagnosticsTruncated = false;
  const scrub = (text: string): string => {
    // Command output can put a sensitive assignment after a harmless header.
    // Inspect each line while preserving its original LF/CRLF separators.
    const safe = text.replace(/[^\r\n]+/g, line => {
      const assignment = /^(\s*)([^:=\s]+)\s*[:=]\s*(.+)$/.exec(line);
      return assignment && isSensitiveValueKey(assignment[2]!)
        ? `${assignment[1]}${assignment[2]}=[redacted]` : redactSensitiveText(line);
    });
    redacted ||= safe !== text;
    return safe;
  };
  // The digest uses hash-chain's canonicalJson: sorted UTF16 keys, JSON scalar
  // encoding, UTF8 hashing. It never exposes the pre-redaction descriptor.
  let original: string;
  try { original = canonicalJson(input.procedure); }
  catch { original = 'null'; procedureTruncated = true; }
  const sha256 = createHash('sha256').update(original, 'utf8').digest('hex');
  let procedureNodes = 0;
  const seen = new Set<object>();
  const sanitize = (value: unknown, depth: number): unknown => {
    if (++procedureNodes > 256 || depth > 6) { procedureTruncated = true; return null; }
    if (typeof value === 'string') {
      const safe = scrub(value);
      if (safe.length > 8192) procedureTruncated = true;
      return safe.slice(0, 8192);
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || seen.has(value)) { procedureTruncated = true; return null; }
    seen.add(value);
    let safe: unknown;
    if (Array.isArray(value)) {
      let hideNext = false;
      safe = value.slice(0, 256).map(entry => {
        if (hideNext) { hideNext = false; redacted = true; return '[redacted]'; }
        if (typeof entry === 'string' && /^--?/.test(entry) && isSensitiveValueKey(entry.split('=')[0]!)) {
          redacted = true;
          const equals = entry.indexOf('=');
          hideNext = equals < 0;
          return equals < 0 ? entry : entry.slice(0, equals + 1) + '[redacted]';
        }
        return sanitize(entry, depth + 1);
      });
      if (value.length > 256) procedureTruncated = true;
    } else {
      const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      safe = Object.fromEntries(entries.slice(0, 256).map(([key, entry]) => {
        if (isSensitiveValueKey(key)) { redacted = true; return [scrub(key), '[redacted]']; }
        return [scrub(key), sanitize(entry, depth + 1)];
      }));
      if (entries.length > 256) procedureTruncated = true;
    }
    seen.delete(value);
    return safe;
  };
  let snapshot = canonicalJson(sanitize(input.procedure, 0));
  if (Buffer.byteLength(snapshot, 'utf8') > MAX_MEASUREMENT_PROCEDURE_BYTES) {
    snapshot = '{}'; procedureTruncated = true;
  }
  const diagnostics: RecordedMeasurementProvenance['diagnostics'] = [];
  let nodes = 0;
  const visit = (value: unknown, path: string, depth: number, sensitive = false): void => {
    if (++nodes > 256 || depth > 6 || diagnostics.length >= 64 || path.length > 256) {
      diagnosticsTruncated = true; return;
    }
    if (sensitive) { redacted = true; diagnostics.push({ path, value: '[redacted]' }); return; }
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      diagnostics.push({ path, value }); return;
    }
    if (typeof value === 'string') {
      const safe = scrub(value);
      // Command replay needs the complete parser input. Keep long stdout in
      // bounded leaves after scrubbing the WHOLE text, so chunk boundaries
      // cannot hide sensitive assignments. The same node/leaf/byte caps apply.
      if (safe.length > 256 && input.procedure !== null && typeof input.procedure === 'object'
        && 'kind' in input.procedure && input.procedure.kind === 'command'
        && /^\$\["samples"\]\["\d+"\]\["stdout"\]$/.test(path)) {
        const chunkCount = Math.ceil(safe.length / 256);
        visit({ chunkCount, chunks: Array.from({ length: Math.min(chunkCount, 65) }, (_, i) =>
          safe.slice(i * 256, (i + 1) * 256)) }, path, depth);
        diagnosticsTruncated ||= chunkCount > 65;
        return;
      }
      diagnosticsTruncated ||= safe.length > 256;
      diagnostics.push({ path, value: safe.slice(0, 256) }); return;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) { diagnosticsTruncated = true; return; }
    seen.add(value);
    const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    for (const [key, entry] of entries) {
      // JSON omits optional object properties. Internal readers commonly return
      // them as own undefined fields (e.g. pgReadQuery.positiveControl); they
      // are not lost measurements. Undefined array elements still signal gaps.
      if (entry === undefined && !Array.isArray(value)) continue;
      if (nodes >= 256 || diagnostics.length >= 64) { diagnosticsTruncated = true; break; }
      visit(entry, `${path}[${JSON.stringify(scrub(key))}]`, depth + 1, isSensitiveValueKey(key));
    }
    seen.delete(value);
  };
  visit(input.result, '$', 0);
  const result: RecordedMeasurementProvenance = {
    schemaVersion: 1, startedAt: input.startedAt, finishedAt: input.finishedAt,
    ...(input.transactionAt ? { transactionAt: input.transactionAt } : {}),
    procedure: { sha256, snapshot }, diagnostics, truncated: false, redacted, gaps: [],
  };
  const flags = (): void => {
    result.truncated = procedureTruncated || diagnosticsTruncated;
    result.gaps = [
      ...(procedureTruncated ? ['procedure-truncated' as const] : []),
      ...(diagnosticsTruncated ? ['diagnostics-truncated' as const] : []),
      ...(redacted ? ['redacted' as const] : []),
      ...(input.needsTransactionClock && !input.transactionAt ? ['transaction-clock-unavailable' as const] : []),
    ];
  };
  flags();
  while (measurementJsonBytes(result) > MAX_MEASUREMENT_PROVENANCE_BYTES && diagnostics.length) {
    diagnostics.pop(); diagnosticsTruncated = true; flags();
  }
  if (!parseRecordedMeasurementProvenance(result)) throw new Error('invalid retained measurement provenance');
  return result;
}

export function measurementProvenanceStatus(provenance?: RecordedMeasurementProvenance): 'retained' | 'partial' | 'legacy-missing' {
  return !provenance ? 'legacy-missing' : provenance.gaps.length ? 'partial' : 'retained';
}

/** Preserve every executed scalar when a multi-probe envelope needs a smaller context. */
export function fitMeasurementProvenance(value: RecordedMeasurementProvenance, maxBytes: number): RecordedMeasurementProvenance {
  const result = { ...value, procedure: { ...value.procedure }, diagnostics: [...value.diagnostics], gaps: [...value.gaps] };
  const gap = (kind: 'diagnostics-truncated' | 'procedure-truncated'): void => {
    result.truncated = true;
    if (!result.gaps.includes(kind)) result.gaps.push(kind);
  };
  while (measurementJsonBytes(result) > maxBytes && result.diagnostics.length) {
    result.diagnostics.pop(); gap('diagnostics-truncated');
  }
  if (measurementJsonBytes(result) > maxBytes && result.procedure.snapshot !== '{}') {
    result.procedure.snapshot = '{}'; gap('procedure-truncated');
  }
  return result;
}

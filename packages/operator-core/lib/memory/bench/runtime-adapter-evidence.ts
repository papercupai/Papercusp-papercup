/** Same-process direct-handler capture custody; never quality or latency acceptance. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseProseCaptureRequests } from '../../search/bench/prose-adapter-capture-cli';

export function adapterRuntimeArguments(args: readonly string[]): string[] {
  const separator = args.indexOf('--');
  const selected = args.slice(separator + 1);
  if (separator < 0 || selected.length !== 4 || selected[0] !== '--requests' || selected[2] !== '--out'
    || !selected[1] || selected[1].startsWith('--') || !selected[3]?.endsWith('.json')
    || path.resolve(selected[1]) === path.resolve(selected[3]))
    throw new Error('runtime adapter requires -- --requests INPUT --out NEW.json');
  return selected;
}

export function readAdapterRequestPin(args: readonly string[]) {
  const file = path.resolve(args[1]);
  const bytes = fs.readFileSync(file);
  parseProseCaptureRequests(JSON.parse(bytes.toString()));
  return { path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export function readAdapterRuntimeEvidence(args: readonly string[], expected: ReturnType<typeof readAdapterRequestPin>) {
  const requests = readAdapterRequestPin(args);
  if (!isDeepStrictEqual(requests, expected)) throw new Error('runtime adapter requests moved');
  const population = parseProseCaptureRequests(JSON.parse(fs.readFileSync(requests.path, 'utf8')));
  // Re-read the pin after parsing so request drift cannot bind different bytes.
  if (!isDeepStrictEqual(readAdapterRequestPin(args), expected)) throw new Error('runtime adapter requests moved');
  const file = path.resolve(args[3]);
  const bytes = fs.readFileSync(file);
  const rows: unknown = JSON.parse(bytes.toString());
  if (!Array.isArray(rows) || rows.length !== population.length || rows.some((row, i) => {
    const request = population[i]!;
    return !row || row.schemaVersion !== 1 || row.attemptId !== request.id || row.adapter !== request.adapter
      || !isDeepStrictEqual(row.request, request.args) || row.exitCode !== 0
      || typeof row.deliveryWallMs !== 'number' || !Number.isFinite(row.deliveryWallMs) || row.deliveryWallMs < 0
      || typeof row.stdout !== 'string' || !row.stdout.trim()
      || row.observation?.plane !== 'direct-tool-handler' || row.observation?.transportExercised !== false
      || row.observation?.baselineAccepted !== false;
  })) throw new Error('runtime adapter lacks a matching terminal population');
  for (const row of rows) JSON.parse(row.stdout);
  return { requests, artifact: { path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    executed: rows.length, searchAdapterExercised: true, baselineAccepted: false, latencyAcceptance: false,
    scope: 'direct tool handlers in observed child; transport, corpus authenticity, budgets and full closure remain separate' };
}

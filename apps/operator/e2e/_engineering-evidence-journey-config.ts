import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface EngineeringJourneyInputs {
  workspaceId: string; clientId: string;
  buildSha: string; plan: string; item: string; harness: string;
  symbol: { path: string; name: string };
  spec: { id: string; revision: number }; decisionId: string;
  runId: number; caseKey: string; occurrence: number;
  observation: { invocationId: string; traceId: string; spanId: string; sourceFingerprint: string;
    artifactFingerprint: string; environmentFingerprint: string };
  sourcePins: { path: string; sha256: string }[];
  stale: { plan: string; item: string }; unobserved: { plan: string; item: string };
  promotionReceipt?: string;
}
const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const path = (value: unknown) => text(value) && !String(value).startsWith('/')
  && !String(value).split(/[\\/]/).some(part => part === '..' || part === '.' || !part);

/** Missing live records and build pins are a refused measurement, never a skipped pass. */
export function validateEngineeringJourneyInputs(value: unknown): EngineeringJourneyInputs {
  const input = value as EngineeringJourneyInputs | null;
  if (!input || !text(input.workspaceId) || !text(input.clientId)
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.buildSha ?? '') || !text(input.plan)
    || !/^P-\d{3,}$/.test(input.item ?? '') || !text(input.harness) || !path(input.symbol?.path) || !text(input.symbol?.name)
    || !text(input.spec?.id) || !integer(input.spec?.revision) || !/^D-\d{3,}$/.test(input.decisionId ?? '')
    || !integer(input.runId) || !text(input.caseKey) || !integer(input.occurrence)
    || !text(input.observation?.invocationId) || !/^[a-f0-9]{32}$/.test(input.observation?.traceId ?? '')
    || !/^[a-f0-9]{16}$/.test(input.observation?.spanId ?? '') || !sha(input.observation?.sourceFingerprint)
    || !sha(input.observation?.artifactFingerprint) || !sha(input.observation?.environmentFingerprint)
    || !Array.isArray(input.sourcePins) || !input.sourcePins.length
    || input.sourcePins.some(pin => !path(pin.path) || !sha(pin.sha256))
    || new Set(input.sourcePins.map(pin => pin.path)).size !== input.sourcePins.length
    || ![input.stale, input.unobserved].every(selector => text(selector?.plan) && /^P-\d{3,}$/.test(selector?.item ?? '')))
    throw new Error('Engineering journey requires exact canonical selectors, an observed receipt, accepted source pins and negative controls.');
  return input;
}

export function readEngineeringJourneyConfig(env: NodeJS.ProcessEnv = process.env) {
  const plane = env.PAPERCUSP_ENGINEERING_PLANE;
  if (plane !== 'current-build' && plane !== 'final-release') throw new Error('Select current-build or final-release explicitly.');
  const inputsPath = env.PAPERCUSP_ENGINEERING_JOURNEY_INPUTS;
  if (!inputsPath) throw new Error('PAPERCUSP_ENGINEERING_JOURNEY_INPUTS must name the frozen canonical journey manifest.');
  const input = validateEngineeringJourneyInputs(JSON.parse(readFileSync(inputsPath, 'utf8')));
  if (plane === 'final-release' && !text(input.promotionReceipt)) throw new Error('Final-release evidence requires the authoritative promotion receipt.');
  const origin = new URL(env.OPERATOR_E2E_BASE_URL ?? `http://127.0.0.1:${plane === 'final-release' ? 3070 : 3170}`);
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
    || origin.port !== (plane === 'final-release' ? '3070' : '3170') || origin.username || origin.password
    || origin.pathname !== '/' || origin.hash || origin.search) throw new Error('Engineering evidence must use the selected maintained runtime origin.');
  const workspace = env.PAPERCUSP_WORKSPACE ?? input.workspaceId, client = env.PAPERCUSP_SID ?? input.clientId;
  if (workspace !== input.workspaceId) throw new Error('The journey manifest is outside the selected workspace.');
  return { plane, input, inputsPath, origin: origin.origin, workspace, client,
    home: env.PAPERCUSP_HOME ?? join(homedir(), '.papercusp') };
}

import { describe, expect, it } from 'vitest';
import { SayStreamProjector } from '@papercusp/chat-protocol';

// Opt-in paid-provider acceptance check. Run against a containing current-build
// operator, never inferred from unit tests or a historical timing sample.
const baseUrl = process.env.PAPERCUSP_VOICE_LATENCY_URL;
const expectedSha = process.env.PAPERCUSP_VOICE_LATENCY_SHA;
type Profile = 'standard' | 'slim';

async function buildSha(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(10_000) });
  expect(response.ok).toBe(true);
  const health = await response.json() as { sha?: string };
  expect(health.sha).toBeTruthy();
  return health.sha!;
}

async function measure(profile: Profile, question = 'Can you hear me? Answer in one short sentence.') {
  const start = performance.now();
  const response = await fetch(`${baseUrl}/api/agent-mcp/operator-converse`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({
      messages: [{ role: 'user', content: question }],
      trigger: 'user_message', modality: 'voice', voiceProfile: profile,
    }),
  });
  expect(response.ok).toBe(true);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '', event = '', reply = '';
  let firstTextMs: number | null = null, costUsd: number | null = null;
  let firstWordMs: number | null = null;
  const spoken = new SayStreamProjector({ allowPlainText: true });
  let finished = false;
  const tools: string[] = [];
  const results: Array<{ name: string; ok: boolean }> = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trimEnd();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (!line.startsWith('data:')) continue;
        const data = JSON.parse(line.slice(5)) as { text?: string; message?: string; costUsd?: number; name?: string; ok?: boolean };
        if (event === 'error') throw new Error(data.message ?? 'converse SSE error');
        if (event === 'tool_call' && data.name) tools.push(data.name);
        if (event === 'tool_result' && data.name) results.push({ name: data.name, ok: data.ok === true });
        // Count actual model text, not heartbeat, provenance, cards or tool output.
        if ((event === 'text' || event === 'delta') && typeof data.text === 'string' && data.text.trim()) {
          firstTextMs ??= Math.round(performance.now() - start);
          reply += data.text;
          const words = spoken.push(data.text);
          if (words.trim()) firstWordMs ??= Math.round(performance.now() - start);
        }
        if (event === 'done') { finished = true; costUsd = data.costUsd ?? null; }
      }
    }
  } finally { await reader.cancel(); }
  expect(finished, `${profile}: stream must finish successfully`).toBe(true);
  expect(firstTextMs, `${profile}: must emit real model text`).not.toBeNull();
  expect(firstWordMs, `${profile}: protocol tags are not spoken words`).not.toBeNull();
  return { profile, firstTextMs: firstTextMs!, firstWordMs: firstWordMs!, doneMs: Math.round(performance.now() - start), costUsd, reply, tools, results };
}

describe.skipIf(!baseUrl)('voice converse same-build latency acceptance', () => {
  it('slim retains a working live tool mount', async () => {
    expect(expectedSha).toBeTruthy();
    expect(await buildSha()).toBe(expectedSha);
    const sample = await measure('slim', 'Call the harness status tool for harness papercusp before answering. Then give its current status in one short sentence.');
    console.log(`[voice-tool-mount] ${JSON.stringify({ sha: expectedSha, ...sample })}`);
    expect(sample.tools).toContain('harness:status');
    // Owner tool result bodies are deliberately withheld by converse. Actual
    // completion is corroborated by the private fixture's MCP dispatch trace;
    // this stream assertion also guards that privacy boundary.
    expect(sample.results).toEqual([]);
    expect(await buildSha()).toBe(expectedSha);
  }, 100_000);

  it('slim emits model text sooner than standard on the same containing build', async () => {
    expect(expectedSha, 'explicit containing runtime SHA is required').toBeTruthy();
    const before = await buildSha();
    expect(before).toBe(expectedSha);
    const samples: Awaited<ReturnType<typeof measure>>[] = [];
    // Alternate order to avoid handing all cold starts to the baseline.
    for (const order of [['standard', 'slim'], ['slim', 'standard'], ['standard', 'slim']] as Profile[][]) {
      for (const profile of order) {
        expect(await buildSha()).toBe(before);
        const sample = await measure(profile);
        samples.push(sample);
        console.log(`[voice-latency-sample] ${JSON.stringify({ sha: before, ...sample })}`);
      }
    }
    expect(await buildSha()).toBe(before);
    const median = (profile: Profile, metric: 'firstTextMs' | 'firstWordMs' = 'firstTextMs') => samples.filter(s => s.profile === profile).map(s => s[metric]).sort((a, b) => a - b)[1];
    console.log(`[voice-latency-comparison] ${JSON.stringify({ sha: before, standardMedianMs: median('standard'), slimMedianMs: median('slim'), standardWordMedianMs: median('standard', 'firstWordMs'), slimWordMedianMs: median('slim', 'firstWordMs'), samples })}`);
    expect(median('slim')).toBeLessThan(median('standard'));
    expect(median('slim', 'firstWordMs')).toBeLessThan(median('standard', 'firstWordMs'));
  }, 600_000);
});

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { retainResumeSmokeWitness, verifyResumeSmokeContinuation }
  from '../../../../../apps/operator/scripts/resume-spawn-live';
import { resumeCommandFor } from './wake-executor';

// MC-P-020-EXACT-SESSION@1: exercise the production resume command and the
// persisted witness together. These are native-format fixtures, not evidence
// that an installed CLI or its provider completed a real turn.
describe('P-020 exact-session resume witness integration', () => {
  const sessionId = '48d6cfa4-d63a-4837-9eb3-405f4ee9f8c1';
  const wake = 'P020 unique wake\nReply with "résumé".';

  for (const agent of ['claude', 'codex', 'omp'] as const) {
    const record = agent === 'claude'
      ? { type: 'user', sessionId, message: { role: 'user', content: wake } }
      : agent === 'codex'
        ? { type: 'event_msg', payload: { type: 'user_message', message: wake } }
        : { type: 'message', message: { role: 'user', content: [{ type: 'text', text: wake }] } };
    // Blank lines are valid JSONL separators but still part of the saved bytes.
    const before = JSON.stringify({ type: 'session', id: sessionId, text: 'prior résumé' }) + '\n\n';
    const appended = JSON.stringify(record) + '\n';

    it(`${agent} persists the exact prior bytes and newly decoded wake from its resume command`, () => {
      const command = resumeCommandFor({ agent, sessionId,
        ompThreadId: agent === 'omp' ? sessionId : null }, wake);
      expect(command?.bin).toBe(agent);
      expect(command?.args).toContain(sessionId);
      expect(command?.args.at(-1)).toBe(wake);
      const dir = mkdtempSync(join(tmpdir(), 'p020-exact-session-'));
      try {
        const witness = retainResumeSmokeWitness(dir, agent, sessionId, before, before + appended, wake);
        const priorBytes = readFileSync(witness.beforePath);
        const currentBytes = readFileSync(witness.afterPath);
        // Independent oracle: compare the actual retained byte prefix, then
        // decode only the newly appended record using its native client shape.
        expect(currentBytes.subarray(0, priorBytes.length).equals(priorBytes)).toBe(true);
        const added = JSON.parse(currentBytes.subarray(priorBytes.length).toString('utf8'));
        const decodedWake = agent === 'claude' ? added.message.content
          : agent === 'codex' ? added.payload.message : added.message.content[0].text;
        expect(decodedWake).toBe(wake);
        expect(witness.exactPrefixAndNewWake).toBe(true);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it(`${agent} rejects a changed byte prefix even when all nonempty JSON records match`, () => {
      expect(verifyResumeSmokeContinuation(before, before.replace('\n\n', '\n') + appended, wake)).toBe(false);
      expect(verifyResumeSmokeContinuation(before, '\n' + before + appended, wake)).toBe(false);
    });

    it(`${agent} rejects a rewritten session prefix despite an otherwise valid wake record`, () => {
      const rewritten = before.replace(sessionId, 'different-session');
      expect(verifyResumeSmokeContinuation(before, rewritten + appended, wake)).toBe(false);
    });

    it(`${agent} requires the wake in a new record rather than only in the prior transcript`, () => {
      expect(verifyResumeSmokeContinuation(before + appended,
        before + appended + JSON.stringify({ text: 'unrelated turn' }) + '\n', wake)).toBe(false);
    });

    it(`${agent} rejects malformed appended data even when a later record contains the wake`, () => {
      expect(verifyResumeSmokeContinuation(before, before + 'not JSON\n' + appended, wake)).toBe(false);
    });
  }
});

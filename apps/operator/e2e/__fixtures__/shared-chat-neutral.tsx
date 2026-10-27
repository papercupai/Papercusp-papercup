import { useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { StructuredResults, type StructuredResultHost } from '../../../../libs/generic/chat-cards/src/structured-results';
import {
  parseChatEnvelope, requireChatCapabilities, type ChatResultBlock,
} from '../../../../libs/generic/chat-protocol/src/index';
import {
  checkConformance, createFixture, fourEventReplay, NeutralConsumer,
} from '../../../../libs/generic/chat-protocol/src/testing/conformance';

// The established portable consumer and renderer run in a real browser. This
// fixture deliberately has no application imports, service, or durable store.
const violations = checkConformance(fixture => new NeutralConsumer(fixture));
const negativeControl = checkConformance(fixture => {
  const consumer = new NeutralConsumer(fixture);
  return {
    answer: consumer.answer.bind(consumer),
    replay(events) {
      consumer.replay(events);
      fixture.storage.db.effects.push({ key: 'duplicate', scope: fixture.scope, result: 'again' });
    },
  };
});
const invalidFixture = createFixture();
const invalidConsumer = new NeutralConsumer(invalidFixture);
const futureFrame = { ...fourEventReplay()[0], schemaVersion: 2 };
let futureRefused = false;
try { invalidConsumer.replay([futureFrame]); } catch { futureRefused = true; }
const futureResult = parseChatEnvelope(futureFrame);
const restart = requireChatCapabilities({
  connectionReplay: true, persistedHistory: false, persistedInteractionDecisions: false,
  completedToolCheckpoints: false, interruptedTurnRecovery: false,
}, ['interruptedTurnRecovery']);
const protocol = {
  violations,
  duplicateControlCaught: negativeControl.some(value => value.scenario === 'duplicate-completed-effect'),
  futureVersion: !futureResult.ok ? futureResult.code : 'incorrectly accepted',
  futureRefused,
  invalidEvents: invalidConsumer.events.length,
  invalidEffects: invalidFixture.storage.db.effects.length,
  invalidDecisions: invalidFixture.storage.db.decisions.size,
  restart: !restart.ok ? restart.code : 'incorrectly advertised',
};
const document: ChatResultBlock = {
  id: 'neutral-document', kind: 'document', title: 'Shared document reader',
  text: 'Portable content. [Safe link](https://example.com/neutral)\n\n'
    + '<script>window.__neutralExecuted=true</script>'
    + '<img src=x onerror="window.__neutralExecuted=true">'
    + '<a onclick="window.__neutralExecuted=true">handler</a>\n\n'
    + '[Bad link](javascript:window.__neutralExecuted=true) [Data link](data:text/html,bad)',
  sources: [{ ref: 'document:allowed', label: 'Authorized fixture document' }],
  actions: [{ id: 'open', label: 'Open document', kind: 'open', ref: 'document:allowed' }],
};
const foreign: ChatResultBlock = {
  ...document, id: 'foreign-document', title: 'Foreign secret',
  sources: [{ ref: 'document:foreign' }],
  actions: [{ id: 'open', label: 'Open foreign document', kind: 'open', ref: 'document:foreign' }],
};

function NeutralChatFixture() {
  const authorized = useRef(true);
  const [epoch, setEpoch] = useState(0);
  const [actions, setActions] = useState(0);
  const host = useMemo<StructuredResultHost>(() => ({
    async resolve(request) {
      return authorized.current && request.result.sources[0]?.ref === 'document:allowed'
        ? { ok: true, value: request.result } : { ok: false, code: 'unauthorized' };
    },
    async activate(intent) {
      if (!authorized.current || intent.ref !== 'document:allowed') return { ok: false, code: 'unauthorized' };
      setActions(count => count + 1);
      return { ok: true, value: undefined };
    },
  }), []);
  return <main>
    <h1>Neutral shared chat conformance</h1>
    <p role="note">In-memory fixture; restart recovery is unsupported.</p>
    <output data-testid="protocol">{JSON.stringify(protocol)}</output>
    <output aria-label="Executed actions">{actions}</output>
    <button onClick={() => { authorized.current = false; setEpoch(value => value + 1); }}>
      Revoke document access
    </button>
    <StructuredResults blocks={[document, foreign]} authorizationKey={`neutral:${epoch}`} host={host} />
  </main>;
}

createRoot(window.document.getElementById('root')!).render(<NeutralChatFixture />);

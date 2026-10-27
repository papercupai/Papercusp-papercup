import { createRoot } from 'react-dom/client';
import { NuqsAdapter } from 'nuqs/adapters/react';
import { HarnessDock } from '../../app/harness/dock/HarnessDock';

createRoot(document.getElementById('root')!).render(
  <NuqsAdapter>
    <div style={{ margin: '80px 48px', width: 'calc(100vw - 792px)', height: 'calc(100vh - 232px)' }}>
      <HarnessDock layoutName="fixture" />
    </div>
  </NuqsAdapter>,
);

import { expect, it } from 'vitest';
import { recordExpertiseRoutingInvocation } from '@papercusp/operator-core/lib/endpoint-route/telemetry';

it('exports the expertise-routing recorder through the operator-core package path', () => {
  expect(recordExpertiseRoutingInvocation).toBeTypeOf('function');
});

import { describe, expect, it } from 'vitest';
import {
  AWS_CUSTOMER_SETUP_CONNECTION_FIELDS,
  awsCustomerSetupTemplate,
} from '../../../workspace-host/aws-customer-setup-template';
import routeDefinition from './aws-setup-template';

type Route = {
  method: string;
  path: string;
  auth: string;
  handler: (request: Request, context: { params: Record<string, string> }) => Promise<Response>;
};

const route = routeDefinition as unknown as Route;

function get(query: string): Promise<Response> {
  return route.handler(new Request(`http://127.0.0.1/api/workspace-hosts/aws-setup-template?${query}`), { params: {} });
}

describe('GET /workspace-hosts/aws-setup-template (P-013 / D-011)', () => {
  it('is a loopback GET beside the other workspace-host routes', () => {
    expect(route.method).toBe('GET');
    expect(route.path).toBe('/workspace-hosts/aws-setup-template');
    expect(route.auth).toBe('loopback');
  });

  it('downloads the same template the builder produces, with the stack name and field mapping', async () => {
    const response = await get('accountId=123456789012&region=us-east-1');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="papercusp-workspace-host-123456789012-us-east-1.cloudformation.json"',
    );
    expect(response.headers.get('x-papercusp-stack-name')).toBe('papercusp-workspace-host-us-east-1');
    expect(JSON.parse(response.headers.get('x-papercusp-connection-fields') ?? '{}'))
      .toEqual(AWS_CUSTOMER_SETUP_CONNECTION_FIELDS);
    expect(await response.json()).toEqual(
      awsCustomerSetupTemplate({ accountId: '123456789012', region: 'us-east-1' }).document,
    );
  });

  it('honours a named principal and refuses bad input with a 400', async () => {
    const principal = 'arn:aws:iam::123456789012:user/alice';
    const named = await get(`accountId=123456789012&region=us-east-1&principalArn=${encodeURIComponent(principal)}`);
    expect(JSON.stringify(await named.json())).toContain(principal);

    for (const query of ['region=us-east-1', 'accountId=123456789012', 'accountId=123456789012&region=cn-north-1',
      'accountId=123456789012&region=us-east-1&principalArn=arn:aws:iam::999999999999:root']) {
      const response = await get(query);
      expect(response.status, query).toBe(400);
      expect(((await response.json()) as { error: string }).error).toMatch(/accountId|region|principalArn/);
    }
  });
});

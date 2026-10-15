/**
 * Pins the public Cloud workspaces page (apps/papercusp-docs) to the code it describes
 * (plan aws-byoc-gcp-parity-2026-10-01, P-013 / D-011). The page explains permissions by service and
 * names template outputs; both are code-describing claims that drift silently when the code moves,
 * so each is checked in BOTH directions here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AWS_WORKSPACE_HOST_PERMISSION_ACTIONS } from '../workspace-host/aws-connection';
import {
  AWS_CUSTOMER_SETUP_CONNECTION_FIELDS,
  awsCustomerSetupTemplate,
} from '../workspace-host/aws-customer-setup-template';
import { AWS_SPOT_SERVICE_LINKED_ROLE_ACTION } from '../workspace-host/hosted-aws-host-stack';
import { buildHostedProviderDelegationOnboarding } from '../workspace-host/hosted-provider-delegation';

const REPO = new URL('../../../../', import.meta.url);
const PAGE = readFileSync(new URL('apps/papercusp-docs/src/content/docs/cloud-workspaces.mdx', REPO), 'utf8');

/** Rows of the markdown table whose header row contains `header`. */
function tableRows(header: string): string[][] {
  const lines = PAGE.split('\n').map((line) => line.trim());
  const start = lines.findIndex((line) => line.startsWith('|') && line.includes(header));
  expect(start, `table with header "${header}"`).toBeGreaterThanOrEqual(0);
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(line.split('|').slice(1, -1).map((cell) => cell.trim()));
  }
  return rows;
}

describe('Cloud workspaces docs page ↔ code', () => {
  it('names every AWS service the least-privilege policy uses, and no service it does not', () => {
    const codePrefixes = new Set(AWS_WORKSPACE_HOST_PERMISSION_ACTIONS.map((action) => action.split(':')[0]));
    const pagePrefixes = new Set(
      tableRows('Action prefix').map((row) => /^`([a-z0-9]+):`$/.exec(row[1] ?? '')?.[1] ?? `unparsed:${row[1]}`),
    );
    expect([...pagePrefixes].sort()).toEqual([...codePrefixes].sort());
  });

  it('names exactly the setup template outputs the desktop connection form takes', () => {
    const pageOutputs = tableRows('Stack output').map((row) => /^`([A-Za-z]+)`$/.exec(row[0] ?? '')?.[1] ?? row[0]);
    expect([...pageOutputs].sort()).toEqual(Object.keys(AWS_CUSTOMER_SETUP_CONNECTION_FIELDS).sort());
    const outputs = awsCustomerSetupTemplate({ accountId: '123456789012', region: 'us-east-1' }).document
      .Outputs as Record<string, unknown>;
    for (const name of pageOutputs) expect(outputs, `template Output ${name}`).toHaveProperty(name);
  });

  it('names the GCP custom role the hosted template actually creates', () => {
    const delegation = readFileSync(
      new URL('packages/operator-core/lib/workspace-host/hosted-provider-delegation.ts', REPO),
      'utf8',
    );
    const title = /title: '([^']+)'/.exec(delegation.slice(delegation.indexOf('const customRole')))?.[1];
    expect(title).toBeTruthy();
    expect(PAGE).toContain(`**${title}**`);
  });

  it('describes the hosted AWS role template that grants exactly the policy actions and requires the ExternalId', () => {
    // Spec AWSP-P-013-cfn-policy-parity targets "the Papercusp role": the role Papercusp itself
    // assumes from app.papercusp.com. Its template is the hosted one (D-007 ExternalId), and the
    // page's app.papercusp.com steps are the guide that references it.
    const trustedPrincipalArn = 'arn:aws:iam::999999999999:role/PapercuspControlPlane';
    const { template } = buildHostedProviderDelegationOnboarding({
      organizationId: 'org-a',
      workspaceId: 'workspace-1',
      connectionId: 'connection-1',
      label: 'Docs claim',
      credentialRef: 'encrypted://workspace-1/cloud/connection-1',
      now: '2026-10-02T00:00:00.000Z',
      configuration: {
        provider: 'aws',
        accountId: '123456789012',
        source: {
          environment: 'hosted',
          method: 'customer-role',
          roleArn: 'arn:aws:iam::123456789012:role/PapercuspWorkspaceHost',
          trustedPrincipalArn,
          externalIdRef: 'resolver://aws-external-id/org-a',
        },
      },
    });
    expect(template.format).toBe('aws-cloudformation-json');
    type Statement = { Principal?: { AWS?: unknown }; Action?: unknown; Condition?: unknown };
    type Role = {
      Type?: string;
      Properties?: {
        AssumeRolePolicyDocument?: { Statement?: Statement[] };
        Policies?: Array<{ PolicyDocument?: { Statement?: Statement[] } }>;
      };
    };
    const resources = Object.values((template.document as { Resources: Record<string, Role> }).Resources);
    const papercuspRoles = resources.filter(
      (resource) =>
        resource.Type === 'AWS::IAM::Role' &&
        resource.Properties?.AssumeRolePolicyDocument?.Statement?.some(
          (statement) => statement.Principal?.AWS === trustedPrincipalArn,
        ),
    );
    expect(papercuspRoles).toHaveLength(1);
    const role = papercuspRoles[0]!.Properties!;
    expect(role.AssumeRolePolicyDocument?.Statement?.[0]?.Condition).toEqual({
      StringEquals: { 'sts:ExternalId': { Ref: 'ExternalId' } },
    });
    const granted = (role.Policies ?? []).flatMap((policy) =>
      (policy.PolicyDocument?.Statement ?? []).flatMap((statement) => statement.Action as string[]),
    );
    // The client's own action list, plus creating EC2's Spot service-linked role (WI-10005389).
    expect([...granted].sort()).toEqual(
      [...AWS_WORKSPACE_HOST_PERMISSION_ACTIONS, AWS_SPOT_SERVICE_LINKED_ROLE_ACTION].sort(),
    );

    const hostedAws = PAGE.slice(PAGE.indexOf('### From app.papercusp.com'), PAGE.indexOf('### From the desktop app'));
    expect(hostedAws.length, 'the AWS "From app.papercusp.com" steps').toBeGreaterThan(0);
    expect(hostedAws).toContain('ExternalId');
    expect(hostedAws).toContain('**Download the setup file**');
  });

  it('is reachable from the docs sidebar', () => {
    const config = readFileSync(new URL('apps/papercusp-docs/astro.config.mjs', REPO), 'utf8');
    expect(config).toContain("'cloud-workspaces'");
  });
});

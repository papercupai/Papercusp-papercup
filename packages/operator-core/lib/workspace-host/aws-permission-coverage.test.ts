/**
 * Every AWS API the workspace-host client and the hosted stack discovery call AS THE CUSTOMER
 * ROLE must be granted by the role the customer creates (aws-byoc-gcp-parity D-009). Measured
 * 2026-10-02: five calls (DescribeSecurityGroups, GetConsoleOutput, GetAWSDefaultServiceQuota,
 * GetProducts, SimulatePrincipalPolicy) were made but not granted, so they would have failed
 * with AccessDenied only on a real account. This reads the SDK commands each module imports and
 * sends, and fails when one is missing from AWS_WORKSPACE_HOST_PERMISSION_ACTIONS. Both modules
 * also load clients lazily (a destructured `await import(…)` / `require(…)`, or a
 * `const ec2Sdk = () => require(…)` helper used as `new (ec2Sdk().XCommand)(…)`); those are read
 * too, and any `new …Command(` form the scan cannot attribute fails instead of dropping out.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AWS_WORKSPACE_HOST_PERMISSION_ACTIONS } from './aws-connection';

/** IAM action prefix for each SDK client package. */
const SERVICE_PREFIX: Record<string, string> = {
  ec2: 'ec2',
  iam: 'iam',
  kms: 'kms',
  pricing: 'pricing',
  'service-quotas': 'servicequotas',
  ssm: 'ssm',
  sts: 'sts',
};
/** Calls that need no IAM permission at all. */
const NO_PERMISSION_NEEDED = new Set(['sts:GetCallerIdentity']);

const MODULES = ['./aws-sdk-client.ts', './hosted-aws-host-discovery.ts'];

function servicePrefix(client: string): string {
  const prefix = SERVICE_PREFIX[client];
  if (!prefix) throw new Error(`unmapped SDK client @aws-sdk/client-${client}`);
  return prefix;
}

function requiredAwsActions(source: string): string[] {
  const serviceOf = new Map<string, string>();
  const addCommands = (names: string, prefix: string) => {
    for (const name of names.split(',').map((part) => part.trim().replace(/^type\s+/, ''))) {
      if (name.endsWith('Command')) serviceOf.set(name, prefix);
    }
  };
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@aws-sdk\/client-([a-z0-9-]+)'/g)) {
    addCommands(match[1]!, servicePrefix(match[2]!));
  }
  // const { XCommand } = await import('@aws-sdk/client-ec2') — or the same through require(…).
  for (const match of source.matchAll(/const\s*\{([^}]*)\}\s*=\s*[^;]*?'@aws-sdk\/client-([a-z0-9-]+)'/g)) {
    addCommands(match[1]!, servicePrefix(match[2]!));
  }
  // const ec2Sdk = () => (… require('@aws-sdk/client-ec2') …), used as new (ec2Sdk().XCommand)(…).
  const helperOf = new Map<string, string>();
  for (const match of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*\(\)\s*=>[^;]*?'@aws-sdk\/client-([a-z0-9-]+)'/g)) {
    helperOf.set(match[1]!, servicePrefix(match[2]!));
  }
  const actions = new Set<string>();
  let read = 0;
  for (const match of source.matchAll(/new\s*\(?\s*(?:([A-Za-z_$][\w$]*)\(\)\s*\.\s*)?([A-Z][A-Za-z0-9]*Command)\s*\)?\s*\(/g)) {
    read++;
    const command = match[2]!;
    const prefix = match[1] ? helperOf.get(match[1]) : serviceOf.get(command);
    if (!prefix) throw new Error(`command ${command} is not imported from a mapped SDK client`);
    const action = `${prefix}:${command.slice(0, -'Command'.length)}`;
    if (!NO_PERMISSION_NEEDED.has(action)) actions.add(action);
  }
  // Fail closed: a construction in any other form (e.g. new sdk.XCommand(…)) must not drop out silently.
  const constructions = source.match(/\bnew\b[^;{}]*?\b[A-Z][A-Za-z0-9]*Command\s*\)?\s*\(/g) ?? [];
  if (constructions.length !== read) {
    throw new Error(`${constructions.length - read} command construction(s) in a form this scan does not read`);
  }
  return [...actions].sort();
}

describe('AWS workspace-host permission coverage (D-009)', () => {
  it.each(MODULES)('grants every AWS call %s makes as the customer role', (module) => {
    const source = readFileSync(fileURLToPath(new URL(module, import.meta.url)), 'utf8');
    const required = requiredAwsActions(source);
    // A positive control: the scan must actually find calls, or a broken regex passes vacuously.
    expect(required.length).toBeGreaterThan(3);
    const granted = new Set<string>(AWS_WORKSPACE_HOST_PERMISSION_ACTIONS);
    expect(required.filter((action) => !granted.has(action))).toEqual([]);
  });

  it('catches a call that the role does not grant', () => {
    const source = [
      "import { DescribeVpcsCommand, DescribeSubnetsCommand } from '@aws-sdk/client-ec2';",
      "import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';",
      'await ec2.send(new DescribeVpcsCommand({}));',
      'await ec2.send(new DescribeSubnetsCommand({}));',
      'await sts.send(new GetCallerIdentityCommand({}));',
    ].join('\n');
    const required = requiredAwsActions(source);
    expect(required).toEqual(['ec2:DescribeSubnets', 'ec2:DescribeVpcs']);
    const granted = new Set<string>(AWS_WORKSPACE_HOST_PERMISSION_ACTIONS);
    expect(required.filter((action) => !granted.has(action))).toEqual(['ec2:DescribeVpcs']);
  });

  it('reads lazily loaded clients and fails on a construction form it cannot read', () => {
    const lazy = [
      "const ec2Sdk = () => require('@aws-sdk/client-ec2') as typeof import('@aws-sdk/client-ec2');",
      "const { DescribeSubnetsCommand } = await import('@aws-sdk/client-ec2');",
      'await ec2.send(new (ec2Sdk().DescribeVpcsCommand)({}));',
      'await ec2.send(new DescribeSubnetsCommand({}));',
    ].join('\n');
    expect(requiredAwsActions(lazy)).toEqual(['ec2:DescribeSubnets', 'ec2:DescribeVpcs']);
    expect(() => requiredAwsActions('await ec2.send(new sdk.DescribeVpcsCommand({}));')).toThrow(
      /form this scan does not read/,
    );
  });
});

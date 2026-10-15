// @vitest-environment jsdom

import type { JSX } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ ...options }),
}));
vi.mock('../../components/admin/AdminShell', () => ({
  default: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div data-testid="admin-shell" data-title={title}>{children}</div>
  ),
}));
vi.mock('@/app/admin/governance-policy/GovernancePolicyAdmin', () => ({
  default: () => <div data-testid="governance-policy-admin" />,
}));

import { Route } from './governance-policy';

const Component = (Route as unknown as { component: () => JSX.Element }).component;

afterEach(() => cleanup());

describe('/admin/governance-policy desktop route', () => {
  // P-005: without this route the pane is unreachable in the desktop (the SPA renders its
  // fallback for an unknown path).
  it('renders GovernancePolicyAdmin inside the Vite AdminShell', () => {
    render(<Component />);
    expect(screen.getByTestId('admin-shell').getAttribute('data-title')).toBe('Governance policy');
    expect(screen.getByTestId('governance-policy-admin')).toBeTruthy();
  });
});

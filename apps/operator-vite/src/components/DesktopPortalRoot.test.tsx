// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
vi.mock('virtual:desktop-portal-entry', () => ({
  default: ({ localMode }: { localMode?: boolean }) => <div data-testid="portal">{localMode ? 'local' : 'hosted'}</div>,
}));
import DesktopPortalRoot from './DesktopPortalRoot';

describe('desktop portal presentation', () => {
  it('selects the shared shell local profile and reserves the native environment bar height', () => {
    const { container } = render(<DesktopPortalRoot />);
    expect(screen.getByTestId('portal').textContent).toBe('local');
    const shell = container.querySelector('[data-desktop-interface="portal-candidate"]') as HTMLElement;
    expect(shell.style.height).toContain('--pc-env-bar-h');
  });
});

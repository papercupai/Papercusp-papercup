// @vitest-environment jsdom
/**
 * A trigger pack's section on Settings → Integrations (cupboard-distributable-integrations-2026-10-10
 * P-005) re-reads the page after its OWN successful save or arm. It must not wait on the server's
 * push: the sync bus drops a repeat of the same invalidation inside its dedupe window, so a save
 * shortly after another integrations write left the form dirty and Save enabled (headless P-005
 * attempt 3, run 20261011T103518Z-4079039, "pack settings did not save").
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AvailableTriggerPack, TriggerPackSettings } from '@papercusp/operator-core/lib/cupboard/trigger-pack-lifecycle';

const H = vi.hoisted(() => ({
  save: vi.fn(),
  arm: vi.fn(),
  setUp: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('./ticket-integrations-client', () => ({
  saveTriggerPackInputs: H.save,
  armTriggerPackRequest: H.arm,
  setUpTriggerPackRequest: H.setUp,
  IntegrationRequestError: class IntegrationRequestError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { TriggerPackSection, TriggerPackSetup } from './TriggerPackSection';

function pack(overrides: Partial<TriggerPackSettings> = {}): TriggerPackSettings {
  return {
    installationId: 'inst-1',
    harnessSlug: 'pack-home',
    pluginName: 'fixture-pack',
    pluginVersion: '0.1.0',
    status: 'configured',
    inputsSchema: { type: 'object', properties: { note: { type: 'string', title: 'Note' } } },
    inputs: {},
    state: {
      fingerprint: 'f'.repeat(64),
      current: false,
      bindingCount: 1,
      armedBindingCount: 0,
      review: { unmet: [], bindings: [], recipients: [] },
    },
    ...overrides,
  } as unknown as TriggerPackSettings;
}

afterEach(() => {
  cleanup();
  H.save.mockReset();
  H.arm.mockReset();
  H.setUp.mockReset();
});

describe('TriggerPackSection refreshes the page after its own write', () => {
  it('a successful save re-reads the page once, with the values that were saved', async () => {
    H.save.mockResolvedValue({ installationId: 'inst-1', status: 'configured', unmet: [], armed: false });
    const onChanged = vi.fn();
    render(<TriggerPackSection pack={pack()} onChanged={onChanged} />);

    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(H.save).toHaveBeenCalledWith('inst-1', { note: 'hello' });
  });

  it('a refused save does not re-read the page', async () => {
    H.save.mockRejectedValue(new Error('trigger_pack_invalid'));
    const onChanged = vi.fn();
    render(<TriggerPackSection pack={pack()} onChanged={onChanged} />);

    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(H.save).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement).disabled).toBe(false));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('a successful arm re-reads the page once', async () => {
    H.arm.mockResolvedValue({ armedBindingIds: ['b1'] });
    const onChanged = vi.fn();
    render(<TriggerPackSection pack={pack()} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole('button', { name: 'Arm fixture-pack' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(H.arm).toHaveBeenCalledWith('inst-1', 'f'.repeat(64));
  });
});

// A pack the Cupboard installed without a project (cupboard-distributable-integrations-2026-10-10
// D-017, WI-6554700010008548): its section shows its declared settings and a project picker, and
// Set up posts both.
describe('TriggerPackSetup', () => {
  const available: AvailableTriggerPack = {
    pluginName: '@papercupai/bug-triage',
    pluginVersion: '0.1.0',
    description: 'Files bugs reported in chat.',
    inputsSchema: { type: 'object', properties: { note: { type: 'string', title: 'Note' } } },
  };

  it('renders as the pack’s section with its settings, and sets it up in the only project', async () => {
    H.setUp.mockResolvedValue({ installationId: 'inst-2', status: 'configured', unmet: [], armed: false });
    const onChanged = vi.fn();
    const { container } = render(<TriggerPackSetup pack={available} harnesses={['pack-home']} onChanged={onChanged} />);

    const section = container.querySelector('[data-trigger-pack="@papercupai/bug-triage"]');
    expect(section?.getAttribute('data-trigger-pack-state')).toBe('not-set-up');
    expect(screen.getByText('Not set up')).toBeTruthy();
    expect(screen.getByText('Files bugs reported in chat.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set up @papercupai/bug-triage' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(H.setUp).toHaveBeenCalledWith('@papercupai/bug-triage', 'pack-home', { note: 'hello' });
  });

  it('cannot be set up until a project is picked when there is more than one', () => {
    render(<TriggerPackSetup pack={available} harnesses={['alpha', 'beta']} />);
    expect((screen.getByRole('button', { name: 'Set up @papercupai/bug-triage' }) as HTMLButtonElement).disabled).toBe(true);
    expect(H.setUp).not.toHaveBeenCalled();
  });

  it('a refused set-up does not re-read the page', async () => {
    H.setUp.mockRejectedValue(new Error('harness_not_found'));
    const onChanged = vi.fn();
    render(<TriggerPackSetup pack={available} harnesses={['pack-home']} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole('button', { name: 'Set up @papercupai/bug-triage' }));

    await waitFor(() => expect(H.setUp).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Set up @papercupai/bug-triage' }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(onChanged).not.toHaveBeenCalled();
  });
});

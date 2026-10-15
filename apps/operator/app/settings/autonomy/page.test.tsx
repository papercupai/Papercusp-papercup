// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/app/harness/Select', () => ({
  Select: ({ value, onChange, ariaLabel, options, disabled }: any) => (
    <select aria-label={ariaLabel} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));
vi.mock('@/app/harness/Button', () => ({ Button: (props: any) => <button {...props} /> }));
import Page from './page';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function servePolicy(failSave = false) {
  let policy: any = { level: 'L0', minConfidence: 'high' };
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.op === 'set' && failSave) return { ok: false, json: async () => ({ error: 'Persistence unavailable' }) };
    if (body.op === 'set') {
      policy = { ...policy, riskLevels: body.riskLevels };
      return { ok: true, json: async () => ({ applied: true, verify: { ok: true }, next: policy }) };
    }
    return { ok: true, json: async () => ({ policy }) };
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

describe('Queue cleanup autonomy settings', () => {
  it('reads the saved policy and persists independent choices with a readback', async () => {
    const fetcher = servePolicy();
    render(<Page />);
    const low = await screen.findByRole('combobox', { name: 'Low risk autonomy' });
    expect((low as HTMLSelectElement).value).toBe('review');
    fireEvent.change(low, { target: { value: 'automatic' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByText(/Saved. Eligible recommendations/);
    const writes = fetcher.mock.calls.map((call) => JSON.parse(String(call[1].body))).filter((x) => x.op === 'set');
    expect(writes).toEqual([{ op: 'set', riskLevels: { low: 'automatic', medium: 'review', high: 'review' } }]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('full autonomy grants every risk and survives a reload', async () => {
    servePolicy();
    const first = render(<Page />);
    fireEvent.click(await screen.findByRole('button', { name: 'Full autonomy for all risk levels' }));
    await screen.findByText(/Saved. Eligible recommendations/);
    first.unmount();
    render(<Page />);
    for (const label of ['Low', 'Medium', 'High']) {
      const control = await screen.findByRole('combobox', { name: label + ' risk autonomy' });
      expect((control as HTMLSelectElement).value).toBe('automatic');
    }
  });

  it('reports a save failure without claiming the grant applied', async () => {
    servePolicy(true);
    render(<Page />);
    fireEvent.click(await screen.findByRole('button', { name: 'Full autonomy for all risk levels' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Persistence unavailable'));
    expect(screen.queryByText(/Saved. Eligible/)).toBeNull();
  });
});

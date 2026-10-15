// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Table, type TableColumn } from './Table';

interface WorklistRow {
  id: string;
  label: string;
}

const columns: TableColumn<WorklistRow>[] = [
  { key: 'plan', header: 'Plan', render: (row) => row.label },
];

afterEach(cleanup);

describe('Table', () => {
  it('keeps an accessible name and caller data attributes on each row', () => {
    render(
      <Table
        ariaLabel="Ongoing worklist"
        columns={columns}
        rows={[{ id: 'plan:h/search', label: 'Search reliability' }]}
        getRowKey={(row) => row.id}
        rowDataAttributes={(row) => ({ 'data-worklist-id': row.id })}
      />,
    );

    expect(screen.getByRole('table', { name: 'Ongoing worklist' })).toBeTruthy();
    const rows = screen.getAllByRole('row');
    expect(rows[1].getAttribute('data-worklist-id')).toBe('plan:h/search');
  });
});

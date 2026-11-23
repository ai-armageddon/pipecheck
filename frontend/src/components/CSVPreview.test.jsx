import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import axios from 'axios';
import CSVPreview from './CSVPreview';

jest.mock('axios', () => ({ get: jest.fn() }));
const run = { run_id: 'example', filename: 'workbook.xlsx', status: 'completed', errors_count: 1 };
const row = { row_index: 12, original: { sku: 'low', units: 0 }, values: { sku: 'LOW', units: 0 }, fixes: [], needs_review: false };

test('workbook without a local preview can be paged and compared', async () => {
  axios.get.mockResolvedValueOnce({ data: { total: 11, rows: [row] } })
    .mockResolvedValueOnce({ data: { total: 11, rows: [{ ...row, row_index: 13 }] } });
  render(<CSVPreview run={run} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Compare row 13' }));
  expect(screen.getByText('low')).toBeTruthy();
  fireEvent.click(screen.getByText('Next'));
  expect(await screen.findByRole('button', { name: 'Compare row 14' })).toBeTruthy();
  expect(axios.get).toHaveBeenLastCalledWith(expect.stringContaining('/example/review'),
    expect.objectContaining({ params: { view: 'processed', offset: 10, limit: 10 } }));
});

test('all-rejected run displays zero processed rows and supports issue filtering', async () => {
  axios.get.mockResolvedValue({ data: { total: 0, rows: [] } });
  render(<CSVPreview run={run} data={'id,qty\na,0,extra'} />);
  expect(await screen.findByText('No rows to display.')).toBeTruthy();
  fireEvent.click(screen.getByText('Issues (1)'));
  fireEvent.change(screen.getByRole('combobox', { name: 'Filter issues' }), { target: { value: 'rejected' } });
  await waitFor(() => expect(axios.get).toHaveBeenLastCalledWith(expect.any(String),
    expect.objectContaining({ params: { view: 'rejected', offset: 0, limit: 10 } })));
});

test('failed requests can be retried', async () => {
  axios.get.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ data: { total: 1, rows: [row] } });
  render(<CSVPreview run={run} />);
  fireEvent.click(await screen.findByText('Retry'));
  expect(await screen.findByRole('button', { name: 'Compare row 13' })).toBeTruthy();
});

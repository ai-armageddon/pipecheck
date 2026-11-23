import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import axios from 'axios';
import ProviderSettings from './ProviderSettings';

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));

test('starts native sign-in and enables selection after the CLI confirms login', async () => {
  const info = { default: 'off', states: { off: 'ready', groq: 'missing_key', claude: 'not_installed', codex: 'signed_out' } };
  axios.get.mockResolvedValueOnce({ data: info })
    .mockResolvedValueOnce({ data: { ...info, connections: { codex: 'pending' } } })
    .mockResolvedValue({ data: { ...info, states: { ...info.states, codex: 'subscription' }, connections: { codex: 'finished' } } });
  axios.post.mockResolvedValue({ data: { connection: 'pending' } });
  const onChange = jest.fn();
  render(<ProviderSettings provider="off" onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'AI repair provider' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Connect ChatGPT subscription' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/providers/codex/connect'),
    null, { headers: { 'X-PipeCheck-Provider': 'codex' } }));
  expect(await screen.findByText(/Finish sign-in/)).toBeTruthy();
  const connected = await screen.findByRole('radio', { name: /Codex Subscription connected/ }, { timeout: 5000 });
  fireEvent.click(connected);
  expect(onChange).toHaveBeenCalledWith('codex');
});

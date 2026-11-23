import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { SlidersHorizontal } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';

export const providerNames = { off: 'Local cleanup only', groq: 'Groq', claude: 'Claude Code', codex: 'Codex' };
const ready = new Set(['ready', 'subscription', 'authenticated', 'configured']);
const statusText = {
  ready: 'On-device cleanup', subscription: 'Subscription connected', authenticated: 'CLI signed in',
  configured: 'API key configured', missing_key: 'API key needed', local_only: 'Open on the backend machine',
  not_installed: 'CLI installation needed', signed_out: 'Sign-in needed', unavailable: 'Connection check failed',
};

export default function ProviderSettings({ provider, onChange }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState(null);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [starting, setStarting] = useState({});
  const [connectError, setConnectError] = useState('');
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setFailed(false);
    let timer;
    const load = async () => {
      try {
        const { data } = await axios.get(apiUrl('/providers'), { signal: controller.signal });
        if (controller.signal.aborted) return;
        setInfo(data);
        if (Object.values(data.connections || {}).includes('pending')) timer = setTimeout(load, 2000);
      } catch {
        if (!controller.signal.aborted) {
          setInfo(null);
          setFailed(true);
        }
      }
    };
    load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [open, refresh]);
  const connect = async id => {
    setConnectError('');
    setStarting(prev => ({ ...prev, [id]: true }));
    try {
      const { data } = await axios.post(apiUrl(`/providers/${id}/connect`), null,
        { headers: { 'X-PipeCheck-Provider': id } });
      setInfo(prev => prev && ({ ...prev, connections: { ...prev.connections, [id]: data.connection } }));
      setRefresh(n => n + 1);
    } catch (error) {
      setConnectError(error.response?.data?.detail || `Could not start ${providerNames[id]} sign-in.`);
    } finally {
      setStarting(prev => ({ ...prev, [id]: false }));
    }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <button className="btn-outline h-9 px-2.5 text-xs sm:px-3" onClick={() => setOpen(true)} aria-label="AI repair provider">
        <SlidersHorizontal className="h-4 w-4" />
        <span className="hidden sm:inline">{providerNames[provider] || 'AI provider'}</span>
      </button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>AI repair provider</DialogTitle>
          <DialogDescription>Choose how to repair uploads and reprocessed runs from this browser. AI providers receive the affected row or a file sample when local cleanup needs help.</DialogDescription>
        </DialogHeader>
        {info ? (
          <fieldset className="space-y-2">
            <legend className="sr-only">Provider for future runs</legend>
            {Object.entries(providerNames).map(([id, name]) => (
              <div key={id} className="rounded-xl border border-slate-200 p-3">
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" name="provider" checked={(provider || info.default) === id}
                    disabled={!ready.has(info.states[id])} onChange={() => onChange(id)} />
                  <strong>{name}</strong>
                  <span className="ml-auto text-right text-xs text-slate-500">{statusText[info.states[id]]}</span>
                </label>
                {['claude', 'codex'].includes(id) && ['signed_out', 'authenticated'].includes(info.states[id]) && (
                  <div className="mt-2">
                    <button className="btn-outline px-3 py-1.5 text-xs"
                      disabled={starting[id] || info.connections?.[id] === 'pending'}
                      onClick={() => connect(id)}>Connect {id === 'claude' ? 'Claude' : 'ChatGPT'} subscription</button>
                    {info.connections?.[id] === 'pending' && (
                      <p role="status" className="mt-2 text-xs">Finish sign-in in the browser opened by {providerNames[id]}. This panel updates automatically.</p>
                    )}
                    {['failed', 'finished'].includes(info.connections?.[id]) && (
                      <p role="status" className="mt-2 text-xs">Subscription sign-in was not confirmed. Retry or run <code>{id === 'claude' ? 'claude auth login' : 'codex login'}</code> locally.</p>
                    )}
                  </div>
                )}
                {info.states[id] === 'not_installed' && (
                  <p className="mt-2 text-xs text-slate-600">Install the {providerNames[id]} CLI on the backend machine, then refresh connections.</p>
                )}
                {id === 'groq' && info.states.groq === 'missing_key' && (
                  <span className="mt-2 block text-xs text-slate-600">Set GROQ_API_KEY in backend/.env and restart the API.</span>
                )}
              </div>
            ))}
          </fieldset>
        ) : <p role="status" className="text-sm text-slate-600">{failed ? 'Could not reach the backend.' : 'Checking provider connections…'}</p>}
        {connectError && <p role="alert" className="text-sm text-rose-700">{connectError}</p>}
        <div className="flex justify-between gap-2">
          <button className="btn-outline px-3 py-2 text-sm" onClick={() => setRefresh(n => n + 1)}>Refresh connections</button>
          <button className="btn-primary px-3 py-2 text-sm" onClick={() => setOpen(false)}>Done</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

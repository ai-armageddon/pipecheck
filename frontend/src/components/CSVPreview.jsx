import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Download, Flag } from 'lucide-react';
import { parseCsv } from '../lib/csv';
import { apiUrl } from '../lib/api';

function cell(value) {
  if (value === null || value === undefined || value === '') return <span className="text-slate-400">—</span>;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export default function CSVPreview({ run, data, onExport, onExportErrors, showFlagged = false }) {
  const [tab, setTab] = useState(showFlagged ? 'issues' : 'processed');
  const [filter, setFilter] = useState(showFlagged ? 'flagged' : 'issues');
  const [page, setPage] = useState(0);
  const [limit, setLimit] = useState(10);
  const [showHeaders, setShowHeaders] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [result, setResult] = useState(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const view = tab === 'issues' ? filter : tab;
  const busy = run.status === 'processing' || run.status === 'pending';
  const source = useMemo(() => tab === 'original' && data ? parseCsv(data) : null, [data, tab]);

  useEffect(() => {
    setExpanded(null);
    setFailed(false);
    setResult(null);
    if (view === 'original' || busy) return;
    const controller = new AbortController();
    axios.get(apiUrl(`/runs/${run.run_id}/review`), {
      params: { view, offset: page * limit, limit }, signal: controller.signal,
    }).then(({ data }) => {
      if (controller.signal.aborted) return;
      if (page && page * limit >= data.total) setPage(0);
      else setResult(data);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [run.run_id, run.completed_at, busy, view, page, limit, retry]);

  const rows = result?.rows || [];
  const headers = source?.headers || [...new Set(rows.flatMap(row => Object.keys(row.values || {})))];
  const total = source?.rows.length ?? result?.total ?? 0;
  const sourceRows = source?.rows.slice(page * limit, (page + 1) * limit) || [];
  const issues = tab === 'issues';
  const tabs = [['processed', 'Processed'], ['issues', `Issues (${run.errors_count})`], ...(data ? [['original', 'Original']] : [])];
  return (
    <section aria-label="Run review" className="card animate-rise overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-4">
        <div className="min-w-0"><h2 className="card-title text-lg">Run review</h2>
          <p className="break-all text-sm text-slate-500">{run.filename}</p></div>
        <div className="flex flex-wrap gap-2">
          <a className="btn-outline px-3 py-1.5 text-xs" href={apiUrl(`/runs/${run.run_id}/source`)}><Download size={14} /> Original file</a>
          {tab !== 'original' && total > 0 && (
            <button className="btn-outline px-3 py-1.5 text-xs" onClick={() => (issues ? onExportErrors : onExport)(run.run_id)}>
              <Download size={14} /> {issues ? 'Export all issues' : 'Export processed CSV'}
            </button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
        <div className="segmented">{tabs.map(([id, label]) => (
          <button key={id} aria-pressed={tab === id} onClick={() => { setTab(id); setPage(0); }}
            className={`segmented-item ${id === tab ? 'segmented-item-active' : ''}`}>{label}</button>
        ))}</div>
        {issues ? <select aria-label="Filter issues" className="input px-2 py-1 text-sm" value={filter} onChange={e => { setFilter(e.target.value); setPage(0); }}>
          <option value="issues">All issues</option><option value="flagged">Needs review</option><option value="rejected">Rejected</option>
        </select> : <label className="text-sm"><input type="checkbox" className="mr-1" checked={showHeaders} onChange={e => setShowHeaders(e.target.checked)} /> Headers</label>}
      </div>
      {failed ? <div role="alert" className="p-5">Could not load this page. <button className="btn-outline px-2" onClick={() => setRetry(n => n + 1)}>Retry</button></div>
        : !source && !result ? <p role="status" className="p-5 text-sm text-slate-500">{busy ? 'Processing this upload…' : 'Loading rows…'}</p>
        : !total ? <p role="status" className="p-5 text-sm text-slate-500">{issues ? 'No matching issues.' : 'No rows to display.'}</p>
        : issues ? <ul className="divide-y divide-slate-100">{rows.map((row, i) => (
          <li className="p-4 text-sm" key={i}>
            <div className="mb-1 flex items-center gap-2"><strong>Row {row.row_index + 1}</strong>
              <span className={`chip ${row.code === 'NEEDS_REVIEW' ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800'}`}>{row.code}</span></div>
            <p>{row.message}</p><details className="mt-1"><summary className="cursor-pointer text-indigo-700">Source values</summary>
              <pre className="mt-1 whitespace-pre-wrap break-all text-xs">{JSON.stringify(row.original, null, 2)}</pre></details>
          </li>
        ))}</ul> : (
          <div className="overflow-x-auto"><table className="min-w-full text-left text-sm">
            {showHeaders && <thead className="bg-slate-50"><tr>{['Row', ...headers].map((h, i) => <th className="px-4 py-2" key={i}>{h}</th>)}</tr></thead>}
            <tbody>{(source ? sourceRows : rows).map((row, index) => {
              const number = (source ? page * limit + index : row.row_index) + 1;
              return <React.Fragment key={index}><tr className={`border-t border-slate-100 ${row.needs_review ? 'bg-amber-50' : ''}`}>
                <td className="whitespace-nowrap px-4 py-2">{source ? number : <button aria-expanded={expanded === index} aria-label={`Compare row ${number}`}
                  className="inline-flex items-center gap-1 font-semibold text-indigo-700 underline" onClick={() => setExpanded(expanded === index ? null : index)}>
                  {number}{row.needs_review && <Flag size={13} aria-label="Needs review" />}</button>}</td>
                {(source ? row : headers.map(key => row.values[key])).map((value, i) => <td className="max-w-sm break-words px-4 py-2" key={i}>{cell(value)}</td>)}
              </tr>{!source && expanded === index && <tr><td colSpan={headers.length + 1} className="bg-slate-50 p-4">
                <table className="text-left text-xs"><caption className="sr-only">Row {number} comparison</caption>
                  <thead><tr>{['Field', 'Source value', 'Processed value'].map(h => <th key={h} className="pr-4">{h}</th>)}</tr></thead>
                  <tbody>{[...new Set([...Object.keys(row.original), ...Object.keys(row.values)])].map(k => <tr key={k}>
                    <th className="pr-4">{k}</th><td className="pr-4">{cell(row.original[k])}</td><td>{cell(row.values[k])}</td></tr>)}</tbody>
                </table>{row.fixes.length > 0 && <ul className="mt-2 list-disc pl-4">{row.fixes.map((fix, i) => <li key={i}>{fix}</li>)}</ul>}
              </td></tr>}</React.Fragment>;
            })}</tbody></table></div>
        )}
      {total > 0 && <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 p-3 text-sm">
        <span>{page * limit + 1}–{Math.min((page + 1) * limit, total)} of {total.toLocaleString()}</span>
        <div className="flex items-center gap-2"><select aria-label="Rows per page" className="input px-2 py-1" value={limit} onChange={e => { setLimit(Number(e.target.value)); setPage(0); }}>
          {[5, 10, 25, 50].map(n => <option key={n} value={n}>{n} per page</option>)}</select>
          <button className="btn-outline px-2 py-1" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
          <button className="btn-outline px-2 py-1" disabled={(page + 1) * limit >= total} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      </div>}
    </section>
  );
}

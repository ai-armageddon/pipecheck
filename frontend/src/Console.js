import React, { useState, useEffect, useRef } from 'react';
import { Terminal, ChevronUp, ChevronDown, Copy } from 'lucide-react';

const Console = ({ logs, onClear, onClearPersisted, isExpanded, onToggle }) => {
  const consoleRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [persistedLogs, setPersistedLogs] = useState(0);

  // Auto-scroll to bottom when logs change or when expanded
  useEffect(() => {
    if (autoScroll && consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // Scroll to bottom when console is expanded
  useEffect(() => {
    if (isExpanded && consoleRef.current) {
      // Small delay to ensure the console is rendered
      setTimeout(() => {
        if (consoleRef.current) {
          consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
        }
      }, 50);
    }
  }, [isExpanded]);

  useEffect(() => {
    // Check how many logs are persisted
    const savedLogs = localStorage.getItem('csvConsoleLogs');
    if (savedLogs) {
      try {
        setPersistedLogs(JSON.parse(savedLogs).length);
      } catch (e) {
        setPersistedLogs(0);
      }
    }
  }, [logs]);

  const handleScroll = () => {
    if (consoleRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = consoleRef.current;
      const isAtBottom = scrollTop + clientHeight >= scrollHeight - 10;
      setAutoScroll(isAtBottom);
    }
  };

  const copyLogs = () => {
    const logText = logs.map(log => 
      `[${log.timestamp}] ${log.level.toUpperCase()}: ${log.message}`
    ).join('\n');
    
    navigator.clipboard.writeText(logText);
    // You could add a toast notification here
  };

  // Get last 3 logs for mini console
  const recentLogs = logs.slice(-3);

  const levelColor = (level) => (
    level === 'error' ? 'text-rose-400' :
    level === 'warn' ? 'text-amber-400' :
    level === 'info' ? 'text-sky-400' :
    'text-slate-400'
  );

  return (
    <div className="console-panel">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/80 px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-emerald-400" />
            <span className="text-sm font-medium text-slate-200">Console</span>
            <span className="hidden text-xs text-slate-500 min-[430px]:inline">({logs.length} messages)</span>
            {persistedLogs > 0 && (
              <span className="hidden text-xs text-emerald-400 min-[520px]:inline" title="Logs persisted in browser storage">
                ● {persistedLogs} saved
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={copyLogs}
            className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100"
            title="Copy logs"
          >
            <Copy className="w-4 h-4" />
          </button>
          <button
            onClick={onClear}
            className="hidden rounded-md px-2 py-1 text-xs font-medium text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100 sm:block"
            title="Clear current logs"
          >
            Clear
          </button>
          {onClearPersisted && (
            <button
              onClick={onClearPersisted}
              className="hidden rounded-md px-2 py-1 text-xs font-medium text-rose-400 transition-colors hover:bg-rose-500/10 hover:text-rose-300 sm:block"
              title="Clear persisted logs"
            >
              Clear All
            </button>
          )}
          <button
            onClick={onToggle}
            className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100"
            title={isExpanded ? "Minimize console" : "Expand console"}
          >
            {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Mini Console - Always visible when collapsed */}
      {!isExpanded && recentLogs.length > 0 && (
        <div className="space-y-1 border-b border-slate-800 bg-slate-950 px-3 py-2.5 sm:px-4">
          {recentLogs.map((log, index) => (
            <div key={index} className="flex items-start gap-2.5 text-xs font-mono">
              <span className="hidden shrink-0 tabular-nums text-slate-600 sm:inline">{log.timestamp}</span>
              <span className={`shrink-0 font-semibold ${levelColor(log.level)}`}>
                {log.level.toUpperCase()}
              </span>
              <span className="truncate text-slate-300">{log.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Full Console Content */}
      {isExpanded && (
        <div 
          ref={consoleRef}
          onScroll={handleScroll}
          className="console-dark h-64 overflow-y-auto bg-slate-950 p-4 font-mono text-xs"
        >
          {logs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-slate-500">
              <Terminal className="mb-2 h-6 w-6 text-slate-700" />
              No logs yet. Upload a file to see processing logs.
            </div>
          ) : (
            <div className="space-y-1">
              {logs.map((log, index) => (
                <div key={index} className="flex items-start gap-2.5">
                  <span className="shrink-0 tabular-nums text-slate-600">{log.timestamp}</span>
                  <span className={`shrink-0 font-semibold ${levelColor(log.level)}`}>
                    {log.level.toUpperCase()}
                  </span>
                  <span className="break-all text-slate-300">{log.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Footer with auto-scroll toggle */}
      {isExpanded && (
        <div className="flex items-center justify-end border-t border-slate-800 bg-slate-900/80 px-4 py-1.5">
          <label className="flex cursor-pointer items-center text-xs text-slate-400">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="mr-2 accent-indigo-500"
            />
            Auto-scroll
          </label>
        </div>
      )}
    </div>
  );
};

export default Console;

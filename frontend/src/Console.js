import React, { useState, useEffect, useRef } from 'react';
import { Terminal, ChevronUp, ChevronDown, Copy } from 'lucide-react';

const Console = ({ logs, onClear, onClearPersisted, isExpanded, onToggle }) => {
  const consoleRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [persistedLogs, setPersistedLogs] = useState(0);

  useEffect(() => {
    if (autoScroll && consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

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

  const getLogLevelClass = (level) => {
    switch (level) {
      case 'error':
        return 'text-red-400';
      case 'warn':
        return 'text-yellow-400';
      case 'info':
        return 'text-blue-400';
      case 'debug':
        return 'text-gray-400';
      default:
        return 'text-gray-300';
    }
  };

  // Get last 3 logs for mini console
  const recentLogs = logs.slice(-3);

  return (
    <div className="bg-black rounded-lg shadow-lg overflow-hidden border border-gray-800">
      {/* Header */}
      <div className="bg-gray-900 px-4 py-2 flex items-center justify-between border-b border-gray-800">
        <div className="flex items-center space-x-2">
          <Terminal className="w-4 h-4 text-green-400" />
          <span className="text-sm font-medium text-gray-300">Console</span>
          <span className="text-xs text-gray-500">({logs.length} messages)</span>
          {persistedLogs > 0 && (
            <span className="text-xs text-green-400" title="Logs persisted in browser storage">
              ● {persistedLogs} saved
            </span>
          )}
        </div>
        <div className="flex items-center space-x-2">
          <button
            onClick={copyLogs}
            className="p-1 text-gray-400 hover:text-white transition-colors"
            title="Copy logs"
          >
            <Copy className="w-4 h-4" />
          </button>
          <button
            onClick={onClear}
            className="p-1 text-gray-400 hover:text-white transition-colors"
            title="Clear current logs"
          >
            Clear
          </button>
          {onClearPersisted && (
            <button
              onClick={onClearPersisted}
              className="p-1 text-red-400 hover:text-red-300 transition-colors"
              title="Clear persisted logs"
            >
              Clear All
            </button>
          )}
          <button
            onClick={onToggle}
            className="p-1 text-gray-400 hover:text-white transition-colors"
            title={isExpanded ? "Minimize console" : "Expand console"}
          >
            {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Mini Console - Always visible when collapsed */}
      {!isExpanded && recentLogs.length > 0 && (
        <div className="bg-black px-3 py-2 border-b border-gray-800">
          {recentLogs.map((log, index) => (
            <div key={index} className="flex items-start space-x-2 text-xs font-mono">
              <span className="text-gray-500 shrink-0">{log.timestamp}</span>
              <span className={`shrink-0 ${
                log.level === 'error' ? 'text-red-400' :
                log.level === 'warn' ? 'text-yellow-400' :
                log.level === 'info' ? 'text-blue-400' :
                'text-gray-400'
              }`}>
                {log.level.toUpperCase()}
              </span>
              <span className="text-gray-300 truncate">{log.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Full Console Content */}
      {isExpanded && (
        <div 
          ref={consoleRef}
          onScroll={handleScroll}
          className="bg-black p-3 h-64 overflow-y-auto font-mono text-xs"
        >
          {logs.length === 0 ? (
            <div className="text-gray-500 text-center py-8">
              No logs yet. Upload a file to see processing logs.
            </div>
          ) : (
            <div className="space-y-1">
              {logs.map((log, index) => (
                <div key={index} className="flex items-start space-x-2">
                  <span className="text-gray-500 shrink-0">{log.timestamp}</span>
                  <span className={`shrink-0 ${
                    log.level === 'error' ? 'text-red-400' :
                    log.level === 'warn' ? 'text-yellow-400' :
                    log.level === 'info' ? 'text-blue-400' :
                    'text-gray-400'
                  }`}>
                    {log.level.toUpperCase()}
                  </span>
                  <span className="text-gray-300 break-all">{log.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Footer with auto-scroll toggle */}
      {isExpanded && (
        <div className="bg-gray-900 px-3 py-1 border-t border-gray-800 flex items-center justify-between">
          <label className="flex items-center text-xs text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="mr-2"
            />
            Auto-scroll
          </label>
        </div>
      )}
    </div>
  );
};

export default Console;

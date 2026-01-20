import React, { useState, useEffect, useRef } from 'react';
import { Terminal, ChevronUp, ChevronDown, Copy } from 'lucide-react';

const Console = ({ logs, onClear, isExpanded, onToggle }) => {
  const consoleRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

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

  return (
    <div className="bg-gray-900 rounded-lg shadow-lg overflow-hidden">
      {/* Header */}
      <div className="bg-gray-800 px-4 py-2 flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <Terminal className="w-4 h-4 text-green-400" />
          <span className="text-sm font-medium text-gray-300">Processing Console</span>
          <span className="text-xs text-gray-500">({logs.length} messages)</span>
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
            title="Clear logs"
          >
            Clear
          </button>
          <button
            onClick={onToggle}
            className="p-1 text-gray-400 hover:text-white transition-colors"
          >
            {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Console Content */}
      {isExpanded && (
        <div className="border-t border-gray-700">
          <div
            ref={consoleRef}
            onScroll={handleScroll}
            className="bg-black p-4 h-64 overflow-y-auto font-mono text-sm"
          >
            {logs.length === 0 ? (
              <div className="text-gray-500">Waiting for logs...</div>
            ) : (
              logs.map((log, index) => (
                <div key={index} className="flex items-start space-x-2 mb-1">
                  <span className="text-gray-500 text-xs flex-shrink-0">
                    {log.timestamp}
                  </span>
                  <span className={`flex-shrink-0 ${getLogLevelClass(log.level)}`}>
                    {log.level.toUpperCase()}:
                  </span>
                  <span className="text-gray-300 break-all">{log.message}</span>
                </div>
              ))
            )}
          </div>
          
          {/* Auto-scroll indicator */}
          <div className="bg-gray-800 px-4 py-1 flex items-center justify-between">
            <label className="flex items-center space-x-2 text-xs text-gray-400">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
                className="rounded"
              />
              <span>Auto-scroll</span>
            </label>
            {!autoScroll && (
              <span className="text-xs text-yellow-400">Auto-scroll paused</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default Console;

import React, { useState, useMemo } from 'react';
import { FileText, CheckCircle, AlertCircle, Eye, EyeOff, Download } from 'lucide-react';

const CSVPreview = ({ data, errors = [], filename }) => {
  const [activeTab, setActiveTab] = useState('original');
  const [showHeaders, setShowHeaders] = useState(true);
  const [maxRows, setMaxRows] = useState(10);

  // Parse CSV data
  const parsedData = useMemo(() => {
    if (!data) return { headers: [], rows: [] };
    
    const lines = data.split('\n').filter(line => line.trim());
    if (lines.length === 0) return { headers: [], rows: [] };
    
    const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
    const rows = lines.slice(1).map(line => 
      line.split(',').map(cell => cell.trim().replace(/"/g, ''))
    );
    
    return { headers, rows };
  }, [data]);

  // Create final data (after processing simulation)
  const finalData = useMemo(() => {
    if (!parsedData.rows.length) return parsedData;
    
    // Simulate processing - remove rows with errors
    const errorRows = new Set(errors.map(e => e.row_index || 0));
    const cleanRows = parsedData.rows.filter((_, index) => !errorRows.has(index));
    
    return {
      ...parsedData,
      rows: cleanRows
    };
  }, [parsedData, errors]);

  // Create highlighted data with error indicators
  const highlightedData = useMemo(() => {
    const errorRows = new Set(errors.map(e => e.row_index || 0));
    
    return {
      ...parsedData,
      rows: parsedData.rows.map((row, index) => ({
        data: row,
        hasError: errorRows.has(index),
        errors: errors.filter(e => (e.row_index || 0) === index)
      }))
    };
  }, [parsedData, errors]);

  const tabs = [
    { id: 'original', label: 'Original', icon: FileText, description: 'Raw uploaded data' },
    { id: 'final', label: 'Final', icon: CheckCircle, description: 'Processed data (errors removed)' },
    { id: 'highlighted', label: 'With Issues', icon: AlertCircle, description: 'Shows errors and fixes' }
  ];

  const displayData = useMemo(() => {
    switch (activeTab) {
      case 'final':
        return finalData;
      case 'highlighted':
        return highlightedData;
      default:
        return parsedData;
    }
  }, [activeTab, parsedData, finalData, highlightedData]);

  const downloadCSV = (dataToDownload, suffix = '') => {
    const csvContent = [
      dataToDownload.headers.join(','),
      ...dataToDownload.rows.map(row => 
        Array.isArray(row) ? row.join(',') : row.data.join(',')
      )
    ].join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename.replace('.csv', '')}${suffix}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (!data) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <div className="text-center text-gray-500">
          <FileText className="w-12 h-12 mx-auto mb-4 text-gray-300" />
          <p>No CSV data to preview</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow overflow-hidden">
      {/* Header */}
      <div className="border-b border-gray-200 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center">
            <h3 className="text-lg font-semibold text-gray-900">CSV Preview</h3>
            {filename && (
              <span className="ml-3 px-2 py-1 text-sm bg-gray-100 text-gray-600 rounded">
                {filename}
              </span>
            )}
          </div>
          <button
            onClick={() => downloadCSV(displayData, `-${activeTab}`)}
            className="flex items-center px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            <Download className="w-3 h-3 mr-1" />
            Download
          </button>
        </div>
        
        {/* Tabs */}
        <div className="flex space-x-1 mt-4">
          {tabs.map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center px-3 py-2 text-sm font-medium rounded-t-lg transition-colors ${
                  activeTab === tab.id 
                    ? 'bg-blue-500 text-white' 
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
                title={tab.description}
              >
                <Icon className="w-4 h-4 mr-1" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Controls */}
      <div className="border-b border-gray-200 px-4 py-2 bg-gray-50">
        <div className="flex items-center justify-between text-sm">
          <div className="flex items-center space-x-4">
            <label className="flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={showHeaders}
                onChange={(e) => setShowHeaders(e.target.checked)}
                className="mr-2"
              />
              <span className="flex items-center">
                {showHeaders ? <Eye className="w-3 h-3 mr-1" /> : <EyeOff className="w-3 h-3 mr-1" />}
                Headers
              </span>
            </label>
            
            <select
              value={maxRows}
              onChange={(e) => setMaxRows(Number(e.target.value))}
              className="px-2 py-1 border border-gray-300 rounded text-sm"
            >
              <option value={5}>5 rows</option>
              <option value={10}>10 rows</option>
              <option value={25}>25 rows</option>
              <option value={50}>50 rows</option>
              <option value={999}>All rows</option>
            </select>
          </div>
          
          <div className="text-gray-500">
            {activeTab === 'final' && (
              <span className="text-green-600">
                {finalData.rows.length} rows (removed {parsedData.rows.length - finalData.rows.length} errors)
              </span>
            )}
            {activeTab === 'highlighted' && (
              <span className="text-red-600">
                {errors.length} rows with issues
              </span>
            )}
            {activeTab === 'original' && (
              <span>{parsedData.rows.length} rows total</span>
            )}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          {showHeaders && (
            <thead className="bg-gray-50">
              <tr>
                {displayData.headers.map((header, index) => (
                  <th
                    key={index}
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody className="bg-white divide-y divide-gray-200">
            {displayData.rows.slice(0, maxRows).map((row, rowIndex) => {
              const rowData = Array.isArray(row) ? row : row.data;
              const hasError = row.hasError || false;
              const rowErrors = row.errors || [];
              
              return (
                <tr 
                  key={rowIndex}
                  className={hasError ? 'bg-red-50' : rowIndex % 2 === 0 ? 'bg-white' : 'bg-gray-50'}
                >
                  {rowData.map((cell, cellIndex) => (
                    <td
                      key={cellIndex}
                      className={`px-6 py-4 whitespace-nowrap text-sm text-gray-900 ${
                        hasError ? 'text-red-700' : ''
                      }`}
                    >
                      {cell || <span className="text-gray-400 italic">NULL</span>}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        
        {displayData.rows.length === 0 && (
          <div className="text-center py-8 text-gray-500">
            No data to display
          </div>
        )}
        
        {displayData.rows.length > maxRows && (
          <div className="text-center py-4 text-sm text-gray-500 bg-gray-50">
            Showing {maxRows} of {displayData.rows.length} rows
          </div>
        )}
      </div>

      {/* Error details for highlighted tab */}
      {activeTab === 'highlighted' && errors.length > 0 && (
        <div className="border-t border-gray-200 p-4 bg-red-50">
          <h4 className="text-sm font-semibold text-red-800 mb-2">Issues Found:</h4>
          <div className="space-y-1 text-sm text-red-700">
            {errors.slice(0, 5).map((error, index) => (
              <div key={index}>
                Row {error.row_index + 1}: {error.error_message}
              </div>
            ))}
            {errors.length > 5 && (
              <div className="text-red-600">
                ... and {errors.length - 5} more issues
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default CSVPreview;

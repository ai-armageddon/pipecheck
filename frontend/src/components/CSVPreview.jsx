import React, { useState, useMemo } from 'react';
import { FileText, CheckCircle, AlertCircle, Eye, EyeOff, Download, Sparkles, Flag } from 'lucide-react';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
  PaginationEllipsis,
} from './ui/pagination';

const CSVPreview = ({ data, errors = [], filename, processedData }) => {
  const [activeTab, setActiveTab] = useState('original');
  const [showHeaders, setShowHeaders] = useState(true);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);

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

  // Create final data from actual processed data from backend
  const finalData = useMemo(() => {
    if (processedData && processedData.data && processedData.data.length > 0) {
      // Use actual processed data from backend
      const firstRow = processedData.data[0];
      const headers = Object.keys(firstRow).filter(k => !k.startsWith('_'));
      const rows = processedData.data.map(row => {
        const rowData = headers.map(h => row[h] ?? '');
        const fixes = row._fixes_applied || [];
        return { data: rowData, fixes, needsReview: row._needs_review === true };
      });
      return { headers, rows, hasRealData: true };
    }
    
    // Fallback: simulate by removing error rows
    if (!parsedData.rows.length) return { ...parsedData, hasRealData: false };
    const errorRows = new Set(errors.map(e => e.row_index || 0));
    const cleanRows = parsedData.rows.filter((_, index) => !errorRows.has(index));
    return { ...parsedData, rows: cleanRows, hasRealData: false };
  }, [parsedData, errors, processedData]);

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

  // Pagination calculations
  const totalPages = Math.ceil(displayData.rows.length / rowsPerPage);
  const startIndex = (currentPage - 1) * rowsPerPage;
  const endIndex = startIndex + rowsPerPage;
  const paginatedRows = displayData.rows.slice(startIndex, endIndex);

  // Reset to page 1 when data or tab changes
  React.useEffect(() => {
    setCurrentPage(1);
  }, [activeTab, data]);

  // Generate page numbers with ellipsis
  const getPageNumbers = () => {
    const pages = [];
    const maxVisible = 5;
    
    if (totalPages <= maxVisible) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      if (currentPage <= 3) {
        pages.push(1, 2, 3, 4, '...', totalPages);
      } else if (currentPage >= totalPages - 2) {
        pages.push(1, '...', totalPages - 3, totalPages - 2, totalPages - 1, totalPages);
      } else {
        pages.push(1, '...', currentPage - 1, currentPage, currentPage + 1, '...', totalPages);
      }
    }
    return pages;
  };

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
      <div className="card p-10">
        <div className="flex flex-col items-center justify-center text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100">
            <FileText className="h-5 w-5 text-slate-400" />
          </div>
          <p className="font-medium text-slate-600">No CSV data to preview</p>
        </div>
      </div>
    );
  }

  return (
    <div className="card animate-rise overflow-hidden">
      {/* Header */}
      <div className="border-b border-slate-200 px-5 pt-4 pb-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <h3 className="card-title text-lg">CSV Preview</h3>
            {filename && (
              <span className="truncate rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-600" title={filename}>
                {filename}
              </span>
            )}
          </div>
          <button
            onClick={() => downloadCSV(displayData, `-${activeTab}`)}
            className="btn-outline px-3 py-1.5 text-xs"
          >
            <Download className="w-3.5 h-3.5" />
            Download
          </button>
        </div>

        {/* Tabs */}
        <div className="segmented mt-4">
          {tabs.map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`segmented-item ${activeTab === tab.id ? 'segmented-item-active' : ''}`}
                title={tab.description}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Controls */}
      <div className="border-b border-slate-200 bg-slate-50/80 px-5 py-2.5">
        <div className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-4">
            <label className="flex cursor-pointer items-center text-slate-600">
              <input
                type="checkbox"
                checked={showHeaders}
                onChange={(e) => setShowHeaders(e.target.checked)}
                className="mr-2 accent-indigo-600"
              />
              <span className="flex items-center">
                {showHeaders ? <Eye className="w-3.5 h-3.5 mr-1 text-slate-400" /> : <EyeOff className="w-3.5 h-3.5 mr-1 text-slate-400" />}
                Headers
              </span>
            </label>

            <select
              value={rowsPerPage}
              onChange={(e) => {
                setRowsPerPage(Number(e.target.value));
                setCurrentPage(1);
              }}
              className="input px-2 py-1 text-sm"
            >
              <option value={5}>5 per page</option>
              <option value={10}>10 per page</option>
              <option value={25}>25 per page</option>
              <option value={50}>50 per page</option>
            </select>
          </div>

          <div className="text-slate-500">
            {activeTab === 'final' && (
              <span className="text-emerald-600 font-medium">
                {finalData.rows.length} rows
                {finalData.hasRealData && (
                  <>
                    <span className="ml-2 text-violet-600">
                      <Sparkles className="inline w-3 h-3 mr-1" />
                      {finalData.rows.filter(r => r.fixes && r.fixes.length > 0).length} fixed
                    </span>
                    {finalData.rows.some(r => r.needsReview) && (
                      <span className="ml-2 text-amber-600" title="Repaired with invented values">
                        <Flag className="inline w-3 h-3 mr-1" />
                        {finalData.rows.filter(r => r.needsReview).length} need review
                      </span>
                    )}
                  </>
                )}
              </span>
            )}
            {activeTab === 'highlighted' && (
              <span className="text-rose-600 font-medium">
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
        <table className="min-w-full divide-y divide-slate-100">
          {showHeaders && (
            <thead className="bg-slate-50">
              <tr>
                {displayData.headers.map((header, index) => (
                  <th
                    key={index}
                    className="label-micro px-4 py-2.5 text-left"
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody className="divide-y divide-slate-100">
            {paginatedRows.map((row, rowIndex) => {
              const rowData = Array.isArray(row) ? row : row.data;
              const hasError = row.hasError || false;
              const rowErrors = row.errors || [];
              const hasFixes = row.fixes && row.fixes.length > 0;
              const needsReview = row.needsReview || false;
              const rowTitle = hasError
                ? rowErrors.map(e => `${e.error_code}: ${e.error_message}`).join('\n')
                : hasFixes ? `Fixes: ${row.fixes.join(', ')}` : '';

              return (
                <tr 
                  key={rowIndex}
                  className={hasError ? 'bg-rose-50/70' : needsReview ? 'bg-amber-50/70' : hasFixes ? 'bg-violet-50/70' : rowIndex % 2 === 0 ? 'bg-white' : 'bg-slate-50/60'}
                  title={rowTitle}
                >
                  {rowData.map((cell, cellIndex) => (
                    <td
                      key={cellIndex}
                      className={`whitespace-nowrap px-4 py-2.5 text-sm ${
                        hasError ? 'text-rose-700' : 'text-slate-700'
                      }`}
                    >
                      {cell || <span className="text-slate-300 italic">NULL</span>}
                    </td>
                  ))}
                  {hasFixes && (
                    <td className="px-2 py-2.5">
                      <span
                        className={needsReview ? 'text-amber-600' : 'text-violet-600'}
                        title={(needsReview ? 'Contains invented values - review before use:\n' : '') + row.fixes.join('\n')}
                      >
                        {needsReview ? <Flag className="w-4 h-4" /> : <Sparkles className="w-4 h-4" />}
                      </span>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>

        {displayData.rows.length === 0 && (
          <div className="text-center py-8 text-slate-400">
            No data to display
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="border-t border-slate-200 bg-slate-50/80 px-5 py-3">
          <div className="flex items-center justify-between">
            <div className="text-sm text-slate-500 tabular-nums">
              Showing {startIndex + 1}-{Math.min(endIndex, displayData.rows.length)} of {displayData.rows.length} rows
            </div>
            <Pagination>
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious 
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    className={currentPage === 1 ? 'pointer-events-none opacity-50' : ''}
                  />
                </PaginationItem>
                
                {getPageNumbers().map((pageNum, idx) => (
                  <PaginationItem key={idx}>
                    {pageNum === '...' ? (
                      <PaginationEllipsis />
                    ) : (
                      <PaginationLink
                        isActive={currentPage === pageNum}
                        onClick={() => setCurrentPage(pageNum)}
                      >
                        {pageNum}
                      </PaginationLink>
                    )}
                  </PaginationItem>
                ))}
                
                <PaginationItem>
                  <PaginationNext 
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    className={currentPage === totalPages ? 'pointer-events-none opacity-50' : ''}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        </div>
      )}

      {/* Error details for highlighted tab */}
      {activeTab === 'highlighted' && errors.length > 0 && (
        <div className="border-t border-rose-100 bg-rose-50/70 px-5 py-4">
          <h4 className="mb-2 text-sm font-semibold text-rose-800">Issues Found</h4>
          <div className="space-y-1 text-sm text-rose-700">
            {errors.slice(0, 5).map((error, index) => (
              <div key={index} className="flex items-start gap-2">
                <span className="chip shrink-0 bg-white font-mono text-rose-600 ring-1 ring-rose-200">Row {error.row_index + 1}</span>
                <span>{error.error_message}</span>
              </div>
            ))}
            {errors.length > 5 && (
              <div className="pt-1 text-rose-500">
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

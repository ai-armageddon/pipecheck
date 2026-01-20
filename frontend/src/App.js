import React, { useState, useEffect } from 'react';
import { Upload, FileText, Activity, AlertCircle, CheckCircle, Clock, XCircle, RefreshCw, ZoomIn, ZoomOut, Link, Clipboard, Download, Trash2 } from 'lucide-react';
import axios from 'axios';
import { Toaster, toast } from 'sonner';
import { Progress } from './Progress';
import './App.css';

function App() {
  const [runs, setRuns] = useState([]);
  const [stats, setStats] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [selectedRun, setSelectedRun] = useState(null);
  const [errors, setErrors] = useState([]);
  const [dragActive, setDragActive] = useState(false);
  const [uiScale, setUiScale] = useState(1); // 0.75, 0.875, 1, 1.125, 1.25, 1.375
  const [uploadProgress, setUploadProgress] = useState(0);
  const [processingProgress, setProcessingProgress] = useState({});
  const [currentUploadId, setCurrentUploadId] = useState(null);
  const [uploadMethod, setUploadMethod] = useState('file'); // file, paste
  const [csvText, setCsvText] = useState('');
  const [csvUrl, setCsvUrl] = useState('');

  useEffect(() => {
    fetchRuns();
    fetchStats();
    const interval = setInterval(() => {
      fetchRuns();
      fetchStats();
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // Poll for progress of processing runs
  useEffect(() => {
    const processingRuns = runs.filter(run => run.status === 'processing');
    
    processingRuns.forEach(run => {
      if (!processingProgress[run.run_id]) {
        pollProcessingProgress(run.run_id);
      }
    });
  }, [runs]);

  // Handle paste events for files
  useEffect(() => {
    const handlePaste = (e) => {
      if (uploadMethod === 'file') {
        const items = e.clipboardData?.items;
        if (items) {
          for (let i = 0; i < items.length; i++) {
            if (items[i].kind === 'file' && items[i].type === 'text/csv') {
              const file = items[i].getAsFile();
              if (file) {
                handleFileUpload(file);
                e.preventDefault();
              }
            }
          }
        }
      }
    };

    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [uploadMethod, uiScale]);

  const fetchRuns = async () => {
    try {
      const response = await axios.get('http://localhost:8001/runs');
      setRuns(response.data);
      if (response.data.length > 0 && !selectedRun) {
        setSelectedRun(response.data[0]);
      }
    } catch (error) {
      console.error('Error fetching runs:', error);
    }
  };

  const fetchStats = async () => {
    try {
      const response = await axios.get('http://localhost:8001/stats');
      setStats(response.data);
    } catch (error) {
      console.error('Error fetching stats:', error);
    }
  };

  const fetchErrors = async (runId) => {
    try {
      const response = await axios.get(`http://localhost:8001/runs/${runId}/errors`);
      setErrors(response.data);
    } catch (error) {
      console.error('Error fetching errors:', error);
    }
  };

  const handleFileUpload = async (file) => {
    if (!file || !(file.name.endsWith('.csv') || file.name.endsWith(('.xlsx', '.xls', '.xlsm')))) {
      toast.error('Please upload a CSV or Excel file');
      return;
    }

    setUploading(true);
    setUploadProgress(0);
    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await axios.post('http://localhost:8001/upload', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
        onUploadProgress: (progressEvent) => {
          const percentCompleted = Math.round(
            (progressEvent.loaded * 100) / progressEvent.total
          );
          setUploadProgress(percentCompleted);
        },
      });
      
      setCurrentUploadId(response.data.run_id);
      setProcessingProgress({ [response.data.run_id]: 0 });
      
      await fetchRuns();
      await fetchStats();
      
      if (response.data.status === 'skipped') {
        toast.info('File already processed. Skipping duplicate.');
        setUploadProgress(0);
        setCurrentUploadId(null);
      } else if (response.data.status === 'pending') {
        toast.success('File uploaded successfully and is being processed.');
        // Poll for progress updates
        pollProcessingProgress(response.data.run_id);
      } else {
        toast.success('File uploaded successfully.');
        setUploadProgress(0);
        setCurrentUploadId(null);
      }
    } catch (error) {
      console.error('Upload error:', error);
      toast.error('Upload failed: ' + (error.response?.data?.detail || error.message));
      setUploadProgress(0);
      setCurrentUploadId(null);
    } finally {
      setUploading(false);
    }
  };

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  };

  const handlePasteUpload = async () => {
    if (!csvText.trim()) {
      toast.error('Please paste CSV content first');
      return;
    }

    setUploading(true);
    try {
      const blob = new Blob([csvText], { type: 'text/csv' });
      const file = new File([blob], 'pasted-data.csv', { type: 'text/csv' });
      await handleFileUpload(file);
      setCsvText('');
    } catch (error) {
      console.error('Paste upload error:', error);
      toast.error('Upload failed: ' + (error.response?.data?.detail || error.message));
    } finally {
      setUploading(false);
    }
  };

  const handleUrlUpload = async () => {
    if (!csvUrl.trim()) {
      toast.error('Please enter a URL first');
      return;
    }

    setUploading(true);
    try {
      // First fetch the CSV from URL
      const response = await fetch(csvUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.statusText}`);
      }
      
      const csvContent = await response.text();
      const blob = new Blob([csvContent], { type: 'text/csv' });
      const filename = csvUrl.split('/').pop() || 'url-data.csv';
      const file = new File([blob], filename, { type: 'text/csv' });
      
      await handleFileUpload(file);
      setCsvUrl('');
    } catch (error) {
      console.error('URL upload error:', error);
      toast.error('Upload failed: ' + error.message);
    } finally {
      setUploading(false);
    }
  };

  const handleExport = async (runId, format = 'csv') => {
    try {
      const response = await axios.get(`http://localhost:8001/export/${runId}?format=${format}`, {
        responseType: 'blob'
      });
      
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', response.headers['content-disposition']?.split('filename=')[1]?.replace(/"/g, '') || `export.${format}`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Export failed: ' + (error.response?.data?.detail || error.message));
    }
  };

  const handleExportErrors = async (runId, format = 'csv') => {
    try {
      const response = await axios.get(`http://localhost:8001/errors/${runId}/export?format=${format}`, {
        responseType: 'blob'
      });
      
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', response.headers['content-disposition']?.split('filename=')[1]?.replace(/"/g, '') || `errors.${format}`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error export failed:', error);
      toast.error('Error export failed: ' + (error.response?.data?.detail || error.message));
    }
  };

  const handleExportAll = async (format = 'csv') => {
    try {
      const response = await axios.get(`http://localhost:8001/export/all?format=${format}`, {
        responseType: 'blob'
      });
      
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', response.headers['content-disposition']?.split('filename=')[1]?.replace(/"/g, '') || `all_export.${format}`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Export failed: ' + (error.response?.data?.detail || error.message));
    }
  };

  const handleDeleteRun = async (runId) => {
    if (!window.confirm('Are you sure you want to delete this run and all its data?')) {
      return;
    }

    try {
      await axios.delete(`http://localhost:8001/runs/${runId}`);
      
      // Refresh the runs list
      await fetchRuns();
      await fetchStats();
      
      // Clear selected run if it was deleted
      if (selectedRun && selectedRun.run_id === runId) {
        setSelectedRun(null);
        setErrors([]);
      }
      
      toast.success('Run deleted successfully');
    } catch (error) {
      console.error('Delete error:', error);
      toast.error('Delete failed: ' + (error.response?.data?.detail || error.message));
    }
  };

  const handleDeleteAllRuns = async () => {
    if (!window.confirm('Are you sure you want to delete ALL runs and their data? This cannot be undone!')) {
      return;
    }

    try {
      await axios.delete('http://localhost:8001/runs');
      
      // Clear all data
      setRuns([]);
      setSelectedRun(null);
      setErrors([]);
      await fetchStats();
      
      toast.success('All runs deleted successfully');
    } catch (error) {
      console.error('Delete all error:', error);
      toast.error('Delete failed: ' + (error.response?.data?.detail || error.message));
    }
  };

  const pollProcessingProgress = async (runId) => {
    const pollInterval = setInterval(async () => {
      try {
        const response = await axios.get(`http://localhost:8001/runs/${runId}`);
        const run = response.data;
        
        if (run.status === 'completed' || run.status === 'failed' || run.status === 'partial_success') {
          clearInterval(pollInterval);
          setProcessingProgress(prev => {
            const newProgress = { ...prev };
            delete newProgress[runId];
            return newProgress;
          });
          setUploadProgress(0);
          setCurrentUploadId(null);
          await fetchRuns();
          await fetchStats();
        } else if (run.status === 'processing') {
          // Calculate progress based on rows processed
          const progress = run.total_rows > 0 
            ? Math.round(((run.rows_inserted + run.rows_updated + run.errors_count + (run.rows_rejected || 0)) / run.total_rows) * 100)
            : 0;
          setProcessingProgress(prev => ({ ...prev, [runId]: progress }));
        }
      } catch (error) {
        console.error('Error polling progress:', error);
        clearInterval(pollInterval);
      }
    }, 1000);
  };

  const getStatusIcon = (status) => {
    switch (status) {
      case 'pending':
        return <Clock className="w-4 h-4" />;
      case 'processing':
        return <RefreshCw className="w-4 h-4 animate-spin" />;
      case 'completed':
        return <CheckCircle className="w-4 h-4" />;
      case 'failed':
        return <XCircle className="w-4 h-4" />;
      case 'skipped':
        return <AlertCircle className="w-4 h-4" />;
      default:
        return <Clock className="w-4 h-4" />;
    }
  };

  const formatDate = (dateString) => {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleString();
  };

  const getSizeClasses = () => {
    const scale = uiScale;
    
    return {
      container: scale <= 0.875 ? 'text-sm' : scale >= 1.125 ? 'text-lg' : 'text-base',
      header: `text-${Math.round(3 * scale)}xl`, // Scales from 2xl to 4xl
      card: scale <= 0.875 ? 'p-4' : scale >= 1.125 ? 'p-8' : 'p-6', // Fixed padding classes
      statCard: scale <= 0.875 ? 'p-4' : scale >= 1.125 ? 'p-8' : 'p-6', // Fixed padding classes
      statValue: `text-${Math.round(2 * scale)}xl`, // Scales from xl to 3xl
      table: scale <= 0.875 ? 'text-xs' : scale >= 1.125 ? 'text-base' : 'text-sm',
      button: `px-${Math.round(2.5 * scale)} py-${Math.round(0.5 * scale)} text-xs`,
      icon: `w-${Math.round(4 * scale)} h-${Math.round(4 * scale)}`, // Scales from 3 to 6
      title: `text-${Math.round(1.25 * scale)}xl` // Scales from lg to 2xl
    };
  };

  const sizeClasses = getSizeClasses();

  const getStatusBadgeClass = (status) => {
    const baseClass = status === 'pending' ? 'status-pending' :
                      status === 'processing' ? 'status-processing' :
                      status === 'completed' ? 'status-completed' :
                      status === 'failed' ? 'status-failed' :
                      status === 'partial_success' ? 'status-pending' :
                      'status-skipped';
    
    const sizeClass = uiScale <= 0.875 ? 'status-badge-small' :
                      uiScale >= 1.125 ? 'status-badge-large' :
                      'status-badge';
    
    return `${baseClass} ${sizeClass}`;
  };

  return (
    <div className={`min-h-screen bg-gray-50 ${sizeClasses.container}`}>
      <Toaster 
        position="top-right"
        expand={false}
        richColors
        closeButton
      />
      <div className="container mx-auto px-4 py-8">
        <header className="mb-8 flex justify-between items-start">
          <div className="flex items-center">
            <img src="/fav-lg.png" alt="PipeCheck Logo" className={`${uiScale <= 0.875 ? 'w-8 h-8' : uiScale >= 1.125 ? 'w-12 h-12' : 'w-10 h-10'} mr-3`} />
            <div>
              <h1 className={`${sizeClasses.header} font-bold text-gray-900 mb-2`}>PipeCheck</h1>
              <p className="text-gray-600">Ops-grade CSV ingestion pipeline with deduplication and idempotency</p>
            </div>
          </div>
          <div className="flex items-center space-x-1 bg-white rounded-lg shadow p-1">
            <button
              onClick={() => setUiScale(0.75)}
              className={`p-1 rounded ${uiScale === 0.75 ? 'bg-blue-100 text-blue-600' : 'text-gray-400 hover:text-gray-600'}`}
              title="75% - Smallest"
            >
              <ZoomOut className="w-3 h-3" />
            </button>
            <div className="flex items-center px-2">
              <input
                type="range"
                min="0.75"
                max="1.375"
                step="0.125"
                value={uiScale}
                onChange={(e) => setUiScale(parseFloat(e.target.value))}
                className="w-20 h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                style={{
                  background: `linear-gradient(to right, #3B82F6 0%, #3B82F6 ${((uiScale - 0.75) / 0.625) * 100}%, #E5E7EB ${((uiScale - 0.75) / 0.625) * 100}%, #E5E7EB 100%)`
                }}
              />
            </div>
            <button
              onClick={() => setUiScale(1.375)}
              className={`p-1 rounded ${uiScale === 1.375 ? 'bg-blue-100 text-blue-600' : 'text-gray-400 hover:text-gray-600'}`}
              title="137.5% - Largest"
            >
              <ZoomIn className="w-3 h-3" />
            </button>
            <span className="text-xs text-gray-500 ml-1 font-mono">
              {Math.round(uiScale * 100)}%
            </span>
          </div>
        </header>

        {stats && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
            <div className={`bg-white rounded-lg shadow ${sizeClasses.statCard}`}>
              <div className="flex items-center">
                <Activity className={`${uiScale <= 0.875 ? 'w-6 h-6' : uiScale >= 1.125 ? 'w-10 h-10' : 'w-8 h-8'} text-blue-500 mr-3`} />
                <div>
                  <p className="text-gray-600">Total Runs</p>
                  <p className={`${sizeClasses.statValue} font-bold`}>{stats.total_runs}</p>
                </div>
              </div>
            </div>
            
            <div className={`bg-white rounded-lg shadow ${sizeClasses.statCard}`}>
              <div className="flex items-center">
                <CheckCircle className={`${uiScale <= 0.875 ? 'w-6 h-6' : uiScale >= 1.125 ? 'w-10 h-10' : 'w-8 h-8'} text-green-500 mr-3`} />
                <div>
                  <p className="text-gray-600">Success Rate</p>
                  <p className={`${sizeClasses.statValue} font-bold`}>{stats.success_rate.toFixed(1)}%</p>
                </div>
              </div>
            </div>
            
            <div className={`bg-white rounded-lg shadow ${sizeClasses.statCard}`}>
              <div className="flex items-center">
                <FileText className={`${uiScale <= 0.875 ? 'w-6 h-6' : uiScale >= 1.125 ? 'w-10 h-10' : 'w-8 h-8'} text-purple-500 mr-3`} />
                <div>
                  <p className="text-gray-600">Rows Processed</p>
                  <p className={`${sizeClasses.statValue} font-bold`}>{stats.total_rows_processed.toLocaleString()}</p>
                </div>
              </div>
            </div>
            
            <div className={`bg-white rounded-lg shadow ${sizeClasses.statCard}`}>
              <div className="flex items-center">
                {stats.last_run ? (
                  <>
                    {getStatusIcon(stats.last_run.status)}
                    <div className="ml-3">
                      <p className="text-gray-600">Last Run</p>
                      <p className="font-medium capitalize">{stats.last_run.status}</p>
                    </div>
                  </>
                ) : (
                  <div>
                    <p className="text-gray-600">Last Run</p>
                    <p className="font-medium">No runs yet</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            <div className="bg-white rounded-lg shadow mb-6">
              <div className={`${sizeClasses.card}`}>
                <h2 className={`${sizeClasses.title} font-semibold mb-4`}>Upload CSV</h2>
                
                {/* Upload Method Tabs */}
                <div className="flex space-x-1 mb-4">
                  <button
                    onClick={() => setUploadMethod('file')}
                    className={`px-3 py-2 text-sm font-medium rounded-t-lg ${
                      uploadMethod === 'file' 
                        ? 'bg-blue-500 text-white' 
                        : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                    }`}
                  >
                    <Upload className="inline w-4 h-4 mr-1" />
                    File
                  </button>
                  <button
                    onClick={() => setUploadMethod('paste')}
                    className={`px-3 py-2 text-sm font-medium rounded-t-lg ${
                      uploadMethod === 'paste' 
                        ? 'bg-blue-500 text-white' 
                        : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                    }`}
                  >
                    <Clipboard className="inline w-4 h-4 mr-1" />
                    Paste Raw Data
                  </button>
                </div>

                {/* File Upload Method */}
                {uploadMethod === 'file' && (
                  <div>
                    <div
                      className={`relative border-2 border-dashed rounded-lg text-center transition-colors ${
                        dragActive ? 'border-blue-400 bg-blue-50' : 'border-gray-300 hover:border-gray-400'
                      } ${uploading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'} ${
                        uiScale <= 0.875 ? 'p-4' : uiScale >= 1.125 ? 'p-12' : 'p-8'
                      }`}
                      onDragEnter={handleDrag}
                      onDragLeave={handleDrag}
                      onDragOver={handleDrag}
                      onDrop={handleDrop}
                    >
                      <input
                        type="file"
                        accept=".csv,.xlsx,.xls,.xlsm"
                        onChange={(e) => e.target.files && handleFileUpload(e.target.files[0])}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                        disabled={uploading}
                      />
                      <Upload className={`${uiScale <= 0.875 ? 'w-8 h-8' : uiScale >= 1.125 ? 'w-16 h-16' : 'w-12 h-12'} text-gray-400 mx-auto mb-4`} />
                      <p className={`${uiScale <= 0.875 ? 'text-sm' : uiScale >= 1.125 ? 'text-xl' : 'text-lg'} font-medium text-gray-700`}>
                        {uploading ? 'Uploading...' : 'Drop CSV or Excel file here or click to browse'}
                      </p>
                      <p className={`${sizeClasses.container} text-gray-500 mt-2`}>Supports CSV, Excel (.xlsx, .xls) files with email, name, and optional fields</p>
                    </div>
                    
                    {/* URL Input */}
                    <div className="mt-4">
                      <div className="flex items-center mb-2">
                        <Link className="w-4 h-4 text-gray-500 mr-2" />
                        <span className="text-sm text-gray-600">Or upload from URL:</span>
                      </div>
                      <div className="flex gap-2">
                        <input
                          type="url"
                          value={csvUrl}
                          onChange={(e) => setCsvUrl(e.target.value)}
                          placeholder="https://example.com/data.csv"
                          className="flex-1 p-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          disabled={uploading}
                        />
                        <button
                          onClick={handleUrlUpload}
                          disabled={uploading || !csvUrl.trim()}
                          className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {uploading ? 'Fetching...' : 'Fetch'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Paste Raw Data Method */}
                {uploadMethod === 'paste' && (
                  <div>
                    <textarea
                      value={csvText}
                      onChange={(e) => setCsvText(e.target.value)}
                      placeholder="Paste your raw CSV data here...
Example:
name,email,phone
John Doe,john@example.com,555-1234
Jane Smith,jane@example.com,555-5678"
                      className="w-full h-48 p-3 border border-gray-300 rounded-lg font-mono text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      disabled={uploading}
                    />
                    <button
                      onClick={handlePasteUpload}
                      disabled={uploading || !csvText.trim()}
                      className="mt-3 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {uploading ? 'Processing...' : 'Upload CSV Data'}
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Progress Bar */}
            {(uploading || currentUploadId) && (
              <div className="bg-white rounded-lg shadow mt-6">
                <div className={`${sizeClasses.card}`}>
                  <h3 className={`${sizeClasses.title} font-semibold mb-4`}>Upload Progress</h3>
                  
                  {uploadProgress < 100 && (
                    <div className="mb-4">
                      <div className="flex justify-between text-sm text-gray-600 mb-2">
                        <span>Uploading file...</span>
                        <span>{uploadProgress}%</span>
                      </div>
                      <Progress value={uploadProgress} className="h-2" />
                    </div>
                  )}
                  
                  {currentUploadId && processingProgress[currentUploadId] !== undefined && (
                    <div>
                      <div className="flex justify-between text-sm text-gray-600 mb-2">
                        <span>Processing file...</span>
                        <span>{processingProgress[currentUploadId] || 0}%</span>
                      </div>
                      <Progress value={processingProgress[currentUploadId] || 0} className="h-2" />
                      <p className="text-xs text-gray-500 mt-2">
                        Validating and processing your data. This may take a moment for large files.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="bg-white rounded-lg shadow">
              <div className={`${sizeClasses.card}`}>
                <div className="flex justify-between items-center mb-4">
                  <h2 className={`${sizeClasses.title} font-semibold`}>Recent Runs</h2>
                  <div className="flex gap-2">
                    <button
                      onClick={handleDeleteAllRuns}
                      className="flex items-center px-3 py-1 text-sm bg-red-500 text-white rounded hover:bg-red-600"
                    >
                      <Trash2 className="w-3 h-3 mr-1" />
                      Delete All
                    </button>
                    <button
                      onClick={() => handleExportAll('csv')}
                      className="flex items-center px-3 py-1 text-sm bg-green-500 text-white rounded hover:bg-green-600"
                    >
                      <Download className="w-3 h-3 mr-1" />
                      Export All (CSV)
                    </button>
                    <button
                      onClick={() => handleExportAll('excel')}
                      className="flex items-center px-3 py-1 text-sm bg-green-600 text-white rounded hover:bg-green-700"
                    >
                      <Download className="w-3 h-3 mr-1" />
                      Export All (Excel)
                    </button>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2">Status</th>
                        <th className="text-left py-2">Filename</th>
                        <th className="text-left py-2">Created</th>
                        <th className="text-right py-2">Rows</th>
                        <th className="text-right py-2">Inserted</th>
                        <th className="text-right py-2">Updated</th>
                        <th className="text-right py-2">Errors</th>
                        <th className="text-center py-2">Progress</th>
                        <th className="text-center py-2">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runs.map((run) => (
                        <tr
                          key={run.run_id}
                          className="border-b hover:bg-gray-50 cursor-pointer"
                          onClick={() => {
                            setSelectedRun(run);
                            fetchErrors(run.run_id);
                          }}
                        >
                          <td className="py-3">
                            <span className={getStatusBadgeClass(run.status)}>
                              {getStatusIcon(run.status)}
                              <span className="ml-1 capitalize">{run.status}</span>
                            </span>
                          </td>
                          <td className={`${sizeClasses.table}`}>{run.filename}</td>
                          <td className={`${sizeClasses.table} text-gray-600`}>{formatDate(run.created_at)}</td>
                          <td className={`${sizeClasses.table} text-right`}>{run.total_rows.toLocaleString()}</td>
                          <td className={`${sizeClasses.table} text-right text-green-600`}>{run.rows_inserted.toLocaleString()}</td>
                          <td className={`${sizeClasses.table} text-right text-blue-600`}>{run.rows_updated.toLocaleString()}</td>
                          <td className={`${sizeClasses.table} text-right text-red-600`}>{run.errors_count}</td>
                          <td className={`${sizeClasses.table} text-center`}>
                            {run.status === 'processing' ? (
                              <div className="flex items-center justify-center">
                                <span className="text-xs text-gray-600 mr-2">
                                  {processingProgress[run.run_id] || 0}%
                                </span>
                                <div className="w-16 bg-gray-200 rounded-full h-2">
                                  <div 
                                    className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                                    style={{ width: `${processingProgress[run.run_id] || 0}%` }}
                                  />
                                </div>
                              </div>
                            ) : run.status === 'completed' ? (
                              <span className="text-green-600 text-xs">100%</span>
                            ) : run.status === 'failed' ? (
                              <span className="text-red-600 text-xs">Failed</span>
                            ) : (
                              <span className="text-gray-400 text-xs">-</span>
                            )}
                          </td>
                          <td className={`${sizeClasses.table} text-center`}>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteRun(run.run_id);
                              }}
                              className="p-1 text-red-500 hover:text-red-700 hover:bg-red-50 rounded"
                              title="Delete run"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {runs.length === 0 && (
                    <div className="text-center py-8 text-gray-500">
                      No runs yet. Upload a CSV or Excel file to get started.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div>
            {selectedRun && (
              <div className="bg-white rounded-lg shadow">
                <div className={`${sizeClasses.card}`}>
                  <h2 className={`${sizeClasses.title} font-semibold mb-4`}>Run Details</h2>
                  <div className="space-y-3">
                    <div className="flex justify-between">
                      <span className="text-gray-600">Run ID:</span>
                      <span className={`${sizeClasses.table} font-mono`}>{selectedRun.run_id.slice(0, 8)}...</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Status:</span>
                      <span className={getStatusBadgeClass(selectedRun.status)}>
                        {getStatusIcon(selectedRun.status)}
                        <span className="ml-1 capitalize">{selectedRun.status}</span>
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Created:</span>
                      <span className={`${sizeClasses.table}`}>{formatDate(selectedRun.created_at)}</span>
                    </div>
                    {selectedRun.completed_at && (
                      <div className="flex justify-between">
                        <span className="text-gray-600">Completed:</span>
                        <span className={`${sizeClasses.table}`}>{formatDate(selectedRun.completed_at)}</span>
                      </div>
                    )}
                    <hr />
                    <div className="grid grid-cols-2 gap-4">
                      <div className="text-center">
                        <p className={`${uiScale <= 0.875 ? 'text-lg' : uiScale >= 1.125 ? 'text-3xl' : 'text-2xl'} font-bold`}>{selectedRun.total_rows.toLocaleString()}</p>
                        <p className={`${sizeClasses.table} text-gray-600`}>Total Rows</p>
                      </div>
                      <div className="text-center">
                        <p className={`${uiScale <= 0.875 ? 'text-lg' : uiScale >= 1.125 ? 'text-3xl' : 'text-2xl'} font-bold text-green-600`}>{selectedRun.rows_inserted.toLocaleString()}</p>
                        <p className={`${sizeClasses.table} text-gray-600`}>Inserted</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="text-center">
                        <p className={`${uiScale <= 0.875 ? 'text-lg' : uiScale >= 1.125 ? 'text-3xl' : 'text-2xl'} font-bold text-blue-600`}>{selectedRun.rows_updated.toLocaleString()}</p>
                        <p className={`${sizeClasses.table} text-gray-600`}>Updated</p>
                      </div>
                      <div className="text-center">
                        <p className={`${uiScale <= 0.875 ? 'text-lg' : uiScale >= 1.125 ? 'text-3xl' : 'text-2xl'} font-bold text-gray-600`}>{selectedRun.rows_skipped.toLocaleString()}</p>
                        <p className={`${sizeClasses.table} text-gray-600`}>Skipped</p>
                      </div>
                    </div>
                  </div>
                  
                  {selectedRun.status === 'completed' && (
                    <div className="mt-4 pt-4 border-t">
                      <h3 className="text-sm font-medium text-gray-700 mb-2">Export Data</h3>
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleExport(selectedRun.run_id, 'csv')}
                          className="flex-1 flex items-center justify-center px-2 py-1 text-xs bg-green-500 text-white rounded hover:bg-green-600"
                        >
                          <Download className="w-3 h-3 mr-1" />
                          CSV
                        </button>
                        <button
                          onClick={() => handleExport(selectedRun.run_id, 'excel')}
                          className="flex-1 flex items-center justify-center px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700"
                        >
                          <Download className="w-3 h-3 mr-1" />
                          Excel
                        </button>
                      </div>
                    </div>
                  )}

                  {(selectedRun.status === 'partial_success' || selectedRun.status === 'failed') && (
                    <div className="mt-4 pt-4 border-t">
                      <h3 className="text-sm font-medium text-gray-700 mb-2">Export Error Report</h3>
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleExportErrors(selectedRun.run_id, 'csv')}
                          className="flex-1 flex items-center justify-center px-2 py-1 text-xs bg-red-500 text-white rounded hover:bg-red-600"
                        >
                          <Download className="w-3 h-3 mr-1" />
                          Errors CSV
                        </button>
                        <button
                          onClick={() => handleExportErrors(selectedRun.run_id, 'excel')}
                          className="flex-1 flex items-center justify-center px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700"
                        >
                          <Download className="w-3 h-3 mr-1" />
                          Errors Excel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {errors.length > 0 && (
              <div className="bg-white rounded-lg shadow mt-6">
                <div className={`${sizeClasses.card}`}>
                  <h2 className={`${sizeClasses.title} font-semibold mb-4 flex items-center`}>
                    <AlertCircle className={`${sizeClasses.icon} text-red-500 mr-2`} />
                    Errors ({errors.length})
                  </h2>
                  <div className={`space-y-2 overflow-y-auto ${
                    uiScale <= 0.875 ? 'max-h-64' : uiScale >= 1.125 ? 'max-h-96' : 'max-h-80'
                  }`}>
                    {errors.map((error) => (
                      <div key={error.id} className="border-l-4 border-red-400 pl-4 py-2">
                        <div className="flex justify-between items-start">
                          <div>
                            <p className={`${sizeClasses.table} font-medium text-red-800`}>{error.error_code}</p>
                            <p className={`${sizeClasses.table} text-gray-600`}>{error.error_message}</p>
                          </div>
                          <span className={`${sizeClasses.table} text-gray-500`}>Row {error.row_index}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;

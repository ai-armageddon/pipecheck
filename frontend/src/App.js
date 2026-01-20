import React, { useState, useEffect } from 'react';
import { Upload, FileText, Activity, AlertCircle, CheckCircle, Clock, XCircle, RefreshCw, ZoomIn, ZoomOut } from 'lucide-react';
import axios from 'axios';
import './App.css';

function App() {
  const [runs, setRuns] = useState([]);
  const [stats, setStats] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [selectedRun, setSelectedRun] = useState(null);
  const [errors, setErrors] = useState([]);
  const [dragActive, setDragActive] = useState(false);
  const [uiSize, setUiSize] = useState('normal'); // small, normal, large

  useEffect(() => {
    fetchRuns();
    fetchStats();
    const interval = setInterval(() => {
      fetchRuns();
      fetchStats();
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const fetchRuns = async () => {
    try {
      const response = await axios.get('http://localhost:8000/runs');
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
      const response = await axios.get('http://localhost:8000/stats');
      setStats(response.data);
    } catch (error) {
      console.error('Error fetching stats:', error);
    }
  };

  const fetchErrors = async (runId) => {
    try {
      const response = await axios.get(`http://localhost:8000/runs/${runId}/errors`);
      setErrors(response.data);
    } catch (error) {
      console.error('Error fetching errors:', error);
    }
  };

  const handleFileUpload = async (file) => {
    if (!file || !file.name.endsWith('.csv')) {
      alert('Please upload a CSV file');
      return;
    }

    setUploading(true);
    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await axios.post('http://localhost:8000/upload', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });
      
      await fetchRuns();
      await fetchStats();
      
      if (response.data.status === 'skipped') {
        alert('File already processed. Skipping duplicate.');
      } else {
        alert('File uploaded successfully! Processing started.');
      }
    } catch (error) {
      console.error('Upload error:', error);
      alert('Upload failed: ' + (error.response?.data?.detail || error.message));
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
    switch (uiSize) {
      case 'small':
        return {
          container: 'text-xs',
          header: 'text-2xl',
          card: 'p-4',
          statCard: 'p-4',
          statValue: 'text-xl',
          table: 'text-xs',
          button: 'px-2 py-1 text-xs',
          icon: 'w-3 h-3',
          title: 'text-lg'
        };
      case 'large':
        return {
          container: 'text-lg',
          header: 'text-5xl',
          card: 'p-8',
          statCard: 'p-8',
          statValue: 'text-4xl',
          table: 'text-base',
          button: 'px-6 py-3 text-base',
          icon: 'w-6 h-6',
          title: 'text-2xl'
        };
      default: // normal
        return {
          container: 'text-base',
          header: 'text-3xl',
          card: 'p-6',
          statCard: 'p-6',
          statValue: 'text-2xl',
          table: 'text-sm',
          button: 'px-2.5 py-0.5 text-xs',
          icon: 'w-4 h-4',
          title: 'text-xl'
        };
    }
  };

  const sizeClasses = getSizeClasses();

  const getStatusBadgeClass = (status) => {
    const baseClass = status === 'pending' ? 'status-pending' :
                      status === 'processing' ? 'status-processing' :
                      status === 'completed' ? 'status-completed' :
                      status === 'failed' ? 'status-failed' :
                      'status-skipped';
    
    const sizeClass = uiSize === 'small' ? 'status-badge-small' :
                      uiSize === 'large' ? 'status-badge-large' :
                      'status-badge';
    
    return `${baseClass} ${sizeClass}`;
  };

  return (
    <div className={`min-h-screen bg-gray-50 ${sizeClasses.container}`}>
      <div className="container mx-auto px-4 py-8">
        <header className="mb-8 flex justify-between items-start">
          <div>
            <h1 className={`${sizeClasses.header} font-bold text-gray-900 mb-2`}>PipeCheck</h1>
            <p className="text-gray-600">Ops-grade CSV ingestion pipeline with deduplication and idempotency</p>
          </div>
          <div className="flex items-center space-x-1 bg-white rounded-lg shadow p-1">
            <button
              onClick={() => setUiSize('small')}
              className={`p-1 rounded ${uiSize === 'small' ? 'bg-blue-100 text-blue-600' : 'text-gray-400 hover:text-gray-600'}`}
              title="Small UI"
            >
              <ZoomOut className="w-3 h-3" />
            </button>
            <button
              onClick={() => setUiSize('normal')}
              className={`p-1 rounded ${uiSize === 'normal' ? 'bg-blue-100 text-blue-600' : 'text-gray-400 hover:text-gray-600'}`}
              title="Normal UI"
            >
              <span className="text-xs font-medium">A</span>
            </button>
            <button
              onClick={() => setUiSize('large')}
              className={`p-1 rounded ${uiSize === 'large' ? 'bg-blue-100 text-blue-600' : 'text-gray-400 hover:text-gray-600'}`}
              title="Large UI"
            >
              <ZoomIn className="w-3 h-3" />
            </button>
          </div>
        </header>

        {stats && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
            <div className={`bg-white rounded-lg shadow ${sizeClasses.statCard}`}>
              <div className="flex items-center">
                <Activity className={`${uiSize === 'small' ? 'w-6 h-6' : uiSize === 'large' ? 'w-10 h-10' : 'w-8 h-8'} text-blue-500 mr-3`} />
                <div>
                  <p className="text-gray-600">Total Runs</p>
                  <p className={`${sizeClasses.statValue} font-bold`}>{stats.total_runs}</p>
                </div>
              </div>
            </div>
            
            <div className={`bg-white rounded-lg shadow ${sizeClasses.statCard}`}>
              <div className="flex items-center">
                <CheckCircle className={`${uiSize === 'small' ? 'w-6 h-6' : uiSize === 'large' ? 'w-10 h-10' : 'w-8 h-8'} text-green-500 mr-3`} />
                <div>
                  <p className="text-gray-600">Success Rate</p>
                  <p className={`${sizeClasses.statValue} font-bold`}>{stats.success_rate.toFixed(1)}%</p>
                </div>
              </div>
            </div>
            
            <div className={`bg-white rounded-lg shadow ${sizeClasses.statCard}`}>
              <div className="flex items-center">
                <FileText className={`${uiSize === 'small' ? 'w-6 h-6' : uiSize === 'large' ? 'w-10 h-10' : 'w-8 h-8'} text-purple-500 mr-3`} />
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
                <div
                  className={`relative border-2 border-dashed rounded-lg ${uiSize === 'small' ? 'p-4' : uiSize === 'large' ? 'p-12' : 'p-8'} text-center transition-colors ${
                    dragActive ? 'border-blue-400 bg-blue-50' : 'border-gray-300 hover:border-gray-400'
                  } ${uploading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                  onDragEnter={handleDrag}
                  onDragLeave={handleDrag}
                  onDragOver={handleDrag}
                  onDrop={handleDrop}
                >
                  <input
                    type="file"
                    accept=".csv"
                    onChange={(e) => e.target.files && handleFileUpload(e.target.files[0])}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    disabled={uploading}
                  />
                  <Upload className={`${uiSize === 'small' ? 'w-8 h-8' : uiSize === 'large' ? 'w-16 h-16' : 'w-12 h-12'} text-gray-400 mx-auto mb-4`} />
                  <p className={`${uiSize === 'small' ? 'text-sm' : uiSize === 'large' ? 'text-xl' : 'text-lg'} font-medium text-gray-700`}>
                    {uploading ? 'Uploading...' : 'Drop CSV file here or click to browse'}
                  </p>
                  <p className={`${sizeClasses.container} text-gray-500 mt-2`}>Supports CSV files with email, name, and optional fields</p>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-lg shadow">
              <div className={`${sizeClasses.card}`}>
                <h2 className={`${sizeClasses.title} font-semibold mb-4`}>Recent Runs</h2>
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
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {runs.length === 0 && (
                    <div className="text-center py-8 text-gray-500">
                      No runs yet. Upload a CSV file to get started.
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
                        <p className={`${uiSize === 'small' ? 'text-lg' : uiSize === 'large' ? 'text-3xl' : 'text-2xl'} font-bold`}>{selectedRun.total_rows.toLocaleString()}</p>
                        <p className={`${sizeClasses.table} text-gray-600`}>Total Rows</p>
                      </div>
                      <div className="text-center">
                        <p className={`${uiSize === 'small' ? 'text-lg' : uiSize === 'large' ? 'text-3xl' : 'text-2xl'} font-bold text-green-600`}>{selectedRun.rows_inserted.toLocaleString()}</p>
                        <p className={`${sizeClasses.table} text-gray-600`}>Inserted</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="text-center">
                        <p className={`${uiSize === 'small' ? 'text-lg' : uiSize === 'large' ? 'text-3xl' : 'text-2xl'} font-bold text-blue-600`}>{selectedRun.rows_updated.toLocaleString()}</p>
                        <p className={`${sizeClasses.table} text-gray-600`}>Updated</p>
                      </div>
                      <div className="text-center">
                        <p className={`${uiSize === 'small' ? 'text-lg' : uiSize === 'large' ? 'text-3xl' : 'text-2xl'} font-bold text-gray-600`}>{selectedRun.rows_skipped.toLocaleString()}</p>
                        <p className={`${sizeClasses.table} text-gray-600`}>Skipped</p>
                      </div>
                    </div>
                  </div>
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
                  <div className={`space-y-2 ${uiSize === 'small' ? 'max-h-64' : uiSize === 'large' ? 'max-h-96' : 'max-h-80'} overflow-y-auto`}>
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

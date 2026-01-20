import React, { useState, useEffect, useRef } from 'react';
import { Upload, FileText, Activity, AlertCircle, CheckCircle, Clock, XCircle, RefreshCw, ZoomIn, ZoomOut, Link, Clipboard, Download, Trash2, Terminal, HelpCircle, SkipForward, Volume2, VolumeX, Copy } from 'lucide-react';
import axios from 'axios';
import { Toaster, toast } from 'sonner';
import { Progress } from './components/ui/progress';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './components/ui/dialog';
import Console from './Console';
import CSVPreview from './components/CSVPreview';
import soundManager from './lib/sounds';
import './App.css';

// Elapsed Timer Component
const ElapsedTimer = ({ startTime }) => {
  const [elapsed, setElapsed] = useState(0);
  
  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Date.now() - startTime);
    }, 100);
    
    return () => clearInterval(interval);
  }, [startTime]);
  
  const seconds = (elapsed / 1000).toFixed(1);
  
  return (
    <span className="text-sm text-gray-500 font-mono">
      {seconds}s
    </span>
  );
};

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
  const [consoleLogs, setConsoleLogs] = useState([]);
  const [consoleExpanded, setConsoleExpanded] = useState(false);
  const [showStatusMeaning, setShowStatusMeaning] = useState(false);
  const [uploadStartTime, setUploadStartTime] = useState(null);
  const [processingTime, setProcessingTime] = useState(null);
  const [uploadedFileContent, setUploadedFileContent] = useState(null);
  const [uploadedFileName, setUploadedFileName] = useState(null);
  const [filePreviewCache, setFilePreviewCache] = useState(() => {
    // Load cached previews from localStorage
    const cached = localStorage.getItem('csvFilePreviewCache');
    return cached ? JSON.parse(cached) : {};
  });
  const [soundEnabled, setSoundEnabled] = useState(soundManager.enabled);
  const [duplicateFileDialog, setDuplicateFileDialog] = useState({ open: false, file: null, existingRun: null });
  const ws = useRef(null);
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

  // WebSocket connection for real-time logs
  useEffect(() => {
    // Connect to global WebSocket
    ws.current = new WebSocket('ws://localhost:8001/ws');
    
    ws.current.onopen = () => {
      console.log('Connected to WebSocket');
      addLog('info', 'Connected to real-time console');
    };
    
    ws.current.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      if (data.type === 'log') {
        addLog(data.level, data.message, data.timestamp, data.run_id);
      } else if (data.type === 'ping') {
        // Ignore ping messages
      }
    };
    
    ws.current.onclose = () => {
      console.log('Disconnected from WebSocket');
      addLog('warn', 'Disconnected from real-time console');
    };
    
    ws.current.onerror = (error) => {
      console.error('WebSocket error:', error);
      addLog('error', 'WebSocket connection error');
    };
    
    return () => {
      if (ws.current) {
        ws.current.close();
      }
    };
  }, []);

  // Load logs and console state from localStorage on mount and fetch recent logs from backend
  useEffect(() => {
    // First load from localStorage
    const savedLogs = localStorage.getItem('csvConsoleLogs');
    const savedConsoleState = localStorage.getItem('csvConsoleExpanded');
    
    if (savedLogs) {
      try {
        setConsoleLogs(JSON.parse(savedLogs));
      } catch (e) {
        console.error('Failed to parse saved logs:', e);
      }
    }
    
    if (savedConsoleState) {
      try {
        setConsoleExpanded(JSON.parse(savedConsoleState));
      } catch (e) {
        console.error('Failed to parse console state:', e);
      }
    }
    
    // Then fetch recent logs from backend
    const fetchRecentLogs = async () => {
      try {
        const response = await axios.get('http://localhost:8001/logs/recent?limit=50');
        const backendLogs = response.data.map(log => ({
          timestamp: new Date(log.timestamp).toLocaleTimeString(),
          level: log.level,
          message: log.message,
          runId: log.run_id
        }));
        
        setConsoleLogs(prev => {
          // Combine with existing logs, remove duplicates, and keep last 500
          const combined = [...backendLogs.reverse(), ...prev];
          const unique = combined.filter((log, index, arr) => 
            arr.findIndex(l => l.timestamp === log.timestamp && l.message === log.message) === index
          );
          return unique.slice(-500);
        });
      } catch (error) {
        console.error('Failed to fetch recent logs:', error);
      }
    };
    
    fetchRecentLogs();
  }, []);

  // Save logs to localStorage whenever they change
  useEffect(() => {
    if (consoleLogs.length > 0) {
      localStorage.setItem('csvConsoleLogs', JSON.stringify(consoleLogs));
    }
  }, [consoleLogs]);

  // Save console state to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('csvConsoleExpanded', JSON.stringify(consoleExpanded));
  }, [consoleExpanded]);

  // Save file preview cache to localStorage
  useEffect(() => {
    if (Object.keys(filePreviewCache).length > 0) {
      // Keep only last 10 previews to avoid localStorage bloat
      const entries = Object.entries(filePreviewCache);
      const trimmed = entries.slice(-10);
      localStorage.setItem('csvFilePreviewCache', JSON.stringify(Object.fromEntries(trimmed)));
    }
  }, [filePreviewCache]);

  // Load preview when selecting a run
  useEffect(() => {
    if (selectedRun && filePreviewCache[selectedRun.run_id]) {
      const cached = filePreviewCache[selectedRun.run_id];
      setUploadedFileContent(cached.content);
      setUploadedFileName(cached.filename);
    }
  }, [selectedRun?.run_id, filePreviewCache]);

  // Connect to run-specific WebSocket when uploading
  useEffect(() => {
    if (currentUploadId) {
      const runWs = new WebSocket(`ws://localhost:8001/ws/${currentUploadId}`);
      
      runWs.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.type === 'log') {
          addLog(data.level, data.message, data.timestamp, data.run_id);
        }
      };
      
      return () => {
        runWs.close();
      };
    }
  }, [currentUploadId]);

  const addLog = (level, message, timestamp = null, runId = null) => {
    const newLog = {
      timestamp: timestamp || new Date().toLocaleTimeString(),
      level,
      message,
      runId
    };
    
    // Play sound based on log level
    if (level === 'error') {
      soundManager.logError();
    } else if (level === 'warn') {
      soundManager.logWarning();
    } else {
      soundManager.log();
    }
    
    setConsoleLogs(prev => {
      const updated = [...prev, newLog];
      // Keep only last 1000 logs
      return updated.slice(-1000);
    });
  };

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
      // Only auto-select first run on initial load, not on polling
      setSelectedRun(prev => {
        if (!prev && response.data.length > 0) {
          return response.data[0];
        }
        // Keep current selection, but update with fresh data if it exists
        if (prev) {
          const updated = response.data.find(r => r.run_id === prev.run_id);
          return updated || prev;
        }
        return prev;
      });
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

  const [processedData, setProcessedData] = useState(null);

  const fetchProcessedData = async (runId) => {
    try {
      const response = await axios.get(`http://localhost:8001/runs/${runId}/data`);
      setProcessedData(response.data);
    } catch (error) {
      console.error('Error fetching processed data:', error);
      setProcessedData(null);
    }
  };

  const handleFileUpload = async (file, forceUpload = false, versionSuffix = null) => {
    if (!file || !(file.name.endsWith('.csv') || file.name.endsWith('.xlsx') || file.name.endsWith('.xls') || file.name.endsWith('.xlsm'))) {
      toast.error('Please upload a CSV or Excel file');
      return;
    }

    // Check for duplicate filename (unless forced)
    if (!forceUpload) {
      const existingRun = runs.find(run => run.filename === file.name);
      if (existingRun) {
        setDuplicateFileDialog({ open: true, file, existingRun });
        return;
      }
    }

    // If version suffix provided, rename the file
    let uploadFile = file;
    if (versionSuffix) {
      const nameParts = file.name.split('.');
      const ext = nameParts.pop();
      const baseName = nameParts.join('.');
      const newName = `${baseName}_v${versionSuffix}.${ext}`;
      uploadFile = new File([file], newName, { type: file.type });
    }

    // Read file content for preview
    const reader = new FileReader();
    let fileContent = null;
    reader.onload = (e) => {
      fileContent = e.target.result;
      setUploadedFileContent(fileContent);
      setUploadedFileName(uploadFile.name);
    };
    reader.onerror = (e) => {
      console.error('FileReader error:', e);
    };
    
    // Wait for file to be read before proceeding
    await new Promise((resolve) => {
      reader.onloadend = resolve;
      reader.readAsText(uploadFile);
    });

    soundManager.upload();
    const startTime = Date.now();
    setUploadStartTime(startTime);
    setProcessingTime(null);
    setUploading(true);
    setUploadProgress(0);
    addLog('info', `Starting upload: ${uploadFile.name} (${(file.size / 1024).toFixed(1)} KB)`);
    
    const formData = new FormData();
    formData.append('file', uploadFile);

    // Build URL with force parameter if needed
    const uploadUrl = forceUpload 
      ? 'http://localhost:8001/upload?force=true' 
      : 'http://localhost:8001/upload';

    try {
      const response = await axios.post(uploadUrl, formData, {
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
      
      addLog('info', `File uploaded, run ID: ${response.data.run_id}`);
      setCurrentUploadId(response.data.run_id);
      setProcessingProgress({ [response.data.run_id]: 0 });
      
      // Cache the file preview for this run
      if (fileContent) {
        setFilePreviewCache(prev => ({
          ...prev,
          [response.data.run_id]: {
            content: fileContent,
            filename: uploadFile.name
          }
        }));
      }
      
      await fetchRuns();
      await fetchStats();
      
      if (response.data.status === 'skipped') {
        toast.info('File already processed. Skipping duplicate.');
        addLog('warn', 'Duplicate file detected, skipping');
        setUploadProgress(0);
        setCurrentUploadId(null);
        setProcessingTime(Date.now() - startTime);
      } else if (response.data.status === 'pending') {
        toast.success('File uploaded successfully and is being processed.');
        addLog('info', 'Processing started...');
        // Poll for progress updates
        pollProcessingProgress(response.data.run_id, startTime);
      } else {
        toast.success('File uploaded successfully.');
        setUploadProgress(0);
        setCurrentUploadId(null);
        setProcessingTime(Date.now() - startTime);
      }
    } catch (error) {
      console.error('Upload error:', error);
      toast.error('Upload failed: ' + (error.response?.data?.detail || error.message));
      addLog('error', `Upload failed: ${error.response?.data?.detail || error.message}`);
      setUploadProgress(0);
      setCurrentUploadId(null);
      setProcessingTime(null);
      // Don't clear preview on error - user may want to see what they uploaded
    } finally {
      setUploading(false);
    }
  };

  const handleMultiFileUpload = async (files) => {
    const fileArray = Array.from(files);
    const validFiles = fileArray.filter(file => 
      file.name.endsWith('.csv') || 
      file.name.endsWith('.xlsx') || 
      file.name.endsWith('.xls') || 
      file.name.endsWith('.xlsm')
    );

    if (validFiles.length === 0) {
      toast.error('Please upload CSV or Excel files');
      return;
    }

    if (validFiles.length < fileArray.length) {
      toast.warning(`${fileArray.length - validFiles.length} invalid file(s) skipped`);
    }

    soundManager.upload();
    addLog('info', `Starting batch upload: ${validFiles.length} file(s)`);

    // Process files sequentially to avoid overwhelming the server
    for (let i = 0; i < validFiles.length; i++) {
      const file = validFiles[i];
      addLog('info', `Processing file ${i + 1}/${validFiles.length}: ${file.name}`);
      
      try {
        await handleFileUpload(file);
      } catch (error) {
        addLog('error', `Failed to upload ${file.name}: ${error.message}`);
      }
    }

    if (validFiles.length > 1) {
      soundManager.uploadComplete();
      toast.success(`Batch upload complete: ${validFiles.length} files processed`);
      addLog('info', `Batch upload complete: ${validFiles.length} files processed`);
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
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleMultiFileUpload(e.dataTransfer.files);
    }
  };

  const handlePasteUpload = async () => {
    if (!csvText.trim()) {
      toast.error('Please paste CSV content first');
      return;
    }

    // Set the preview data
    setUploadedFileContent(csvText);
    setUploadedFileName('pasted-data.csv');

    setUploading(true);
    try {
      const blob = new Blob([csvText], { type: 'text/csv' });
      const file = new File([blob], 'pasted-data.csv', { type: 'text/csv' });
      await handleFileUpload(file);
      setCsvText('');
    } catch (error) {
      console.error('Paste upload error:', error);
      toast.error('Upload failed: ' + (error.response?.data?.detail || error.message));
      setUploadedFileContent(null);
      setUploadedFileName(null);
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
      const filename = csvUrl.split('/').pop() || 'url-data.csv';
      
      // Set the preview data
      setUploadedFileContent(csvContent);
      setUploadedFileName(filename);
      
      const blob = new Blob([csvContent], { type: 'text/csv' });
      const file = new File([blob], filename, { type: 'text/csv' });
      
      await handleFileUpload(file);
      setCsvUrl('');
    } catch (error) {
      console.error('URL upload error:', error);
      toast.error('Upload failed: ' + error.message);
      setUploadedFileContent(null);
      setUploadedFileName(null);
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
    toast('Delete this run?', {
      description: 'This will permanently delete this run and all its data.',
      action: {
        label: 'Delete',
        onClick: async () => {
          soundManager.delete();
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
        }
      },
      cancel: {
        label: 'Cancel',
        onClick: () => {}
      }
    });
  };

  const handleClearLogs = () => {
    soundManager.click();
    setConsoleLogs([]);
  };

  const handleClearPersistedLogs = () => {
    soundManager.delete();
    setConsoleLogs([]);
    localStorage.removeItem('csvConsoleLogs');
    toast.success('All logs cleared from storage');
  };

  const toggleSound = () => {
    const newState = !soundEnabled;
    setSoundEnabled(newState);
    soundManager.setEnabled(newState);
    if (newState) {
      soundManager.click();
    }
  };

  const handleDeleteAllRuns = async () => {
    toast('Delete ALL runs?', {
      description: 'This will permanently delete ALL runs and their data. This cannot be undone!',
      action: {
        label: 'Delete All',
        onClick: async () => {
          soundManager.delete();
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
        }
      },
      cancel: {
        label: 'Cancel',
        onClick: () => {}
      }
    });
  };

  // Handle duplicate file dialog actions
  const handleDuplicateOverwrite = async () => {
    const { file, existingRun } = duplicateFileDialog;
    setDuplicateFileDialog({ open: false, file: null, existingRun: null });
    
    // Delete the existing run first
    try {
      await axios.delete(`http://localhost:8001/runs/${existingRun.run_id}`);
      await fetchRuns();
      toast.success('Previous run deleted');
    } catch (error) {
      toast.error('Failed to delete previous run');
      return;
    }
    
    // Now upload the file
    await handleFileUpload(file, true);
  };

  const handleDuplicateNewVersion = async () => {
    const { file } = duplicateFileDialog;
    setDuplicateFileDialog({ open: false, file: null, existingRun: null });
    
    // Find the next version number
    const baseName = file.name.split('.')[0];
    const existingVersions = runs.filter(run => 
      run.filename.startsWith(baseName) && run.filename.includes('_v')
    );
    const nextVersion = existingVersions.length + 2; // +2 because original is v1
    
    await handleFileUpload(file, true, nextVersion);
  };

  const handleDuplicateCancel = () => {
    setDuplicateFileDialog({ open: false, file: null, existingRun: null });
  };

  const pollProcessingProgress = async (runId, startTime = null) => {
    const pollInterval = setInterval(async () => {
      try {
        const response = await axios.get(`http://localhost:8001/runs/${runId}`);
        const run = response.data;
        
        if (run.status === 'completed' || run.status === 'failed' || run.status === 'partial_success') {
          clearInterval(pollInterval);
          
          const elapsed = startTime ? Date.now() - startTime : null;
          if (elapsed) {
            setProcessingTime(elapsed);
            addLog('info', `Processing completed in ${(elapsed / 1000).toFixed(2)}s - Status: ${run.status}`);
            addLog('info', `Results: ${run.rows_inserted} inserted, ${run.rows_updated} updated, ${run.errors_count} errors`);
          }
          
          setProcessingProgress(prev => {
            const newProgress = { ...prev };
            delete newProgress[runId];
            return newProgress;
          });
          setUploadProgress(0);
          setCurrentUploadId(null);
          await fetchRuns();
          await fetchStats();
          
          if (run.status === 'completed') {
            soundManager.uploadComplete();
            toast.success(`Processing complete! ${run.rows_inserted} rows inserted.`);
          } else if (run.status === 'partial_success') {
            soundManager.warning();
            toast.warning(`Processing complete with errors. ${run.rows_inserted} inserted, ${run.errors_count} errors.`);
          } else {
            soundManager.error();
            toast.error('Processing failed. Check the console for details.');
          }
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
    }, 500); // Poll every 500ms for faster updates
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
      
      {/* Duplicate File Dialog */}
      <Dialog open={duplicateFileDialog.open} onOpenChange={(open) => !open && handleDuplicateCancel()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Copy className="w-5 h-5 text-yellow-500" />
              Duplicate File Detected
            </DialogTitle>
            <DialogDescription>
              A file named <strong>{duplicateFileDialog.file?.name}</strong> has already been processed.
              {duplicateFileDialog.existingRun && (
                <span className="block mt-2 text-gray-600">
                  Previous run: {new Date(duplicateFileDialog.existingRun.created_at).toLocaleString()} 
                  ({duplicateFileDialog.existingRun.rows_inserted} rows inserted)
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm text-gray-600 mb-4">What would you like to do?</p>
            <div className="space-y-3">
              <button
                onClick={handleDuplicateOverwrite}
                className="w-full p-3 text-left border rounded-lg hover:bg-gray-50 transition-colors"
              >
                <div className="font-medium text-gray-900">Overwrite existing</div>
                <div className="text-sm text-gray-500">Delete the previous run and process this file again</div>
              </button>
              <button
                onClick={handleDuplicateNewVersion}
                className="w-full p-3 text-left border rounded-lg hover:bg-gray-50 transition-colors"
              >
                <div className="font-medium text-gray-900">Create new version</div>
                <div className="text-sm text-gray-500">
                  Save as {duplicateFileDialog.file?.name.replace(/\.([^.]+)$/, '_v2.$1')} and keep both
                </div>
              </button>
            </div>
          </div>
          <DialogFooter>
            <button
              onClick={handleDuplicateCancel}
              className="px-4 py-2 text-gray-600 hover:text-gray-800 transition-colors"
            >
              Cancel
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
          <button
            onClick={() => setShowStatusMeaning(!showStatusMeaning)}
            className="ml-4 p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
            title="What do the statuses mean?"
          >
            <HelpCircle className="w-5 h-5" />
          </button>
          <button
            onClick={toggleSound}
            className={`ml-2 p-2 rounded-lg transition-colors ${soundEnabled ? 'text-blue-500 hover:bg-blue-50' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}
            title={soundEnabled ? "Sound effects on - click to mute" : "Sound effects off - click to enable"}
          >
            {soundEnabled ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}
          </button>
        </header>

        {/* Status Meanings Popup */}
        {showStatusMeaning && (
          <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="flex justify-between items-start mb-2">
              <h3 className="font-semibold text-blue-900">Status Meanings</h3>
              <button
                onClick={() => setShowStatusMeaning(false)}
                className="text-blue-600 hover:text-blue-800"
              >
                ×
              </button>
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex items-center">
                <Clock className="w-4 h-4 text-yellow-500 mr-2" />
                <span className="font-medium">Pending:</span>
                <span className="ml-2 text-gray-600">File uploaded, waiting to be processed</span>
              </div>
              <div className="flex items-center">
                <RefreshCw className="w-4 h-4 text-blue-500 mr-2 animate-spin" />
                <span className="font-medium">Processing:</span>
                <span className="ml-2 text-gray-600">Currently validating and importing data</span>
              </div>
              <div className="flex items-center">
                <CheckCircle className="w-4 h-4 text-green-500 mr-2" />
                <span className="font-medium">Completed:</span>
                <span className="ml-2 text-gray-600">Successfully processed all rows</span>
              </div>
              <div className="flex items-center">
                <XCircle className="w-4 h-4 text-red-500 mr-2" />
                <span className="font-medium">Failed:</span>
                <span className="ml-2 text-gray-600">Processing failed due to an error</span>
              </div>
              <div className="flex items-center">
                <AlertCircle className="w-4 h-4 text-yellow-500 mr-2" />
                <span className="font-medium">Partial Success:</span>
                <span className="ml-2 text-gray-600">Some rows processed, others rejected</span>
              </div>
              <div className="flex items-center">
                <SkipForward className="w-4 h-4 text-gray-500 mr-2" />
                <span className="font-medium">Skipped:</span>
                <span className="ml-2 text-gray-600">Duplicate file, not processed</span>
              </div>
            </div>
          </div>
        )}

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
                        multiple
                        onChange={(e) => e.target.files && handleMultiFileUpload(e.target.files)}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                        disabled={uploading}
                      />
                      <Upload className={`${uiScale <= 0.875 ? 'w-8 h-8' : uiScale >= 1.125 ? 'w-16 h-16' : 'w-12 h-12'} text-gray-400 mx-auto mb-4`} />
                      <p className={`${uiScale <= 0.875 ? 'text-sm' : uiScale >= 1.125 ? 'text-xl' : 'text-lg'} font-medium text-gray-700`}>
                        {uploading ? 'Uploading...' : 'Drop CSV or Excel files here or click to browse'}
                      </p>
                      <p className={`${sizeClasses.container} text-gray-500 mt-2`}>Supports multiple files • CSV, Excel (.xlsx, .xls) with email and optional fields</p>
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
                  <div className="flex justify-between items-center mb-4">
                    <h3 className={`${sizeClasses.title} font-semibold`}>
                      <RefreshCw className="inline w-4 h-4 mr-2 animate-spin" />
                      Processing...
                    </h3>
                    {uploadStartTime && (
                      <ElapsedTimer startTime={uploadStartTime} />
                    )}
                  </div>
                  
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

            {/* Last Processing Time */}
            {processingTime && !uploading && !currentUploadId && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-3 mt-6">
                <p className="text-sm text-green-700">
                  <CheckCircle className="inline w-4 h-4 mr-1" />
                  Last upload completed in <strong>{(processingTime / 1000).toFixed(2)}s</strong>
                </p>
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
                  <table className="w-full table-fixed">
                    <thead>
                      <tr className="border-b text-xs">
                        <th className="text-left py-2 px-2 w-28">Status</th>
                        <th className="text-left py-2 px-2 w-40 truncate">Filename</th>
                        <th className="text-left py-2 px-2 w-24">Created</th>
                        <th className="text-right py-2 px-1 w-14">Rows</th>
                        <th className="text-right py-2 px-1 w-14">Ins.</th>
                        <th className="text-right py-2 px-1 w-14">Upd.</th>
                        <th className="text-right py-2 px-1 w-14">Err.</th>
                        <th className="text-center py-2 px-1 w-16">Prog.</th>
                        <th className="text-center py-2 px-1 w-12"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {runs.map((run) => (
                        <tr
                          key={run.run_id}
                          className={`border-b hover:bg-gray-50 cursor-pointer transition-colors ${selectedRun?.run_id === run.run_id ? 'bg-blue-50 border-l-4 border-l-blue-500' : ''}`}
                          onClick={() => {
                            setSelectedRun(run);
                            fetchErrors(run.run_id);
                            fetchProcessedData(run.run_id);
                          }}
                        >
                          <td className="py-2 px-2">
                            <span className={`${getStatusBadgeClass(run.status)} text-xs`}>
                              {getStatusIcon(run.status)}
                              <span className="ml-1 capitalize hidden sm:inline">{run.status.replace('_', ' ')}</span>
                            </span>
                          </td>
                          <td className={`${sizeClasses.table} px-2 truncate`} title={run.filename}>{run.filename}</td>
                          <td className={`${sizeClasses.table} px-2 text-gray-600 text-xs`}>{formatDate(run.created_at)}</td>
                          <td className={`${sizeClasses.table} px-1 text-right`}>{run.total_rows.toLocaleString()}</td>
                          <td className={`${sizeClasses.table} px-1 text-right text-green-600`}>{run.rows_inserted.toLocaleString()}</td>
                          <td className={`${sizeClasses.table} px-1 text-right text-blue-600`}>{run.rows_updated.toLocaleString()}</td>
                          <td className={`${sizeClasses.table} px-1 text-right text-red-600`}>{run.errors_count}</td>
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
                    {selectedRun.error_message && (
                      <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded">
                        <p className="text-xs text-red-600 font-medium">Error:</p>
                        <p className="text-sm text-red-800">{selectedRun.error_message}</p>
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

        {/* CSV Preview */}
        {uploadedFileContent && (
          <div className="mt-6">
            <CSVPreview 
              data={uploadedFileContent} 
              errors={errors}
              filename={uploadedFileName}
              processedData={processedData}
            />
          </div>
        )}

        {/* Real-time Console */}
        <div className="mt-6">
          <Console 
            logs={consoleLogs}
            onClear={handleClearLogs}
            onClearPersisted={handleClearPersistedLogs}
            isExpanded={consoleExpanded}
            onToggle={() => setConsoleExpanded(!consoleExpanded)}
          />
        </div>

        {/* Footer */}
        <footer className="mt-12 pb-8 text-center text-gray-500 text-sm">
          <p>© {new Date().getFullYear()} PipeCheck. Built by{' '}
            <a 
              href="https://x.com/jeremyboulerice" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-blue-500 hover:text-blue-600 hover:underline transition-colors"
            >
              {/* X(.com) logo icon - black */}
              <svg className="w-4 h-4 inline-block mr-1" viewBox="0 0 24 24" fill="black">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
              </svg>
              @jeremyboulerice
            </a>
            {/* add margin to separator */}
            <span className="mx-2">|</span>
            {/* Github - @ai-armageddon */}
            <a 
              href="https://github.com/ai-armageddon" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-blue-500 hover:text-blue-600 hover:underline transition-colors"
            >
              {/* Github logo icon - black */}
              <svg className="w-4 h-4 inline-block mr-1" viewBox="0 0 24 24" fill="black">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
              </svg>
              ai-armageddon
            </a>
          </p>
        </footer>
      </div>
    </div>
  );
}

export default App;

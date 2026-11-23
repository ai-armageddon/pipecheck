import React, { useState, useEffect, useRef } from 'react';
import { Upload, FileText, ArrowUpRight, AlertCircle, CheckCircle, Clock, XCircle, RefreshCw, ZoomIn, ZoomOut, Link, Clipboard, Download, Trash2, HelpCircle, SkipForward, Volume2, VolumeX, Copy, Flag, X, BookOpen, Braces, PlayCircle } from 'lucide-react';
import axios from 'axios';
import { Toaster, toast } from 'sonner';
import { Progress } from './components/ui/progress';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './components/ui/dialog';
import Console from './Console';
import ProviderSettings, { providerNames } from './components/ProviderSettings';
import CSVPreview from './components/CSVPreview';
import soundManager from './lib/sounds';
import { API_URL, apiUrl, wsUrl } from './lib/api';
import { jsonToCsv } from './lib/csv';
import './App.css';

const ACCEPTED_EXTENSIONS = new Set(['csv', 'xlsx', 'xls', 'xlsm']);
const MAX_PREVIEW_SIZE = 2 * 1024 * 1024;
const MAX_CACHED_PREVIEW_SIZE = 500 * 1024;
const MAX_URL_UPLOAD_SIZE = 25 * 1024 * 1024;

const removeStored = (key) => {
  try {
    localStorage.removeItem(key);
  } catch (error) {
    console.warn(`Unable to clear browser storage value for ${key}:`, error);
  }
};

const readStoredJson = (key, fallback) => {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch (error) {
    console.warn(`Ignoring invalid browser storage value for ${key}:`, error);
    removeStored(key);
    return fallback;
  }
};

const writeStoredJson = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.warn(`Unable to save browser storage value for ${key}:`, error);
    return false;
  }
};

const fileExtension = (filename = '') => {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
};

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'partial_success']);
const POLL_INTERVAL_MS = 500;
const MAX_POLL_FAILURES = 20;
const URL_FETCH_TIMEOUT_MS = 60 * 1000;
const sampleUrl = (format) => `${process.env.PUBLIC_URL || ''}/samples/pipecheck-demo.${format}`;

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
    <span className="text-sm text-slate-400 font-mono tabular-nums">
      {seconds}s
    </span>
  );
};

function App() {
  const [runs, setRuns] = useState([]);
  const [stats, setStats] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [selectedRun, setSelectedRun] = useState(null);
  const [reviewRequest, setReviewRequest] = useState({ runId: null, revision: 0 });
  const [provider, setProvider] = useState(() => readStoredJson('pipecheckRepairProvider', null));
  const providerHeaders = provider ? { 'X-PipeCheck-Provider': provider } : {};
  const [dragActive, setDragActive] = useState(false);
  const [uiScale, setUiScale] = useState(() => {
    const storedScale = Number(readStoredJson('pipecheckUiScale', 0.875));
    return storedScale >= 0.75 && storedScale <= 1.375 ? storedScale : 0.875;
  });
  const [uploadProgress, setUploadProgress] = useState(0);
  const [processingProgress, setProcessingProgress] = useState({});
  const [currentUploadId, setCurrentUploadId] = useState(null);
  const [consoleLogs, setConsoleLogs] = useState([]);
  const [consoleExpanded, setConsoleExpanded] = useState(false);
  const [showStatusMeaning, setShowStatusMeaning] = useState(false);
  const [uploadStartTime, setUploadStartTime] = useState(null);
  const [processingTime, setProcessingTime] = useState(null);
  const [filePreviewCache, setFilePreviewCache] = useState(() => {
    const cached = readStoredJson('csvFilePreviewCache', {});
    return cached && typeof cached === 'object' && !Array.isArray(cached) ? cached : {};
  });
  const [soundEnabled, setSoundEnabled] = useState(soundManager.enabled);
  const [duplicateFileDialog, setDuplicateFileDialog] = useState({ open: false, file: null, existingRun: null });
  const ws = useRef(null);
  const [uploadMethod, setUploadMethod] = useState('file'); // file, paste
  const [csvText, setCsvText] = useState('');
  const [csvUrl, setCsvUrl] = useState('');
  const [pasteFormat, setPasteFormat] = useState('csv');
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [tutorialFormat, setTutorialFormat] = useState('csv');
  const [tutorialLoading, setTutorialLoading] = useState(false);
  const pollingRuns = useRef(new Map());
  const pendingReplacements = useRef(new Map());
  const handleFileUploadRef = useRef(null);
  const addLogRef = useRef(null);
  const pollProcessingProgressRef = useRef(null);

  useEffect(() => {
    fetchRuns();
    fetchStats();
    const interval = setInterval(() => {
      fetchRuns();
      fetchStats();
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // WebSocket connection for real-time logs. Reconnect after API restarts or
  // brief network interruptions instead of leaving the console permanently stale.
  useEffect(() => {
    let disposed = false;
    let retryTimer = null;
    let attempts = 0;

    const scheduleReconnect = () => {
      if (disposed) return;
      attempts += 1;
      const delay = Math.min(1000 * (2 ** (attempts - 1)), 15000);
      if (attempts === 1) {
        addLogRef.current?.('warn', 'Real-time console disconnected; reconnecting…');
      }
      retryTimer = window.setTimeout(connect, delay);
    };

    const connect = () => {
      let socket;
      try {
        socket = new WebSocket(wsUrl('/ws'));
      } catch (error) {
        console.warn('Unable to open WebSocket:', error);
        scheduleReconnect();
        return;
      }
      ws.current = socket;

      socket.onopen = () => {
        const reconnected = attempts > 0;
        attempts = 0;
        addLogRef.current?.('info', reconnected ? 'Real-time console reconnected' : 'Connected to real-time console');
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'log') {
            addLogRef.current?.(data.level, data.message, data.timestamp, data.run_id);
          }
        } catch (error) {
          console.warn('Ignored malformed WebSocket message:', error);
        }
      };

      socket.onclose = scheduleReconnect;

      socket.onerror = () => socket.close();
    };

    retryTimer = window.setTimeout(connect, 0);

    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      ws.current?.close();
    };
  }, []);

  // Load logs and console state from localStorage on mount and fetch recent logs from backend
  useEffect(() => {
    // First load from localStorage
    const savedLogs = readStoredJson('csvConsoleLogs', []);
    const savedConsoleState = readStoredJson('csvConsoleExpanded', false);

    if (Array.isArray(savedLogs)) setConsoleLogs(savedLogs.slice(-250));
    setConsoleExpanded(savedConsoleState === true);
    
    // Then fetch recent logs from backend
    const fetchRecentLogs = async () => {
      try {
        const response = await axios.get(apiUrl('/logs/recent?limit=50'));
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
      writeStoredJson('csvConsoleLogs', consoleLogs.slice(-250));
    } else {
      removeStored('csvConsoleLogs');
    }
  }, [consoleLogs]);

  // Save console state to localStorage whenever it changes
  useEffect(() => {
    writeStoredJson('csvConsoleExpanded', consoleExpanded);
  }, [consoleExpanded]);

  useEffect(() => {
    writeStoredJson('pipecheckUiScale', uiScale);
  }, [uiScale]);

  // Save file preview cache to localStorage
  useEffect(() => {
    const cacheable = Object.entries(filePreviewCache)
      .filter(([, preview]) => preview?.content?.length <= MAX_CACHED_PREVIEW_SIZE)
      .slice(-3);
    if (cacheable.length > 0) {
      writeStoredJson('csvFilePreviewCache', Object.fromEntries(cacheable));
    } else {
      removeStored('csvFilePreviewCache');
    }
  }, [filePreviewCache]);

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
  addLogRef.current = addLog;

  // Poll for progress of processing runs
  useEffect(() => {
    const processingRuns = runs.filter(run => run.status === 'processing' || run.status === 'pending');
    
    processingRuns.forEach(run => {
      if (!pollingRuns.current.has(run.run_id)) {
        pollProcessingProgressRef.current?.(run.run_id);
      }
    });
  }, [runs]);

  useEffect(() => () => {
    pollingRuns.current.forEach(interval => window.clearInterval(interval));
    pollingRuns.current.clear();
  }, []);

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
                handleFileUploadRef.current?.(file);
                e.preventDefault();
              }
            }
          }
        }
      }
    };

    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [uploadMethod]);

  const fetchRuns = async () => {
    try {
      const response = await axios.get(apiUrl('/runs'));
      setRuns(response.data);
      // Only auto-select first run on initial load, not on polling
      setSelectedRun(prev => {
        if (!prev && response.data.length > 0) {
          return response.data[0];
        }
        // Keep current selection, but update with fresh data if it exists
        if (prev) {
          const updated = response.data.find(r => r.run_id === prev.run_id);
          return updated || response.data[0] || null;
        }
        return prev;
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching runs:', error);
      return null;
    }
  };

  const fetchStats = async () => {
    try {
      const response = await axios.get(apiUrl('/stats'));
      setStats(response.data);
    } catch (error) {
      console.error('Error fetching stats:', error);
    }
  };

  const handleFileUpload = async (file, forceUpload = false, versionSuffix = null, replacingRunId = null) => {
    if (!file || !ACCEPTED_EXTENSIONS.has(fileExtension(file.name))) {
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

    const previewable = fileExtension(uploadFile.name) === 'csv' && file.size <= MAX_PREVIEW_SIZE;
    let fileContent = null;
    
    if (previewable) {
      // Read file content for preview
      const reader = new FileReader();
      reader.onload = (e) => {
        fileContent = e.target.result;
      };
      reader.onerror = (e) => {
        console.error('FileReader error:', e);
      };
      
      // Wait for file to be read before proceeding
      await new Promise((resolve) => {
        reader.onloadend = resolve;
        reader.readAsText(uploadFile);
      });
    } else if (fileExtension(uploadFile.name) === 'csv') {
      const sizeMB = (file.size / 1024 / 1024).toFixed(1);
      addLog('info', `Large file detected (${sizeMB} MB); browser preview skipped`);
    } else {
      addLog('info', `Excel preview is shown after server processing completes`);
    }

    soundManager.upload();
    const startTime = Date.now();
    setUploadStartTime(startTime);
    setProcessingTime(null);
    setUploading(true);
    setUploadProgress(0);
    addLog('info', `Starting upload: ${uploadFile.name} (${file.size > 1024 * 1024 ? (file.size / 1024 / 1024).toFixed(1) + ' MB' : (file.size / 1024).toFixed(1) + ' KB'})`);
    
    const formData = new FormData();
    formData.append('file', uploadFile);

    // Build URL with force parameter if needed
    const uploadUrl = forceUpload 
      ? apiUrl('/upload?force=true') 
      : apiUrl('/upload');

    let uploadResult = null;
    try {
      const response = await axios.post(uploadUrl, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
          ...providerHeaders,
        },
        onUploadProgress: (progressEvent) => {
          if (!progressEvent.total) return;
          const percentCompleted = Math.round(
            (progressEvent.loaded * 100) / progressEvent.total
          );
          setUploadProgress(percentCompleted);
        },
      });
      uploadResult = response.data;
      if (replacingRunId) pendingReplacements.current.set(uploadResult.run_id, replacingRunId);
      
      addLog('info', `File uploaded, run ID: ${response.data.run_id}`);
      setCurrentUploadId(response.data.run_id);
      setProcessingProgress(prev => ({ ...prev, [response.data.run_id]: 0 }));
      
      // Cache the file preview for this run
      if (fileContent) {
        setFilePreviewCache(prev => ({
          ...Object.fromEntries(Object.entries(prev).filter(([id]) => id !== response.data.run_id).slice(-2)),
          [response.data.run_id]: {
            content: fileContent,
            filename: uploadFile.name
          }
        }));
      }
      
      const latestRuns = await fetchRuns();
      await fetchStats();
      const uploadedRun = latestRuns?.find(run => run.run_id === response.data.run_id);
      if (uploadedRun) setSelectedRun(uploadedRun);
      
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
    return uploadResult;
  };
  handleFileUploadRef.current = handleFileUpload;

  const handleMultiFileUpload = async (files) => {
    const fileArray = Array.from(files);
    const validFiles = fileArray.filter(file => 
      ACCEPTED_EXTENSIONS.has(fileExtension(file.name))
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
    let uploaded = 0;
    for (let i = 0; i < validFiles.length; i++) {
      const file = validFiles[i];
      addLog('info', `Processing file ${i + 1}/${validFiles.length}: ${file.name}`);
      
      try {
        if (await handleFileUpload(file)) uploaded += 1;
      } catch (error) {
        addLog('error', `Failed to upload ${file.name}: ${error.message}`);
      }
    }

    if (validFiles.length > 1) {
      const summary = `Batch upload complete: ${uploaded} of ${validFiles.length} files uploaded`;
      if (uploaded === validFiles.length) {
        soundManager.uploadComplete();
        toast.success(summary);
      } else {
        toast.warning(summary);
      }
      addLog(uploaded === validFiles.length ? 'info' : 'warn', summary);
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

    try {
      const uploadContent = pasteFormat === 'json' ? jsonToCsv(JSON.parse(csvText)) : csvText;
      const filename = pasteFormat === 'json' ? 'pasted-json-data.csv' : 'pasted-data.csv';
      if (pasteFormat === 'json') {
        addLog('info', 'Converted pasted JSON records to CSV for processing');
      }
      const blob = new Blob([uploadContent], { type: 'text/csv' });
      const file = new File([blob], filename, { type: 'text/csv' });
      if (await handleFileUpload(file)) setCsvText('');
    } catch (error) {
      console.error('Paste upload error:', error);
      toast.error(`${pasteFormat.toUpperCase()} upload failed: ${error.response?.data?.detail || error.message}`);
    }
  };

  const loadTutorialSample = async (runImmediately = false) => {
    setTutorialLoading(true);
    try {
      const response = await fetch(sampleUrl(tutorialFormat));
      if (!response.ok) throw new Error('Sample data is unavailable');
      const source = await response.text();
      const csv = tutorialFormat === 'json' ? jsonToCsv(JSON.parse(source)) : source;

      if (runImmediately) {
        const file = new File([csv], `pipecheck-demo-${tutorialFormat}.csv`, { type: 'text/csv' });
        setTutorialOpen(false);
        addLog('info', `Starting guided ${tutorialFormat.toUpperCase()} demo`);
        await handleFileUpload(file);
      } else {
        setUploadMethod('paste');
        setPasteFormat(tutorialFormat);
        setCsvText(source);
        setTutorialOpen(false);
        window.requestAnimationFrame(() => document.getElementById('paste-data-input')?.focus());
        toast.success(`${tutorialFormat.toUpperCase()} sample loaded. Review it, then click Process ${tutorialFormat.toUpperCase()} data.`);
      }
    } catch (error) {
      toast.error(`Could not load sample: ${error.message}`);
    } finally {
      setTutorialLoading(false);
    }
  };

  const handleUrlUpload = async () => {
    if (!csvUrl.trim()) {
      toast.error('Please enter a URL first');
      return;
    }

    let url;
    try {
      url = new URL(csvUrl.trim());
    } catch (error) {
      toast.error('Please enter a valid URL');
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      toast.error('Only http and https URLs are supported');
      return;
    }

    setUploading(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
    try {
      // First fetch the CSV from URL
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`.trim());
      }
      
      const declaredSize = Number(response.headers.get('content-length') || 0);
      if (declaredSize > MAX_URL_UPLOAD_SIZE) throw new Error('Remote file exceeds the 25 MB URL-import limit');
      const blob = await response.blob();
      if (blob.size > MAX_URL_UPLOAD_SIZE) throw new Error('Remote file exceeds the 25 MB URL-import limit');
      if (blob.size === 0) throw new Error('Remote file is empty');

      let filename = url.pathname.split('/').pop() || '';
      try {
        filename = decodeURIComponent(filename);
      } catch (error) {
        // Keep the raw segment when it contains malformed percent-escapes.
      }
      if (!ACCEPTED_EXTENSIONS.has(fileExtension(filename))) {
        // Export endpoints (e.g. ?format=csv) often have no extension. Accept
        // them when the server says the body is text, otherwise refuse.
        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        if (!/csv|text\/plain|octet-stream/.test(contentType) && contentType !== '') {
          throw new Error('URL must point to a CSV or Excel file');
        }
        filename = `${filename.replace(/[^\w.-]+/g, '_') || 'url-data'}.csv`;
      }
      
      const file = new File([blob], filename, { type: blob.type || 'text/csv' });
      
      if (await handleFileUpload(file)) setCsvUrl('');
    } catch (error) {
      console.error('URL upload error:', error);
      const message = error.name === 'AbortError'
        ? 'The remote server did not respond in time'
        : error.message === 'Failed to fetch'
          ? 'The remote server refused the request (it may not allow cross-origin downloads)'
          : error.message;
      toast.error('Upload failed: ' + message);
    } finally {
      window.clearTimeout(timeout);
      setUploading(false);
    }
  };

  const handleExport = async (runId, format = 'csv') => {
    try {
      const response = await axios.get(`${API_URL}/export/${runId}?format=${format}`, {
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
      const response = await axios.get(`${API_URL}/errors/${runId}/export?format=${format}`, {
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
      const response = await axios.get(`${API_URL}/export/all?format=${format}`, {
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
            await axios.delete(`${API_URL}/runs/${runId}`);
            
            // Refresh the runs list
            await fetchRuns();
            await fetchStats();
            
            // Clear selected run if it was deleted
            if (selectedRun && selectedRun.run_id === runId) {
              setSelectedRun(null);
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

  const handleReprocessRun = async (runId) => {
    soundManager.click();
    try {
      addLog('info', `Reprocessing run ${runId}...`);
      await axios.post(`${API_URL}/runs/${runId}/reprocess`, null, { headers: providerHeaders });
      
      setCurrentUploadId(runId);
      setProcessingProgress(prev => ({ ...prev, [runId]: 0 }));
      
      await fetchRuns();
      toast.success('Reprocessing started');
      addLog('info', 'Reprocessing started...');
      
      // Poll for progress
      pollProcessingProgress(runId, Date.now());
    } catch (error) {
      console.error('Reprocess error:', error);
      toast.error('Reprocess failed: ' + (error.response?.data?.detail || error.message));
      addLog('error', `Reprocess failed: ${error.response?.data?.detail || error.message}`);
    }
  };

  const handleClearLogs = () => {
    soundManager.click();
    setConsoleLogs([]);
  };

  const handleClearPersistedLogs = () => {
    soundManager.delete();
    setConsoleLogs([]);
    removeStored('csvConsoleLogs');
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
            await axios.delete(apiUrl('/runs'));
            
            // Clear all data
            setRuns([]);
            setSelectedRun(null);
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

    await handleFileUpload(file, true, null, existingRun.run_id);
  };

  const handleDuplicateNewVersion = async () => {
    const { file } = duplicateFileDialog;
    setDuplicateFileDialog({ open: false, file: null, existingRun: null });
    
    // Find the next version number
    const extension = fileExtension(file.name);
    const baseName = file.name.slice(0, -(extension.length + 1));
    const existingVersions = runs.filter(run => 
      run.filename === file.name || new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_v\\d+\\.${extension}$`, 'i').test(run.filename)
    );
    const versionNumbers = existingVersions.map(run => {
      const match = run.filename.match(/_v(\d+)\.[^.]+$/i);
      return match ? Number(match[1]) : 1;
    });
    const nextVersion = Math.max(1, ...versionNumbers) + 1;
    
    await handleFileUpload(file, true, nextVersion);
  };

  const handleDuplicateCancel = () => {
    setDuplicateFileDialog({ open: false, file: null, existingRun: null });
  };

  const pollProcessingProgress = async (runId, startTime = null) => {
    if (pollingRuns.current.has(runId)) return;

    let inFlight = false;
    let finished = false;
    let failures = 0;
    const stop = () => {
      finished = true;
      clearInterval(pollInterval);
      pollingRuns.current.delete(runId);
    };

    const pollInterval = setInterval(async () => {
      if (inFlight || finished) return;
      inFlight = true;
      try {
        const response = await axios.get(`${API_URL}/runs/${runId}`, { timeout: 10000 });
        failures = 0;
        if (finished) return;
        const run = response.data;
        
        if (TERMINAL_STATUSES.has(run.status)) {
          stop();
          const previousRunId = pendingReplacements.current.get(runId);
          if (previousRunId) {
            pendingReplacements.current.delete(runId);
            if (run.status !== 'failed' && run.rows_inserted + run.rows_updated > 0) {
              try {
                await axios.delete(apiUrl(`/runs/${previousRunId}`));
                toast.success('Previous run replaced');
              } catch {
                toast.warning('Replacement completed. The previous run is still available.');
              }
            } else {
              toast.warning('Replacement produced no usable result. The previous run is still available.');
            }
          }

          const elapsed = startTime ? Date.now() - startTime : null;
          if (elapsed) {
            setProcessingTime(elapsed);
            addLog('info', `Processing completed in ${(elapsed / 1000).toFixed(2)}s - Status: ${run.status}`);
            addLog('info', `Results: ${run.rows_inserted} inserted, ${run.rows_updated} updated, ${run.rows_rejected || 0} rejected, ${run.rows_flagged || 0} needing review`);
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
            const parts = [`${run.rows_inserted} inserted`];
            if (run.rows_rejected) parts.push(`${run.rows_rejected} rejected`);
            if (run.rows_flagged) parts.push(`${run.rows_flagged} needing review`);
            toast.warning(`Processing complete: ${parts.join(', ')}.`);
          } else {
            soundManager.error();
            toast.error('Processing failed. Check the console for details.');
          }
        } else if (run.status === 'processing') {
          // Progress counts each row exactly once, by outcome.
          const handled = run.rows_inserted + run.rows_updated
            + (run.rows_skipped || 0) + (run.rows_rejected || 0);
          const progress = run.total_rows > 0
            ? Math.min(100, Math.round((handled / run.total_rows) * 100))
            : 0;
          setProcessingProgress(prev => ({ ...prev, [runId]: progress }));
        }
      } catch (error) {
        console.error('Error polling progress:', error);
        failures += 1;
        if (error.response?.status === 404) {
          stop();
          setProcessingProgress(prev => {
            const newProgress = { ...prev };
            delete newProgress[runId];
            return newProgress;
          });
        } else if (failures >= MAX_POLL_FAILURES) {
          stop();
          addLog('warn', 'Progress updates paused; the dashboard will retry automatically');
        }
      } finally {
        inFlight = false;
      }
    }, POLL_INTERVAL_MS);
    pollingRuns.current.set(runId, pollInterval);
  };
  pollProcessingProgressRef.current = pollProcessingProgress;

  const formatDate = (dateString) => {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleString();
  };

  const getSizeClasses = () => {
    const scale = uiScale;
    
    return {
      container: scale <= 0.875 ? 'text-sm' : scale >= 1.125 ? 'text-base' : 'text-sm',
      card: scale <= 0.875 ? 'p-4' : scale >= 1.125 ? 'p-6' : 'p-5',
      table: scale <= 0.875 ? 'text-xs' : scale >= 1.125 ? 'text-base' : 'text-sm',
      icon: scale <= 0.875 ? 'w-4 h-4' : scale >= 1.125 ? 'w-6 h-6' : 'w-5 h-5',
      title: scale <= 0.875 ? 'text-base' : scale >= 1.125 ? 'text-xl' : 'text-lg'
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
    <div className={`workspace ${sizeClasses.container}`} id="top" style={{ '--desk-scale': uiScale / 0.875 }}>
      <a className="skip-link" href="#import">Skip to import</a>
      <Toaster 
        position="top-right"
        expand={false}
        richColors
        closeButton
      />

      <Dialog open={tutorialOpen} onOpenChange={setTutorialOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto p-5 sm:p-6">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BookOpen className="h-5 w-5 text-indigo-600" />
              Guided PipeCheck demo
            </DialogTitle>
            <DialogDescription>
              Start with four realistic records. The sample includes clean values, deterministic cleanup, and repairs that must be reviewed.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ['1', 'Choose a source', 'Use CSV directly or see JSON converted before ingest.'],
              ['2', 'Process the sample', 'PipeCheck validates, normalizes, deduplicates, and flags guesses.'],
              ['3', 'Inspect the result', 'Compare counters, issues, final data, and exports.'],
            ].map(([step, title, description]) => (
              <div key={step} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <span className="chip mb-2 bg-indigo-100 text-indigo-700">Step {step}</span>
                <p className="text-sm font-semibold text-slate-800">{title}</p>
                <p className="mt-1 text-xs leading-relaxed text-slate-500">{description}</p>
              </div>
            ))}
          </div>

          <div className="segmented w-full">
            <button
              onClick={() => setTutorialFormat('csv')}
              className={`segmented-item flex-1 justify-center ${tutorialFormat === 'csv' ? 'segmented-item-active' : ''}`}
            >
              <FileText className="h-4 w-4" /> CSV sample
            </button>
            <button
              onClick={() => setTutorialFormat('json')}
              className={`segmented-item flex-1 justify-center ${tutorialFormat === 'json' ? 'segmented-item-active' : ''}`}
            >
              <Braces className="h-4 w-4" /> JSON sample
            </button>
          </div>

          <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-4">
            <p className="text-sm font-semibold text-indigo-950">
              {tutorialFormat === 'csv' ? 'CSV goes straight to the pipeline' : 'JSON is converted to CSV in your browser'}
            </p>
            <p className="mt-1 text-sm text-indigo-800/75">
              {tutorialFormat === 'csv'
                ? 'The quoted city value also demonstrates correct handling of commas inside fields.'
                : 'PipeCheck still processes CSV/Excel on the backend; the conversion is explicit and the original JSON remains downloadable.'}
            </p>
          </div>

          <DialogFooter className="gap-2 sm:space-x-0">
            <a
              href={sampleUrl(tutorialFormat)}
              download
              className="btn-outline px-4 py-2 text-sm"
            >
              <Download className="h-4 w-4" /> Download sample
            </a>
            <button
              onClick={() => loadTutorialSample(false)}
              disabled={tutorialLoading}
              className="btn-outline px-4 py-2 text-sm"
            >
              <Clipboard className="h-4 w-4" /> Load in editor
            </button>
            <button
              onClick={() => loadTutorialSample(true)}
              disabled={tutorialLoading || uploading}
              className="btn-primary px-4 py-2 text-sm"
            >
              {tutorialLoading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
              Run demo
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      {/* Duplicate File Dialog */}
      <Dialog open={duplicateFileDialog.open} onOpenChange={(open) => !open && handleDuplicateCancel()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Copy className="w-5 h-5 text-amber-500" />
              Duplicate File Detected
            </DialogTitle>
            <DialogDescription>
              A file named <strong>{duplicateFileDialog.file?.name}</strong> has already been processed.
              {duplicateFileDialog.existingRun && (
                <span className="block mt-2 text-slate-600">
                  Previous run: {new Date(duplicateFileDialog.existingRun.created_at).toLocaleString()} 
                  ({duplicateFileDialog.existingRun.rows_inserted} rows inserted)
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm text-slate-500 mb-4">What would you like to do?</p>
            <div className="space-y-3">
              <button
                onClick={handleDuplicateOverwrite}
                className="w-full p-3.5 text-left rounded-xl border border-slate-200 transition-all hover:border-indigo-300 hover:bg-indigo-50/50 hover:shadow-sm"
              >
                <div className="font-medium text-slate-900">Overwrite existing</div>
                <div className="text-sm text-slate-500">Delete the previous run and process this file again</div>
              </button>
              <button
                onClick={handleDuplicateNewVersion}
                className="w-full p-3.5 text-left rounded-xl border border-slate-200 transition-all hover:border-indigo-300 hover:bg-indigo-50/50 hover:shadow-sm"
              >
                <div className="font-medium text-slate-900">Create new version</div>
                <div className="text-sm text-slate-500">
                  Save as {duplicateFileDialog.file?.name.replace(/\.([^.]+)$/, '_v2.$1')} and keep both
                </div>
              </button>
            </div>
          </div>
          <DialogFooter>
            <button
              onClick={handleDuplicateCancel}
              className="btn-ghost px-4 py-2 text-sm"
            >
              Cancel
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <header className="masthead">
        <div className="shell masthead-inner">
          <a href="#top" className="wordmark" aria-label="PipeCheck home">
            <span className="pipe-mark" aria-hidden="true"><i /><i /><i /></span>
            PipeCheck
          </a>
          <nav aria-label="Workspace sections" className="desk-nav">
            <a href="#history">Run history</a>
            {selectedRun && <a href="#review">Review</a>}
            <a href="#console">Console</a>
          </nav>
          <div className="desk-tools">
              <ProviderSettings provider={provider} onChange={value => {
                setProvider(value);
                writeStoredJson('pipecheckRepairProvider', value);
              }} />
              <button
                onClick={() => setTutorialOpen(true)}
                className="btn-outline h-9 px-2.5 text-xs sm:px-3"
                title="Open the guided demo"
                aria-label="Open guided demo"
              >
                <BookOpen className="h-4 w-4 text-indigo-600" />
                <span className="hidden sm:inline">Try demo</span>
              </button>
              <div className="scale-control hidden lg:flex items-center gap-1.5 px-2 py-1.5">
                <button
                  onClick={() => setUiScale(0.75)}
                  className={`rounded-md p-1 transition-colors ${uiScale === 0.75 ? 'bg-indigo-50 text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}
                  title="75% - Smallest"
                >
                  <ZoomOut className="w-3.5 h-3.5" />
                </button>
                <input
                  type="range" aria-label="Interface scale"
                  min="0.75"
                  max="1.375"
                  step="0.125"
                  value={uiScale}
                  onChange={(e) => setUiScale(parseFloat(e.target.value))}
                  className="h-1 w-20 cursor-pointer appearance-none rounded-full accent-indigo-600"
                  style={{
                    background: `linear-gradient(to right, #31634d 0%, #31634d ${((uiScale - 0.75) / 0.625) * 100}%, #d5d9cd ${((uiScale - 0.75) / 0.625) * 100}%, #d5d9cd 100%)`
                  }}
                />
                <button
                  onClick={() => setUiScale(1.375)}
                  className={`rounded-md p-1 transition-colors ${uiScale === 1.375 ? 'bg-indigo-50 text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}
                  title="137.5% - Largest"
                >
                  <ZoomIn className="w-3.5 h-3.5" />
                </button>
                <span className="w-9 text-right font-mono text-xs text-slate-400">
                  {Math.round(uiScale * 100)}%
                </span>
              </div>
              <button
                onClick={() => setShowStatusMeaning(!showStatusMeaning)}
                className={`icon-btn h-9 w-9 ${showStatusMeaning ? 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100 hover:text-indigo-700' : ''}`}
                title="What do the statuses mean?"
              >
                <HelpCircle className="w-5 h-5" />
              </button>
              <button
                onClick={toggleSound}
                className={`icon-btn h-9 w-9 ${soundEnabled ? 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100 hover:text-indigo-700' : ''}`}
                title={soundEnabled ? "Sound effects on - click to mute" : "Sound effects off - click to enable"}
              >
                {soundEnabled ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}
              </button>
          </div>
        </div>
      </header>

      <main className="shell desk-main">

        {/* Status Meanings Popup */}
        {showStatusMeaning && (
          <div className="card animate-scaleIn fixed right-4 top-[4.5rem] z-50 w-80 max-w-[calc(100vw-2rem)] p-4 shadow-card-hover">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold tracking-tight text-slate-900">Status Meanings</h3>
              <button
                onClick={() => setShowStatusMeaning(false)}
                className="icon-btn h-7 w-7"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-2.5 text-sm">
              <div className="flex items-start gap-2.5">
                <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <div>
                  <span className="font-medium text-slate-800">Pending</span>
                  <span className="text-slate-500"> — file uploaded, waiting to be processed</span>
                </div>
              </div>
              <div className="flex items-start gap-2.5">
                <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-indigo-500" />
                <div>
                  <span className="font-medium text-slate-800">Processing</span>
                  <span className="text-slate-500"> — currently validating and importing data</span>
                </div>
              </div>
              <div className="flex items-start gap-2.5">
                <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                <div>
                  <span className="font-medium text-slate-800">Completed</span>
                  <span className="text-slate-500"> — successfully processed all rows</span>
                </div>
              </div>
              <div className="flex items-start gap-2.5">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />
                <div>
                  <span className="font-medium text-slate-800">Failed</span>
                  <span className="text-slate-500"> — processing failed due to an error</span>
                </div>
              </div>
              <div className="flex items-start gap-2.5">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <div>
                  <span className="font-medium text-slate-800">Partial Success</span>
                  <span className="text-slate-500"> — some rows processed, others rejected</span>
                </div>
              </div>
              <div className="flex items-start gap-2.5">
                <SkipForward className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                <div>
                  <span className="font-medium text-slate-800">Skipped</span>
                  <span className="text-slate-500"> — duplicate file, not processed</span>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="workspace-heading">
          <h1>Ingestion workspace<span aria-hidden="true">.</span></h1>
          {stats && <dl className="workspace-stats">
            <div><dt>Runs</dt><dd>{stats.total_runs.toLocaleString()}</dd></div>
            <div><dt>Rows processed</dt><dd>{stats.total_rows_processed.toLocaleString()}</dd></div>
            <div><dt>Success rate</dt><dd>{stats.success_rate.toFixed(1)}<small>%</small></dd></div>
            <div><dt>Last run</dt><dd className="last-status">{stats.last_run ? stats.last_run.status.replace('_', ' ') : 'No runs yet'}</dd></div>
          </dl>}
        </div>

        <div className="intake-layout">
          <div className="min-w-0">
            <section className="import-panel" id="import" aria-labelledby="import-title">
              <div className="import-inner">
                <div className="import-heading">
                  <h2 id="import-title">Import data</h2>
                  <div className="source-tabs" aria-label="Import method">
                    {[[ 'file', 'File', Upload ], [ 'paste', 'Paste', Clipboard ], [ 'url', 'URL', Link ]].map(([id, label, Icon]) => (
                      <button key={id} aria-pressed={uploadMethod === id} onClick={() => setUploadMethod(id)}>
                        <Icon size={15} />{label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* File Upload Method */}
                {uploadMethod === 'file' && (
                  <div className={`drop-surface ${dragActive ? 'is-dragging' : ''}`}
                    onDragEnter={handleDrag} onDragLeave={handleDrag} onDragOver={handleDrag} onDrop={handleDrop}>
                    <input type="file" aria-label="Browse CSV or Excel files" accept=".csv,.xlsx,.xls,.xlsm" multiple
                      disabled={uploading} onChange={e => e.target.files && handleMultiFileUpload(e.target.files)} />
                    <div className="drop-copy">
                      <h3>{uploading ? 'Uploading…' : dragActive ? 'Release to import' : 'Drop your files here'}</h3>
                      <p>CSV or Excel · multiple files supported</p>
                      <span className="browse-action">Browse files <ArrowUpRight size={17} /></span>
                    </div>
                    <div className="sheet-stack" aria-hidden="true"><div className="sheet-face"><i /><b /></div></div>
                  </div>
                )}
                {uploadMethod === 'url' && (
                  <div className="import-form">
                    <label className="field-label" htmlFor="source-url">Source URL</label>
                    <div className="flex gap-2">
                      <input id="source-url" type="url" value={csvUrl} onChange={e => setCsvUrl(e.target.value)}
                        placeholder="https://example.com/data.csv" className="input min-w-0 flex-1 px-3 py-2" disabled={uploading} />
                      <button onClick={handleUrlUpload} disabled={uploading || !csvUrl.trim()} className="btn-primary px-4 py-2">
                        {uploading ? 'Fetching…' : 'Fetch file'}
                      </button>
                    </div>
                  </div>
                )}

                {/* Paste Raw Data Method */}
                {uploadMethod === 'paste' && (
                  <div className="import-form">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div className="segmented">
                        <button
                          onClick={() => setPasteFormat('csv')}
                          className={`segmented-item ${pasteFormat === 'csv' ? 'segmented-item-active' : ''}`}
                        >
                          <FileText className="h-4 w-4" /> CSV
                        </button>
                        <button
                          onClick={() => setPasteFormat('json')}
                          className={`segmented-item ${pasteFormat === 'json' ? 'segmented-item-active' : ''}`}
                        >
                          <Braces className="h-4 w-4" /> JSON
                        </button>
                      </div>
                      <button onClick={() => setTutorialOpen(true)} className="btn-ghost px-2 py-1 text-xs">
                        <BookOpen className="h-3.5 w-3.5" /> Use sample data
                      </button>
                    </div>
                    <textarea
                      aria-label="Data to paste" id="paste-data-input"
                      value={csvText}
                      onChange={(e) => setCsvText(e.target.value)}
                      placeholder={pasteFormat === 'json'
                        ? '[\n  { "name": "Jane Doe", "email": "jane@example.com" }\n]'
                        : 'name,email,phone\nJane Doe,jane@example.com,555-1234'}
                      className="input h-44 w-full p-3 font-mono text-sm"
                      disabled={uploading}
                    />
                    {pasteFormat === 'json' && (
                      <p className="mt-2 text-xs text-slate-500">
                        Accepts a JSON array of objects and converts it to CSV locally before upload.
                      </p>
                    )}
                    <button
                      onClick={handlePasteUpload}
                      disabled={uploading || !csvText.trim()}
                      className="btn-primary mt-3 px-4 py-2 text-sm"
                    >
                      {uploading ? 'Processing...' : `Process ${pasteFormat.toUpperCase()} data`}
                    </button>
                  </div>
                )}
              </div>
            </section>

            {/* Progress Bar */}
            {(uploading || currentUploadId) && (
              <div className="card animate-rise mt-6">
                <div className={`${sizeClasses.card}`}>
                  <div className="flex justify-between items-center mb-4">
                    <h3 className={`${sizeClasses.title} card-title flex items-center gap-2`}>
                      <RefreshCw className="w-4 h-4 animate-spin text-indigo-500" />
                      Processing...
                    </h3>
                    {uploadStartTime && (
                      <ElapsedTimer startTime={uploadStartTime} />
                    )}
                  </div>

                  {uploadProgress < 100 && (
                    <div className="mb-4">
                      <div className="flex justify-between text-sm text-slate-500 mb-2">
                        <span>Uploading file...</span>
                        <span className="font-medium tabular-nums text-slate-700">{uploadProgress}%</span>
                      </div>
                      <Progress value={uploadProgress} className="h-2" />
                    </div>
                  )}

                  {currentUploadId && processingProgress[currentUploadId] !== undefined && (
                    <div>
                      <div className="flex justify-between text-sm text-slate-500 mb-2">
                        <span>Processing file...</span>
                        <span className="font-medium tabular-nums text-slate-700">{processingProgress[currentUploadId] || 0}%</span>
                      </div>
                      <Progress value={processingProgress[currentUploadId] || 0} className="h-2" />
                      <p className="text-xs text-slate-400 mt-2">
                        Validating and processing your data. This may take a moment for large files.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Last Processing Time */}
            {processingTime && !uploading && !currentUploadId && (
              <div className="animate-rise mt-6 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                <CheckCircle className="w-4 h-4 text-emerald-600" />
                <p className="text-sm text-emerald-800">
                  Last upload completed in <strong>{(processingTime / 1000).toFixed(2)}s</strong>
                </p>
              </div>
            )}

          </div>

          <aside className="inspector" aria-label="Run details">
            <div className="inspector-top"><span className="label-micro">{selectedRun ? 'Selected run' : 'Sample dataset'}</span>
              {selectedRun && <span className={getStatusBadgeClass(selectedRun.status)}>{selectedRun.status.replace('_', ' ')}</span>}
            </div>
            {selectedRun ? <>
              <h2 title={selectedRun.filename}>{selectedRun.filename}</h2>
              <div className="run-meta">
                <span title={selectedRun.run_id}>{selectedRun.run_id.slice(0, 8)}</span>
                <span>Created {formatDate(selectedRun.created_at)}</span>
                {selectedRun.completed_at && <span>Completed {formatDate(selectedRun.completed_at)}</span>}
                {selectedRun.repair_provider && <span>{providerNames[selectedRun.repair_provider]}</span>}
              </div>
              <dl className="outcomes">
                {[
                  ['Total rows', selectedRun.total_rows], ['Inserted', selectedRun.rows_inserted],
                  ['Updated', selectedRun.rows_updated], ['Skipped', selectedRun.rows_skipped],
                  ['Rejected', selectedRun.rows_rejected], ['Needs review', selectedRun.rows_flagged],
                ].map(([label, value]) => <div key={label} data-attention={Boolean(value && ['Rejected', 'Needs review'].includes(label))}>
                  <dt>{label}</dt><dd>{(value || 0).toLocaleString()}</dd>
                </div>)}
              </dl>
              {selectedRun.error_message && <p className="run-warning">{selectedRun.error_message}</p>}
              {selectedRun.rows_flagged > 0 && <a className="review-notice" href="#review" onClick={() => setReviewRequest(prev => ({ runId: selectedRun.run_id, revision: prev.revision + 1 }))}>
                <Flag size={14} /> Review {selectedRun.rows_flagged} {selectedRun.rows_flagged === 1 ? 'row' : 'rows'} with inferred values <ArrowUpRight size={14} />
              </a>}
              <div className="export-lines">
                {[
                  ['Processed data', handleExport, ['completed', 'partial_success'].includes(selectedRun.status)],
                  ['Error report', handleExportErrors, ['partial_success', 'failed'].includes(selectedRun.status)],
                ].filter(([, , visible]) => visible).map(([label, handler]) => <div key={label}>
                  <span>{label}</span>
                  {['csv', 'excel'].map(format => <button key={format} aria-label={`Export ${label.toLowerCase()} as ${format}`}
                    onClick={() => handler(selectedRun.run_id, format)}><Download size={12} /> {format === 'csv' ? 'CSV' : 'Excel'}</button>)}
                </div>)}
              </div>
            </> : <div className="sample-intro">
              <h2>Try a sample import</h2>
              <p>Four contact records with inconsistent emails and phone numbers. Compare the source values with the repairs.</p>
              <div className="sample-file"><FileText size={16} /><span>pipecheck-demo.csv</span><a href={sampleUrl('csv')} download aria-label="Download sample CSV"><Download size={15} /></a></div>
              <button className="btn-outline px-3 py-2 text-sm" onClick={() => setTutorialOpen(true)}>Open guided demo <ArrowUpRight size={15} /></button>
            </div>}
          </aside>
        </div>
        <section className="history-panel card" id="history">
          <div className={`${sizeClasses.card}`}>
            <div className="flex flex-wrap justify-between items-center gap-3 mb-4">
              <div className="flex items-center gap-2.5">
                <h2 className={`${sizeClasses.title} card-title`}>Run history</h2>
                {runs.length > 0 && (
                  <span className="chip bg-indigo-50 text-indigo-600 ring-1 ring-indigo-100">{runs.length}</span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  disabled={!runs.length} onClick={() => handleExportAll('csv')}
                  className="btn-outline px-3 py-1.5 text-xs"
                >
                  <Download className="w-3.5 h-3.5 text-emerald-600" />
                  Export CSV
                </button>
                <button
                  disabled={!runs.length} onClick={() => handleExportAll('excel')}
                  className="btn-outline px-3 py-1.5 text-xs"
                >
                  <Download className="w-3.5 h-3.5 text-emerald-600" />
                  Export Excel
                </button>
                <button
                  disabled={!runs.length} onClick={handleDeleteAllRuns}
                  className="btn-danger px-3 py-1.5 text-xs"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete All
                </button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] table-fixed">
                <colgroup>
                  <col className="w-[15%]" />
                  <col className="w-[17%]" />
                  <col className="w-[14%]" />
                  <col className="w-[9%]" />
                  <col className="w-[9%]" />
                  <col className="w-[7%]" />
                  <col className="w-[8%]" />
                  <col className="w-[10%]" />
                  <col className="w-[11%]" />
                </colgroup>
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="label-micro px-2 py-2.5 text-left">Status</th>
                    <th className="label-micro truncate px-2 py-2.5 text-left">Filename</th>
                    <th className="label-micro px-2 py-2.5 text-left">Created</th>
                    <th className="label-micro px-1 py-2.5 text-right">Rows</th>
                    <th className="label-micro px-1 py-2.5 text-right">Inserted</th>
                    <th className="label-micro px-1 py-2.5 text-right">Updated</th>
                    <th className="label-micro px-1 py-2.5 text-right" title="Rejected rows / rows needing review">Issues</th>
                    <th className="label-micro px-1 py-2.5 text-center">Progress</th>
                    <th className="px-1 py-2.5 text-center"></th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr
                      key={run.run_id}
                      className={`border-b border-slate-100 hover:bg-slate-50/80 cursor-pointer transition-colors ${selectedRun?.run_id === run.run_id ? 'selected-run' : ''}`}
                      onClick={() => {
                        setSelectedRun(run);
                      }}
                    >
                      <td className="py-2.5 px-2">
                        <span className={`${getStatusBadgeClass(run.status)} text-xs`}>
                          <span className={`h-1.5 w-1.5 rounded-full bg-current ${run.status === 'processing' ? 'animate-pulse' : ''}`} />
                          <span className="ml-1 capitalize">{run.status.replace('_', ' ')}</span>
                        </span>
                      </td>
                      <td className={`${sizeClasses.table} px-2 truncate font-medium text-slate-700`} title={run.filename}><button className="run-filename" aria-pressed={selectedRun?.run_id === run.run_id} onClick={() => setSelectedRun(run)}>{run.filename}</button></td>
                      <td className={`${sizeClasses.table} px-2 text-slate-500 text-xs`}>{formatDate(run.created_at)}</td>
                      <td className={`${sizeClasses.table} px-1 text-right tabular-nums text-slate-600`}>{run.total_rows.toLocaleString()}</td>
                      <td className={`${sizeClasses.table} px-1 text-right tabular-nums text-emerald-600`}>{run.rows_inserted.toLocaleString()}</td>
                      <td className={`${sizeClasses.table} px-1 text-right tabular-nums text-indigo-600`}>{run.rows_updated.toLocaleString()}</td>
                      <td className={`${sizeClasses.table} px-1 text-right whitespace-nowrap tabular-nums`}>
                        <span className={(run.rows_rejected ?? run.errors_count) ? 'text-rose-700' : 'text-slate-500'} title={`${run.rows_rejected ?? run.errors_count} rejected`}>
                          {run.rows_rejected ?? run.errors_count}
                        </span>
                        {run.rows_flagged > 0 && (
                          <span
                            className="ml-1 inline-flex items-center gap-0.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200"
                            title={`${run.rows_flagged} row(s) repaired with invented values - review before use`}
                          >
                            <Flag className="w-3 h-3" />{run.rows_flagged}
                          </span>
                        )}
                      </td>
                      <td className={`${sizeClasses.table} text-center`}>
                        {run.status === 'processing' ? (
                          <div className="flex items-center justify-center gap-2">
                            <span className="text-xs text-slate-500 tabular-nums w-8 text-right">
                              {processingProgress[run.run_id] || 0}%
                            </span>
                            <div className="w-16 bg-slate-100 rounded-full h-1.5 overflow-hidden">
                              <div
                                className="bg-gradient-to-r from-indigo-500 to-violet-500 h-1.5 rounded-full transition-all duration-300"
                                style={{ width: `${processingProgress[run.run_id] || 0}%` }}
                              />
                            </div>
                          </div>
                        ) : run.status === 'completed' ? (
                          <span className="text-emerald-600 text-xs font-medium">100%</span>
                        ) : run.status === 'failed' ? (
                          <span className="text-rose-600 text-xs font-medium">Failed</span>
                        ) : (
                          <span className="text-slate-300 text-xs">—</span>
                        )}
                      </td>
                      <td className={`${sizeClasses.table} text-center`}>
                        <div className="flex justify-center gap-0.5">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleReprocessRun(run.run_id);
                            }}
                            disabled={run.status === 'pending' || run.status === 'processing'}
                            className="icon-btn h-7 w-7 hover:bg-indigo-50 hover:text-indigo-600 disabled:cursor-not-allowed disabled:opacity-40"
                            title={run.status === 'pending' || run.status === 'processing' ? 'Run is already processing' : 'Reprocess file'}
                          >
                            <RefreshCw className="w-4 h-4" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteRun(run.run_id);
                            }}
                            className="icon-btn h-7 w-7 hover:bg-rose-50 hover:text-rose-600"
                            title="Delete run"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {runs.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100">
                    <FileText className="h-5 w-5 text-slate-400" />
                  </div>
                  <p className="font-medium text-slate-600">No runs yet</p>
                  <p className="text-sm text-slate-400 mt-0.5">Upload a CSV or Excel file to get started.</p>
                </div>
              )}
            </div>
          </div>
        </section>
        {selectedRun && (
          <div id="review" className="mt-6">
            <CSVPreview key={`${selectedRun.run_id}-${reviewRequest.revision}`} run={selectedRun}
              showFlagged={reviewRequest.runId === selectedRun.run_id}
              data={filePreviewCache[selectedRun.run_id]?.content}
              onExport={handleExport} onExportErrors={handleExportErrors} />
          </div>
        )}

        {/* Real-time Console */}
        <div id="console" className="mt-6">
          <Console 
            logs={consoleLogs}
            onClear={handleClearLogs}
            onClearPersisted={handleClearPersistedLogs}
            isExpanded={consoleExpanded}
            onToggle={() => setConsoleExpanded(!consoleExpanded)}
          />
        </div>

        {/* Footer */}
        <footer className="mt-12 pb-10 text-center text-slate-400 text-sm">
          <p>© {new Date().getFullYear()} PipeCheck. Built by{' '}
            <a 
              href="https://x.com/jeremyboulerice" 
              target="_blank" 
              rel="noopener noreferrer"
              className="font-medium text-slate-500 hover:text-indigo-600 transition-colors"
            >
              {/* X(.com) logo icon - black */}
              <svg className="w-4 h-4 inline-block mr-1" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
              </svg>
              @jeremyboulerice
            </a>
            {/* add margin to separator */}
            <span className="mx-2 text-slate-300">|</span>
            {/* Github - @ai-armageddon */}
            <a 
              href="https://github.com/ai-armageddon" 
              target="_blank" 
              rel="noopener noreferrer"
              className="font-medium text-slate-500 hover:text-indigo-600 transition-colors"
            >
              {/* Github logo icon - black */}
              <svg className="w-4 h-4 inline-block mr-1" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
              </svg>
              ai-armageddon
            </a>
          </p>
        </footer>
      </main>
    </div>
  );
}

export default App;

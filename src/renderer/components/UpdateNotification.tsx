import React, { useState, useEffect } from 'react';
import { Download, X, RefreshCw, CheckCircle } from 'lucide-react';

interface UpdateInfo {
  version: string;
  releaseNotes?: string;
}

interface UpdateProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

type UpdateState = 'idle' | 'available' | 'downloading' | 'downloaded' | 'error';

const UpdateNotification: React.FC = () => {
  const [updateState, setUpdateState] = useState<UpdateState>('idle');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const api = window.electronAPI;

    api.onUpdateAvailable((info) => {
      setUpdateInfo(info);
      setUpdateState('available');
      setDismissed(false);
    });

    api.onUpdateNotAvailable(() => {
      setUpdateState('idle');
    });

    api.onUpdateDownloadProgress((prog) => {
      setProgress(prog);
      setUpdateState('downloading');
    });

    api.onUpdateDownloaded((info) => {
      setUpdateInfo(info);
      setUpdateState('downloaded');
    });

    api.onUpdateError((err) => {
      setError(err.message);
      setUpdateState('error');
    });

    return () => {
      api.removeUpdateListeners();
    };
  }, []);

  const handleDownload = async () => {
    setUpdateState('downloading');
    setProgress({ percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 });
    await window.electronAPI.downloadUpdate();
  };

  const handleInstall = () => {
    window.electronAPI.installUpdate();
  };

  const handleDismiss = () => {
    setDismissed(true);
  };

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  if (dismissed || updateState === 'idle') {
    return null;
  }

  return (
    <div className="update-notification">
      {updateState === 'available' && updateInfo && (
        <>
          <div className="update-notification-content">
            <Download size={20} />
            <span>
              Version {updateInfo.version} is available
            </span>
          </div>
          <div className="update-notification-actions">
            <button className="update-btn primary" onClick={handleDownload}>
              Download
            </button>
            <button className="update-btn secondary" onClick={handleDismiss}>
              <X size={16} />
            </button>
          </div>
        </>
      )}

      {updateState === 'downloading' && progress && (
        <>
          <div className="update-notification-content">
            <RefreshCw size={20} className="spinning" />
            <span>
              Downloading... {progress.percent.toFixed(0)}%
            </span>
          </div>
          <div className="update-progress-bar">
            <div
              className="update-progress-fill"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
          <div className="update-progress-info">
            {formatBytes(progress.transferred)} / {formatBytes(progress.total)}
            {' - '}
            {formatBytes(progress.bytesPerSecond)}/s
          </div>
        </>
      )}

      {updateState === 'downloaded' && updateInfo && (
        <>
          <div className="update-notification-content">
            <CheckCircle size={20} />
            <span>
              Version {updateInfo.version} ready to install
            </span>
          </div>
          <div className="update-notification-actions">
            <button className="update-btn primary" onClick={handleInstall}>
              Install & Restart
            </button>
            <button className="update-btn secondary" onClick={handleDismiss}>
              Later
            </button>
          </div>
        </>
      )}

      {updateState === 'error' && (
        <>
          <div className="update-notification-content error">
            <X size={20} />
            <span>Update error: {error}</span>
          </div>
          <button className="update-btn secondary" onClick={handleDismiss}>
            <X size={16} />
          </button>
        </>
      )}
    </div>
  );
};

export default UpdateNotification;

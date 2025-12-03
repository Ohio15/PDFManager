import { contextBridge, ipcRenderer } from 'electron';

export interface FileData {
  path: string;
  data: string;
}

export interface ImageData {
  path: string;
  data: string;
  type: string;
}

export interface SaveResult {
  success: boolean;
  path?: string;
  error?: string;
  canceled?: boolean;
}

export interface UpdateInfo {
  version: string;
  releaseNotes?: string;
}

export interface UpdateProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

export interface ElectronAPI {
  openFileDialog: () => Promise<FileData | null>;
  readFileByPath: (filePath: string) => Promise<FileData | null>;
  saveFile: (data: string, filePath: string) => Promise<SaveResult>;
  saveFileDialog: (data: string, defaultPath?: string) => Promise<SaveResult>;
  openImageDialog: () => Promise<ImageData | null>;
  getStore: (key: string) => Promise<unknown>;
  setStore: (key: string, value: unknown) => Promise<void>;
  onFileOpened: (callback: (data: FileData) => void) => void;
  onMenuAction: (action: string, callback: () => void) => void;
  removeMenuListener: (action: string) => void;
  // Auto-update methods
  checkForUpdates: () => Promise<{ success: boolean; updateInfo?: unknown; error?: string }>;
  downloadUpdate: () => Promise<{ success: boolean; error?: string }>;
  installUpdate: () => void;
  getAppVersion: () => Promise<string>;
  onUpdateAvailable: (callback: (info: UpdateInfo) => void) => void;
  onUpdateNotAvailable: (callback: (info: { version: string }) => void) => void;
  onUpdateDownloadProgress: (callback: (progress: UpdateProgress) => void) => void;
  onUpdateDownloaded: (callback: (info: UpdateInfo) => void) => void;
  onUpdateError: (callback: (error: { message: string }) => void) => void;
  removeUpdateListeners: () => void;
}

const electronAPI: ElectronAPI = {
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  readFileByPath: (filePath: string) => ipcRenderer.invoke('read-file-by-path', filePath),
  saveFile: (data: string, filePath: string) =>
    ipcRenderer.invoke('save-file', { data, filePath }),
  saveFileDialog: (data: string, defaultPath?: string) =>
    ipcRenderer.invoke('save-file-dialog', { data, defaultPath }),
  openImageDialog: () => ipcRenderer.invoke('open-image-dialog'),
  getStore: (key: string) => ipcRenderer.invoke('get-store', key),
  setStore: (key: string, value: unknown) =>
    ipcRenderer.invoke('set-store', key, value),
  onFileOpened: (callback: (data: FileData) => void) => {
    ipcRenderer.on('file-opened', (_event, data) => callback(data));
  },
  onMenuAction: (action: string, callback: () => void) => {
    ipcRenderer.on(`menu-${action}`, callback);
  },
  removeMenuListener: (action: string) => {
    ipcRenderer.removeAllListeners(`menu-${action}`);
  },
  // Auto-update methods
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  onUpdateAvailable: (callback: (info: UpdateInfo) => void) => {
    ipcRenderer.on('update-available', (_event, info) => callback(info));
  },
  onUpdateNotAvailable: (callback: (info: { version: string }) => void) => {
    ipcRenderer.on('update-not-available', (_event, info) => callback(info));
  },
  onUpdateDownloadProgress: (callback: (progress: UpdateProgress) => void) => {
    ipcRenderer.on('update-download-progress', (_event, progress) => callback(progress));
  },
  onUpdateDownloaded: (callback: (info: UpdateInfo) => void) => {
    ipcRenderer.on('update-downloaded', (_event, info) => callback(info));
  },
  onUpdateError: (callback: (error: { message: string }) => void) => {
    ipcRenderer.on('update-error', (_event, error) => callback(error));
  },
  removeUpdateListeners: () => {
    ipcRenderer.removeAllListeners('update-available');
    ipcRenderer.removeAllListeners('update-not-available');
    ipcRenderer.removeAllListeners('update-download-progress');
    ipcRenderer.removeAllListeners('update-downloaded');
    ipcRenderer.removeAllListeners('update-error');
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

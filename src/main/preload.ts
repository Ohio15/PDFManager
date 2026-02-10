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
  // Multi-file operations
  openMultipleFilesDialog: () => Promise<FileData[] | null>;
  selectOutputDirectory: () => Promise<string | null>;
  saveFileToPath: (data: string, filePath: string) => Promise<SaveResult>;
  saveImageToPath: (data: string, filePath: string) => Promise<SaveResult>;
  openFolder: (folderPath: string) => Promise<{ success: boolean; error?: string }>;
  openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
  // Recent files
  getRecentFiles: () => Promise<string[]>;
  addRecentFile: (filePath: string) => Promise<string[]>;
  clearRecentFiles: () => Promise<string[]>;
  // Document conversion
  detectLibreOffice: () => Promise<string | null>;
  onLibreOfficeStatus: (callback: (path: string | null) => void) => void;
  openDocumentsDialog: () => Promise<string[] | null>;
  convertToPdf: (inputPath: string, outputDir: string) => Promise<{ success: boolean; path?: string; data?: string; error?: string }>;
  getPrinters: () => Promise<Array<{ name: string; displayName: string; description: string; isDefault: boolean; status: number }>>;
  printPdf: (options: { html: string; printerName: string; copies: number; landscape: boolean; color: boolean; scaleFactor: number }) => Promise<{ success: boolean; error?: string }>;
  getLaunchFile: () => Promise<{ path: string; data: string } | null>;
  // Auto-recovery
  saveAutoRecovery: (data: string, filePath: string | null, fileName: string) => Promise<{ success: boolean; error?: string }>;
  checkAutoRecovery: () => Promise<{ originalPath: string | null; fileName: string; timestamp: number } | null>;
  loadAutoRecovery: () => Promise<{ data: string; filePath: string | null; fileName: string } | null>;
  clearAutoRecovery: () => Promise<{ success: boolean }>;
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
  // Multi-file operations
  openMultipleFilesDialog: () => ipcRenderer.invoke('open-multiple-files-dialog'),
  selectOutputDirectory: () => ipcRenderer.invoke('select-output-directory'),
  saveFileToPath: (data: string, filePath: string) =>
    ipcRenderer.invoke('save-file-to-path', { data, filePath }),
  saveImageToPath: (data: string, filePath: string) =>
    ipcRenderer.invoke('save-image-to-path', { data, filePath }),
  openFolder: (folderPath: string) => ipcRenderer.invoke('open-folder', folderPath),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  // Recent files
  getRecentFiles: () => ipcRenderer.invoke('get-recent-files'),
  addRecentFile: (filePath: string) => ipcRenderer.invoke('add-recent-file', filePath),
  clearRecentFiles: () => ipcRenderer.invoke('clear-recent-files'),
  // Document conversion
  detectLibreOffice: () => ipcRenderer.invoke('detect-libreoffice'),
  onLibreOfficeStatus: (callback: (path: string | null) => void) => {
    ipcRenderer.on('libreoffice-status', (_event, path) => callback(path));
  },
  openDocumentsDialog: () => ipcRenderer.invoke('open-documents-dialog'),
  convertToPdf: (inputPath: string, outputDir: string) =>
    ipcRenderer.invoke('convert-to-pdf', { inputPath, outputDir }),
  getPrinters: () => ipcRenderer.invoke('get-printers'),
  printPdf: (options: { html: string; printerName: string; copies: number; landscape: boolean; color: boolean; scaleFactor: number }) =>
    ipcRenderer.invoke('print-pdf', options),
  getLaunchFile: () => ipcRenderer.invoke('get-launch-file'),
  // Auto-recovery
  saveAutoRecovery: (data: string, filePath: string | null, fileName: string) =>
    ipcRenderer.invoke('save-auto-recovery', { data, filePath, fileName }),
  checkAutoRecovery: () => ipcRenderer.invoke('check-auto-recovery'),
  loadAutoRecovery: () => ipcRenderer.invoke('load-auto-recovery'),
  clearAutoRecovery: () => ipcRenderer.invoke('clear-auto-recovery'),
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

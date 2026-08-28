import { contextBridge, ipcRenderer } from 'electron';
import type { ElectronAPI, FileData, UpdateInfo, UpdateProgress } from '../shared/ipc';

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
  removeFileOpenedListener: () => {
    ipcRenderer.removeAllListeners('file-opened');
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
  showSaveDocxDialog: (defaultName: string, defaultDir?: string) =>
    ipcRenderer.invoke('show-save-docx-dialog', { defaultName, defaultDir }),
  scanDirectoryForPdfs: (dirPath: string) => ipcRenderer.invoke('scan-directory-for-pdfs', dirPath),
  readFileRaw: (filePath: string) => ipcRenderer.invoke('read-file-raw', filePath),
  pickPdfFile: () => ipcRenderer.invoke('pick-pdf-file'),
  checkFileExists: (filePath: string) => ipcRenderer.invoke('check-file-exists', filePath),
  saveFileToPath: (data: string, filePath: string) =>
    ipcRenderer.invoke('save-file-to-path', { data, filePath }),
  saveRawBytesToPath: (data: ArrayBuffer, filePath: string) =>
    ipcRenderer.invoke('save-raw-bytes-to-path', { data, filePath }),
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
  stageDroppedDocument: (data: string, fileName: string) =>
    ipcRenderer.invoke('stage-dropped-document', { data, fileName }),
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

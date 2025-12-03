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
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

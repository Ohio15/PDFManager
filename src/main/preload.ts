import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DropResult, ElectronAPI, FileData, UpdateInfo, UpdateProgress } from '../shared/ipc';

// --- Trusted drag-and-drop ----------------------------------------------------
//
// Threat model. The main world (React app + pdf.js) is treated as potentially
// compromised: a hostile PDF that reaches script execution there can call any
// electronAPI method with any argument. It must NOT be able to make main bless
// a path of its choosing. So:
//
//  1. Only THIS isolated-world listener talks to main about drops, over a
//     private channel (TRUSTED_DROP_CHANNEL) that is never exposed through
//     contextBridge. The main world has no function that sends a path to it.
//  2. The listener acts only on `event.isTrusted` drops — events the browser
//     generated from a real user drag. A `new DragEvent('drop')` dispatched by
//     page script is untrusted and is ignored.
//  3. Paths come only from webUtils.getPathForFile(). It returns a path solely
//     for native, OS-backed File objects; a File the page constructs (even one
//     smuggled into a real drag via dataTransfer.items.add in dragstart)
//     yields "" and is skipped. The page therefore cannot name the path.
//  4. Main re-validates every path as untrusted (canonical, existing, regular
//     file, allowed extension, no UNC/device/ADS) and blesses those EXACT files
//     only — never their directories (see BlessedFileRegistry in security.ts).
//  5. The main world gets back only {path, name} records for files the user
//     actually dropped, via takeDroppedFiles(). Correlation is by dispatch
//     order, not by an id the page could forge: this capture-phase listener on
//     window runs first in the drop's dispatch and parks the pending result;
//     the app's own drop listener claims it synchronously later in the SAME
//     dispatch; a macrotask after dispatch discards an unclaimed result.
//
// Residual risk (documented, not mitigated here): native code execution inside
// the renderer process can forge IPC on the private channel directly. That
// attacker still only gets files that exist, are regular PDF/convertible files
// on a local volume, blessed one-by-one — and main accepts the channel only
// from the main window's top frame.
const TRUSTED_DROP_CHANNEL = 'internal:trusted-drop'; // mirrors shared/ipc.ts

let pendingDrop: Promise<DropResult> | null = null;

const emptyDrop = (rejected = 0): DropResult => ({ files: [], rejected });

/** Coerce main's reply into a well-formed DropResult (defensive; main is trusted). */
function normalizeDropReply(reply: unknown, unresolved: number): DropResult {
  if (!reply || typeof reply !== 'object') return emptyDrop(unresolved);
  const { files, rejected } = reply as { files?: unknown; rejected?: unknown };
  const records = Array.isArray(files)
    ? files
        .filter((f): f is { path: string; name: string } =>
          !!f && typeof f === 'object' &&
          typeof (f as { path?: unknown }).path === 'string' &&
          typeof (f as { name?: unknown }).name === 'string')
        .map((f) => ({ path: f.path, name: f.name }))
    : [];
  const refused = typeof rejected === 'number' && Number.isFinite(rejected) ? rejected : 0;
  return { files: records, rejected: refused + unresolved };
}

window.addEventListener(
  'drop',
  (event: DragEvent) => {
    // Any drop — trusted or not — first invalidates a previous unclaimed record,
    // so a forged drop can never pick up a stale real one.
    pendingDrop = null;
    if (!event.isTrusted) return;
    const fileList = event.dataTransfer?.files;
    if (!fileList || fileList.length === 0) return;

    const paths: string[] = [];
    let unresolved = 0;
    for (const file of Array.from(fileList)) {
      let filePath = '';
      try {
        filePath = webUtils.getPathForFile(file);
      } catch {
        filePath = '';
      }
      if (filePath) {
        paths.push(filePath);
      } else {
        unresolved++;
      }
    }

    const total = fileList.length;
    const result: Promise<DropResult> =
      paths.length === 0
        ? Promise.resolve(emptyDrop(unresolved))
        : ipcRenderer
            .invoke(TRUSTED_DROP_CHANNEL, paths)
            .then((reply: unknown) => normalizeDropReply(reply, unresolved))
            .catch(() => emptyDrop(total));
    pendingDrop = result;
    // Expire after this event's dispatch completes (a macrotask runs only once
    // every listener of the drop has returned; a microtask would not).
    setTimeout(() => {
      if (pendingDrop === result) pendingDrop = null;
    }, 0);
  },
  true
);

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
  // Trusted drag-and-drop (see the threat model above)
  takeDroppedFiles: () => {
    const claimed = pendingDrop;
    pendingDrop = null;
    return claimed ?? Promise.resolve(emptyDrop());
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

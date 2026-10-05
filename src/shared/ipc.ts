/**
 * Single source of truth for the renderer<->main IPC contract.
 *
 * The preload script (src/main/preload.ts) implements ElectronAPI and exposes
 * it via contextBridge; renderer code consumes it as window.electronAPI (typed
 * by the global declaration below). Add new IPC methods HERE first, then
 * implement them in preload.ts and handle them in main.ts.
 */

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

/** One file from a trusted OS drag-and-drop, blessed by main for exact-file access. */
export interface DroppedFileRecord {
  /** Canonical on-disk path (main-validated; usable with readFileByPath/saveFile). */
  path: string;
  /** Display name (basename). */
  name: string;
}

/** Outcome of one drop: the blessed files and how many dropped items were refused. */
export interface DropResult {
  files: DroppedFileRecord[];
  rejected: number;
}

/**
 * Private preload -> main channel carrying the paths of a TRUSTED drop. It is
 * deliberately NOT part of ElectronAPI: the main world can never invoke it.
 * (preload.ts repeats this literal — a sandboxed preload cannot require a
 * sibling module at runtime, only type-import it.)
 */
export const TRUSTED_DROP_CHANNEL = 'internal:trusted-drop';

export interface ElectronAPI {
  openFileDialog: () => Promise<FileData | null>;
  readFileByPath: (filePath: string) => Promise<FileData | null>;
  saveFile: (data: string, filePath: string) => Promise<SaveResult>;
  saveFileDialog: (data: string, defaultPath?: string) => Promise<SaveResult>;
  openImageDialog: () => Promise<ImageData | null>;
  getStore: (key: string) => Promise<unknown>;
  setStore: (key: string, value: unknown) => Promise<void>;
  onFileOpened: (callback: (data: FileData) => void) => void;
  removeFileOpenedListener: () => void;
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
  showSaveDocxDialog: (defaultName: string, defaultDir?: string) => Promise<string | null>;
  scanDirectoryForPdfs: (dirPath: string) => Promise<string[]>;
  readFileRaw: (filePath: string) => Promise<ArrayBuffer | null>;
  pickPdfFile: () => Promise<string | null>;
  checkFileExists: (filePath: string) => Promise<boolean>;
  saveFileToPath: (data: string, filePath: string) => Promise<SaveResult>;
  saveRawBytesToPath: (data: ArrayBuffer, filePath: string) => Promise<SaveResult>;
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
  getPrinters: () => Promise<Array<{ name: string; displayName: string; description: string }>>;
  printPdf: (options: { html: string; printerName: string; copies: number; landscape: boolean; color: boolean; scaleFactor: number }) => Promise<{ success: boolean; error?: string }>;
  getLaunchFile: () => Promise<FileData | null>;
  // Auto-recovery
  saveAutoRecovery: (data: string, filePath: string | null, fileName: string) => Promise<{ success: boolean; error?: string }>;
  checkAutoRecovery: () => Promise<{ originalPath: string | null; fileName: string; timestamp: number } | null>;
  loadAutoRecovery: () => Promise<{ data: string; filePath: string | null; fileName: string } | null>;
  clearAutoRecovery: () => Promise<{ success: boolean }>;
  // Trusted drag-and-drop
  /**
   * Claim the blessed files of the drop event CURRENTLY being dispatched. Must
   * be called synchronously from a 'drop' listener (before any await): the
   * preload records a trusted drop in its capture-phase listener and the
   * record lives only until that event's dispatch finishes. One-shot — a second
   * call for the same drop, or a call for a synthetic/forged drop, resolves to
   * an empty result.
   */
  takeDroppedFiles: () => Promise<DropResult>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as path from 'path';
import * as fs from 'fs';
import { execFile, spawn } from 'child_process';
import Store from 'electron-store';

// Define config schema for type safety
interface StoreSchema {
  windowBounds: { width: number; height: number; x?: number; y?: number };
  sidebarVisible: boolean;
  toolsPanelVisible: boolean;
  lastOpenDirectory: string;
  lastSaveDirectory: string;
  recentFiles: string[];
  autoConvertOnDrop: boolean;
  openFolderAfterConversion: boolean;
  libreOfficePath: string | null;
  theme: 'light' | 'dark' | 'system';
  defaultZoom: number;
}

const store = new Store<StoreSchema>({
  defaults: {
    windowBounds: { width: 1400, height: 900 },
    sidebarVisible: true,
    toolsPanelVisible: true,
    lastOpenDirectory: '',
    lastSaveDirectory: '',
    recentFiles: [],
    autoConvertOnDrop: true,
    openFolderAfterConversion: true,
    libreOfficePath: null,
    theme: 'system',
    defaultZoom: 100,
  },
});

let mainWindow: BrowserWindow | null = null;
let fileToOpenOnReady: string | null = null;

// Extract PDF file path from command-line arguments
function getFileFromArgs(args: string[]): string | null {
  for (const arg of args) {
    if (arg.toLowerCase().endsWith('.pdf') && fs.existsSync(arg)) {
      return arg;
    }
  }
  return null;
}

// Single instance lock - ensure only one instance runs
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

// Auto-updater configuration
autoUpdater.autoDownload = false; // User must confirm download
autoUpdater.autoInstallOnAppQuit = true;

// GitHub token for private repo access
// This token needs 'repo' scope for private repos
// Priority: 1) Environment variable, 2) Config file, 3) Hardcoded fallback
function getGitHubToken(): string {
  // Check environment variables first
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

  // Check for config file in app directory (for production)
  try {
    const configPath = app.isPackaged
      ? path.join(process.resourcesPath, 'update-config.json')
      : path.join(__dirname, '../../update-config.json');

    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.githubToken) return config.githubToken;
    }
  } catch (e) {
    // Config file doesn't exist or is invalid
  }

  // Hardcoded fallback for private distribution (replace with your token)
  // WARNING: Only use this for private/internal distribution
  return '';
}

const GITHUB_TOKEN = getGitHubToken();

if (GITHUB_TOKEN) {
  autoUpdater.requestHeaders = {
    Authorization: `token ${GITHUB_TOKEN}`,
  };
  console.log('GitHub token configured for auto-updates');
} else {
  console.log('No GitHub token - updates will only work for public repos');
}

function setupAutoUpdater(): void {
  // Only check for updates in production
  if (!app.isPackaged) {
    console.log('Skipping auto-update check in development mode');
    return;
  }

  // Check for updates on startup
  autoUpdater.checkForUpdates().catch((err) => {
    console.log('Update check failed:', err);
  });

  // Update available - notify renderer
  autoUpdater.on('update-available', (info) => {
    console.log('Update available:', info.version);
    mainWindow?.webContents.send('update-available', {
      version: info.version,
      releaseNotes: info.releaseNotes,
    });
  });

  // No update available
  autoUpdater.on('update-not-available', (info) => {
    console.log('No update available:', info.version);
    mainWindow?.webContents.send('update-not-available', {
      version: info.version,
    });
  });

  // Download progress
  autoUpdater.on('download-progress', (progress) => {
    console.log('Download progress:', progress.percent);
    mainWindow?.webContents.send('update-download-progress', {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  // Update downloaded - ready to install
  autoUpdater.on('update-downloaded', (info) => {
    console.log('Update downloaded:', info.version);
    mainWindow?.webContents.send('update-downloaded', {
      version: info.version,
      releaseNotes: info.releaseNotes,
    });
  });

  // Error handling
  autoUpdater.on('error', (err) => {
    console.error('Auto-updater error:', err);
    mainWindow?.webContents.send('update-error', {
      message: err.message,
    });
  });
}

function createWindow(): void {
  const bounds = store.get('windowBounds');

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    icon: path.join(__dirname, '../../assets/icon.png'),
    title: 'PDF Manager',
  });

  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

  if (isDev) {
    mainWindow.loadURL('http://localhost:5200');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Save window bounds on resize/move
  mainWindow.on('resize', () => {
    if (mainWindow && !mainWindow.isMaximized()) {
      const bounds = mainWindow.getBounds();
      store.set('windowBounds', bounds);
    }
  });

  mainWindow.on('move', () => {
    if (mainWindow && !mainWindow.isMaximized()) {
      const bounds = mainWindow.getBounds();
      store.set('windowBounds', bounds);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Send LibreOffice status when DOM is ready
  mainWindow.webContents.on('dom-ready', () => {
    const loPath = store.get('libreOfficePath');
    mainWindow?.webContents.send('libreoffice-status', loPath);
  });

  createMenu();

  // Setup auto-updater after window is created
  setupAutoUpdater();
}

function createMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open PDF',
          accelerator: 'CmdOrCtrl+O',
          click: () => openFile(),
        },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow?.webContents.send('menu-save'),
        },
        {
          label: 'Save As',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => mainWindow?.webContents.send('menu-save-as'),
        },
        { type: 'separator' },
        {
          label: 'Print',
          accelerator: 'CmdOrCtrl+P',
          click: () => mainWindow?.webContents.send('menu-print'),
        },
        { type: 'separator' },
        {
          label: 'Merge PDFs...',
          accelerator: 'CmdOrCtrl+M',
          click: () => mainWindow?.webContents.send('menu-merge-pdfs'),
        },
        {
          label: 'Split PDF...',
          click: () => mainWindow?.webContents.send('menu-split-pdf'),
        },
        {
          label: 'Extract Pages...',
          click: () => mainWindow?.webContents.send('menu-extract-pages'),
        },
        { type: 'separator' },
        {
          label: 'Convert Documents to PDF...',
          click: () => mainWindow?.webContents.send('menu-convert-to-pdf'),
        },
        { type: 'separator' },
        {
          label: 'Export as Image',
          click: () => mainWindow?.webContents.send('menu-export-image'),
        },
        {
          label: 'Extract Images...',
          click: () => mainWindow?.webContents.send('menu-extract-images'),
        },
        { type: 'separator' },
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => mainWindow?.webContents.send('menu-settings'),
        },
        { type: 'separator' },
        {
          label: 'Exit',
          accelerator: 'Alt+F4',
          click: () => app.quit(),
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          click: () => mainWindow?.webContents.send('menu-undo'),
        },
        {
          label: 'Redo',
          accelerator: 'CmdOrCtrl+Y',
          click: () => mainWindow?.webContents.send('menu-redo'),
        },
        { type: 'separator' },
        {
          label: 'Add Text',
          accelerator: 'CmdOrCtrl+T',
          click: () => mainWindow?.webContents.send('menu-add-text'),
        },
        {
          label: 'Add Image',
          accelerator: 'CmdOrCtrl+I',
          click: () => mainWindow?.webContents.send('menu-add-image'),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => mainWindow?.webContents.send('menu-zoom-in'),
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => mainWindow?.webContents.send('menu-zoom-out'),
        },
        {
          label: 'Fit to Width',
          click: () => mainWindow?.webContents.send('menu-fit-width'),
        },
        {
          label: 'Fit to Page',
          click: () => mainWindow?.webContents.send('menu-fit-page'),
        },
        { type: 'separator' },
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+B',
          click: () => mainWindow?.webContents.send('menu-toggle-sidebar'),
        },
        { type: 'separator' },
        {
          label: 'Toggle Developer Tools',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => mainWindow?.webContents.toggleDevTools(),
        },
      ],
    },
    {
      label: 'Page',
      submenu: [
        {
          label: 'Rotate Clockwise',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow?.webContents.send('menu-rotate-cw'),
        },
        {
          label: 'Rotate Counter-Clockwise',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => mainWindow?.webContents.send('menu-rotate-ccw'),
        },
        {
          label: 'Rotate All Pages',
          click: () => mainWindow?.webContents.send('menu-rotate-all'),
        },
        { type: 'separator' },
        {
          label: 'Delete Page',
          click: () => mainWindow?.webContents.send('menu-delete-page'),
        },
        {
          label: 'Insert Page',
          click: () => mainWindow?.webContents.send('menu-insert-page'),
        },
        {
          label: 'Extract Pages',
          click: () => mainWindow?.webContents.send('menu-extract-pages'),
        },
      ],
    },
    {
      label: 'Tools',
      submenu: [
        {
          label: 'Toggle Tools Panel',
          accelerator: 'CmdOrCtrl+T',
          click: () => mainWindow?.webContents.send('menu-toggle-tools-panel'),
        },
        { type: 'separator' },
        {
          label: 'Merge PDFs...',
          click: () => mainWindow?.webContents.send('menu-merge-pdfs'),
        },
        {
          label: 'Split PDF...',
          click: () => mainWindow?.webContents.send('menu-split-pdf'),
        },
        {
          label: 'Extract Images...',
          click: () => mainWindow?.webContents.send('menu-extract-images'),
        },
        { type: 'separator' },
        {
          label: 'Convert Documents to PDF...',
          click: () => mainWindow?.webContents.send('menu-convert-to-pdf'),
        },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Check for Updates',
          click: () => {
            if (app.isPackaged) {
              autoUpdater.checkForUpdates().catch((err) => {
                dialog.showErrorBox('Update Error', 'Failed to check for updates: ' + err.message);
              });
            } else {
              dialog.showMessageBox(mainWindow!, {
                type: 'info',
                title: 'Development Mode',
                message: 'Auto-updates are disabled in development mode.',
              });
            }
          },
        },
        { type: 'separator' },
        {
          label: 'About',
          click: () => {
            dialog.showMessageBox(mainWindow!, {
              type: 'info',
              title: 'About PDF Manager',
              message: 'PDF Manager v' + app.getVersion(),
              detail: 'A powerful desktop PDF manager built with Electron.',
            });
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

async function openFile(): Promise<void> {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile'],
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const filePath = result.filePaths[0];
    const fileData = fs.readFileSync(filePath);
    mainWindow?.webContents.send('file-opened', {
      path: filePath,
      data: fileData.toString('base64'),
    });
  }
}

// IPC Handlers
ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile'],
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const filePath = result.filePaths[0];
    const fileData = fs.readFileSync(filePath);
    return {
      path: filePath,
      data: fileData.toString('base64'),
    };
  }
  return null;
});

ipcMain.handle('save-file', async (_event, { data, filePath }) => {
  try {
    const buffer = Buffer.from(data, 'base64');
    fs.writeFileSync(filePath, buffer);
    return { success: true, path: filePath };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('save-file-dialog', async (_event, { data, defaultPath }) => {
  const result = await dialog.showSaveDialog(mainWindow!, {
    defaultPath: defaultPath || 'document.pdf',
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
  });

  if (!result.canceled && result.filePath) {
    try {
      const buffer = Buffer.from(data, 'base64');
      fs.writeFileSync(result.filePath, buffer);
      return { success: true, path: result.filePath };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }
  return { success: false, canceled: true };
});

ipcMain.handle('open-image-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp'] },
    ],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const filePath = result.filePaths[0];
    const fileData = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase().slice(1);
    return {
      path: filePath,
      data: fileData.toString('base64'),
      type: ext === 'jpg' ? 'jpeg' : ext,
    };
  }
  return null;
});

ipcMain.handle('get-store', (_event, key) => {
  return store.get(key);
});

ipcMain.handle('set-store', (_event, key, value) => {
  store.set(key, value);
});


ipcMain.handle('read-file-by-path', async (_event, filePath: string) => {
  try {
    const fileData = fs.readFileSync(filePath);
    return {
      path: filePath,
      data: fileData.toString('base64'),
    };
  } catch (error) {
    return null;
  }
});

// Auto-updater IPC handlers
ipcMain.handle('check-for-updates', async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    return { success: true, updateInfo: result?.updateInfo };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('download-update', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

ipcMain.handle('get-launch-file', () => {
  if (fileToOpenOnReady) {
    try {
      const filePath = fileToOpenOnReady;
      fileToOpenOnReady = null;
      const fileData = fs.readFileSync(filePath);
      return {
        path: filePath,
        data: fileData.toString('base64'),
      };
    } catch (e) {
      console.error('Failed to read launch file:', e);
      fileToOpenOnReady = null;
      return null;
    }
  }
  return null;
});

ipcMain.handle('get-printers', async () => {
  if (!mainWindow) return [];
  const printers = await mainWindow.webContents.getPrintersAsync();
  return printers.map(p => ({
    name: p.name,
    displayName: p.displayName,
    description: p.description,
    isDefault: p.isDefault,
    status: p.status,
  }));
});

ipcMain.handle('print-pdf', async (_event, { html, printerName, copies, landscape, color, scaleFactor }) => {
  const tempFile = path.join(app.getPath('temp'), `pdf-manager-print-${Date.now()}.html`);
  fs.writeFileSync(tempFile, html, 'utf-8');

  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  await printWindow.loadFile(tempFile);

  // Wait for all images to finish loading
  await printWindow.webContents.executeJavaScript(`
    new Promise(resolve => {
      const imgs = Array.from(document.images);
      if (imgs.length === 0 || imgs.every(i => i.complete)) return resolve();
      let loaded = 0;
      imgs.forEach(img => {
        if (img.complete) { loaded++; return; }
        img.onload = img.onerror = () => { if (++loaded >= imgs.length) resolve(); };
      });
    })
  `);

  return new Promise<{ success: boolean; error?: string }>((resolve) => {
    const printOptions: Electron.WebContentsPrintOptions = {
      silent: true,
      printBackground: true,
      copies: copies || 1,
      landscape: !!landscape,
      color: color !== false,
    };

    if (printerName) {
      printOptions.deviceName = printerName;
    }

    printWindow.webContents.print(printOptions, (success, failureReason) => {
      printWindow.close();
      try { fs.unlinkSync(tempFile); } catch (_e) { /* ignore */ }
      resolve({ success, error: failureReason || undefined });
    });
  });
});

// Multi-file operations
ipcMain.handle('open-multiple-files-dialog', async () => {
  const lastDir = store.get('lastOpenDirectory') || undefined;
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile', 'multiSelections'],
    defaultPath: lastDir,
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    store.set('lastOpenDirectory', path.dirname(result.filePaths[0]));
    const files = await Promise.all(
      result.filePaths.map(async (filePath) => {
        const fileData = fs.readFileSync(filePath);
        return {
          path: filePath,
          data: fileData.toString('base64'),
        };
      })
    );
    return files;
  }
  return null;
});

ipcMain.handle('select-output-directory', async () => {
  const lastDir = store.get('lastSaveDirectory') || undefined;
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: lastDir,
    title: 'Select Output Folder',
  });

  if (!result.canceled && result.filePaths.length > 0) {
    store.set('lastSaveDirectory', result.filePaths[0]);
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('save-file-to-path', async (_event, { data, filePath }) => {
  try {
    const buffer = Buffer.from(data, 'base64');
    // Ensure directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, buffer);
    return { success: true, path: filePath };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('save-image-to-path', async (_event, { data, filePath }) => {
  try {
    const buffer = Buffer.from(data, 'base64');
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, buffer);
    return { success: true, path: filePath };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('open-folder', async (_event, folderPath: string) => {
  try {
    await shell.openPath(folderPath);
    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('open-external', async (_event, url: string) => {
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

// Recent files management
ipcMain.handle('get-recent-files', () => {
  return store.get('recentFiles');
});

ipcMain.handle('add-recent-file', (_event, filePath: string) => {
  const recentFiles = store.get('recentFiles');
  // Remove if already exists
  const filtered = recentFiles.filter((f) => f !== filePath);
  // Add to front and limit to 10
  const updated = [filePath, ...filtered].slice(0, 10);
  store.set('recentFiles', updated);
  return updated;
});

ipcMain.handle('clear-recent-files', () => {
  store.set('recentFiles', []);
  return [];
});

// LibreOffice detection and conversion
function detectLibreOffice(): string | null {
  const possiblePaths: string[] = [];

  // Always check hardcoded common Windows paths first (most reliable)
  // Use forward slashes - they work on Windows in Node.js
  const hardcodedWindowsPaths = [
    'C:/Program Files/LibreOffice/program/soffice.exe',
    'C:/Program Files (x86)/LibreOffice/program/soffice.exe',
    'C:/Program Files/LibreOffice 7/program/soffice.exe',
    'C:/Program Files/LibreOffice 24/program/soffice.exe',
    'C:/Program Files/LibreOffice 25/program/soffice.exe',
  ];

  for (const p of hardcodedWindowsPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  if (process.platform === 'win32') {
    // Check common installation paths
    const programDirs = [
      process.env['ProgramFiles'] || 'C:\\Program Files',
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      process.env['LOCALAPPDATA'],
      process.env['APPDATA'],
    ].filter(Boolean) as string[];

    // LibreOffice folder names to check
    const libreOfficeFolders = ['LibreOffice', 'LibreOffice 7', 'LibreOffice 24', 'LibreOffice 25'];

    for (const base of programDirs) {
      for (const folder of libreOfficeFolders) {
        // Direct program path: LibreOffice/program/soffice.exe
        const directPath = path.join(base, folder, 'program', 'soffice.exe');
        if (fs.existsSync(directPath)) {
          possiblePaths.push(directPath);
        }

        // Also check for version subfolders: LibreOffice/<version>/program/soffice.exe
        const libreOfficePath = path.join(base, folder);
        if (fs.existsSync(libreOfficePath)) {
          try {
            const items = fs.readdirSync(libreOfficePath);
            for (const item of items) {
              if (item !== 'program') {
                const versionPath = path.join(libreOfficePath, item, 'program', 'soffice.exe');
                if (fs.existsSync(versionPath)) {
                  possiblePaths.push(versionPath);
                }
              }
            }
          } catch (e) {
            // Ignore errors reading directory
          }
        }
      }
    }

    // Also try to find via registry (using PowerShell)
    if (possiblePaths.length === 0) {
      try {
        const { execSync } = require('child_process');
        const result = execSync(
          'powershell -Command "Get-ItemProperty HKLM:\\\\SOFTWARE\\\\LibreOffice\\\\* -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path"',
          { encoding: 'utf8', timeout: 5000 }
        ).trim();
        if (result) {
          const regPath = path.join(result, 'program', 'soffice.exe');
          if (fs.existsSync(regPath)) {
            possiblePaths.push(regPath);
          }
        }
      } catch (e) {
        // Registry lookup failed, continue with other methods
      }
    }
  } else if (process.platform === 'darwin') {
    const macPaths = [
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      path.join(process.env['HOME'] || '', 'Applications/LibreOffice.app/Contents/MacOS/soffice'),
    ];
    for (const p of macPaths) {
      if (fs.existsSync(p)) {
        possiblePaths.push(p);
      }
    }
  } else {
    const linuxPaths = [
      '/usr/bin/libreoffice',
      '/usr/bin/soffice',
      '/usr/local/bin/libreoffice',
      '/usr/local/bin/soffice',
      '/opt/libreoffice/program/soffice',
      '/opt/libreoffice7.0/program/soffice',
      '/snap/bin/libreoffice',
    ];
    for (const p of linuxPaths) {
      if (fs.existsSync(p)) {
        possiblePaths.push(p);
      }
    }
  }

  return possiblePaths.length > 0 ? possiblePaths[0] : null;
}

ipcMain.handle('detect-libreoffice', () => {
  // Simply return the stored path - detection already ran at startup
  const storedPath = store.get('libreOfficePath');

  // If we have a stored path, return it
  if (storedPath && typeof storedPath === 'string' && storedPath.length > 0) {
    return storedPath;
  }

  // Otherwise run detection now
  const detected = detectLibreOffice();
  if (detected) {
    store.set('libreOfficePath', detected);
  }
  return detected;
});

ipcMain.handle('convert-to-pdf', async (_event, { inputPath, outputDir }) => {
  const loPath = store.get('libreOfficePath') || detectLibreOffice();
  if (!loPath) {
    return { success: false, error: 'LibreOffice not found' };
  }

  return new Promise((resolve) => {
    const args = [
      '--headless',
      '--invisible',
      '--nodefault',
      '--nolockcheck',
      '--nologo',
      '--norestore',
      '--convert-to', 'pdf',
      '--outdir', outputDir,
      inputPath,
    ];

    execFile(loPath, args, { timeout: 120000 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: error.message });
      } else {
        const baseName = path.basename(inputPath, path.extname(inputPath));
        const outputPath = path.join(outputDir, `${baseName}.pdf`);
        if (fs.existsSync(outputPath)) {
          const fileData = fs.readFileSync(outputPath);
          resolve({ success: true, path: outputPath, data: fileData.toString('base64') });
        } else {
          resolve({ success: false, error: 'Output file not created' });
        }
      }
    });
  });
});

// Document conversion file dialog
ipcMain.handle('open-documents-dialog', async () => {
  const lastDir = store.get('lastOpenDirectory') || undefined;
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile', 'multiSelections'],
    defaultPath: lastDir,
    filters: [
      { name: 'Documents', extensions: ['doc', 'docx', 'odt', 'rtf', 'txt', 'ppt', 'pptx', 'odp', 'xls', 'xlsx', 'ods', 'html', 'htm'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    store.set('lastOpenDirectory', path.dirname(result.filePaths[0]));
    return result.filePaths;
  }
  return null;
});

// Handle second instance (user double-clicks a PDF while app is already running)
app.on('second-instance', (_event, commandLine) => {
  const filePath = getFileFromArgs(commandLine);
  if (filePath && mainWindow) {
    const fileData = fs.readFileSync(filePath);
    mainWindow.webContents.send('file-opened', {
      path: filePath,
      data: fileData.toString('base64'),
    });
  }
  // Focus the existing window
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// macOS: handle open-file event (file association / drag to dock)
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (mainWindow) {
    const fileData = fs.readFileSync(filePath);
    mainWindow.webContents.send('file-opened', {
      path: filePath,
      data: fileData.toString('base64'),
    });
  } else {
    // App not ready yet, store for later
    fileToOpenOnReady = filePath;
  }
});

// Check for file argument passed on launch
const launchFile = getFileFromArgs(process.argv);
if (launchFile) {
  fileToOpenOnReady = launchFile;
}

// Auto-recovery handlers
const getRecoveryDir = () => {
  const dir = path.join(app.getPath('userData'), 'recovery');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
};

ipcMain.handle('save-auto-recovery', async (_event, { data, filePath: originalPath, fileName }) => {
  try {
    const recoveryDir = getRecoveryDir();
    const recoveryFile = path.join(recoveryDir, 'recovery.pdf');
    const metaFile = path.join(recoveryDir, 'recovery.json');

    const buffer = Buffer.from(data, 'base64');
    fs.writeFileSync(recoveryFile, buffer);
    fs.writeFileSync(metaFile, JSON.stringify({
      originalPath: originalPath || null,
      fileName: fileName || 'Untitled.pdf',
      timestamp: Date.now(),
    }));

    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('check-auto-recovery', () => {
  try {
    const recoveryDir = getRecoveryDir();
    const metaFile = path.join(recoveryDir, 'recovery.json');
    if (fs.existsSync(metaFile)) {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
      // Only offer recovery for files less than 24 hours old
      if (Date.now() - meta.timestamp < 24 * 60 * 60 * 1000) {
        return meta;
      }
      // Cleanup stale recovery files
      fs.unlinkSync(metaFile);
      const recoveryFile = path.join(recoveryDir, 'recovery.pdf');
      if (fs.existsSync(recoveryFile)) fs.unlinkSync(recoveryFile);
    }
  } catch (e) {
    // Recovery check failed, not critical
  }
  return null;
});

ipcMain.handle('load-auto-recovery', () => {
  try {
    const recoveryDir = getRecoveryDir();
    const recoveryFile = path.join(recoveryDir, 'recovery.pdf');
    const metaFile = path.join(recoveryDir, 'recovery.json');
    if (fs.existsSync(recoveryFile) && fs.existsSync(metaFile)) {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
      const fileData = fs.readFileSync(recoveryFile);
      return {
        data: fileData.toString('base64'),
        filePath: meta.originalPath,
        fileName: meta.fileName,
      };
    }
  } catch (e) {
    console.error('Failed to load recovery file:', e);
  }
  return null;
});

ipcMain.handle('clear-auto-recovery', () => {
  try {
    const recoveryDir = getRecoveryDir();
    const recoveryFile = path.join(recoveryDir, 'recovery.pdf');
    const metaFile = path.join(recoveryDir, 'recovery.json');
    if (fs.existsSync(recoveryFile)) fs.unlinkSync(recoveryFile);
    if (fs.existsSync(metaFile)) fs.unlinkSync(metaFile);
  } catch (e) {
    // Cleanup failure is not critical
  }
  return { success: true };
});

app.whenReady().then(() => {
  // Run LibreOffice detection at startup
  const detectedPath = detectLibreOffice();
  if (detectedPath) {
    store.set('libreOfficePath', detectedPath);
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

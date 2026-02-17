import React, { useState, useCallback, useEffect } from 'react';
import Modal from './Modal';
import {
  Loader2, FolderOpen, CheckCircle, FileText, Layout, Type,
  Folder, SkipForward, Copy, Edit3,
} from 'lucide-react';
import type { ConversionMode } from '../utils/docxGenerator/types';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type DialogMode = 'single' | 'batch';
type DuplicateAction = 'skip' | 'overwrite' | 'rename';

interface FolderSource {
  path: string;
  name: string;
  pdfFiles: string[];
  pdfCount: number;
}

interface ConvertToDocxDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConvert: (outputPath: string, mode: ConversionMode) => Promise<{ count: number; folder: string }>;
  fileName?: string;
  pageCount?: number;
  filePath?: string;
  initialMode?: 'single' | 'batch';
}

interface BatchResult {
  converted: number;
  skipped: number;
  failed: number;
  total: number;
  folder: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const extractName = (p: string) =>
  p.substring(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);

const extractDir = (p: string) => {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx > 0 ? p.substring(0, idx) : '';
};

const truncatePath = (p: string, maxLen = 50) => {
  if (p.length <= maxLen) return p;
  return '...' + p.substring(p.length - maxLen + 3);
};

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const modeCard = (active: boolean): React.CSSProperties => ({
  flex: 1,
  padding: '14px 16px',
  borderRadius: '10px',
  border: active
    ? '2px solid var(--accent-color, #4A90D9)'
    : '2px solid var(--border-color, #3a3a3a)',
  background: active
    ? 'var(--accent-bg, rgba(74, 144, 217, 0.1))'
    : 'var(--input-bg, #2a2a2a)',
  color: 'var(--text-primary, #e0e0e0)',
  cursor: 'pointer',
  textAlign: 'center' as const,
  transition: 'all 0.15s ease',
});

const convModeBtn = (active: boolean): React.CSSProperties => ({
  flex: 1,
  padding: '10px 12px',
  borderRadius: '8px',
  border: active
    ? '2px solid var(--accent-color, #4A90D9)'
    : '2px solid var(--border-color, #3a3a3a)',
  background: active
    ? 'var(--accent-bg, rgba(74, 144, 217, 0.1))'
    : 'var(--input-bg, #2a2a2a)',
  color: 'var(--text-primary, #e0e0e0)',
  cursor: 'pointer',
  textAlign: 'left' as const,
  transition: 'all 0.15s ease',
});

const dupBtn = (active: boolean): React.CSSProperties => ({
  flex: 1,
  padding: '7px 10px',
  borderRadius: '6px',
  border: active
    ? '1px solid var(--accent-color, #4A90D9)'
    : '1px solid var(--border-color, #3a3a3a)',
  background: active
    ? 'var(--accent-bg, rgba(74, 144, 217, 0.1))'
    : 'transparent',
  color: active ? 'var(--accent-color, #4A90D9)' : 'var(--text-secondary, #999)',
  cursor: 'pointer',
  fontSize: '12px',
  fontWeight: 500,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '5px',
  transition: 'all 0.15s ease',
});

const smallBtn = (disabled?: boolean): React.CSSProperties => ({
  padding: '5px 10px',
  borderRadius: '4px',
  border: '1px solid var(--border-color, #3a3a3a)',
  background: 'transparent',
  color: 'var(--text-secondary, #999)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  fontSize: '11px',
  opacity: disabled ? 0.5 : 1,
  transition: 'all 0.15s ease',
});

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const ConvertToDocxDialog: React.FC<ConvertToDocxDialogProps> = ({
  isOpen,
  onClose,
  onConvert,
  fileName = '',
  pageCount = 0,
  filePath = '',
  initialMode = 'single',
}) => {
  const hasCurrentFile = !!filePath && !!fileName;
  const [mode, setMode] = useState<DialogMode>(initialMode);
  const [folderSource, setFolderSource] = useState<FolderSource | null>(null);
  const [singleFilePath, setSingleFilePath] = useState<string>(filePath);
  const [singleFileName, setSingleFileName] = useState<string>(fileName);
  const [singleIsCurrentFile, setSingleIsCurrentFile] = useState(hasCurrentFile);
  const [conversionMode, setConversionMode] = useState<ConversionMode>('flow');
  const [duplicateAction, setDuplicateAction] = useState<DuplicateAction>('rename');
  const [outputLocation, setOutputLocation] = useState<'same' | 'custom'>('same');
  const [customOutputDir, setCustomOutputDir] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [batchProgress, setBatchProgress] = useState<{
    current: number; total: number; currentFile: string;
  } | null>(null);

  /* Reset when dialog opens */
  useEffect(() => {
    if (isOpen) {
      setMode(initialMode);
      setFolderSource(null);
      setSingleFilePath(filePath);
      setSingleFileName(fileName);
      setSingleIsCurrentFile(hasCurrentFile);
      setError(null);
      setResult(null);
      setBatchProgress(null);
      setOutputLocation('same');
      setCustomOutputDir('');

      // If opening directly in batch mode, immediately show folder picker
      if (initialMode === 'batch') {
        (async () => {
          const dirPath = await window.electronAPI.selectOutputDirectory();
          if (!dirPath) return;
          const pdfFiles = await window.electronAPI.scanDirectoryForPdfs(dirPath);
          setFolderSource({
            path: dirPath,
            name: extractName(dirPath),
            pdfFiles,
            pdfCount: pdfFiles.length,
          });
        })();
      }
    }
  }, [isOpen, filePath, fileName, initialMode, hasCurrentFile]);

  /* ---- Switch to batch mode and immediately open folder picker ---- */

  const handleSelectBatchMode = useCallback(async () => {
    setMode('batch');
    setError(null);
    // Immediately open the folder picker
    const dirPath = await window.electronAPI.selectOutputDirectory();
    if (!dirPath) {
      // User cancelled folder picker - stay in batch mode but no folder selected
      return;
    }
    const pdfFiles = await window.electronAPI.scanDirectoryForPdfs(dirPath);
    setFolderSource({
      path: dirPath,
      name: extractName(dirPath),
      pdfFiles,
      pdfCount: pdfFiles.length,
    });
  }, []);

  /* ---- Re-pick a folder ---- */

  const handleChangeBatchFolder = useCallback(async () => {
    const dirPath = await window.electronAPI.selectOutputDirectory();
    if (!dirPath) return;
    const pdfFiles = await window.electronAPI.scanDirectoryForPdfs(dirPath);
    setFolderSource({
      path: dirPath,
      name: extractName(dirPath),
      pdfFiles,
      pdfCount: pdfFiles.length,
    });
    setError(null);
  }, []);

  /* ---- Browse for a different single file ---- */

  const handleBrowseSingleFile = useCallback(async () => {
    const picked = await window.electronAPI.pickPdfFile();
    if (!picked) return;
    setSingleFilePath(picked);
    setSingleFileName(extractName(picked));
    setSingleIsCurrentFile(false);
    setError(null);
  }, []);

  /* ---- Output dir picker (batch custom) ---- */

  const handleChooseOutputDir = useCallback(async () => {
    const dir = await window.electronAPI.selectOutputDirectory();
    if (dir) {
      setCustomOutputDir(dir);
      setOutputLocation('custom');
    }
  }, []);

  /* ---- Duplicate rename helper ---- */

  const findAvailablePath = useCallback(async (basePath: string): Promise<string> => {
    if (!(await window.electronAPI.checkFileExists(basePath))) return basePath;
    const dotIdx = basePath.lastIndexOf('.');
    const stem = dotIdx > 0 ? basePath.substring(0, dotIdx) : basePath;
    const ext = dotIdx > 0 ? basePath.substring(dotIdx) : '';
    for (let n = 1; n < 1000; n++) {
      const candidate = `${stem} (${n})${ext}`;
      if (!(await window.electronAPI.checkFileExists(candidate))) return candidate;
    }
    return `${stem} (${Date.now()})${ext}`;
  }, []);

  /* ---- Single-file conversion ---- */

  const handleConvertSingle = useCallback(async () => {
    const sourceDir = extractDir(singleFilePath) || undefined;
    const defaultName = singleFileName.replace(/\.pdf$/i, '.docx');

    const savePath = await window.electronAPI.showSaveDocxDialog(defaultName, sourceDir);
    if (!savePath) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      let folder: string;

      if (singleIsCurrentFile) {
        const r = await onConvert(savePath, conversionMode);
        folder = r.folder;
      } else {
        const { generateDocx } = await import('../utils/docxGenerator/DocxGenerator');
        const rawData = await window.electronAPI.readFileRaw(singleFilePath);
        if (!rawData) throw new Error('Failed to read PDF file');
        const pdfData = new Uint8Array(rawData);
        const docxResult = await generateDocx(pdfData, { conversionMode });
        await window.electronAPI.saveRawBytesToPath(
          docxResult.data.buffer.slice(
            docxResult.data.byteOffset,
            docxResult.data.byteOffset + docxResult.data.byteLength,
          ),
          savePath,
        );
        folder = extractDir(savePath);
      }

      setResult({ converted: 1, skipped: 0, failed: 0, total: 1, folder });
    } catch (e) {
      setError((e as Error).message || 'Failed to convert PDF to Word');
    } finally {
      setLoading(false);
    }
  }, [singleFilePath, singleFileName, singleIsCurrentFile, onConvert, conversionMode]);

  /* ---- Batch conversion ---- */

  const handleConvertBatch = useCallback(async () => {
    if (!folderSource || folderSource.pdfCount === 0) return;
    const { pdfFiles, path: sourceDir } = folderSource;

    let outputDir = sourceDir;
    if (outputLocation === 'custom') {
      if (!customOutputDir) {
        const dir = await window.electronAPI.selectOutputDirectory();
        if (!dir) return;
        setCustomOutputDir(dir);
        outputDir = dir;
      } else {
        outputDir = customOutputDir;
      }
    }

    setLoading(true);
    setError(null);
    setResult(null);
    setBatchProgress({ current: 0, total: pdfFiles.length, currentFile: 'Starting...' });

    try {
      const { generateDocx } = await import('../utils/docxGenerator/DocxGenerator');
      let converted = 0;
      let skipped = 0;
      let failed = 0;

      for (let i = 0; i < pdfFiles.length; i++) {
        const pdfPath = pdfFiles[i];
        const pdfName = extractName(pdfPath);
        setBatchProgress({ current: i + 1, total: pdfFiles.length, currentFile: pdfName });

        try {
          let outPath: string;
          if (outputLocation === 'same') {
            outPath = extractDir(pdfPath) + '/' + pdfName.replace(/\.pdf$/i, '.docx');
          } else {
            const relativePath = pdfPath.substring(sourceDir.length).replace(/\\/g, '/');
            const relativeDir = relativePath.substring(0, relativePath.lastIndexOf('/'));
            outPath = outputDir + relativeDir + '/' + pdfName.replace(/\.pdf$/i, '.docx');
          }

          if (duplicateAction === 'skip') {
            if (await window.electronAPI.checkFileExists(outPath)) {
              skipped++;
              continue;
            }
          } else if (duplicateAction === 'rename') {
            outPath = await findAvailablePath(outPath);
          }

          const rawData = await window.electronAPI.readFileRaw(pdfPath);
          if (!rawData) { failed++; continue; }

          const pdfData = new Uint8Array(rawData);
          const docxResult = await generateDocx(pdfData, { conversionMode });

          await window.electronAPI.saveRawBytesToPath(
            docxResult.data.buffer.slice(
              docxResult.data.byteOffset,
              docxResult.data.byteOffset + docxResult.data.byteLength,
            ),
            outPath,
          );
          converted++;
        } catch (e) {
          console.warn(`[Batch] Failed to convert ${pdfName}:`, e);
          failed++;
        }
      }

      setBatchProgress(null);
      setResult({
        converted, skipped, failed,
        total: pdfFiles.length,
        folder: outputLocation === 'same' ? sourceDir : outputDir,
      });
      if (failed > 0) {
        setError(`${failed} file${failed !== 1 ? 's' : ''} failed to convert`);
      }
    } catch (e) {
      setError((e as Error).message || 'Batch conversion failed');
      setBatchProgress(null);
    } finally {
      setLoading(false);
    }
  }, [folderSource, conversionMode, duplicateAction, outputLocation, customOutputDir, findAvailablePath]);

  /* ---- Misc handlers ---- */

  const handleOpenFolder = useCallback(async () => {
    if (result?.folder) await window.electronAPI.openFolder(result.folder);
  }, [result]);

  const handleClose = useCallback(() => {
    if (loading) return;
    onClose();
  }, [onClose, loading]);

  const handleConvert = useCallback(() => {
    if (mode === 'batch') handleConvertBatch();
    else handleConvertSingle();
  }, [mode, handleConvertBatch, handleConvertSingle]);

  const batchReady = folderSource && folderSource.pdfCount > 0;
  const singleReady = !!singleFileName;
  const convertDisabled = loading
    || (mode === 'single' && !singleReady)
    || (mode === 'batch' && !batchReady)
    || (mode === 'batch' && outputLocation === 'custom' && !customOutputDir);

  /* ================================================================ */
  /*  Render                                                           */
  /* ================================================================ */

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Convert PDF to Word" width="540px">
      <div className="convert-from-dialog">

        {/* ---- RESULT VIEW ---- */}
        {result ? (
          <div className="result-view">
            <CheckCircle size={48} className="success-icon" />
            <h3>Conversion Complete</h3>

            {mode === 'batch' ? (
              <div>
                <p>
                  Converted <strong>{result.converted}</strong> of{' '}
                  <strong>{result.total}</strong> file{result.total !== 1 ? 's' : ''} to
                  Word documents
                </p>
                {result.skipped > 0 && (
                  <p style={{ fontSize: '13px', opacity: 0.7, marginTop: '4px' }}>
                    {result.skipped} file{result.skipped !== 1 ? 's' : ''} skipped
                    (already existed)
                  </p>
                )}
              </div>
            ) : (
              <p>
                Converted <strong>{singleFileName}</strong> to Word document
              </p>
            )}

            {error && (
              <p style={{ color: 'var(--error-color, #ff6b6b)', fontSize: '13px', marginTop: '4px' }}>
                {error}
              </p>
            )}

            <div className="dialog-actions">
              <button className="btn btn-secondary" onClick={handleOpenFolder}>
                <FolderOpen size={16} /> Open Folder
              </button>
              <button className="btn btn-primary" onClick={handleClose}>
                Done
              </button>
            </div>
          </div>
        ) : (

        /* ---- FORM VIEW ---- */
        <>
          {/* ======== MODE SELECTION ======== */}
          <div style={{ display: 'flex', gap: '10px', marginBottom: '16px' }}>
            {/* Single File card */}
            <button type="button" onClick={() => { setMode('single'); setError(null); }} style={modeCard(mode === 'single')}>
              <FileText size={28} style={{
                margin: '0 auto 8px',
                display: 'block',
                opacity: mode === 'single' ? 1 : 0.5,
                color: mode === 'single' ? 'var(--accent-color, #4A90D9)' : 'var(--text-secondary, #999)',
              }} />
              <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '4px' }}>
                Single File
              </div>
              <div style={{ fontSize: '11px', opacity: 0.6, lineHeight: 1.3 }}>
                Convert one PDF to Word
              </div>
            </button>

            {/* Batch Folder card */}
            <button type="button" onClick={handleSelectBatchMode} style={modeCard(mode === 'batch')}>
              <Folder size={28} style={{
                margin: '0 auto 8px',
                display: 'block',
                opacity: mode === 'batch' ? 1 : 0.5,
                color: mode === 'batch' ? 'var(--accent-color, #4A90D9)' : 'var(--text-secondary, #999)',
              }} />
              <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '4px' }}>
                Batch Folder
              </div>
              <div style={{ fontSize: '11px', opacity: 0.6, lineHeight: 1.3 }}>
                Convert all PDFs in a directory
              </div>
            </button>
          </div>

          {/* ======== SOURCE INFO ======== */}
          {mode === 'single' ? (
            /* -- Single file source -- */
            <div style={{
              padding: '10px 12px',
              borderRadius: '6px',
              background: 'var(--input-bg, #2a2a2a)',
              marginBottom: '14px',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
            }}>
              {singleFileName ? (
                <>
                  <FileText size={18} style={{ color: 'var(--accent-color, #4A90D9)', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontWeight: 600, fontSize: '13px',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {singleFileName}
                    </div>
                    <div style={{ fontSize: '11px', opacity: 0.5, marginTop: '1px' }}>
                      {singleIsCurrentFile
                        ? `Currently open \u00B7 ${pageCount} page${pageCount !== 1 ? 's' : ''}`
                        : truncatePath(singleFilePath)}
                    </div>
                  </div>
                  <button type="button" onClick={handleBrowseSingleFile} disabled={loading} style={smallBtn(loading)}>
                    Change...
                  </button>
                </>
              ) : (
                <div style={{ flex: 1, textAlign: 'center', padding: '4px 0' }}>
                  <button type="button" onClick={handleBrowseSingleFile} disabled={loading} style={{
                    padding: '8px 20px',
                    borderRadius: '6px',
                    border: '1px dashed var(--border-color, #3a3a3a)',
                    background: 'transparent',
                    color: 'var(--accent-color, #4A90D9)',
                    cursor: 'pointer',
                    fontSize: '13px',
                    fontWeight: 500,
                  }}>
                    <FileText size={14} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
                    Choose PDF File...
                  </button>
                </div>
              )}
            </div>
          ) : (
            /* -- Batch folder source -- */
            <div style={{
              padding: '10px 12px',
              borderRadius: '6px',
              background: 'var(--input-bg, #2a2a2a)',
              marginBottom: '14px',
            }}>
              {folderSource ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <Folder size={18} style={{ color: 'var(--accent-color, #4A90D9)', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontWeight: 600, fontSize: '13px',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {folderSource.name}
                    </div>
                    <div style={{ fontSize: '11px', opacity: 0.5, marginTop: '1px' }}>
                      {folderSource.pdfCount === 0
                        ? 'No PDF files found in this directory'
                        : `${folderSource.pdfCount} PDF file${folderSource.pdfCount !== 1 ? 's' : ''} found (including subfolders)`}
                    </div>
                  </div>
                  <button type="button" onClick={handleChangeBatchFolder} disabled={loading} style={smallBtn(loading)}>
                    Change...
                  </button>
                </div>
              ) : (
                <div style={{ textAlign: 'center', padding: '8px 0' }}>
                  <button
                    type="button"
                    onClick={handleChangeBatchFolder}
                    disabled={loading}
                    style={{
                      padding: '8px 20px',
                      borderRadius: '6px',
                      border: '1px dashed var(--border-color, #3a3a3a)',
                      background: 'transparent',
                      color: 'var(--accent-color, #4A90D9)',
                      cursor: 'pointer',
                      fontSize: '13px',
                      fontWeight: 500,
                    }}
                  >
                    <FolderOpen size={14} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
                    Choose Source Folder...
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ======== CONVERSION MODE ======== */}
          <div className="form-group" style={{ marginBottom: '14px' }}>
            <label style={{ marginBottom: '8px', display: 'block' }}>Conversion Mode</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="button" onClick={() => setConversionMode('flow')} style={convModeBtn(conversionMode === 'flow')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                  <Type size={16} style={{ opacity: 0.8 }} />
                  <strong style={{ fontSize: '13px' }}>Retain Flowing Text</strong>
                </div>
                <div style={{ fontSize: '11px', opacity: 0.6, lineHeight: 1.3 }}>
                  Editable paragraphs and tables. Text reflows when edited.
                </div>
              </button>
              <button type="button" onClick={() => setConversionMode('positioned')} style={convModeBtn(conversionMode === 'positioned')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                  <Layout size={16} style={{ opacity: 0.8 }} />
                  <strong style={{ fontSize: '13px' }}>Retain Page Layout</strong>
                </div>
                <div style={{ fontSize: '11px', opacity: 0.6, lineHeight: 1.3 }}>
                  1:1 visual match. Text positioned exactly as in PDF.
                </div>
              </button>
            </div>
          </div>

          {/* ======== BATCH-ONLY OPTIONS ======== */}
          {mode === 'batch' && (
            <>
              {/* -- Duplicate handling -- */}
              <div style={{ marginBottom: '14px' }}>
                <label style={{ marginBottom: '8px', display: 'block', fontSize: '13px' }}>
                  If File Already Exists
                </label>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button type="button" onClick={() => setDuplicateAction('skip')} style={dupBtn(duplicateAction === 'skip')}>
                    <SkipForward size={13} /> Skip
                  </button>
                  <button type="button" onClick={() => setDuplicateAction('overwrite')} style={dupBtn(duplicateAction === 'overwrite')}>
                    <Copy size={13} /> Overwrite
                  </button>
                  <button type="button" onClick={() => setDuplicateAction('rename')} style={dupBtn(duplicateAction === 'rename')}>
                    <Edit3 size={13} /> Rename
                  </button>
                </div>
                <div style={{ fontSize: '11px', opacity: 0.5, marginTop: '4px' }}>
                  {duplicateAction === 'skip' && 'Existing .docx files will not be re-converted.'}
                  {duplicateAction === 'overwrite' && 'Existing .docx files will be replaced.'}
                  {duplicateAction === 'rename' && 'New files will be saved as filename (1).docx, (2).docx, etc.'}
                </div>
              </div>

              {/* -- Output location -- */}
              <div style={{ marginBottom: '14px' }}>
                <label style={{ marginBottom: '8px', display: 'block', fontSize: '13px' }}>
                  Output Location
                </label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <label style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    cursor: 'pointer', fontSize: '12px',
                  }}>
                    <input
                      type="radio" name="outputLoc"
                      checked={outputLocation === 'same'}
                      onChange={() => setOutputLocation('same')}
                      style={{ accentColor: 'var(--accent-color, #4A90D9)' }}
                    />
                    Same folder as source PDFs
                  </label>
                  <label style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    cursor: 'pointer', fontSize: '12px',
                  }}>
                    <input
                      type="radio" name="outputLoc"
                      checked={outputLocation === 'custom'}
                      onChange={() => {
                        setOutputLocation('custom');
                        if (!customOutputDir) handleChooseOutputDir();
                      }}
                      style={{ accentColor: 'var(--accent-color, #4A90D9)' }}
                    />
                    Custom output folder
                  </label>
                  {outputLocation === 'custom' && (
                    <div style={{ display: 'flex', gap: '6px', marginLeft: '24px' }}>
                      <div style={{
                        flex: 1, padding: '5px 8px', borderRadius: '4px',
                        border: '1px solid var(--border-color, #3a3a3a)',
                        background: 'var(--input-bg, #2a2a2a)',
                        fontSize: '11px', opacity: 0.7,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {customOutputDir ? truncatePath(customOutputDir) : 'No folder selected'}
                      </div>
                      <button type="button" onClick={handleChooseOutputDir} style={smallBtn(loading)} disabled={loading}>
                        Browse...
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {/* ======== PROGRESS BAR ======== */}
          {batchProgress && (
            <div style={{
              padding: '10px 12px', borderRadius: '6px',
              background: 'var(--input-bg, #2a2a2a)', marginBottom: '12px',
            }}>
              <div style={{ fontSize: '12px', marginBottom: '6px', opacity: 0.8 }}>
                Converting {batchProgress.current} of {batchProgress.total}
              </div>
              <div style={{
                fontSize: '11px', opacity: 0.6,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {batchProgress.currentFile}
              </div>
              {batchProgress.total > 0 && (
                <div style={{
                  marginTop: '6px', height: '4px', borderRadius: '2px',
                  background: 'var(--border-color, #3a3a3a)', overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%',
                    width: `${(batchProgress.current / batchProgress.total) * 100}%`,
                    background: 'var(--accent-color, #4A90D9)',
                    borderRadius: '2px',
                    transition: 'width 0.3s ease',
                  }} />
                </div>
              )}
            </div>
          )}

          {/* ======== ERROR ======== */}
          {error && <p className="dialog-error">{error}</p>}

          {/* ======== ACTIONS ======== */}
          <div className="dialog-actions">
            <button className="btn btn-ghost" onClick={handleClose} disabled={loading}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={handleConvert}
              disabled={convertDisabled}
            >
              {loading ? (
                <>
                  <Loader2 size={16} className="spinning" />
                  Converting...
                </>
              ) : (
                <>
                  <FileText size={16} />
                  {mode === 'batch' && folderSource
                    ? `Convert ${folderSource.pdfCount} File${folderSource.pdfCount !== 1 ? 's' : ''}`
                    : 'Convert to Word'}
                </>
              )}
            </button>
          </div>
        </>
        )}
      </div>
    </Modal>
  );
};

export default ConvertToDocxDialog;

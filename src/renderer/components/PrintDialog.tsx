import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ChevronLeft, ChevronRight, Minus, Plus, Printer, Loader2 } from 'lucide-react';
import Modal from './Modal';

interface PrinterInfo {
  name: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  status: number;
}

interface PrintDialogProps {
  isOpen: boolean;
  onClose: () => void;
  pdfData: Uint8Array;
  pageCount: number;
  currentPage: number;
  fileName: string;
}

const PrintDialog: React.FC<PrintDialogProps> = ({
  isOpen,
  onClose,
  pdfData,
  pageCount,
  currentPage,
  fileName,
}) => {
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [selectedPrinter, setSelectedPrinter] = useState('');
  const [pageRangeType, setPageRangeType] = useState<'all' | 'current' | 'custom'>('all');
  const [customRange, setCustomRange] = useState('');
  const [copies, setCopies] = useState(1);
  const [scaleMode, setScaleMode] = useState<'fit' | 'actual' | 'custom'>('fit');
  const [customScale, setCustomScale] = useState(100);
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const [colorMode, setColorMode] = useState(true);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [printing, setPrinting] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  // Parse page range
  const pagesToPrint = useMemo((): number[] => {
    if (pageRangeType === 'all') {
      return Array.from({ length: pageCount }, (_, i) => i + 1);
    }
    if (pageRangeType === 'current') {
      return [currentPage];
    }
    const pages: number[] = [];
    const parts = customRange.split(',');
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      if (trimmed.includes('-')) {
        const [start, end] = trimmed.split('-').map(s => parseInt(s.trim()));
        if (!isNaN(start) && !isNaN(end)) {
          for (let i = Math.max(1, start); i <= Math.min(pageCount, end); i++) {
            pages.push(i);
          }
        }
      } else {
        const num = parseInt(trimmed);
        if (!isNaN(num) && num >= 1 && num <= pageCount) {
          pages.push(num);
        }
      }
    }
    return [...new Set(pages)].sort((a, b) => a - b);
  }, [pageRangeType, customRange, currentPage, pageCount]);

  // Reset preview index when page selection changes
  useEffect(() => {
    setPreviewIndex(0);
  }, [pageRangeType, customRange]);

  // Load printers and reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      window.electronAPI.getPrinters().then((list: PrinterInfo[]) => {
        setPrinters(list);
        const def = list.find(p => p.isDefault);
        if (def) setSelectedPrinter(def.name);
      });
      setPreviewIndex(0);
      setPageRangeType('all');
      setCustomRange('');
      setCopies(1);
      setScaleMode('fit');
      setCustomScale(100);
      setColorMode(true);
      setPrinting(false);
      setLoadingPreview(true);
    } else {
      setPdfDoc(null);
    }
  }, [isOpen]);

  // Load PDF document for preview
  useEffect(() => {
    if (!isOpen || !pdfData) return;
    let cancelled = false;

    (async () => {
      const pdfjsLib = await import('pdfjs-dist');
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url
      ).toString();
      const { PDFJS_DOCUMENT_OPTIONS } = await import('../utils/pdfjsConfig');
      const doc = await pdfjsLib.getDocument({ ...PDFJS_DOCUMENT_OPTIONS, data: pdfData }).promise;
      if (!cancelled) {
        setPdfDoc(doc);

        // Auto-detect orientation from first page
        const firstPage = await doc.getPage(1);
        const vp = firstPage.getViewport({ scale: 1.0 });
        setOrientation(vp.width > vp.height ? 'landscape' : 'portrait');
      }
    })();

    return () => { cancelled = true; };
  }, [isOpen, pdfData]);

  // Render preview page
  useEffect(() => {
    if (!pdfDoc || !previewCanvasRef.current || pagesToPrint.length === 0) return;

    const pageNum = pagesToPrint[Math.min(previewIndex, pagesToPrint.length - 1)];
    if (!pageNum) return;

    let cancelled = false;
    setLoadingPreview(true);

    (async () => {
      const page = await pdfDoc.getPage(pageNum);
      if (cancelled) return;

      const viewport = page.getViewport({ scale: 1.0 });
      const previewScale = Math.min(340 / viewport.width, 440 / viewport.height);
      const scaledViewport = page.getViewport({ scale: previewScale });

      const canvas = previewCanvasRef.current!;
      canvas.width = scaledViewport.width;
      canvas.height = scaledViewport.height;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;
      if (!cancelled) setLoadingPreview(false);
    })();

    return () => { cancelled = true; };
  }, [pdfDoc, previewIndex, pagesToPrint]);

  // Handle print
  const handlePrint = useCallback(async () => {
    if (!pdfDoc || pagesToPrint.length === 0) return;
    setPrinting(true);

    try {
      // Render pages at print quality
      const pageImages: string[] = [];
      const pageDimensions: Array<{ width: number; height: number }> = [];

      for (const pageNum of pagesToPrint) {
        const page = await pdfDoc.getPage(pageNum);
        const baseViewport = page.getViewport({ scale: 1.0 });
        pageDimensions.push({ width: baseViewport.width, height: baseViewport.height });

        const printScale = 3.0;
        const viewport = page.getViewport({ scale: printScale });
        const canvas = window.document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        pageImages.push(canvas.toDataURL('image/jpeg', 0.95));
      }

      // Build image style based on scale mode
      let imgStyle: string;
      if (scaleMode === 'actual') {
        imgStyle = ''; // Each image gets individual sizing below
      } else if (scaleMode === 'custom') {
        const pct = customScale;
        imgStyle = `max-width:${pct}%;max-height:${pct}%;object-fit:contain;`;
      } else {
        imgStyle = 'max-width:100%;max-height:100%;object-fit:contain;';
      }

      const pagesHtml = pageImages.map((img, i) => {
        const style = scaleMode === 'actual'
          ? `width:${pageDimensions[i].width}pt;height:${pageDimensions[i].height}pt;`
          : imgStyle;
        return `<div class="print-page"><img src="${img}" style="${style}"></div>`;
      }).join('\n');

      const html = `<!DOCTYPE html>
<html><head><style>
  @page { margin: 0; size: auto; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { margin: 0; background: white; }
  .print-page {
    page-break-after: always;
    width: 100vw;
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .print-page:last-child { page-break-after: auto; }
</style></head><body>
${pagesHtml}
</body></html>`;

      const result = await window.electronAPI.printPdf({
        html,
        printerName: selectedPrinter,
        copies,
        landscape: orientation === 'landscape',
        color: colorMode,
        scaleFactor: scaleMode === 'custom' ? customScale : 100,
      });

      if (result.success) {
        onClose();
      }
    } catch (error) {
      console.error('Print failed:', error);
    } finally {
      setPrinting(false);
    }
  }, [pdfDoc, pagesToPrint, selectedPrinter, copies, orientation, colorMode, scaleMode, customScale, onClose]);

  const safePreviewIndex = Math.min(previewIndex, Math.max(0, pagesToPrint.length - 1));
  const currentPreviewPage = pagesToPrint[safePreviewIndex] || 1;

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Print" width="780px">
      <div className="print-dialog-layout">
        {/* Preview Section */}
        <div className="print-preview-section">
          <div className="print-preview-canvas-wrapper">
            {loadingPreview && (
              <div className="print-preview-loading">
                <Loader2 size={24} className="spin" />
              </div>
            )}
            <canvas
              ref={previewCanvasRef}
              className="print-preview-canvas"
              style={{ opacity: loadingPreview ? 0.3 : 1 }}
            />
          </div>

          <div className="print-preview-nav">
            <button
              className="print-nav-btn"
              disabled={safePreviewIndex === 0 || pagesToPrint.length <= 1}
              onClick={() => setPreviewIndex(i => Math.max(0, i - 1))}
            >
              <ChevronLeft size={16} />
            </button>
            <span className="print-preview-page-info">
              {pagesToPrint.length > 0
                ? `Page ${currentPreviewPage} (${safePreviewIndex + 1} of ${pagesToPrint.length})`
                : 'No pages selected'
              }
            </span>
            <button
              className="print-nav-btn"
              disabled={safePreviewIndex >= pagesToPrint.length - 1 || pagesToPrint.length <= 1}
              onClick={() => setPreviewIndex(i => Math.min(pagesToPrint.length - 1, i + 1))}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>

        {/* Options Section */}
        <div className="print-options-section">
          {/* Printer */}
          <div className="print-option-group">
            <label className="print-option-label">Printer</label>
            <select
              className="print-option-select"
              value={selectedPrinter}
              onChange={e => setSelectedPrinter(e.target.value)}
            >
              {printers.length === 0 && (
                <option value="">No printers found</option>
              )}
              {printers.map(p => (
                <option key={p.name} value={p.name}>
                  {p.displayName || p.name}{p.isDefault ? ' (Default)' : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Pages */}
          <div className="print-option-group">
            <label className="print-option-label">Pages</label>
            <div className="print-radio-group">
              <label className="print-radio">
                <input
                  type="radio"
                  name="pageRange"
                  checked={pageRangeType === 'all'}
                  onChange={() => setPageRangeType('all')}
                />
                <span>All pages ({pageCount})</span>
              </label>
              <label className="print-radio">
                <input
                  type="radio"
                  name="pageRange"
                  checked={pageRangeType === 'current'}
                  onChange={() => setPageRangeType('current')}
                />
                <span>Current page ({currentPage})</span>
              </label>
              <label className="print-radio">
                <input
                  type="radio"
                  name="pageRange"
                  checked={pageRangeType === 'custom'}
                  onChange={() => setPageRangeType('custom')}
                />
                <span>Custom range</span>
              </label>
              {pageRangeType === 'custom' && (
                <input
                  type="text"
                  className="print-option-input"
                  placeholder="e.g. 1-3, 5, 8-10"
                  value={customRange}
                  onChange={e => setCustomRange(e.target.value)}
                  autoFocus
                />
              )}
            </div>
          </div>

          {/* Copies */}
          <div className="print-option-group">
            <label className="print-option-label">Copies</label>
            <div className="print-copies-control">
              <button
                className="print-copies-btn"
                onClick={() => setCopies(c => Math.max(1, c - 1))}
                disabled={copies <= 1}
              >
                <Minus size={14} />
              </button>
              <input
                type="number"
                className="print-copies-input"
                value={copies}
                min={1}
                max={999}
                onChange={e => setCopies(Math.max(1, parseInt(e.target.value) || 1))}
              />
              <button
                className="print-copies-btn"
                onClick={() => setCopies(c => Math.min(999, c + 1))}
              >
                <Plus size={14} />
              </button>
            </div>
          </div>

          {/* Scale */}
          <div className="print-option-group">
            <label className="print-option-label">Scale</label>
            <select
              className="print-option-select"
              value={scaleMode}
              onChange={e => setScaleMode(e.target.value as 'fit' | 'actual' | 'custom')}
            >
              <option value="fit">Fit to Page</option>
              <option value="actual">Actual Size</option>
              <option value="custom">Custom</option>
            </select>
            {scaleMode === 'custom' && (
              <div className="print-scale-custom">
                <input
                  type="number"
                  className="print-option-input print-scale-input"
                  value={customScale}
                  min={10}
                  max={200}
                  onChange={e => setCustomScale(Math.max(10, Math.min(200, parseInt(e.target.value) || 100)))}
                />
                <span className="print-scale-unit">%</span>
              </div>
            )}
          </div>

          {/* Orientation */}
          <div className="print-option-group">
            <label className="print-option-label">Orientation</label>
            <div className="print-toggle-group">
              <button
                className={`print-toggle-btn ${orientation === 'portrait' ? 'active' : ''}`}
                onClick={() => setOrientation('portrait')}
              >
                Portrait
              </button>
              <button
                className={`print-toggle-btn ${orientation === 'landscape' ? 'active' : ''}`}
                onClick={() => setOrientation('landscape')}
              >
                Landscape
              </button>
            </div>
          </div>

          {/* Color */}
          <div className="print-option-group">
            <label className="print-option-label">Color</label>
            <div className="print-toggle-group">
              <button
                className={`print-toggle-btn ${colorMode ? 'active' : ''}`}
                onClick={() => setColorMode(true)}
              >
                Color
              </button>
              <button
                className={`print-toggle-btn ${!colorMode ? 'active' : ''}`}
                onClick={() => setColorMode(false)}
              >
                Grayscale
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="print-dialog-footer">
        <span className="print-page-summary">
          {pagesToPrint.length} page{pagesToPrint.length !== 1 ? 's' : ''} selected
          {copies > 1 ? ` \u00D7 ${copies} copies` : ''}
        </span>
        <div className="print-dialog-actions">
          <button className="print-cancel-btn" onClick={onClose} disabled={printing}>
            Cancel
          </button>
          <button
            className="print-submit-btn"
            onClick={handlePrint}
            disabled={printing || pagesToPrint.length === 0 || !selectedPrinter}
          >
            {printing ? (
              <>
                <Loader2 size={16} className="spin" />
                Printing...
              </>
            ) : (
              <>
                <Printer size={16} />
                Print
              </>
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default PrintDialog;

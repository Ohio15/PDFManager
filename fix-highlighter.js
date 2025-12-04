const fs = require('fs');

// =====================================================
// 1. Update usePDFDocument.ts - Add addHighlight function
// =====================================================
const hookPath = 'D:/Projects/PDFEditor/src/renderer/hooks/usePDFDocument.ts';
let hookContent = fs.readFileSync(hookPath, 'utf8');

// Add HighlightAnnotation to imports
hookContent = hookContent.replace(
  "import { PDFDocument, Annotation, Position, TextAnnotation, ImageAnnotation, PDFTextItem } from '../types';",
  "import { PDFDocument, Annotation, Position, TextAnnotation, ImageAnnotation, HighlightAnnotation, PDFTextItem } from '../types';"
);

// Add addHighlight function after addImage function
const addImageFunctionEnd = `    [document, addToHistory]
  );

  const updateAnnotation = useCallback(`;

const addHighlightFunction = `    [document, addToHistory]
  );

  const addHighlight = useCallback(
    (pageIndex: number, rects: Array<{ x: number; y: number; width: number; height: number }>, color: string = 'rgba(255, 255, 0, 0.3)') => {
      if (!document || rects.length === 0) return;

      const annotation: HighlightAnnotation = {
        id: \`highlight-\${Date.now()}\`,
        type: 'highlight',
        pageIndex,
        rects,
        color,
      };

      const previousAnnotations = [...document.pages[pageIndex - 1].annotations];

      setDocument((prev) => {
        if (!prev) return null;
        const newPages = [...prev.pages];
        newPages[pageIndex - 1] = {
          ...newPages[pageIndex - 1],
          annotations: [...newPages[pageIndex - 1].annotations, annotation],
        };
        return { ...prev, pages: newPages };
      });

      addToHistory({
        type: 'addHighlight',
        undo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            const newPages = [...prev.pages];
            newPages[pageIndex - 1] = {
              ...newPages[pageIndex - 1],
              annotations: previousAnnotations,
            };
            return { ...prev, pages: newPages };
          });
        },
        redo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            const newPages = [...prev.pages];
            newPages[pageIndex - 1] = {
              ...newPages[pageIndex - 1],
              annotations: [...newPages[pageIndex - 1].annotations, annotation],
            };
            return { ...prev, pages: newPages };
          });
        },
      });
    },
    [document, addToHistory]
  );

  const updateAnnotation = useCallback(`;

hookContent = hookContent.replace(addImageFunctionEnd, addHighlightFunction);

// Add addHighlight to return statement
hookContent = hookContent.replace(
  `return {
    document,
    loading,
    modified,
    openFile,
    saveFile,
    saveFileAs,
    addText,
    addImage,
    deletePage,`,
  `return {
    document,
    loading,
    modified,
    openFile,
    saveFile,
    saveFileAs,
    addText,
    addImage,
    addHighlight,
    deletePage,`
);

fs.writeFileSync(hookPath, hookContent);
console.log('Updated usePDFDocument.ts with addHighlight');

// =====================================================
// 2. Update PDFViewer.tsx - Add highlight rendering and creation
// =====================================================
const viewerPath = 'D:/Projects/PDFEditor/src/renderer/components/PDFViewer.tsx';
let viewerContent = fs.readFileSync(viewerPath, 'utf8');

// Add HighlightAnnotation to imports
viewerContent = viewerContent.replace(
  "import { PDFDocument, Annotation, TextAnnotation, ImageAnnotation, PDFTextItem, Size } from '../types';",
  "import { PDFDocument, Annotation, TextAnnotation, ImageAnnotation, HighlightAnnotation, PDFTextItem, Size } from '../types';"
);

// Add onAddHighlight to props interface
viewerContent = viewerContent.replace(
  `onBringToFront?: (pageIndex: number, annotationId: string) => void;
  onSelectionChange?: (annotationId: string | null) => void;`,
  `onBringToFront?: (pageIndex: number, annotationId: string) => void;
  onSelectionChange?: (annotationId: string | null) => void;
  onAddHighlight?: (pageIndex: number, rects: Array<{ x: number; y: number; width: number; height: number }>) => void;`
);

// Add onAddHighlight to destructuring
viewerContent = viewerContent.replace(
  `onBringToFront,
  onSelectionChange,
  loading,`,
  `onBringToFront,
  onSelectionChange,
  onAddHighlight,
  loading,`
);

// Add state for highlight drawing
viewerContent = viewerContent.replace(
  `const [textEditDialog, setTextEditDialog] = useState<TextEditDialogState>({
    isOpen: false,
    pageNum: 0,
    textItemId: '',
    originalText: '',
    editedText: '',
  });`,
  `const [textEditDialog, setTextEditDialog] = useState<TextEditDialogState>({
    isOpen: false,
    pageNum: 0,
    textItemId: '',
    originalText: '',
    editedText: '',
  });
  const [highlightStart, setHighlightStart] = useState<{ pageNum: number; x: number; y: number } | null>(null);
  const [highlightPreview, setHighlightPreview] = useState<{ x: number; y: number; width: number; height: number } | null>(null);`
);

// Add handlePageMouseDown function before handleAnnotationMouseDown
viewerContent = viewerContent.replace(
  `const handleAnnotationMouseDown = (
    e: React.MouseEvent,
    pageIndex: number,
    annotation: Annotation
  ) => {`,
  `const handlePageMouseDown = (
    e: React.MouseEvent,
    pageNum: number
  ) => {
    if (currentTool !== 'highlight') return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;

    setHighlightStart({ pageNum, x, y });
    setHighlightPreview(null);
  };

  const handlePageMouseMove = (
    e: React.MouseEvent,
    pageNum: number
  ) => {
    if (!highlightStart || highlightStart.pageNum !== pageNum) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const currentX = (e.clientX - rect.left) / scale;
    const currentY = (e.clientY - rect.top) / scale;

    const x = Math.min(highlightStart.x, currentX);
    const y = Math.min(highlightStart.y, currentY);
    const width = Math.abs(currentX - highlightStart.x);
    const height = Math.abs(currentY - highlightStart.y);

    setHighlightPreview({ x, y, width, height });
  };

  const handlePageMouseUp = (pageNum: number) => {
    if (!highlightStart || highlightStart.pageNum !== pageNum || !highlightPreview) {
      setHighlightStart(null);
      setHighlightPreview(null);
      return;
    }

    // Only create highlight if it's big enough
    if (highlightPreview.width > 5 && highlightPreview.height > 5) {
      onAddHighlight?.(pageNum, [highlightPreview]);
    }

    setHighlightStart(null);
    setHighlightPreview(null);
  };

  const handleAnnotationMouseDown = (
    e: React.MouseEvent,
    pageIndex: number,
    annotation: Annotation
  ) => {`
);

// Add highlight rendering in renderAnnotation function (before the final return null)
viewerContent = viewerContent.replace(
  `    return null;
  };

  return (
    <div className="pdf-viewer" ref={containerRef}>`,
  `    if (annotation.type === 'highlight') {
      const highlightAnnotation = annotation as HighlightAnnotation;
      return (
        <div key={annotation.id} className="highlight-annotation-container">
          {highlightAnnotation.rects.map((rect, idx) => (
            <div
              key={\`\${annotation.id}-\${idx}\`}
              className={\`highlight-rect \${isSelected ? 'selected' : ''}\`}
              style={{
                left: rect.x * scale,
                top: rect.y * scale,
                width: rect.width * scale,
                height: rect.height * scale,
                backgroundColor: highlightAnnotation.color,
                cursor: currentTool === 'erase' ? 'pointer' : (currentTool === 'select' ? 'pointer' : 'default'),
              }}
              onMouseDown={(e) => handleAnnotationMouseDown(e, pageIndex, annotation)}
              onContextMenu={(e) => handleContextMenu(e, pageIndex, annotation)}
            />
          ))}
        </div>
      );
    }

    return null;
  };

  return (
    <div className="pdf-viewer" ref={containerRef}>`
);

// Update the page container to handle highlight drawing
viewerContent = viewerContent.replace(
  `<div
            key={pageNum}
            className="pdf-page-container"
            style={{
              width: canvas.width,
              height: canvas.height,
            }}
            onClick={() => { setSelectedAnnotation(null); setEditingAnnotation(null); setEditingTextItem(null); }}
          >`,
  `<div
            key={pageNum}
            className={\`pdf-page-container \${currentTool === 'highlight' ? 'highlight-mode' : ''}\`}
            style={{
              width: canvas.width,
              height: canvas.height,
            }}
            onClick={() => { setSelectedAnnotation(null); setEditingAnnotation(null); setEditingTextItem(null); }}
            onMouseDown={(e) => handlePageMouseDown(e, pageNum)}
            onMouseMove={(e) => handlePageMouseMove(e, pageNum)}
            onMouseUp={() => handlePageMouseUp(pageNum)}
            onMouseLeave={() => { if (highlightStart) { setHighlightStart(null); setHighlightPreview(null); } }}
          >`
);

// Add highlight preview rendering after annotation layer
viewerContent = viewerContent.replace(
  `<div className="text-layer">
              {page?.textItems?.map((textItem) => renderTextItem(pageNum, textItem))}
            </div>
          </div>
        );
      })}`,
  `<div className="text-layer">
              {page?.textItems?.map((textItem) => renderTextItem(pageNum, textItem))}
            </div>
            {/* Highlight preview while drawing */}
            {highlightStart && highlightStart.pageNum === pageNum && highlightPreview && (
              <div
                className="highlight-preview"
                style={{
                  left: highlightPreview.x * scale,
                  top: highlightPreview.y * scale,
                  width: highlightPreview.width * scale,
                  height: highlightPreview.height * scale,
                }}
              />
            )}
          </div>
        );
      })}`
);

fs.writeFileSync(viewerPath, viewerContent);
console.log('Updated PDFViewer.tsx with highlight rendering and creation');

// =====================================================
// 3. Update App.tsx - Wire up addHighlight
// =====================================================
const appPath = 'D:/Projects/PDFEditor/src/renderer/App.tsx';
let appContent = fs.readFileSync(appPath, 'utf8');

// Add addHighlight to usePDFDocument destructuring
appContent = appContent.replace(
  `const {
    document,
    loading,
    modified,
    openFile,
    saveFile,
    saveFileAs,
    addText,
    addImage,
    deletePage,`,
  `const {
    document,
    loading,
    modified,
    openFile,
    saveFile,
    saveFileAs,
    addText,
    addImage,
    addHighlight,
    deletePage,`
);

// Add onAddHighlight prop to PDFViewer
appContent = appContent.replace(
  `onSelectionChange={handleSelectionChange}
            loading={loading}`,
  `onSelectionChange={handleSelectionChange}
            onAddHighlight={addHighlight}
            loading={loading}`
);

fs.writeFileSync(appPath, appContent);
console.log('Updated App.tsx with addHighlight wiring');

// =====================================================
// 4. Update styles - Add highlight CSS
// =====================================================
const stylesPath = 'D:/Projects/PDFEditor/src/renderer/styles/main.css';
let stylesContent = fs.readFileSync(stylesPath, 'utf8');

// Check if highlight styles already exist
if (!stylesContent.includes('.highlight-rect')) {
  // Add highlight styles at the end
  stylesContent += `

/* Highlight annotation styles */
.highlight-annotation-container {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
}

.highlight-rect {
  position: absolute;
  pointer-events: auto;
  border-radius: 2px;
  opacity: 0.5;
  transition: opacity 0.15s ease;
}

.highlight-rect:hover {
  opacity: 0.7;
}

.highlight-rect.selected {
  outline: 2px solid #2196f3;
  outline-offset: 1px;
}

.highlight-preview {
  position: absolute;
  background-color: rgba(255, 255, 0, 0.4);
  border: 1px dashed #ffc107;
  pointer-events: none;
  z-index: 1000;
}

.pdf-page-container.highlight-mode {
  cursor: crosshair;
}

.pdf-page-container.highlight-mode .pdf-text-item {
  pointer-events: none;
}

.pdf-page-container.highlight-mode .annotation-layer {
  pointer-events: none;
}

.pdf-page-container.highlight-mode .highlight-rect {
  pointer-events: none;
}
`;

  fs.writeFileSync(stylesPath, stylesContent);
  console.log('Updated main.css with highlight styles');
} else {
  console.log('Highlight styles already exist in main.css');
}

console.log('\\nAll highlighter functionality added successfully!');

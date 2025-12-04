const fs = require('fs');

// =====================================================
// 1. Update App.tsx - Add tool-change effect
// =====================================================
const appPath = 'D:/Projects/PDFEditor/src/renderer/App.tsx';
let appContent = fs.readFileSync(appPath, 'utf8');

// Add a new effect to handle tool changes with selection
// Insert after handleSelectionChange callback
const afterSelectionChange = `const handleSelectionChange = useCallback((annotationId: string | null) => {
    setSelectedAnnotationId(annotationId);
  }, []);`;

const newToolChangeEffect = `const handleSelectionChange = useCallback((annotationId: string | null) => {
    setSelectedAnnotationId(annotationId);
  }, []);

  // Handle tool activation on existing selection
  // When eraser is selected with something already selected, delete it
  // When highlighter is selected with something already selected, it stays selected (ready for highlight interaction)
  const handleToolChange = useCallback((newTool: Tool) => {
    if (newTool === 'erase' && selectedAnnotationId && document) {
      // Find which page has this annotation and delete it
      const pageIndex = document.pages.findIndex((p) =>
        p.annotations.some((a) => a.id === selectedAnnotationId)
      );
      if (pageIndex !== -1) {
        deleteAnnotation(pageIndex + 1, selectedAnnotationId);
        setSelectedAnnotationId(null);
      }
    }
    setCurrentTool(newTool);
  }, [selectedAnnotationId, document, deleteAnnotation]);`;

appContent = appContent.replace(afterSelectionChange, newToolChangeEffect);

// Update the Toolbar to use handleToolChange instead of setCurrentTool
appContent = appContent.replace(
  'onToolChange={setCurrentTool}',
  'onToolChange={handleToolChange}'
);

fs.writeFileSync(appPath, appContent);
console.log('Updated App.tsx with tool-change effect');

// =====================================================
// 2. Update PDFViewer.tsx - Improve keyboard handling
// =====================================================
const viewerPath = 'D:/Projects/PDFEditor/src/renderer/components/PDFViewer.tsx';
let viewerContent = fs.readFileSync(viewerPath, 'utf8');

// Update handleKeyDown to work regardless of tool (Delete should always work when something is selected)
const oldKeyDown = `const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Don't handle delete if we're editing text
      if (editingAnnotation) return;

      if (e.key === 'Delete' && selectedAnnotation) {
        const pageIndex = document.pages.findIndex((p) =>
          p.annotations.some((a) => a.id === selectedAnnotation)
        );
        if (pageIndex !== -1) {
          onDeleteAnnotation(pageIndex + 1, selectedAnnotation);
          setSelectedAnnotation(null);
        }
      }
      if (e.key === 'Escape') {
        setSelectedAnnotation(null);
        setEditingAnnotation(null);
        setContextMenu(prev => ({ ...prev, isOpen: false }));
      }
    },
    [selectedAnnotation, editingAnnotation, document.pages, onDeleteAnnotation]
  );`;

const newKeyDown = `const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Don't handle delete if we're editing text or if text edit dialog is open
      if (editingAnnotation || textEditDialog.isOpen) return;

      // Delete key works regardless of current tool when something is selected
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedAnnotation) {
        e.preventDefault();
        const pageIndex = document.pages.findIndex((p) =>
          p.annotations.some((a) => a.id === selectedAnnotation)
        );
        if (pageIndex !== -1) {
          onDeleteAnnotation(pageIndex + 1, selectedAnnotation);
          setSelectedAnnotation(null);
        }
      }
      if (e.key === 'Escape') {
        setSelectedAnnotation(null);
        setEditingAnnotation(null);
        setContextMenu(prev => ({ ...prev, isOpen: false }));
      }
    },
    [selectedAnnotation, editingAnnotation, textEditDialog.isOpen, document.pages, onDeleteAnnotation]
  );`;

viewerContent = viewerContent.replace(oldKeyDown, newKeyDown);

fs.writeFileSync(viewerPath, viewerContent);
console.log('Updated PDFViewer.tsx with improved keyboard handling');

// =====================================================
// 3. Update CSS - Add eraser cursor and tool styles
// =====================================================
const stylesPath = 'D:/Projects/PDFEditor/src/renderer/styles/global.css';
let stylesContent = fs.readFileSync(stylesPath, 'utf8');

// Check if eraser styles already exist
if (!stylesContent.includes('.erase-mode')) {
  // Add eraser mode styles
  stylesContent += `

/* Eraser tool mode styles */
.pdf-page-container.erase-mode {
  cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%23e53935' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 5H9l-7 7 7 7h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Z'/%3E%3Cline x1='18' y1='9' x2='12' y2='15'/%3E%3Cline x1='12' y1='9' x2='18' y2='15'/%3E%3C/svg%3E") 12 12, crosshair;
}

.pdf-page-container.erase-mode .editable-text,
.pdf-page-container.erase-mode .editable-image,
.pdf-page-container.erase-mode .highlight-rect {
  cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%23e53935' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 5H9l-7 7 7 7h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Z'/%3E%3Cline x1='18' y1='9' x2='12' y2='15'/%3E%3Cline x1='12' y1='9' x2='18' y2='15'/%3E%3C/svg%3E") 12 12, pointer !important;
  transition: opacity 0.15s ease, transform 0.1s ease;
}

.pdf-page-container.erase-mode .editable-text:hover,
.pdf-page-container.erase-mode .editable-image:hover,
.pdf-page-container.erase-mode .highlight-rect:hover {
  opacity: 0.6;
  outline: 2px dashed #e53935;
  outline-offset: 2px;
}

/* Selection indicator when annotation is selected */
.editable-text.selected,
.editable-image.selected {
  outline: 2px solid #2196f3;
  outline-offset: 2px;
}

/* Make sure text-layer doesn't interfere with eraser on annotations */
.pdf-page-container.erase-mode .text-layer {
  pointer-events: none;
}
`;

  fs.writeFileSync(stylesPath, stylesContent);
  console.log('Updated global.css with eraser cursor styles');
} else {
  console.log('Eraser styles already exist in global.css');
}

// =====================================================
// 4. Update PDFViewer.tsx - Add erase-mode class to container
// =====================================================
viewerContent = fs.readFileSync(viewerPath, 'utf8');

// Update the page container class to include erase-mode
const oldPageContainerClass = "className={`pdf-page-container ${currentTool === 'highlight' ? 'highlight-mode' : ''}`}";
const newPageContainerClass = "className={`pdf-page-container ${currentTool === 'highlight' ? 'highlight-mode' : ''} ${currentTool === 'erase' ? 'erase-mode' : ''}`}";

viewerContent = viewerContent.replace(oldPageContainerClass, newPageContainerClass);

fs.writeFileSync(viewerPath, viewerContent);
console.log('Updated PDFViewer.tsx with erase-mode class');

console.log('\nAll keyboard and tool improvements applied successfully!');

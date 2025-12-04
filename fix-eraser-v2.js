const fs = require('fs');

// =====================================================
// Update PDFViewer.tsx - Improved eraser with region selection
// =====================================================
const viewerPath = 'D:/Projects/PDFEditor/src/renderer/components/PDFViewer.tsx';
let viewerContent = fs.readFileSync(viewerPath, 'utf8');

// 1. Add state for eraser region selection
const oldHighlightState = `const [highlightStart, setHighlightStart] = useState<{ pageNum: number; x: number; y: number } | null>(null);
  const [highlightPreview, setHighlightPreview] = useState<{ x: number; y: number; width: number; height: number } | null>(null);`;

const newHighlightState = `const [highlightStart, setHighlightStart] = useState<{ pageNum: number; x: number; y: number } | null>(null);
  const [highlightPreview, setHighlightPreview] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [eraserStart, setEraserStart] = useState<{ pageNum: number; x: number; y: number } | null>(null);
  const [eraserPreview, setEraserPreview] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [erasedItems, setErasedItems] = useState<Set<string>>(new Set());`;

viewerContent = viewerContent.replace(oldHighlightState, newHighlightState);

// 2. Update handlePageMouseDown to handle eraser drag selection
const oldPageMouseDown = `const handlePageMouseDown = (
    e: React.MouseEvent,
    pageNum: number
  ) => {
    if (currentTool !== 'highlight') return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;

    setHighlightStart({ pageNum, x, y });
    setHighlightPreview(null);
  };`;

const newPageMouseDown = `const handlePageMouseDown = (
    e: React.MouseEvent,
    pageNum: number
  ) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;

    if (currentTool === 'highlight') {
      setHighlightStart({ pageNum, x, y });
      setHighlightPreview(null);
    } else if (currentTool === 'erase') {
      setEraserStart({ pageNum, x, y });
      setEraserPreview(null);
    }
  };`;

viewerContent = viewerContent.replace(oldPageMouseDown, newPageMouseDown);

// 3. Update handlePageMouseMove to handle eraser drag
const oldPageMouseMove = `const handlePageMouseMove = (
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
  };`;

const newPageMouseMove = `const handlePageMouseMove = (
    e: React.MouseEvent,
    pageNum: number
  ) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const currentX = (e.clientX - rect.left) / scale;
    const currentY = (e.clientY - rect.top) / scale;

    if (highlightStart && highlightStart.pageNum === pageNum) {
      const x = Math.min(highlightStart.x, currentX);
      const y = Math.min(highlightStart.y, currentY);
      const width = Math.abs(currentX - highlightStart.x);
      const height = Math.abs(currentY - highlightStart.y);
      setHighlightPreview({ x, y, width, height });
    }

    if (eraserStart && eraserStart.pageNum === pageNum) {
      const x = Math.min(eraserStart.x, currentX);
      const y = Math.min(eraserStart.y, currentY);
      const width = Math.abs(currentX - eraserStart.x);
      const height = Math.abs(currentY - eraserStart.y);
      setEraserPreview({ x, y, width, height });
    }
  };`;

viewerContent = viewerContent.replace(oldPageMouseMove, newPageMouseMove);

// 4. Update handlePageMouseUp to handle eraser region selection
const oldPageMouseUp = `const handlePageMouseUp = (pageNum: number) => {
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
  };`;

const newPageMouseUp = `const handlePageMouseUp = (pageNum: number) => {
    // Handle highlight tool
    if (highlightStart && highlightStart.pageNum === pageNum && highlightPreview) {
      if (highlightPreview.width > 5 && highlightPreview.height > 5) {
        onAddHighlight?.(pageNum, [highlightPreview]);
      }
      setHighlightStart(null);
      setHighlightPreview(null);
    }

    // Handle eraser region selection
    if (eraserStart && eraserStart.pageNum === pageNum && eraserPreview) {
      if (eraserPreview.width > 5 && eraserPreview.height > 5) {
        // Find all text items that intersect with the eraser region
        const page = document.pages[pageNum - 1];
        if (page?.textItems) {
          const itemsToErase: string[] = [];
          page.textItems.forEach((textItem) => {
            // Check if text item intersects with eraser region
            const itemRight = textItem.x + textItem.width;
            const itemBottom = textItem.y + textItem.height;
            const eraserRight = eraserPreview.x + eraserPreview.width;
            const eraserBottom = eraserPreview.y + eraserPreview.height;

            const intersects = !(
              textItem.x > eraserRight ||
              itemRight < eraserPreview.x ||
              textItem.y > eraserBottom ||
              itemBottom < eraserPreview.y
            );

            if (intersects && textItem.str && textItem.str.trim()) {
              itemsToErase.push(textItem.id);
            }
          });

          // Erase all intersecting items
          itemsToErase.forEach((itemId) => {
            onUpdateTextItem(pageNum, itemId, '');
          });

          // Add to visual erased set for immediate feedback
          setErasedItems((prev) => {
            const newSet = new Set(prev);
            itemsToErase.forEach((id) => newSet.add(id));
            return newSet;
          });
        }
      }
      setEraserStart(null);
      setEraserPreview(null);
    } else if (eraserStart) {
      setEraserStart(null);
      setEraserPreview(null);
    }

    if (highlightStart) {
      setHighlightStart(null);
      setHighlightPreview(null);
    }
  };`;

viewerContent = viewerContent.replace(oldPageMouseUp, newPageMouseUp);

// 5. Update handleTextItemClick for immediate visual feedback
const oldTextItemClick = `const handleTextItemClick = (
    e: React.MouseEvent,
    pageNum: number,
    textItem: PDFTextItem
  ) => {
    // Handle eraser tool - delete/hide text item on click
    if (currentTool === 'erase') {
      e.stopPropagation();
      e.preventDefault();
      // "Delete" the text by setting it to empty string
      onUpdateTextItem(pageNum, textItem.id, '');
      return;
    }
  };`;

const newTextItemClick = `const handleTextItemClick = (
    e: React.MouseEvent,
    pageNum: number,
    textItem: PDFTextItem
  ) => {
    // Handle eraser tool - delete/hide text item on click
    if (currentTool === 'erase') {
      e.stopPropagation();
      e.preventDefault();
      // "Delete" the text by setting it to empty string
      onUpdateTextItem(pageNum, textItem.id, '');
      // Immediately add to erased set for instant visual feedback
      setErasedItems((prev) => new Set(prev).add(textItem.id));
      return;
    }
  };`;

viewerContent = viewerContent.replace(oldTextItemClick, newTextItemClick);

// 6. Update renderTextItem to check erasedItems set
const oldRenderTextItem = `const renderTextItem = (pageNum: number, textItem: PDFTextItem) => {
    const isEditable = true;
    // Don't render if text is empty (was "deleted")
    if (!textItem.str || textItem.str.trim() === '') return null;

    return (
      <div
        key={textItem.id}
        className={\`pdf-text-item \${textItem.isEdited ? 'edited' : ''} \${isEditable ? 'editable' : ''}\`}
        style={{
          left: textItem.x * scale,
          top: textItem.y * scale,
          fontSize: textItem.fontSize * scale,
          width: textItem.width * scale,
          height: textItem.height * scale,
          cursor: currentTool === 'erase' ? 'pointer' : (currentTool === 'select' && isEditable ? 'pointer' : 'default'),
          pointerEvents: currentTool === 'erase' ? 'auto' : undefined,
        }}
        onClick={(e) => handleTextItemClick(e, pageNum, textItem)}
        onDoubleClick={(e) => handleTextItemDoubleClick(e, pageNum, textItem)}
      >
        {textItem.str}
      </div>
    );
  };`;

const newRenderTextItem = `const renderTextItem = (pageNum: number, textItem: PDFTextItem) => {
    const isEditable = true;
    // Don't render if text is empty (was "deleted") or in erased set
    if (!textItem.str || textItem.str.trim() === '' || erasedItems.has(textItem.id)) return null;

    return (
      <div
        key={textItem.id}
        className={\`pdf-text-item \${textItem.isEdited ? 'edited' : ''} \${isEditable ? 'editable' : ''}\`}
        style={{
          left: textItem.x * scale,
          top: textItem.y * scale,
          fontSize: textItem.fontSize * scale,
          width: textItem.width * scale,
          height: textItem.height * scale,
          cursor: currentTool === 'erase' ? 'pointer' : (currentTool === 'select' && isEditable ? 'pointer' : 'default'),
          pointerEvents: currentTool === 'erase' ? 'auto' : undefined,
        }}
        onClick={(e) => handleTextItemClick(e, pageNum, textItem)}
        onDoubleClick={(e) => handleTextItemDoubleClick(e, pageNum, textItem)}
      >
        {textItem.str}
      </div>
    );
  };`;

viewerContent = viewerContent.replace(oldRenderTextItem, newRenderTextItem);

// 7. Update onMouseLeave to also handle eraser state
const oldMouseLeave = `onMouseLeave={() => { if (highlightStart) { setHighlightStart(null); setHighlightPreview(null); } }}`;
const newMouseLeave = `onMouseLeave={() => {
              if (highlightStart) { setHighlightStart(null); setHighlightPreview(null); }
              if (eraserStart) { setEraserStart(null); setEraserPreview(null); }
            }}`;

viewerContent = viewerContent.replace(oldMouseLeave, newMouseLeave);

// 8. Add eraser preview rendering (after highlight preview)
const oldHighlightPreviewRender = `{/* Highlight preview while drawing */}
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
      })}`;

const newHighlightPreviewRender = `{/* Highlight preview while drawing */}
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
            {/* Eraser region preview while dragging */}
            {eraserStart && eraserStart.pageNum === pageNum && eraserPreview && (
              <div
                className="eraser-preview"
                style={{
                  left: eraserPreview.x * scale,
                  top: eraserPreview.y * scale,
                  width: eraserPreview.width * scale,
                  height: eraserPreview.height * scale,
                }}
              />
            )}
          </div>
        );
      })}`;

viewerContent = viewerContent.replace(oldHighlightPreviewRender, newHighlightPreviewRender);

fs.writeFileSync(viewerPath, viewerContent);
console.log('Updated PDFViewer.tsx with improved eraser functionality');

// =====================================================
// Update CSS - Add eraser preview styles
// =====================================================
const stylesPath = 'D:/Projects/PDFEditor/src/renderer/styles/global.css';
let stylesContent = fs.readFileSync(stylesPath, 'utf8');

// Check if eraser preview styles already exist
if (!stylesContent.includes('.eraser-preview')) {
  stylesContent += `

/* Eraser region selection preview */
.eraser-preview {
  position: absolute;
  background-color: rgba(229, 57, 53, 0.15);
  border: 2px dashed #e53935;
  pointer-events: none;
  z-index: 1000;
  box-sizing: border-box;
}
`;
  fs.writeFileSync(stylesPath, stylesContent);
  console.log('Updated global.css with eraser preview styles');
} else {
  console.log('Eraser preview styles already exist in global.css');
}

console.log('\\nImproved eraser functionality added:');
console.log('- Click to erase single text items');
console.log('- Click and drag to select region and erase all text within');
console.log('- Immediate visual feedback when text is erased');

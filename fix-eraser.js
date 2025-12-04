const fs = require('fs');

// =====================================================
// Update PDFViewer.tsx - Add eraser functionality for PDF text items
// =====================================================
const viewerPath = 'D:/Projects/PDFEditor/src/renderer/components/PDFViewer.tsx';
let viewerContent = fs.readFileSync(viewerPath, 'utf8');

// Add handleTextItemClick function and update renderTextItem
const oldRenderTextItem = `  const renderTextItem = (pageNum: number, textItem: PDFTextItem) => {
    const isEditable = true;

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
          cursor: currentTool === 'select' && isEditable ? 'pointer' : 'default',
        }}
        onDoubleClick={(e) => handleTextItemDoubleClick(e, pageNum, textItem)}
      >
        {textItem.str}
      </div>
    );
  };`;

const newRenderTextItem = `  const handleTextItemClick = (
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
  };

  const renderTextItem = (pageNum: number, textItem: PDFTextItem) => {
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

if (viewerContent.includes(oldRenderTextItem)) {
  viewerContent = viewerContent.replace(oldRenderTextItem, newRenderTextItem);
  fs.writeFileSync(viewerPath, viewerContent);
  console.log('Updated PDFViewer.tsx with eraser functionality for text items');
} else {
  console.log('Could not find the renderTextItem function to update. It may have already been modified.');
  console.log('Checking if handleTextItemClick already exists...');
  if (viewerContent.includes('handleTextItemClick')) {
    console.log('handleTextItemClick already exists in the file');
  } else {
    console.log('Need to manually update the file');
  }
}

// =====================================================
// Update CSS - Add eraser hover style for text items
// =====================================================
const stylesPath = 'D:/Projects/PDFEditor/src/renderer/styles/global.css';
let stylesContent = fs.readFileSync(stylesPath, 'utf8');

// Check if text item eraser styles already exist
if (!stylesContent.includes('.pdf-page-container.erase-mode .pdf-text-item')) {
  stylesContent += `

/* Eraser mode for PDF text items */
.pdf-page-container.erase-mode .pdf-text-item {
  pointer-events: auto !important;
  cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%23e53935' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 5H9l-7 7 7 7h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Z'/%3E%3Cline x1='18' y1='9' x2='12' y2='15'/%3E%3Cline x1='12' y1='9' x2='18' y2='15'/%3E%3C/svg%3E") 12 12, pointer !important;
}

.pdf-page-container.erase-mode .pdf-text-item:hover {
  background-color: rgba(229, 57, 53, 0.2);
  outline: 2px dashed #e53935;
  outline-offset: 1px;
}
`;
  fs.writeFileSync(stylesPath, stylesContent);
  console.log('Updated global.css with text item eraser styles');
} else {
  console.log('Text item eraser styles already exist in global.css');
}

console.log('\\nEraser functionality for text items added successfully!');

const fs = require('fs');

const viewerPath = 'D:/Projects/PDFEditor/src/renderer/components/PDFViewer.tsx';
let content = fs.readFileSync(viewerPath, 'utf8');

// 1. Add onSelectionChange to interface
content = content.replace(
  'onBringToFront?: (pageIndex: number, annotationId: string) => void;\n  loading: boolean;',
  'onBringToFront?: (pageIndex: number, annotationId: string) => void;\n  onSelectionChange?: (annotationId: string | null) => void;\n  loading: boolean;'
);

// 2. Add onSelectionChange to destructuring
content = content.replace(
  'onBringToFront,\n  loading,\n}) => {',
  'onBringToFront,\n  onSelectionChange,\n  loading,\n}) => {'
);

// 3. Add editableTextRef after containerRef
content = content.replace(
  'const containerRef = useRef<HTMLDivElement>(null);',
  'const containerRef = useRef<HTMLDivElement>(null);\n  const editableTextRef = useRef<HTMLDivElement>(null);'
);

// 4. Add useEffect to notify parent when selection changes (after scale definition)
content = content.replace(
  'const scale = zoom / 100;\n\n  useEffect(() => {\n    const renderPages',
  `const scale = zoom / 100;

  // Notify parent when selection changes
  useEffect(() => {
    onSelectionChange?.(selectedAnnotation);
  }, [selectedAnnotation, onSelectionChange]);

  // Focus editable text when entering edit mode
  useEffect(() => {
    if (editingAnnotation && editableTextRef.current) {
      editableTextRef.current.focus();
      // Select all text for easy editing
      const selection = window.getSelection();
      const range = window.document.createRange();
      range.selectNodeContents(editableTextRef.current);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }, [editingAnnotation]);

  useEffect(() => {
    const renderPages`
);

// 5. Fix handleAnnotationMouseDown to handle eraser tool
content = content.replace(
  `const handleAnnotationMouseDown = (
    e: React.MouseEvent,
    pageIndex: number,
    annotation: Annotation
  ) => {
    if (currentTool !== 'select') return;
    e.stopPropagation();`,
  `const handleAnnotationMouseDown = (
    e: React.MouseEvent,
    pageIndex: number,
    annotation: Annotation
  ) => {
    e.stopPropagation();

    // Handle eraser tool - delete annotation on click
    if (currentTool === 'erase') {
      onDeleteAnnotation(pageIndex, annotation.id);
      return;
    }

    if (currentTool !== 'select') return;`
);

// 6. Fix handleKeyDown to not delete when editing text
content = content.replace(
  `const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Delete' && selectedAnnotation) {`,
  `const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Don't handle delete if we're editing text
      if (editingAnnotation) return;

      if (e.key === 'Delete' && selectedAnnotation) {`
);

// Also update the dependency array for handleKeyDown
content = content.replace(
  '[selectedAnnotation, document.pages, onDeleteAnnotation]',
  '[selectedAnnotation, editingAnnotation, document.pages, onDeleteAnnotation]'
);

// 7. Update renderAnnotation for text to add ref and keyboard handlers
content = content.replace(
  `<div
          key={annotation.id}
          className={\`editable-text \${isSelected ? 'selected' : ''} \${isEditing ? 'editing' : ''} \${isDraggingThis ? 'dragging' : ''} \${isResizingThis ? 'resizing' : ''}\`}
          style={{
            left: textAnnotation.position.x * scale,
            top: textAnnotation.position.y * scale,
            fontSize: textAnnotation.fontSize * scale,
            fontFamily: textAnnotation.fontFamily,
            color: textAnnotation.color,
            cursor: isEditing ? 'text' : (currentTool === 'select' ? 'move' : 'default'),`,
  `<div
          key={annotation.id}
          ref={isEditing ? editableTextRef : undefined}
          className={\`editable-text \${isSelected ? 'selected' : ''} \${isEditing ? 'editing' : ''} \${isDraggingThis ? 'dragging' : ''} \${isResizingThis ? 'resizing' : ''}\`}
          style={{
            left: textAnnotation.position.x * scale,
            top: textAnnotation.position.y * scale,
            fontSize: textAnnotation.fontSize * scale,
            fontFamily: textAnnotation.fontFamily,
            color: textAnnotation.color,
            cursor: currentTool === 'erase' ? 'pointer' : (isEditing ? 'text' : (currentTool === 'select' ? 'move' : 'default')),`
);

// 8. Update onBlur for text editing
content = content.replace(
  `contentEditable={isEditing}
          suppressContentEditableWarning
          onBlur={(e) =>
            handleTextChange(pageIndex, annotation.id, e.currentTarget.textContent || '')
          }
        >`,
  `contentEditable={isEditing}
          suppressContentEditableWarning
          onBlur={(e) => {
            if (isEditing) {
              handleTextChange(pageIndex, annotation.id, e.currentTarget.textContent || '');
            }
          }}
          onKeyDown={(e) => {
            if (isEditing && e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.blur();
            }
            if (isEditing && e.key === 'Escape') {
              e.preventDefault();
              setEditingAnnotation(null);
            }
          }}
        >`
);

// 9. Update image cursor for eraser tool
content = content.replace(
  `cursor: currentTool === 'select' ? 'move' : 'default',
          }}
          onMouseDown={(e) => handleAnnotationMouseDown(e, pageIndex, annotation)}
          onContextMenu={(e) => handleContextMenu(e, pageIndex, annotation)}
        >
          <img`,
  `cursor: currentTool === 'erase' ? 'pointer' : (currentTool === 'select' ? 'move' : 'default'),
          }}
          onMouseDown={(e) => handleAnnotationMouseDown(e, pageIndex, annotation)}
          onContextMenu={(e) => handleContextMenu(e, pageIndex, annotation)}
        >
          <img`
);

fs.writeFileSync(viewerPath, content);
console.log('Updated PDFViewer.tsx');

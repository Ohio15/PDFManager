import React from 'react';
import {
  Combine,
  Scissors,
  FileOutput,
  ImageDown,
  RotateCw,
  FileText,
  Image,
  Code,
  ChevronLeft,
  X,
} from 'lucide-react';

interface ToolsPanelProps {
  visible: boolean;
  onToggle: () => void;
  disabled: boolean;
  onMergePdfs: () => void;
  onSplitPdf: () => void;
  onExtractPages: () => void;
  onExtractImages: () => void;
  onRotateAll: () => void;
  onConvertFromPdf: () => void;
  onConvertToDocx: () => void;
  onExportSvg: () => void;
}

const ToolsPanel: React.FC<ToolsPanelProps> = ({
  visible,
  onToggle,
  disabled,
  onMergePdfs,
  onSplitPdf,
  onExtractPages,
  onExtractImages,
  onRotateAll,
  onConvertFromPdf,
  onConvertToDocx,
  onExportSvg,
}) => {
  const tools = [
    {
      id: 'merge',
      label: 'Merge PDFs',
      icon: <Combine size={18} />,
      onClick: onMergePdfs,
      description: 'Combine multiple PDFs into one',
      requiresDoc: false,
    },
    {
      id: 'split',
      label: 'Split PDF',
      icon: <Scissors size={18} />,
      onClick: onSplitPdf,
      description: 'Split into separate pages',
      requiresDoc: true,
    },
    {
      id: 'extract',
      label: 'Extract Pages',
      icon: <FileOutput size={18} />,
      onClick: onExtractPages,
      description: 'Extract specific pages',
      requiresDoc: true,
    },
    {
      id: 'images',
      label: 'Extract Images',
      icon: <ImageDown size={18} />,
      onClick: onExtractImages,
      description: 'Export embedded images',
      requiresDoc: true,
    },
    {
      id: 'rotate',
      label: 'Rotate All Pages',
      icon: <RotateCw size={18} />,
      onClick: onRotateAll,
      description: 'Rotate all pages 90°',
      requiresDoc: true,
    },
  ];

  if (!visible) {
    return (
      <button
        className="tools-panel-toggle collapsed"
        onClick={onToggle}
        title="Show Tools Panel"
      >
        <ChevronLeft size={16} />
      </button>
    );
  }

  return (
    <div className="tools-panel">
      <div className="tools-panel-header">
        <h3>Tools</h3>
        <button
          className="tools-panel-close"
          onClick={onToggle}
          title="Hide Tools Panel"
        >
          <X size={16} />
        </button>
      </div>

      <div className="tools-panel-content">
        <div className="tools-section">
          <h4>PDF Operations</h4>
          {tools.map((tool) => (
            <button
              key={tool.id}
              className="tool-btn"
              onClick={tool.onClick}
              disabled={tool.requiresDoc && disabled}
              title={tool.description}
            >
              {tool.icon}
              <span>{tool.label}</span>
            </button>
          ))}
        </div>

        <div className="tools-section">
          <h4>Document Conversion</h4>
          <button
            className="tool-btn"
            onClick={onConvertToDocx}
            disabled={disabled}
            title="Convert PDF to Word document (.docx)"
          >
            <FileText size={18} />
            <span>PDF to Word</span>
          </button>
          <button
            className="tool-btn"
            onClick={onConvertFromPdf}
            disabled={disabled}
            title="Export PDF pages as PNG or JPEG images"
          >
            <Image size={18} />
            <span>PDF to Images</span>
          </button>
          <button
            className="tool-btn"
            onClick={onExportSvg}
            disabled={disabled}
            title="Export PDF pages as SVG vector graphics"
          >
            <Code size={18} />
            <span>PDF to SVG</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default ToolsPanel;

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
  ExternalLink,
  AlertCircle,
  FileType2,
} from 'lucide-react';

export type ToolsDocType = 'pdf' | 'staged' | 'none';

interface ToolsPanelProps {
  visible: boolean;
  onToggle: () => void;
  /** What is currently open: a PDF, a staged non-PDF document, or nothing. */
  docType: ToolsDocType;
  /** Name of the staged document (shown in the staged section header). */
  stagedName?: string;
  onMergePdfs: () => void;
  onSplitPdf: () => void;
  onExtractPages: () => void;
  onExtractImages: () => void;
  onRotateAll: () => void;
  onConvertToPdf: () => void;
  onConvertStagedToPdf: () => void;
  onConvertFromPdf: () => void;
  onConvertToDocx: () => void;
  onExportSvg: () => void;
  libreOfficeAvailable: boolean;
}

interface ToolDef {
  id: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  description: string;
  disabled?: boolean;
}

const ToolsPanel: React.FC<ToolsPanelProps> = ({
  visible,
  onToggle,
  docType,
  stagedName,
  onMergePdfs,
  onSplitPdf,
  onExtractPages,
  onExtractImages,
  onRotateAll,
  onConvertToPdf,
  onConvertStagedToPdf,
  onConvertFromPdf,
  onConvertToDocx,
  onExportSvg,
  libreOfficeAvailable,
}) => {
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

  // Sections are chosen by what's open, so the panel only ever shows
  // conversions that apply to the current document.
  const sections: Array<{ title: string; tools: ToolDef[] }> = [];

  if (docType === 'pdf') {
    sections.push({
      title: 'PDF Operations',
      tools: [
        { id: 'merge', label: 'Merge PDFs', icon: <Combine size={18} />, onClick: onMergePdfs, description: 'Combine multiple PDFs into one' },
        { id: 'split', label: 'Split PDF', icon: <Scissors size={18} />, onClick: onSplitPdf, description: 'Split into separate pages' },
        { id: 'extract', label: 'Extract Pages', icon: <FileOutput size={18} />, onClick: onExtractPages, description: 'Extract specific pages' },
        { id: 'images', label: 'Extract Images', icon: <ImageDown size={18} />, onClick: onExtractImages, description: 'Export embedded images' },
        { id: 'rotate', label: 'Rotate All Pages', icon: <RotateCw size={18} />, onClick: onRotateAll, description: 'Rotate all pages 90°' },
      ],
    });
    sections.push({
      title: 'Convert From PDF',
      tools: [
        { id: 'to-word', label: 'PDF to Word', icon: <FileText size={18} />, onClick: onConvertToDocx, description: 'Convert PDF to Word document (.docx)' },
        { id: 'to-images', label: 'PDF to Images', icon: <Image size={18} />, onClick: onConvertFromPdf, description: 'Export PDF pages as PNG or JPEG images' },
        { id: 'to-svg', label: 'PDF to SVG', icon: <Code size={18} />, onClick: onExportSvg, description: 'Export PDF pages as SVG vector graphics' },
      ],
    });
  } else if (docType === 'staged') {
    sections.push({
      title: stagedName ? `Convert "${stagedName}"` : 'Convert',
      tools: [
        {
          id: 'staged-to-pdf',
          label: 'Convert to PDF',
          icon: <FileText size={18} />,
          onClick: onConvertStagedToPdf,
          description: libreOfficeAvailable ? 'Convert this document to PDF' : 'LibreOffice required',
          disabled: !libreOfficeAvailable,
        },
      ],
    });
    sections.push({
      title: 'More',
      tools: [
        { id: 'batch-to-pdf', label: 'Batch Documents to PDF', icon: <FileType2 size={18} />, onClick: onConvertToPdf, description: 'Convert several documents to PDF at once', disabled: !libreOfficeAvailable },
        { id: 'merge', label: 'Merge PDFs', icon: <Combine size={18} />, onClick: onMergePdfs, description: 'Combine multiple PDFs into one' },
      ],
    });
  } else {
    sections.push({
      title: 'Get Started',
      tools: [
        { id: 'batch-to-pdf', label: 'Documents to PDF', icon: <FileText size={18} />, onClick: onConvertToPdf, description: 'Convert Word, Excel, PowerPoint to PDF', disabled: !libreOfficeAvailable },
        { id: 'merge', label: 'Merge PDFs', icon: <Combine size={18} />, onClick: onMergePdfs, description: 'Combine multiple PDFs into one' },
      ],
    });
  }

  // The LibreOffice notice only matters where a doc→PDF conversion is offered.
  const showLibreOfficeNotice = !libreOfficeAvailable && (docType === 'staged' || docType === 'none');

  return (
    <div className="tools-panel">
      <div className="tools-panel-header">
        <h3>Tools</h3>
        <button className="tools-panel-close" onClick={onToggle} title="Hide Tools Panel">
          <X size={16} />
        </button>
      </div>

      <div className="tools-panel-content">
        {sections.map((section) => (
          <div className="tools-section" key={section.title}>
            <h4>{section.title}</h4>
            {section.tools.map((tool) => (
              <button
                key={tool.id}
                className="tool-btn"
                onClick={tool.onClick}
                disabled={tool.disabled}
                title={tool.description}
              >
                {tool.icon}
                <span>{tool.label}</span>
              </button>
            ))}
          </div>
        ))}

        {showLibreOfficeNotice && (
          <div className="tools-notice">
            <div className="tools-notice-header">
              <AlertCircle size={16} />
              <span>LibreOffice Required</span>
            </div>
            <p>Install LibreOffice to enable document-to-PDF conversion.</p>
            <button
              className="tools-notice-link"
              onClick={() => window.electronAPI.openExternal('https://www.libreoffice.org/download/download/')}
            >
              <ExternalLink size={14} />
              Download LibreOffice
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ToolsPanel;

import React, { useEffect, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import Modal from './Modal';
import { PDFDocument } from '../types';

interface DocumentPropertiesDialogProps {
  isOpen: boolean;
  onClose: () => void;
  document: PDFDocument | null;
}

interface PDFMetadata {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
  creationDate: string;
  modificationDate: string;
  pdfVersion: string;
  pageCount: number;
  fileSize: string;
  pageDimensions: string;
  isEncrypted: boolean;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatPdfDate(dateStr: string): string {
  if (!dateStr) return 'Unknown';
  // PDF date format: D:YYYYMMDDHHmmSS+HH'mm'
  const match = dateStr.match(/D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/);
  if (match) {
    const [, year, month, day, hours = '00', minutes = '00', seconds = '00'] = match;
    const date = new Date(`${year}-${month}-${day}T${hours}:${minutes}:${seconds}`);
    if (!isNaN(date.getTime())) {
      return date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    }
  }
  return dateStr;
}

const DocumentPropertiesDialog: React.FC<DocumentPropertiesDialogProps> = ({
  isOpen,
  onClose,
  document,
}) => {
  const [metadata, setMetadata] = useState<PDFMetadata | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen || !document) {
      setMetadata(null);
      return;
    }

    const extractMetadata = async () => {
      setLoading(true);
      try {
        const dataCopy = new Uint8Array(document.pdfData);
        const pdfDoc = await pdfjsLib.getDocument({ data: dataCopy }).promise;
        const meta = await pdfDoc.getMetadata();

        const info = (meta?.info as Record<string, any>) || {};

        // Get first page dimensions
        const firstPage = await pdfDoc.getPage(1);
        const viewport = firstPage.getViewport({ scale: 1 });
        const widthInches = (viewport.width / 72).toFixed(2);
        const heightInches = (viewport.height / 72).toFixed(2);
        const widthMm = (viewport.width * 0.3528).toFixed(0);
        const heightMm = (viewport.height * 0.3528).toFixed(0);

        setMetadata({
          title: info.Title || document.fileName || 'Untitled',
          author: info.Author || 'Unknown',
          subject: info.Subject || '',
          keywords: info.Keywords || '',
          creator: info.Creator || '',
          producer: info.Producer || '',
          creationDate: formatPdfDate(info.CreationDate || ''),
          modificationDate: formatPdfDate(info.ModDate || ''),
          pdfVersion: info.PDFFormatVersion || 'Unknown',
          pageCount: pdfDoc.numPages,
          fileSize: formatFileSize(document.pdfData.length),
          pageDimensions: `${viewport.width.toFixed(0)} x ${viewport.height.toFixed(0)} pts (${widthInches}" x ${heightInches}" / ${widthMm} x ${heightMm} mm)`,
          isEncrypted: false,
        });
      } catch (error) {
        console.error('Failed to extract metadata:', error);
      } finally {
        setLoading(false);
      }
    };

    extractMetadata();
  }, [isOpen, document]);

  const properties: Array<{ label: string; value: string }> = metadata
    ? [
        { label: 'File Name', value: document?.fileName || '' },
        { label: 'File Path', value: document?.filePath || 'Unsaved' },
        { label: 'File Size', value: metadata.fileSize },
        { label: 'Title', value: metadata.title },
        { label: 'Author', value: metadata.author },
        { label: 'Subject', value: metadata.subject },
        { label: 'Keywords', value: metadata.keywords },
        { label: 'Creator', value: metadata.creator },
        { label: 'Producer', value: metadata.producer },
        { label: 'Created', value: metadata.creationDate },
        { label: 'Modified', value: metadata.modificationDate },
        { label: 'PDF Version', value: metadata.pdfVersion },
        { label: 'Pages', value: String(metadata.pageCount) },
        { label: 'Page Size', value: metadata.pageDimensions },
      ].filter((p) => p.value)
    : [];

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Document Properties" width="480px">
      {loading ? (
        <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)' }}>
          Loading properties...
        </div>
      ) : (
        <div className="doc-properties-grid">
          {properties.map((prop) => (
            <div key={prop.label} className="doc-property-row">
              <span className="doc-property-label">{prop.label}</span>
              <span className="doc-property-value" title={prop.value}>
                {prop.value}
              </span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
};

export default DocumentPropertiesDialog;

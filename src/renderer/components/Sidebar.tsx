import React, { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument } from '../types';

interface SidebarProps {
  visible: boolean;
  document: PDFDocument | null;
  currentPage: number;
  onPageSelect: (page: number) => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  visible,
  document,
  currentPage,
  onPageSelect,
}) => {
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!document) {
      setThumbnails([]);
      return;
    }

    const generateThumbnails = async () => {
      try {
        const dataCopy = new Uint8Array(document.pdfData);
        const pdfDoc = await pdfjsLib.getDocument({ data: dataCopy }).promise;
        const newThumbnails: string[] = [];

        for (let i = 1; i <= pdfDoc.numPages; i++) {
          const page = await pdfDoc.getPage(i);
          const viewport = page.getViewport({ scale: 0.2 });

          const canvas = window.document.createElement('canvas');
          const context = canvas.getContext('2d');
          canvas.width = viewport.width;
          canvas.height = viewport.height;

          await page.render({
            canvasContext: context!,
            viewport,
          }).promise;

          newThumbnails.push(canvas.toDataURL());
        }

        setThumbnails(newThumbnails);
      } catch (error) {
        console.error('Failed to generate thumbnails:', error);
      }
    };

    generateThumbnails();
  }, [document]);

  useEffect(() => {
    if (containerRef.current && currentPage > 0) {
      const thumbnail = containerRef.current.children[currentPage - 1] as HTMLElement;
      if (thumbnail) {
        thumbnail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }, [currentPage]);

  if (!visible) {
    return null;
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">Pages</div>
      <div className="sidebar-content" ref={containerRef}>
        {thumbnails.map((thumbnail, index) => (
          <div
            key={index}
            className={`page-thumbnail ${currentPage === index + 1 ? 'active' : ''}`}
            onClick={() => onPageSelect(index + 1)}
          >
            <img
              src={thumbnail}
              alt={`Page ${index + 1}`}
              style={{
                transform: document?.pages[index]?.rotation
                  ? `rotate(${document.pages[index].rotation}deg)`
                  : undefined,
              }}
            />
            <span className="page-number">{index + 1}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Sidebar;

import React from 'react';
import { Image, FileText, X } from 'lucide-react';

interface ConversionActionBarProps {
  visible: boolean;
  onClose: () => void;
  onConvertToImages: () => void;
  onConvertToDocx: () => void;
}

const ConversionActionBar: React.FC<ConversionActionBarProps> = ({
  visible,
  onClose,
  onConvertToImages,
  onConvertToDocx,
}) => {
  if (!visible) return null;

  return (
    <div className="conversion-action-bar">
      <div className="action-bar-content">
        <span className="action-bar-label">
          <FileText size={16} />
          PDF loaded. Convert to:
        </span>
        <div className="action-bar-buttons">
          <button
            className="action-btn"
            onClick={onConvertToDocx}
            title="Convert PDF to Word document"
          >
            <FileText size={16} />
            Word
          </button>
          <button
            className="action-btn"
            onClick={onConvertToImages}
            title="Convert PDF pages to images"
          >
            <Image size={16} />
            Images
          </button>
        </div>
        <button className="action-bar-close" onClick={onClose} title="Dismiss">
          <X size={14} />
        </button>
      </div>
    </div>
  );
};

export default ConversionActionBar;

import React from 'react';
import { Upload } from 'lucide-react';

interface DropOverlayProps {
  visible: boolean;
}

/**
 * Full-window hint shown while an external file drag is over the app. It is
 * pointer-events:none so the drag keeps targeting the real elements beneath
 * it (the drop itself is handled app-wide by useAppFileDrop).
 */
const DropOverlay: React.FC<DropOverlayProps> = ({ visible }) => {
  if (!visible) return null;
  return (
    <div className="drop-overlay" data-testid="drop-overlay" aria-hidden="true">
      <div className="drop-overlay-card">
        <Upload size={36} className="drop-overlay-icon" />
        <div className="drop-overlay-title">Drop to open</div>
        <div className="drop-overlay-hint">
          PDFs open in new tabs. Word, Excel and PowerPoint files are staged for conversion to PDF.
        </div>
      </div>
    </div>
  );
};

export default DropOverlay;

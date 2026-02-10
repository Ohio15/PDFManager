import React from 'react';
import Modal from './Modal';

interface ShortcutsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

const shortcuts = [
  {
    category: 'File',
    items: [
      { keys: 'Ctrl+O', description: 'Open file' },
      { keys: 'Ctrl+S', description: 'Save' },
      { keys: 'Ctrl+Shift+S', description: 'Save as' },
      { keys: 'Ctrl+W', description: 'Close tab' },
      { keys: 'Ctrl+P', description: 'Print' },
      { keys: 'Ctrl+M', description: 'Merge PDFs' },
    ],
  },
  {
    category: 'Navigation',
    items: [
      { keys: 'Ctrl+Tab', description: 'Next tab' },
      { keys: 'Ctrl+Shift+Tab', description: 'Previous tab' },
      { keys: 'Ctrl+F', description: 'Find in document' },
      { keys: 'Ctrl+1', description: 'Actual size (100%)' },
      { keys: 'Ctrl+0', description: 'Fit width' },
      { keys: 'Ctrl+9', description: 'Fit page' },
      { keys: 'Ctrl+=', description: 'Zoom in' },
      { keys: 'Ctrl+-', description: 'Zoom out' },
    ],
  },
  {
    category: 'Tools',
    items: [
      { keys: 'V', description: 'Select tool' },
      { keys: 'T', description: 'Text tool' },
      { keys: 'H', description: 'Highlight tool' },
      { keys: 'D', description: 'Freehand draw' },
      { keys: 'S', description: 'Shape tool' },
      { keys: 'N', description: 'Sticky note' },
      { keys: 'I', description: 'Add image' },
      { keys: 'E', description: 'Eraser tool' },
    ],
  },
  {
    category: 'Edit',
    items: [
      { keys: 'Ctrl+Z', description: 'Undo' },
      { keys: 'Ctrl+Y', description: 'Redo' },
      { keys: 'Delete', description: 'Delete selection' },
      { keys: 'Escape', description: 'Deselect / cancel' },
    ],
  },
  {
    category: 'View',
    items: [
      { keys: 'Ctrl+B', description: 'Toggle sidebar' },
      { keys: 'Ctrl+T', description: 'Toggle tools panel' },
      { keys: '?', description: 'Show this dialog' },
    ],
  },
];

const ShortcutsDialog: React.FC<ShortcutsDialogProps> = ({ isOpen, onClose }) => {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Keyboard Shortcuts" width="540px">
      <div className="shortcuts-grid">
        {shortcuts.map((group) => (
          <div key={group.category} className="shortcuts-group">
            <h3 className="shortcuts-category">{group.category}</h3>
            {group.items.map((shortcut) => (
              <div key={shortcut.keys} className="shortcut-row">
                <span className="shortcut-description">{shortcut.description}</span>
                <kbd className="shortcut-keys">
                  {shortcut.keys.split('+').map((key, i) => (
                    <React.Fragment key={i}>
                      {i > 0 && <span className="shortcut-separator">+</span>}
                      <span className="shortcut-key">{key}</span>
                    </React.Fragment>
                  ))}
                </kbd>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
};

export default ShortcutsDialog;

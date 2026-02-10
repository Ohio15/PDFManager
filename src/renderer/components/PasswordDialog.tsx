import React, { useState, useEffect, useRef } from 'react';
import Modal from './Modal';
import { Lock } from 'lucide-react';

interface PasswordDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (password: string) => void;
  incorrect?: boolean;
  fileName?: string;
}

const PasswordDialog: React.FC<PasswordDialogProps> = ({
  isOpen,
  onClose,
  onSubmit,
  incorrect = false,
  fileName,
}) => {
  const [password, setPassword] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setPassword('');
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password) {
      onSubmit(password);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Password Required" width="380px">
      <form onSubmit={handleSubmit}>
        <div className="password-dialog-content">
          <div className="password-dialog-icon">
            <Lock size={32} />
          </div>
          <p className="password-dialog-message">
            {fileName ? (
              <>The file <strong>{fileName}</strong> is password protected.</>
            ) : (
              <>This PDF is password protected.</>
            )}
          </p>
          {incorrect && (
            <p className="password-dialog-error">
              Incorrect password. Please try again.
            </p>
          )}
          <input
            ref={inputRef}
            type="password"
            className="password-dialog-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password"
            autoFocus
          />
        </div>
        <div className="password-dialog-actions">
          <button type="button" className="dialog-btn cancel" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="dialog-btn save" disabled={!password}>
            Open
          </button>
        </div>
      </form>
    </Modal>
  );
};

export default PasswordDialog;

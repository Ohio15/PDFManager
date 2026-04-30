import React, { useState, useEffect, useRef } from 'react';
import Modal from './Modal';
import { Lock, Unlock, Eye, EyeOff, AlertTriangle } from 'lucide-react';
import type { PDFDocument, PDFEncryptionPermissions } from '../types';

interface EncryptionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  document: PDFDocument | null;
  onApplyAdd: (userPassword: string, ownerPassword: string | undefined, permissions: PDFEncryptionPermissions) => void;
  onApplyChange: (userPassword: string, ownerPassword: string | undefined, permissions: PDFEncryptionPermissions) => void;
  onApplyRemove: () => void;
}

type Mode = 'add' | 'change' | 'remove';

const DEFAULT_PERMISSIONS: PDFEncryptionPermissions = {
  print: true,
  modify: true,
  copy: true,
  annotate: true,
};

const MIN_PASSWORD_LENGTH = 3;

function classifyStrength(pw: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  if (pw.length === 0) return { score: 0, label: '' };
  let score = 0;
  if (pw.length >= 8) score += 1;
  if (pw.length >= 12) score += 1;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score += 1;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score += 1;
  const labels = ['weak', 'weak', 'fair', 'good', 'strong'] as const;
  const clamped = Math.min(4, score) as 0 | 1 | 2 | 3 | 4;
  return { score: clamped, label: labels[clamped] };
}

const EncryptionDialog: React.FC<EncryptionDialogProps> = ({
  isOpen, onClose, document: doc, onApplyAdd, onApplyChange, onApplyRemove,
}) => {
  const isEncrypted = !!doc?.encryptionMeta;
  const [mode, setMode] = useState<Mode>(isEncrypted ? 'change' : 'add');

  const [userPassword, setUserPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [revealPassword, setRevealPassword] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [ownerPassword, setOwnerPassword] = useState('');
  const [permissions, setPermissions] = useState<PDFEncryptionPermissions>(
    doc?.encryptionMeta?.permissions ?? DEFAULT_PERMISSIONS
  );
  const [removeConfirmed, setRemoveConfirmed] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setMode(isEncrypted ? 'change' : 'add');
      setUserPassword('');
      setConfirmPassword('');
      setOwnerPassword('');
      setRevealPassword(false);
      setShowAdvanced(false);
      setRemoveConfirmed(false);
      setSubmitError(null);
      setPermissions(doc?.encryptionMeta?.permissions ?? DEFAULT_PERMISSIONS);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen, isEncrypted, doc?.encryptionMeta?.permissions]);

  if (!isOpen) return null;

  const passwordsMatch = userPassword.length > 0 && userPassword === confirmPassword;
  const passwordTooShort = userPassword.length > 0 && userPassword.length < MIN_PASSWORD_LENGTH;
  const strength = classifyStrength(userPassword);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);

    if (mode === 'remove') {
      if (!removeConfirmed) {
        setRemoveConfirmed(true);
        return;
      }
      onApplyRemove();
      onClose();
      return;
    }

    if (passwordTooShort) {
      setSubmitError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (!passwordsMatch) {
      setSubmitError('Passwords do not match.');
      return;
    }
    const ownerPw = showAdvanced && ownerPassword ? ownerPassword : undefined;
    if (mode === 'add') {
      onApplyAdd(userPassword, ownerPw, permissions);
    } else {
      onApplyChange(userPassword, ownerPw, permissions);
    }
    onClose();
  };

  const togglePermission = (key: keyof PDFEncryptionPermissions) => {
    setPermissions((p) => ({ ...p, [key]: !p[key] }));
  };

  const title = mode === 'remove'
    ? 'Remove Password'
    : mode === 'change'
      ? 'Change Password'
      : 'Add Password';

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} width="440px">
      <form onSubmit={handleSubmit}>
        <div className="encryption-dialog-content">
          <div className="encryption-dialog-icon">
            {isEncrypted ? <Lock size={32} /> : <Unlock size={32} />}
          </div>

          {isEncrypted && (
            <div className="encryption-dialog-mode-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'change'}
                className={`mode-tab ${mode === 'change' ? 'active' : ''}`}
                onClick={() => { setMode('change'); setRemoveConfirmed(false); setSubmitError(null); }}
              >
                Change Password
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'remove'}
                className={`mode-tab ${mode === 'remove' ? 'active' : ''}`}
                onClick={() => { setMode('remove'); setRemoveConfirmed(false); setSubmitError(null); }}
              >
                Remove Password
              </button>
            </div>
          )}

          {mode !== 'remove' && (
            <>
              <p className="encryption-dialog-message">
                {mode === 'add'
                  ? 'This PDF has no password. Add one to require a password to open it.'
                  : 'Set a new password. The existing password will be replaced on save.'}
              </p>

              <label className="encryption-dialog-label" htmlFor="enc-pw">
                {mode === 'add' ? 'Password' : 'New password'}
              </label>
              <div className="encryption-dialog-input-wrap">
                <input
                  ref={inputRef}
                  id="enc-pw"
                  type={revealPassword ? 'text' : 'password'}
                  className="encryption-dialog-input"
                  value={userPassword}
                  onChange={(e) => setUserPassword(e.target.value)}
                  placeholder="Enter password"
                  aria-describedby="enc-pw-strength"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  className="encryption-dialog-reveal"
                  onClick={() => setRevealPassword((v) => !v)}
                  aria-label={revealPassword ? 'Hide password' : 'Show password'}
                  tabIndex={-1}
                >
                  {revealPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {userPassword.length > 0 && (
                <div className="encryption-dialog-strength" id="enc-pw-strength" data-score={strength.score}>
                  <div className="encryption-dialog-strength-bar"><span style={{ width: `${(strength.score / 4) * 100}%` }} /></div>
                  <span className="encryption-dialog-strength-label">{strength.label}</span>
                </div>
              )}
              {passwordTooShort && (
                <p className="encryption-dialog-hint warn">At least {MIN_PASSWORD_LENGTH} characters.</p>
              )}

              <label className="encryption-dialog-label" htmlFor="enc-pw-confirm">Confirm password</label>
              <div className="encryption-dialog-input-wrap">
                <input
                  id="enc-pw-confirm"
                  type={revealPassword ? 'text' : 'password'}
                  className="encryption-dialog-input"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter password"
                  autoComplete="new-password"
                />
                {confirmPassword.length > 0 && (
                  <span className={`encryption-dialog-match ${passwordsMatch ? 'ok' : 'no'}`} aria-live="polite">
                    {passwordsMatch ? '✓' : '✗'}
                  </span>
                )}
              </div>

              <button
                type="button"
                className="encryption-dialog-disclosure"
                onClick={() => setShowAdvanced((v) => !v)}
                aria-expanded={showAdvanced}
              >
                {showAdvanced ? '▾ Advanced options' : '▸ Advanced options'}
              </button>

              {showAdvanced && (
                <div className="encryption-dialog-advanced">
                  <label className="encryption-dialog-label" htmlFor="enc-owner-pw">
                    Owner password (optional)
                  </label>
                  <p className="encryption-dialog-hint">
                    A separate password to override the permissions below. Leave blank to use the same as above.
                  </p>
                  <input
                    id="enc-owner-pw"
                    type={revealPassword ? 'text' : 'password'}
                    className="encryption-dialog-input"
                    value={ownerPassword}
                    onChange={(e) => setOwnerPassword(e.target.value)}
                    placeholder="(optional)"
                    autoComplete="new-password"
                  />

                  <fieldset className="encryption-dialog-permissions">
                    <legend>Permissions</legend>
                    <label><input type="checkbox" checked={permissions.print} onChange={() => togglePermission('print')} /> Allow printing</label>
                    <label><input type="checkbox" checked={permissions.modify} onChange={() => togglePermission('modify')} /> Allow content modification</label>
                    <label><input type="checkbox" checked={permissions.copy} onChange={() => togglePermission('copy')} /> Allow copying text/images</label>
                    <label><input type="checkbox" checked={permissions.annotate} onChange={() => togglePermission('annotate')} /> Allow adding annotations</label>
                  </fieldset>
                </div>
              )}
            </>
          )}

          {mode === 'remove' && (
            <div className="encryption-dialog-remove">
              <AlertTriangle size={20} className="encryption-dialog-warn-icon" aria-hidden />
              <p className="encryption-dialog-message">
                {removeConfirmed
                  ? 'Confirm: removing the password will save this PDF without protection. Anyone with the file will be able to open and edit it.'
                  : 'This will remove the password and save this PDF without protection on next save.'}
              </p>
            </div>
          )}

          {submitError && (
            <p className="encryption-dialog-error" role="alert">{submitError}</p>
          )}
        </div>

        <div className="encryption-dialog-actions">
          <button type="button" className="dialog-btn cancel" onClick={onClose}>Cancel</button>
          <button
            type="submit"
            className={`dialog-btn ${mode === 'remove' ? 'destructive' : 'save'}`}
            disabled={
              mode !== 'remove'
                ? (!userPassword || !passwordsMatch || passwordTooShort)
                : false
            }
          >
            {mode === 'remove'
              ? (removeConfirmed ? 'Confirm Remove' : 'Remove Password')
              : (mode === 'change' ? 'Change Password' : 'Set Password')}
          </button>
        </div>
      </form>
    </Modal>
  );
};

export default EncryptionDialog;

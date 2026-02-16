import React, { useState, useEffect } from 'react';
import Modal from './Modal';
import { Sun, Moon, Monitor, FolderOpen } from 'lucide-react';

export type Theme = 'light' | 'dark' | 'system';

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

const SettingsDialog: React.FC<SettingsDialogProps> = ({ isOpen, onClose }) => {
  const [theme, setTheme] = useState<Theme>('system');
  const [defaultZoom, setDefaultZoom] = useState(100);
  const [openFolderAfterConversion, setOpenFolderAfterConversion] = useState(true);

  // Load settings on mount
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const savedTheme = await window.electronAPI.getStore('theme') as Theme;
        if (savedTheme) setTheme(savedTheme);

        const savedZoom = await window.electronAPI.getStore('defaultZoom') as number;
        if (savedZoom) setDefaultZoom(savedZoom);

        const savedOpenFolder = await window.electronAPI.getStore('openFolderAfterConversion') as boolean;
        if (typeof savedOpenFolder === 'boolean') setOpenFolderAfterConversion(savedOpenFolder);
      } catch (e) {
        console.error('Failed to load settings:', e);
      }
    };

    if (isOpen) {
      loadSettings();
    }
  }, [isOpen]);

  // Apply theme to document
  useEffect(() => {
    const applyTheme = (selectedTheme: Theme) => {
      const root = document.documentElement;

      if (selectedTheme === 'system') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        root.classList.toggle('dark', prefersDark);
      } else {
        root.classList.toggle('dark', selectedTheme === 'dark');
      }
    };

    applyTheme(theme);

    // Listen for system theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      if (theme === 'system') {
        applyTheme('system');
      }
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme]);

  const handleThemeChange = async (newTheme: Theme) => {
    setTheme(newTheme);
    await window.electronAPI.setStore('theme', newTheme);
  };

  const handleDefaultZoomChange = async (value: number) => {
    setDefaultZoom(value);
    await window.electronAPI.setStore('defaultZoom', value);
  };

  const handleOpenFolderChange = async (value: boolean) => {
    setOpenFolderAfterConversion(value);
    await window.electronAPI.setStore('openFolderAfterConversion', value);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Settings" width="480px">
      <div className="settings-dialog">
        {/* Appearance Section */}
        <div className="settings-section">
          <h3 className="settings-section-title">Appearance</h3>

          <div className="settings-item">
            <label className="settings-label">Theme</label>
            <div className="theme-options">
              <button
                className={`theme-option ${theme === 'light' ? 'active' : ''}`}
                onClick={() => handleThemeChange('light')}
              >
                <Sun size={20} />
                <span>Light</span>
              </button>
              <button
                className={`theme-option ${theme === 'dark' ? 'active' : ''}`}
                onClick={() => handleThemeChange('dark')}
              >
                <Moon size={20} />
                <span>Dark</span>
              </button>
              <button
                className={`theme-option ${theme === 'system' ? 'active' : ''}`}
                onClick={() => handleThemeChange('system')}
              >
                <Monitor size={20} />
                <span>System</span>
              </button>
            </div>
          </div>

          <div className="settings-item">
            <label className="settings-label">Default Zoom Level</label>
            <div className="zoom-control">
              <input
                type="range"
                min="25"
                max="200"
                step="25"
                value={defaultZoom}
                onChange={(e) => handleDefaultZoomChange(Number(e.target.value))}
                className="zoom-slider"
              />
              <span className="zoom-value">{defaultZoom}%</span>
            </div>
          </div>
        </div>

        {/* Behavior Section */}
        <div className="settings-section">
          <h3 className="settings-section-title">Behavior</h3>

          <div className="settings-item">
            <label className="settings-checkbox">
              <input
                type="checkbox"
                checked={openFolderAfterConversion}
                onChange={(e) => handleOpenFolderChange(e.target.checked)}
              />
              <span className="checkbox-mark"></span>
              <span className="checkbox-label">
                <FolderOpen size={16} />
                Open folder after conversion/export
              </span>
            </label>
            <p className="settings-help">
              Automatically open the output folder when operations complete
            </p>
          </div>
        </div>

        <div className="settings-footer">
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default SettingsDialog;

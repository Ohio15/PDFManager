import React, { useCallback } from 'react';
import { X, Plus, FileText } from 'lucide-react';
import { TabInfo } from '../types';

interface TabBarProps {
  tabs: TabInfo[];
  activeTabId: string | null;
  onTabSelect: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onNewTab: () => void;
}

const TabBar: React.FC<TabBarProps> = ({ tabs, activeTabId, onTabSelect, onTabClose, onNewTab }) => {
  if (tabs.length === 0) return null;

  const handleTabMouseDown = useCallback((e: React.MouseEvent, tabId: string) => {
    // Middle-click to close
    if (e.button === 1) {
      e.preventDefault();
      onTabClose(tabId);
    }
  }, [onTabClose]);

  const handleCloseClick = useCallback((e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    onTabClose(tabId);
  }, [onTabClose]);

  return (
    <div className="tab-bar">
      <div className="tab-bar-tabs">
        {tabs.map(tab => (
          <div
            key={tab.id}
            className={`tab-bar-tab ${tab.id === activeTabId ? 'active' : ''}`}
            onClick={() => onTabSelect(tab.id)}
            onMouseDown={(e) => handleTabMouseDown(e, tab.id)}
            title={tab.filePath || tab.fileName}
          >
            <FileText size={13} className="tab-icon" />
            <span className="tab-name">{tab.fileName}</span>
            {tab.modified && <span className="tab-modified-dot" />}
            <button
              className="tab-close-btn"
              onClick={(e) => handleCloseClick(e, tab.id)}
              title="Close tab"
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      <button className="tab-bar-new-btn" onClick={onNewTab} title="Open file (Ctrl+O)">
        <Plus size={14} />
      </button>
    </div>
  );
};

export default TabBar;

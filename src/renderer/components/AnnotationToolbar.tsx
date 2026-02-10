import React, { useState } from 'react';
import { Tool } from '../App';
import { AnnotationStyle } from '../types';
import {
  Minus,
  Plus,
  Square,
  Circle,
  ArrowRight,
  Slash,
  CheckCircle,
  XCircle,
  FileText,
  Lock,
  Flag,
  Edit3,
} from 'lucide-react';

interface AnnotationToolbarProps {
  currentTool: Tool;
  style: AnnotationStyle;
  onStyleChange: (updates: Partial<AnnotationStyle>) => void;
}

const COLOR_PRESETS = [
  '#000000', '#FF0000', '#FF6600', '#FFD700',
  '#00CC00', '#0066FF', '#9933FF', '#FF69B4',
  '#FFFFFF', '#CC0000', '#FF9900', '#FFFF00',
  '#009900', '#0099CC', '#6600CC', '#808080',
];

const HIGHLIGHT_COLORS = [
  'rgba(255, 255, 0, 0.3)',
  'rgba(0, 255, 0, 0.3)',
  'rgba(0, 200, 255, 0.3)',
  'rgba(255, 150, 200, 0.3)',
  'rgba(255, 165, 0, 0.3)',
  'rgba(200, 150, 255, 0.3)',
  'rgba(255, 100, 100, 0.3)',
  'rgba(150, 255, 200, 0.3)',
];

const NOTE_COLORS = [
  '#FFF9C4', '#FFECB3', '#FFE0B2', '#FFCDD2',
  '#F8BBD0', '#E1BEE7', '#C5CAE9', '#B3E5FC',
  '#B2DFDB', '#C8E6C9', '#DCEDC8', '#F0F4C3',
];

const STAMP_TYPES: Array<{ type: AnnotationStyle['stampType']; label: string; color: string }> = [
  { type: 'approved', label: 'APPROVED', color: '#22C55E' },
  { type: 'rejected', label: 'REJECTED', color: '#EF4444' },
  { type: 'draft', label: 'DRAFT', color: '#F59E0B' },
  { type: 'confidential', label: 'CONFIDENTIAL', color: '#8B5CF6' },
  { type: 'final', label: 'FINAL', color: '#3B82F6' },
  { type: 'custom', label: 'Custom...', color: '#6B7280' },
];

const STAMP_ICONS: Record<string, React.ReactNode> = {
  approved: <CheckCircle size={13} />,
  rejected: <XCircle size={13} />,
  draft: <FileText size={13} />,
  confidential: <Lock size={13} />,
  final: <Flag size={13} />,
  custom: <Edit3 size={13} />,
};

const SHAPE_TYPES: Array<{ type: AnnotationStyle['shapeType']; icon: React.ReactNode; label: string }> = [
  { type: 'rectangle', icon: <Square size={14} />, label: 'Rectangle' },
  { type: 'ellipse', icon: <Circle size={14} />, label: 'Ellipse' },
  { type: 'arrow', icon: <ArrowRight size={14} />, label: 'Arrow' },
  { type: 'line', icon: <Slash size={14} />, label: 'Line' },
];

const AnnotationToolbar: React.FC<AnnotationToolbarProps> = ({
  currentTool,
  style,
  onStyleChange,
}) => {
  const [customStampText, setCustomStampText] = useState(style.stampText || 'CUSTOM');

  const showToolbar = ['text', 'highlight', 'draw', 'shape', 'note', 'stamp'].includes(currentTool);
  if (!showToolbar) return null;

  const renderColorPresets = (
    colors: string[],
    selectedColor: string,
    onChange: (color: string) => void,
    label: string
  ) => (
    <div className="annotation-toolbar-section">
      <span className="annotation-toolbar-label">{label}</span>
      <div className="color-presets">
        {colors.map((color) => (
          <button
            key={color}
            className={`color-preset ${selectedColor === color ? 'active' : ''}`}
            style={{ backgroundColor: color }}
            onClick={() => onChange(color)}
            title={color}
          />
        ))}
        <input
          type="color"
          className="color-custom-input"
          value={selectedColor.startsWith('#') ? selectedColor : '#000000'}
          onChange={(e) => onChange(e.target.value)}
          title="Custom color"
        />
      </div>
    </div>
  );

  const renderStrokeWidth = () => (
    <div className="annotation-toolbar-section">
      <span className="annotation-toolbar-label">Width</span>
      <div className="stroke-width-control">
        <button
          className="annotation-toolbar-btn"
          onClick={() => onStyleChange({ strokeWidth: Math.max(1, style.strokeWidth - 1) })}
          title="Decrease width"
        >
          <Minus size={12} />
        </button>
        <span className="stroke-width-value">{style.strokeWidth}px</span>
        <button
          className="annotation-toolbar-btn"
          onClick={() => onStyleChange({ strokeWidth: Math.min(20, style.strokeWidth + 1) })}
          title="Increase width"
        >
          <Plus size={12} />
        </button>
      </div>
    </div>
  );

  const renderFontSize = () => (
    <div className="annotation-toolbar-section">
      <span className="annotation-toolbar-label">Size</span>
      <div className="stroke-width-control">
        <button
          className="annotation-toolbar-btn"
          onClick={() => onStyleChange({ fontSize: Math.max(8, style.fontSize - 2) })}
          title="Decrease font size"
        >
          <Minus size={12} />
        </button>
        <span className="stroke-width-value">{style.fontSize}pt</span>
        <button
          className="annotation-toolbar-btn"
          onClick={() => onStyleChange({ fontSize: Math.min(72, style.fontSize + 2) })}
          title="Increase font size"
        >
          <Plus size={12} />
        </button>
      </div>
    </div>
  );

  return (
    <div className="annotation-toolbar">
      {/* Text tool */}
      {currentTool === 'text' && (
        <>
          {renderColorPresets(COLOR_PRESETS, style.color, (c) => onStyleChange({ color: c }), 'Color')}
          {renderFontSize()}
        </>
      )}

      {/* Highlight tool */}
      {currentTool === 'highlight' && (
        <>
          {renderColorPresets(HIGHLIGHT_COLORS, style.color, (c) => onStyleChange({ color: c }), 'Color')}
        </>
      )}

      {/* Drawing tool */}
      {currentTool === 'draw' && (
        <>
          {renderColorPresets(COLOR_PRESETS, style.strokeColor, (c) => onStyleChange({ strokeColor: c }), 'Color')}
          {renderStrokeWidth()}
        </>
      )}

      {/* Shape tool */}
      {currentTool === 'shape' && (
        <>
          <div className="annotation-toolbar-section">
            <span className="annotation-toolbar-label">Shape</span>
            <div className="shape-type-selector">
              {SHAPE_TYPES.map((shape) => (
                <button
                  key={shape.type}
                  className={`annotation-toolbar-btn ${style.shapeType === shape.type ? 'active' : ''}`}
                  onClick={() => onStyleChange({ shapeType: shape.type })}
                  title={shape.label}
                >
                  {shape.icon}
                </button>
              ))}
            </div>
          </div>
          {renderColorPresets(COLOR_PRESETS, style.strokeColor, (c) => onStyleChange({ strokeColor: c }), 'Stroke')}
          <div className="annotation-toolbar-section">
            <span className="annotation-toolbar-label">Fill</span>
            <div className="color-presets">
              <button
                className={`color-preset no-fill ${style.fillColor === 'transparent' ? 'active' : ''}`}
                onClick={() => onStyleChange({ fillColor: 'transparent' })}
                title="No fill"
              />
              {COLOR_PRESETS.slice(0, 8).map((color) => (
                <button
                  key={`fill-${color}`}
                  className={`color-preset ${style.fillColor === color ? 'active' : ''}`}
                  style={{ backgroundColor: color, opacity: 0.3 }}
                  onClick={() => onStyleChange({ fillColor: color })}
                  title={color}
                />
              ))}
            </div>
          </div>
          {renderStrokeWidth()}
        </>
      )}

      {/* Sticky note tool */}
      {currentTool === 'note' && (
        <>
          {renderColorPresets(NOTE_COLORS, style.noteColor, (c) => onStyleChange({ noteColor: c }), 'Color')}
        </>
      )}

      {/* Stamp tool */}
      {currentTool === 'stamp' && (
        <>
          <div className="annotation-toolbar-section">
            <span className="annotation-toolbar-label">Stamp</span>
            <div className="stamp-type-selector">
              {STAMP_TYPES.map((stamp) => (
                <button
                  key={stamp.type}
                  className={`stamp-type-btn ${style.stampType === stamp.type ? 'active' : ''}`}
                  style={{
                    borderColor: stamp.color,
                    color: style.stampType === stamp.type ? '#fff' : stamp.color,
                    backgroundColor: style.stampType === stamp.type ? stamp.color : 'transparent',
                  }}
                  onClick={() => {
                    onStyleChange({
                      stampType: stamp.type,
                      stampText: stamp.type === 'custom' ? customStampText : stamp.label,
                      color: stamp.color,
                    });
                  }}
                  title={stamp.label}
                >
                  {STAMP_ICONS[stamp.type]}
                  <span>{stamp.label}</span>
                </button>
              ))}
            </div>
          </div>
          {style.stampType === 'custom' && (
            <div className="annotation-toolbar-section">
              <span className="annotation-toolbar-label">Text</span>
              <input
                type="text"
                className="stamp-custom-input"
                value={customStampText}
                onChange={(e) => {
                  const text = e.target.value.toUpperCase();
                  setCustomStampText(text);
                  onStyleChange({ stampText: text });
                }}
                placeholder="CUSTOM TEXT"
                maxLength={30}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default AnnotationToolbar;

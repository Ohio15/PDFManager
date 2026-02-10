import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronRight, ChevronLeft, X } from 'lucide-react';

interface TourStep {
  target: string; // CSS selector
  title: string;
  description: string;
  position: 'top' | 'bottom' | 'left' | 'right';
}

const tourSteps: TourStep[] = [
  {
    target: '.toolbar',
    title: 'Main Toolbar',
    description: 'Access all your tools here — open files, annotate, zoom, rotate pages, and more. Hover any button to see its keyboard shortcut.',
    position: 'bottom',
  },
  {
    target: '.toolbar-group:nth-child(3)',
    title: 'Annotation Tools',
    description: 'Select from text, highlight, draw, shapes, sticky notes, stamps, and more. Press the letter key shown in the tooltip for quick switching.',
    position: 'bottom',
  },
  {
    target: '.sidebar-container',
    title: 'Page Sidebar',
    description: 'Browse page thumbnails, reorder pages with drag & drop, and manage annotations. Toggle with Ctrl+B.',
    position: 'right',
  },
  {
    target: '.tools-panel',
    title: 'Tools Panel',
    description: 'Advanced operations: merge, split, extract pages, convert formats, and rotate all pages. Toggle with Ctrl+T.',
    position: 'left',
  },
  {
    target: '.status-bar',
    title: 'Status Bar',
    description: 'See your current page, total pages, zoom level, and document status at a glance.',
    position: 'top',
  },
  {
    target: '.tab-bar',
    title: 'Document Tabs',
    description: 'Open multiple PDFs at once and switch between them. Middle-click a tab to close it, or press Ctrl+W.',
    position: 'bottom',
  },
];

interface OnboardingTourProps {
  active: boolean;
  onComplete: () => void;
}

const OnboardingTour: React.FC<OnboardingTourProps> = ({ active, onComplete }) => {
  const [step, setStep] = useState(0);
  const [spotlight, setSpotlight] = useState<DOMRect | null>(null);
  const [visible, setVisible] = useState(false);
  const rafRef = useRef(0);

  const updateSpotlight = useCallback(() => {
    const currentStep = tourSteps[step];
    if (!currentStep) return;

    const el = document.querySelector(currentStep.target);
    if (el) {
      const rect = el.getBoundingClientRect();
      setSpotlight(rect);
      setVisible(true);
    } else {
      // Skip steps whose target doesn't exist (e.g., tab bar when no tabs)
      if (step < tourSteps.length - 1) {
        setStep(prev => prev + 1);
      } else {
        onComplete();
      }
    }
  }, [step, onComplete]);

  useEffect(() => {
    if (!active) return;
    // Small delay for DOM to settle
    const timer = setTimeout(updateSpotlight, 150);
    return () => clearTimeout(timer);
  }, [active, step, updateSpotlight]);

  // Update spotlight on window resize
  useEffect(() => {
    if (!active) return;
    const handleResize = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(updateSpotlight);
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(rafRef.current);
    };
  }, [active, updateSpotlight]);

  const handleNext = useCallback(() => {
    if (step < tourSteps.length - 1) {
      setVisible(false);
      setTimeout(() => setStep(prev => prev + 1), 100);
    } else {
      onComplete();
    }
  }, [step, onComplete]);

  const handlePrev = useCallback(() => {
    if (step > 0) {
      setVisible(false);
      setTimeout(() => setStep(prev => prev - 1), 100);
    }
  }, [step]);

  const handleSkip = useCallback(() => {
    onComplete();
  }, [onComplete]);

  // Keyboard navigation
  useEffect(() => {
    if (!active) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleSkip();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') handleNext();
      else if (e.key === 'ArrowLeft') handlePrev();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [active, handleSkip, handleNext, handlePrev]);

  if (!active || !spotlight) return null;

  const currentStep = tourSteps[step];
  const padding = 8;

  // Calculate popover position
  const getPopoverStyle = (): React.CSSProperties => {
    const style: React.CSSProperties = { position: 'fixed' };
    const popoverWidth = 340;
    const popoverGap = 16;

    switch (currentStep.position) {
      case 'bottom':
        style.top = spotlight.bottom + popoverGap;
        style.left = Math.max(12, Math.min(
          spotlight.left + spotlight.width / 2 - popoverWidth / 2,
          window.innerWidth - popoverWidth - 12
        ));
        break;
      case 'top':
        style.bottom = window.innerHeight - spotlight.top + popoverGap;
        style.left = Math.max(12, Math.min(
          spotlight.left + spotlight.width / 2 - popoverWidth / 2,
          window.innerWidth - popoverWidth - 12
        ));
        break;
      case 'right':
        style.top = Math.max(12, spotlight.top + spotlight.height / 2 - 60);
        style.left = spotlight.right + popoverGap;
        break;
      case 'left':
        style.top = Math.max(12, spotlight.top + spotlight.height / 2 - 60);
        style.right = window.innerWidth - spotlight.left + popoverGap;
        break;
    }
    return style;
  };

  return (
    <div className="onboarding-overlay">
      {/* Dark overlay with spotlight cutout via clip-path */}
      <svg
        className="onboarding-backdrop"
        width="100%"
        height="100%"
        style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
      >
        <defs>
          <mask id="spotlight-mask">
            <rect width="100%" height="100%" fill="white" />
            <rect
              x={spotlight.left - padding}
              y={spotlight.top - padding}
              width={spotlight.width + padding * 2}
              height={spotlight.height + padding * 2}
              rx="8"
              fill="black"
            />
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="rgba(0,0,0,0.55)"
          mask="url(#spotlight-mask)"
        />
        {/* Spotlight border highlight */}
        <rect
          x={spotlight.left - padding}
          y={spotlight.top - padding}
          width={spotlight.width + padding * 2}
          height={spotlight.height + padding * 2}
          rx="8"
          fill="none"
          stroke="var(--primary-color)"
          strokeWidth="2"
          className={visible ? 'onboarding-spotlight-ring' : ''}
        />
      </svg>

      {/* Popover card */}
      <div
        className={`onboarding-popover ${visible ? 'onboarding-popover-visible' : ''}`}
        style={getPopoverStyle()}
      >
        <div className="onboarding-popover-header">
          <span className="onboarding-step-badge">
            {step + 1} / {tourSteps.length}
          </span>
          <button className="onboarding-skip-btn" onClick={handleSkip} aria-label="Skip tour">
            <X size={16} />
          </button>
        </div>

        <h3 className="onboarding-popover-title">{currentStep.title}</h3>
        <p className="onboarding-popover-desc">{currentStep.description}</p>

        <div className="onboarding-popover-actions">
          {step > 0 && (
            <button className="onboarding-btn onboarding-btn-secondary" onClick={handlePrev}>
              <ChevronLeft size={14} /> Back
            </button>
          )}
          <button className="onboarding-btn onboarding-btn-primary" onClick={handleNext}>
            {step < tourSteps.length - 1 ? (
              <>Next <ChevronRight size={14} /></>
            ) : (
              'Get Started'
            )}
          </button>
        </div>

        {/* Progress dots */}
        <div className="onboarding-dots">
          {tourSteps.map((_, i) => (
            <span
              key={i}
              className={`onboarding-dot ${i === step ? 'active' : ''} ${i < step ? 'completed' : ''}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

export default OnboardingTour;

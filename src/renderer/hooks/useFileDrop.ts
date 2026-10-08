import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import type { DropResult } from '../../shared/ipc';

/**
 * External (OS) file drags carry the 'Files' type; in-app drags such as the
 * sidebar's thumbnail reorder carry only 'text/plain' and must be left alone.
 */
export function isExternalFileDrag(dataTransfer: DataTransfer | null | undefined): boolean {
  return !!dataTransfer && Array.from(dataTransfer.types).includes('Files');
}

/**
 * Native drop events already claimed by a nested handler that must NOT stop
 * propagation (the app-wide target still needs the event to reset its overlay
 * depth). The app-wide handler skips the claim step for these.
 */
const claimedDrops = new WeakSet<Event>();

/**
 * Claim an external file drop inside a nested target (e.g. the sidebar
 * thumbnails) while letting the event bubble so the app-wide overlay resets.
 * Must be called synchronously from the drop handler.
 */
export function claimExternalDrop(e: React.DragEvent): Promise<DropResult> {
  e.preventDefault();
  claimedDrops.add(e.nativeEvent);
  return window.electronAPI.takeDroppedFiles();
}

/** True while any modal dialog is open; the app-wide drop target stands down. */
function isModalOpen(): boolean {
  return window.document.querySelector('.modal-overlay') !== null;
}

/**
 * Called with the drop's claim (resolved by main with the blessed files) and
 * the number of items the user dropped.
 */
export type FileDropHandler = (claim: Promise<DropResult>, droppedCount: number) => void;

/**
 * App-wide external-file drop target. Listens on window so a drop anywhere —
 * welcome screen, viewer, tab bar, sidebar — is handled. Returns whether an
 * external drag is currently over the window (for the overlay).
 *
 * Flicker: dragenter/dragleave fire for every element boundary the cursor
 * crosses, so visibility is a depth count (enter +1, leave -1), not the last
 * event seen.
 */
export function useAppFileDrop(onDrop: FileDropHandler): boolean {
  const [active, setActive] = useState(false);
  const depthRef = useRef(0);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  useEffect(() => {
    const reset = () => {
      depthRef.current = 0;
      setActive(false);
    };

    const handleDragEnter = (e: DragEvent) => {
      if (!isExternalFileDrag(e.dataTransfer)) return;
      depthRef.current += 1;
      if (!isModalOpen()) setActive(true);
    };

    const handleDragLeave = (e: DragEvent) => {
      if (!isExternalFileDrag(e.dataTransfer)) return;
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) setActive(false);
    };

    const handleDragOver = (e: DragEvent) => {
      if (!isExternalFileDrag(e.dataTransfer)) return;
      // Always cancel for file drags: an unhandled file drop would otherwise
      // ask Chromium to navigate to the file. With a modal open the app-wide
      // target refuses the drop (dropEffect 'none' suppresses the drop event);
      // a dialog's own drop zone stops propagation before this runs.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = isModalOpen() ? 'none' : 'copy';
    };

    const handleDrop = (e: DragEvent) => {
      if (!isExternalFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      reset();
      if (claimedDrops.has(e) || isModalOpen()) return;
      // Claim synchronously: the preload's record lives only for this dispatch.
      const claim = window.electronAPI.takeDroppedFiles();
      onDropRef.current(claim, e.dataTransfer?.files.length ?? 0);
    };

    window.addEventListener('dragenter', handleDragEnter);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('drop', handleDrop);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('dragenter', handleDragEnter);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('drop', handleDrop);
      window.removeEventListener('blur', reset);
    };
  }, []);

  return active;
}

export interface DropZoneBindings {
  onDragEnter: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}

/**
 * A local drop zone (e.g. inside a dialog). It stops propagation of external
 * file drags so the app-wide target does not also handle them, and uses the
 * same depth count for its hover state.
 */
export function useDropZone(
  onDrop: FileDropHandler,
  disabled = false
): { isOver: boolean; bindings: DropZoneBindings } {
  const [isOver, setIsOver] = useState(false);
  const depthRef = useRef(0);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!isExternalFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    depthRef.current += 1;
    if (!disabled) setIsOver(true);
  }, [disabled]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!isExternalFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
  }, [disabled]);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!isExternalFileDrag(e.dataTransfer)) return;
    e.stopPropagation();
    depthRef.current = Math.max(0, depthRef.current - 1);
    if (depthRef.current === 0) setIsOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!isExternalFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    depthRef.current = 0;
    setIsOver(false);
    if (disabled) return;
    // Claim synchronously: the preload's record lives only for this dispatch.
    const claim = window.electronAPI.takeDroppedFiles();
    onDrop(claim, e.dataTransfer.files.length);
  }, [disabled, onDrop]);

  return { isOver, bindings: { onDragEnter, onDragOver, onDragLeave, onDrop: handleDrop } };
}

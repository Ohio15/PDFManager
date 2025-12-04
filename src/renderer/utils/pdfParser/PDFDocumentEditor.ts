/**
 * PDFDocumentEditor - High-level PDF editing integration layer
 *
 * This module bridges the low-level PDF parsing/building infrastructure
 * with the existing PDFEditor application. It provides a unified API for:
 * - Loading and parsing PDF documents
 * - Editing text, images, and annotations
 * - Managing fonts and form fields
 * - Saving changes back to PDF format
 */

import type {
  PageStructure,
  DocumentStructure,
  TextRun,
  Word,
  TextLine,
  Paragraph,
  BoundingBox,
  Color,
  TextMatrix,
  PDFOperator,
  FontInfo,
  FormField,
  EditOperation,
  ContentElement
} from './types';

import {
  ContentStreamLexer,
  ContentStreamParser,
  ContentStreamInterpreter
} from './ContentStreamParser';

import {
  ContentStreamBuilder,
  TextEditCompiler,
  ContentStreamMerger
} from './ContentStreamBuilder';

import { LayoutAnalyzer, ReadingOrderDetector } from './LayoutAnalyzer';
import { FontManager, TrueTypeFontParser } from './FontManager';
import { FormFieldManager } from './FormFieldManager';

// Edit types
export interface TextEdit {
  type: 'replace' | 'insert' | 'delete' | 'style';
  runId: string;
  pageIndex: number;
  newText?: string;
  insertPosition?: { x: number; y: number };
  style?: {
    fontName?: string;
    fontSize?: number;
    color?: Color;
  };
}

export interface ImageEdit {
  type: 'add' | 'remove' | 'move' | 'resize';
  imageId?: string;
  pageIndex: number;
  imageData?: Uint8Array;
  boundingBox?: BoundingBox;
  transform?: TextMatrix;
}

export interface DocumentState {
  pages: PageStructure[];
  fonts: Map<string, FontInfo>;
  formFields: FormField[];
  editHistory: EditOperation[];
  isDirty: boolean;
}

/**
 * Main PDF Document Editor class
 */
export class PDFDocumentEditor {
  private pdfLib: any; // pdf-lib PDFDocument
  private pdfjs: any; // pdfjs-dist document proxy
  private state: DocumentState;
  private fontManager: FontManager;
  private formManager: FormFieldManager;
  private layoutAnalyzer: LayoutAnalyzer;
  private readingOrderDetector: ReadingOrderDetector;
  private editCompiler: TextEditCompiler;

  constructor() {
    this.fontManager = new FontManager();
    this.formManager = new FormFieldManager();
    this.layoutAnalyzer = new LayoutAnalyzer();
    this.readingOrderDetector = new ReadingOrderDetector();
    this.editCompiler = new TextEditCompiler();
    this.state = {
      pages: [],
      fonts: new Map(),
      formFields: [],
      editHistory: [],
      isDirty: false
    };
  }

  /**
   * Load a PDF document for editing
   */
  async load(pdfBytes: Uint8Array, pdfLib: any, pdfjs: any): Promise<void> {
    this.pdfLib = pdfLib;
    this.pdfjs = pdfjs;

    // Parse each page
    const numPages = this.pdfjs.numPages;
    this.state.pages = [];

    for (let i = 0; i < numPages; i++) {
      const page = await this.parsePage(i);
      this.state.pages.push(page);
    }

    // Load form fields
    await this.loadFormFields();

    this.state.isDirty = false;
  }

  /**
   * Parse a single page
   */
  private async parsePage(pageIndex: number): Promise<PageStructure> {
    const page = await this.pdfjs.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1 });

    // Get content stream
    const operatorList = await page.getOperatorList();
    const textContent = await page.getTextContent();

    // Parse content stream if available
    let operators: PDFOperator[] = [];
    let textRuns: TextRun[] = [];

    // Convert PDF.js text items to TextRuns
    for (let i = 0; i < textContent.items.length; i++) {
      const item = textContent.items[i] as any;
      if (item.str) {
        const run: TextRun = {
          id: `run_${pageIndex}_${i}`,
          glyphs: [],
          text: item.str,
          boundingBox: {
            x: item.transform[4],
            y: viewport.height - item.transform[5] - item.height,
            width: item.width,
            height: item.height
          },
          fontName: item.fontName || 'default',
          fontSize: Math.abs(item.transform[0]) || 12,
          color: { space: 'DeviceGray', values: [0] },
          transform: {
            a: item.transform[0],
            b: item.transform[1],
            c: item.transform[2],
            d: item.transform[3],
            e: item.transform[4],
            f: item.transform[5]
          },
          operators: [],
          modified: false
        };
        textRuns.push(run);
      }
    }

    // Run layout analysis
    const words = this.layoutAnalyzer.groupIntoWords(textRuns);
    const lines = this.layoutAnalyzer.groupIntoLines(words);
    const paragraphs = this.layoutAnalyzer.groupIntoParagraphs(lines);
    const columns = this.layoutAnalyzer.detectColumns(paragraphs);
    const tables = this.layoutAnalyzer.detectTables(lines);

    // Detect reading order
    const readingOrder = this.readingOrderDetector.detectReadingOrder(
      textRuns.map(r => ({ type: 'text' as const, element: r })),
      { x: 0, y: 0, width: viewport.width, height: viewport.height }
    );

    return {
      pageIndex,
      mediaBox: { x: 0, y: 0, width: viewport.width, height: viewport.height },
      cropBox: { x: 0, y: 0, width: viewport.width, height: viewport.height },
      rotation: page.rotate || 0,
      resources: {
        fonts: new Map(),
        xObjects: new Map(),
        extGState: new Map(),
        colorSpaces: new Map(),
        patterns: new Map(),
        shadings: new Map()
      },
      operators,
      textRuns,
      words,
      lines,
      paragraphs,
      columns,
      tables,
      images: [],
      paths: [],
      formXObjects: [],
      readingOrder
    };
  }

  /**
   * Load form fields from the document
   */
  private async loadFormFields(): Promise<void> {
    // Form field loading would use the AcroForm dictionary
    // This requires access to the raw PDF structure
    this.state.formFields = this.formManager.getAllFields();
  }

  /**
   * Get page structure
   */
  getPage(pageIndex: number): PageStructure | undefined {
    return this.state.pages[pageIndex];
  }

  /**
   * Get all pages
   */
  getAllPages(): PageStructure[] {
    return this.state.pages;
  }

  /**
   * Get text runs on a page
   */
  getTextRuns(pageIndex: number): TextRun[] {
    return this.state.pages[pageIndex]?.textRuns || [];
  }

  /**
   * Get words on a page
   */
  getWords(pageIndex: number): Word[] {
    return this.state.pages[pageIndex]?.words || [];
  }

  /**
   * Get lines on a page
   */
  getLines(pageIndex: number): TextLine[] {
    return this.state.pages[pageIndex]?.lines || [];
  }

  /**
   * Get paragraphs on a page
   */
  getParagraphs(pageIndex: number): Paragraph[] {
    return this.state.pages[pageIndex]?.paragraphs || [];
  }

  /**
   * Find text runs at a specific point
   */
  findTextRunsAtPoint(pageIndex: number, x: number, y: number): TextRun[] {
    const runs = this.getTextRuns(pageIndex);
    return runs.filter(run => {
      const bbox = run.boundingBox;
      return x >= bbox.x && x <= bbox.x + bbox.width &&
             y >= bbox.y && y <= bbox.y + bbox.height;
    });
  }

  /**
   * Find text runs in a rectangle
   */
  findTextRunsInRect(pageIndex: number, rect: BoundingBox): TextRun[] {
    const runs = this.getTextRuns(pageIndex);
    return runs.filter(run => {
      const bbox = run.boundingBox;
      return bbox.x < rect.x + rect.width &&
             bbox.x + bbox.width > rect.x &&
             bbox.y < rect.y + rect.height &&
             bbox.y + bbox.height > rect.y;
    });
  }

  /**
   * Replace text in a text run
   */
  replaceText(edit: TextEdit): boolean {
    const page = this.state.pages[edit.pageIndex];
    if (!page) return false;

    const run = page.textRuns.find(r => r.id === edit.runId);
    if (!run) return false;

    // Record edit operation
    const operation: EditOperation = {
      id: `edit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'replace',
      target: {
        pageIndex: edit.pageIndex,
        elementId: edit.runId,
        elementType: 'text'
      },
      before: run.text,
      after: edit.newText,
      timestamp: Date.now()
    };
    this.state.editHistory.push(operation);

    // Update the text run
    run.text = edit.newText || '';
    run.modified = true;

    // Recalculate layout
    this.recalculatePageLayout(edit.pageIndex);

    this.state.isDirty = true;
    return true;
  }

  /**
   * Delete text run
   */
  deleteTextRun(pageIndex: number, runId: string): boolean {
    const page = this.state.pages[pageIndex];
    if (!page) return false;

    const runIndex = page.textRuns.findIndex(r => r.id === runId);
    if (runIndex === -1) return false;

    const run = page.textRuns[runIndex];

    // Record operation
    const operation: EditOperation = {
      id: `edit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'delete',
      target: {
        pageIndex,
        elementId: runId,
        elementType: 'text'
      },
      before: run,
      after: null,
      timestamp: Date.now()
    };
    this.state.editHistory.push(operation);

    // Mark as deleted (we don't remove it to preserve structure)
    run.text = '';
    run.modified = true;

    this.recalculatePageLayout(pageIndex);
    this.state.isDirty = true;
    return true;
  }

  /**
   * Insert new text
   */
  insertText(
    pageIndex: number,
    position: { x: number; y: number },
    text: string,
    style: { fontName: string; fontSize: number; color?: Color }
  ): TextRun {
    const page = this.state.pages[pageIndex];

    const newRun: TextRun = {
      id: `run_${pageIndex}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      glyphs: [],
      text,
      boundingBox: {
        x: position.x,
        y: position.y,
        width: this.estimateTextWidth(text, style.fontSize),
        height: style.fontSize * 1.2
      },
      fontName: style.fontName,
      fontSize: style.fontSize,
      color: style.color || { space: 'DeviceGray', values: [0] },
      transform: {
        a: style.fontSize,
        b: 0,
        c: 0,
        d: style.fontSize,
        e: position.x,
        f: position.y
      },
      operators: [],
      modified: true
    };

    // Record operation
    const operation: EditOperation = {
      id: `edit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'insert',
      target: {
        pageIndex,
        elementId: newRun.id,
        elementType: 'text'
      },
      before: null,
      after: newRun,
      timestamp: Date.now()
    };
    this.state.editHistory.push(operation);

    page.textRuns.push(newRun);
    this.recalculatePageLayout(pageIndex);
    this.state.isDirty = true;

    return newRun;
  }

  /**
   * Change text style
   */
  changeTextStyle(edit: TextEdit): boolean {
    const page = this.state.pages[edit.pageIndex];
    if (!page || !edit.style) return false;

    const run = page.textRuns.find(r => r.id === edit.runId);
    if (!run) return false;

    // Record operation
    const operation: EditOperation = {
      id: `edit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'style',
      target: {
        pageIndex: edit.pageIndex,
        elementId: edit.runId,
        elementType: 'text'
      },
      before: {
        fontName: run.fontName,
        fontSize: run.fontSize,
        color: run.color
      },
      after: edit.style,
      timestamp: Date.now()
    };
    this.state.editHistory.push(operation);

    // Apply style changes
    if (edit.style.fontName) run.fontName = edit.style.fontName;
    if (edit.style.fontSize) run.fontSize = edit.style.fontSize;
    if (edit.style.color) run.color = edit.style.color;
    run.modified = true;

    this.state.isDirty = true;
    return true;
  }

  /**
   * Recalculate page layout after edits
   */
  private recalculatePageLayout(pageIndex: number): void {
    const page = this.state.pages[pageIndex];
    if (!page) return;

    // Re-run layout analysis
    page.words = this.layoutAnalyzer.groupIntoWords(page.textRuns);
    page.lines = this.layoutAnalyzer.groupIntoLines(page.words);
    page.paragraphs = this.layoutAnalyzer.groupIntoParagraphs(page.lines);
    page.columns = this.layoutAnalyzer.detectColumns(page.paragraphs);
    page.tables = this.layoutAnalyzer.detectTables(page.lines);

    // Re-detect reading order
    page.readingOrder = this.readingOrderDetector.detectReadingOrder(
      page.textRuns.map(r => ({ type: 'text' as const, element: r })),
      page.mediaBox
    );
  }

  /**
   * Undo the last edit
   */
  undo(): boolean {
    const operation = this.state.editHistory.pop();
    if (!operation) return false;

    const page = this.state.pages[operation.target.pageIndex];
    if (!page) return false;

    switch (operation.type) {
      case 'replace':
      case 'style': {
        const run = page.textRuns.find(r => r.id === operation.target.elementId);
        if (run) {
          if (operation.type === 'replace') {
            run.text = operation.before as string;
          } else {
            const before = operation.before as any;
            if (before.fontName) run.fontName = before.fontName;
            if (before.fontSize) run.fontSize = before.fontSize;
            if (before.color) run.color = before.color;
          }
          run.modified = true;
        }
        break;
      }
      case 'delete': {
        const deletedRun = operation.before as TextRun;
        const run = page.textRuns.find(r => r.id === operation.target.elementId);
        if (run) {
          run.text = deletedRun.text;
          run.modified = true;
        }
        break;
      }
      case 'insert': {
        const runIndex = page.textRuns.findIndex(r => r.id === operation.target.elementId);
        if (runIndex !== -1) {
          page.textRuns.splice(runIndex, 1);
        }
        break;
      }
    }

    this.recalculatePageLayout(operation.target.pageIndex);
    this.state.isDirty = this.state.editHistory.length > 0;
    return true;
  }

  /**
   * Get all modified text runs
   */
  getModifiedTextRuns(): { pageIndex: number; run: TextRun }[] {
    const modified: { pageIndex: number; run: TextRun }[] = [];

    for (let i = 0; i < this.state.pages.length; i++) {
      for (const run of this.state.pages[i].textRuns) {
        if (run.modified) {
          modified.push({ pageIndex: i, run });
        }
      }
    }

    return modified;
  }

  /**
   * Build content stream for a page with all modifications
   */
  buildModifiedContentStream(pageIndex: number): Uint8Array {
    const page = this.state.pages[pageIndex];
    if (!page) return new Uint8Array(0);

    // Get modified runs
    const modifiedRuns = page.textRuns.filter(r => r.modified);
    if (modifiedRuns.length === 0) {
      return new Uint8Array(0);
    }

    // Compile text edits
    const edits = modifiedRuns.map(run => ({
      originalRun: run,
      newText: run.text,
      newStyle: {
        fontName: run.fontName,
        fontSize: run.fontSize,
        color: run.color
      }
    }));

    return this.editCompiler.compile(edits);
  }

  /**
   * Check if document has unsaved changes
   */
  isDirty(): boolean {
    return this.state.isDirty;
  }

  /**
   * Get edit history
   */
  getEditHistory(): EditOperation[] {
    return [...this.state.editHistory];
  }

  /**
   * Clear edit history
   */
  clearEditHistory(): void {
    this.state.editHistory = [];
  }

  /**
   * Mark document as saved
   */
  markSaved(): void {
    this.state.isDirty = false;
    // Clear modified flags
    for (const page of this.state.pages) {
      for (const run of page.textRuns) {
        run.modified = false;
      }
    }
  }

  /**
   * Estimate text width based on font size
   */
  private estimateTextWidth(text: string, fontSize: number): number {
    // Rough estimate: average character width is about 0.5 * fontSize
    return text.length * fontSize * 0.5;
  }

  /**
   * Get font manager instance
   */
  getFontManager(): FontManager {
    return this.fontManager;
  }

  /**
   * Get form field manager instance
   */
  getFormManager(): FormFieldManager {
    return this.formManager;
  }

  /**
   * Search for text across all pages
   */
  searchText(query: string, options?: { caseSensitive?: boolean; wholeWord?: boolean }): {
    pageIndex: number;
    runId: string;
    text: string;
    boundingBox: BoundingBox;
  }[] {
    const results: {
      pageIndex: number;
      runId: string;
      text: string;
      boundingBox: BoundingBox;
    }[] = [];

    const searchQuery = options?.caseSensitive ? query : query.toLowerCase();

    for (let i = 0; i < this.state.pages.length; i++) {
      for (const run of this.state.pages[i].textRuns) {
        const text = options?.caseSensitive ? run.text : run.text.toLowerCase();

        if (options?.wholeWord) {
          const regex = new RegExp(`\\b${searchQuery}\\b`);
          if (regex.test(text)) {
            results.push({
              pageIndex: i,
              runId: run.id,
              text: run.text,
              boundingBox: run.boundingBox
            });
          }
        } else if (text.includes(searchQuery)) {
          results.push({
            pageIndex: i,
            runId: run.id,
            text: run.text,
            boundingBox: run.boundingBox
          });
        }
      }
    }

    return results;
  }

  /**
   * Replace all occurrences of text
   */
  replaceAll(
    searchQuery: string,
    replacement: string,
    options?: { caseSensitive?: boolean; wholeWord?: boolean }
  ): number {
    const matches = this.searchText(searchQuery, options);

    for (const match of matches) {
      const page = this.state.pages[match.pageIndex];
      const run = page.textRuns.find(r => r.id === match.runId);
      if (run) {
        if (options?.wholeWord) {
          const regex = new RegExp(
            `\\b${searchQuery}\\b`,
            options.caseSensitive ? 'g' : 'gi'
          );
          run.text = run.text.replace(regex, replacement);
        } else {
          const regex = new RegExp(
            searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            options?.caseSensitive ? 'g' : 'gi'
          );
          run.text = run.text.replace(regex, replacement);
        }
        run.modified = true;
      }
    }

    // Recalculate layouts
    const affectedPages = new Set(matches.map(m => m.pageIndex));
    for (const pageIndex of affectedPages) {
      this.recalculatePageLayout(pageIndex);
    }

    if (matches.length > 0) {
      this.state.isDirty = true;
    }

    return matches.length;
  }

  /**
   * Get document statistics
   */
  getStatistics(): {
    pageCount: number;
    textRunCount: number;
    wordCount: number;
    characterCount: number;
    fontCount: number;
    formFieldCount: number;
  } {
    let textRunCount = 0;
    let wordCount = 0;
    let characterCount = 0;

    for (const page of this.state.pages) {
      textRunCount += page.textRuns.length;
      wordCount += page.words.length;
      for (const run of page.textRuns) {
        characterCount += run.text.length;
      }
    }

    return {
      pageCount: this.state.pages.length,
      textRunCount,
      wordCount,
      characterCount,
      fontCount: this.state.fonts.size,
      formFieldCount: this.state.formFields.length
    };
  }
}

export default PDFDocumentEditor;

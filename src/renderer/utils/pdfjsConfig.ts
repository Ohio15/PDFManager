/**
 * Shared pdfjs-dist configuration for document loading.
 *
 * standardFontDataUrl — points at the bundled Foxit / Liberation font files
 * so pdfjs can render PDFs that reference standard 14 fonts (Helvetica,
 * Times, Courier, etc.) without embedding them.
 *
 * cMapUrl — points at the bundled CMap files for CJK font encoding.
 */

/** Base options to spread into every pdfjsLib.getDocument() call. */
export const PDFJS_DOCUMENT_OPTIONS = {
  standardFontDataUrl: './standard_fonts/',
  cMapUrl: './cmaps/',
  cMapPacked: true,
} as const;

/**
 * Shared test helpers for the forms/finalize suites: real fixtures, real
 * pdf.js (legacy Node build) and real pdf-lib — no doubles.
 */
import fs from 'fs';
import path from 'path';

export const FIXTURES = path.resolve(__dirname, '../../../../test-pdfs');

export function fixture(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function pdfjs(): Promise<any> {
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

const STANDARD_FONTS = path.resolve(__dirname, '../../public/standard_fonts') + path.sep;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function openPdfJs(bytes: Uint8Array): Promise<any> {
  const lib = await pdfjs();
  return lib.getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: STANDARD_FONTS,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
}

/** All text on every page, items joined by spaces, pages by newlines. */
export async function allText(bytes: Uint8Array): Promise<string> {
  const doc = await openPdfJs(bytes);
  try {
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pages.push(content.items.map((it: any) => it.str).join(' '));
    }
    return pages.join('\n');
  } finally {
    await doc.destroy();
  }
}

/** Minimal AnnotationStorage with the shape pdf.js exposes (getAll/getRawValue/setValue). */
export class TestAnnotationStorage {
  private values = new Map<string, Record<string, unknown>>();
  setValue(id: string, value: Record<string, unknown>) {
    this.values.set(id, { ...(this.values.get(id) ?? {}), ...value });
  }
  getRawValue(id: string) {
    return this.values.get(id);
  }
  getAll() {
    return this.values.size ? Object.fromEntries(this.values) : null;
  }
}

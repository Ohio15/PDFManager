/**
 * The pdf.js scan is the redaction verifier's independent oracle. When it
 * cannot examine content (here: a font pdf.js fails to load) it must say so,
 * never return an empty glyph list that reads as "nothing under the mark".
 *
 * The doubles mirror REAL pdf.js 4.10.38 behaviour: a font that fails to load
 * becomes a worker-side ErrorFont whose charsToGlyphs() returns [] (so the
 * showText argument is an EMPTY array) and whose commonObjs entry resolves to
 * the error STRING (pdf.mjs "Error during font loading" branch); the lookup
 * never throws. A double that throws would be more permissive than reality.
 */
import { describe, it, expect } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { scanPdfjsPage } from '../pdfjsScan';

const OPS = (pdfjs as unknown as { OPS: Record<string, number> }).OPS;

/** A page whose operator list shows `glyphs` in font `f1`, resolved by `loadFont`. */
function pageWithFont(loadFont: (id: string, cb: (data: unknown) => void) => void, glyphs: unknown[]) {
  return {
    getOperatorList: async () => ({
      fnArray: [OPS.beginText, OPS.setFont, OPS.showText, OPS.endText],
      argsArray: [null, ['f1', 12], [glyphs], null],
    }),
    objs: { get: loadFont },
    commonObjs: { get: loadFont },
  };
}

const SN = [{ unicode: 'S', width: 600, isSpace: false }, { unicode: 'N', width: 600, isSpace: false }];

describe('scanPdfjsPage fails closed', () => {
  it('ErrorFont (resolves to an error string, shows NO glyphs) is reported as font-unloadable', async () => {
    const scan = await scanPdfjsPage(
      pageWithFont((_id, cb) => cb('Font "F9" is not available.'), []) as never,
      OPS
    );
    expect(scan.glyphs).toHaveLength(0);
    expect(scan.unexamined).toEqual([{ reason: 'font-unloadable', detail: 'Text drawn with a font that could not be loaded' }]);
  });

  it('reports nothing unexamined when the font loads', async () => {
    const scan = await scanPdfjsPage(
      pageWithFont((_id, cb) => cb({ fontMatrix: [0.001, 0, 0, 0.001, 0, 0] }), SN) as never,
      OPS
    );
    expect(scan.glyphs.map((g) => g.unicode)).toEqual(['S', 'N']);
    expect(scan.unexamined).toEqual([]);
  });
});

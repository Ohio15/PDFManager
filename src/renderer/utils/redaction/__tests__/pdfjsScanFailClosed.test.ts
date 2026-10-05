/**
 * The pdf.js scan is the redaction verifier's independent oracle. When it
 * cannot examine content (here: a font pdf.js fails to load) it must say so,
 * never return an empty glyph list that reads as "nothing under the mark".
 */
import { describe, it, expect } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { scanPdfjsPage } from '../pdfjsScan';

const OPS = (pdfjs as unknown as { OPS: Record<string, number> }).OPS;

/** A page whose operator list shows text in font `f1`; the font load fails. */
function pageWithFont(loadFont: (id: string, cb: (data: unknown) => void) => void) {
  return {
    getOperatorList: async () => ({
      fnArray: [OPS.beginText, OPS.setFont, OPS.showText, OPS.endText],
      argsArray: [
        null,
        ['f1', 12],
        [[{ unicode: 'S', width: 600, isSpace: false }, { unicode: 'N', width: 600, isSpace: false }]],
        null,
      ],
    }),
    objs: { get: loadFont },
    commonObjs: { get: loadFont },
  };
}

describe('scanPdfjsPage fails closed', () => {
  it('reports text in an unloadable font as unexamined instead of dropping it', async () => {
    const scan = await scanPdfjsPage(
      pageWithFont(() => { throw new Error('font failed to load'); }) as never,
      OPS
    );
    expect(scan.glyphs).toHaveLength(0);
    expect(scan.unexamined).toEqual(['Text drawn with a font that could not be loaded']);
  });

  it('reports nothing unexamined when the font loads', async () => {
    const scan = await scanPdfjsPage(
      pageWithFont((_id, cb) => cb({ fontMatrix: [0.001, 0, 0, 0.001, 0, 0] })) as never,
      OPS
    );
    expect(scan.glyphs.map((g) => g.unicode)).toEqual(['S', 'N']);
    expect(scan.unexamined).toEqual([]);
  });
});

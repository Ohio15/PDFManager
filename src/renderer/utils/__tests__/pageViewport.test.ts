import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { createViewportTransform, pdfRectToScreen, screenRectToPdf } from '../pageViewport';
import { openPdfJs } from './formsFinalizeHelpers';

async function pageWithMediaBox(x: number, y: number, w: number, h: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([w, h]);
  page.setMediaBox(x, y, w, h);
  return new Uint8Array(await doc.save());
}

describe('pageViewport matches pdf.js page.getViewport()', () => {
  const boxes: Array<[number, number, number, number]> = [
    [0, 0, 612, 792],
    [20, 30, 600, 800], // view box not at the origin
  ];
  for (const box of boxes) {
    for (const rotation of [0, 90, 180, 270]) {
      it(`MediaBox ${box.join(',')} rotation ${rotation}`, async () => {
        const pdf = await openPdfJs(await pageWithMediaBox(...box));
        try {
          const page = await pdf.getPage(1);
          const scale = 1.37;
          const ref = page.getViewport({ scale, rotation });
          const view = page.view as [number, number, number, number];
          const t = createViewportTransform(view, rotation, scale);
          expect(t.width).toBeCloseTo(ref.width, 6);
          expect(t.height).toBeCloseTo(ref.height, 6);
          for (const [x, y] of [[view[0], view[1]], [100, 200], [view[2], view[3]]]) {
            const [vx, vy] = t.toViewport(x, y);
            const [rx, ry] = ref.convertToViewportPoint(x, y);
            expect(vx).toBeCloseTo(rx, 6);
            expect(vy).toBeCloseTo(ry, 6);
            const [bx, by] = t.toPdf(vx, vy);
            expect(bx).toBeCloseTo(x, 6);
            expect(by).toBeCloseTo(y, 6);
          }
          const rect = { x: 100, y: 200, width: 150, height: 30 };
          expect(screenRectToPdf(t, pdfRectToScreen(t, rect))).toEqual(rect);
        } finally {
          await pdf.destroy();
        }
      });
    }
  }
});

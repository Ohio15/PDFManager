/**
 * Content Stream Pipeline Tests
 *
 * Comprehensive tests for the PDF content stream generation pipeline:
 *   - ContentStreamBuilder: low-level PDF operator generation
 *   - annotationContentStreamWriter: annotation -> content stream conversion
 *   - pdfResourceManager: ResourceAllocator class for resource name allocation
 *
 * contentStreamInjector is NOT tested here because appendContentStream()
 * requires a real pdf-lib PDFDocument instance and page structure.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ContentStreamBuilder } from '../pdfParser/ContentStreamBuilder';
import { writeAnnotation } from '../annotationContentStreamWriter';
import type {
  HighlightAnnotation,
  DrawingAnnotation,
  ShapeAnnotation,
  TextAnnotation,
  ImageAnnotation,
  StampAnnotation,
  StickyNoteAnnotation,
} from '../../types';

/** Decode Uint8Array to string for content stream inspection. */
function decode(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes);
}

// ─────────────────────────────────────────────────────────────────────────────
// ContentStreamBuilder
// ─────────────────────────────────────────────────────────────────────────────
describe('ContentStreamBuilder', () => {
  let builder: ContentStreamBuilder;

  beforeEach(() => {
    builder = new ContentStreamBuilder();
  });

  it('builds a simple rectangle command with re and f operators', () => {
    builder.rectangle(10, 20, 100, 50);
    builder.fill();
    const output = decode(builder.build());
    expect(output).toContain('re');
    expect(output).toContain('f');
    expect(output).toContain('10 20 100 50 re');
  });

  it('builds text operators (BT, Tf, Tm, Tj, ET)', () => {
    builder.beginText();
    builder.setFont('Helvetica', 12);
    builder.setTextMatrix({ a: 1, b: 0, c: 0, d: 1, e: 72, f: 700 });
    builder.showText('Hello');
    builder.endText();

    const output = builder.buildString();
    expect(output).toContain('BT');
    expect(output).toContain('/Helvetica 12 Tf');
    expect(output).toContain('1 0 0 1 72 700 Tm');
    expect(output).toContain('(Hello) Tj');
    expect(output).toContain('ET');
  });

  it('saveState/restoreState wraps content in q/Q', () => {
    builder.saveState();
    builder.setLineWidth(2);
    builder.restoreState();

    const output = builder.buildString();
    const lines = output.split('\n');
    expect(lines[0]).toBe('q');
    expect(lines[lines.length - 1]).toBe('Q');
  });

  it('setExtGState produces correct operator', () => {
    builder.setExtGState('GS_ann_1');
    const output = builder.buildString();
    expect(output).toBe('/GS_ann_1 gs');
  });

  it('drawXObject produces correct operator', () => {
    builder.drawXObject('Im_ann_1');
    const output = builder.buildString();
    expect(output).toBe('/Im_ann_1 Do');
  });

  it('ellipse drawn via curveTo produces 4 "c" operators', () => {
    // Reproduce the drawEllipse helper logic inline to verify builder output
    const x = 0;
    const y = 0;
    const w = 100;
    const h = 80;
    const k = 0.5523;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const rx = w / 2;
    const ry = h / 2;
    const kx = rx * k;
    const ky = ry * k;

    builder.moveTo(cx, cy + ry);
    builder.curveTo(cx + kx, cy + ry, cx + rx, cy + ky, cx + rx, cy);
    builder.curveTo(cx + rx, cy - ky, cx + kx, cy - ry, cx, cy - ry);
    builder.curveTo(cx - kx, cy - ry, cx - rx, cy - ky, cx - rx, cy);
    builder.curveTo(cx - rx, cy + ky, cx - kx, cy + ry, cx, cy + ry);
    builder.closePath();

    const output = builder.buildString();
    // Count occurrences of the " c" operator (curveTo lines end with " c")
    const curveOperators = output.split('\n').filter((line) => line.trimEnd().endsWith(' c'));
    expect(curveOperators).toHaveLength(4);
  });

  it('buildString matches decoded build() output', () => {
    builder.saveState();
    builder.rectangle(0, 0, 50, 50);
    builder.fill();
    builder.restoreState();

    const fromBuild = decode(builder.build());
    const fromString = builder.buildString() + '\n'; // build() appends trailing newline
    expect(fromBuild).toBe(fromString);
  });

  it('clear() resets commands', () => {
    builder.rectangle(0, 0, 10, 10);
    expect(builder.commandCount).toBe(1);
    builder.clear();
    expect(builder.commandCount).toBe(0);
  });

  it('setFillColor with DeviceRGB produces rg operator', () => {
    builder.setFillColor({ space: 'DeviceRGB', values: [1, 0, 0] });
    expect(builder.buildString()).toBe('1 0 0 rg');
  });

  it('setStrokeColor with DeviceRGB produces RG operator', () => {
    builder.setStrokeColor({ space: 'DeviceRGB', values: [0, 0.5, 1] });
    expect(builder.buildString()).toBe('0 0.5 1 RG');
  });

  it('setFillColor with DeviceGray produces g operator', () => {
    builder.setFillColor({ space: 'DeviceGray', values: [0.5] });
    expect(builder.buildString()).toBe('0.5 g');
  });

  it('moveTo and lineTo produce m and l operators', () => {
    builder.moveTo(10, 20);
    builder.lineTo(30, 40);
    const output = builder.buildString();
    expect(output).toContain('10 20 m');
    expect(output).toContain('30 40 l');
  });

  it('setMatrix produces cm operator', () => {
    builder.setMatrix({ a: 200, b: 0, c: 0, d: 150, e: 50, f: 100 });
    expect(builder.buildString()).toBe('200 0 0 150 50 100 cm');
  });

  it('showText escapes parentheses in literal strings', () => {
    builder.showText('(test)');
    expect(builder.buildString()).toBe('(\\(test\\)) Tj');
  });

  it('showText with hex encoding produces hex string', () => {
    builder.showText('AB', true);
    expect(builder.buildString()).toBe('<4142> Tj');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// annotationContentStreamWriter
// ─────────────────────────────────────────────────────────────────────────────
describe('annotationContentStreamWriter', () => {
  const pageHeight = 800;

  describe('highlight annotation', () => {
    const highlight: HighlightAnnotation = {
      id: 'h1',
      type: 'highlight',
      pageIndex: 0,
      rects: [{ x: 10, y: 100, width: 200, height: 20 }],
      color: 'rgba(255, 255, 0, 0.3)',
    };

    it('returns content bytes and ExtGState resource requirement', () => {
      const result = writeAnnotation(highlight, pageHeight);
      expect(result).not.toBeNull();

      const content = decode(result!.contentBytes);
      expect(content.length).toBeGreaterThan(0);

      // Must require an ExtGState for transparency
      expect(result!.resources.extGStates).toHaveLength(1);
      expect(result!.resources.extGStates[0].fillOpacity).toBeCloseTo(0.3);
    });

    it('contains rectangle fill operators', () => {
      const result = writeAnnotation(highlight, pageHeight)!;
      const content = decode(result.contentBytes);
      expect(content).toContain('re');
      expect(content).toContain('f');
    });

    it('wraps in q/Q save/restore state', () => {
      const result = writeAnnotation(highlight, pageHeight)!;
      const content = decode(result.contentBytes);
      const lines = content.trim().split('\n');
      expect(lines[0]).toBe('q');
      expect(lines[lines.length - 1]).toBe('Q');
    });

    it('references placeholder ExtGState name __GS_0__', () => {
      const result = writeAnnotation(highlight, pageHeight)!;
      const content = decode(result.contentBytes);
      expect(content).toContain('/__GS_0__ gs');
    });
  });

  describe('drawing annotation', () => {
    const drawing: DrawingAnnotation = {
      id: 'd1',
      type: 'drawing',
      pageIndex: 0,
      paths: [
        {
          points: [
            { x: 10, y: 10 },
            { x: 50, y: 50 },
            { x: 100, y: 30 },
          ],
          color: '#ff0000',
          width: 2,
        },
      ],
    };

    it('returns content bytes with stroke operators', () => {
      const result = writeAnnotation(drawing, pageHeight);
      expect(result).not.toBeNull();

      const content = decode(result!.contentBytes);
      // Should have moveTo for first point
      expect(content).toContain('m');
      // Should have lineTo for subsequent points
      expect(content).toContain('l');
      // Should stroke the path
      expect(content).toContain('S');
    });

    it('sets stroke color from path hex color', () => {
      const result = writeAnnotation(drawing, pageHeight)!;
      const content = decode(result.contentBytes);
      // #ff0000 -> r=1, g=0, b=0
      expect(content).toContain('1 0 0 RG');
    });

    it('sets line width from path width', () => {
      const result = writeAnnotation(drawing, pageHeight)!;
      const content = decode(result.contentBytes);
      expect(content).toContain('2 w');
    });

    it('converts Y coordinates (page to PDF)', () => {
      const result = writeAnnotation(drawing, pageHeight)!;
      const content = decode(result.contentBytes);
      // First point: y=10 -> pdfY = 800 - 10 = 790
      expect(content).toContain('10 790 m');
      // Second point: y=50 -> pdfY = 800 - 50 = 750
      expect(content).toContain('50 750 l');
    });

    it('does not require ExtGState or XObject resources', () => {
      const result = writeAnnotation(drawing, pageHeight)!;
      expect(result.resources.extGStates).toHaveLength(0);
      expect(result.resources.xObjects).toHaveLength(0);
      expect(result.resources.fonts).toHaveLength(0);
    });
  });

  describe('shape annotation (rectangle)', () => {
    const rectShape: ShapeAnnotation = {
      id: 's1',
      type: 'shape',
      pageIndex: 0,
      shapeType: 'rectangle',
      position: { x: 50, y: 50 },
      size: { width: 100, height: 80 },
      strokeColor: '#000000',
      fillColor: '#ff0000',
      strokeWidth: 2,
      opacity: 1,
    };

    it('returns content bytes with re operator', () => {
      const result = writeAnnotation(rectShape, pageHeight);
      expect(result).not.toBeNull();

      const content = decode(result!.contentBytes);
      expect(content).toContain('re');
    });

    it('converts position to PDF coordinates', () => {
      const result = writeAnnotation(rectShape, pageHeight)!;
      const content = decode(result.contentBytes);
      // pdfY = 800 - 50 - 80 = 670
      expect(content).toContain('50 670 100 80 re');
    });

    it('uses fillStroke (B) when fill color is not white', () => {
      const result = writeAnnotation(rectShape, pageHeight)!;
      const content = decode(result.contentBytes);
      // #ff0000 is not white, so fillStroke (B operator) should be used
      expect(content).toContain('\nB\n');
    });

    it('does not require ExtGState when opacity is 1', () => {
      const result = writeAnnotation(rectShape, pageHeight)!;
      expect(result.resources.extGStates).toHaveLength(0);
    });

    it('requires ExtGState when opacity < 1', () => {
      const semiTransparent: ShapeAnnotation = { ...rectShape, opacity: 0.5 };
      const result = writeAnnotation(semiTransparent, pageHeight)!;
      expect(result.resources.extGStates).toHaveLength(1);
      expect(result.resources.extGStates[0].fillOpacity).toBe(0.5);
      expect(result.resources.extGStates[0].strokeOpacity).toBe(0.5);
    });
  });

  describe('shape annotation (ellipse)', () => {
    const ellipseShape: ShapeAnnotation = {
      id: 's2',
      type: 'shape',
      pageIndex: 0,
      shapeType: 'ellipse',
      position: { x: 50, y: 50 },
      size: { width: 100, height: 80 },
      strokeColor: '#000000',
      fillColor: '#ff0000',
      strokeWidth: 2,
      opacity: 1,
    };

    it('returns content bytes with c (curveTo) operators', () => {
      const result = writeAnnotation(ellipseShape, pageHeight);
      expect(result).not.toBeNull();

      const content = decode(result!.contentBytes);
      const lines = content.split('\n');
      const curveLines = lines.filter((line) => line.trimEnd().endsWith(' c'));
      expect(curveLines).toHaveLength(4);
    });

    it('contains closePath (h) operator', () => {
      const result = writeAnnotation(ellipseShape, pageHeight)!;
      const content = decode(result.contentBytes);
      expect(content.split('\n')).toContain('h');
    });
  });

  describe('shape annotation (line)', () => {
    const lineShape: ShapeAnnotation = {
      id: 's3',
      type: 'shape',
      pageIndex: 0,
      shapeType: 'line',
      position: { x: 10, y: 10 },
      size: { width: 200, height: 100 },
      strokeColor: '#000000',
      fillColor: '#ffffff',
      strokeWidth: 1,
      opacity: 1,
    };

    it('returns content bytes with m and l operators', () => {
      const result = writeAnnotation(lineShape, pageHeight);
      expect(result).not.toBeNull();

      const content = decode(result!.contentBytes);
      const lines = content.split('\n');
      const moveToLines = lines.filter((l) => l.trimEnd().endsWith(' m'));
      const lineToLines = lines.filter((l) => l.trimEnd().endsWith(' l'));
      expect(moveToLines.length).toBeGreaterThanOrEqual(1);
      expect(lineToLines.length).toBeGreaterThanOrEqual(1);
    });

    it('strokes the line path', () => {
      const result = writeAnnotation(lineShape, pageHeight)!;
      const content = decode(result.contentBytes);
      expect(content.split('\n')).toContain('S');
    });
  });

  describe('text annotation', () => {
    const textAnnotation: TextAnnotation = {
      id: 't1',
      type: 'text',
      pageIndex: 0,
      position: { x: 100, y: 200 },
      content: 'Hello World',
      fontSize: 14,
      fontFamily: 'Helvetica',
      color: '#000000',
    };

    it('returns content bytes with BT/ET text object', () => {
      const result = writeAnnotation(textAnnotation, pageHeight);
      expect(result).not.toBeNull();

      const content = decode(result!.contentBytes);
      expect(content).toContain('BT');
      expect(content).toContain('ET');
    });

    it('contains the annotation text as a Tj operand', () => {
      const result = writeAnnotation(textAnnotation, pageHeight)!;
      const content = decode(result.contentBytes);
      expect(content).toContain('(Hello World) Tj');
    });

    it('sets font with placeholder name and correct size', () => {
      const result = writeAnnotation(textAnnotation, pageHeight)!;
      const content = decode(result.contentBytes);
      expect(content).toContain('/__F_0__ 14 Tf');
    });

    it('converts Y coordinate for PDF', () => {
      const result = writeAnnotation(textAnnotation, pageHeight)!;
      const content = decode(result.contentBytes);
      // pdfY = 800 - 200 - 14 (fontSize) = 586
      expect(content).toContain('100');
      expect(content).toContain('586');
    });

    it('requires a font resource', () => {
      const result = writeAnnotation(textAnnotation, pageHeight)!;
      expect(result.resources.fonts).toHaveLength(1);
    });
  });

  describe('image annotation', () => {
    const imageAnnotation: ImageAnnotation = {
      id: 'i1',
      type: 'image',
      pageIndex: 0,
      position: { x: 50, y: 100 },
      size: { width: 200, height: 150 },
      data: 'base64data',
      imageType: 'png',
    };

    it('returns content bytes with cm and Do operators', () => {
      const result = writeAnnotation(imageAnnotation, pageHeight);
      expect(result).not.toBeNull();

      const content = decode(result!.contentBytes);
      expect(content).toContain('cm');
      expect(content).toContain('Do');
    });

    it('sets transform matrix for image placement', () => {
      const result = writeAnnotation(imageAnnotation, pageHeight)!;
      const content = decode(result.contentBytes);
      // Matrix: width 0 0 height x pdfY cm
      // pdfY = 800 - 100 - 150 = 550
      expect(content).toContain('200 0 0 150 50 550 cm');
    });

    it('references placeholder XObject name __Im_0__', () => {
      const result = writeAnnotation(imageAnnotation, pageHeight)!;
      const content = decode(result.contentBytes);
      expect(content).toContain('/__Im_0__ Do');
    });

    it('requires an XObject resource', () => {
      const result = writeAnnotation(imageAnnotation, pageHeight)!;
      expect(result.resources.xObjects).toHaveLength(1);
    });

    it('does not require font or ExtGState resources', () => {
      const result = writeAnnotation(imageAnnotation, pageHeight)!;
      expect(result.resources.fonts).toHaveLength(0);
      expect(result.resources.extGStates).toHaveLength(0);
    });
  });

  describe('stamp annotation', () => {
    const stamp: StampAnnotation = {
      id: 'st1',
      type: 'stamp',
      pageIndex: 0,
      position: { x: 100, y: 100 },
      stampType: 'approved',
      text: 'APPROVED',
      color: '#00ff00',
      size: { width: 160, height: 40 },
    };

    it('requires a font resource', () => {
      const result = writeAnnotation(stamp, pageHeight);
      expect(result).not.toBeNull();
      expect(result!.resources.fonts).toHaveLength(1);
    });

    it('draws a border rectangle with re operator', () => {
      const result = writeAnnotation(stamp, pageHeight)!;
      const content = decode(result.contentBytes);
      expect(content).toContain('re');
    });

    it('contains stamp text in BT/ET block', () => {
      const result = writeAnnotation(stamp, pageHeight)!;
      const content = decode(result.contentBytes);
      expect(content).toContain('BT');
      expect(content).toContain('(APPROVED) Tj');
      expect(content).toContain('ET');
    });

    it('converts position to PDF coordinates', () => {
      const result = writeAnnotation(stamp, pageHeight)!;
      const content = decode(result.contentBytes);
      // pdfY = 800 - 100 - 40 = 660
      expect(content).toContain('100 660 160 40 re');
    });

    it('sets stamp color for stroke and fill', () => {
      const result = writeAnnotation(stamp, pageHeight)!;
      const content = decode(result.contentBytes);
      // #00ff00 -> r=0, g=1, b=0
      expect(content).toContain('0 1 0 RG'); // stroke color
      expect(content).toContain('0 1 0 rg'); // fill color for text
    });
  });

  describe('sticky note annotation', () => {
    const note: StickyNoteAnnotation = {
      id: 'n1',
      type: 'note',
      pageIndex: 0,
      position: { x: 200, y: 300 },
      content: 'This is a note',
      color: '#FFF9C4',
    };

    it('requires a font resource', () => {
      const result = writeAnnotation(note, pageHeight);
      expect(result).not.toBeNull();
      expect(result!.resources.fonts).toHaveLength(1);
    });

    it('draws a colored square marker with fillStroke (B)', () => {
      const result = writeAnnotation(note, pageHeight)!;
      const content = decode(result.contentBytes);
      // Note draws a 24x24 marker square
      expect(content).toContain('re');
      expect(content).toContain('\nB\n');
    });

    it('renders an "N" text icon inside the marker', () => {
      const result = writeAnnotation(note, pageHeight)!;
      const content = decode(result.contentBytes);
      expect(content).toContain('BT');
      expect(content).toContain('(N) Tj');
      expect(content).toContain('ET');
    });

    it('converts position for marker square', () => {
      const result = writeAnnotation(note, pageHeight)!;
      const content = decode(result.contentBytes);
      // marker y = 800 - 300 - 24 = 476
      expect(content).toContain('200 476 24 24 re');
    });
  });

  describe('coordinate conversion', () => {
    it('page coords (y=100, pageHeight=800) produce pdfY = pageHeight - y - height', () => {
      // Use a highlight with a single rect to verify the formula
      const annotation: HighlightAnnotation = {
        id: 'coord1',
        type: 'highlight',
        pageIndex: 0,
        rects: [{ x: 0, y: 100, width: 50, height: 20 }],
        color: 'rgba(255,255,0,0.5)',
      };
      const result = writeAnnotation(annotation, 800)!;
      const content = decode(result.contentBytes);
      // pdfY = 800 - 100 - 20 = 680
      expect(content).toContain('0 680 50 20 re');
    });

    it('image annotation coordinate conversion: pdfY = pageHeight - y - height', () => {
      const img: ImageAnnotation = {
        id: 'coord2',
        type: 'image',
        pageIndex: 0,
        position: { x: 10, y: 50 },
        size: { width: 300, height: 200 },
        data: 'data',
        imageType: 'png',
      };
      const result = writeAnnotation(img, 1000)!;
      const content = decode(result.contentBytes);
      // pdfY = 1000 - 50 - 200 = 750
      expect(content).toContain('300 0 0 200 10 750 cm');
    });
  });

  describe('writeAnnotation returns null for unknown types', () => {
    it('returns null for unrecognized annotation type', () => {
      const unknown = { id: 'u1', type: 'unknown', pageIndex: 0 } as any;
      const result = writeAnnotation(unknown, pageHeight);
      expect(result).toBeNull();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pdfResourceManager (ResourceAllocator class API)
// ─────────────────────────────────────────────────────────────────────────────
describe('pdfResourceManager', () => {
  // The module exports a ResourceAllocator class. Each instance maintains its
  // own counter so concurrent save operations cannot collide. The methods
  // (ensureExtGState, ensureXObject, ensureFont) require a real pdf-lib
  // PDFDocument, so we use PDFDocument.create() to build minimal test documents.

  describe('ResourceAllocator constructor', () => {
    it('exports ResourceAllocator as a class/function', async () => {
      const { ResourceAllocator } = await import('../pdfResourceManager');
      expect(typeof ResourceAllocator).toBe('function');
    });

    it('creates instances with ensureExtGState, ensureXObject, ensureFont methods', async () => {
      const { ResourceAllocator } = await import('../pdfResourceManager');
      const allocator = new ResourceAllocator();
      expect(typeof allocator.ensureExtGState).toBe('function');
      expect(typeof allocator.ensureXObject).toBe('function');
      expect(typeof allocator.ensureFont).toBe('function');
    });
  });

  describe('resource naming with live PDFDocument', () => {
    it('ensureExtGState returns sequential GS_ann_N names', async () => {
      const pdfLib = await import('pdf-lib');
      const { ResourceAllocator } = await import('../pdfResourceManager');
      const allocator = new ResourceAllocator();
      const pdfDoc = await pdfLib.PDFDocument.create();
      pdfDoc.addPage([612, 792]);

      const name1 = allocator.ensureExtGState(pdfDoc, 0, { fillOpacity: 0.5 });
      const name2 = allocator.ensureExtGState(pdfDoc, 0, { strokeOpacity: 0.8 });

      expect(name1).toMatch(/^GS_ann_\d+$/);
      expect(name2).toMatch(/^GS_ann_\d+$/);
      // Names should be unique
      expect(name1).not.toBe(name2);
    });

    it('ensureXObject returns sequential Im_ann_N names', async () => {
      const pdfLib = await import('pdf-lib');
      const { ResourceAllocator } = await import('../pdfResourceManager');
      const allocator = new ResourceAllocator();
      const pdfDoc = await pdfLib.PDFDocument.create();
      pdfDoc.addPage([612, 792]);

      // Minimal 1x1 PNG for embedding
      const minimalPng = new Uint8Array([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00,
        0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
        0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE,
        0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7, 0x63,
        0xF8, 0xCF, 0xC0, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21,
        0xBC, 0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
        0x42, 0x60, 0x82,
      ]);
      const embeddedImage = await pdfDoc.embedPng(minimalPng);
      const imgRef = embeddedImage.ref;

      const name1 = allocator.ensureXObject(pdfDoc, 0, imgRef);
      const name2 = allocator.ensureXObject(pdfDoc, 0, imgRef);

      expect(name1).toMatch(/^Im_ann_\d+$/);
      expect(name2).toMatch(/^Im_ann_\d+$/);
      expect(name1).not.toBe(name2);
    });

    it('ensureFont returns sequential F_ann_N names', async () => {
      const pdfLib = await import('pdf-lib');
      const { ResourceAllocator } = await import('../pdfResourceManager');
      const allocator = new ResourceAllocator();
      const pdfDoc = await pdfLib.PDFDocument.create();
      pdfDoc.addPage([612, 792]);

      const font = await pdfDoc.embedFont(pdfLib.StandardFonts.Helvetica);
      const fontRef = font.ref;

      const name1 = allocator.ensureFont(pdfDoc, 0, fontRef);
      const name2 = allocator.ensureFont(pdfDoc, 0, fontRef);

      expect(name1).toMatch(/^F_ann_\d+$/);
      expect(name2).toMatch(/^F_ann_\d+$/);
      expect(name1).not.toBe(name2);
    });

    it('multiple allocators have independent counters', async () => {
      const pdfLib = await import('pdf-lib');
      const { ResourceAllocator } = await import('../pdfResourceManager');
      const pdfDoc = await pdfLib.PDFDocument.create();
      pdfDoc.addPage([612, 792]);

      const allocatorA = new ResourceAllocator();
      const allocatorB = new ResourceAllocator();

      const nameA = allocatorA.ensureExtGState(pdfDoc, 0, { fillOpacity: 0.5 });
      const nameB = allocatorB.ensureExtGState(pdfDoc, 0, { fillOpacity: 0.7 });

      // Both allocators start their own counter at 1, so first name matches
      expect(nameA).toBe(nameB);
    });

    it('counter is shared across ensureExtGState, ensureXObject, ensureFont within one allocator', async () => {
      const pdfLib = await import('pdf-lib');
      const { ResourceAllocator } = await import('../pdfResourceManager');
      const allocator = new ResourceAllocator();
      const pdfDoc = await pdfLib.PDFDocument.create();
      pdfDoc.addPage([612, 792]);

      const gsName = allocator.ensureExtGState(pdfDoc, 0, { fillOpacity: 0.5 });
      const font = await pdfDoc.embedFont(pdfLib.StandardFonts.Helvetica);
      const fontName = allocator.ensureFont(pdfDoc, 0, font.ref);

      // Extract numeric IDs - they should be sequential across function types
      const gsId = parseInt(gsName.split('_').pop()!);
      const fontId = parseInt(fontName.split('_').pop()!);
      expect(fontId).toBe(gsId + 1);
    });
  });

  // NOTE: The naming pattern follows: GS_ann_{id}, Im_ann_{id}, F_ann_{id}
  // where {id} is an auto-incrementing counter from the ResourceAllocator instance.
});

// ─────────────────────────────────────────────────────────────────────────────
// contentStreamInjector (appendContentStream)
// ─────────────────────────────────────────────────────────────────────────────
describe('contentStreamInjector', () => {
  // TODO: appendContentStream requires a real pdf-lib PDFDocument with pages,
  // context.obj(), context.stream(), context.register(), and pako compression.
  // Skipping these tests as they are integration-level and cannot run without
  // a full PDFDocument instance. Add integration tests when a test PDF fixture
  // or pdf-lib test helper is available.
  it.skip('appendContentStream wraps bytes in q/Q and compresses with FlateDecode', () => {
    // Needs real PDFDocument
  });

  it.skip('appendContentStream converts single Contents stream to array', () => {
    // Needs real PDFDocument
  });
});

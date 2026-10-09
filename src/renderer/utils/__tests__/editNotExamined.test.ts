/**
 * Delete-text and replace-text through the real save pipeline. When a page's
 * content cannot be decoded the edit cannot know whether the text is there,
 * so the save fails with ContentNotExaminedError and the user is told the
 * text could not be examined, instead of the stream being skipped as "no
 * match" and the text covered by an overlay while staying in the file.
 */
import { describe, it, expect } from 'vitest';
import * as pako from 'pako';
import { PDFArray, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { applyEditsAndAnnotations } from '../pdfSavePipeline';
import { replaceTextInPage } from '../pdfTextReplacer';
import { blankTextInContentStream } from '../blankText';
import { ContentNotExaminedError } from '../pdfStreamUtils';
import { saveFailureMessage } from '../saveErrors';
import { decodeRawStreamBounded } from '../boundedDecode';
import type { PDFPage, PDFTextItem } from '../../types';

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** One page whose /Contents is a readable Flate stream plus `second`. */
async function twoStreamPdf(second: { filter?: string; bytes: Uint8Array }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const readable = doc.context.register(
    PDFRawStream.of(doc.context.obj({ Filter: 'FlateDecode' }), pako.deflate(latin1('BT /F1 12 Tf 20 250 Td (Public heading) Tj ET\n')))
  );
  const other = doc.context.register(
    PDFRawStream.of(doc.context.obj(second.filter ? { Filter: second.filter } : {}), second.bytes)
  );
  page.node.set(PDFName.of('Contents'), doc.context.obj([readable, other]) as PDFArray);
  return doc.save({ useObjectStreams: false });
}

function textItem(str: string, extra: Partial<PDFTextItem> = {}): PDFTextItem {
  return {
    id: 't1', str, originalStr: str, x: 20, y: 40, width: 80, height: 12,
    fontName: 'Helvetica', fontSize: 12, transform: [12, 0, 0, 12, 20, 200], isEdited: false, ...extra,
  };
}

const page = (items: PDFTextItem[], edits: PDFPage['textEdits'] = []): PDFPage => ({
  index: 0, width: 300, height: 300, rotation: 0, annotations: [], textItems: items, textEdits: edits,
});

// The second stream holds the secret but is encoded with a filter PDF Manager cannot decode.
const undecodable = { filter: 'JBIG2Decode', bytes: latin1('BT /F1 12 Tf 20 200 Td (SECRET) Tj ET\n') };

describe('text edits fail closed on content they cannot examine', () => {
  it('delete-text: the save rejects with ContentNotExaminedError and the UI says the text could not be examined', async () => {
    const pdfData = await twoStreamPdf(undecodable);
    const err = await applyEditsAndAnnotations({
      pdfData,
      pages: [page([textItem('SECRET', { isDeleted: true })])],
      annotationStorage: null,
      formFieldMappings: [],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContentNotExaminedError);
    expect((err as ContentNotExaminedError).pageIndex).toBe(0);
    expect(saveFailureMessage(err)).toMatch(/could not be examined/);
    expect(saveFailureMessage(err)).toMatch(/SECRET/);
  });

  it('replace-text: the save rejects instead of falling back to an overlay', async () => {
    const pdfData = await twoStreamPdf(undecodable);
    const err = await applyEditsAndAnnotations({
      pdfData,
      pages: [page([textItem('SECRET', { isEdited: true, str: 'PUBLIC' })], [{ itemId: 't1', pageIndex: 0, originalText: 'SECRET', newText: 'PUBLIC' }])],
      annotationStorage: null,
      formFieldMappings: [],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContentNotExaminedError);
  });

  it('replaceTextInPage and blankTextInContentStream each reject on their own (no silent false)', async () => {
    const doc = await PDFDocument.load(await twoStreamPdf(undecodable));
    await expect(replaceTextInPage(doc, 0, 'SECRET', 'PUBLIC')).rejects.toBeInstanceOf(ContentNotExaminedError);
    await expect(blankTextInContentStream(doc, 0, 'SECRET')).rejects.toBeInstanceOf(ContentNotExaminedError);
  });

  it('control: with every stream decodable, delete-text saves and the text is gone from the content', async () => {
    const pdfData = await twoStreamPdf({ filter: 'FlateDecode', bytes: pako.deflate(undecodable.bytes) });
    const out = await applyEditsAndAnnotations({
      pdfData,
      pages: [page([textItem('SECRET', { isDeleted: true })])],
      annotationStorage: null,
      formFieldMappings: [],
    });
    const lib = await PDFDocument.load(out);
    const contents = lib.getPage(0).node.lookup(PDFName.of('Contents'), PDFArray);
    const text = contents.asArray()
      .map((r) => lib.context.lookup(r))
      .map((s) => (s instanceof PDFRawStream ? Buffer.from(decodeRawStreamBounded(s)).toString('latin1') : ''))
      .join('\n');
    expect(text).not.toContain('SECRET');
    expect(text).toContain('Public heading');
  });

  it('other save failures keep the generic message', () => {
    expect(saveFailureMessage(new Error('EPERM'))).toBe('Failed to save document');
  });
});

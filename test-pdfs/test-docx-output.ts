/**
 * End-to-end DOCX generation test — converts a PDF and saves the output.
 * Usage: npx tsx test-pdfs/test-docx-output.ts test-pdfs/repair-calibration-form.pdf
 */
import * as fs from 'fs';
import * as path from 'path';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument } from 'pdf-lib';
import { analyzePage } from '../src/renderer/utils/docxGenerator/PageAnalyzer';
import { buildPageLayout } from '../src/renderer/utils/docxGenerator/LayoutAnalyzer';
import { ZipBuilder } from '../src/renderer/utils/docxGenerator/ZipBuilder';
import { StyleCollector } from '../src/renderer/utils/docxGenerator/StyleCollector';
import type { ImageElement, ImageFile, PageLayout } from '../src/renderer/utils/docxGenerator/types';
import { PT_TO_EMU, PT_TO_TWIPS } from '../src/renderer/utils/docxGenerator/types';
import {
  generateContentTypes,
  generateRootRels,
  generateDocumentRels,
  generateDocumentXml,
  generateStylesXml,
  generateSettingsXml,
  generateFontTableXml,
} from '../src/renderer/utils/docxGenerator/OoxmlParts';

async function convert(pdfPath: string): Promise<void> {
  const absPath = path.resolve(pdfPath);
  console.log(`Converting: ${path.basename(absPath)}`);

  const data = new Uint8Array(fs.readFileSync(absPath));
  const pdfJsDoc = await pdfjsLib.getDocument({ data: data.slice() }).promise;
  let pdfLibDoc: PDFDocument | null = null;
  try { pdfLibDoc = await PDFDocument.load(data, { ignoreEncryption: true }); } catch { }

  const numPages = pdfJsDoc.numPages;
  const styleCollector = new StyleCollector();
  const layouts: PageLayout[] = [];

  for (let pageIdx = 0; pageIdx < numPages; pageIdx++) {
    const page = await pdfJsDoc.getPage(pageIdx + 1);
    const scene = await analyzePage(page, pdfLibDoc, pageIdx);
    const layout = buildPageLayout(scene);

    console.log(`  Page ${pageIdx + 1}: ${layout.elements.length} layout elements`);
    for (const elem of layout.elements) {
      if (elem.type === 'table') {
        console.log(`    TABLE: ${elem.element.rows}x${elem.element.cols}`);
      } else if (elem.type === 'paragraph') {
        const preview = elem.element.texts.map(t => t.text).join(' ').substring(0, 50);
        console.log(`    PARA: texts=${elem.element.texts.length} fields=${elem.element.formFields.length} "${preview}"`);
      } else {
        console.log(`    IMAGE: ${elem.element.resourceName}`);
      }
    }

    layouts.push(layout);
    page.cleanup();
  }

  // Generate DOCX
  const hasFormFields = true;
  const uniqueImages: ImageFile[] = [];
  const allImages: ImageFile[] = [];

  const contentTypes = generateContentTypes(allImages);
  const rootRels = generateRootRels();
  const documentRels = generateDocumentRels(uniqueImages);
  const documentXml = generateDocumentXml(layouts, allImages, styleCollector);
  const stylesXml = generateStylesXml(styleCollector);
  const settingsXml = generateSettingsXml(hasFormFields);
  const fontTableXml = generateFontTableXml(styleCollector.getUsedFonts());

  const zip = new ZipBuilder();
  zip.addFileString('[Content_Types].xml', contentTypes);
  zip.addFileString('_rels/.rels', rootRels);
  zip.addFileString('word/_rels/document.xml.rels', documentRels);
  zip.addFileString('word/document.xml', documentXml);
  zip.addFileString('word/styles.xml', stylesXml);
  zip.addFileString('word/settings.xml', settingsXml);
  zip.addFileString('word/fontTable.xml', fontTableXml);

  const docxData = zip.build();

  const outPath = absPath.replace(/\.pdf$/i, '-test.docx');
  fs.writeFileSync(outPath, docxData);
  console.log(`\nOutput: ${outPath} (${docxData.length} bytes)`);

  // Also dump document.xml for inspection
  const xmlPath = absPath.replace(/\.pdf$/i, '-document.xml');
  fs.writeFileSync(xmlPath, documentXml);
  console.log(`XML dump: ${xmlPath}`);

  await pdfJsDoc.destroy();
}

const pdfPath = process.argv[2] || 'test-pdfs/repair-calibration-form.pdf';
convert(pdfPath).catch(err => { console.error('Fatal error:', err); process.exit(1); });

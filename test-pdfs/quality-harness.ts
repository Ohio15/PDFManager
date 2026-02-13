/**
 * DOCX Conversion Quality Comparison Harness
 *
 * Runs all test PDFs through the conversion pipeline, collects structured
 * metrics at each stage (source, layout, output), scores quality on 6 axes,
 * and prints an aggregate scorecard.
 *
 * Usage:
 *   npx tsx test-pdfs/quality-harness.mts
 *   npx tsx test-pdfs/quality-harness.mts test-pdfs/specific-file.pdf
 */

import fs from 'fs';
import path from 'path';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument } from 'pdf-lib';

import { analyzePage } from '../src/renderer/utils/docxGenerator/PageAnalyzer';
import { buildPageLayout } from '../src/renderer/utils/docxGenerator/LayoutAnalyzer';
import { StyleCollector } from '../src/renderer/utils/docxGenerator/StyleCollector';
import { ZipBuilder } from '../src/renderer/utils/docxGenerator/ZipBuilder';
import {
  generateContentTypes,
  generateRootRels,
  generateDocumentRels,
  generateDocumentXml,
  generateStylesXml,
  generateSettingsXml,
  generateFontTableXml,
} from '../src/renderer/utils/docxGenerator/OoxmlParts';
import type {
  PageScene,
  PageLayout,
  ImageElement,
  ImageFile,
  TextElement,
  RectElement,
} from '../src/renderer/utils/docxGenerator/types';

// Inline constant to avoid ESM/CJS interop issues
const PT_TO_EMU = 12700;

// ─── Interfaces ──────────────────────────────────────────────

interface SourceMetrics {
  pageCount: number;
  textElements: number;
  totalCharacters: number;
  uniqueTextColors: Set<string>;
  fontSizeRange: { min: number; max: number; unique: number };
  rectElements: number;
  borderRects: number;
  imageElements: number;
  genuineImages: number;
  formFields: number;
  avgFontSize: number;
}

interface LayoutMetrics {
  tables: number;
  tablesWithCustomBorders: number;
  paragraphs: number;
  paragraphsWithHeading: number;
  paragraphsWithLineSpacing: number;
  paragraphsWithIndent: number;
  images: number;
  twoColumnRegions: number;
  contentBoundsComputed: number;
  computedMargins: { left: number; top: number; right: number; bottom: number } | null;
}

interface OutputMetrics {
  totalCharactersInXml: number;
  uniqueColorsInXml: number;
  paragraphCount: number;
  headingStylesUsed: number;
  indentsUsed: number;
  lineSpacingOverrides: number;
  tableCount: number;
  customBorderColors: number;
  imagesEmbedded: number;
  marginValues: { top: number; right: number; bottom: number; left: number };
  docxSizeBytes: number;
}

interface QualityScores {
  text: number;
  color: number;
  structure: number | null;
  typography: number;
  spatial: number;
  images: number;
  composite: number;
}

interface PdfResult {
  name: string;
  source: SourceMetrics;
  layout: LayoutMetrics;
  output: OutputMetrics;
  scores: QualityScores;
  docxPath: string;
}

// ─── Metric Collection: Source ───────────────────────────────

function collectSourceMetrics(scenes: PageScene[]): SourceMetrics {
  let textElements = 0;
  let totalCharacters = 0;
  const uniqueColors = new Set<string>();
  const fontSizes = new Set<number>();
  let minFontSize = Infinity;
  let maxFontSize = 0;
  let rectElements = 0;
  let borderRects = 0;
  let imageElements = 0;
  let genuineImages = 0;
  let formFields = 0;
  let weightedFontSizeSum = 0;
  let charCount = 0;

  for (const scene of scenes) {
    formFields += scene.formFields.length;

    for (const el of scene.elements) {
      switch (el.kind) {
        case 'text': {
          const te = el as TextElement;
          textElements++;
          totalCharacters += te.text.length;
          uniqueColors.add(te.color.toUpperCase());
          fontSizes.add(te.fontSize);
          if (te.fontSize < minFontSize) minFontSize = te.fontSize;
          if (te.fontSize > maxFontSize) maxFontSize = te.fontSize;
          weightedFontSizeSum += te.fontSize * te.text.length;
          charCount += te.text.length;
          break;
        }
        case 'rect': {
          const re = el as RectElement;
          rectElements++;
          if (re.strokeColor !== null && re.lineWidth > 0) {
            borderRects++;
          }
          break;
        }
        case 'image': {
          const ie = el as ImageElement;
          imageElements++;
          if (ie.isGenuine) genuineImages++;
          break;
        }
      }
    }
  }

  return {
    pageCount: scenes.length,
    textElements,
    totalCharacters,
    uniqueTextColors: uniqueColors,
    fontSizeRange: {
      min: minFontSize === Infinity ? 0 : minFontSize,
      max: maxFontSize,
      unique: fontSizes.size,
    },
    rectElements,
    borderRects,
    imageElements,
    genuineImages,
    formFields,
    avgFontSize: charCount > 0 ? weightedFontSizeSum / charCount : 0,
  };
}

// ─── Metric Collection: Layout ───────────────────────────────

function collectLayoutMetrics(layouts: PageLayout[]): LayoutMetrics {
  let tables = 0;
  let tablesWithCustomBorders = 0;
  let paragraphs = 0;
  let paragraphsWithHeading = 0;
  let paragraphsWithLineSpacing = 0;
  let paragraphsWithIndent = 0;
  let images = 0;
  let twoColumnRegions = 0;
  let contentBoundsComputed = 0;

  // Gather margins from content bounds
  const lefts: number[] = [];
  const tops: number[] = [];
  const rights: number[] = [];
  const bottoms: number[] = [];

  for (const layout of layouts) {
    if (layout.contentBounds) {
      contentBoundsComputed++;
      lefts.push(layout.contentBounds.left);
      tops.push(layout.contentBounds.top);
      rights.push(layout.contentBounds.right);
      bottoms.push(layout.contentBounds.bottom);
    }

    // Compute approximate left margin for indent detection
    const pageLeftMargin = layout.contentBounds?.left ?? 72;

    for (const elem of layout.elements) {
      switch (elem.type) {
        case 'table':
          tables++;
          if (elem.element.borderColor !== undefined) {
            tablesWithCustomBorders++;
          }
          break;
        case 'paragraph':
          paragraphs++;
          if (elem.element.headingLevel !== undefined) {
            paragraphsWithHeading++;
          }
          if (elem.element.lineSpacingPt !== undefined && elem.element.lineSpacingPt > 0) {
            paragraphsWithLineSpacing++;
          }
          // Indent detection: X significantly (>10pt) to the right of page left margin
          if (elem.element.x > pageLeftMargin + 10) {
            paragraphsWithIndent++;
          }
          break;
        case 'image':
          images++;
          break;
        case 'two-column':
          twoColumnRegions++;
          break;
      }
    }
  }

  const computedMargins = lefts.length > 0 ? {
    left: lefts.reduce((a, b) => a + b, 0) / lefts.length,
    top: tops.reduce((a, b) => a + b, 0) / tops.length,
    right: rights.reduce((a, b) => a + b, 0) / rights.length,
    bottom: bottoms.reduce((a, b) => a + b, 0) / bottoms.length,
  } : null;

  return {
    tables,
    tablesWithCustomBorders,
    paragraphs,
    paragraphsWithHeading,
    paragraphsWithLineSpacing,
    paragraphsWithIndent,
    images,
    twoColumnRegions,
    contentBoundsComputed,
    computedMargins,
  };
}

// ─── Metric Collection: Output ───────────────────────────────

function collectOutputMetrics(documentXml: string, docxBytes: Uint8Array): OutputMetrics {
  // Count text content: extract all <w:t ...>text</w:t> values
  const textMatches = documentXml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
  const totalChars = textMatches.reduce((sum, m) => {
    const inner = m.replace(/<[^>]+>/g, '');
    return sum + inner.length;
  }, 0);

  // Count unique colors from w:color
  const colorMatches = documentXml.match(/w:color w:val="([0-9a-fA-F]{6})"/g) || [];
  const uniqueColors = new Set<string>();
  for (const m of colorMatches) {
    const val = m.match(/"([0-9a-fA-F]{6})"/);
    if (val) uniqueColors.add(val[1].toUpperCase());
  }

  // Count structural elements
  const paragraphCount = (documentXml.match(/<w:p[ >\/]/g) || []).length;
  const headingCount = (documentXml.match(/w:pStyle w:val="Heading\d"/g) || []).length;
  const indentCount = (documentXml.match(/<w:ind /g) || []).length;
  const spacingCount = (documentXml.match(/w:lineRule="exact"/g) || []).length;
  const tableCount = (documentXml.match(/<w:tbl>/g) || []).length;

  // Custom border colors (non-"auto" hex colors on border elements)
  const borderColorMatches = documentXml.match(/w:color="[0-9a-fA-F]{6}"/g) || [];
  const customBorderColors = new Set(borderColorMatches.map(m => {
    const v = m.match(/"([^"]+)"/);
    return v ? v[1] : '';
  }));

  const imageCount = (documentXml.match(/<a:blip/g) || []).length;

  // Extract margin values from w:pgMar
  let marginValues = { top: 1440, right: 1440, bottom: 1440, left: 1440 };
  const marginMatch = documentXml.match(
    /w:pgMar w:top="(\d+)" w:right="(\d+)" w:bottom="(\d+)" w:left="(\d+)"/
  );
  if (marginMatch) {
    marginValues = {
      top: parseInt(marginMatch[1], 10),
      right: parseInt(marginMatch[2], 10),
      bottom: parseInt(marginMatch[3], 10),
      left: parseInt(marginMatch[4], 10),
    };
  }

  return {
    totalCharactersInXml: totalChars,
    uniqueColorsInXml: uniqueColors.size,
    paragraphCount,
    headingStylesUsed: headingCount,
    indentsUsed: indentCount,
    lineSpacingOverrides: spacingCount,
    tableCount,
    customBorderColors: customBorderColors.size,
    imagesEmbedded: imageCount,
    marginValues,
    docxSizeBytes: docxBytes.length,
  };
}

// ─── Quality Scoring ─────────────────────────────────────────

function computeScores(
  source: SourceMetrics,
  layout: LayoutMetrics,
  output: OutputMetrics
): QualityScores {
  // 1. Text Completeness (0-100)
  const textScore = source.totalCharacters > 0
    ? Math.min(100, Math.round(output.totalCharactersInXml / source.totalCharacters * 100))
    : 100;

  // 2. Color Fidelity (0-100)
  const sourceColorCount = source.uniqueTextColors.size;
  const colorScore = sourceColorCount > 0
    ? Math.min(100, Math.round(output.uniqueColorsInXml / sourceColorCount * 100))
    : 100;

  // 3. Structure (0-100, null if no tables expected)
  let structureScore: number | null = null;
  if (source.borderRects >= 4) {
    // If there are bordered rects, we expect some tables
    structureScore = layout.tables > 0
      ? Math.min(100, Math.round(output.tableCount / layout.tables * 100))
      : 0;
  }

  // 4. Typography (0-100) — composite of heading, spacing, indent detection
  let typoPoints = 0;
  let typoMax = 0;

  // Heading detection: if font size variance exists, headings should be detected
  if (source.fontSizeRange.unique > 1 && source.fontSizeRange.max > source.avgFontSize * 1.3) {
    typoMax += 40;
    if (output.headingStylesUsed > 0) typoPoints += 40;
    else if (layout.paragraphsWithHeading > 0) typoPoints += 20;
  }

  // Line spacing: if multi-paragraph content, some spacing overrides expected
  if (layout.paragraphs > 3) {
    typoMax += 30;
    if (output.lineSpacingOverrides > 0) typoPoints += 30;
    else if (layout.paragraphsWithLineSpacing > 0) typoPoints += 15;
  }

  // Indentation: if X offsets vary, indents should appear
  if (layout.paragraphsWithIndent > 0) {
    typoMax += 30;
    if (output.indentsUsed > 0) typoPoints += 30;
  }

  const typographyScore = typoMax > 0 ? Math.round(typoPoints / typoMax * 100) : 50;

  // 5. Spatial (0-100) — margin accuracy
  let spatialScore = 50; // default if no bounds computed
  if (layout.computedMargins) {
    const PT_TO_TWIPS = 20;
    const sides = [
      { computed: layout.computedMargins.left * PT_TO_TWIPS, output: output.marginValues.left },
      { computed: layout.computedMargins.top * PT_TO_TWIPS, output: output.marginValues.top },
      { computed: layout.computedMargins.right * PT_TO_TWIPS, output: output.marginValues.right },
      { computed: layout.computedMargins.bottom * PT_TO_TWIPS, output: output.marginValues.bottom },
    ];

    let totalDev = 0;
    let measuredSides = 0;
    for (const side of sides) {
      if (side.computed > 0) {
        const deviation = Math.abs(side.output - side.computed) / side.computed;
        totalDev += deviation;
        measuredSides++;
      }
    }

    if (measuredSides > 0) {
      const avgDeviation = totalDev / measuredSides;
      spatialScore = Math.max(0, Math.min(100, Math.round((1 - avgDeviation) * 100)));
    }
  }

  // 6. Images (0-100)
  const imageScore = source.genuineImages > 0
    ? Math.min(100, Math.round(output.imagesEmbedded / source.genuineImages * 100))
    : 100;

  // Composite: weighted average
  // Text 30%, Color 15%, Structure 20%, Typography 15%, Spatial 10%, Images 10%
  const structVal = structureScore ?? 50; // use 50 if not applicable
  const structWeight = structureScore !== null ? 0.20 : 0.00;
  const redistributed = structureScore === null ? 0.20 / 5 : 0;

  const composite = Math.round(
    textScore * (0.30 + redistributed) +
    colorScore * (0.15 + redistributed) +
    structVal * structWeight +
    typographyScore * (0.15 + redistributed) +
    spatialScore * (0.10 + redistributed) +
    imageScore * (0.10 + redistributed)
  );

  return {
    text: textScore,
    color: colorScore,
    structure: structureScore,
    typography: typographyScore,
    spatial: spatialScore,
    images: imageScore,
    composite,
  };
}

// ─── Image Dedup (mirrors DocxGenerator.ts) ──────────────────

function fastHash(data: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16)}-${data.length}`;
}

function collectImages(layouts: PageLayout[]): { allImages: ImageFile[]; uniqueImages: ImageFile[] } {
  let nextRId = 4;
  let imageCounter = 0;
  const resourceDedup = new Map<string, ImageFile>();
  const contentDedup = new Map<string, ImageFile>();
  const allImages: ImageFile[] = [];
  const uniqueImages: ImageFile[] = [];

  for (const layout of layouts) {
    for (const elem of layout.elements) {
      if (elem.type !== 'image') continue;
      const imgElem = elem.element;
      if (!imgElem.isGenuine || !imgElem.data) continue;

      const existingByResource = resourceDedup.get(imgElem.resourceName);
      if (existingByResource) {
        allImages.push(existingByResource);
        continue;
      }

      const hash = fastHash(imgElem.data);
      const existingByContent = contentDedup.get(hash);
      if (existingByContent) {
        resourceDedup.set(imgElem.resourceName, existingByContent);
        allImages.push(existingByContent);
        continue;
      }

      imageCounter++;
      const rId = `rId${nextRId++}`;
      const ext = imgElem.mimeType === 'image/jpeg' ? 'jpeg' : 'png';
      const fileName = `image${imageCounter}.${ext}`;

      let widthEmu = Math.round(imgElem.width * PT_TO_EMU);
      let heightEmu = Math.round(imgElem.height * PT_TO_EMU);
      const maxDim = 6858000;
      if (widthEmu > maxDim) { const r = maxDim / widthEmu; widthEmu = maxDim; heightEmu = Math.round(heightEmu * r); }
      if (heightEmu > maxDim) { const r = maxDim / heightEmu; heightEmu = maxDim; widthEmu = Math.round(widthEmu * r); }

      const imageFile: ImageFile = {
        rId, data: imgElem.data, mimeType: imgElem.mimeType, fileName,
        resourceName: imgElem.resourceName, widthEmu, heightEmu,
      };

      resourceDedup.set(imgElem.resourceName, imageFile);
      contentDedup.set(hash, imageFile);
      allImages.push(imageFile);
      uniqueImages.push(imageFile);
    }
  }

  return { allImages, uniqueImages };
}

// ─── Process a single PDF ────────────────────────────────────

async function processPdf(pdfPath: string, resultsDir: string): Promise<PdfResult> {
  const absPath = path.resolve(pdfPath);
  const baseName = path.basename(absPath, '.pdf');

  const data = new Uint8Array(fs.readFileSync(absPath));
  const pdfJsDoc = await pdfjsLib.getDocument({ data: data.slice() }).promise;
  let pdfLibDoc: PDFDocument | null = null;
  try { pdfLibDoc = await PDFDocument.load(data, { ignoreEncryption: true }); } catch { }

  // Phase 2: Analyze pages → scene graphs
  const scenes: PageScene[] = [];
  for (let pageIdx = 0; pageIdx < pdfJsDoc.numPages; pageIdx++) {
    const page = await pdfJsDoc.getPage(pageIdx + 1);
    const scene = await analyzePage(page, pdfLibDoc, pageIdx);
    scenes.push(scene);
    page.cleanup();
  }

  // Phase 3: Build layouts
  const layouts: PageLayout[] = [];
  for (const scene of scenes) {
    const layout = await buildPageLayout(scene);
    layouts.push(layout);
  }

  // Phase 4: Image collection
  const { allImages, uniqueImages } = collectImages(layouts);

  // Phase 5: Generate OOXML
  const styleCollector = new StyleCollector();
  const hasFormFields = scenes.some(s => s.formFields.length > 0);

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
  for (const img of uniqueImages) {
    zip.addFile(`word/media/${img.fileName}`, img.data);
  }

  const docxData = zip.build();

  // Save DOCX
  const docxPath = path.join(resultsDir, `${baseName}.docx`);
  fs.writeFileSync(docxPath, docxData);

  // Collect metrics
  const source = collectSourceMetrics(scenes);
  const layout = collectLayoutMetrics(layouts);
  const output = collectOutputMetrics(documentXml, docxData);
  const scores = computeScores(source, layout, output);

  // Save per-PDF detail JSON
  const detailPath = path.join(resultsDir, `${baseName}.json`);
  fs.writeFileSync(detailPath, JSON.stringify({
    name: baseName,
    source: {
      ...source,
      uniqueTextColors: Array.from(source.uniqueTextColors),
    },
    layout,
    output,
    scores,
  }, null, 2));

  await pdfJsDoc.destroy();

  return { name: baseName, source, layout, output, scores, docxPath };
}

// ─── Scorecard Formatting ────────────────────────────────────

function pad(str: string, len: number): string {
  return str.length >= len ? str.substring(0, len) : str + ' '.repeat(len - str.length);
}

function padNum(n: number | null, len: number): string {
  if (n === null) return pad('--', len);
  return pad(String(n), len);
}

function formatScorecard(results: PdfResult[], version: string): string {
  const lines: string[] = [];
  const W = 82;
  const border = '\u2550'.repeat(W - 2);

  lines.push(`\u2554${border}\u2557`);
  lines.push(`\u2551 ${pad(`DOCX Conversion Quality Report \u2014 v${version}`, W - 4)} \u2551`);
  lines.push(`\u2560${border}\u2563`);

  // Header
  const header = ` ${pad('PDF', 30)} ${pad('Text', 5)} ${pad('Color', 5)} ${pad('Struc', 5)} ${pad('Typo', 5)} ${pad('Space', 5)} ${pad('Image', 5)} ${pad('\u03A3', 4)}`;
  lines.push(`\u2551${pad(header, W - 2)}\u2551`);

  // Data rows
  for (const r of results) {
    const row = ` ${pad(r.name, 30)} ${padNum(r.scores.text, 5)} ${padNum(r.scores.color, 5)} ${padNum(r.scores.structure, 5)} ${padNum(r.scores.typography, 5)} ${padNum(r.scores.spatial, 5)} ${padNum(r.scores.images, 5)} ${padNum(r.scores.composite, 4)}`;
    lines.push(`\u2551${pad(row, W - 2)}\u2551`);
  }

  // Separator
  lines.push(`\u2560${border}\u2563`);

  // Averages
  const avg = (fn: (r: PdfResult) => number | null): number => {
    const vals = results.map(fn).filter((v): v is number => v !== null);
    return vals.length > 0 ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
  };

  const avgText = avg(r => r.scores.text);
  const avgColor = avg(r => r.scores.color);
  const avgStruct = avg(r => r.scores.structure);
  const avgTypo = avg(r => r.scores.typography);
  const avgSpace = avg(r => r.scores.spatial);
  const avgImage = avg(r => r.scores.images);
  const avgComposite = avg(r => r.scores.composite);

  const avgRow = ` ${pad('AVERAGE', 30)} ${padNum(avgText, 5)} ${padNum(avgColor, 5)} ${padNum(avgStruct > 0 ? avgStruct : null, 5)} ${padNum(avgTypo, 5)} ${padNum(avgSpace, 5)} ${padNum(avgImage, 5)} ${padNum(avgComposite, 4)}`;
  lines.push(`\u2551${pad(avgRow, W - 2)}\u2551`);

  // Find weakest axis
  const axes: { name: string; score: number; recommendation: string }[] = [
    { name: 'Text Completeness', score: avgText, recommendation: 'Improve text extraction and character preservation' },
    { name: 'Color Fidelity', score: avgColor, recommendation: 'Improve text color recovery accuracy' },
    { name: 'Structure', score: avgStruct, recommendation: 'Improve table detection from vector borders' },
    { name: 'Typography', score: avgTypo, recommendation: 'Improve heading detection, line spacing, and indent handling' },
    { name: 'Spatial', score: avgSpace, recommendation: 'Improve margin computation from content bounds' },
    { name: 'Images', score: avgImage, recommendation: 'Improve image extraction and embedding pipeline' },
  ];

  const weakest = axes.reduce((a, b) => a.score <= b.score ? a : b);

  const weakLine = ` WEAKEST AXIS: ${weakest.name} (${weakest.score}/100)`;
  lines.push(`\u2551${pad(weakLine, W - 2)}\u2551`);
  const recLine = ` RECOMMENDED FOCUS: ${weakest.recommendation}`;
  lines.push(`\u2551${pad(recLine, W - 2)}\u2551`);

  lines.push(`\u255A${border}\u255D`);

  return lines.join('\n');
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const scriptDir = path.resolve(__dirname);
  const resultsDir = path.join(scriptDir, 'quality-results');

  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  // Read version from package.json
  const pkgPath = path.resolve(scriptDir, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const version = pkg.version;

  // Determine which PDFs to process
  let pdfPaths: string[];
  if (process.argv[2]) {
    pdfPaths = [path.resolve(process.argv[2])];
  } else {
    // Find all PDFs in test-pdfs/ (exclude synthetic test outputs)
    const allFiles = fs.readdirSync(scriptDir);
    pdfPaths = allFiles
      .filter(f => f.endsWith('.pdf') && !f.includes('test-with-images'))
      .map(f => path.join(scriptDir, f));
  }

  if (pdfPaths.length === 0) {
    console.error('No PDF files found in test-pdfs/');
    process.exit(1);
  }

  console.log(`\nProcessing ${pdfPaths.length} PDF(s)...\n`);

  const results: PdfResult[] = [];
  for (const pdfPath of pdfPaths) {
    const baseName = path.basename(pdfPath, '.pdf');
    process.stdout.write(`  ${pad(baseName, 30)}`);
    try {
      const result = await processPdf(pdfPath, resultsDir);
      results.push(result);
      console.log(`done  (composite: ${result.scores.composite})`);
    } catch (err: any) {
      console.log(`FAILED: ${err.message}`);
    }
  }

  // Print scorecard
  console.log('\n' + formatScorecard(results, version));

  // Save summary JSON
  const axisAvg = (fn: (r: PdfResult) => number | null): number => {
    const vals = results.map(fn).filter((v): v is number => v !== null);
    return vals.length > 0 ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
  };

  const axes = {
    text: axisAvg(r => r.scores.text),
    color: axisAvg(r => r.scores.color),
    structure: axisAvg(r => r.scores.structure),
    typography: axisAvg(r => r.scores.typography),
    spatial: axisAvg(r => r.scores.spatial),
    images: axisAvg(r => r.scores.images),
  };

  const allAxisEntries = Object.entries(axes) as [string, number][];
  const weakest = allAxisEntries.reduce((a, b) => a[1] <= b[1] ? a : b);

  const summary = {
    version,
    timestamp: new Date().toISOString(),
    composite: axisAvg(r => r.scores.composite),
    axes,
    weakest: weakest[0],
    perPdf: Object.fromEntries(results.map(r => [r.name, {
      composite: r.scores.composite,
      text: r.scores.text,
      color: r.scores.color,
      structure: r.scores.structure,
      typography: r.scores.typography,
      spatial: r.scores.spatial,
      images: r.scores.images,
    }])),
  };

  const summaryPath = path.join(resultsDir, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  // Also save a versioned copy for historical comparison
  const versionedPath = path.join(resultsDir, `summary-v${version}.json`);
  fs.writeFileSync(versionedPath, JSON.stringify(summary, null, 2));

  console.log(`\nResults saved to: ${resultsDir}/`);
  console.log(`  summary.json (latest)`);
  console.log(`  summary-v${version}.json (versioned)`);
  console.log(`  ${results.length} DOCX files + detail JSON files\n`);
}

main().catch(err => {
  console.error('Quality harness failed:', err);
  process.exit(1);
});

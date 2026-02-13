/**
 * Positioned OOXML Parts Generator
 *
 * Generates DOCX document.xml using absolute-positioned text boxes and images
 * for 1:1 visual fidelity with the source PDF. Each text element becomes a
 * WordprocessingML text box anchored at its exact PDF coordinate.
 *
 * Key OOXML structures used:
 *   - wp:anchor with absolute positionH/positionV for positioning
 *   - wps:wsp with wps:txbx for text boxes
 *   - pic:pic inside wp:anchor for images
 *   - Background rectangles as filled shapes with behindDoc="true"
 *
 * Coordinate conversion: 1 PDF point = 12700 EMU (PT_TO_EMU)
 *
 * Z-ordering:
 *   - Background rects: 0-999
 *   - Images: 1000-1999
 *   - Text boxes: 2000+
 *
 * Page margins are zero — all positioning is absolute from page origin.
 */

import type {
  PageScene,
  TextElement,
  RectElement,
  ImageElement,
  FormField,
  ImageFile,
  RGB,
} from './types';
import { PT_TO_EMU, PT_TO_TWIPS } from './types';
import { StyleCollector } from './StyleCollector';
import {
  escXml,
  DOC_NS,
  mapFontName,
  rgbToHex,
  BASELINE_TOL,
  WORD_GAP_FACTOR,
  renderTextRunsFromElements,
  generateFormFieldRuns,
} from './OoxmlUtils';

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

/** Gap factor for grouping adjacent text into a single text box */
const TEXT_GROUP_GAP_FACTOR = 0.3;

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

/** A group of adjacent text elements on the same baseline that form a single text box */
interface TextGroup {
  elements: TextElement[];
  x: number;
  y: number;
  width: number;
  height: number;
}

// ────────────────────────────────────────────────────────────
// Main Entry Point
// ────────────────────────────────────────────────────────────

/**
 * Generate word/document.xml using positioned text boxes for 1:1 PDF fidelity.
 *
 * Each page becomes a separate section with zero margins.
 * Text elements are placed as absolutely-positioned text boxes.
 * Images are placed as absolutely-positioned anchored pictures.
 * Background rectangles are placed as shapes behind text.
 */
export function generatePositionedDocumentXml(
  scenes: PageScene[],
  images: ImageFile[],
  styleCollector: StyleCollector,
  pageBackgrounds: ImageFile[] = [],
  editableTextSets: Set<number>[] = [],
): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += `<w:document ${DOC_NS}>\n`;
  xml += '<w:body>\n';

  const normalStyle = styleCollector.getNormalStyle();
  let docPrId = 1; // Global unique ID counter for wp:docPr

  for (let pageIdx = 0; pageIdx < scenes.length; pageIdx++) {
    const scene = scenes[pageIdx];
    const pgWEmu = Math.round(scene.width * PT_TO_EMU);
    const pgHEmu = Math.round(scene.height * PT_TO_EMU);
    const pgWTwips = Math.round(scene.width * PT_TO_TWIPS);
    const pgHTwips = Math.round(scene.height * PT_TO_TWIPS);

    // Collect all positioned elements for this page
    const positionedElements: string[] = [];

    // ─── Full-Page Background Image (Z: 0) ──────────────
    // Rendered from the PDF page via canvas — captures all vector graphics,
    // borders, logos, paths, and decorative elements for 1:1 fidelity.
    const bgImage = pageBackgrounds.find(bg => bg.resourceName === `__page_bg_${pageIdx}`);
    if (bgImage) {
      let bgXml = '<w:drawing>\n';
      bgXml += `<wp:anchor simplePos="false" relativeHeight="0" behindDoc="true" locked="false" layoutInCell="true" allowOverlap="true">\n`;
      bgXml += '<wp:simplePos x="0" y="0"/>\n';
      bgXml += '<wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH>\n';
      bgXml += '<wp:positionV relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionV>\n';
      bgXml += `<wp:extent cx="${bgImage.widthEmu}" cy="${bgImage.heightEmu}"/>\n`;
      bgXml += '<wp:effectExtent l="0" t="0" r="0" b="0"/>\n';
      bgXml += '<wp:wrapNone/>\n';
      bgXml += `<wp:docPr id="${docPrId}" name="PageBackground ${pageIdx + 1}"/>\n`;
      docPrId++;

      bgXml += '<a:graphic>\n';
      bgXml += '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">\n';
      bgXml += '<pic:pic>\n';
      bgXml += '<pic:nvPicPr>\n';
      bgXml += `  <pic:cNvPr id="${docPrId - 1}" name="${escXml(bgImage.fileName)}"/>\n`;
      bgXml += '  <pic:cNvPicPr/>\n';
      bgXml += '</pic:nvPicPr>\n';
      bgXml += '<pic:blipFill>\n';
      bgXml += `  <a:blip r:embed="${bgImage.rId}"/>\n`;
      bgXml += '  <a:stretch><a:fillRect/></a:stretch>\n';
      bgXml += '</pic:blipFill>\n';
      bgXml += '<pic:spPr>\n';
      bgXml += '  <a:xfrm>\n';
      bgXml += '    <a:off x="0" y="0"/>\n';
      bgXml += `    <a:ext cx="${bgImage.widthEmu}" cy="${bgImage.heightEmu}"/>\n`;
      bgXml += '  </a:xfrm>\n';
      bgXml += '  <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>\n';
      bgXml += '</pic:spPr>\n';
      bgXml += '</pic:pic>\n';
      bgXml += '</a:graphicData>\n';
      bgXml += '</a:graphic>\n';
      bgXml += '</wp:anchor>\n';
      bgXml += '</w:drawing>\n';

      positionedElements.push(bgXml);
      console.log(`[PositionedOoxmlParts] Page ${pageIdx}: background image ${bgImage.fileName} (${bgImage.data.length} bytes, rId=${bgImage.rId})`);
    }

    // ─── Background Rectangles (Z: 1-999) ──────────────
    // When a full-page background image is present, skip individual rects
    // (they're already captured in the rasterized background).
    if (!bgImage) {
      let rectZ = 1;
      for (const elem of scene.elements) {
        if (elem.kind !== 'rect') continue;
        const rect = elem as RectElement;
        if (!rect.fillColor) continue;
        if (rect.width < 5 || rect.height < 5) continue;
        const shapeXml = generatePositionedRect(rect, docPrId++, rectZ++);
        positionedElements.push(shapeXml);
      }
    }

    // ─── Standalone Images (Z: 1000-1999) ────────────────
    // When a full-page background is present, bitmap images are already
    // captured in the rasterized background. Only emit standalone images
    // when there's no background (fallback).
    if (!bgImage) {
      let imgZ = 1000;
      for (const elem of scene.elements) {
        if (elem.kind !== 'image') continue;
        const imgElem = elem as ImageElement;
        if (!imgElem.data) continue;
        const imgXml = generatePositionedImage(imgElem, images, docPrId++, imgZ++);
        if (imgXml) positionedElements.push(imgXml);
      }
    }

    // ─── Text Boxes (Z: 2000+) ──────────────────────────
    // Only create text box overlays for "editable" text elements — text that was
    // erased from the background image. Text inside graphical regions (logos,
    // diagrams) stays in the background image and is NOT made editable.
    let textZ = 2000;
    const editableIndices = editableTextSets[pageIdx] || new Set<number>();

    // Filter to only editable text elements
    const editableTextElements: TextElement[] = [];
    for (let ei = 0; ei < scene.elements.length; ei++) {
      if (scene.elements[ei].kind === 'text' && editableIndices.has(ei)) {
        editableTextElements.push(scene.elements[ei] as TextElement);
      }
    }

    const textGroups = groupAdjacentTextElements(editableTextElements);

    for (const group of textGroups) {
      const tbXml = generatePositionedTextBox(
        group, normalStyle, styleCollector, docPrId++, textZ++
      );
      positionedElements.push(tbXml);
    }

    // ─── Form Fields (Z: 3000+) ─────────────────────────
    // Form field areas are erased from the background image, so these
    // functional form field overlays provide editability.
    let formZ = 3000;
    for (const field of scene.formFields) {
      const ffXml = generatePositionedFormField(field, docPrId++, formZ++);
      positionedElements.push(ffXml);
    }

    // Emit ALL positioned elements inside a SINGLE paragraph per page.
    // Since wp:anchor with wrapNone doesn't consume inline space, all elements
    // float freely at their absolute coordinates. Using one paragraph avoids
    // the flow-space problem where hundreds of <w:p> elements push content
    // to subsequent pages.
    xml += '<w:p>\n';
    for (const elemXml of positionedElements) {
      xml += '<w:r>\n';
      xml += elemXml;
      xml += '</w:r>\n';
    }
    xml += '</w:p>\n';

    // Section properties for this page (continuous sections, zero margins)
    // Last page: final sectPr goes outside the loop (in w:body)
    if (pageIdx < scenes.length - 1) {
      xml += '<w:p>\n<w:pPr>\n<w:sectPr>\n';
      xml += `  <w:pgSz w:w="${pgWTwips}" w:h="${pgHTwips}"/>\n`;
      xml += '  <w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/>\n';
      xml += '  <w:cols w:space="720"/>\n';
      xml += '</w:sectPr>\n</w:pPr>\n</w:p>\n';
    }
  }

  // Final section properties (for the last page)
  const lastScene = scenes[scenes.length - 1];
  const finalPgW = lastScene ? Math.round(lastScene.width * PT_TO_TWIPS) : 12240;
  const finalPgH = lastScene ? Math.round(lastScene.height * PT_TO_TWIPS) : 15840;

  xml += '<w:sectPr>\n';
  xml += `  <w:pgSz w:w="${finalPgW}" w:h="${finalPgH}"/>\n`;
  xml += '  <w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/>\n';
  xml += '  <w:cols w:space="720"/>\n';
  xml += '</w:sectPr>\n';

  xml += '</w:body>\n';
  xml += '</w:document>';
  return xml;
}

// ────────────────────────────────────────────────────────────
// Text Grouping Algorithm
// ────────────────────────────────────────────────────────────

/**
 * Group adjacent text elements on the same baseline into text groups.
 *
 * Algorithm:
 * 1. Sort text elements by Y then X
 * 2. Group by baseline (tolerance 3pt)
 * 3. Within a baseline: merge adjacent elements where gap < fontSize * 0.3
 * 4. Each group becomes a single text box with multiple runs
 */
function groupAdjacentTextElements(texts: TextElement[]): TextGroup[] {
  if (texts.length === 0) return [];

  // Sort by Y first, then X
  const sorted = [...texts].sort((a, b) => {
    const yDiff = a.y - b.y;
    if (Math.abs(yDiff) > BASELINE_TOL) return yDiff;
    return a.x - b.x;
  });

  // Group by baseline
  const baselines: TextElement[][] = [];
  let currentBaseline: TextElement[] = [sorted[0]];
  let currentY = sorted[0].y;

  for (let i = 1; i < sorted.length; i++) {
    const elem = sorted[i];
    if (Math.abs(elem.y - currentY) <= BASELINE_TOL) {
      currentBaseline.push(elem);
    } else {
      currentBaseline.sort((a, b) => a.x - b.x);
      baselines.push(currentBaseline);
      currentBaseline = [elem];
      currentY = elem.y;
    }
  }
  currentBaseline.sort((a, b) => a.x - b.x);
  baselines.push(currentBaseline);

  // Within each baseline, merge adjacent elements into groups
  const groups: TextGroup[] = [];

  for (const baseline of baselines) {
    let currentGroup: TextElement[] = [baseline[0]];

    for (let i = 1; i < baseline.length; i++) {
      const prev = baseline[i - 1];
      const curr = baseline[i];
      const gap = curr.x - (prev.x + prev.width);
      const threshold = curr.fontSize * TEXT_GROUP_GAP_FACTOR;

      // Merge if gap is small enough (same word/phrase)
      // Also merge if gap is moderate but formatting is identical
      if (gap < threshold * 3) {
        currentGroup.push(curr);
      } else {
        groups.push(buildTextGroup(currentGroup));
        currentGroup = [curr];
      }
    }
    groups.push(buildTextGroup(currentGroup));
  }

  return groups;
}

/**
 * Build a TextGroup from a list of adjacent TextElements.
 */
function buildTextGroup(elements: TextElement[]): TextGroup {
  const x = Math.min(...elements.map(e => e.x));
  const y = Math.min(...elements.map(e => e.y));
  const maxRight = Math.max(...elements.map(e => e.x + e.width));
  const maxBottom = Math.max(...elements.map(e => e.y + e.height));
  return {
    elements,
    x,
    y,
    width: maxRight - x,
    height: maxBottom - y,
  };
}

// ────────────────────────────────────────────────────────────
// Positioned Text Box Generator
// ────────────────────────────────────────────────────────────

/**
 * Generate a positioned text box from a TextGroup.
 *
 * Uses wp:anchor with absolute positioning from page origin.
 * The text box has zero internal margins and no border or fill.
 * Text runs preserve original font, size, color, bold/italic.
 */
function generatePositionedTextBox(
  group: TextGroup,
  normalStyle: ReturnType<StyleCollector['getNormalStyle']>,
  styleCollector: StyleCollector,
  docPrId: number,
  zOrder: number,
): string {
  // Match eraser origin: eraser uses 3pt padding from top-left of text group
  const xEmu = Math.round((group.x - 3) * PT_TO_EMU);
  const yEmu = Math.round((group.y - 3) * PT_TO_EMU);
  // Match eraser extent: eraser adds 6pt total (3pt each side)
  const wEmu = Math.round((group.width + 6) * PT_TO_EMU);
  const hEmu = Math.round((group.height + 6) * PT_TO_EMU);

  let xml = '<w:drawing>\n';
  xml += `<wp:anchor simplePos="false" relativeHeight="${zOrder}" behindDoc="false" locked="false" layoutInCell="true" allowOverlap="true">\n`;
  xml += '<wp:simplePos x="0" y="0"/>\n';
  xml += '<wp:positionH relativeFrom="page">\n';
  xml += `  <wp:posOffset>${xEmu}</wp:posOffset>\n`;
  xml += '</wp:positionH>\n';
  xml += '<wp:positionV relativeFrom="page">\n';
  xml += `  <wp:posOffset>${yEmu}</wp:posOffset>\n`;
  xml += '</wp:positionV>\n';
  xml += `<wp:extent cx="${wEmu}" cy="${hEmu}"/>\n`;
  xml += '<wp:effectExtent l="0" t="0" r="0" b="0"/>\n';
  xml += '<wp:wrapNone/>\n';
  xml += `<wp:docPr id="${docPrId}" name="TextBox ${docPrId}"/>\n`;

  xml += '<a:graphic>\n';
  xml += '<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">\n';
  xml += '<wps:wsp>\n';
  xml += '<wps:cNvSpPr txBox="1"/>\n';
  xml += '<wps:spPr>\n';
  xml += `  <a:xfrm><a:off x="0" y="0"/><a:ext cx="${wEmu}" cy="${hEmu}"/></a:xfrm>\n`;
  xml += '  <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>\n';
  xml += '  <a:noFill/>\n';
  xml += '  <a:ln><a:noFill/></a:ln>\n';
  xml += '</wps:spPr>\n';

  xml += '<wps:txbx>\n';
  xml += '<w:txbxContent>\n';

  // Render text runs inside the text box
  xml += '<w:p>\n';
  xml += renderTextRunsFromElements(group.elements, normalStyle, styleCollector);
  xml += '</w:p>\n';

  xml += '</w:txbxContent>\n';
  xml += '</wps:txbx>\n';

  // Body properties: 3pt insets to offset text within the expanded box (matches eraser padding)
  xml += '<wps:bodyPr wrap="square" lIns="38100" tIns="38100" rIns="38100" bIns="0" anchor="t">\n';
  xml += '  <a:noAutofit/>\n';
  xml += '</wps:bodyPr>\n';

  xml += '</wps:wsp>\n';
  xml += '</a:graphicData>\n';
  xml += '</a:graphic>\n';

  xml += '</wp:anchor>\n';
  xml += '</w:drawing>\n';

  return xml;
}

// ────────────────────────────────────────────────────────────
// Positioned Image Generator
// ────────────────────────────────────────────────────────────

/**
 * Generate a positioned image using wp:anchor with absolute coordinates.
 */
function generatePositionedImage(
  imgElem: ImageElement,
  images: ImageFile[],
  docPrId: number,
  zOrder: number,
): string | null {
  const imgFile = images.find(img => img.resourceName === imgElem.resourceName);
  if (!imgFile) return null;

  const xEmu = Math.round(imgElem.x * PT_TO_EMU);
  const yEmu = Math.round(imgElem.y * PT_TO_EMU);
  const wEmu = imgFile.widthEmu > 0 ? imgFile.widthEmu : Math.round(imgElem.width * PT_TO_EMU);
  const hEmu = imgFile.heightEmu > 0 ? imgFile.heightEmu : Math.round(imgElem.height * PT_TO_EMU);

  let xml = '<w:drawing>\n';
  xml += `<wp:anchor simplePos="false" relativeHeight="${zOrder}" behindDoc="false" locked="false" layoutInCell="true" allowOverlap="true">\n`;
  xml += '<wp:simplePos x="0" y="0"/>\n';
  xml += '<wp:positionH relativeFrom="page">\n';
  xml += `  <wp:posOffset>${xEmu}</wp:posOffset>\n`;
  xml += '</wp:positionH>\n';
  xml += '<wp:positionV relativeFrom="page">\n';
  xml += `  <wp:posOffset>${yEmu}</wp:posOffset>\n`;
  xml += '</wp:positionV>\n';
  xml += `<wp:extent cx="${wEmu}" cy="${hEmu}"/>\n`;
  xml += '<wp:effectExtent l="0" t="0" r="0" b="0"/>\n';
  xml += '<wp:wrapNone/>\n';
  xml += `<wp:docPr id="${docPrId}" name="Picture ${docPrId}"/>\n`;

  xml += '<a:graphic>\n';
  xml += '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">\n';
  xml += '<pic:pic>\n';
  xml += '<pic:nvPicPr>\n';
  xml += `  <pic:cNvPr id="${docPrId}" name="${escXml(imgFile.fileName)}"/>\n`;
  xml += '  <pic:cNvPicPr/>\n';
  xml += '</pic:nvPicPr>\n';
  xml += '<pic:blipFill>\n';
  xml += `  <a:blip r:embed="${imgFile.rId}"/>\n`;
  xml += '  <a:stretch><a:fillRect/></a:stretch>\n';
  xml += '</pic:blipFill>\n';
  xml += '<pic:spPr>\n';
  xml += '  <a:xfrm>\n';
  xml += '    <a:off x="0" y="0"/>\n';
  xml += `    <a:ext cx="${wEmu}" cy="${hEmu}"/>\n`;
  xml += '  </a:xfrm>\n';
  xml += '  <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>\n';
  xml += '</pic:spPr>\n';
  xml += '</pic:pic>\n';
  xml += '</a:graphicData>\n';
  xml += '</a:graphic>\n';

  xml += '</wp:anchor>\n';
  xml += '</w:drawing>\n';

  return xml;
}

// ────────────────────────────────────────────────────────────
// Positioned Rectangle Generator
// ────────────────────────────────────────────────────────────

/**
 * Generate a positioned filled rectangle (background, cell fill, etc.)
 * using wp:anchor with behindDoc="true" so text renders on top.
 */
function generatePositionedRect(
  rect: RectElement,
  docPrId: number,
  zOrder: number,
): string {
  const xEmu = Math.round(rect.x * PT_TO_EMU);
  const yEmu = Math.round(rect.y * PT_TO_EMU);
  const wEmu = Math.round(rect.width * PT_TO_EMU);
  const hEmu = Math.round(rect.height * PT_TO_EMU);

  const fillHex = rect.fillColor ? rgbToHex(rect.fillColor) : 'FFFFFF';

  let xml = '<w:drawing>\n';
  xml += `<wp:anchor simplePos="false" relativeHeight="${zOrder}" behindDoc="true" locked="false" layoutInCell="true" allowOverlap="true">\n`;
  xml += '<wp:simplePos x="0" y="0"/>\n';
  xml += '<wp:positionH relativeFrom="page">\n';
  xml += `  <wp:posOffset>${xEmu}</wp:posOffset>\n`;
  xml += '</wp:positionH>\n';
  xml += '<wp:positionV relativeFrom="page">\n';
  xml += `  <wp:posOffset>${yEmu}</wp:posOffset>\n`;
  xml += '</wp:positionV>\n';
  xml += `<wp:extent cx="${wEmu}" cy="${hEmu}"/>\n`;
  xml += '<wp:effectExtent l="0" t="0" r="0" b="0"/>\n';
  xml += '<wp:wrapNone/>\n';
  xml += `<wp:docPr id="${docPrId}" name="Rectangle ${docPrId}"/>\n`;

  xml += '<a:graphic>\n';
  xml += '<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">\n';
  xml += '<wps:wsp>\n';
  xml += '<wps:cNvSpPr/>\n';
  xml += '<wps:spPr>\n';
  xml += `  <a:xfrm><a:off x="0" y="0"/><a:ext cx="${wEmu}" cy="${hEmu}"/></a:xfrm>\n`;
  xml += '  <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>\n';
  xml += `  <a:solidFill><a:srgbClr val="${fillHex}"/></a:solidFill>\n`;

  // Add stroke if the rect has a stroke color
  if (rect.strokeColor && rect.lineWidth > 0) {
    const strokeHex = rgbToHex(rect.strokeColor);
    const strokeWidthEmu = Math.round(rect.lineWidth * PT_TO_EMU);
    xml += `  <a:ln w="${strokeWidthEmu}"><a:solidFill><a:srgbClr val="${strokeHex}"/></a:solidFill></a:ln>\n`;
  } else {
    xml += '  <a:ln><a:noFill/></a:ln>\n';
  }

  xml += '</wps:spPr>\n';
  xml += '<wps:bodyPr/>\n';
  xml += '</wps:wsp>\n';
  xml += '</a:graphicData>\n';
  xml += '</a:graphic>\n';

  xml += '</wp:anchor>\n';
  xml += '</w:drawing>\n';

  return xml;
}

// ────────────────────────────────────────────────────────────
// Positioned Form Field Generator
// ────────────────────────────────────────────────────────────

/**
 * Generate a positioned form field as a text box at the field's PDF coordinates.
 * The text box contains the appropriate legacy form field runs.
 */
function generatePositionedFormField(
  field: FormField,
  docPrId: number,
  zOrder: number,
): string {
  // Match eraser origin: eraser uses 3pt padding from top-left of form field
  const xEmu = Math.round((field.x - 3) * PT_TO_EMU);
  const yEmu = Math.round((field.y - 3) * PT_TO_EMU);
  // Match eraser extent: eraser adds 6pt total (3pt each side)
  const wEmu = Math.round((field.width + 6) * PT_TO_EMU);
  const hEmu = Math.round((field.height + 6) * PT_TO_EMU);

  let xml = '<w:drawing>\n';
  xml += `<wp:anchor simplePos="false" relativeHeight="${zOrder}" behindDoc="false" locked="false" layoutInCell="true" allowOverlap="true">\n`;
  xml += '<wp:simplePos x="0" y="0"/>\n';
  xml += '<wp:positionH relativeFrom="page">\n';
  xml += `  <wp:posOffset>${xEmu}</wp:posOffset>\n`;
  xml += '</wp:positionH>\n';
  xml += '<wp:positionV relativeFrom="page">\n';
  xml += `  <wp:posOffset>${yEmu}</wp:posOffset>\n`;
  xml += '</wp:positionV>\n';
  xml += `<wp:extent cx="${wEmu}" cy="${hEmu}"/>\n`;
  xml += '<wp:effectExtent l="0" t="0" r="0" b="0"/>\n';
  xml += '<wp:wrapNone/>\n';
  xml += `<wp:docPr id="${docPrId}" name="FormField ${docPrId}"/>\n`;

  xml += '<a:graphic>\n';
  xml += '<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">\n';
  xml += '<wps:wsp>\n';
  xml += '<wps:cNvSpPr txBox="1"/>\n';
  xml += '<wps:spPr>\n';
  xml += `  <a:xfrm><a:off x="0" y="0"/><a:ext cx="${wEmu}" cy="${hEmu}"/></a:xfrm>\n`;
  xml += '  <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>\n';
  xml += '  <a:noFill/>\n';
  xml += '  <a:ln><a:noFill/></a:ln>\n';
  xml += '</wps:spPr>\n';

  xml += '<wps:txbx>\n';
  xml += '<w:txbxContent>\n';
  xml += '<w:p>\n';
  xml += generateFormFieldRuns(field);
  xml += '</w:p>\n';
  xml += '</w:txbxContent>\n';
  xml += '</wps:txbx>\n';

  // 3pt insets to offset content within the expanded box (matches eraser padding)
  xml += '<wps:bodyPr wrap="square" lIns="38100" tIns="38100" rIns="38100" bIns="0" anchor="t">\n';
  xml += '  <a:noAutofit/>\n';
  xml += '</wps:bodyPr>\n';

  xml += '</wps:wsp>\n';
  xml += '</a:graphicData>\n';
  xml += '</a:graphic>\n';

  xml += '</wp:anchor>\n';
  xml += '</w:drawing>\n';

  return xml;
}

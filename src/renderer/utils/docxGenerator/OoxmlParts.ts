/**
 * OOXML Parts Generator
 *
 * Generates all XML parts for a valid DOCX file.
 * Key constraint: DrawingML ONLY — no VML, no mc:AlternateContent, no w:pict.
 *
 * Generated parts:
 * - [Content_Types].xml
 * - _rels/.rels
 * - word/_rels/document.xml.rels
 * - word/document.xml
 * - word/styles.xml
 * - word/settings.xml
 * - word/fontTable.xml
 */

import type { DocxPage, DocxParagraph, DocxRun, DocxImage, DocxStyle } from './types';
import { StyleCollector } from './StyleCollector';

/** Escape XML special characters */
function escXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// OOXML namespace declarations used in document.xml
const DOC_NS = [
  'xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"',
  'xmlns:mo="http://schemas.microsoft.com/office/mac/office/2008/main"',
  'xmlns:mv="urn:schemas-microsoft-com:mac:vml"',
  'xmlns:o="urn:schemas-microsoft-com:office:office"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"',
  'xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"',
  'xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"',
  'xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"',
  'xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"',
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
].join(' ');

/**
 * Generate [Content_Types].xml
 */
export function generateContentTypes(images: DocxImage[]): string {
  const hasJpeg = images.some(img => img.mimeType === 'image/jpeg');
  const hasPng = images.some(img => img.mimeType === 'image/png');

  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n';
  xml += '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n';
  xml += '  <Default Extension="xml" ContentType="application/xml"/>\n';
  if (hasJpeg) {
    xml += '  <Default Extension="jpeg" ContentType="image/jpeg"/>\n';
  }
  if (hasPng) {
    xml += '  <Default Extension="png" ContentType="image/png"/>\n';
  }
  xml += '  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>\n';
  xml += '  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>\n';
  xml += '  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>\n';
  xml += '  <Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>\n';
  xml += '</Types>';
  return xml;
}

/**
 * Generate _rels/.rels (root relationships)
 */
export function generateRootRels(): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n';
  xml += '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>\n';
  xml += '</Relationships>';
  return xml;
}

/**
 * Generate word/_rels/document.xml.rels
 */
export function generateDocumentRels(images: DocxImage[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n';
  xml += '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>\n';
  xml += '  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>\n';
  xml += '  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/>\n';

  for (const img of images) {
    xml += `  <Relationship Id="${img.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${img.fileName}"/>\n`;
  }

  xml += '</Relationships>';
  return xml;
}

/**
 * Generate word/document.xml
 *
 * Pure DrawingML output — no VML, no mc:AlternateContent.
 */
export function generateDocumentXml(
  pages: DocxPage[],
  images: DocxImage[],
  styleCollector: StyleCollector
): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += `<w:document ${DOC_NS}>\n`;
  xml += '<w:body>\n';

  const normalStyle = styleCollector.getNormalStyle();

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const page = pages[pageIdx];

    // Collect images for this page, sorted by Y position
    const pageImages = images
      .filter(img => img.pageIndex === pageIdx)
      .sort((a, b) => a.yPosition - b.yPosition);

    let imageIdx = 0;

    for (const elem of page.elements) {
      if (elem.type === 'paragraph') {
        // Insert any images that should come before this paragraph's position
        // (based on approximate Y ordering from the PDF)
        // For now, images are inserted at the start of each page

        xml += generateParagraphXml(elem.element, normalStyle, styleCollector);
      } else if (elem.type === 'image') {
        xml += generateImageParagraphXml(elem.element);
      }
    }

    // Insert any remaining images for this page that weren't placed inline
    while (imageIdx < pageImages.length) {
      xml += generateImageParagraphXml(pageImages[imageIdx]);
      imageIdx++;
    }

    // Page break between pages (except after last page)
    if (pageIdx < pages.length - 1) {
      xml += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>\n';
    }
  }

  // Section properties (page size from last page, or default Letter)
  const lastPage = pages[pages.length - 1];
  const pgW = lastPage?.widthTwips ?? 12240; // 8.5" default
  const pgH = lastPage?.heightTwips ?? 15840; // 11" default

  xml += '<w:sectPr>\n';
  xml += `  <w:pgSz w:w="${pgW}" w:h="${pgH}"/>\n`;
  xml += '  <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>\n';
  xml += '  <w:cols w:space="720"/>\n';
  xml += '</w:sectPr>\n';

  xml += '</w:body>\n';
  xml += '</w:document>';
  return xml;
}

/**
 * Generate XML for a single paragraph.
 */
function generateParagraphXml(
  para: DocxParagraph,
  normalStyle: DocxStyle,
  styleCollector: StyleCollector
): string {
  let xml = '<w:p>\n';

  // Paragraph properties
  const hasPprops =
    para.alignment !== 'left' ||
    para.indent > 0 ||
    para.firstLineIndent > 0 ||
    para.spacingBefore > 0 ||
    para.spacingAfter > 0 ||
    para.lineSpacing > 0 ||
    para.styleId ||
    para.pageBreakBefore;

  if (hasPprops) {
    xml += '  <w:pPr>\n';

    if (para.styleId && !styleCollector.isNormalStyle(para.styleId)) {
      xml += `    <w:pStyle w:val="${escXml(para.styleId)}"/>\n`;
    }

    if (para.alignment !== 'left') {
      const jcVal = para.alignment === 'justify' ? 'both' : para.alignment;
      xml += `    <w:jc w:val="${jcVal}"/>\n`;
    }

    if (para.indent > 0 || para.firstLineIndent > 0) {
      const parts: string[] = [];
      if (para.indent > 0) parts.push(`w:left="${para.indent}"`);
      if (para.firstLineIndent > 0) parts.push(`w:firstLine="${para.firstLineIndent}"`);
      xml += `    <w:ind ${parts.join(' ')}/>\n`;
    }

    if (para.spacingBefore > 0 || para.spacingAfter > 0 || para.lineSpacing > 0) {
      const parts: string[] = [];
      if (para.spacingBefore > 0) parts.push(`w:before="${para.spacingBefore}"`);
      if (para.spacingAfter > 0) parts.push(`w:after="${para.spacingAfter}"`);
      if (para.lineSpacing > 0) parts.push(`w:line="${para.lineSpacing}" w:lineRule="exact"`);
      xml += `    <w:spacing ${parts.join(' ')}/>\n`;
    }

    if (para.pageBreakBefore) {
      xml += '    <w:pageBreakBefore/>\n';
    }

    xml += '  </w:pPr>\n';
  }

  // Runs
  for (const run of para.runs) {
    xml += generateRunXml(run, normalStyle);
  }

  xml += '</w:p>\n';
  return xml;
}

/**
 * Generate XML for a single text run.
 */
function generateRunXml(run: DocxRun, normalStyle: DocxStyle): string {
  let xml = '  <w:r>\n';

  // Run properties — only emit what differs from Normal
  const needsRPr =
    run.fontName !== normalStyle.fontName ||
    run.fontSize !== normalStyle.fontSize ||
    run.bold !== normalStyle.bold ||
    run.italic !== normalStyle.italic ||
    run.color !== normalStyle.color ||
    run.underline ||
    run.strikethrough;

  if (needsRPr) {
    xml += '    <w:rPr>\n';

    if (run.fontName !== normalStyle.fontName) {
      xml += `      <w:rFonts w:ascii="${escXml(run.fontName)}" w:hAnsi="${escXml(run.fontName)}" w:cs="${escXml(run.fontName)}"/>\n`;
    }

    if (run.bold && !normalStyle.bold) {
      xml += '      <w:b/>\n';
    } else if (!run.bold && normalStyle.bold) {
      xml += '      <w:b w:val="0"/>\n';
    }

    if (run.italic && !normalStyle.italic) {
      xml += '      <w:i/>\n';
    } else if (!run.italic && normalStyle.italic) {
      xml += '      <w:i w:val="0"/>\n';
    }

    if (run.underline) {
      xml += '      <w:u w:val="single"/>\n';
    }

    if (run.strikethrough) {
      xml += '      <w:strike/>\n';
    }

    if (run.color !== normalStyle.color) {
      xml += `      <w:color w:val="${escXml(run.color)}"/>\n`;
    }

    if (run.fontSize !== normalStyle.fontSize) {
      xml += `      <w:sz w:val="${run.fontSize}"/>\n`;
      xml += `      <w:szCs w:val="${run.fontSize}"/>\n`;
    }

    xml += '    </w:rPr>\n';
  }

  // Text content — preserve spaces with xml:space="preserve"
  xml += `    <w:t xml:space="preserve">${escXml(run.text)}</w:t>\n`;
  xml += '  </w:r>\n';
  return xml;
}

/**
 * Generate a paragraph containing an inline image (pure DrawingML, no VML).
 */
function generateImageParagraphXml(image: DocxImage): string {
  const n = parseInt(image.rId.replace('rId', ''), 10) || 1;

  let xml = '<w:p>\n';
  xml += '  <w:r>\n';
  xml += '    <w:drawing>\n';
  xml += `      <wp:inline distT="0" distB="0" distL="0" distR="0">\n`;
  xml += `        <wp:extent cx="${image.widthEmu}" cy="${image.heightEmu}"/>\n`;
  xml += `        <wp:docPr id="${n}" name="Picture ${n}"/>\n`;
  xml += '        <a:graphic>\n';
  xml += '          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">\n';
  xml += '            <pic:pic>\n';
  xml += '              <pic:nvPicPr>\n';
  xml += `                <pic:cNvPr id="${n}" name="${escXml(image.fileName)}"/>\n`;
  xml += '                <pic:cNvPicPr/>\n';
  xml += '              </pic:nvPicPr>\n';
  xml += '              <pic:blipFill>\n';
  xml += `                <a:blip r:embed="${image.rId}"/>\n`;
  xml += '                <a:stretch><a:fillRect/></a:stretch>\n';
  xml += '              </pic:blipFill>\n';
  xml += '              <pic:spPr>\n';
  xml += '                <a:xfrm>\n';
  xml += '                  <a:off x="0" y="0"/>\n';
  xml += `                  <a:ext cx="${image.widthEmu}" cy="${image.heightEmu}"/>\n`;
  xml += '                </a:xfrm>\n';
  xml += '                <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>\n';
  xml += '              </pic:spPr>\n';
  xml += '            </pic:pic>\n';
  xml += '          </a:graphicData>\n';
  xml += '        </a:graphic>\n';
  xml += '      </wp:inline>\n';
  xml += '    </w:drawing>\n';
  xml += '  </w:r>\n';
  xml += '</w:p>\n';
  return xml;
}

/**
 * Generate word/styles.xml
 *
 * Only emits actually-used styles, plus the docDefaults from Normal.
 */
export function generateStylesXml(styleCollector: StyleCollector): string {
  const normal = styleCollector.getNormalStyle();
  const usedStyles = styleCollector.getUsedStyles();

  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n';

  // Document defaults
  xml += '  <w:docDefaults>\n';
  xml += '    <w:rPrDefault>\n';
  xml += '      <w:rPr>\n';
  xml += `        <w:rFonts w:ascii="${escXml(normal.fontName)}" w:hAnsi="${escXml(normal.fontName)}" w:cs="${escXml(normal.fontName)}" w:eastAsia="${escXml(normal.fontName)}"/>\n`;
  xml += `        <w:sz w:val="${normal.fontSize}"/>\n`;
  xml += `        <w:szCs w:val="${normal.fontSize}"/>\n`;
  if (normal.color !== '000000') {
    xml += `        <w:color w:val="${escXml(normal.color)}"/>\n`;
  }
  if (normal.bold) {
    xml += '        <w:b/>\n';
  }
  if (normal.italic) {
    xml += '        <w:i/>\n';
  }
  xml += '      </w:rPr>\n';
  xml += '    </w:rPrDefault>\n';
  xml += '    <w:pPrDefault>\n';
  xml += '      <w:pPr>\n';
  xml += '        <w:spacing w:after="0" w:line="240" w:lineRule="auto"/>\n';
  xml += '      </w:pPr>\n';
  xml += '    </w:pPrDefault>\n';
  xml += '  </w:docDefaults>\n';

  // Normal style definition
  xml += '  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">\n';
  xml += '    <w:name w:val="Normal"/>\n';
  xml += '    <w:qFormat/>\n';
  xml += '  </w:style>\n';

  // Only emit styles that are actually used and differ from Normal
  for (const style of usedStyles) {
    xml += `  <w:style w:type="character" w:customStyle="1" w:styleId="${escXml(style.id)}">\n`;
    xml += `    <w:name w:val="${escXml(style.name)}"/>\n`;
    xml += '    <w:rPr>\n';
    if (style.fontName !== normal.fontName) {
      xml += `      <w:rFonts w:ascii="${escXml(style.fontName)}" w:hAnsi="${escXml(style.fontName)}" w:cs="${escXml(style.fontName)}"/>\n`;
    }
    if (style.bold !== normal.bold) {
      xml += style.bold ? '      <w:b/>\n' : '      <w:b w:val="0"/>\n';
    }
    if (style.italic !== normal.italic) {
      xml += style.italic ? '      <w:i/>\n' : '      <w:i w:val="0"/>\n';
    }
    if (style.fontSize !== normal.fontSize) {
      xml += `      <w:sz w:val="${style.fontSize}"/>\n`;
      xml += `      <w:szCs w:val="${style.fontSize}"/>\n`;
    }
    if (style.color !== normal.color) {
      xml += `      <w:color w:val="${escXml(style.color)}"/>\n`;
    }
    xml += '    </w:rPr>\n';
    xml += '  </w:style>\n';
  }

  xml += '</w:styles>';
  return xml;
}

/**
 * Generate word/settings.xml
 * Compatibility mode 15 = Word 2013+
 */
export function generateSettingsXml(): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">\n';
  xml += '  <w:zoom w:percent="100"/>\n';
  xml += '  <w:defaultTabStop w:val="720"/>\n';
  xml += '  <w:characterSpacingControl w:val="doNotCompress"/>\n';
  xml += '  <w:compat>\n';
  xml += '    <w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>\n';
  xml += '  </w:compat>\n';
  xml += '</w:settings>';
  return xml;
}

/**
 * Generate word/fontTable.xml with only used fonts.
 */
export function generateFontTableXml(fonts: string[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n';

  for (const font of fonts) {
    xml += `  <w:font w:name="${escXml(font)}">\n`;
    xml += `    <w:panose1 w:val="020F0502020204030204"/>\n`;
    xml += '    <w:charset w:val="00"/>\n';
    xml += '    <w:family w:val="swiss"/>\n';
    xml += '    <w:pitch w:val="variable"/>\n';
    xml += '  </w:font>\n';
  }

  xml += '</w:fonts>';
  return xml;
}

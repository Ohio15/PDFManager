/**
 * SVG Exporter — Convert PageScene to SVG vector output.
 *
 * Preserves full vector fidelity: paths, rects, text, and images
 * are output as SVG elements without rasterization.
 */

import type { PageScene, TextElement, RectElement, PathElement, ImageElement, RGB } from './docxGenerator/types';

/** Convert RGB (0-1 range) to CSS hex color */
function rgbToHex(c: RGB): string {
  const r = Math.round(Math.max(0, Math.min(1, c.r)) * 255).toString(16).padStart(2, '0');
  const g = Math.round(Math.max(0, Math.min(1, c.g)) * 255).toString(16).padStart(2, '0');
  const b = Math.round(Math.max(0, Math.min(1, c.b)) * 255).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}

/** Escape XML special characters */
function escXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Convert a RectElement to an SVG <rect> element */
export function rectToSvgElement(rect: RectElement): string {
  const attrs: string[] = [
    `x="${rect.x.toFixed(2)}"`,
    `y="${rect.y.toFixed(2)}"`,
    `width="${rect.width.toFixed(2)}"`,
    `height="${rect.height.toFixed(2)}"`,
  ];

  if (rect.fillColor) {
    attrs.push(`fill="${rgbToHex(rect.fillColor)}"`);
  } else {
    attrs.push('fill="none"');
  }

  if (rect.strokeColor) {
    attrs.push(`stroke="${rgbToHex(rect.strokeColor)}"`);
    attrs.push(`stroke-width="${rect.lineWidth.toFixed(2)}"`);
  }

  return `  <rect ${attrs.join(' ')}/>`;
}

/** Convert a PathElement to an SVG <path> element */
export function pathToSvgElement(path: PathElement): string {
  let d = '';

  for (const op of path.operations) {
    switch (op.type) {
      case 'moveTo':
        d += `M${op.args[0].toFixed(2)},${op.args[1].toFixed(2)} `;
        break;
      case 'lineTo':
        d += `L${op.args[0].toFixed(2)},${op.args[1].toFixed(2)} `;
        break;
      case 'curveTo':
        d += `C${op.args[0].toFixed(2)},${op.args[1].toFixed(2)} ` +
             `${op.args[2].toFixed(2)},${op.args[3].toFixed(2)} ` +
             `${op.args[4].toFixed(2)},${op.args[5].toFixed(2)} `;
        break;
      case 'closePath':
        d += 'Z ';
        break;
    }
  }

  const attrs: string[] = [`d="${d.trim()}"`];

  if (path.fillColor) {
    attrs.push(`fill="${rgbToHex(path.fillColor)}"`);
  } else {
    attrs.push('fill="none"');
  }

  if (path.strokeColor) {
    attrs.push(`stroke="${rgbToHex(path.strokeColor)}"`);
    attrs.push(`stroke-width="${path.lineWidth.toFixed(2)}"`);
  }

  return `  <path ${attrs.join(' ')}/>`;
}

/** Convert a TextElement to an SVG <text> element */
function textToSvgElement(text: TextElement): string {
  const attrs: string[] = [
    `x="${text.x.toFixed(2)}"`,
    `y="${(text.y + text.height * 0.85).toFixed(2)}"`, // approximate baseline
    `font-family="${escXml(text.fontName)}"`,
    `font-size="${text.fontSize.toFixed(1)}"`,
    `fill="#${text.color}"`,
  ];

  if (text.bold) attrs.push('font-weight="bold"');
  if (text.italic) attrs.push('font-style="italic"');
  if (text.underline) attrs.push('text-decoration="underline"');
  if (text.strikethrough) attrs.push('text-decoration="line-through"');

  return `  <text ${attrs.join(' ')}>${escXml(text.text)}</text>`;
}

/** Convert an ImageElement to an SVG <image> element with embedded base64 data */
function imageToSvgElement(image: ImageElement): string {
  if (!image.data) return '';

  // Convert Uint8Array to base64
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < image.data.length; i += chunkSize) {
    const chunk = image.data.subarray(i, Math.min(i + chunkSize, image.data.length));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  const base64 = btoa(binary);

  const attrs: string[] = [
    `x="${image.x.toFixed(2)}"`,
    `y="${image.y.toFixed(2)}"`,
    `width="${image.width.toFixed(2)}"`,
    `height="${image.height.toFixed(2)}"`,
    `href="data:${image.mimeType};base64,${base64}"`,
  ];

  return `  <image ${attrs.join(' ')}/>`;
}

/**
 * Convert a full PageScene to an SVG document string.
 *
 * @param scene  The page scene from PageAnalyzer
 * @returns SVG document as a string
 */
export function pageToSvg(scene: PageScene): string {
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"`,
    `     viewBox="0 0 ${scene.width.toFixed(2)} ${scene.height.toFixed(2)}"`,
    `     width="${scene.width.toFixed(2)}" height="${scene.height.toFixed(2)}">`,
    `  <rect width="100%" height="100%" fill="white"/>`,
  ];

  // Render in order: rects first, then paths, then images, then text (on top)
  for (const el of scene.elements) {
    if (el.kind === 'rect') {
      lines.push(rectToSvgElement(el));
    }
  }

  for (const el of scene.elements) {
    if (el.kind === 'path') {
      lines.push(pathToSvgElement(el));
    }
  }

  for (const el of scene.elements) {
    if (el.kind === 'image' && (el as ImageElement).isGenuine) {
      const svg = imageToSvgElement(el as ImageElement);
      if (svg) lines.push(svg);
    }
  }

  for (const el of scene.elements) {
    if (el.kind === 'text') {
      lines.push(textToSvgElement(el));
    }
  }

  lines.push('</svg>');
  return lines.join('\n');
}

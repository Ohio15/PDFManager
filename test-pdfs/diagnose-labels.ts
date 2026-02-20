import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as path from 'path';

const PDF_PATH = path.join(__dirname, 'repair-calibration-form.pdf');

async function diagnose() {
  const doc = await pdfjsLib.getDocument(PDF_PATH).promise;
  const page = await doc.getPage(1);
  
  // Get text content
  const textContent = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1.0 });
  
  console.log(`Page size: ${viewport.width} x ${viewport.height}`);
  console.log('\n=== ALL TEXT ITEMS (sorted by Y then X) ===\n');
  
  const items = textContent.items
    .filter((item: any) => item.str && item.str.trim())
    .map((item: any) => {
      const tx = item.transform;
      return {
        str: item.str.trim(),
        x: tx[4],
        y: viewport.height - tx[5],  // flip Y
        width: item.width,
        height: item.height || Math.abs(tx[3]) || 10,
        fontSize: Math.abs(tx[0]) || Math.abs(tx[3]),
      };
    })
    .sort((a: any, b: any) => {
      const yDiff = a.y - b.y;
      if (Math.abs(yDiff) > 3) return yDiff;
      return a.x - b.x;
    });
  
  for (const item of items) {
    console.log(`  Y=${item.y.toFixed(1).padStart(6)} X=${item.x.toFixed(1).padStart(6)} W=${item.width.toFixed(1).padStart(5)} fontSize=${item.fontSize.toFixed(1)} "${item.str}"`);
  }
  
  // Also get operator list to find border rects
  const ops = await page.getOperatorList();
  const OPS_RECTANGLE = 19;
  const OPS_CONSTRUCT_PATH = 91;
  
  // Collect all rectangles
  const rects: Array<{x: number; y: number; w: number; h: number}> = [];
  
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] === OPS_CONSTRUCT_PATH) {
      const subOps = ops.argsArray[i][0] || [];
      const subArgs = ops.argsArray[i][1] || [];
      let argIdx = 0;
      for (const op of subOps) {
        if (op === OPS_RECTANGLE) {
          const rx = subArgs[argIdx];
          const ry = viewport.height - subArgs[argIdx + 1] - subArgs[argIdx + 3];
          const rw = subArgs[argIdx + 2];
          const rh = subArgs[argIdx + 3];
          rects.push({ x: rx, y: ry, w: rw, h: rh });
          argIdx += 4;
        } else if (op === 13) { argIdx += 2; }
        else if (op === 14) { argIdx += 2; }
        else if (op === 15) { argIdx += 6; }
        else if (op === 18) { /* no args */ }
      }
    }
  }
  
  // Find table-like border rects (stroked, reasonable size)
  const borderRects = rects.filter(r => r.w > 10 && r.h > 10 && r.w < 600 && r.h < 50);
  
  console.log(`\n=== BORDER-LIKE RECTS (${borderRects.length} total) ===\n`);
  
  // Group rects by Y band to find table rows
  borderRects.sort((a, b) => a.y - b.y || a.x - b.x);
  
  // Find the leftmost and rightmost border rect boundaries
  let minBorderX = Infinity;
  let maxBorderX = -Infinity;
  
  for (const r of borderRects) {
    if (r.x < minBorderX) minBorderX = r.x;
    if (r.x + r.w > maxBorderX) maxBorderX = r.x + r.w;
  }
  
  console.log(`Border rect X range: ${minBorderX.toFixed(1)} to ${maxBorderX.toFixed(1)}`);
  
  // Find text that's to the LEFT of the border rect boundaries
  console.log('\n=== TEXT LABELS LEFT OF TABLE BORDERS ===\n');
  
  for (const item of items) {
    const textCenterX = item.x + item.width / 2;
    if (textCenterX < minBorderX) {
      console.log(`  LABEL: Y=${item.y.toFixed(1).padStart(6)} X=${item.x.toFixed(1).padStart(6)} "${item.str}" (border starts at X=${minBorderX.toFixed(1)})`);
    }
  }
  
  // Cross-reference: for each text label left of borders, find the closest border rect row
  console.log('\n=== LABEL-TO-ROW MAPPING ===\n');
  
  for (const item of items) {
    const textCenterX = item.x + item.width / 2;
    const textCenterY = item.y + item.height / 2;
    
    if (textCenterX < minBorderX) {
      // Find closest border rect by Y
      let bestRect = borderRects[0];
      let bestDist = Infinity;
      
      for (const r of borderRects) {
        const rectCenterY = r.y + r.h / 2;
        const dist = Math.abs(textCenterY - rectCenterY);
        if (dist < bestDist) {
          bestDist = dist;
          bestRect = r;
        }
      }
      
      console.log(`  "${item.str}" (Y=${item.y.toFixed(1)}) → closest rect at Y=${bestRect.y.toFixed(1)} (dist=${bestDist.toFixed(1)}pt)`);
    }
  }
}

diagnose().catch(console.error);

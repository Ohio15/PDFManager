/**
 * Diagnose color values from pdfjs operator list.
 * Usage: npx tsx test-pdfs/diagnose-colors.ts
 */
import * as fs from 'fs';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

async function run() {
  const data = new Uint8Array(fs.readFileSync('test-pdfs/repair-calibration-form.pdf'));
  const doc = await pdfjsLib.getDocument({ data: data.slice() }).promise;
  const page = await doc.getPage(1);
  const opList = await page.getOperatorList();

  const OPS_NAMES: Record<number, string> = {};
  for (const [key, val] of Object.entries(pdfjsLib.OPS)) {
    OPS_NAMES[val as number] = key;
  }

  // Look for color-setting operators
  let count = 0;
  for (let i = 0; i < opList.fnArray.length && count < 20; i++) {
    const fn = opList.fnArray[i];
    const name = OPS_NAMES[fn] || `op${fn}`;

    if (name === 'setFillRGBColor' || name === 'setStrokeRGBColor' ||
        name === 'setFillGray' || name === 'setStrokeGray') {
      const args = opList.argsArray[i];
      console.log(`op[${i}] ${name}: args = [${args.map((a: number) => a.toFixed(6)).join(', ')}]`);
      count++;
    }
  }

  page.cleanup();
  await doc.destroy();
}

run().catch(e => { console.error(e); process.exit(1); });

// @ts-nocheck
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { resolve } from "path";

const pdfPath = process.argv[2];
if (!pdfPath) {
  console.error("Usage: npx tsx analyze-form.ts <path-to-pdf>");
  process.exit(1);
}

const fullPath = resolve(pdfPath);
console.log(`\n=== Analyzing: ${fullPath} ===\n`);

// Build reverse lookup: op number -> op name
const opsReverse: Record<number, string> = {};
for (const [name, num] of Object.entries(OPS)) {
  opsReverse[num as number] = name;
}

async function main() {
  const doc = await getDocument(fullPath).promise;
  console.log(`Pages: ${doc.numPages}\n`);

  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 1.0 });
  console.log(`Page 1 viewport: ${viewport.width} x ${viewport.height}\n`);

  // --- Text Content ---
  const textContent = await page.getTextContent();
  console.log(`\n${"=".repeat(80)}`);
  console.log(`TEXT ITEMS (${textContent.items.length} total)`);
  console.log("=".repeat(80));

  for (let i = 0; i < textContent.items.length; i++) {
    const item = textContent.items[i] as any;
    if (item.str === undefined) {
      continue;
    }
    const tx = item.transform; // [scaleX, skewY, skewX, scaleY, translateX, translateY]
    const x = tx[4];
    const y = tx[5];
    const fontSize = Math.abs(tx[0]) || Math.abs(tx[3]);
    const width = item.width;
    const height = item.height;
    const fontName = item.fontName || "unknown";
    console.log(
      `[${i}] x=${x.toFixed(1)} y=${y.toFixed(1)} w=${width.toFixed(1)} h=${height.toFixed(1)} fontSize=${fontSize.toFixed(1)} font="${fontName}" str="${item.str}"`
    );
  }

  // --- Operator List ---
  const opList = await page.getOperatorList();
  console.log(`\n${"=".repeat(80)}`);
  console.log(`OPERATOR LIST (${opList.fnArray.length} total ops)`);
  console.log("=".repeat(80));

  // Count ops by type
  const opCounts: Record<string, number> = {};
  for (const fn of opList.fnArray) {
    const name = opsReverse[fn] || `unknown_${fn}`;
    opCounts[name] = (opCounts[name] || 0) + 1;
  }

  console.log("\n--- Op Counts ---");
  for (const [name, count] of Object.entries(opCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name}: ${count}`);
  }

  // Print all ops with details for key operations
  console.log("\n--- All Operators (detailed for rects/paths/fills/strokes) ---");
  const interestingOps = new Set([
    OPS.rectangle,
    OPS.constructPath,
    OPS.fill,
    OPS.eoFill,
    OPS.stroke,
    OPS.fillStroke,
    OPS.setFillRGBColor,
    OPS.setStrokeRGBColor,
    OPS.setFillGray,
    OPS.setStrokeGray,
    OPS.setLineWidth,
    OPS.moveTo,
    OPS.lineTo,
    OPS.transform,
    OPS.save,
    OPS.restore,
    OPS.beginText,
    OPS.endText,
    OPS.setFont,
    OPS.showText,
    OPS.paintImageXObject,
  ]);

  let rectCount = 0;

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];
    const name = opsReverse[fn] || `unknown_${fn}`;

    if (fn === OPS.constructPath) {
      // constructPath args: [ops[], [coords...], minMax]
      const subOps = args[0];
      const coords = args[1];
      let coordIdx = 0;
      const parts: string[] = [];
      for (const subOp of subOps) {
        if (subOp === OPS.rectangle) {
          const rx = coords[coordIdx];
          const ry = coords[coordIdx + 1];
          const rw = coords[coordIdx + 2];
          const rh = coords[coordIdx + 3];
          parts.push(`RECT(x=${rx?.toFixed(1)}, y=${ry?.toFixed(1)}, w=${rw?.toFixed(1)}, h=${rh?.toFixed(1)})`);
          coordIdx += 4;
          rectCount++;
        } else if (subOp === OPS.moveTo) {
          parts.push(`M(${coords[coordIdx]?.toFixed(1)}, ${coords[coordIdx + 1]?.toFixed(1)})`);
          coordIdx += 2;
        } else if (subOp === OPS.lineTo) {
          parts.push(`L(${coords[coordIdx]?.toFixed(1)}, ${coords[coordIdx + 1]?.toFixed(1)})`);
          coordIdx += 2;
        } else {
          parts.push(`subOp_${subOp}`);
        }
      }
      console.log(`[${i}] constructPath: ${parts.join(" -> ")}`);
      if (args[2]) {
        console.log(`      minMax: [${args[2].map((v: number) => v?.toFixed(1)).join(", ")}]`);
      }
    } else if (interestingOps.has(fn)) {
      const argStr = args
        ? args
            .map((a: any) => {
              if (Array.isArray(a)) return `[${a.map((v: any) => (typeof v === "number" ? v.toFixed(3) : v)).join(",")}]`;
              if (typeof a === "number") return a.toFixed(3);
              return String(a);
            })
            .join(", ")
        : "(none)";
      console.log(`[${i}] ${name}: ${argStr}`);
    }
  }

  // --- Summary ---
  console.log(`\n${"=".repeat(80)}`);
  console.log("SUMMARY");
  console.log("=".repeat(80));
  console.log(`Text items: ${textContent.items.filter((it: any) => it.str !== undefined).length}`);
  console.log(`Rectangles (in constructPath): ${rectCount}`);
  console.log(`Total operator list entries: ${opList.fnArray.length}`);
  console.log(`constructPath ops: ${opCounts["constructPath"] || 0}`);
  console.log(`fill ops: ${opCounts["fill"] || 0}`);
  console.log(`eoFill ops: ${opCounts["eoFill"] || 0}`);
  console.log(`stroke ops: ${opCounts["stroke"] || 0}`);
  console.log(`fillStroke ops: ${opCounts["fillStroke"] || 0}`);

  await doc.destroy();
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});

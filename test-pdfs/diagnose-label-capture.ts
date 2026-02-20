/**
 * Label Capture Diagnostic - tests LayoutAnalyzer label capture
 * Usage: npx tsx test-pdfs/diagnose-label-capture.ts
 */
import fs from "fs";
import path from "path";
import { PDFDocument } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { analyzePage } from "../src/renderer/utils/docxGenerator/PageAnalyzer";
import { buildPageLayout } from "../src/renderer/utils/docxGenerator/LayoutAnalyzer";
import type { PageScene, PageLayout, DetectedTable, DetectedCell, ParagraphGroup, TextElement, LayoutElement } from "../src/renderer/utils/docxGenerator/types";

function truncate(s: string, max: number): string { return s.length > max ? s.slice(0, max - 3) + "..." : s; }
function pad(s: string | number, w: number): string { return String(s).padStart(w); }
function fmt(t: TextElement): string {
  const q = String.fromCharCode(34);
  return q + truncate(t.text, 40) + q + " [x=" + t.x.toFixed(1) + ", y=" + t.y.toFixed(1) + ", w=" + t.width.toFixed(1) + ", h=" + t.height.toFixed(1) + ", fs=" + t.fontSize.toFixed(1) + ", bold=" + t.bold + "]";
}
async function main() {
  const scriptDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
  const pdfPath = path.join(scriptDir, "repair-calibration-form.pdf");
  if (!fs.existsSync(pdfPath)) { console.error("PDF not found: " + pdfPath); process.exit(1); }
  console.log("=".repeat(80)); console.log("LABEL CAPTURE DIAGNOSTIC"); console.log("PDF: " + pdfPath); console.log("=".repeat(80));
  const pdfData = new Uint8Array(fs.readFileSync(pdfPath));
  console.log("\nPDF size: " + pdfData.length + " bytes");
  const pdfLibDoc = await PDFDocument.load(pdfData, { ignoreEncryption: true });
  const pdfJsDoc = await pdfjsLib.getDocument({ data: pdfData.slice() }).promise;
  const numPages = pdfJsDoc.numPages;
  console.log("Pages: " + numPages);
  let gtTT = 0, gtPT = 0, gtTables = 0, gtParas = 0;
  for (let pi = 0; pi < numPages; pi++) {
    console.log("\n" + "=".repeat(80)); console.log("PAGE " + (pi + 1)); console.log("=".repeat(80));
    const page = await pdfJsDoc.getPage(pi + 1);
    await page.getOperatorList().catch(() => {});
    const scene: PageScene = await analyzePage(page, pdfLibDoc, pi);
    const txts = scene.elements.filter((e): e is TextElement => e.kind === "text");
    console.log("\nScene: " + scene.elements.length + " elems, " + txts.length + " text, " + scene.formFields.length + " fields");
    console.log("Page dims: " + scene.width.toFixed(1) + " x " + scene.height.toFixed(1) + " pts");
    const layout: PageLayout = buildPageLayout(scene);
    const tables = layout.elements.filter((e): e is LayoutElement & { type: "table" } => e.type === "table");
    const paras = layout.elements.filter((e): e is LayoutElement & { type: "paragraph" } => e.type === "paragraph");
    const imgs = layout.elements.filter((e): e is LayoutElement & { type: "image" } => e.type === "image");
    console.log("Layout: " + tables.length + " tables, " + paras.length + " paragraphs, " + imgs.length + " images");
    let pTT = 0;
    for (let ti = 0; ti < tables.length; ti++) {
      const tbl: DetectedTable = tables[ti].element;
      console.log("\n" + "~".repeat(70));
      console.log("TABLE " + (ti + 1) + ": " + tbl.rows + " rows x " + tbl.cols + " cols");
      console.log("  Bounding box: x=" + tbl.x.toFixed(1) + ", y=" + tbl.y.toFixed(1) + ", w=" + tbl.width.toFixed(1) + ", h=" + tbl.height.toFixed(1));
      console.log("  Column widths: [" + tbl.columnWidths.map((w: number) => w.toFixed(1)).join(", ") + "]");
      console.log("  Row heights: [" + tbl.rowHeights.map((h: number) => h.toFixed(1)).join(", ") + "]");
      const cells = [...tbl.cells].sort((a: DetectedCell, b: DetectedCell) => a.row !== b.row ? a.row - b.row : a.col - b.col);
      for (const c of cells) {
        const sp = (c.colSpan > 1 || c.rowSpan > 1) ? " [span: " + c.rowSpan + "r x " + c.colSpan + "c]" : "";
        const ff: string[] = [];
        for (const f of c.formFields) { ff.push(f.fieldType + "=" + String.fromCharCode(34) + f.fieldName + String.fromCharCode(34)); }
        const fi = c.formFields.length > 0 ? " {" + c.formFields.length + " field(s): " + ff.join(", ") + "}" : "";
        pTT += c.texts.length;
        console.log("\n  Cell [row=" + pad(c.row, 2) + ", col=" + pad(c.col, 2) + "]" + sp + " (x=" + c.x.toFixed(1) + ", y=" + c.y.toFixed(1) + ", w=" + c.width.toFixed(1) + ", h=" + c.height.toFixed(1) + ")" + fi);
        if (c.texts.length === 0) { console.log("    (empty)"); }
        else { for (const t of c.texts) { console.log("    " + fmt(t)); } }
      }
    }
    let pPT = 0;
    if (paras.length > 0) { console.log("\n" + "~".repeat(70)); console.log("PARAGRAPHS (text NOT in tables):"); }
    for (let j = 0; j < paras.length; j++) {
      const p: ParagraphGroup = paras[j].element;
      pPT += p.texts.length;
      const pff: string[] = [];
      for (const f of p.formFields) { pff.push(f.fieldType + "=" + String.fromCharCode(34) + f.fieldName + String.fromCharCode(34)); }
      const fi = p.formFields.length > 0 ? " {" + p.formFields.length + " field(s): " + pff.join(", ") + "}" : "";
      const bg = p.backgroundColor ? " bg=(" + p.backgroundColor.r.toFixed(2) + "," + p.backgroundColor.g.toFixed(2) + "," + p.backgroundColor.b.toFixed(2) + ")" : "";
      const bb = p.bottomBorder ? " border-bottom=" + p.bottomBorder.widthPt.toFixed(1) + "pt" : "";
      console.log("\n  Paragraph " + (j + 1) + ": " + p.texts.length + " text(s) at (x=" + p.x.toFixed(1) + ", y=" + p.y.toFixed(1) + ")" + fi + bg + bb);
      for (const t of p.texts) { console.log("    " + fmt(t)); }
    }
    console.log("\n" + "~".repeat(70));
    console.log("PAGE " + (pi + 1) + " SUMMARY:");
    console.log("  Text in tables:     " + pTT);
    console.log("  Text in paragraphs: " + pPT);
    console.log("  Total placed:       " + (pTT + pPT));
    console.log("  Total in scene:     " + txts.length);
    const unp = txts.length - (pTT + pPT);
    if (unp > 0) { console.log("  WARNING: " + unp + " items NOT placed!"); }
    else if (unp < 0) { console.log("  NOTE: " + Math.abs(unp) + " items in multiple elements."); }
    gtTT += pTT; gtPT += pPT; gtTables += tables.length; gtParas += paras.length;
    page.cleanup();
  }
  console.log("\n" + "=".repeat(80)); console.log("GRAND SUMMARY"); console.log("=".repeat(80));
  console.log("  Total tables:              " + gtTables);
  console.log("  Total paragraphs:          " + gtParas);
  console.log("  Text items in tables:      " + gtTT);
  console.log("  Text items in paragraphs:  " + gtPT);
  console.log("  Total text items placed:   " + (gtTT + gtPT));
  const tot = gtTT + gtPT;
  if (tot > 0) {
    console.log("  Table capture rate:        " + ((gtTT / tot) * 100).toFixed(1) + "%");
    console.log("  Paragraph (orphan) rate:   " + ((gtPT / tot) * 100).toFixed(1) + "%");
  }
  console.log("\n" + "=".repeat(80)); console.log("LABEL ANALYSIS"); console.log("=".repeat(80));
  console.log("\nChecking proximity of orphaned paragraph texts to tables:\n");
  for (let pi = 0; pi < numPages; pi++) {
    const page = await pdfJsDoc.getPage(pi + 1);
    await page.getOperatorList().catch(() => {});
    const scene = await analyzePage(page, pdfLibDoc, pi);
    const layout = buildPageLayout(scene);
    const tbls = layout.elements.filter((e): e is LayoutElement & { type: "table" } => e.type === "table").map(e => e.element);
    const pars = layout.elements.filter((e): e is LayoutElement & { type: "paragraph" } => e.type === "paragraph").map(e => e.element);
    if (pars.length === 0) continue;
    console.log("--- Page " + (pi + 1) + ": Orphaned labels near tables ---\n");
    for (const p of pars) {
      for (const t of p.texts) {
        const cx = t.x + t.width / 2, cy = t.y + t.height / 2;
        let best: DetectedTable | null = null, bestD = Infinity;
        for (const tbl of tbls) {
          const mx = Math.max(tbl.x, Math.min(cx, tbl.x + tbl.width));
          const my = Math.max(tbl.y, Math.min(cy, tbl.y + tbl.height));
          const d = Math.sqrt((cx - mx) ** 2 + (cy - my) ** 2);
          if (d < bestD) { bestD = d; best = tbl; }
        }
        const q = String.fromCharCode(34);
        if (best && bestD < 30) {
          const pos = cx < best.x ? "LEFT of" : cx > best.x + best.width ? "RIGHT of" : cy < best.y ? "ABOVE" : cy > best.y + best.height ? "BELOW" : "INSIDE";
          console.log("  " + q + truncate(t.text, 50) + q + " -> " + bestD.toFixed(1) + "pt " + pos + " table (" + best.rows + "x" + best.cols + " at y=" + best.y.toFixed(1) + ")");
        } else if (best) {
          console.log("  " + q + truncate(t.text, 50) + q + " -> " + bestD.toFixed(1) + "pt from nearest table (far)");
        } else {
          console.log("  " + q + truncate(t.text, 50) + q + " -> no tables on page");
        }
      }
    }
    page.cleanup();
  }
  await pdfJsDoc.destroy();
  console.log("\nDiagnostic complete.");
}
main().catch(e => { console.error("Diagnostic failed:", e); process.exit(1); });

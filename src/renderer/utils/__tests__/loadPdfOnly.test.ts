/**
 * Every renderer load of a PDF with pdf-lib goes through loadPdf()
 * (boundedDecode.ts), which installs the load-time decode bounds before
 * loading. A direct PDFDocument.load elsewhere would depend on some other
 * module having imported boundedDecode first.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const RENDERER = path.join(__dirname, '..', '..');
const rel = (f: string) => path.relative(RENDERER, f).split(path.sep).join('/');

/**
 * Sibling-owned redaction modules still call PDFDocument.load directly; they
 * are moved to loadPdf when that branch merges. Until then each must reach
 * boundedDecode through its static imports (checked below), so the bounds
 * are installed before their load runs.
 */
const PENDING_SIBLING = ['utils/redaction/redactionEngine.ts', 'utils/redaction/redactionVerifier.ts'];

/** Direct pdf-lib loads in `source`, given the names PDFDocument is imported under. */
function directLoads(source: string): string[] {
  const names = new Set(['PDFDocument']);
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]pdf-lib['"]/g)) {
    for (const alias of m[1].matchAll(/\bPDFDocument\s+as\s+(\w+)/g)) names.add(alias[1]);
  }
  for (const m of source.matchAll(/import\s*\*\s*as\s+(\w+)\s+from\s*['"]pdf-lib['"]/g)) names.add(`${m[1]}\\s*\\.\\s*PDFDocument`);
  const found: string[] = [];
  for (const name of names) {
    const re = new RegExp(`\\b${name}\\s*(?:\\?\\.|\\.)\\s*load\\s*\\(|\\b${name}\\s*\\[\\s*['"\`]load['"\`]\\s*\\]`, 'g');
    for (const m of source.matchAll(re)) found.push(m[0].replace(/\s+/g, ''));
  }
  return found;
}

/** True when `file`'s static relative imports transitively include boundedDecode.ts. */
function reachesBoundedDecode(file: string, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false;
  seen.add(file);
  if (path.basename(file) === 'boundedDecode.ts') return true;
  const source = fs.readFileSync(file, 'utf8');
  for (const m of source.matchAll(/^\s*import\s+(?!type\s)[^'"]*from\s*['"](\.{1,2}\/[^'"]+)['"]/gm)) {
    const base = path.resolve(path.dirname(file), m[1]);
    const target = [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find((c) => fs.existsSync(c));
    if (target && reachesBoundedDecode(target, seen)) return true;
  }
  return false;
}

const files = fs.readdirSync(RENDERER, { recursive: true, encoding: 'utf8' })
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.includes('__tests__'))
  .map((f) => path.join(RENDERER, f));

describe('loadPdf is the only pdf-lib load in the renderer', () => {
  it('is used across the renderer (the scan is not vacuous)', () => {
    const users = files.filter((f) => /\bloadPdf\s*\(/.test(fs.readFileSync(f, 'utf8')));
    expect(users.length).toBeGreaterThanOrEqual(10);
  });

  it('finds no direct PDFDocument.load outside boundedDecode.ts', () => {
    const offenders = files
      .filter((f) => rel(f) !== 'utils/boundedDecode.ts' && !PENDING_SIBLING.includes(rel(f)))
      .flatMap((f) => directLoads(fs.readFileSync(f, 'utf8')).map((hit) => `${rel(f)}: ${hit}`));
    expect(offenders).toEqual([]);
  });

  it('the pending sibling modules reach boundedDecode through their imports', () => {
    for (const f of PENDING_SIBLING) {
      expect(reachesBoundedDecode(path.join(RENDERER, f)), f).toBe(true);
    }
  });

  const RED = [
    "import { PDFDocument } from 'pdf-lib';\nconst d = await PDFDocument.load(bytes);",
    "import { PDFDocument as PDFLib } from 'pdf-lib';\nconst d = await PDFLib.load(bytes);",
    "import { rgb, PDFDocument as Doc } from 'pdf-lib';\nconst d = await Doc\n  .load(bytes, {});",
    "import * as lib from 'pdf-lib';\nconst d = await lib.PDFDocument.load(bytes);",
    "import { PDFDocument } from 'pdf-lib';\nconst d = await PDFDocument['load'](bytes);",
  ];
  for (const sample of RED) {
    it(`catches: ${JSON.stringify(sample)}`, () => {
      expect(directLoads(sample)).not.toEqual([]);
    });
  }
  it('allows loadPdf and unrelated .load calls', () => {
    expect(directLoads("import { loadPdf } from './boundedDecode';\nconst d = await loadPdf(bytes);\nconst f = Font.load(name);")).toEqual([]);
  });
});

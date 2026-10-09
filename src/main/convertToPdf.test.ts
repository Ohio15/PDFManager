/**
 * convert-to-pdf at the handler boundary: the IPC payload goes through the
 * production handler with the real path validation and the real
 * BlessedFileRegistry. A dropped input whose `<stem>.pdf` sibling already
 * exists must never have that sibling overwritten, read back, or blessed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BlessedFileRegistry } from './security';
import { handleConvertToPdf, runConverter, type ConvertToPdfDeps, type ConverterRunner } from './convertToPdf';

const PRODUCED_PDF = '%PDF-1.4\n% produced by this conversion\n%%EOF\n';
const SIBLING_PDF = '%PDF-1.4\n% the user\'s existing contract.pdf\n%%EOF\n';

/** Test converter: behaves like LibreOffice's CLI, writing `<stem>.pdf` into --outdir. */
const writesPdf: ConverterRunner = async (_bin, args) => {
  const outdir = args[args.indexOf('--outdir') + 1];
  const input = args[args.length - 1];
  fs.writeFileSync(path.join(outdir, `${path.basename(input, path.extname(input))}.pdf`), PRODUCED_PDF);
};
/** Test converter: exits 0 without writing (another instance owns the profile). */
const writesNothing: ConverterRunner = async () => {};

function setup() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pdfm-convert-test-')));
  const tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pdfm-convert-work-')));
  const input = path.join(dir, 'contract.docx');
  fs.writeFileSync(input, 'not really a docx');
  const registry = new BlessedFileRegistry();
  const { accepted } = registry.blessDrop([input]); // the user dropped contract.docx
  expect(accepted).toHaveLength(1);
  const blessed: string[] = [];
  const deps = (run: ConverterRunner, converter = 'soffice'): ConvertToPdfDeps => ({
    guard: (target, _label, access) => access !== 'dir' && registry.has(target, access),
    isDirBlessed: () => false,
    isInputFileBlessed: (p) => registry.has(p, 'read'),
    blessDerivedPdf: (p) => {
      blessed.push(p);
      return registry.addDerivedPdf(p);
    },
    converterPath: () => converter,
    run,
    tempRoot,
  });
  return { dir, tempRoot, input, registry, blessed, deps };
}

describe('convert-to-pdf beside a dropped input', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('never overwrites an existing <stem>.pdf: writes <stem> (1).pdf and blesses only that', async () => {
    const sibling = path.join(ctx.dir, 'contract.pdf');
    fs.writeFileSync(sibling, SIBLING_PDF);

    const result = await handleConvertToPdf({ inputPath: ctx.input, outputDir: ctx.dir }, ctx.deps(writesPdf));

    expect(result.success).toBe(true);
    expect(result.path).toBe(path.join(ctx.dir, 'contract (1).pdf'));
    expect(fs.readFileSync(sibling, 'latin1')).toBe(SIBLING_PDF);
    expect(fs.readFileSync(result.path!, 'latin1')).toBe(PRODUCED_PDF);
    expect(Buffer.from(result.data!, 'base64').toString('latin1')).toBe(PRODUCED_PDF);
    expect(ctx.blessed).toEqual([result.path]);
    expect(ctx.registry.has(sibling, 'read')).toBe(false);
    expect(ctx.registry.has(sibling, 'write')).toBe(false);
    expect(ctx.registry.has(result.path, 'write')).toBe(true);
  });

  it('skips every taken name, including a directory squatting on one', async () => {
    fs.writeFileSync(path.join(ctx.dir, 'contract.pdf'), SIBLING_PDF);
    fs.mkdirSync(path.join(ctx.dir, 'contract (1).pdf'));
    const result = await handleConvertToPdf({ inputPath: ctx.input, outputDir: ctx.dir }, ctx.deps(writesPdf));
    expect(result.path).toBe(path.join(ctx.dir, 'contract (2).pdf'));
    expect(fs.readFileSync(path.join(ctx.dir, 'contract.pdf'), 'latin1')).toBe(SIBLING_PDF);
  });

  it('a converter that exits 0 without writing fails, and the pre-existing sibling is neither returned nor blessed', async () => {
    const sibling = path.join(ctx.dir, 'contract.pdf');
    fs.writeFileSync(sibling, SIBLING_PDF);
    const result = await handleConvertToPdf({ inputPath: ctx.input, outputDir: ctx.dir }, ctx.deps(writesNothing));
    expect(result).toEqual({ success: false, error: 'Output file not created' });
    expect(ctx.blessed).toEqual([]);
    expect(ctx.registry.has(sibling, 'read')).toBe(false);
  });

  it('writes <stem>.pdf when the name is free, and removes its working folder', async () => {
    const result = await handleConvertToPdf({ inputPath: ctx.input, outputDir: ctx.dir }, ctx.deps(writesPdf));
    expect(result.path).toBe(path.join(ctx.dir, 'contract.pdf'));
    expect(fs.readdirSync(ctx.tempRoot)).toEqual([]);
  });

  it('still refuses an output folder that is neither blessed nor the input\'s own folder', async () => {
    const elsewhere = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pdfm-convert-other-')));
    const result = await handleConvertToPdf({ inputPath: ctx.input, outputDir: elsewhere }, ctx.deps(writesPdf));
    expect(result).toEqual({ success: false, error: 'Output directory not permitted' });
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });
});

// The real dependency: LibreOffice's CLI writes `<stem>.pdf` into --outdir.
// Runs wherever LibreOffice is installed (the developer workstation); CI
// runners have none, so it is skipped there and the cases above carry CI.
const SOFFICE = [
  'C:/Program Files/LibreOffice/program/soffice.exe',
  '/usr/bin/soffice',
  '/usr/lib/libreoffice/program/soffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
].find((p) => fs.existsSync(p));

describe.skipIf(!SOFFICE)('convert-to-pdf with the real LibreOffice', () => {
  it('converts beside a dropped input without touching the existing sibling', async () => {
    const ctx = setup();
    const input = path.join(ctx.dir, 'memo.txt');
    fs.writeFileSync(input, 'Quarterly memo\n');
    ctx.registry.blessDrop([input]);
    const sibling = path.join(ctx.dir, 'memo.pdf');
    fs.writeFileSync(sibling, SIBLING_PDF);

    const result = await handleConvertToPdf({ inputPath: input, outputDir: ctx.dir }, ctx.deps(runConverter, SOFFICE!));

    expect(result.error).toBeUndefined();
    expect(result.path).toBe(path.join(ctx.dir, 'memo (1).pdf'));
    expect(fs.readFileSync(sibling, 'latin1')).toBe(SIBLING_PDF);
    expect(fs.readFileSync(result.path!).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(ctx.blessed).toEqual([result.path]);
  }, 180_000);
});

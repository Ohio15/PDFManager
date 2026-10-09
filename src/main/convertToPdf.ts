import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { isOutputBesideBlessedInput, isSafeConvertInput, isSafeOutputDir } from './security';

/**
 * The convert-to-pdf IPC handler.
 *
 * LibreOffice writes `<stem>.pdf` into its --outdir and silently replaces an
 * existing file there, and it can exit 0 without writing anything. So it
 * never writes into the user's folder: it converts into a fresh directory
 * main creates for this call, and main then copies the result out under the
 * first free name (`<stem>.pdf`, `<stem> (1).pdf`, ...) with an exclusive
 * create. A file already in the output folder is never overwritten, and only
 * the file main created in this call is ever blessed or returned.
 */

export interface ConvertResult {
  success: boolean;
  path?: string;
  data?: string;
  error?: string;
}

/** Runs the converter binary; resolves when it exits 0. */
export type ConverterRunner = (binary: string, args: string[]) => Promise<void>;

const CONVERT_TIMEOUT_MS = 120_000;

export const runConverter: ConverterRunner = (binary, args) =>
  new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: CONVERT_TIMEOUT_MS }, (error) => (error ? reject(error) : resolve()));
  });

export interface ConvertToPdfDeps {
  /** main's guardPath: is a renderer-supplied path permitted for this access? */
  guard: (target: unknown, label: string, access: 'read' | 'dir') => boolean;
  /** Is the directory inside a dialog-blessed directory? */
  isDirBlessed: (dir: string) => boolean;
  /** Is the file an exactly-blessed (dropped) file, readable? */
  isInputFileBlessed: (file: string) => boolean;
  /** Bless a PDF main itself created beside a dropped input. */
  blessDerivedPdf: (file: string) => boolean;
  /** Main-detected LibreOffice binary (never renderer-supplied). */
  converterPath: () => string | null;
  run?: ConverterRunner;
  /** Parent of the per-call working directory; the OS temp dir by default. */
  tempRoot?: string;
}

/** Highest " (n)" suffix tried before giving up on finding a free name. */
const MAX_NAME_SUFFIX = 999;

/**
 * Copies `source` into `dir` under the first free name `<stem>.pdf`,
 * `<stem> (1).pdf`, ... and returns the path it created. The copy is an
 * exclusive create (COPYFILE_EXCL), so a file, directory or link that already
 * holds a name, or appears there mid-way, is never replaced.
 */
export function copyToFreeName(source: string, dir: string, stem: string): string {
  for (let n = 0; n <= MAX_NAME_SUFFIX; n++) {
    const candidate = path.join(dir, n === 0 ? `${stem}.pdf` : `${stem} (${n}).pdf`);
    if (pathEntryExists(candidate)) continue;
    try {
      fs.copyFileSync(source, candidate, fs.constants.COPYFILE_EXCL);
      return candidate;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw e;
    }
  }
  throw new Error(`No free file name for ${stem}.pdf in the output folder`);
}

function pathEntryExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

export async function handleConvertToPdf(payload: unknown, deps: ConvertToPdfDeps): Promise<ConvertResult> {
  const { inputPath, outputDir } = (payload ?? {}) as { inputPath?: unknown; outputDir?: unknown };
  // Validate renderer-supplied argv before handing them to execFile. inputPath
  // must be an absolute path to a convertible document (an absolute path also
  // can't be re-parsed as a LibreOffice option); outputDir must be absolute.
  if (!isSafeConvertInput(inputPath)) {
    return { success: false, error: 'Invalid input file for conversion' };
  }
  if (!isSafeOutputDir(outputDir)) {
    return { success: false, error: 'Invalid output directory' };
  }
  if (!deps.guard(inputPath, 'convert-to-pdf inputPath', 'read')) {
    return { success: false, error: 'Input file not permitted' };
  }
  // The output dir must be a blessed directory, OR, for an exactly-blessed
  // dropped input, the very directory that input sits in. In that case the only
  // file written is a main-derived `<input name>.pdf` (or `<input name> (n).pdf`)
  // beside the input (the renderer cannot choose the name), and the directory
  // itself is not blessed.
  const outputBesideBlessedInput = isOutputBesideBlessedInput(outputDir, inputPath, {
    isDirBlessed: deps.isDirBlessed,
    isInputFileBlessed: deps.isInputFileBlessed,
  });
  if (!outputBesideBlessedInput && !deps.guard(outputDir, 'convert-to-pdf outputDir', 'dir')) {
    return { success: false, error: 'Output directory not permitted' };
  }

  // libreOfficePath is main-detected only (never renderer-writable), so this is
  // a trusted binary path.
  const converter = deps.converterPath();
  if (!converter) {
    return { success: false, error: 'LibreOffice not found' };
  }

  let workDir: string;
  try {
    workDir = fs.mkdtempSync(path.join(deps.tempRoot ?? os.tmpdir(), 'pdfm-convert-'));
  } catch (e) {
    return { success: false, error: `Could not create a working folder: ${(e as Error).message}` };
  }
  try {
    const args = [
      '--headless',
      '--invisible',
      '--nodefault',
      '--nolockcheck',
      '--nologo',
      '--norestore',
      '--convert-to', 'pdf',
      '--outdir', workDir,
      inputPath,
    ];
    try {
      await (deps.run ?? runConverter)(converter, args);
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }

    const stem = path.basename(inputPath, path.extname(inputPath));
    const produced = path.join(workDir, `${stem}.pdf`);
    // workDir was empty when the converter started, so a regular file here is
    // the converter's output from this call and nothing else.
    let producedStat: fs.Stats;
    try {
      producedStat = fs.lstatSync(produced);
    } catch {
      return { success: false, error: 'Output file not created' };
    }
    if (!producedStat.isFile()) {
      return { success: false, error: 'Output file not created' };
    }

    const data = fs.readFileSync(produced);
    let outputPath: string;
    try {
      outputPath = copyToFreeName(produced, outputDir, stem);
    } catch (e) {
      return { success: false, error: `Could not write the PDF: ${(e as Error).message}` };
    }
    // A PDF written beside a dropped input is outside every blessed dir; bless
    // exactly the file created above so the opened result can save in place.
    if (outputBesideBlessedInput) deps.blessDerivedPdf(outputPath);
    return { success: true, path: outputPath, data: data.toString('base64') };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

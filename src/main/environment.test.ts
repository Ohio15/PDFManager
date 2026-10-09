import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  DEVELOPMENT_ONLY_ENV,
  PACKAGED_ENV_ALLOW_LIST,
  pathConfinementMode,
  readEnv,
  shouldLoadDevServer,
} from './environment';

const hostileEnv: Record<string, string> = {
  NODE_ENV: 'development',
  PDFMANAGER_PATH_CONFINEMENT: 'warn',
  GH_TOKEN: 'attacker-token',
  GITHUB_TOKEN: 'attacker-token-2',
};

describe('packaged app: the environment cannot change behaviour', () => {
  it('has an empty packaged allow-list', () => {
    expect(PACKAGED_ENV_ALLOW_LIST).toEqual([]);
  });
  it('ignores every variable main knows about', () => {
    for (const name of DEVELOPMENT_ONLY_ENV) expect(readEnv(name, true, hostileEnv)).toBeUndefined();
  });
  it('never loads the dev server, whatever NODE_ENV says', () => {
    expect(shouldLoadDevServer(true, readEnv('NODE_ENV', true, hostileEnv))).toBe(false);
    expect(shouldLoadDevServer(true, 'development')).toBe(false);
  });
  it('keeps path confinement enforced under PDFMANAGER_PATH_CONFINEMENT=warn', () => {
    expect(pathConfinementMode(true, readEnv('PDFMANAGER_PATH_CONFINEMENT', true, hostileEnv))).toBe('enforce');
    expect(pathConfinementMode(true, 'warn')).toBe('enforce');
  });
});

describe('unpackaged (development) run keeps its switches', () => {
  it('honours every development variable', () => {
    for (const name of DEVELOPMENT_ONLY_ENV) expect(readEnv(name, false, hostileEnv)).toBe(hostileEnv[name]);
  });
  it('loads the dev server except under the e2e harness', () => {
    expect(shouldLoadDevServer(false, undefined)).toBe(true);
    expect(shouldLoadDevServer(false, 'development')).toBe(true);
    expect(shouldLoadDevServer(false, 'test')).toBe(false);
  });
  it('allows warn-mode confinement on request only', () => {
    expect(pathConfinementMode(false, 'warn')).toBe('warn');
    expect(pathConfinementMode(false, undefined)).toBe('enforce');
  });
});

/**
 * Every way a module can reach the environment. Matched against WHOLE files,
 * so a read split across lines is still caught.
 */
const ENV_ACCESS: Array<[string, RegExp]> = [
  ['process.env (any spacing, optional chaining, line breaks)', /\bprocess\s*(?:\?\.|\.)\s*env\b/],
  ["process['env']", /\bprocess\s*(?:\?\.)?\s*\[\s*['"`]env['"`]\s*\]/],
  ['import from the process module', /\bfrom\s*['"](?:node:)?process['"]/],
  ['require of the process module', /\brequire\s*\(\s*['"](?:node:)?process['"]\s*\)/],
  ['dynamic import of the process module', /\bimport\s*\(\s*['"](?:node:)?process['"]\s*\)/],
  ['process reached through globalThis/global by key', /\b(?:globalThis|global)\s*\[\s*['"`]process['"`]\s*\]/],
  // `const p = process;`, `const { env } = process`, `f(process)`, `{ p: process }`:
  // the process object itself handed somewhere, rather than one property read.
  ['process object aliased or passed', /(?:[=:(,]|\breturn)\s*(?:(?:globalThis|global)\s*(?:\?\.|\.)\s*)?process\b(?!\s*(?:\?\.|\.|\[))/],
];

function envAccesses(source: string): string[] {
  return ENV_ACCESS.filter(([, re]) => re.test(source)).map(([name]) => name);
}

describe('source scan: environment.ts is the only environment reader in main, preload and shared', () => {
  const roots = [__dirname, path.join(__dirname, '..', 'shared')];
  const files = roots.flatMap((root) =>
    fs.existsSync(root)
      ? fs.readdirSync(root, { recursive: true, encoding: 'utf8' })
          .filter((f) => /\.(ts|tsx|js|mjs|cjs)$/.test(f) && !/\.test\.[jt]sx?$/.test(f))
          .map((f) => path.join(root, f))
      : []
  );

  it('scans the real sources (main.ts and preload.ts are among them)', () => {
    const names = files.map((f) => path.basename(f));
    expect(names).toContain('main.ts');
    expect(names).toContain('preload.ts');
  });

  it('finds no environment access outside environment.ts', () => {
    const offenders = files
      .filter((f) => path.basename(f) !== 'environment.ts')
      .flatMap((f) => envAccesses(fs.readFileSync(f, 'utf8')).map((kind) => `${path.relative(path.join(__dirname, '..'), f)}: ${kind}`));
    expect(offenders).toEqual([]);
  });

  // One red fixture per spelling: each must be caught.
  const RED: string[] = [
    'const t = process.env.GH_TOKEN;',
    'const t = process\n  .env\n  .GH_TOKEN;',
    'const t = process?.env?.X;',
    "const t = process['env'].X;",
    'const t = globalThis.process.env.X;',
    "import { env } from 'node:process';",
    "import { env } from 'process';",
    "import process from 'node:process';",
    "import * as proc from 'process';",
    "const e = require('process').env;",
    "const e = require('node:process');",
    "const m = await import('node:process');",
    'const p = process;\nconst t = p.env.X;',
    'const { env } = process;',
    'const { env: e } = globalThis.process;',
    'readAll(process);',
    "const p = globalThis['process'];",
    'function f() { return process; }',
  ];
  for (const sample of RED) {
    it(`catches: ${JSON.stringify(sample)}`, () => {
      expect(envAccesses(sample)).not.toEqual([]);
    });
  }

  // Ordinary uses of process that do not touch the environment.
  const GREEN = [
    "if (process.platform === 'win32') {}",
    'const launch = getFileFromArgs(process.argv);',
    "path.join(process.resourcesPath, 'update-config.json')",
    "process.on('uncaughtException', handler);",
    "const v = readEnv('NODE_ENV', app.isPackaged);",
    "const isDev = shouldLoadDevServer(app.isPackaged, env('NODE_ENV'));",
  ];
  for (const sample of GREEN) {
    it(`allows: ${JSON.stringify(sample)}`, () => {
      expect(envAccesses(sample)).toEqual([]);
    });
  }
});

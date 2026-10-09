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

const hostileEnv = {
  NODE_ENV: 'development',
  PDFMANAGER_PATH_CONFINEMENT: 'warn',
  GH_TOKEN: 'attacker-token',
  GITHUB_TOKEN: 'attacker-token-2',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
  HOME: '/home/u',
};

describe('packaged app: the environment cannot relax a guard or redirect the app', () => {
  it('ignores every development-only variable', () => {
    for (const name of DEVELOPMENT_ONLY_ENV) expect(readEnv(name, true, hostileEnv)).toBeUndefined();
  });
  it('reads the OS-location allow-list', () => {
    for (const name of PACKAGED_ENV_ALLOW_LIST) expect(readEnv(name, true, hostileEnv)).toBe(hostileEnv[name]);
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
  it('honours every variable', () => {
    for (const name of [...DEVELOPMENT_ONLY_ENV, ...PACKAGED_ENV_ALLOW_LIST]) {
      expect(readEnv(name, false, hostileEnv)).toBe(hostileEnv[name]);
    }
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

describe('source scan: environment.ts is the only environment reader in main, preload and shared', () => {
  // process.env, process['env'], and destructuring `{ env } = process`.
  const ENV_READ = /\bprocess\s*(?:\??\.\s*env\b|\[\s*['"`]env['"`]\s*\])|\{[^}]*\benv\b[^}]*\}\s*=\s*(?:globalThis\.)?process\b/;
  const roots = [path.join(__dirname), path.join(__dirname, '..', 'shared')];
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

  it('finds no process.env read outside environment.ts', () => {
    const offenders = files
      .filter((f) => path.basename(f) !== 'environment.ts')
      .flatMap((f) =>
        fs.readFileSync(f, 'utf8').split(/\r?\n/)
          .map((line, i) => ({ line, i }))
          .filter(({ line }) => ENV_READ.test(line))
          .map(({ line, i }) => `${path.relative(path.join(__dirname, '..'), f)}:${i + 1}: ${line.trim()}`)
      );
    expect(offenders).toEqual([]);
  });

  it('the pattern catches each form it is meant to catch', () => {
    for (const sample of ["process.env.FOO", "process.env['X']", "process['env'].X", "const { env } = process;", "process?.env"]) {
      expect(ENV_READ.test(sample), sample).toBe(true);
    }
    expect(ENV_READ.test("readEnv('NODE_ENV', app.isPackaged)")).toBe(false);
  });
});

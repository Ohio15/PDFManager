/**
 * The only place main and preload read the process environment.
 *
 * In a packaged app the environment belongs to whoever launched the process,
 * so a packaged app reads none of it: no switch that relaxes a guard or
 * redirects the app (dev-server URL, path-confinement warn mode, updater
 * credentials), and no folder location (those chose the LibreOffice binary;
 * libreOffice.ts now derives install roots from Electron and fixed paths).
 * The variables below are honoured only in an unpackaged development run. A source-scan test (environment.test.ts) fails if any
 * other file in src/main or src/shared reads process.env.
 */

/** Variables a packaged app may read: none. */
export const PACKAGED_ENV_ALLOW_LIST: readonly string[] = [];

/** Variables honoured only when the app is NOT packaged. */
export const DEVELOPMENT_ONLY_ENV = [
  /** 'development' loads the Vite dev server; 'test' loads the built renderer. */
  'NODE_ENV',
  /** 'warn' turns renderer path confinement into logging only. */
  'PDFMANAGER_PATH_CONFINEMENT',
  /** Updater credentials; a packaged build reads its bundled update-config.json. */
  'GH_TOKEN',
  'GITHUB_TOKEN',
] as const;

export type EnvVarName = (typeof DEVELOPMENT_ONLY_ENV)[number];

const packagedAllowed: ReadonlySet<string> = new Set(PACKAGED_ENV_ALLOW_LIST);

/**
 * Reads `name` from the environment, or undefined when the app is packaged and
 * `name` is not on the packaged allow-list.
 */
export function readEnv(
  name: EnvVarName,
  isPackaged: boolean,
  env: Readonly<Record<string, string | undefined>> = process.env
): string | undefined {
  if (isPackaged && !packagedAllowed.has(name)) return undefined;
  return env[name];
}

/**
 * Whether the main window loads the Vite dev server instead of the built
 * renderer. Never when packaged. Unpackaged, the e2e harness (NODE_ENV=test)
 * launches the built dist and must load that build.
 */
export function shouldLoadDevServer(isPackaged: boolean, nodeEnv: string | undefined): boolean {
  return !isPackaged && nodeEnv !== 'test';
}

/** Path-confinement mode: 'warn' only in an unpackaged run that asks for it. */
export function pathConfinementMode(isPackaged: boolean, requested: string | undefined): 'warn' | 'enforce' {
  return !isPackaged && requested === 'warn' ? 'warn' : 'enforce';
}

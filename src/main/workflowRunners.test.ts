/**
 * The repository is public: a job reachable from pull_request or
 * pull_request_target runs fork-controlled code (npm ci, pip, go on PR
 * manifests). Its runner must be a literal GitHub-hosted label, never chosen
 * by an expression such as `${{ vars.CI_RUNNER }}`: setting that variable to a
 * self-hosted label would hand the host to any returning fork contributor.
 * Schedule / push / tag / workflow_dispatch-only workflows may keep a variable.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const WORKFLOWS = path.join(__dirname, '..', '..', '.github', 'workflows');
const HOSTED = /^(ubuntu|windows|macos)-[\w.-]+$/;

/** The text of the top-level `on:` block (or inline `on:` value). */
function triggerBlock(lines: string[]): string {
  const start = lines.findIndex((l) => /^(on|"on"|'on'|true):/.test(l));
  if (start < 0) return '';
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length && (/^\s/.test(lines[i]) || lines[i].trim() === ''); i++) out.push(lines[i]);
  return out.join('\n');
}

const workflows = fs.readdirSync(WORKFLOWS)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => {
    const text = fs.readFileSync(path.join(WORKFLOWS, f), 'utf8');
    const lines = text.split(/\r?\n/);
    return { file: f, lines, prReachable: /\bpull_request(_target)?\b/.test(triggerBlock(lines)) };
  });

describe('pull_request-reachable workflows use literal GitHub-hosted runners', () => {
  it('finds the PR-triggered workflows (the scan is not vacuous)', () => {
    const pr = workflows.filter((w) => w.prReachable).map((w) => w.file);
    expect(pr).toEqual(expect.arrayContaining(['ci.yml', 'security-audit.yml', 'size-guard.yml']));
    expect(workflows.find((w) => w.file === 'dep-auto-apply.yml')?.prReachable).toBe(false);
  });

  for (const w of workflows.filter((x) => x.prReachable)) {
    it(`${w.file}: every runs-on is a literal hosted label or a matrix of literal labels`, () => {
      const bad: string[] = [];
      w.lines.forEach((line, i) => {
        const m = line.match(/^\s*runs-on:\s*(.+?)\s*(#.*)?$/);
        if (!m) return;
        const value = m[1].replace(/^['"]|['"]$/g, '');
        if (HOSTED.test(value)) return;
        if (value === '${{ matrix.os }}') return; // checked below: the matrix must be literal
        bad.push(`${w.file}:${i + 1}: ${line.trim()}`);
      });
      w.lines.forEach((line, i) => {
        const os = line.match(/^\s*os:\s*\[(.*)\]\s*$/);
        if (os && !os[1].split(',').every((v) => HOSTED.test(v.trim().replace(/^['"]|['"]$/g, '')))) {
          bad.push(`${w.file}:${i + 1}: ${line.trim()}`);
        }
      });
      expect(bad).toEqual([]);
    });
  }
});

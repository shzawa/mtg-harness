import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { changedFiles, needsBuild } from '../scripts/build-plan.ts';

test('skips documentation and preview/check-only edits', () => {
  expect(
    needsBuild([
      'README.md',
      'docs/guide.md',
      'scripts/pr-preview.ts',
      'tests/pr-preview.test.ts',
      '.github/workflows/pr-preview.yml',
      'oxlint.config.ts',
    ]),
  ).toBe(false);
  expect(needsBuild([])).toBe(false);
});

test.each([
  'entrypoints/content.ts',
  'utils/target.ts',
  'public/icon.png',
  'wxt.config.ts',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'mise.toml',
  'mise.lock',
  'bin/mise',
  'scripts/licenses.ts',
  'scripts/release.ts',
  'LICENSE',
  'licenses/new.txt',
  'tests/e2e.test.ts',
  'vitest.config.ts',
  'tsconfig.json',
  '.github/workflows/ci.yml',
  'scripts/build-plan.ts',
  'new-unknown-file',
])('builds when %s changes, even with documentation', (path) => {
  expect(needsBuild(['README.md', path])).toBe(true);
});

test('PR diff ignores base-only edits and detects deleted or renamed build inputs', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'mtg-build-plan-'));
  t.onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(cwd, 'README.md'), 'initial');
  writeFileSync(join(cwd, 'application.ts'), 'initial');
  git('add', '.');
  git('commit', '-m', 'initial');
  const initial = git('rev-parse', 'HEAD');
  git('switch', '-c', 'feature');
  writeFileSync(join(cwd, 'README.md'), 'docs');
  git('commit', '-am', 'docs');
  const head = git('rev-parse', 'HEAD');
  git('switch', 'main');
  writeFileSync(join(cwd, 'application.ts'), 'base-only');
  git('commit', '-am', 'base only');
  const base = git('rev-parse', 'HEAD');
  expect(changedFiles(base, head, true, cwd)).toEqual(['README.md']);
  expect(needsBuild(changedFiles(base, head, false, cwd))).toBe(true);
  git('switch', 'feature');
  git('mv', 'application.ts', 'docs.md');
  git('commit', '-m', 'rename');
  expect(changedFiles(initial, git('rev-parse', 'HEAD'), true, cwd)).toContain('application.ts');
  expect(needsBuild(changedFiles(initial, git('rev-parse', 'HEAD'), true, cwd))).toBe(true);
  expect(() => changedFiles('--bad', head, true, cwd)).toThrow('SHAs');
});

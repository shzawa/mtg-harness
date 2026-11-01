import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Skip only known non-build inputs. Unknown paths deliberately trigger a build.
const checkOnly = new Set([
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  '.gitignore',
  '.gitattributes',
  'renovate.json',
  'oxfmt.config.ts',
  'oxlint.config.ts',
  '.github/workflows/dependency-audit.yml',
  '.github/workflows/pr-preview.yml',
  'scripts/check-actions.ts',
  'scripts/pr-preview.ts',
  'tests/check-actions.test.ts',
  'tests/pr-preview.test.ts',
]);

export function needsBuild(paths: readonly string[]): boolean {
  return paths.some(
    (path) =>
      !checkOnly.has(path) &&
      !path.startsWith('docs/') &&
      !path.startsWith('.github/ISSUE_TEMPLATE/') &&
      path !== '.github/PULL_REQUEST_TEMPLATE.md',
  );
}

export function changedFiles(
  base: string,
  head: string,
  pullRequest: boolean,
  cwd = process.cwd(),
): string[] {
  if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha)))
    throw new Error('Expected full base and head commit SHAs');
  return execFileSync(
    'git',
    [
      'diff',
      '--no-renames',
      '--name-only',
      '-z',
      pullRequest ? `${base}...${head}` : base,
      ...(pullRequest ? [] : [head]),
      '--',
    ],
    { cwd, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const eventName = process.env.GITHUB_EVENT_NAME;
    let required = true;
    if (eventName === 'pull_request' || eventName === 'push') {
      const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, 'utf8')) as {
        before?: string;
        after?: string;
        pull_request?: { base: { sha: string }; head: { sha: string } };
      };
      const base = event.pull_request?.base.sha ?? event.before;
      const head = event.pull_request?.head.sha ?? event.after;
      // New branches have an all-zero before SHA; build rather than guess.
      if (base && head && !/^0+$/.test(base))
        required = needsBuild(changedFiles(base, head, eventName === 'pull_request'));
    }
    console.log(`required=${required}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

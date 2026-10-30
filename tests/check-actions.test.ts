import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import {
  checkActionFile,
  checkActions,
  verifyUpstream,
  type ActionPin,
  type GitHubRunner,
} from '../scripts/check-actions.ts';

const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const tagSha = 'c'.repeat(40);
const file = '.github/workflows/ci.yml';
const reference = `owner/action@${sha}`;
const workflow = (uses: string) => `jobs:\n  check:\n    steps:\n      - uses: ${uses}\n`;
const pin: ActionPin = {
  repository: 'owner/action',
  sha,
  version: 'v1.2.3',
  location: `${file}:4`,
};
const gitObject = (type: string, objectSha = sha) =>
  JSON.stringify({ object: { type, sha: objectSha } });

test('checks plain and quoted action values without treating run text as uses', () => {
  for (const uses of [reference, `'${reference}'`, `"${reference}"`]) {
    const source = workflow(`${uses} # v1.2.3`) + '      - run: "echo uses: owner/evil@main"\n';
    expect(checkActionFile(source, file).pins).toEqual([pin]);
  }
});

test('handles flow mappings with a comment on the uses scalar itself', () => {
  const source = `jobs: { check: { steps: [ { uses: '${reference}' # v1.2.3\n  } ] } }\n`;
  expect(checkActionFile(source, file).pins).toEqual([{ ...pin, location: `${file}:1` }]);
  expect(() =>
    checkActionFile(`jobs: { check: { steps: [{ uses: '${reference}' }] } } # v1.2.3\n`, file),
  ).toThrow(/inline/);
});

test('covers reusable workflow jobs, subdirectory actions, and composite steps', () => {
  const reusable = `jobs:\n  call:\n    uses: owner/action/.github/workflows/build.yml@${sha} # v1.2.3\n`;
  expect(checkActionFile(reusable, file).pins).toEqual([{ ...pin, location: `${file}:3` }]);
  const composite = `runs:\n  using: composite\n  steps:\n    - uses: owner/action/subdir@${sha} # v1.2.3\n`;
  expect(checkActionFile(composite, 'tools/action.yaml').pins).toEqual([
    { ...pin, location: 'tools/action.yaml:4' },
  ]);
  const shared = `jobs:\n  call:\n    uses: owner/.github/.github/workflows/build.yml@${sha} # v1.2.3\n`;
  expect(checkActionFile(shared, '.github/workflows/action.yml').pins).toEqual([
    { ...pin, repository: 'owner/.github', location: '.github/workflows/action.yml:3' },
  ]);
});

test('rejects major, minor, prerelease, missing, detached, or misleading version comments', () => {
  for (const uses of [
    `${reference} # v1`,
    `${reference} # v1.2`,
    `${reference} # v1.2.3-beta.1`,
    `${reference} # v01.2.3`,
    `${reference} # v1.2.3 extra`,
    reference,
    `${reference}\n        # v1.2.3`,
    `| # v1.2.3\n          ${reference}`,
  ])
    expect(() => checkActionFile(workflow(uses), file)).toThrow(/inline|single-line/);
});

test('rejects mutable refs, short or uppercase SHAs, expressions, and Docker references', () => {
  for (const uses of [
    'owner/action@main',
    'owner/action@v1.2.3',
    'owner/action@abcdef',
    `owner/action@${sha.toUpperCase()}`,
    `owner/action/\${{ inputs.path }}@${sha}`,
    'docker://alpine:3.22',
  ])
    expect(() => checkActionFile(workflow(`${uses} # v1.2.3`), file)).toThrow(
      /SHA|invalid|Docker|whitespace/,
    );
});

test('does not let duplicate keys, aliases, or YAML merges hide executable uses', () => {
  for (const source of [
    workflow(`${reference} # v1.2.3`) + '        uses: owner/evil@main\n',
    `step: &step { uses: owner/evil@main }\njobs:\n  check:\n    steps: [*step]\n`,
    `steps: &steps [{ uses: owner/evil@main }]\njobs:\n  check:\n    steps: *steps\n`,
    `job: &job { steps: [{ uses: owner/evil@main }] }\njobs: { check: *job }\n`,
    `ref: &ref ${reference}\njobs:\n  check:\n    steps:\n      - uses: *ref # v1.2.3\n`,
    `step: &step { uses: owner/evil@main }\njobs:\n  check:\n    steps:\n      - <<: *step\n        run: echo ok\n`,
  ])
    expect(() => checkActionFile(source, file)).toThrow(/unique|aliases|merge/i);
});

test('fails malformed workflow or action structures instead of skipping them', () => {
  for (const source of ['jobs: [', 'jobs: []', 'jobs: {}', 'jobs: { check: { steps: {} } }'])
    expect(() => checkActionFile(source, file)).toThrow(/Flow|mapping|sequence|empty/);
  expect(() => checkActionFile('runs: { using: composite, steps: {} }', 'action.yml')).toThrow(
    /sequence/,
  );
  expect(() => checkActionFile('runs: { using: docker, image: Dockerfile }', 'action.yml')).toThrow(
    /Docker/,
  );
});

test('discovers repository composites outside .github and validates local targets', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'mtg-harness-actions-'));
  t.onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
  const files = [file, 'tools/nested/action.yaml', 'node_modules/dependency/action.yml'];
  const sources = [
    workflow('./tools/nested'),
    `runs:\n  using: composite\n  steps:\n    - uses: ${reference} # v1.2.3\n`,
    'not valid YAML: [',
  ];
  files.forEach((name, index) => {
    mkdirSync(dirname(join(cwd, name)), { recursive: true });
    writeFileSync(join(cwd, name), sources[index] ?? '');
  });
  expect(checkActions(cwd, files)).toEqual([{ ...pin, location: 'tools/nested/action.yaml:4' }]);
  writeFileSync(join(cwd, file), workflow('./missing'));
  expect(() => checkActions(cwd, files)).toThrow(/local uses target/);
  writeFileSync(join(cwd, file), workflow('./../outside'));
  expect(() => checkActions(cwd, files)).toThrow(/within the repository/);
});

test('validates local reusable workflow targets', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'mtg-harness-actions-local-'));
  t.onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, '.github/workflows'), { recursive: true });
  const target = '.github/workflows/reusable.yaml';
  writeFileSync(join(cwd, file), `jobs:\n  call:\n    uses: ./${target}\n`);
  writeFileSync(join(cwd, target), workflow(`${reference} # v1.2.3`));
  expect(checkActions(cwd, [file, target])).toHaveLength(1);
});

test.runIf(process.platform !== 'win32')(
  'rejects manifests resolving outside the repository',
  (t) => {
    const cwd = mkdtempSync(join(tmpdir(), 'mtg-harness-actions-links-'));
    const outside = mkdtempSync(join(tmpdir(), 'mtg-harness-actions-outside-'));
    t.onTestFinished(() => {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    });
    const manifest = join(outside, 'action.yml');
    writeFileSync(manifest, 'runs: { using: node24, main: main.js }\n');
    symlinkSync(manifest, join(cwd, 'action.yml'));
    expect(() => checkActions(cwd, ['action.yml'])).toThrow(/outside the repository/);
  },
);

test('verifies each repeated pin while deduplicating read-only upstream tag lookups', () => {
  const calls: (readonly string[])[] = [];
  const run: GitHubRunner = (args) => {
    calls.push(args);
    return gitObject('commit');
  };
  verifyUpstream([pin, { ...pin, location: 'another.yml:1' }], run);
  expect(calls).toEqual([['api', '--method', 'GET', 'repos/owner/action/git/ref/tags/v1.2.3']]);
  expect(() => verifyUpstream([pin, { ...pin, sha: otherSha }], run)).toThrow(/does not match/);
});

test('resolves annotated tags and rejects mismatches, cycles, and invalid API data', () => {
  const calls: (readonly string[])[] = [];
  verifyUpstream([pin], (args) => {
    calls.push(args);
    return calls.length === 1 ? gitObject('tag', tagSha) : gitObject('commit');
  });
  expect(calls[1]).toEqual(['api', '--method', 'GET', `repos/owner/action/git/tags/${tagSha}`]);
  expect(() => verifyUpstream([pin], () => gitObject('commit', otherSha))).toThrow(
    /does not match/,
  );
  expect(() => verifyUpstream([pin], () => gitObject('tag', tagSha))).toThrow(/cyclic/);
  for (const response of [
    '[]',
    '{}',
    gitObject('tree'),
    JSON.stringify({ object: { type: 'commit', sha: 'bad' } }),
  ])
    expect(() => verifyUpstream([pin], () => response)).toThrow(
      /Invalid GitHub|resolve to a commit/,
    );
  let depth = 0;
  expect(() =>
    verifyUpstream([pin], () => gitObject('tag', (depth++).toString(16).padStart(40, '0'))),
  ).toThrow(/excessive/);
  expect(depth).toBe(17);
});

test('upstream HTTP and network failures cannot be treated as valid pins', () => {
  for (const message of [
    'HTTP 401',
    'HTTP 403',
    'HTTP 404',
    'HTTP 429',
    'HTTP 500',
    'network timeout',
  ])
    expect(() =>
      verifyUpstream([pin], () => {
        throw new Error(message);
      }),
    ).toThrow(message);
});

test('rejects trailing newlines in refs, SHA objects, or version pins', () => {
  expect(() => checkActionFile(workflow(`"${reference}\\n" # v1.2.3`), file)).toThrow(/whitespace/);
  expect(() =>
    verifyUpstream([{ ...pin, version: 'v1.2.3\n' }], () => gitObject('commit')),
  ).toThrow(/invalid action pin/);
  expect(() => verifyUpstream([pin], () => gitObject('commit', `${sha}\n`))).toThrow(
    /Invalid GitHub tag object/,
  );
});

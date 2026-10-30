import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, expect, test, type TestContext } from 'vitest';
import {
  metadata,
  parseVersion,
  release,
  type GitHubRelease,
  type GitReference,
  type ProcessResult,
  type ProcessRunner,
  type ReleaseEnvironment,
  type ZipManifest,
} from '../scripts/release.ts';

interface FixtureState {
  release: Partial<GitHubRelease> | null;
  latest: Partial<GitHubRelease> | null;
  ref: GitReference | null;
  tagObjects: Record<string, GitReference>;
  manifest: ZipManifest;
  apiErrors: Record<string, ProcessResult>;
  calls: string[][];
  mutations: string[];
  hideDraftFromGraphql?: boolean;
  uploadFails?: boolean;
  createdResponse?: Partial<GitHubRelease>;
}

const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const tag = 'v1.0.0';
const assetName = 'mtg-harness-1.0.0-chrome.zip';
const uploadedAsset = { name: assetName, state: 'uploaded', size: 42 };
const http = (body: unknown, status = 200): ProcessResult => ({
  status: status < 400 ? 0 : 1,
  stdout: `HTTP/2.0 ${status} Response\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`,
  stderr: status < 400 ? '' : `gh: request failed (HTTP ${status})`,
});

function fixture(t: TestContext, options: Partial<FixtureState> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'mtg-harness-release-test-'));
  t.onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({ name: 'mtg-harness', version: '1.0.0' }),
  );
  mkdirSync(join(cwd, 'release-assets'));
  const zip = join(cwd, 'release-assets', assetName);
  writeFileSync(zip, 'fake ZIP; unzip output is supplied by the process runner');
  const state: FixtureState = {
    release: null,
    latest: null,
    ref: null,
    tagObjects: {},
    manifest: { manifest_version: 3, version: '1.0.0' },
    apiErrors: {},
    calls: [],
    mutations: [],
    ...options,
  };
  const run: ProcessRunner = (command, args) => {
    state.calls.push([command, ...args]);
    if (command === 'unzip') {
      expect(args).toEqual(['-p', zip, 'manifest.json']);
      return { status: 0, stdout: JSON.stringify(state.manifest), stderr: '' };
    }
    expect(command).toBe('gh');
    if (args[0] === 'api') {
      const path = args[args.indexOf('--method') + 2];
      const method = args[args.indexOf('--method') + 1];
      assert(path && method);
      if (state.apiErrors[path]) return state.apiErrors[path];
      if (path.endsWith('/releases/tags/v1.0.0'))
        return state.release && !state.release.draft ? http(state.release) : http({}, 404);
      if (path === 'graphql') {
        expect(args.some((arg) => arg.includes('release(tagName:$tag){databaseId isDraft}'))).toBe(
          true,
        );
        expect(args).toEqual(expect.arrayContaining(['owner=owner', 'name=repo', 'tag=v1.0.0']));
        return http({
          data: {
            repository: {
              release:
                state.release && !state.hideDraftFromGraphql
                  ? { databaseId: 1, isDraft: state.release.draft }
                  : null,
            },
          },
        });
      }
      if (path.endsWith('/releases/latest'))
        return state.latest ? http(state.latest) : http({}, 404);
      if (path.endsWith('/git/ref/tags/v1.0.0')) return state.ref ? http(state.ref) : http({}, 404);
      if (path.includes('/git/tags/')) {
        const tagObjectSha = path.split('/').at(-1);
        assert(tagObjectSha);
        return http(state.tagObjects[tagObjectSha]);
      }
      if (path.endsWith('/git/refs') && method === 'POST') {
        expect(args).toContain('ref=refs/tags/v1.0.0');
        expect(args).toContain(`sha=${sha}`);
        state.ref = { object: { type: 'commit', sha } };
        state.mutations.push('create-tag');
        return http(state.ref, 201);
      }
      if (path.endsWith('/releases/1')) return http(state.release);
      if (path.endsWith('/releases') && method === 'POST') {
        for (const field of [
          'tag_name=v1.0.0',
          `target_commitish=${sha}`,
          'name=v1.0.0',
          'draft=true',
          'prerelease=false',
        ])
          expect(args).toContain(field);
        const notesField = args.find((arg) => arg.startsWith('body=@'));
        assert(notesField);
        const notesFile = notesField.slice('body=@'.length);
        const notes = readFileSync(notesFile, 'utf8');
        expect(notes).toContain(assetName);
        expect(notes).toContain('自動更新には対応しません');
        state.release = {
          id: 1,
          tag_name: tag,
          draft: true,
          prerelease: false,
          target_commitish: sha,
          assets: [],
        };
        state.mutations.push('create');
        return http(state.createdResponse ?? state.release, 201);
      }
      assert.fail(`Unexpected API call ${method} ${path}`);
    }
    expect(args[0]).toBe('release');
    expect(args[2]).toBe(tag);
    expect(args).toEqual(expect.arrayContaining(['--repo', 'owner/repo']));
    const action = args[1];
    if (action === 'upload') {
      expect(args[3]).toBe(zip);
      expect(args).not.toContain('--clobber');
      if (state.uploadFails) return { status: 1, stdout: '', stderr: 'upload network failure' };
      assert(state.release?.assets);
      state.release.assets.push({ ...uploadedAsset });
    } else if (action === 'edit') {
      expect(args).toEqual(expect.arrayContaining(['--draft=false', '--latest']));
      assert(state.release);
      state.release.draft = false;
    } else {
      assert.fail(`Unexpected release action ${action}`);
    }
    state.mutations.push(action);
    return { status: 0, stdout: '', stderr: '' };
  };
  const invoke = (checkOnly: boolean, env: ReleaseEnvironment = {}) =>
    release({
      cwd,
      env: { GITHUB_REPOSITORY: 'owner/repo', GITHUB_SHA: sha, ...env },
      run,
      log() {},
      checkOnly,
    });
  return {
    cwd,
    zip,
    state,
    publish: (env: ReleaseEnvironment = {}) => invoke(false, env),
    check: (env: ReleaseEnvironment = {}) => invoke(true, env),
  };
}

function expectReadOnlyLookup(state: FixtureState): void {
  expect(state.mutations).toEqual([]);
  for (const call of state.calls) {
    expect(call.slice(0, 3)).toEqual(['gh', 'api', '--include']);
    const method = call[call.indexOf('--method') + 1];
    const path = call[call.indexOf('--method') + 2];
    if (path === 'graphql') {
      expect(method).toBe('POST');
      // GraphQL uses POST for reads too; the operation must remain a query.
      expect(call.find((field) => field.startsWith('query='))).toMatch(/^query=query\(/);
    } else {
      expect(method).toBe('GET');
      expect(path).toMatch(/^repos\/owner\/repo\/releases\/(tags\/v1\.0\.0|1)$/);
    }
  }
}

test('metadata accepts stable Chrome versions and rejects ambiguous or unsupported versions', (t) => {
  expect(parseVersion('65535.1.0')).toEqual([65535, 1, 0]);
  for (const version of [
    '0.0.0',
    '01.0.0',
    '1.02.3',
    '1.0',
    '1.0.0.0',
    '1.0.0-beta.1',
    '65536.0.0',
    null,
  ]) {
    expect(() => parseVersion(version)).toThrow(/version/i);
  }
  const f = fixture(t);
  expect(metadata(f.cwd)).toEqual({ version: '1.0.0', tag, asset: assetName });
  const script = fileURLToPath(new URL('../scripts/release.ts', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--metadata'], {
    cwd: f.cwd,
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('version=1.0.0\ntag=v1.0.0\n');
});

test('auth, rate-limit, server, and network failures are never treated as missing releases', (t) => {
  for (const status of [401, 403, 429, 500]) {
    const f = fixture(t, {
      apiErrors: { 'repos/owner/repo/releases/tags/v1.0.0': http({}, status) },
    });
    expect(() => f.publish()).toThrow(new RegExp(`HTTP ${status}`));
    expect(f.state.mutations).toEqual([]);
  }
  const f = fixture(t, {
    apiErrors: { graphql: { status: 1, stdout: '', stderr: 'network timeout' } },
  });
  expect(() => f.publish()).toThrow(/HTTP unknown/);
  expect(f.state.mutations).toEqual([]);
});

test('HTTP 200 GraphQL errors and an inaccessible repository cannot become a missing draft', (t) => {
  const f = fixture(t, {
    apiErrors: {
      graphql: http({
        errors: [{ message: 'Resource not accessible by integration' }],
        data: { repository: null },
      }),
    },
  });
  expect(() => f.publish()).toThrow(/GraphQL Release lookup failed: Resource not accessible/);
  expect(f.state.mutations).toEqual([]);
  const inaccessible = fixture(t, { apiErrors: { graphql: http({ data: { repository: null } }) } });
  expect(() => inaccessible.publish()).toThrow(/did not return the repository/);
  expect(inaccessible.state.mutations).toEqual([]);
});

test('published releases with the asset remain unchanged even when main has advanced', (t) => {
  const f = fixture(t, {
    release: { draft: false, tag_name: tag, assets: [uploadedAsset], target_commitish: sha },
  });
  rmSync(f.zip);
  expect(f.publish({ GITHUB_SHA: otherSha })).toEqual({ status: 'skipped', tag });
  expect(f.state.calls).toHaveLength(1);
  expect(f.state.mutations).toEqual([]);
});

test('preflight skips a complete published release without reading the ZIP or changing it', (t) => {
  const f = fixture(t, {
    release: { draft: false, tag_name: tag, assets: [uploadedAsset], target_commitish: sha },
  });
  rmSync(f.zip);
  expect(f.check({ GITHUB_SHA: otherSha })).toEqual({ status: 'skipped', tag });
  expect(f.state.calls).toHaveLength(1);
  expectReadOnlyLookup(f.state);
});

test('preflight reports missing or draft releases as pending using only release lookups', (t) => {
  for (const pending of [
    null,
    { id: 1, tag_name: tag, draft: true, target_commitish: sha, assets: [] },
    { id: 1, tag_name: tag, draft: true, target_commitish: otherSha, assets: [uploadedAsset] },
  ]) {
    const f = fixture(t, {
      release: pending,
      latest: { tag_name: 'v2.0.0' },
      ref: { object: { type: 'commit', sha: otherSha } },
    });
    rmSync(f.zip);
    expect(f.check()).toEqual({ status: 'needed', tag });
    expect(f.state.calls).toHaveLength(pending === null ? 2 : 3);
    expectReadOnlyLookup(f.state);
  }
});

test('preflight still rejects prereleases and incomplete published assets', (t) => {
  const prerelease = fixture(t, {
    release: { draft: false, prerelease: true, tag_name: tag, assets: [uploadedAsset] },
  });
  expect(() => prerelease.check()).toThrow(/only stable Releases/);
  expectReadOnlyLookup(prerelease.state);
  const incomplete = fixture(t, {
    release: { draft: false, tag_name: tag, assets: [{ ...uploadedAsset, state: 'starter' }] },
  });
  expect(() => incomplete.check()).toThrow(/Published.*missing/);
  expectReadOnlyLookup(incomplete.state);
});

test('preflight cannot turn API errors into an unnecessary or skipped publication', (t) => {
  for (const status of [401, 403, 429, 500]) {
    const f = fixture(t, {
      apiErrors: { 'repos/owner/repo/releases/tags/v1.0.0': http({}, status) },
    });
    expect(() => f.check()).toThrow(new RegExp(`HTTP ${status}`));
    expectReadOnlyLookup(f.state);
  }
  for (const response of [
    { status: 1, stdout: '', stderr: 'network timeout' },
    http({ errors: [{ message: 'Resource not accessible' }], data: { repository: null } }),
    http({ data: { repository: null } }),
  ]) {
    const f = fixture(t, { apiErrors: { graphql: response } });
    expect(() => f.check()).toThrow(/HTTP unknown|GraphQL Release lookup/);
    expectReadOnlyLookup(f.state);
  }
});

test('preflight validates repository, commit, and package version before querying GitHub', (t) => {
  for (const env of [{ GITHUB_REPOSITORY: '' }, { GITHUB_SHA: 'main' }]) {
    const f = fixture(t);
    expect(() => f.check(env)).toThrow(/GITHUB_REPOSITORY and a full 40-character GITHUB_SHA/);
    expect(f.state.calls).toEqual([]);
  }
  const f = fixture(t);
  writeFileSync(
    join(f.cwd, 'package.json'),
    JSON.stringify({ name: 'mtg-harness', version: 'bad' }),
  );
  expect(() => f.check()).toThrow(/stable three-part version/);
  expect(f.state.calls).toEqual([]);
});

test('published releases without the expected completed asset cannot be repaired automatically', (t) => {
  const f = fixture(t, { release: { draft: false, tag_name: tag, assets: [] } });
  expect(() => f.publish()).toThrow(/Published.*missing/);
  expect(f.state.mutations).toEqual([]);
  const prerelease = fixture(t, {
    release: { draft: false, prerelease: true, tag_name: tag, assets: [uploadedAsset] },
  });
  expect(() => prerelease.publish()).toThrow(/only stable Releases/);
  expect(prerelease.state.mutations).toEqual([]);
});

test('a stale or equal version cannot supersede the latest stable release', (t) => {
  for (const latestTag of ['v1.0.0', 'v1.1.0', 'v2.0.0']) {
    const f = fixture(t, { latest: { tag_name: latestTag } });
    expect(() => f.publish()).toThrow(/must be newer/);
    expect(f.state.mutations).toEqual([]);
  }
});

test('a preexisting tag at another commit fails before creating or uploading a release', (t) => {
  const f = fixture(t, { ref: { object: { type: 'commit', sha: otherSha } } });
  expect(() => f.publish()).toThrow(/Tag.*does not point/);
  expect(f.state.mutations).toEqual([]);
});

test('a first release creates the tested tag, draft, ZIP upload, then publishes', (t) => {
  const f = fixture(t, { hideDraftFromGraphql: true });
  expect(f.publish()).toEqual({ status: 'published', tag });
  expect(f.state.mutations).toEqual(['create-tag', 'create', 'upload', 'edit']);
  expect(f.state.release?.draft).toBe(false);
  expect(f.state.ref?.object?.sha).toBe(sha);
  expect(
    f.state.calls.filter((call) => call[0] === 'gh' && call.includes('graphql')),
    'The created draft is verified from its API response instead of rediscovered',
  ).toHaveLength(1);
});

test('invalid creation metadata fails with diagnostic fields before uploading or publishing', (t) => {
  const f = fixture(t, {
    createdResponse: { id: 1, tag_name: tag, draft: true, target_commitish: otherSha },
  });
  expect(() => f.publish()).toThrow(
    /created draft could not be verified \(id=1, draft=true, target=b{40}\)/,
  );
  expect(f.state.mutations).toEqual(['create-tag', 'create']);
});

test('an increased version publishes after an existing stable release', (t) => {
  const f = fixture(t, { latest: { tag_name: 'v0.9.9' } });
  expect(f.publish()).toEqual({ status: 'published', tag });
  expect(f.state.mutations).toEqual(['create-tag', 'create', 'upload', 'edit']);
});

test('annotated tags resolve to the commit instead of comparing tag object SHA', (t) => {
  const tagObjectSha = 'c'.repeat(40);
  const f = fixture(t, {
    ref: { object: { type: 'tag', sha: tagObjectSha } },
    tagObjects: { [tagObjectSha]: { object: { type: 'commit', sha } } },
  });
  f.publish();
  expect(f.state.mutations).toEqual(['create', 'upload', 'edit']);
  const mismatch = fixture(t, {
    ref: { object: { type: 'tag', sha: tagObjectSha } },
    tagObjects: { [tagObjectSha]: { object: { type: 'commit', sha: otherSha } } },
  });
  expect(() => mismatch.publish()).toThrow(/Tag.*does not point/);
  expect(mismatch.state.mutations).toEqual([]);
});

test('same-commit draft recovery uploads only a missing asset, never clobbering an earlier ZIP', (t) => {
  for (const assets of [[], [{ ...uploadedAsset, size: 9999 }]]) {
    const f = fixture(t, {
      ref: { object: { type: 'commit', sha } },
      release: { id: 1, tag_name: tag, draft: true, target_commitish: sha, assets },
    });
    f.publish();
    expect(f.state.mutations).toEqual(
      assets.length === 1 && assets[0]?.size === 9999 ? ['edit'] : ['upload', 'edit'],
    );
    expect(f.state.calls.some((call) => call.includes('graphql'))).toBe(true);
    expect(
      f.state.calls.filter((call) => call.includes('repos/owner/repo/releases/1')),
      'GraphQL databaseId resolves the draft before its final publish check',
    ).toHaveLength(2);
  }
});

test('a failed upload leaves a recoverable draft, and retry completes it without recreating the tag', (t) => {
  const f = fixture(t, { uploadFails: true });
  expect(() => f.publish()).toThrow(/upload network failure/);
  expect(f.state.release?.draft).toBe(true);
  expect(f.state.mutations).toEqual(['create-tag', 'create']);
  f.state.uploadFails = false;
  expect(f.publish()).toEqual({ status: 'published', tag });
  expect(f.state.mutations).toEqual(['create-tag', 'create', 'upload', 'edit']);
});

test('a draft for a different commit, incomplete asset, or wrong ZIP manifest is not published', (t) => {
  const wrongCommit = fixture(t, {
    release: { tag_name: tag, draft: true, target_commitish: otherSha },
  });
  expect(() => wrongCommit.publish()).toThrow(/Draft.*tested commit/);
  expect(wrongCommit.state.mutations).toEqual([]);
  const incomplete = fixture(t, {
    ref: { object: { type: 'commit', sha } },
    release: {
      id: 1,
      tag_name: tag,
      draft: true,
      target_commitish: sha,
      assets: [{ name: assetName, state: 'starter', size: 0 }],
    },
  });
  expect(() => incomplete.publish()).toThrow(/incomplete ZIP/);
  expect(incomplete.state.mutations).toEqual([]);
  for (const manifest of [
    { manifest_version: 2, version: '1.0.0' },
    { manifest_version: 3, version: '1.0.1' },
  ]) {
    const f = fixture(t, { manifest });
    expect(() => f.publish()).toThrow(/ZIP manifest/);
    expect(f.state.mutations).toEqual([]);
  }
});

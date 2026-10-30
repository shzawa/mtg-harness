import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { metadata, parseVersion, release, type GitHubRelease, type GitReference, type ProcessResult, type ProcessRunner, type ReleaseEnvironment, type ZipManifest } from '../scripts/release.ts';

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
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'mtg-harness', version: '1.0.0' }));
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
      assert.deepEqual(args, ['-p', zip, 'manifest.json']);
      return { status: 0, stdout: JSON.stringify(state.manifest), stderr: '' };
    }
    assert.equal(command, 'gh');
    if (args[0] === 'api') {
      const path = args[args.indexOf('--method') + 2];
      const method = args[args.indexOf('--method') + 1];
      assert.ok(path && method);
      if (state.apiErrors[path]) return state.apiErrors[path];
      if (path.endsWith('/releases/tags/v1.0.0')) return state.release && !state.release.draft ? http(state.release) : http({}, 404);
      if (path === 'graphql') {
        assert.ok(args.some((arg) => arg.includes('release(tagName:$tag){databaseId isDraft}')));
        assert.ok(args.includes('owner=owner') && args.includes('name=repo') && args.includes('tag=v1.0.0'));
        return http({ data: { repository: { release: state.release && !state.hideDraftFromGraphql ? { databaseId: 1, isDraft: state.release.draft } : null } } });
      }
      if (path.endsWith('/releases/latest')) return state.latest ? http(state.latest) : http({}, 404);
      if (path.endsWith('/git/ref/tags/v1.0.0')) return state.ref ? http(state.ref) : http({}, 404);
      if (path.includes('/git/tags/')) {
        const tagObjectSha = path.split('/').at(-1);
        assert.ok(tagObjectSha);
        return http(state.tagObjects[tagObjectSha]);
      }
      if (path.endsWith('/git/refs') && method === 'POST') {
        assert.ok(args.includes('ref=refs/tags/v1.0.0'));
        assert.ok(args.includes(`sha=${sha}`));
        state.ref = { object: { type: 'commit', sha } };
        state.mutations.push('create-tag');
        return http(state.ref, 201);
      }
      if (path.endsWith('/releases/1')) return http(state.release);
      if (path.endsWith('/releases') && method === 'POST') {
        for (const field of ['tag_name=v1.0.0', `target_commitish=${sha}`, 'name=v1.0.0', 'draft=true', 'prerelease=false']) assert.ok(args.includes(field));
        const notesField = args.find((arg) => arg.startsWith('body=@'));
        assert.ok(notesField);
        const notesFile = notesField.slice('body=@'.length);
        const notes = readFileSync(notesFile, 'utf8');
        assert.ok(notes.includes(assetName) && notes.includes('自動更新には対応しません'));
        state.release = { id: 1, tag_name: tag, draft: true, prerelease: false, target_commitish: sha, assets: [] };
        state.mutations.push('create');
        return http(state.createdResponse ?? state.release, 201);
      }
      assert.fail(`Unexpected API call ${method} ${path}`);
    }
    assert.equal(args[0], 'release');
    assert.equal(args[2], tag);
    assert.ok(args.includes('--repo'));
    assert.ok(args.includes('owner/repo'));
    const action = args[1];
    if (action === 'upload') {
      assert.equal(args[3], zip);
      assert.ok(!args.includes('--clobber'));
      if (state.uploadFails) return { status: 1, stdout: '', stderr: 'upload network failure' };
      assert.ok(state.release?.assets);
      state.release.assets.push({ ...uploadedAsset });
    } else if (action === 'edit') {
      assert.ok(args.includes('--draft=false') && args.includes('--latest'));
      assert.ok(state.release);
      state.release.draft = false;
    } else {
      assert.fail(`Unexpected release action ${action}`);
    }
    state.mutations.push(action);
    return { status: 0, stdout: '', stderr: '' };
  };
  return {
    cwd, zip, state,
    publish: (env: ReleaseEnvironment = {}) => release({ cwd, env: { GITHUB_REPOSITORY: 'owner/repo', GITHUB_SHA: sha, ...env }, run, log() {} }),
  };
}

test('metadata accepts stable Chrome versions and rejects ambiguous or unsupported versions', (t) => {
  assert.deepEqual(parseVersion('65535.1.0'), [65535, 1, 0]);
  for (const version of ['0.0.0', '01.0.0', '1.02.3', '1.0', '1.0.0.0', '1.0.0-beta.1', '65536.0.0', null]) {
    assert.throws(() => parseVersion(version), /version/i);
  }
  const f = fixture(t);
  assert.deepEqual(metadata(f.cwd), { version: '1.0.0', tag, asset: assetName });
  const script = fileURLToPath(new URL('../scripts/release.ts', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--metadata'], { cwd: f.cwd, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'version=1.0.0\ntag=v1.0.0\n');
});

test('auth, rate-limit, server, and network failures are never treated as missing releases', (t) => {
  for (const status of [401, 403, 429, 500]) {
    const f = fixture(t, { apiErrors: { 'repos/owner/repo/releases/tags/v1.0.0': http({}, status) } });
    assert.throws(() => f.publish(), new RegExp(`HTTP ${status}`));
    assert.deepEqual(f.state.mutations, []);
  }
  const f = fixture(t, { apiErrors: { graphql: { status: 1, stdout: '', stderr: 'network timeout' } } });
  assert.throws(() => f.publish(), /HTTP unknown/);
  assert.deepEqual(f.state.mutations, []);
});

test('HTTP 200 GraphQL errors and an inaccessible repository cannot become a missing draft', (t) => {
  const f = fixture(t, { apiErrors: { graphql: http({ errors: [{ message: 'Resource not accessible by integration' }], data: { repository: null } }) } });
  assert.throws(() => f.publish(), /GraphQL Release lookup failed: Resource not accessible/);
  assert.deepEqual(f.state.mutations, []);
  const inaccessible = fixture(t, { apiErrors: { graphql: http({ data: { repository: null } }) } });
  assert.throws(() => inaccessible.publish(), /did not return the repository/);
  assert.deepEqual(inaccessible.state.mutations, []);
});

test('published releases with the asset remain unchanged even when main has advanced', (t) => {
  const f = fixture(t, { release: { draft: false, tag_name: tag, assets: [uploadedAsset], target_commitish: sha } });
  rmSync(f.zip);
  assert.deepEqual(f.publish({ GITHUB_SHA: otherSha }), { status: 'skipped', tag });
  assert.equal(f.state.calls.length, 1);
  assert.deepEqual(f.state.mutations, []);
});

test('published releases without the expected completed asset cannot be repaired automatically', (t) => {
  const f = fixture(t, { release: { draft: false, tag_name: tag, assets: [] } });
  assert.throws(() => f.publish(), /Published.*missing/);
  assert.deepEqual(f.state.mutations, []);
  const prerelease = fixture(t, { release: { draft: false, prerelease: true, tag_name: tag, assets: [uploadedAsset] } });
  assert.throws(() => prerelease.publish(), /only stable Releases/);
  assert.deepEqual(prerelease.state.mutations, []);
});

test('a stale or equal version cannot supersede the latest stable release', (t) => {
  for (const latestTag of ['v1.0.0', 'v1.1.0', 'v2.0.0']) {
    const f = fixture(t, { latest: { tag_name: latestTag } });
    assert.throws(() => f.publish(), /must be newer/);
    assert.deepEqual(f.state.mutations, []);
  }
});

test('a preexisting tag at another commit fails before creating or uploading a release', (t) => {
  const f = fixture(t, { ref: { object: { type: 'commit', sha: otherSha } } });
  assert.throws(() => f.publish(), /Tag.*does not point/);
  assert.deepEqual(f.state.mutations, []);
});

test('a first release creates the tested tag, draft, ZIP upload, then publishes', (t) => {
  const f = fixture(t, { hideDraftFromGraphql: true });
  assert.deepEqual(f.publish(), { status: 'published', tag });
  assert.deepEqual(f.state.mutations, ['create-tag', 'create', 'upload', 'edit']);
  assert.ok(f.state.release && f.state.ref?.object);
  assert.equal(f.state.release.draft, false);
  assert.equal(f.state.ref.object.sha, sha);
  assert.equal(f.state.calls.filter((call) => call[0] === 'gh' && call.includes('graphql')).length, 1, 'The created draft is verified from its API response instead of rediscovered');
});

test('invalid creation metadata fails with diagnostic fields before uploading or publishing', (t) => {
  const f = fixture(t, { createdResponse: { id: 1, tag_name: tag, draft: true, target_commitish: otherSha } });
  assert.throws(() => f.publish(), /created draft could not be verified \(id=1, draft=true, target=b{40}\)/);
  assert.deepEqual(f.state.mutations, ['create-tag', 'create']);
});

test('an increased version publishes after an existing stable release', (t) => {
  const f = fixture(t, { latest: { tag_name: 'v0.9.9' } });
  assert.deepEqual(f.publish(), { status: 'published', tag });
  assert.deepEqual(f.state.mutations, ['create-tag', 'create', 'upload', 'edit']);
});

test('annotated tags resolve to the commit instead of comparing tag object SHA', (t) => {
  const tagObjectSha = 'c'.repeat(40);
  const f = fixture(t, {
    ref: { object: { type: 'tag', sha: tagObjectSha } },
    tagObjects: { [tagObjectSha]: { object: { type: 'commit', sha } } },
  });
  f.publish();
  assert.deepEqual(f.state.mutations, ['create', 'upload', 'edit']);
  const mismatch = fixture(t, {
    ref: { object: { type: 'tag', sha: tagObjectSha } },
    tagObjects: { [tagObjectSha]: { object: { type: 'commit', sha: otherSha } } },
  });
  assert.throws(() => mismatch.publish(), /Tag.*does not point/);
  assert.deepEqual(mismatch.state.mutations, []);
});

test('same-commit draft recovery uploads only a missing asset, never clobbering an earlier ZIP', (t) => {
  for (const assets of [[], [{ ...uploadedAsset, size: 9999 }]]) {
    const f = fixture(t, {
      ref: { object: { type: 'commit', sha } },
      release: { id: 1, tag_name: tag, draft: true, target_commitish: sha, assets },
    });
    f.publish();
    assert.deepEqual(f.state.mutations, assets.length === 1 && assets[0]?.size === 9999 ? ['edit'] : ['upload', 'edit']);
    assert.ok(f.state.calls.some((call) => call.includes('graphql')));
    assert.equal(f.state.calls.filter((call) => call.includes('repos/owner/repo/releases/1')).length, 2, 'GraphQL databaseId resolves the draft before its final publish check');
  }
});

test('a failed upload leaves a recoverable draft, and retry completes it without recreating the tag', (t) => {
  const f = fixture(t, { uploadFails: true });
  assert.throws(() => f.publish(), /upload network failure/);
  assert.ok(f.state.release);
  assert.equal(f.state.release.draft, true);
  assert.deepEqual(f.state.mutations, ['create-tag', 'create']);
  f.state.uploadFails = false;
  assert.deepEqual(f.publish(), { status: 'published', tag });
  assert.deepEqual(f.state.mutations, ['create-tag', 'create', 'upload', 'edit']);
});

test('a draft for a different commit, incomplete asset, or wrong ZIP manifest is not published', (t) => {
  const wrongCommit = fixture(t, { release: { tag_name: tag, draft: true, target_commitish: otherSha } });
  assert.throws(() => wrongCommit.publish(), /Draft.*tested commit/);
  assert.deepEqual(wrongCommit.state.mutations, []);
  const incomplete = fixture(t, { ref: { object: { type: 'commit', sha } }, release: {
    id: 1, tag_name: tag, draft: true, target_commitish: sha, assets: [{ name: assetName, state: 'starter', size: 0 }],
  } });
  assert.throws(() => incomplete.publish(), /incomplete ZIP/);
  assert.deepEqual(incomplete.state.mutations, []);
  for (const manifest of [{ manifest_version: 2, version: '1.0.0' }, { manifest_version: 3, version: '1.0.1' }]) {
    const f = fixture(t, { manifest });
    assert.throws(() => f.publish(), /ZIP manifest/);
    assert.deepEqual(f.state.mutations, []);
  }
});

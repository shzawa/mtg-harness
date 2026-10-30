import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Expected a stable three-part version, received ${JSON.stringify(version)}`);
  }
  const parts = version.split('.').map(Number);
  if (parts.some((part) => part > 65535) || parts.every((part) => part === 0)) {
    throw new Error(`Version ${version} is outside Chrome's version range`);
  }
  return parts;
}

export function metadata(cwd = process.cwd()) {
  const { version } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  parseVersion(version);
  return { version, tag: `v${version}`, asset: `meet-tab-guard-${version}-chrome.zip` };
}

function defaultRunner(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
}

function notes(version, asset) {
  return `# Meet Tab Guard ${version}

Google Meet の /meet/ で始まるページを閉じる前に、ブラウザ標準の確認を表示します。

## インストール

1. この Release の ${asset} をダウンロードして解凍します。
2. Chrome の chrome://extensions（Edge は edge://extensions）でデベロッパーモードをオンにします。
3. 「パッケージ化されていない拡張機能を読み込む」から、manifest.json のある解凍済みフォルダを選びます。
4. フォルダは削除・移動せず保管し、会議参加前に対象タブを再読み込みしてください。

自動更新には対応しません。新しい ZIP を解凍して拡張を読み込み直してください。

確認を有効にするにはページ内で一度操作してください。再読み込み・別ページへの移動でも確認が出ます。
会議参加中の接続維持は実会議で未検証です。
`;
}

export function release({ cwd = process.cwd(), env = process.env, run = defaultRunner, log = console.log } = {}) {
  const { version, tag, asset } = metadata(cwd);
  const repo = env.GITHUB_REPOSITORY;
  const sha = env.GITHUB_SHA?.toLowerCase();
  if (!/^[a-z\d][a-z\d-]*\/[a-z\d][a-z\d_.-]*$/i.test(repo ?? '') || !/^[a-f\d]{40}$/.test(sha ?? '')) {
    throw new Error('GITHUB_REPOSITORY and a full 40-character GITHUB_SHA are required');
  }
  const base = `repos/${repo}`;
  const command = (program, args) => {
    const result = run(program, args);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${program} failed: ${result.stderr || result.stdout || result.status}`);
    return result.stdout;
  };
  const api = (path, { missing = false, method = 'GET', fields = [] } = {}) => {
    const result = run('gh', ['api', '--include', '--method', method, path, ...fields]);
    if (result.error) throw result.error;
    const status = Number(result.stdout?.match(/^HTTP\/[\d.]+\s+(\d{3})\b/)?.[1]);
    if (status === 404 && missing) return null;
    if (result.status !== 0 || status < 200 || status >= 300 || !status) {
      throw new Error(`GitHub API ${method} ${path} failed (HTTP ${status || 'unknown'}): ${result.stderr || ''}`);
    }
    return JSON.parse(result.stdout.split(/\r?\n\r?\n/).slice(1).join('\n\n'));
  };
  const findRelease = () => {
    const published = api(`${base}/releases/tags/${tag}`, { missing: true });
    if (published) return published;
    // Pending draft tags are not returned by the REST tag lookup.
    for (let page = 1; ; page++) {
      const releases = api(`${base}/releases?per_page=100&page=${page}`);
      const found = releases.find((item) => item.tag_name === tag);
      if (found) return found;
      if (releases.length < 100) return null;
    }
  };
  const hasAsset = (item) => item.assets?.some((file) => file.name === asset && file.state === 'uploaded' && file.size > 0);
  let existing = findRelease();
  if (existing?.prerelease) throw new Error(`${tag} is marked as a prerelease; only stable Releases are supported`);
  if (existing && !existing.draft) {
    if (!hasAsset(existing)) throw new Error(`Published ${tag} is missing its completed ZIP asset; refusing to change it`);
    log(`${tag} is already published with ${asset}; no changes made`);
    return { status: 'skipped', tag };
  }
  if (existing && existing.target_commitish?.toLowerCase() !== sha) {
    throw new Error(`Draft ${tag} does not target the tested commit ${sha}`);
  }

  const zip = join(cwd, 'release-assets', asset);
  if (statSync(zip).size === 0) throw new Error('The tested ZIP is empty');
  const manifest = JSON.parse(command('unzip', ['-p', zip, 'manifest.json']));
  if (manifest.manifest_version !== 3 || manifest.version !== version ||
      (manifest.version_name !== undefined && manifest.version_name !== version)) {
    throw new Error('The tested ZIP manifest does not match the stable package version and Manifest V3');
  }
  const latest = api(`${base}/releases/latest`, { missing: true });
  if (latest) {
    const previous = parseVersion(latest.tag_name.replace(/^v/, ''));
    const current = parseVersion(version);
    const difference = current.map((part, index) => part - previous[index]).find((part) => part !== 0) ?? 0;
    if (difference <= 0) throw new Error(`${tag} must be newer than latest Release ${latest.tag_name}`);
  }
  let ref = api(`${base}/git/ref/tags/${tag}`, { missing: true });
  if (ref) {
    const seen = new Set();
    while (ref.object?.type === 'tag') {
      if (seen.has(ref.object.sha)) throw new Error('Annotated tag contains a cycle');
      seen.add(ref.object.sha);
      ref = api(`${base}/git/tags/${ref.object.sha}`);
    }
    if (ref.object?.type !== 'commit' || ref.object.sha?.toLowerCase() !== sha) {
      throw new Error(`Tag ${tag} does not point to tested commit ${sha}`);
    }
  } else {
    api(`${base}/git/refs`, { method: 'POST', fields: ['-f', `ref=refs/tags/${tag}`, '-f', `sha=${sha}`] });
  }
  const temp = mkdtempSync(join(tmpdir(), 'meet-tab-guard-release-'));
  try {
    if (!existing) {
      const notesFile = join(temp, 'release-notes.md');
      writeFileSync(notesFile, notes(version, asset));
      command('gh', ['release', 'create', tag, '--repo', repo, '--draft', '--verify-tag', '--target', sha, '--title', tag, '--notes-file', notesFile]);
      existing = findRelease();
      if (!existing?.draft || existing.target_commitish?.toLowerCase() !== sha) throw new Error('The created draft could not be verified');
    }
    if (!hasAsset(existing)) {
      if (existing.assets?.some((file) => file.name === asset)) throw new Error(`Draft ${tag} has an incomplete ZIP asset; refusing to overwrite it`);
      command('gh', ['release', 'upload', tag, zip, '--repo', repo]);
    }
    const ready = api(`${base}/releases/${existing.id}`);
    if (!ready.draft || ready.target_commitish?.toLowerCase() !== sha || !hasAsset(ready)) {
      throw new Error('The draft and its completed ZIP could not be verified before publishing');
    }
    command('gh', ['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest']);
    log(`Published ${tag} with ${asset}`);
    return { status: 'published', tag };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--metadata') {
      const { version, tag } = metadata();
      console.log(`version=${version}\ntag=${tag}`);
    } else if (process.argv.length === 2) {
      release();
    } else {
      throw new Error('Usage: node scripts/release.mjs [--metadata]');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

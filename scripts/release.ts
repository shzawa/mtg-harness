import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}
export type ProcessRunner = (command: string, args: readonly string[]) => ProcessResult;
export interface ReleaseAsset {
  name: string;
  state: string;
  size: number;
}
export interface GitHubRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  target_commitish: string;
  assets: ReleaseAsset[];
}
export interface GitReference {
  object?: { type: 'commit' | 'tag' | 'tree' | 'blob'; sha: string };
}
export interface ZipManifest {
  manifest_version: number;
  version: string;
  version_name?: string;
}
export interface ReleaseEnvironment {
  GITHUB_REPOSITORY?: string;
  GITHUB_SHA?: string;
}
interface ReleaseOptions {
  cwd?: string;
  env?: ReleaseEnvironment;
  run?: ProcessRunner;
  log?: (message: string) => void;
  /** Report pending publication without creating or changing remote resources. */
  checkOnly?: boolean;
}
interface ApiOptions {
  missing?: boolean;
  method?: 'GET' | 'POST';
  fields?: readonly string[];
}
interface GraphQLReleaseLookup {
  errors?: { message: string }[];
  data?: { repository?: { release?: { databaseId: number; isDraft: boolean } | null } | null };
}
type VersionParts = [number, number, number];

function parseJsonObject<T extends object>(source: string, label: string): T {
  const value: unknown = JSON.parse(source);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  // Endpoint-specific interfaces describe GitHub's contract; publication gates
  // below still verify the fields that determine external changes.
  return value as T;
}

export function parseVersion(version: unknown): VersionParts {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Expected a stable three-part version, received ${JSON.stringify(version)}`);
  }
  const parts = version.split('.').map(Number);
  if (parts.some((part) => part > 65535) || parts.every((part) => part === 0)) {
    throw new Error(`Version ${version} is outside Chrome's version range`);
  }
  return parts as VersionParts;
}

export function metadata(cwd = process.cwd()): { version: string; tag: string; asset: string } {
  const { name, version } = parseJsonObject<{ name: string; version: string }>(
    readFileSync(join(cwd, 'package.json'), 'utf8'),
    'package.json',
  );
  parseVersion(version);
  return { version, tag: `v${version}`, asset: `${name}-${version}-chrome.zip` };
}

const defaultRunner: ProcessRunner = (command, args) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
};

function notes(version: string, asset: string): string {
  return `# MTG Harness ${version}

Google Meet の /meet/ で始まるページを閉じる前に、ブラウザ標準の確認を表示します。
日本語の退出後画面では、表示中の h1 が「ミーティングから退出しました」と一致した場合だけ、この拡張の確認を省略します。再参加してこの見出しが消えると、確認が再び有効になります。

## インストール

1. この Release の ${asset} をダウンロードして解凍します。
2. Chrome の chrome://extensions（Edge は edge://extensions）でデベロッパーモードをオンにします。
3. 「パッケージ化されていない拡張機能を読み込む」から、manifest.json のある解凍済みフォルダを選びます。
4. フォルダは削除・移動せず保管し、会議参加前に対象タブを再読み込みしてください。

自動更新には対応しません。新しい ZIP を解凍して拡張を読み込み直してください。

本体は MIT License です。ZIP 内の LICENSE と THIRD_PARTY_NOTICES.txt に、プロジェクトとバンドルされた第三者コードのライセンス全文を同梱しています。

確認を有効にするにはページ内で一度操作してください。再読み込み・別ページへの移動でも確認が出ます。
会議参加中の接続維持は実会議で未検証です。
`;
}

export function release({
  cwd = process.cwd(),
  env = process.env,
  run = defaultRunner,
  log = console.log,
  checkOnly = false,
}: ReleaseOptions = {}): { status: 'skipped' | 'published' | 'needed'; tag: string } {
  const { version, tag, asset } = metadata(cwd);
  const repo = env.GITHUB_REPOSITORY ?? '';
  const sha = env.GITHUB_SHA?.toLowerCase() ?? '';
  if (
    !/^[a-z\d][a-z\d-]*\/[a-z\d][a-z\d_.-]*$/i.test(repo ?? '') ||
    !/^[a-f\d]{40}$/.test(sha ?? '')
  ) {
    throw new Error('GITHUB_REPOSITORY and a full 40-character GITHUB_SHA are required');
  }
  const base = `repos/${repo}`;
  const command = (program: string, args: readonly string[]): string => {
    const result = run(program, args);
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`${program} failed: ${result.stderr || result.stdout || result.status}`);
    return result.stdout;
  };
  function api<T extends object>(path: string, options: ApiOptions & { missing: true }): T | null;
  function api<T extends object>(path: string, options?: ApiOptions & { missing?: false }): T;
  function api<T extends object>(
    path: string,
    { missing = false, method = 'GET', fields = [] }: ApiOptions = {},
  ): T | null {
    const result = run('gh', ['api', '--include', '--method', method, path, ...fields]);
    if (result.error) throw result.error;
    const status = Number(result.stdout?.match(/^HTTP\/[\d.]+\s+(\d{3})\b/)?.[1]);
    if (status === 404 && missing) return null;
    if (result.status !== 0 || status < 200 || status >= 300 || !status) {
      throw new Error(
        `GitHub API ${method} ${path} failed (HTTP ${status || 'unknown'}): ${result.stderr || ''}`,
      );
    }
    return parseJsonObject<T>(
      result.stdout
        .split(/\r?\n\r?\n/)
        .slice(1)
        .join('\n\n'),
      'GitHub API response',
    );
  }
  const findRelease = (): GitHubRelease | null => {
    const published = api<GitHubRelease>(`${base}/releases/tags/${tag}`, { missing: true });
    if (published) return published;
    // Match gh's pending-draft lookup: REST tag/list results may omit drafts.
    const [owner, name] = repo.split('/');
    const result = api<GraphQLReleaseLookup>('graphql', {
      method: 'POST',
      fields: [
        '-f',
        'query=query($owner:String!,$name:String!,$tag:String!){repository(owner:$owner,name:$name){release(tagName:$tag){databaseId isDraft}}}',
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${name}`,
        '-f',
        `tag=${tag}`,
      ],
    });
    if (result.errors?.length)
      throw new Error(
        `GraphQL Release lookup failed: ${result.errors.map((error) => error.message).join('; ')}`,
      );
    if (!result.data?.repository)
      throw new Error('GraphQL Release lookup did not return the repository');
    const found = result.data.repository.release;
    if (!found) return null;
    if (!Number.isSafeInteger(found.databaseId) || found.databaseId <= 0)
      throw new Error('GraphQL Release lookup returned an invalid ID');
    return api<GitHubRelease>(`${base}/releases/${found.databaseId}`);
  };
  const hasAsset = (item: GitHubRelease): boolean =>
    item.assets?.some((file) => file.name === asset && file.state === 'uploaded' && file.size > 0);
  let existing = findRelease();
  if (existing?.prerelease)
    throw new Error(`${tag} is marked as a prerelease; only stable Releases are supported`);
  if (existing && !existing.draft) {
    if (!hasAsset(existing))
      throw new Error(`Published ${tag} is missing its completed ZIP asset; refusing to change it`);
    log(`${tag} is already published with ${asset}; no changes made`);
    return { status: 'skipped', tag };
  }
  if (checkOnly) return { status: 'needed', tag };
  if (existing && existing.target_commitish?.toLowerCase() !== sha) {
    throw new Error(`Draft ${tag} does not target the tested commit ${sha}`);
  }

  const zip = join(cwd, 'release-assets', asset);
  if (statSync(zip).size === 0) throw new Error('The tested ZIP is empty');
  const manifest = parseJsonObject<ZipManifest>(
    command('unzip', ['-p', zip, 'manifest.json']),
    'ZIP manifest',
  );
  if (
    manifest.manifest_version !== 3 ||
    manifest.version !== version ||
    (manifest.version_name !== undefined && manifest.version_name !== version)
  ) {
    throw new Error(
      'The tested ZIP manifest does not match the stable package version and Manifest V3',
    );
  }
  const latest = api<GitHubRelease>(`${base}/releases/latest`, { missing: true });
  if (latest) {
    const previous = parseVersion(latest.tag_name.replace(/^v/, ''));
    const current = parseVersion(version);
    const difference =
      current[0] - previous[0] || current[1] - previous[1] || current[2] - previous[2];
    if (difference <= 0)
      throw new Error(`${tag} must be newer than latest Release ${latest.tag_name}`);
  }
  let ref = api<GitReference>(`${base}/git/ref/tags/${tag}`, { missing: true });
  if (ref) {
    const seen = new Set<string>();
    while (ref.object?.type === 'tag') {
      if (seen.has(ref.object.sha)) throw new Error('Annotated tag contains a cycle');
      seen.add(ref.object.sha);
      ref = api<GitReference>(`${base}/git/tags/${ref.object.sha}`);
    }
    if (ref.object?.type !== 'commit' || ref.object.sha?.toLowerCase() !== sha) {
      throw new Error(`Tag ${tag} does not point to tested commit ${sha}`);
    }
  } else {
    api<GitReference>(`${base}/git/refs`, {
      method: 'POST',
      fields: ['-f', `ref=refs/tags/${tag}`, '-f', `sha=${sha}`],
    });
  }
  const temp = mkdtempSync(join(tmpdir(), 'mtg-harness-release-'));
  try {
    if (!existing) {
      const notesFile = join(temp, 'release-notes.md');
      writeFileSync(notesFile, notes(version, asset));
      // Use the creation response instead of immediately rediscovering the draft.
      existing = api<GitHubRelease>(`${base}/releases`, {
        method: 'POST',
        fields: [
          '-f',
          `tag_name=${tag}`,
          '-f',
          `target_commitish=${sha}`,
          '-f',
          `name=${tag}`,
          '-F',
          'draft=true',
          '-F',
          'prerelease=false',
          '-F',
          `body=@${notesFile}`,
        ],
      });
      if (
        !Number.isSafeInteger(existing?.id) ||
        !existing.draft ||
        existing.tag_name !== tag ||
        existing.prerelease ||
        existing.target_commitish?.toLowerCase() !== sha
      ) {
        throw new Error(
          `The created draft could not be verified (id=${existing?.id}, draft=${existing?.draft}, target=${existing?.target_commitish})`,
        );
      }
    }
    if (!hasAsset(existing)) {
      if (existing.assets?.some((file) => file.name === asset))
        throw new Error(`Draft ${tag} has an incomplete ZIP asset; refusing to overwrite it`);
      command('gh', ['release', 'upload', tag, zip, '--repo', repo]);
    }
    const ready = api<GitHubRelease>(`${base}/releases/${existing.id}`);
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
    } else if (process.argv.length === 3 && process.argv[2] === '--check-release') {
      const result = release({ checkOnly: true, log() {} });
      console.log(`release_needed=${result.status === 'needed'}`);
    } else if (process.argv.length === 2) {
      release();
    } else {
      throw new Error('Usage: node scripts/release.ts [--metadata | --check-release]');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface WorkflowRun {
  id: number;
  event: string;
  conclusion: string;
  head_sha: string;
  head_repository: { full_name: string };
  repository: { full_name: string };
  pull_requests: { number: number }[];
}

interface PullRequest {
  number: number;
  state: string;
  body: string | null;
  head: { sha: string; repo: { full_name: string } | null };
  base: { repo: { full_name: string } };
}

interface Artifact {
  id: number;
  name: string;
  expired: boolean;
  expires_at: string;
}

export type PreviewApi = (path: string, body?: { body: string }) => Promise<unknown>;
const start = '<!-- mtg-harness-preview:start -->';
const end = '<!-- mtg-harness-preview:end -->';

export function replacePreview(body: string | null, section: string): string {
  const text = body ?? '';
  const block = `${start}\n${section}\n${end}`;
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from === -1 && to === -1) return `${text}${text ? '\n\n' : ''}${block}`;
  if (
    from === -1 ||
    to < from ||
    text.indexOf(start, from + start.length) !== -1 ||
    text.indexOf(end, to + end.length) !== -1
  )
    throw new Error('Preview markers are malformed; refusing to overwrite the PR description');
  return `${text.slice(0, from)}${block}${text.slice(to + end.length)}`;
}

/** GitHub metadata only: no PR code or downloaded artifacts are executed. */
export async function updatePreview(
  run: WorkflowRun,
  repository: string,
  api: PreviewApi,
): Promise<void> {
  if (run.event !== 'pull_request' || run.repository.full_name !== repository) return;
  const root = `/repos/${repository}`;
  const runUrl = `https://github.com/${repository}/actions/runs/${run.id}`;
  // workflow_run.pull_requests can be empty for fork PRs.
  const candidates = run.pull_requests.length
    ? run.pull_requests
    : ((await api(`${root}/commits/${run.head_sha}/pulls?per_page=100`)) as PullRequest[]);
  for (const candidate of candidates) {
    const path = `${root}/pulls/${candidate.number}`;
    const pr = (await api(path)) as PullRequest;
    if (
      pr.state !== 'open' ||
      pr.base.repo.full_name !== repository ||
      pr.head.sha !== run.head_sha ||
      pr.head.repo?.full_name !== run.head_repository.full_name
    )
      continue;

    // Ignore delayed completions/re-runs of older runs for the same commit.
    const { workflow_runs: runs } = (await api(
      `${root}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${run.head_sha}&per_page=100`,
    )) as { workflow_runs: { id: number }[] };
    if (runs.some((other) => other.id > run.id)) continue;

    let download = `最新の CI は ${run.conclusion} です。プレビューは提供していません。`;
    if (run.conclusion === 'success') {
      const { artifacts } = (await api(
        `${root}/actions/runs/${run.id}/artifacts?per_page=100`,
      )) as { artifacts: Artifact[] };
      const artifact = artifacts.find((item) => item.name === 'chrome-extension' && !item.expired);
      if (!artifact) {
        const { jobs } = (await api(`${root}/actions/runs/${run.id}/jobs?per_page=100`)) as {
          jobs: { name: string; steps: { name: string; conclusion: string }[] }[];
        };
        const skipped = jobs.some(
          (job) =>
            job.name === 'check' &&
            job.steps.some(
              (step) => step.name === 'Build extension ZIP' && step.conclusion === 'skipped',
            ),
        );
        if (!skipped) throw new Error(`No unexpired chrome-extension artifact for run ${run.id}`);
        download =
          '拡張のビルドに影響する変更がないため、ビルド・E2E・ZIP 生成を省略しました。このコミットのプレビューはありません。';
      } else
        download = [
          `[chrome-extension.zip をダウンロード](${runUrl}/artifacts/${artifact.id})`,
          '',
          `保存期間: 30日（期限: ${artifact.expires_at}）。GitHub へのログインとリポジトリの読み取り権限が必要です。`,
          '',
          'ZIP を解凍し、chrome://extensions（Edge は edge://extensions）のデベロッパー モードで、manifest.json が入ったフォルダを読み込んでください。更新時は拡張を再読み込みし、対象の Meet タブも再読み込みしてください。',
        ].join('\n');
    }
    const section = `### 拡張プレビュー\n\n${download}\n\n対象コミット: \`${run.head_sha}\` · [CI の実行結果](${runUrl})`;
    // Re-read before writing to preserve recent user edits and skip newly pushed commits.
    const current = (await api(path)) as PullRequest;
    if (current.state !== 'open' || current.head.sha !== run.head_sha) continue;
    const body = replacePreview(current.body, section);
    if (body !== current.body) await api(path, { body });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const repository = process.env.GITHUB_REPOSITORY;
    const token = process.env.GH_TOKEN;
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!repository || !token || !eventPath || process.env.GITHUB_EVENT_NAME !== 'workflow_run')
      throw new Error('Expected a workflow_run event, repository and GH_TOKEN');
    const event = JSON.parse(readFileSync(eventPath, 'utf8')) as { workflow_run: WorkflowRun };
    const api: PreviewApi = async (path, body) => {
      const response = await fetch(`https://api.github.com${path}`, {
        method: body ? 'PATCH' : 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`GitHub API ${response.status}: ${path}`);
      return response.json();
    };
    await updatePreview(event.workflow_run, repository, api);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

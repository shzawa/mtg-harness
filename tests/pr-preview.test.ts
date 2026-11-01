import { expect, test, vi } from 'vitest';
import { replacePreview, updatePreview, type PreviewApi } from '../scripts/pr-preview.ts';

const repository = 'owner/repo';
const sha = 'a'.repeat(40);
function fixture() {
  const run = {
    id: 42,
    event: 'pull_request',
    conclusion: 'success',
    head_sha: sha,
    repository: { full_name: repository },
    head_repository: { full_name: 'contributor/fork' },
    pull_requests: [{ number: 7 }],
  };
  const pr = {
    number: 7,
    state: 'open',
    body: 'Original description',
    head: { sha, repo: { full_name: 'contributor/fork' } },
    base: { repo: { full_name: repository } },
  };
  const state = {
    pr,
    latestRun: 42,
    buildSkipped: false,
    artifacts: [
      { id: 123, name: 'chrome-extension', expired: false, expires_at: '2026-12-01T00:00:00Z' },
    ],
    updates: [] as string[],
  };
  const api = vi.fn<PreviewApi>(async (path, body) => {
    if (body) {
      state.updates.push(body.body);
      return {};
    }
    if (path.endsWith('/pulls/7')) return state.pr;
    if (path.includes('/commits/')) return [{ number: 7 }];
    if (path.includes('/workflows/')) return { workflow_runs: [{ id: state.latestRun }] };
    if (path.includes('/jobs?'))
      return {
        jobs: [
          {
            name: 'check',
            steps: [
              {
                name: 'Build extension ZIP',
                conclusion: state.buildSkipped ? 'skipped' : 'success',
              },
            ],
          },
        ],
      };
    if (path.includes('/artifacts?')) return { artifacts: state.artifacts };
    throw new Error(`Unexpected request: ${path}`);
  });
  return { run, state, api };
}

test('adds a downloadable preview while preserving the description, including fork fallback', async () => {
  const { run, state, api } = fixture();
  run.pull_requests = [];
  await updatePreview(run, repository, api);
  expect(state.updates).toHaveLength(1);
  expect(state.updates[0]).toContain('Original description\n\n<!-- mtg-harness-preview:start -->');
  expect(state.updates[0]).toContain('https://github.com/owner/repo/actions/runs/42/artifacts/123');
  expect(state.updates[0]).toContain(sha);
  expect(state.updates[0]).toContain('2026-12-01T00:00:00Z');
  expect(api).toHaveBeenCalledWith('/repos/owner/repo/pulls/7', { body: state.updates[0] });
});

test('replaces only the managed section and preserves literal user text', () => {
  const original =
    'User text $&\n\n<!-- mtg-harness-preview:start -->\nold\n<!-- mtg-harness-preview:end -->\nFooter';
  expect(replacePreview(original, 'new $&')).toBe(
    'User text $&\n\n<!-- mtg-harness-preview:start -->\nnew $&\n<!-- mtg-harness-preview:end -->\nFooter',
  );
  expect(replacePreview(null, 'new')).toBe(
    '<!-- mtg-harness-preview:start -->\nnew\n<!-- mtg-harness-preview:end -->',
  );
  expect(() => replacePreview('<!-- mtg-harness-preview:start -->user text', 'new')).toThrow(
    'malformed',
  );
});

test.each(['failure', 'cancelled', 'timed_out'])(
  'replaces an old link with %s status',
  async (conclusion) => {
    const { run, state, api } = fixture();
    run.conclusion = conclusion;
    state.pr.body = replacePreview('Original description', 'old download');
    await updatePreview(run, repository, api);
    expect(state.updates[0]).toContain(conclusion);
    expect(state.updates[0]).not.toContain('old download');
    expect(api.mock.calls.some(([path]) => path.includes('/artifacts?'))).toBe(false);
  },
);

test.each(['push', 'closed', 'old-sha', 'other-repo', 'other-head', 'newer-run'])(
  'skips %s without writing',
  async (scenario) => {
    const { run, state, api } = fixture();
    if (scenario === 'push') run.event = 'push';
    if (scenario === 'closed') state.pr.state = 'closed';
    if (scenario === 'old-sha') state.pr.head.sha = 'b'.repeat(40);
    if (scenario === 'other-repo') state.pr.base.repo.full_name = 'owner/other';
    if (scenario === 'other-head') state.pr.head.repo.full_name = 'other/fork';
    if (scenario === 'newer-run') state.latestRun = 43;
    await updatePreview(run, repository, api);
    expect(state.updates).toEqual([]);
  },
);

test.each(['missing', 'expired'])('refuses %s artifacts', async (scenario) => {
  const { run, state, api } = fixture();
  if (scenario === 'missing') state.artifacts = [];
  else state.artifacts[0]!.expired = true;
  await expect(updatePreview(run, repository, api)).rejects.toThrow('No unexpired');
  expect(state.updates).toEqual([]);
});

test.each(['edit', 'push'])('handles a concurrent %s before writing', async (scenario) => {
  const { run, state, api } = fixture();
  let reads = 0;
  const racingApi: PreviewApi = async (path, body) => {
    if (path.endsWith('/pulls/7') && !body && ++reads === 2) {
      if (scenario === 'push') state.pr.head.sha = 'b'.repeat(40);
      else state.pr.body = 'Edited description';
    }
    return api(path, body);
  };
  await updatePreview(run, repository, racingApi);
  expect(state.updates.length).toBe(scenario === 'push' ? 0 : 1);
  expect(state.updates.join('')).toContain(scenario === 'edit' ? 'Edited description' : '');
});

test('reports intentional build skip instead of retaining a previous download', async () => {
  const { run, state, api } = fixture();
  state.artifacts = [];
  state.buildSkipped = true;
  state.pr.body = replacePreview('Description', 'old download');
  await updatePreview(run, repository, api);
  expect(state.updates[0]).toContain('省略しました');
  expect(state.updates[0]).not.toContain('old download');
});

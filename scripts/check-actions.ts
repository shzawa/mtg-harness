import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument } from 'yaml';
import type { YAMLMap } from 'yaml';

export interface ActionPin {
  repository: string;
  sha: string;
  version: string;
  location: string;
}

interface LocalReference {
  path: string;
  workflow: boolean;
  location: string;
}

export interface ActionFileCheck {
  pins: ActionPin[];
  local: LocalReference[];
}

export type GitHubRunner = (args: readonly string[]) => string;
const stableVersion = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const commitSha = /^[a-f0-9]{40}$/;
const repositoryName = /^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i;

/** Check executable uses nodes, retaining YAML comments and source locations. */
export function checkActionFile(source: string, filePath: string): ActionFileCheck {
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter, uniqueKeys: true, strict: true });
  const problems = [...doc.errors, ...doc.warnings];
  if (problems.length) throw new Error(`${filePath}: ${problems[0]?.message}`);
  const result: ActionFileCheck = { pins: [], local: [] };
  const fail = (message: string): never => {
    throw new Error(`${filePath}: ${message}`);
  };
  const mapping = (node: unknown, label: string): YAMLMap => {
    if (isAlias(node)) fail(`${label}: YAML aliases are unsupported in executable mappings`);
    if (!isMap(node)) return fail(`${label} must be a mapping`);
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string')
        return fail(`${label}: mapping keys must be strings`);
      if (pair.key.value === '<<') fail(`${label}: YAML merge keys are unsupported`);
    }
    return node;
  };
  const value = (map: YAMLMap, key: string): unknown =>
    map.items.find((pair) => isScalar(pair.key) && pair.key.value === key)?.value;
  const checkUse = (node: unknown, workflow: boolean): void => {
    if (isAlias(node)) fail('uses: YAML aliases are unsupported');
    if (!isScalar(node) || typeof node.value !== 'string' || !node.range)
      return fail('uses must be a literal string');
    const location = `${filePath}:${lineCounter.linePos(node.range[0]).line}`;
    const end = node.range[1];
    if (lineCounter.linePos(node.range[0]).line !== lineCounter.linePos(end).line)
      return fail(`${location}: uses must be a single-line literal string`);
    const ref = node.value;
    if (/\s/.test(ref)) fail(`${location}: uses must not contain whitespace`);
    if (ref.startsWith('./') || ref.startsWith('$/')) {
      const path = ref.slice(2);
      if (path.includes('${{') || path.includes('\\') || path.split('/').includes('..'))
        fail(`${location}: local uses must stay within the repository and be static`);
      result.local.push({ path, workflow, location });
      return;
    }
    if (ref.startsWith('docker://'))
      fail(`${location}: Docker uses are unsupported; review a digest-pinning policy first`);
    const match = ref.match(/^([^@]+)@([a-f0-9]{40})$/);
    if (!match?.[1] || !match[2])
      return fail(`${location}: remote uses must be pinned to a full lowercase 40-character SHA`);
    const parts = match[1].split('/');
    const repository = parts.slice(0, 2).join('/');
    if (
      !repositoryName.test(repository) ||
      parts.some((part) => !/^[a-z\d_.-]+$/i.test(part) || part === '.' || part === '..') ||
      (workflow && !/^[^/]+\/[^/]+\/\.github\/workflows\/[^/]+\.ya?ml$/.test(match[1]))
    )
      fail(`${location}: invalid action or reusable workflow reference`);
    const newline = source.indexOf('\n', end);
    const suffix = source.slice(end, newline === -1 ? source.length : newline);
    const inlineComment = suffix.match(/^[\t ]+#([\t ]*v[^\r\n]*?)[\t ]*\r?$/)?.[1]?.trim();
    if (
      !inlineComment ||
      !stableVersion.test(inlineComment) ||
      node.comment?.trim() !== inlineComment
    )
      return fail(`${location}: uses requires its own inline # vX.Y.Z stable version comment`);
    result.pins.push({ repository, sha: match[2], version: inlineComment, location });
  };
  const steps = (node: unknown, label: string): void => {
    if (isAlias(node)) fail(`${label}: YAML aliases are unsupported`);
    if (!isSeq(node)) return fail(`${label} must be a sequence`);
    for (const [index, item] of node.items.entries()) {
      const step = mapping(item, `${label}[${index}]`);
      if (step.has('uses')) checkUse(value(step, 'uses'), false);
    }
  };
  const root = mapping(doc.contents, 'document');
  if (!filePath.startsWith('.github/workflows/') && /^action\.ya?ml$/.test(basename(filePath))) {
    const runs = mapping(value(root, 'runs'), 'runs');
    const using = value(runs, 'using');
    if (!isScalar(using) || typeof using.value !== 'string')
      return fail('runs.using must be a string');
    if (using.value === 'composite') steps(value(runs, 'steps'), 'runs.steps');
    else if (using.value === 'docker')
      fail('Docker actions are unsupported by this pinning policy');
    else if (!/^node\d+$/.test(using.value)) fail('Unsupported runs.using value');
  } else {
    const jobs = mapping(value(root, 'jobs'), 'jobs');
    if (jobs.items.length === 0) fail('jobs must not be empty');
    for (const pair of jobs.items) {
      const job = mapping(pair.value, 'job');
      if (job.has('uses')) {
        if (job.has('steps')) fail('A reusable workflow job cannot also contain steps');
        checkUse(value(job, 'uses'), true);
      } else steps(value(job, 'steps'), 'job.steps');
    }
  }
  return result;
}

const ignoredDirectories = new Set([
  '.git',
  '.mise',
  '.output',
  '.wxt',
  'node_modules',
  'playwright-report',
  'release-assets',
  'test-results',
]);

/** Include new local manifests while excluding ignored dependency/build directories. */
export function checkActions(cwd = process.cwd(), files?: readonly string[]): ActionPin[] {
  const root = realpathSync(cwd);
  const listed =
    files ??
    execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    }).split('\0');
  const paths = [...new Set(listed)].filter(
    (file) =>
      file &&
      !file.split('/').some((part) => ignoredDirectories.has(part)) &&
      (/^\.github\/workflows\/.+\.ya?ml$/.test(file) || /^action\.ya?ml$/.test(basename(file))),
  );
  if (!paths.length) throw new Error('No workflow or action manifests were found');
  const pins: ActionPin[] = [];
  const local: LocalReference[] = [];
  for (const file of paths.sort()) {
    const real = realpathSync(resolve(root, file));
    const relativePath = relative(root, real);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))
      throw new Error(`${file}: manifest resolves outside the repository`);
    const checked = checkActionFile(readFileSync(real, 'utf8'), file);
    pins.push(...checked.pins);
    local.push(...checked.local);
  }
  const available = new Set(paths);
  for (const ref of local) {
    const prefix = ref.path.replace(/\/+$/, '');
    const found = ref.workflow
      ? available.has(prefix) && /^\.github\/workflows\/.+\.ya?ml$/.test(prefix)
      : ['action.yml', 'action.yaml'].some((name) =>
          available.has(prefix ? `${prefix}/${name}` : name),
        );
    if (!found) throw new Error(`${ref.location}: local uses target is not a repository manifest`);
  }
  return pins;
}

/** Only GET requests are issued; injected runners keep tests offline. */
export function verifyUpstream(
  pins: readonly ActionPin[],
  run: GitHubRunner = (args) =>
    execFileSync('gh', [...args], { encoding: 'utf8', timeout: 60_000 }),
): void {
  const resolved = new Map<string, string>();
  const request = (path: string): { type: string; sha: string } => {
    const response: unknown = JSON.parse(run(['api', '--method', 'GET', path]));
    if (response === null || typeof response !== 'object' || !('object' in response))
      throw new Error(`Invalid GitHub tag response for ${path}`);
    const object = response.object;
    if (
      object === null ||
      typeof object !== 'object' ||
      !('type' in object) ||
      !('sha' in object) ||
      typeof object.type !== 'string' ||
      typeof object.sha !== 'string' ||
      object.sha.length !== 40 ||
      !commitSha.test(object.sha)
    )
      throw new Error(`Invalid GitHub tag object for ${path}`);
    return { type: object.type, sha: object.sha };
  };
  for (const pin of pins) {
    if (
      !repositoryName.test(pin.repository) ||
      !stableVersion.test(pin.version) ||
      pin.sha.length !== 40 ||
      !commitSha.test(pin.sha) ||
      /\s/.test(pin.repository + pin.version)
    )
      throw new Error(`${pin.location}: invalid action pin`);
    const key = `${pin.repository.toLowerCase()}@${pin.version}`;
    let sha = resolved.get(key);
    if (!sha) {
      const base = `repos/${pin.repository}/git`;
      let object = request(`${base}/ref/tags/${encodeURIComponent(pin.version)}`);
      const seen = new Set<string>();
      while (object.type === 'tag') {
        if (seen.size >= 16 || seen.has(object.sha))
          throw new Error(`${key}: cyclic or excessive annotated tags`);
        seen.add(object.sha);
        object = request(`${base}/tags/${object.sha}`);
      }
      if (object.type !== 'commit') throw new Error(`${key}: tag does not resolve to a commit`);
      sha = object.sha;
      resolved.set(key, sha);
    }
    if (sha !== pin.sha)
      throw new Error(`${pin.location}: ${key} does not match pinned SHA ${pin.sha}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--verify-upstream'))
      throw new Error('Usage: node scripts/check-actions.ts [--verify-upstream]');
    const pins = checkActions();
    if (process.argv[2]) verifyUpstream(pins);
    console.log(`Checked ${pins.length} action references with full SHA and patch-version pins.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

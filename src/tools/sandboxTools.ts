import { randomUUID } from 'node:crypto';
import { sessionSignal } from '../lib/sessionControl.js';
import { ExecResult, FileEntry, GitHubExecutionContext, TestResult, ToolContext } from '../sandbox/types.js';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_LIST_ENTRIES = 2_000;
const MAX_SEARCH_RESULTS = 1_000;

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function workspacePath(path: string) {
  const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0') || normalized.split('/').includes('..')) throw new Error('path must remain inside /workspace');
  return `/workspace/${normalized}`;
}

function lines(text: string) {
  return text.split(/\r?\n/).filter(Boolean).slice(0, 5_000);
}

async function exec(context: ToolContext, command: string, cwd = '/workspace', timeoutMs = 120_000, env?: Record<string, string>): Promise<ExecResult> {
  return context.runtime.exec(context.sandbox, {
    command, cwd, timeoutMs, env,
    onStdout: (chunk) => { for (const line of lines(chunk)) void context.events.emit('terminal.stdout', { line }); },
    onStderr: (chunk) => { for (const line of lines(chunk)) void context.events.emit('terminal.stderr', { line }); },
  });
}

export async function shellExec(context: ToolContext, command: string, cwd = '/workspace', timeoutMs = 120_000) {
  if (!command.trim()) throw new Error('command is required');
  await context.events.emit('action.started', { role: 'executor', tool: 'terminal', verb: 'exec', target: command.slice(0, 120) });
  const result = await exec(context, command, cwd, timeoutMs);
  await context.events.emit('action.completed', { tool: 'terminal', result: `exit ${result.exitCode}${result.timedOut ? ' · timed out' : ''}` });
  return result;
}

export async function readFile(context: ToolContext, path: string) {
  const target = workspacePath(path);
  await context.events.emit('action.started', { role: 'executor', tool: 'editor', verb: 'read', target: path });
  const result = await exec(context, `test -f ${shellQuote(target)} && wc -c < ${shellQuote(target)} && cat ${shellQuote(target)}`, '/workspace', 30_000);
  if (result.exitCode !== 0) throw new Error(result.stderr || `file not found: ${path}`);
  const [sizeLine, ...content] = result.stdout.split('\n');
  const size = Number(sizeLine);
  if (size > MAX_FILE_BYTES) throw new Error(`file exceeds ${MAX_FILE_BYTES} byte limit`);
  await context.events.emit('action.completed', { tool: 'editor', result: `${size} bytes` });
  return { path, content: content.join('\n') };
}

export async function writeFile(context: ToolContext, path: string, content: string, options: { emitEvents?: boolean } = {}) {
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error(`file exceeds ${MAX_FILE_BYTES} byte limit`);
  const target = workspacePath(path);
  const encoded = Buffer.from(content, 'utf8').toString('base64');
  const emitEvents = options.emitEvents !== false;
  if (emitEvents) await context.events.emit('action.started', { role: 'executor', tool: 'editor', verb: 'write', target: path });
  const existed = (await exec(context, `test -e ${shellQuote(target)}`, '/workspace', 10_000)).exitCode === 0;
  const result = await exec(context, `mkdir -p "$(dirname ${shellQuote(target)})" && printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(target)}`, '/workspace', 30_000);
  if (result.exitCode !== 0) throw new Error(result.stderr || 'write failed');
  if (emitEvents) {
    await context.events.emit(existed ? 'file.modified' : 'file.created', { path, content });
    await context.events.emit('action.completed', { tool: 'editor', result: `${Buffer.byteLength(content, 'utf8')} bytes` });
  }
  return { path, bytes: Buffer.byteLength(content, 'utf8'), created: !existed };
}

export async function listDir(context: ToolContext, path = '.') {
  const target = path === '.' ? '/workspace' : workspacePath(path);
  const result = await exec(context, `find ${shellQuote(target)} -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%p\\n' | sort | head -n ${MAX_LIST_ENTRIES}`, '/workspace', 30_000);
  if (result.exitCode !== 0) throw new Error(result.stderr || 'list failed');
  const entries: FileEntry[] = result.stdout.split('\n').filter(Boolean).map((line) => {
    const [type, size, absolute] = line.split('\t');
    return { path: absolute.replace(/^\/workspace\/?/, ''), type: type === 'd' ? 'directory' : 'file', size: Number(size) };
  });
  return entries;
}

export async function searchFiles(context: ToolContext, pattern: string, path = '.') {
  if (!pattern.trim() || pattern.length > 500) throw new Error('search pattern must be 1-500 characters');
  const target = path === '.' ? '/workspace' : workspacePath(path);
  const result = await exec(context, `rg --line-number --no-heading --hidden --glob '!.git' --max-count 100 ${shellQuote(pattern)} ${shellQuote(target)} | head -n ${MAX_SEARCH_RESULTS}`, '/workspace', 30_000);
  if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error(result.stderr || 'search failed');
  return { pattern, matches: result.stdout.split('\n').filter(Boolean).slice(0, MAX_SEARCH_RESULTS) };
}

export async function applyPatch(context: ToolContext, patch: string) {
  if (!patch.trim() || Buffer.byteLength(patch, 'utf8') > MAX_FILE_BYTES) throw new Error('patch is empty or too large');
  const encoded = Buffer.from(patch, 'utf8').toString('base64');
  await context.events.emit('action.started', { role: 'executor', tool: 'editor', verb: 'apply_patch', target: 'workspace' });
  const result = await exec(context, `printf %s ${shellQuote(encoded)} | base64 -d > /tmp/klin.patch && git apply --whitespace=nowarn /tmp/klin.patch && git diff --stat`, '/workspace', 60_000);
  if (result.exitCode !== 0) throw new Error(result.stderr || 'patch failed to apply');
  await context.events.emit('diff.ready', { path: 'workspace', diff: patch.slice(0, MAX_FILE_BYTES) });
  await context.events.emit('action.completed', { tool: 'editor', result: 'patch applied' });
  return { applied: true, summary: result.stdout.trim() };
}

export async function gitClone(context: ToolContext, url: string, destination = '.', githubToken?: string, githubUsername?: string) {
  if (!/^https:\/\//i.test(url) || /[;&|`$\n\r]/.test(url)) throw new Error('git clone only accepts an HTTPS URL');
  const target = destination === '.' ? '/workspace' : workspacePath(destination);
  await context.events.emit('action.started', { role: 'executor', tool: 'git', verb: 'clone', target: url });
  let command = `git clone -- ${shellQuote(url)} ${shellQuote(target)}`;
  if (githubToken) {
    command = withGitHubAskpass(command);
  }
  const result = await exec(context, command, '/workspace', 5 * 60_000, githubToken ? { KILN_GITHUB_TOKEN: githubToken, KILN_GITHUB_USERNAME: githubUsername || 'x-access-token' } : undefined);
  await context.events.emit('action.completed', { tool: 'git', result: `exit ${result.exitCode}` });
  if (result.exitCode !== 0) throw new Error(result.stderr || 'git clone failed');
  return { url, destination };
}

export async function gitStatus(context: ToolContext) { return shellExec(context, 'git status --short --branch'); }
export async function gitDiff(context: ToolContext) { return shellExec(context, 'git diff -- .'); }
export async function gitBranch(context: ToolContext, name?: string) {
  if (name && !/^[A-Za-z0-9._/-]{1,120}$/.test(name)) throw new Error('invalid branch name');
  if (!name) return shellExec(context, 'git branch --show-current');
  const localRef = shellQuote(`refs/heads/${name}`);
  const remoteRef = shellQuote(`refs/remotes/origin/${name}`);
  const branch = shellQuote(name);
  const remoteBranch = shellQuote(`origin/${name}`);
  return shellExec(context, `if git show-ref --quiet --verify ${localRef}; then git switch --quiet -- ${branch}; elif git show-ref --quiet --verify ${remoteRef}; then git switch --quiet --track --create ${branch} ${remoteBranch}; else git switch --quiet --create ${branch}; fi`);
}

export async function gitCommit(context: ToolContext, message: string) {
  if (!message.trim() || message.length > 200) throw new Error('commit message must be 1-200 characters');
  const result = await shellExec(context, `git add -A && git commit -m ${shellQuote(message)}`);
  if (result.exitCode !== 0) throw new Error(result.stderr || 'git commit failed');
  const sha = (await exec(context, 'git rev-parse HEAD', '/workspace', 10_000)).stdout.trim();
  await context.events.emit('git.commit', { sha, message });
  return { sha, message };
}

export async function gitPush(context: ToolContext) {
  const github = requireGitHubContext(context);
  const branch = (await exec(context, 'git branch --show-current', '/workspace', 10_000)).stdout.trim();
  if (!branch || branch !== github.workBranch) throw new Error(`Refusing to push ${branch || 'an unknown branch'}; only the session feature branch ${github.workBranch} may be pushed.`);
  if (!/^[A-Za-z0-9._/-]{1,120}$/.test(branch)) throw new Error('invalid branch name');
  await context.events.emit('action.started', { role: 'executor', tool: 'git', verb: 'push', target: `${github.repository}:${branch}` });
  const command = withGitHubAskpass(`git push --set-upstream origin -- ${shellQuote(branch)}`);
  const result = await exec(context, command, '/workspace', 5 * 60_000, { KILN_GITHUB_TOKEN: github.token, KILN_GITHUB_USERNAME: github.username || 'x-access-token' });
  await context.events.emit('action.completed', { tool: 'git', result: `push exit ${result.exitCode}` });
  if (result.exitCode !== 0) throw new Error(result.stderr || 'git push failed');
  return { repository: github.repository, branch };
}

export async function githubCreatePullRequest(context: ToolContext, title: string, body: string) {
  const github = requireGitHubContext(context);
  if (!title.trim() || title.length > 256) throw new Error('pull request title must be 1-256 characters');
  if (body.length > 20_000) throw new Error('pull request description must be 20,000 characters or fewer');
  const branch = (await exec(context, 'git branch --show-current', '/workspace', 10_000)).stdout.trim();
  if (!branch || branch !== github.workBranch) throw new Error(`Refusing to open a pull request from ${branch || 'an unknown branch'}; expected ${github.workBranch}.`);
  const [owner, name] = github.repository.split('/');
  await context.events.emit('action.started', { role: 'executor', tool: 'github', verb: 'open_pull_request', target: `${github.repository}:${branch} → ${github.baseBranch}` });
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${github.token}`,
      'User-Agent': 'klin-app',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: title.trim(), body, head: branch, base: github.baseBranch }),
    signal: AbortSignal.any([sessionSignal(context.sessionId), AbortSignal.timeout(30_000)]),
  });
  const result: any = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.html_url !== 'string') {
    throw new Error(`GitHub could not open the pull request (${response.status}): ${String(result.message ?? 'unknown error').slice(0, 200)}`);
  }
  const artifact = {
    id: randomUUID(), sessionId: context.sessionId, kind: 'pr' as const,
    title: result.title ?? title.trim(), url: result.html_url, createdAt: new Date().toISOString(),
  };
  await context.events.emit('git.pr_opened', { url: result.html_url, title: artifact.title });
  await context.events.emit('artifact.created', artifact);
  await context.events.emit('action.completed', { tool: 'github', result: result.html_url });
  return { url: result.html_url, title: artifact.title, base: github.baseBranch, head: branch };
}

function requireGitHubContext(context: ToolContext): GitHubExecutionContext {
  if (!context.github?.repository || !context.github.baseBranch || !context.github.workBranch || !context.github.token) {
    throw new Error('Connect GitHub and select a repository and base branch to use GitHub write actions.');
  }
  return context.github;
}

function withGitHubAskpass(command: string) {
  const askpass = `/tmp/klin-git-askpass-${randomUUID()}`;
  const source = `#!/bin/sh
case "$1" in
  *Username*"https://github.com':"*) printf "%s\\n" "$KILN_GITHUB_USERNAME" ;;
  *Password*"https://github.com':"*) printf "%s\\n" "$KILN_GITHUB_TOKEN" ;;
  *) exit 1 ;;
esac
`;
  const encoded = Buffer.from(source, 'utf8').toString('base64');
  return `askpass=${shellQuote(askpass)}; printf %s ${shellQuote(encoded)} | base64 -d > "$askpass" && chmod 700 "$askpass" && GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 ${command}; result=$?; rm -f "$askpass"; exit "$result"`;
}

function parseTestResult(result: ExecResult): TestResult {
  const report = `${result.stdout}\n${result.stderr}`.trim().slice(-120_000);
  const passed = Number(report.match(/(\d+)\s+(?:passing|passed|tests? passed)/i)?.[1] ?? 0);
  const failed = Number(report.match(/(\d+)\s+(?:failing|failed|tests? failed)/i)?.[1] ?? (result.exitCode === 0 ? 0 : 1));
  return { passed, failed, exitCode: result.exitCode, timedOut: result.timedOut, report };
}

export async function runTests(context: ToolContext, command?: string, timeoutMs = 10 * 60_000) {
  const selected = command?.trim();
  if (selected && /[;&|`$<>\n\r]/.test(selected)) throw new Error('custom test command contains disallowed shell operators');
  const detection = selected ?? "if [ -f package.json ] && node -e \"const p=require('./package.json'); process.stdout.write(p.scripts?.test ? 'npm test' : '')\"; then :; elif [ -f pyproject.toml ] || [ -f pytest.ini ]; then printf 'pytest'; elif [ -f go.mod ]; then printf 'go test ./...'; elif [ -f Cargo.toml ]; then printf 'cargo test'; fi";
  const detected = selected ?? (await exec(context, detection, '/workspace', 10_000)).stdout.trim();
  if (!detected) throw new Error('no test command detected; pass an explicit command');
  await context.events.emit('action.started', { role: 'executor', tool: 'tests', verb: 'run', target: detected });
  const result = await exec(context, detected, '/workspace', timeoutMs);
  const parsed = parseTestResult(result);
  await context.events.emit('test.result', { ...parsed });
  await context.events.emit('action.completed', { tool: 'tests', result: `passed ${parsed.passed}, failed ${parsed.failed}, exit ${parsed.exitCode}` });
  return parsed;
}

export function eventSink(sessionId: string) {
  return { emit: async (type: string, payload: Record<string, unknown>) => {
    const { emitEvent: persistEvent } = await import('../lib/eventBus.js');
    await persistEvent(sessionId, type as never, payload);
  } };
}

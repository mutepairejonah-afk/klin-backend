import { ExecResult, FileEntry, TestResult, ToolContext } from '../sandbox/types.js';

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

async function exec(context: ToolContext, command: string, cwd = '/workspace', timeoutMs = 120_000): Promise<ExecResult> {
  return context.runtime.exec(context.sandbox, {
    command, cwd, timeoutMs,
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

export async function writeFile(context: ToolContext, path: string, content: string) {
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error(`file exceeds ${MAX_FILE_BYTES} byte limit`);
  const target = workspacePath(path);
  const encoded = Buffer.from(content, 'utf8').toString('base64');
  await context.events.emit('action.started', { role: 'executor', tool: 'editor', verb: 'write', target: path });
  const existed = (await exec(context, `test -e ${shellQuote(target)}`, '/workspace', 10_000)).exitCode === 0;
  const result = await exec(context, `mkdir -p "$(dirname ${shellQuote(target)})" && printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(target)}`, '/workspace', 30_000);
  if (result.exitCode !== 0) throw new Error(result.stderr || 'write failed');
  await context.events.emit(existed ? 'file.modified' : 'file.created', { path, content });
  await context.events.emit('action.completed', { tool: 'editor', result: `${Buffer.byteLength(content, 'utf8')} bytes` });
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

export async function gitClone(context: ToolContext, url: string, destination = '.') {
  if (!/^https:\/\//i.test(url) || /[;&|`$\n\r]/.test(url)) throw new Error('git clone only accepts an HTTPS URL');
  const target = destination === '.' ? '/workspace' : workspacePath(destination);
  await context.events.emit('action.started', { role: 'executor', tool: 'git', verb: 'clone', target: url });
  const result = await exec(context, `git clone -- ${shellQuote(url)} ${shellQuote(target)}`, '/workspace', 5 * 60_000);
  await context.events.emit('action.completed', { tool: 'git', result: `exit ${result.exitCode}` });
  if (result.exitCode !== 0) throw new Error(result.stderr || 'git clone failed');
  return { url, destination };
}

export async function gitStatus(context: ToolContext) { return shellExec(context, 'git status --short --branch'); }
export async function gitDiff(context: ToolContext) { return shellExec(context, 'git diff -- .'); }
export async function gitBranch(context: ToolContext, name?: string) {
  if (name && !/^[A-Za-z0-9._/-]{1,120}$/.test(name)) throw new Error('invalid branch name');
  return shellExec(context, name ? `git switch -c ${shellQuote(name)}` : 'git branch --show-current');
}

export async function gitCommit(context: ToolContext, message: string) {
  if (!message.trim() || message.length > 200) throw new Error('commit message must be 1-200 characters');
  const result = await shellExec(context, `git add -A && git commit -m ${shellQuote(message)}`);
  if (result.exitCode !== 0) throw new Error(result.stderr || 'git commit failed');
  const sha = (await exec(context, 'git rev-parse HEAD', '/workspace', 10_000)).stdout.trim();
  await context.events.emit('git.commit', { sha, message });
  return { sha, message };
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

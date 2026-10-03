import { z } from 'zod';

const todo = z.object({ id: z.string(), label: z.string(), done: z.boolean() });
const role = z.enum(['planner', 'executor', 'critic', 'retriever']);
const tool = z.enum(['terminal', 'editor', 'browser', 'preview', 'db', 'deploy', 'git', 'github', 'tests', 'search', 'model']);
const base = z.object({ seq: z.number().int().nonnegative(), ts: z.string().datetime(), payload: z.record(z.unknown()) });

export const sessionEventSchema = z.union([
  base.extend({ type: z.literal('plan.updated'), payload: z.object({ todos: z.array(todo) }) }),
  base.extend({ type: z.literal('message.user'), payload: z.object({ message: z.string() }) }),
  base.extend({ type: z.literal('thought'), payload: z.object({ role, text: z.string() }) }),
  base.extend({ type: z.literal('action.started'), payload: z.object({ role, tool, verb: z.string(), target: z.string() }) }),
  base.extend({ type: z.literal('action.completed'), payload: z.object({ tool, result: z.string().optional() }) }),
  base.extend({ type: z.literal('terminal.stdout'), payload: z.object({ line: z.string() }) }),
  base.extend({ type: z.literal('terminal.stderr'), payload: z.object({ line: z.string() }) }),
  base.extend({ type: z.enum(['file.created', 'file.modified', 'file.deleted']), payload: z.object({ path: z.string(), content: z.string().optional() }) }),
  base.extend({ type: z.literal('diff.ready'), payload: z.object({ path: z.string(), diff: z.string() }) }),
  base.extend({ type: z.literal('browser.navigate'), payload: z.object({ url: z.string().url() }) }),
  base.extend({ type: z.literal('browser.screenshot'), payload: z.object({ url: z.string().url() }) }),
  base.extend({ type: z.enum(['db.schema', 'db.query']), payload: z.object({ sql: z.string().optional(), status: z.string().optional(), tables: z.array(z.object({ name: z.string(), columns: z.array(z.object({ name: z.string(), type: z.string() })) })).optional(), applied: z.boolean().optional() }) }),
  base.extend({ type: z.literal('git.commit'), payload: z.object({ sha: z.string(), message: z.string() }) }),
  base.extend({ type: z.literal('git.pr_opened'), payload: z.object({ url: z.string().url(), title: z.string(), stats: z.string().optional() }) }),
  base.extend({ type: z.literal('test.result'), payload: z.object({ passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), report: z.string().optional() }) }),
  base.extend({ type: z.literal('deploy.preview_url'), payload: z.object({ url: z.string().url() }) }),
  base.extend({ type: z.literal('approval.requested'), payload: z.object({ id: z.string(), title: z.string(), body: z.string(), command: z.string().optional(), rollback: z.string().optional(), blastRadius: z.string().optional() }) }),
  base.extend({ type: z.literal('approval.resolved'), payload: z.object({ id: z.string(), decision: z.enum(['approved', 'rejected']) }) }),
  base.extend({ type: z.literal('critic.verdict'), payload: z.object({ checks: z.array(z.object({ label: z.string(), passed: z.boolean() })) }) }),
  base.extend({ type: z.literal('artifact.created'), payload: z.record(z.unknown()) }),
  base.extend({ type: z.literal('error'), payload: z.object({ message: z.string() }) }),
  base.extend({ type: z.literal('session.done'), payload: z.object({ summary: z.string() }) }),
]);

export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SessionEventType = SessionEvent['type'];

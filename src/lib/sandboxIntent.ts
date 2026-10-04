export interface SessionExecutionRequest {
  goal: string;
  repo?: string;
  jobId?: string | null;
  sandbox?: boolean;
}

export type SessionExecutionMode = 'sandbox' | 'chat' | 'unavailable';

const INFORMATIONAL_QUESTION = /^\s*(?:(?:can|could|would) you\s+)?(?:explain\b|teach(?: me)?\b|tell me how\b|how (?:do|does|did|can|could|should|would|is|are|to)\b|what(?:'s| is| are| does| do| can| should| would)\b|why\b|when\b|where\b)/i;
const EXPLICIT_EXECUTION = /\b(?:sandbox(?:es)?|(?:run|execute|exec)\b[^.?!\n]{0,60}\b(?:code|script|python|node|npm|bash|shell|command|program|tests?)\b)/i;

const CODE_ACTION = String.raw`(?:build|built|create|creates|created|creating|make|makes|made|write|writes|writing|wrote|written|develop|develops|developed|developing|implement|implements|implemented|implementing|fix|fixes|fixed|fixing|debug|debugs|debugged|debugging|edit|edits|edited|editing|modify|modifies|modified|modifying|update|updates|updated|updating|refactor|refactors|refactored|refactoring|scaffold|scaffolds|scaffolded|scaffolding|test|tests|tested|testing|run|runs|ran|running|execute|executes|executed|executing|start|starts|started|starting|launch|launches|launched|launching|serve|serves|served|serving|compile|compiles|compiled|compiling|install|installs|installed|installing|add|adds|added|adding|remove|removes|removed|removing)`;
const CODE_ARTIFACT = String.raw`(?:website|web[\s-]?app|webpage|site|application|app|project|repository|repo|codebase|script|program|software|code|python|node(?:\.js)?|html|css|javascript|typescript|react|next\.js|vue|svelte|api|backend|frontend|component|feature|bug|calculator|game|landing page|dashboard|cli|bot|test(?:s| suite)?|unit tests?)`;
const CODE_WORK = new RegExp(
  `\\b${CODE_ACTION}\\b[\\s\\S]{0,100}\\b${CODE_ARTIFACT}\\b|\\b${CODE_ARTIFACT}\\b[\\s\\S]{0,100}\\b${CODE_ACTION}\\b`,
  'i',
);

/**
 * Detect requests that need a real isolated workspace even when no job template
 * or repository was selected. Explanatory questions remain ordinary chat.
 */
export function hasSandboxIntent(goal: string): boolean {
  const text = goal.trim();
  if (!text || INFORMATIONAL_QUESTION.test(text)) return false;
  return EXPLICIT_EXECUTION.test(text) || CODE_WORK.test(text);
}

/**
 * Resolve routing independently from provider readiness. If the user asks for
 * code execution but the runtime is disabled, fail truthfully instead of
 * silently falling back to a text-only model response.
 */
export function resolveSessionExecutionMode(
  request: SessionExecutionRequest,
  runtimeReady: boolean,
): SessionExecutionMode {
  const requested = Boolean(request.repo || request.jobId || request.sandbox === true || hasSandboxIntent(request.goal));
  if (!requested) return 'chat';
  return runtimeReady ? 'sandbox' : 'unavailable';
}

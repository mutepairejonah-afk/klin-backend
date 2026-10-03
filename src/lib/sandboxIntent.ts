// Goals that clearly ask for real execution ("open your sandbox", "run this python code").
// Only consulted when the coding runtime is enabled, so ordinary chat never pays for a sandbox.
export const SANDBOX_INTENT = /\bsandbox(es)?\b|\b(run|execute|exec)\b[^.?!\n]{0,40}\b(code|script|python|node|npm|bash|shell|command|program|tests?)\b/i;

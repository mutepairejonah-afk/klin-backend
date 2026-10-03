export type SessionCommand =
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'cancel' }
  | { type: 'message'; message: string };

export class SessionCancelledError extends Error {
  constructor() {
    super('session cancelled');
    this.name = 'SessionCancelledError';
  }
}

interface ControlState {
  paused: boolean;
  cancelled: boolean;
  messages: string[];
  wake: (() => void) | null;
  controller: AbortController;
}

const controls = new Map<string, ControlState>();

function stateFor(id: string): ControlState {
  let state = controls.get(id);
  if (!state) {
    state = { paused: false, cancelled: false, messages: [], wake: null, controller: new AbortController() };
    controls.set(id, state);
  }
  return state;
}

export function sessionSignal(id: string): AbortSignal {
  return stateFor(id).controller.signal;
}

function notify(state: ControlState) {
  state.wake?.();
  state.wake = null;
}

export function pauseSession(id: string) {
  stateFor(id).paused = true;
}

export function resumeSession(id: string) {
  const state = stateFor(id);
  state.paused = false;
  notify(state);
}

export function cancelSession(id: string) {
  const state = stateFor(id);
  state.cancelled = true;
  state.paused = false;
  state.controller.abort();
  notify(state);
}

export function steerSession(id: string, message: string) {
  stateFor(id).messages.push(message);
  notify(stateFor(id));
}

export function takeSteeringMessages(id: string): string[] {
  const state = stateFor(id);
  const messages = state.messages.splice(0);
  return messages;
}

export async function checkpoint(id: string) {
  const state = stateFor(id);
  if (state.cancelled) throw new SessionCancelledError();
  while (state.paused && !state.cancelled) {
    await new Promise<void>((resolve) => { state.wake = resolve; });
  }
  if (state.cancelled) throw new SessionCancelledError();
}

export function forgetSessionControl(id: string) {
  controls.delete(id);
}

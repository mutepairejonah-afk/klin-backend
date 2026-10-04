export interface WorkspaceSnapshotEvent {
  type: string;
  payload: unknown;
}

export interface WorkspaceFile {
  path: string;
  content: string;
}

/** Build the current file set from ordered create/modify/delete events. */
export function reconstructWorkspaceFiles(events: readonly WorkspaceSnapshotEvent[]): WorkspaceFile[] {
  const latest = new Map<string, string>();
  for (const event of events) {
    if (!['file.created', 'file.modified', 'file.deleted'].includes(event.type)) continue;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (typeof payload.path !== 'string' || !payload.path.trim()) continue;
    const normalizedPath = payload.path.replaceAll('\\', '/');
    if (normalizedPath.includes('\0') || normalizedPath.split('/').includes('..')) {
      throw new Error('A previous workspace file path is unsafe to restore.');
    }
    if (event.type === 'file.deleted') latest.delete(payload.path);
    else if (typeof payload.content === 'string') latest.set(payload.path, payload.content);
  }
  return Array.from(latest, ([path, content]) => ({ path, content }));
}

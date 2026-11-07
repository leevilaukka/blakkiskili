// "Something changed" notifications between the services and whatever shows live data (the
// website's server-sent events). It carries only ids, never data: listeners read what they need.
// In-process and synchronous; a listener that throws can't break the write that triggered it.

export interface Change {
  /** An account's drinks, body data or name changed (or it left or joined a group). */
  accountId?: string;
  /** A group's membership changed. */
  groupId?: string;
}

export class ChangeBus {
  private readonly listeners = new Set<(change: Change) => void>();

  subscribe(listener: (change: Change) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  emit(change: Change) {
    for (const l of this.listeners) {
      try {
        l(change);
      } catch (e) {
        console.error("Change listener failed:", e);
      }
    }
  }
}

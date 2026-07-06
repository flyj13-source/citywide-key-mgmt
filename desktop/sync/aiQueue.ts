import path from 'path';

function backend(dir: string, mod: string): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(path.join(dir, mod));
}

/**
 * Flush pending AI questions on reconnect. Delegates to the backend's
 * flushAiQueue, which answers each queued question with the *current* registry
 * context and flips its row pending → answered. The AI panel polls
 * GET /api/claude/queue to reflect the change (Queued → Answered).
 */
export async function flushAi(backendDir: string): Promise<number> {
  const claude = backend(backendDir, 'routes/claude.js');
  if (typeof claude.flushAiQueue !== 'function') return 0;
  try {
    return await claude.flushAiQueue();
  } catch (err) {
    console.error('[aiQueue] flush failed', err);
    return 0;
  }
}

/** Count of questions still waiting for an answer. */
export function pendingAiCount(backendDir: string): number {
  try {
    const db = backend(backendDir, 'lib/db.js').default;
    const row = db.prepare("SELECT COUNT(*) AS c FROM ai_queue WHERE status='pending'").get();
    return Object.assign({}, row).c as number;
  } catch {
    return 0;
  }
}

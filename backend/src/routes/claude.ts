import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';
import { logAudit } from '../lib/audit';
import Anthropic from '@anthropic-ai/sdk';

const router = Router();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const DESKTOP = process.env.CITYWIDE_DESKTOP === '1';

type ChatTurn = { role: 'user' | 'assistant'; content: string };

/**
 * Build the registry-context system prompt and call Anthropic.
 * Shared by the live route and the offline ai_queue flush so a queued question
 * is answered with exactly the same context once connectivity returns.
 */
export async function generateAnswer(message: string, history: ChatTurn[] = []): Promise<string> {
  const accounts = (db.prepare('SELECT * FROM accounts ORDER BY name ASC LIMIT 50').all() as any[]).map((a) => Object.assign({}, a));
  const assignments = (db.prepare("SELECT * FROM key_assignments WHERE status='checked_out'").all() as any[]).map((a) => Object.assign({}, a));
  const staff = (db.prepare('SELECT DISTINCT staff_name FROM staff_key_holders').all() as any[]).map((s) => Object.assign({}, s));

  const alarmCount = accounts.filter((a) => a.alarm_code_encrypted).length;
  const doorCount = accounts.filter((a) => a.door_code_encrypted).length;

  const accountSummary = accounts
    .map(
      (a) =>
        `${a.name}: ${a.total_keys} keys (AM:${a.am_keys} CCM:${a.ccm_keys} IC:${a.contractor_keys})` +
        (a.has_fob ? ' [FOB]' : '') +
        (a.lockbox ? ` lockbox:${a.lockbox}` : '') +
        (a.notes ? ` | ${a.notes}` : '')
    )
    .join('\n');

  const systemPrompt = `You are the City Wide Boston key management assistant.
You have access to the complete key registry: ${accounts.length} accounts, ${alarmCount} alarm codes, ${doorCount} door codes, ${staff.length} staff members holding ${assignments.length} key assignments.
Answer questions about: which accounts have alarm/door codes, who holds keys for which accounts, overdue assignments, staff key holder details, lockbox codes, and notes about specific accounts.
Be specific and reference exact account names and staff names from the data. Keep responses concise and actionable.

CURRENT KEY REGISTRY (top 50 accounts):
${accountSummary}

ACTIVE ASSIGNMENTS (${assignments.length} total):
${assignments.slice(0, 20).map((a) => `${a.account_name}: ${a.assignee} — checked out ${a.checked_out_at}${a.due_at ? ` due ${a.due_at}` : ''}`).join('\n')}`;

  const messages = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user' as const, content: message },
  ];

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages,
  });

  return response.content[0].type === 'text' ? response.content[0].text : '';
}

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const { message, history = [] } = req.body as { message: string; history: ChatTurn[] };

  try {
    const text = await generateAnswer(message, history);

    logAudit(req, 'ai_query', null, null, { query: message.slice(0, 100) });

    res.json({ response: text });
  } catch (e: any) {
    // In the desktop build, a failure to reach Anthropic means we're offline —
    // queue the question and let the AI queue flush answer it on reconnect.
    if (DESKTOP) {
      const result = db.prepare(
        "INSERT INTO ai_queue (question, status) VALUES (?, 'pending')"
      ).run(message);
      return res.status(202).json({
        queued: true,
        id: Number(result.lastInsertRowid),
        question: message,
        status: 'pending',
      });
    }
    res.status(500).json({ error: e.message });
  }
});

// ── Desktop AI queue ────────────────────────────────────────────────────────
export interface AiQueueRow {
  id: number;
  question: string;
  status: 'pending' | 'answered' | 'failed';
  answer: string | null;
  created_at: string;
  answered_at: string | null;
}

/** All queued questions (newest first) — the panel polls this to flip pills. */
router.get('/queue', requireAuth, (_req: AuthRequest, res: Response) => {
  if (!DESKTOP) return res.json({ queue: [] });
  const queue = (db.prepare('SELECT * FROM ai_queue ORDER BY id DESC').all() as any[]).map((r) => Object.assign({}, r));
  res.json({ queue, pending: queue.filter((q) => q.status === 'pending').length });
});

/**
 * Flush pending AI questions in order. Called by the sync engine on reconnect.
 * Each answered row flips pending → answered; a hard failure flips → failed.
 * Returns the number of questions answered this pass.
 */
export async function flushAiQueue(): Promise<number> {
  if (!DESKTOP) return 0;
  const pending = (db.prepare("SELECT * FROM ai_queue WHERE status='pending' ORDER BY id ASC").all() as any[]).map((r) => Object.assign({}, r) as AiQueueRow);
  let answered = 0;
  for (const row of pending) {
    try {
      const text = await generateAnswer(row.question, []);
      db.prepare("UPDATE ai_queue SET status='answered', answer=?, answered_at=CURRENT_TIMESTAMP WHERE id=?").run(text, row.id);
      db.prepare('INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)').run(
        'ai_query', null, null, 'Sync', JSON.stringify({ query: row.question.slice(0, 100), source: 'ai_queue' })
      );
      answered++;
    } catch (err) {
      // Still offline / transient — leave as pending so the next flush retries.
      // Only mark failed if the API rejected the request outright (4xx).
      const status = (err as any)?.status;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        db.prepare("UPDATE ai_queue SET status='failed', answered_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
      }
      break; // stop the pass; retry the rest next reconnect
    }
  }
  return answered;
}

export default router;

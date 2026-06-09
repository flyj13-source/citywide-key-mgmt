import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';
import Anthropic from '@anthropic-ai/sdk';

const router = Router();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const { message, history = [] } = req.body as {
    message: string;
    history: Array<{ role: 'user' | 'assistant'; content: string }>;
  };

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

  try {
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

    const text = response.content[0].type === 'text' ? response.content[0].text : '';

    db.prepare('INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)').run(
      'ai_query', null, null, req.manager!.name, JSON.stringify({ query: message.slice(0, 100) })
    );

    res.json({ response: text });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

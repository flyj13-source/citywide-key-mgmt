import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { logAudit } from '../lib/audit';
import {
  CUSTODY_NOTIFY_KEY, getSetting, setSetting, settingMeta,
  parseRecipients, custodyNotifyRecipients, seedCustodyNotifyDefault,
} from '../lib/settings';

const router = Router();

// ── Operator-editable system settings ────────────────────────────────────────
// Today this holds exactly one thing: who receives a copy of every key custody
// email. It lives in the database rather than in a constant or an env var
// precisely so it survives the person currently in that seat moving on.

// ── GET /api/settings/custody-notification ───────────────────────────────────
router.get('/custody-notification', requireAuth, (_req: AuthRequest, res: Response) => {
  seedCustodyNotifyDefault();
  const stored = getSetting(CUSTODY_NOTIFY_KEY);
  const meta = settingMeta(CUSTODY_NOTIFY_KEY);
  res.json({
    value: stored ?? '',
    // What the mailer will ACTUALLY use right now, after fallbacks — so the
    // screen can never claim a recipient the emails do not go to.
    effective: custodyNotifyRecipients(),
    source: stored ? 'settings' : (process.env.CARA_EMAIL ? 'environment' : 'default'),
    updated_at: meta.updated_at,
    updated_by: meta.updated_by,
  });
});

// ── PUT /api/settings/custody-notification ───────────────────────────────────
// One or more comma-separated addresses. Rejects a malformed address outright:
// silently dropping it would mean nobody is notified and nothing says so.
router.put('/custody-notification', requireAuth, (req: AuthRequest, res: Response) => {
  const raw = req.body?.value;
  if (typeof raw !== 'string') {
    return res.status(400).json({ error: 'value must be a string of one or more email addresses' });
  }
  const { valid, invalid } = parseRecipients(raw);
  if (invalid.length) {
    return res.status(400).json({ error: `Not a valid email address: ${invalid.join(', ')}` });
  }
  if (!valid.length) {
    return res.status(400).json({ error: 'At least one recipient address is required' });
  }

  const previous = getSetting(CUSTODY_NOTIFY_KEY);
  const value = valid.join(', ');
  setSetting(CUSTODY_NOTIFY_KEY, value, req.manager?.name ?? 'System');

  logAudit(req, 'settings_updated', null, null, {
    key: CUSTODY_NOTIFY_KEY, from: previous, to: value,
  });

  const meta = settingMeta(CUSTODY_NOTIFY_KEY);
  res.json({
    success: true,
    value,
    effective: custodyNotifyRecipients(),
    source: 'settings',
    updated_at: meta.updated_at,
    updated_by: meta.updated_by,
  });
});

export default router;

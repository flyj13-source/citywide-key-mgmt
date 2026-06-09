import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';
import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs';
import { sendOverdueAlert } from '../lib/mailer';
import { sendTeamsAlert } from '../lib/teams';

const router = Router();

function getOverdue() {
  return (db.prepare(`
    SELECT *,
      CAST((julianday('now') - julianday(due_at)) AS INTEGER) as days_overdue
    FROM key_assignments
    WHERE status = 'checked_out' AND due_at IS NOT NULL AND due_at < datetime('now')
    ORDER BY due_at ASC
  `).all() as any[]).map((r) => Object.assign({}, r));
}

router.get('/overdue', requireAuth, (_req: AuthRequest, res: Response) => {
  res.json(getOverdue());
});

router.post('/excel', requireAuth, async (req: AuthRequest, res: Response) => {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'City Wide Boston Key Management';
  wb.created = new Date();

  const ws1 = wb.addWorksheet('Key Registry');
  ws1.columns = [
    { header: 'Account', key: 'name', width: 35 },
    { header: 'Total Keys', key: 'total_keys', width: 12 },
    { header: 'AM Keys', key: 'am_keys', width: 12 },
    { header: 'CCM Keys', key: 'ccm_keys', width: 12 },
    { header: 'IC Keys', key: 'contractor_keys', width: 12 },
    { header: 'Fob', key: 'has_fob', width: 8 },
    { header: 'Lockbox #', key: 'lockbox', width: 12 },
    { header: 'Key Code', key: 'key_code', width: 12 },
    { header: 'Notes', key: 'notes', width: 50 },
    { header: 'Status', key: 'status', width: 10 },
  ];
  ws1.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws1.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A1A' } };
  const accounts = (db.prepare('SELECT * FROM accounts ORDER BY name').all() as any[]).map((a) => Object.assign({}, a));
  accounts.forEach((a) => ws1.addRow({ ...a, has_fob: a.has_fob ? 'Yes' : 'No' }));

  const ws2 = wb.addWorksheet('Active Assignments');
  ws2.columns = [
    { header: 'Account', key: 'account_name', width: 35 },
    { header: 'Assignee', key: 'assignee', width: 25 },
    { header: 'Keys Held', key: 'keys_held', width: 20 },
    { header: 'Checked Out', key: 'checked_out_at', width: 20 },
    { header: 'Due', key: 'due_at', width: 20 },
    { header: 'Status', key: 'status', width: 12 },
  ];
  ws2.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws2.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A1A' } };
  (db.prepare("SELECT * FROM key_assignments WHERE status='checked_out' ORDER BY account_name").all() as any[])
    .map((a) => Object.assign({}, a)).forEach((a) => ws2.addRow(a));

  const ws3 = wb.addWorksheet('Overdue');
  ws3.columns = [
    { header: 'Account', key: 'account_name', width: 35 },
    { header: 'Assignee', key: 'assignee', width: 25 },
    { header: 'Due Date', key: 'due_at', width: 20 },
    { header: 'Days Overdue', key: 'days_overdue', width: 14 },
  ];
  ws3.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws3.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC0272D' } };
  getOverdue().forEach((o) => ws3.addRow(o));

  const ws4 = wb.addWorksheet('Staff Key Holders');
  ws4.columns = [
    { header: 'Staff Member', key: 'staff_name', width: 25 },
    { header: 'Account', key: 'account', width: 40 },
  ];
  ws4.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws4.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A1A' } };
  (db.prepare('SELECT * FROM staff_key_holders ORDER BY staff_name, account').all() as any[])
    .map((s) => Object.assign({}, s)).forEach((s) => ws4.addRow(s));

  const oneDrivePath = process.env.LOCAL_ONEDRIVE_PATH;
  if (oneDrivePath && fs.existsSync(oneDrivePath)) {
    const odFile = path.join(oneDrivePath, `KeyReport_${new Date().toISOString().slice(0, 10)}.xlsx`);
    await wb.xlsx.writeFile(odFile);
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="CityWide_KeyReport_${new Date().toISOString().slice(0, 10)}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();

  db.prepare('INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)').run(
    'excel_exported', null, null, (req as AuthRequest).manager!.name, JSON.stringify({ rows: accounts.length })
  );
});

router.post('/outlook', requireAuth, async (req: AuthRequest, res: Response) => {
  const overdue = getOverdue();
  if (overdue.length === 0) return res.json({ message: 'No overdue assignments' });
  try {
    await sendOverdueAlert(
      req.body.to || process.env.SMTP_USER || 'cara@citywideboston.com',
      overdue.map((o) => ({ account_name: o.account_name, assignee: o.assignee, days: o.days_overdue }))
    );
    db.prepare('INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)').run(
      'email_sent', null, null, req.manager!.name, JSON.stringify({ overdue_count: overdue.length })
    );
    res.json({ success: true, sent: overdue.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/teams', requireAuth, async (req: AuthRequest, res: Response) => {
  const overdue = getOverdue();
  if (overdue.length === 0) return res.json({ message: 'No overdue assignments' });
  try {
    await sendTeamsAlert(overdue.map((o) => ({ account_name: o.account_name, assignee: o.assignee, days: o.days_overdue })));
    db.prepare('INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)').run(
      'teams_alert_sent', null, null, req.manager!.name, JSON.stringify({ overdue_count: overdue.length })
    );
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

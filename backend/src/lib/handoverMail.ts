import { notifyAddresses, brandedShell, MailResult, sendBranded } from './custodyMail';

// ── Key handover notice ──────────────────────────────────────────────────────
// Sent after a bulk reassignment, to BOTH managers and Cara. It lists every
// client and the key types that must physically change hands — registry truth
// has already moved, this is the instruction for the metal to follow.

export interface HandoverMail {
  fromName: string;
  fromEmail: string | null;
  toName: string;
  toEmail: string | null;
  roleLabel: string;
  actor: string;
  clients: { name: string; bc_client_number: string | null; keys: { label: string; qty: number }[] }[];
}

const CW_RED = '#C0272D';
const CW_CHARCOAL = '#1a1a1a';
const CW_BG = '#f4f4f2';
const CW_BORDER = '#e0e0dd';
const CW_MUTED = '#6b6b68';

const esc = (v: any): string =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function sendHandoverNotice(d: HandoverMail): Promise<MailResult> {
  const subject = `Key handover — ${d.fromName} → ${d.toName}`;
  const totalKeys = d.clients.reduce((n, c) => n + c.keys.reduce((m, k) => m + k.qty, 0), 0);

  const rows = d.clients.map((c, i) => `
    <tr style="background:${i % 2 === 0 ? '#ffffff' : CW_BG}">
      <td style="padding:10px 14px;border-top:1px solid ${CW_BORDER};color:${CW_CHARCOAL}">
        ${esc(c.name)}
        ${c.bc_client_number ? `<div style="color:${CW_MUTED};font-size:11px">${esc(c.bc_client_number)}</div>` : ''}
      </td>
      <td style="padding:10px 14px;border-top:1px solid ${CW_BORDER};color:${CW_CHARCOAL};font-size:13px">
        ${c.keys.length ? c.keys.map((k) => `${k.qty} × ${esc(k.label)}`).join('<br />') : '<span style="color:' + CW_MUTED + '">No keys recorded</span>'}
      </td>
    </tr>`).join('');

  const body = `
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:20px">
      <tr><td style="padding:5px 0;color:${CW_MUTED};font-size:13px;width:150px">Handing over</td>
          <td style="padding:5px 0;color:${CW_CHARCOAL};font-size:13px;font-weight:600">${esc(d.fromName)}</td></tr>
      <tr><td style="padding:5px 0;color:${CW_MUTED};font-size:13px">Receiving</td>
          <td style="padding:5px 0;color:${CW_CHARCOAL};font-size:13px;font-weight:600">${esc(d.toName)}</td></tr>
      <tr><td style="padding:5px 0;color:${CW_MUTED};font-size:13px">Role</td>
          <td style="padding:5px 0;color:${CW_CHARCOAL};font-size:13px;font-weight:600">${esc(d.roleLabel)}</td></tr>
      <tr><td style="padding:5px 0;color:${CW_MUTED};font-size:13px">Recorded by</td>
          <td style="padding:5px 0;color:${CW_CHARCOAL};font-size:13px;font-weight:600">${esc(d.actor)}</td></tr>
    </table>

    <div style="margin-bottom:18px;padding:14px;border:1px solid ${CW_BORDER};border-left:4px solid ${CW_RED};border-radius:4px;background:${CW_BG};font-size:13px;color:${CW_CHARCOAL}">
      The registry has already been updated. <strong>The physical keys still need to change hands.</strong>
      These clients stay flagged in the Key Registry until the handover is confirmed.
    </div>

    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid ${CW_BORDER};border-radius:4px;border-collapse:separate;overflow:hidden">
      <tr style="background:${CW_CHARCOAL};color:#ffffff;font-size:12px;text-transform:uppercase;letter-spacing:1px">
        <th align="left" style="padding:10px 14px;font-weight:600">Client</th>
        <th align="left" style="padding:10px 14px;font-weight:600">Keys to exchange</th>
      </tr>
      ${rows}
      <tr style="background:${CW_BG}">
        <td style="padding:10px 14px;border-top:2px solid ${CW_RED};font-weight:700;color:${CW_CHARCOAL}">${d.clients.length} client${d.clients.length === 1 ? '' : 's'}</td>
        <td style="padding:10px 14px;border-top:2px solid ${CW_RED};font-weight:700;color:${CW_RED}">${totalKeys} key${totalKeys === 1 ? '' : 's'} total</td>
      </tr>
    </table>`;

  const html = brandedShell(
    'Key handover required',
    `${d.fromName} → ${d.toName} · ${d.clients.length} client${d.clients.length === 1 ? '' : 's'}`,
    body,
  );

  const text = [
    subject,
    `Handing over: ${d.fromName}`,
    `Receiving: ${d.toName}`,
    `Role: ${d.roleLabel}`,
    `Recorded by: ${d.actor}`,
    '',
    'The registry has already been updated. The physical keys still need to change hands.',
    '',
    ...d.clients.map((c) =>
      `  ${c.name}${c.bc_client_number ? ` (${c.bc_client_number})` : ''}: ` +
      (c.keys.length ? c.keys.map((k) => `${k.qty} × ${k.label}`).join(', ') : 'no keys recorded')),
    '',
    `${d.clients.length} client(s), ${totalKeys} key(s) total.`,
  ].join('\n');

  // notifyAddresses() returns the list, so several configured recipients each
  // land as their own address rather than one comma-joined blob.
  return sendBranded(subject, html, text, [d.fromEmail || '', d.toEmail || '', ...notifyAddresses()]);
}

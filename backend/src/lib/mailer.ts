import nodemailer from 'nodemailer';

export function createTransport() {
  return nodemailer.createTransport({
    host: 'smtp.office365.com',
    port: 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: { ciphers: 'SSLv3' },
  });
}

export async function sendOverdueAlert(
  to: string,
  overdueList: Array<{ account_name: string; assignee: string; days: number }>
) {
  const transport = createTransport();
  const rows = overdueList
    .map(
      (o) =>
        `<tr><td style="padding:4px 8px">${o.account_name}</td><td style="padding:4px 8px">${o.assignee}</td><td style="padding:4px 8px;color:#C0272D">${o.days} days</td></tr>`
    )
    .join('');
  await transport.sendMail({
    from: `City Wide Key Management <${process.env.SMTP_USER}>`,
    to,
    subject: `[Key Alert] ${overdueList.length} overdue key assignment(s)`,
    html: `
      <h2 style="color:#C0272D">City Wide Boston — Overdue Key Assignments</h2>
      <table border="1" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif">
        <thead><tr style="background:#1a1a1a;color:#fff">
          <th style="padding:4px 8px">Account</th>
          <th style="padding:4px 8px">Assignee</th>
          <th style="padding:4px 8px">Days Overdue</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="color:#6b6b68;font-size:12px">Sent by City Wide Key Management System</p>
    `,
  });
}

export async function sendContractorInvite(to: string, name: string, magicLink: string) {
  const transport = createTransport();
  await transport.sendMail({
    from: `City Wide Key Management <${process.env.SMTP_USER}>`,
    to,
    subject: 'City Wide Boston — Key Receipt Acknowledgement Required',
    html: `
      <h2 style="color:#C0272D">Key Receipt Acknowledgement</h2>
      <p>Hello ${name},</p>
      <p>Please click the link below to acknowledge receipt of your assigned keys. This link expires in 48 hours.</p>
      <a href="${magicLink}" style="display:inline-block;padding:12px 24px;background:#C0272D;color:#fff;text-decoration:none;border-radius:4px">Acknowledge Key Receipt</a>
      <p style="color:#6b6b68;font-size:12px">City Wide Building Services · Boston, MA</p>
    `,
  });
}

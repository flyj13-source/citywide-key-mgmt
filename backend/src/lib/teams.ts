export async function sendTeamsAlert(
  overdueList: Array<{ account_name: string; assignee: string; days: number }>
) {
  const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
  if (!webhookUrl) throw new Error('TEAMS_WEBHOOK_URL not configured');

  const facts = overdueList.slice(0, 10).map((o) => ({
    title: o.account_name,
    value: `${o.assignee} — **${o.days} days overdue**`,
  }));

  const body = {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.3',
          body: [
            {
              type: 'TextBlock',
              size: 'Large',
              weight: 'Bolder',
              text: `🔑 ${overdueList.length} Overdue Key Assignment(s)`,
              color: 'Attention',
            },
            { type: 'FactSet', facts },
            overdueList.length > 10
              ? {
                  type: 'TextBlock',
                  text: `...and ${overdueList.length - 10} more. Open the Key Management System for full list.`,
                  isSubtle: true,
                }
              : null,
          ].filter(Boolean),
        },
      },
    ],
  };

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Teams webhook failed: ${res.status}`);
}

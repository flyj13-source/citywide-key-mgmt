import Layout from '../components/Layout';

export default function Settings() {
  return (
    <Layout>
      <div className="p-6 max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-xl font-bold">Settings</h1>
          <p className="text-sm text-cw-muted">M365 integrations and system configuration</p>
        </div>

        {[
          {
            title: 'SMTP / Outlook',
            fields: [
              { label: 'SMTP Host', value: 'smtp.office365.com', hint: 'Office 365 SMTP relay' },
              { label: 'SMTP Port', value: '587', hint: 'STARTTLS' },
              { label: 'SMTP User', value: 'SMTP_USER in .env', hint: 'e.g. cara@citywideboston.com' },
              { label: 'SMTP Password', value: '••••••••', hint: 'App password from Outlook settings' },
            ],
          },
          {
            title: 'Microsoft Teams',
            fields: [
              { label: 'Incoming Webhook URL', value: 'TEAMS_WEBHOOK_URL in .env', hint: 'Add Incoming Webhook connector to Facilities channel' },
            ],
          },
          {
            title: 'OneDrive / SharePoint',
            fields: [
              { label: 'Local OneDrive Path', value: 'LOCAL_ONEDRIVE_PATH in .env', hint: 'Path to synced OneDrive folder on this machine' },
            ],
          },
          {
            title: 'Security',
            fields: [
              { label: 'JWT Secret', value: 'JWT_SECRET in .env', hint: 'Change in production — minimum 32 chars' },
              { label: 'Encryption Key', value: 'ENCRYPTION_KEY in .env', hint: '32-byte hex key for AES-256-GCM vault' },
              { label: 'Anthropic API Key', value: 'ANTHROPIC_API_KEY in .env', hint: 'Required for AI Assistant feature' },
            ],
          },
        ].map((section) => (
          <div key={section.title} className="card overflow-hidden">
            <div className="px-5 py-3 bg-cw-black">
              <h2 className="text-white font-semibold text-sm">{section.title}</h2>
            </div>
            <div className="divide-y divide-cw-border">
              {section.fields.map((f) => (
                <div key={f.label} className="px-5 py-3 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium">{f.label}</div>
                    <div className="text-xs text-cw-muted">{f.hint}</div>
                  </div>
                  <code className="text-xs bg-gray-100 border border-cw-border px-2 py-1 rounded text-cw-muted max-w-[200px] truncate">
                    {f.value}
                  </code>
                </div>
              ))}
            </div>
          </div>
        ))}

        <div className="card p-5 border-l-4 border-l-yellow-400">
          <h3 className="font-semibold text-sm mb-2">Configuration Instructions</h3>
          <ol className="text-sm text-cw-muted space-y-2 list-decimal list-inside">
            <li>Copy <code className="bg-gray-100 px-1 rounded">.env.example</code> to <code className="bg-gray-100 px-1 rounded">backend/.env</code></li>
            <li>Generate an Outlook app password at <strong>account.microsoft.com → Security → App passwords</strong></li>
            <li>Add Teams webhook: open Teams → channel → Connectors → Incoming Webhook</li>
            <li>Set <code className="bg-gray-100 px-1 rounded">LOCAL_ONEDRIVE_PATH</code> to your OneDrive sync folder (Excel saves there automatically)</li>
            <li>Set <code className="bg-gray-100 px-1 rounded">ANTHROPIC_API_KEY</code> from <strong>console.anthropic.com</strong></li>
          </ol>
        </div>
      </div>
    </Layout>
  );
}

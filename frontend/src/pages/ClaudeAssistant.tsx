import { useState, useRef, useEffect } from 'react';
import Layout from '../components/Layout';
import { askClaude } from '../lib/api';

interface Message { role: 'user' | 'assistant'; content: string; }

const SUGGESTIONS = [
  'Which accounts have alarm codes?',
  'Who holds keys for Greentown Labs?',
  'List all overdue assignments',
  'Which accounts have key fobs?',
  'What is the lockbox code for Beverly Bank?',
  'How many keys does Craig Kolesar hold?',
];

export default function ClaudeAssistant() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = async (text?: string) => {
    const query = text || input.trim();
    if (!query || loading) return;
    setInput('');
    const userMsg: Message = { role: 'user', content: query };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setLoading(true);
    try {
      const data = await askClaude(query, messages);
      setMessages([...newMessages, { role: 'assistant', content: data.response }]);
    } catch (e: any) {
      setMessages([...newMessages, { role: 'assistant', content: `Error: ${e.message}` }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Layout>
      <div className="flex flex-col h-full p-6 max-w-4xl mx-auto">
        <div className="mb-4">
          <h1 className="text-xl font-bold flex items-center gap-2">
            <span className="text-cw-red">✦</span> AI Assistant
          </h1>
          <p className="text-sm text-cw-muted">Ask questions about keys, codes, staff assignments, and more</p>
        </div>

        {/* Chat area */}
        <div className="card flex-1 flex flex-col overflow-hidden" style={{ minHeight: 0, height: 'calc(100vh - 260px)' }}>
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {messages.length === 0 && (
              <div className="space-y-4">
                <div className="text-center text-cw-muted text-sm py-6">
                  <div className="text-3xl mb-2">✦</div>
                  <div className="font-medium text-cw-text mb-1">City Wide Key Management Assistant</div>
                  <div>Ask anything about the key registry, staff assignments, or access codes</div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      className="text-left text-sm text-cw-muted border border-cw-border rounded px-3 py-2 hover:border-cw-red hover:text-cw-text transition-colors"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[80%] rounded-lg px-4 py-3 text-sm whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-cw-red text-white'
                      : 'bg-gray-100 text-cw-text border border-cw-border'
                  }`}
                >
                  {msg.role === 'assistant' && (
                    <div className="text-xs text-cw-muted mb-1 font-medium">✦ Assistant</div>
                  )}
                  {msg.content}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex justify-start">
                <div className="bg-gray-100 border border-cw-border rounded-lg px-4 py-3 text-sm text-cw-muted">
                  <div className="flex gap-1 items-center">
                    <span className="animate-pulse">●</span>
                    <span className="animate-pulse" style={{ animationDelay: '0.2s' }}>●</span>
                    <span className="animate-pulse" style={{ animationDelay: '0.4s' }}>●</span>
                  </div>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="border-t border-cw-border p-4">
            <div className="flex gap-2">
              <input
                className="input flex-1"
                placeholder="Ask about keys, staff, codes…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                disabled={loading}
              />
              <button onClick={() => send()} disabled={loading || !input.trim()} className="btn-primary px-5">
                Send
              </button>
              {messages.length > 0 && (
                <button onClick={() => setMessages([])} className="btn-secondary text-xs">Clear</button>
              )}
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}

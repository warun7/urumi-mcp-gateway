import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { useUser } from '../auth';
import { AccessBadge, Badge, Button, Callout } from '../components/ui';
import { Icons } from '../icons';

interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
interface Msg { role: 'user' | 'assistant' | 'tool'; content?: string | null; tool_calls?: ToolCall[]; tool_call_id?: string; name?: string }
interface Pending { id: string; name: string; server: string; description: string; args: Record<string, unknown> }
interface LiveCall { id: string; name: string; args: unknown; access: 'read' | 'write'; result?: { isError: boolean; preview: string } }
/** A streaming turn, in order: the model's text, then the tools it calls, then more text, and so on. */
type LivePart = { type: 'text'; text: string } | { type: 'calls'; calls: LiveCall[] };

const SUGGESTIONS = [
  { text: 'How many orders did we get today?', hint: 'Reads orders from the store' },
  { text: 'Create a product called "Blue Mug" for 499', hint: 'A write: you approve it first' },
  { text: 'Compare today\'s sales across all stores', hint: 'Calls every store in parallel' },
  { text: 'Fetch https://example.com and summarise it', hint: 'Sends a request out, so you approve it first' },
];

/**
 * Chat with the team's tools. The browser keeps the conversation (the agent is stateless) and sends it
 * with each turn; the gateway mints a short-lived token so the agent acts as *this* user.
 */
export function ChatPage() {
  const { me } = useUser();
  const qc = useQueryClient();
  const storeKey = `urumi-chat:${me.user.id}`;
  const [history, setHistory] = useState<Msg[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(storeKey) ?? '[]');
    } catch {
      return [];
    }
  });
  const [pending, setPending] = useState<Pending[] | null>(null);
  const [live, setLive] = useState<LivePart[] | null>(null);
  const [error, setError] = useState('');
  const [input, setInput] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const info = useQuery({ queryKey: ['chat-info'], queryFn: () => api<{ available: boolean; provider: string | null; model: string | null }>('/chat/info'), staleTime: 60_000 });

  useEffect(() => {
    try {
      sessionStorage.setItem(storeKey, JSON.stringify(history));
    } catch {
      /* storage full or disabled: the chat still works for this page view */
    }
  }, [history, storeKey]);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [history, live, pending]);
  // If the page reloads while an approval was pending, the history still ends with unanswered calls.
  useEffect(() => {
    if (!pending && !live) setPending(unansweredFromHistory(history));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (messages: Msg[], approvals: Record<string, boolean> = {}) => {
    setError('');
    setPending(null);
    setLive([]);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages, approvals }),
        signal: ctrl.signal,
        credentials: 'same-origin',
      });
      if (res.status === 401) return location.assign('/login?next=/chat');
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      for await (const ev of readSse(res.body)) {
        const d = JSON.parse(ev.data);
        if (ev.event === 'text') setLive((l) => l && appendPart(l, { type: 'text', text: d.delta }));
        else if (ev.event === 'tool_call') setLive((l) => l && appendPart(l, { type: 'calls', calls: [{ id: d.id, name: d.name, args: d.args, access: d.access }] }));
        else if (ev.event === 'tool_result')
          setLive((l) => l && l.map((p) => (p.type === 'calls' ? { ...p, calls: p.calls.map((c) => (c.id === d.id ? { ...c, result: { isError: d.isError, preview: d.preview } } : c)) } : p)));
        else if (ev.event === 'approval_required') setPending(d.calls);
        else if (ev.event === 'messages') setHistory(d.messages);
        else if (ev.event === 'error') setError(d.message);
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
      else setHistory(messages); // keep what was sent; the partial answer is dropped
    } finally {
      setLive(null);
      abortRef.current = null;
      qc.invalidateQueries({ queryKey: ['audit'] });
    }
  };

  const send = (text: string) => {
    const t = text.trim();
    if (!t || live) return;
    setInput('');
    const next = [...history, { role: 'user' as const, content: t }];
    setHistory(next);
    void run(next);
  };
  const decide = (approve: boolean) => {
    if (!pending) return;
    void run(history, Object.fromEntries(pending.map((p) => [p.id, approve])));
  };
  const reset = () => {
    abortRef.current?.abort();
    setHistory([]);
    setPending(null);
    setError('');
  };

  const results = new Map(history.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id!, m.content ?? '']));
  const busy = !!live;
  const model = info.data;

  return (
    <div className="chat-page">
      <header className="chat-head">
        <h1>Chat</h1>
        {model && (model.available
          ? model.provider === 'scripted'
            ? <Badge tone="warn" title="Set an LLM key on the agent (make chat-llm) for a real model">Demo model (scripted)</Badge>
            : <Badge>{model.model}</Badge>
          : <Badge tone="err">Assistant offline</Badge>)}
        <span className="sub">Acts as you, with your permissions. Anything that changes data asks for your approval first.</span>
        <div className="spacer" />
        {history.length > 0 && <Button size="sm" icon={<Icons.plus />} onClick={reset}>New chat</Button>}
      </header>

      <div className="chat-scroll" ref={logRef}>
        <div className="chat-log">
          {history.length === 0 && !live && (
            <div className="chat-empty">
              <h2>What would you like to know?</h2>
              <p>Ask about your stores, or anything your connected tools can do.</p>
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s.text} type="button" className="suggestion" onClick={() => send(s.text)}>
                    {s.text}
                    <small>{s.hint}</small>
                  </button>
                ))}
              </div>
            </div>
          )}
          {history.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="msg-user">{m.content}</div>
            ) : m.role === 'assistant' ? (
              <div key={i} className="msg-assistant">
                {m.content && <div><Markdown text={m.content} /></div>}
                {m.tool_calls?.length ? (
                  <div className="tool-calls">
                    {m.tool_calls.map((c) => <ToolChip key={c.id} name={c.function.name} args={safeJson(c.function.arguments)} result={results.has(c.id) ? { isError: /^Tool error:|declined/.test(results.get(c.id)!), preview: results.get(c.id)! } : undefined} />)}
                  </div>
                ) : null}
              </div>
            ) : null,
          )}
          {live && (
            <div className="msg-assistant">
              {live.map((p, i) => p.type === 'text'
                ? <div key={i}><Markdown text={p.text} /></div>
                : (
                  <div key={i} className="tool-calls">
                    {p.calls.map((c) => <ToolChip key={c.id} name={c.name} args={c.args} access={c.access} result={c.result} running={!c.result} />)}
                  </div>
                ))}
              {waitingOnModel(live) && !pending && <div className="thinking"><span className="spinner" /> Thinking…</div>}
            </div>
          )}
          {pending && !live && (
            <div className="approval">
              <div className="approval-head">
                <Icons.alert />
                <strong>Approve {pending.length === 1 ? 'this action' : `these ${pending.length} actions`}?</strong>
                <span className="small muted">Nothing runs until you approve: these tools change data or send requests outside the gateway.</span>
              </div>
              {pending.map((p) => (
                <div key={p.id} className="approval-call">
                  <div className="row-sm">
                    <span className="mono strong">{p.name}</span>
                    <Badge>{p.server}</Badge>
                    <AccessBadge access="write" />
                  </div>
                  {p.description && <p className="small muted mt-1">{p.description}</p>}
                  {Object.keys(p.args ?? {}).length > 0 && (
                    <dl className="props compact">
                      {Object.entries(p.args ?? {}).map(([k, v]) => (
                        <Fragment key={k}><dt className="mono xs">{k}</dt><dd className="mono xs">{typeof v === 'string' ? v : JSON.stringify(v)}</dd></Fragment>
                      ))}
                    </dl>
                  )}
                </div>
              ))}
              <div className="row-sm">
                <Button variant="primary" icon={<Icons.check />} onClick={() => decide(true)}>Approve</Button>
                <Button onClick={() => decide(false)}>Decline</Button>
              </div>
            </div>
          )}
          {error && <Callout tone="err">{error}</Callout>}
        </div>
      </div>

      <div className="composer-wrap">
        <form className="composer" onSubmit={(e) => { e.preventDefault(); send(input); }}>
          <textarea
            placeholder={pending ? 'Approve or decline the action above first' : 'Ask about orders, products, sales…'}
            value={input}
            disabled={!!pending}
            rows={1}
            aria-label="Message"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(input);
              }
            }}
          />
          {busy
            ? <Button icon={<Icons.stop />} onClick={() => abortRef.current?.abort()} aria-label="Stop" title="Stop" />
            : <Button type="submit" variant="primary" icon={<Icons.send />} disabled={!input.trim() || !!pending} aria-label="Send" title="Send" />}
        </form>
        <p className="composer-hint">Enter to send · Shift + Enter for a new line · Every tool call is recorded in the audit log</p>
      </div>
    </div>
  );
}

function ToolChip({ name, args, access, result, running }: { name: string; args: unknown; access?: 'read' | 'write'; result?: { isError: boolean; preview: string }; running?: boolean }) {
  const [open, setOpen] = useState(false);
  const tone = !result ? 'warn' : result.isError ? 'err' : 'ok';
  return (
    <div>
      <button type="button" className="tool-chip" onClick={() => setOpen(!open)} aria-expanded={open} title="Show arguments and result">
        {running ? <span className="spinner" /> : <span className={`dot ${tone}`} title={!result ? 'Waiting for your approval' : result.isError ? 'Failed or declined' : 'Done'} />}
        <span className="mono">{name}</span>
        {access === 'write' && <Badge tone="accent">write</Badge>}
        <Icons.chevronDown />
      </button>
      {open && (
        <div className="tool-detail">
          <div className="label">Arguments</div>
          <pre className="code plain">{JSON.stringify(args, null, 2)}</pre>
          {result && (
            <>
              <div className="label">Result{result.isError ? ' (error)' : ''}</div>
              <pre className="code plain scroll">{prettyMaybe(result.preview)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- helpers

async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) yield { event, data: data.join('\n') };
    }
  }
}

function unansweredFromHistory(history: Msg[]): Pending[] | null {
  const last = history.map((m) => m.role).lastIndexOf('assistant');
  if (last < 0) return null;
  const answered = new Set(history.slice(last + 1).map((m) => m.tool_call_id));
  const open = (history[last]!.tool_calls ?? []).filter((c) => !answered.has(c.id));
  if (!open.length) return null;
  return open.map((c) => {
    const args = safeJson(c.function.arguments) as Record<string, unknown>;
    const viaMeta = c.function.name === 'gateway__call_tool';
    const name = viaMeta ? String(args.name ?? '') : c.function.name;
    return { id: c.id, name, server: name.split('__')[0] ?? '', description: '', args: (viaMeta ? args.arguments : args) as Record<string, unknown> };
  });
}

/** Text deltas extend the text before them; consecutive tool calls share one row of chips. */
function appendPart(parts: LivePart[], next: LivePart): LivePart[] {
  const last = parts.at(-1);
  if (last?.type === 'text' && next.type === 'text') return [...parts.slice(0, -1), { type: 'text', text: last.text + next.text }];
  if (last?.type === 'calls' && next.type === 'calls') return [...parts.slice(0, -1), { type: 'calls', calls: [...last.calls, ...next.calls] }];
  return [...parts, next];
}
/** Nothing streamed yet, or every tool call has finished and the model hasn't started writing. */
const waitingOnModel = (parts: LivePart[]) => {
  const last = parts.at(-1);
  return !last || (last.type === 'calls' && last.calls.every((c) => c.result));
};

const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};
const prettyMaybe = (s: string) => {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
};

/** A tiny, safe Markdown subset (paragraphs, headings, lists, tables, bold, code, links), built as React nodes, with no HTML injection. */
function Markdown({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        const lines = b.split('\n');
        if (lines.every((l) => /^\s*([-*_])(\s*\1){2,}\s*$/.test(l))) return <hr key={i} className="md-rule" />;
        const table = mdTable(lines);
        if (table) return table(i);
        if (lines.every((l) => /^\s*[-*] /.test(l))) return <ul key={i} className="md-block">{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*[-*] /, ''))}</li>)}</ul>;
        if (lines.every((l) => /^\s*\d+\. /.test(l))) return <ol key={i} className="md-block">{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*\d+\. /, ''))}</li>)}</ol>;
        // Mixed blocks (a heading line followed by a list) are common in model output.
        return (
          <div key={i} className="md-block">
            {lines.map((l, j) => /^\s*[-*] /.test(l) ? <div key={j} className="md-bullet">• {inline(l.replace(/^\s*[-*] /, ''))}</div> : mdLine(l, j))}
          </div>
        );
      })}
    </div>
  );
}

/** One line of a mixed block: a heading, or plain text. */
const mdLine = (l: string, key: number) => (/^#{1,6}\s/.test(l) ? <div key={key} className="md-heading">{inline(l.replace(/^#+\s*/, ''))}</div> : <div key={key}>{inline(l)}</div>);

/** A GitHub-style table: a header row, a |---| separator, then rows. Models reach for these to compare stores. */
function mdTable(lines: string[]): ((key: number) => ReactNode) | null {
  // A table can follow a lead-in line in the same block ("Today's orders:" then the table).
  const start = lines.findIndex((l) => /^\s*\|/.test(l));
  if (start < 0 || lines.length - start < 2 || !/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[start + 1]!)) return null;
  if (!lines.slice(start).every((l) => /^\s*\|/.test(l))) return null;
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const [head, , ...rows] = lines.slice(start);
  const body = rows.map(cells);
  // Right-align a column (header included) when every value in it is a number or an amount.
  const numeric = cells(head!).map((_, j) => body.length > 0 && body.every((r) => /^[-+]?[₹$€£]?\s?[\d,]+(\.\d+)?\s?[A-Z%]{0,3}$/.test(r[j] ?? '')));
  return (key) => (
    <Fragment key={key}>
      {start > 0 && <div className="md-block">{lines.slice(0, start).map(mdLine)}</div>}
      <div className="md-table-wrap">
        <table className="md-table">
          <thead><tr>{cells(head!).map((c, j) => <th key={j} className={numeric[j] ? 'num' : undefined}>{inline(c)}</th>)}</tr></thead>
          <tbody>{body.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k} className={numeric[k] ? 'num' : undefined}>{inline(c)}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </Fragment>
  );
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else if (t.startsWith('[')) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!;
      out.push(<a key={k++} href={href} target="_blank" rel="noopener noreferrer">{label}</a>);
    } else out.push(<a key={k++} href={t} target="_blank" rel="noopener noreferrer">{t}</a>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

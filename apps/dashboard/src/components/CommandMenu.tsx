import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { useUser } from '../auth';
import { Icons } from '../icons';
import type { Server } from '../types';
import { copyText, Kbd, useToast } from './ui';

type Group = 'Actions' | 'Go to' | 'Servers';
type Cmd = { id: string; group: Group; label: string; icon: ReactNode; hint?: string; keywords?: string; run: () => void };

const DOT: Record<Server['status'], string> = { connected: 'ok', pending: 'warn', unreachable: 'err', disabled: '' };

/** ⌘K: jump to any page, server or action by typing. The fastest way around the dashboard. */
export function CommandMenu({ onClose, servers }: { onClose: () => void; servers: Server[] }) {
  const { me, isAdmin } = useUser();
  const nav = useNavigate();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const cmds = useMemo<Cmd[]>(() => {
    const go = (to: string) => () => nav(to);
    const list: (Cmd | false)[] = [
      isAdmin && { id: 'a-server', group: 'Actions', label: 'Add an MCP server', icon: <Icons.plus />, keywords: 'register new upstream', run: go('/servers?new=1') },
      { id: 'a-key', group: 'Actions', label: 'Create an API key', icon: <Icons.key />, keywords: 'token new connect', run: go('/keys?new=1') },
      isAdmin && { id: 'a-invite', group: 'Actions', label: 'Invite a member', icon: <Icons.mail />, keywords: 'user team add people', run: go('/members?new=1') },
      isAdmin && { id: 'a-rule', group: 'Actions', label: 'Add a permission rule', icon: <Icons.lock />, keywords: 'allow deny access', run: go('/permissions?new=1') },
      me.storesEnabled && { id: 'a-store', group: 'Actions', label: 'Create a store', icon: <Icons.store />, keywords: 'woocommerce new shop', run: go('/stores?new=1') },
      { id: 'a-copy', group: 'Actions', label: 'Copy the MCP URL', icon: <Icons.copy />, keywords: 'endpoint connect client', run: () => void copyText(me.mcpUrl).then(() => toast('MCP URL copied')) },
      { id: 'p-overview', group: 'Go to', label: 'Overview', icon: <Icons.home />, keywords: 'home dashboard', run: go('/') },
      { id: 'p-chat', group: 'Go to', label: 'Chat', icon: <Icons.chat />, keywords: 'assistant ask', run: go('/chat') },
      { id: 'p-servers', group: 'Go to', label: 'Servers', icon: <Icons.servers />, keywords: 'mcp upstreams tools', run: go('/servers') },
      me.storesEnabled && { id: 'p-stores', group: 'Go to', label: 'Stores', icon: <Icons.store />, keywords: 'woocommerce shops', run: go('/stores') },
      { id: 'p-audit', group: 'Go to', label: 'Audit log', icon: <Icons.audit />, keywords: 'logs calls history activity', run: go('/audit') },
      { id: 'p-keys', group: 'Go to', label: 'API keys', icon: <Icons.key />, keywords: 'tokens', run: go('/keys') },
      { id: 'p-apps', group: 'Go to', label: 'Connected apps', icon: <Icons.apps />, keywords: 'oauth clients grants', run: go('/apps') },
      isAdmin && { id: 'p-members', group: 'Go to', label: 'Members', icon: <Icons.users />, keywords: 'team people users invites', run: go('/members') },
      isAdmin && { id: 'p-perms', group: 'Go to', label: 'Permissions', icon: <Icons.lock />, keywords: 'rules access allow deny', run: go('/permissions') },
      { id: 'p-account', group: 'Go to', label: 'Account settings', icon: <Icons.user />, keywords: 'password profile theme dark light', run: go('/account') },
      ...servers.map<Cmd>((s) => ({
        id: `s-${s.id}`,
        group: 'Servers',
        label: s.displayName,
        hint: s.slug,
        icon: <span className={`dot ${DOT[s.status]}`} />,
        keywords: `${s.slug} ${s.url}`,
        run: go(`/servers/${s.id}`),
      })),
    ];
    return list.filter((c): c is Cmd => !!c);
  }, [isAdmin, me, servers, nav, toast]);

  const shown = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return cmds;
    return cmds.filter((c) => {
      const hay = `${c.label} ${c.hint ?? ''} ${c.keywords ?? ''} ${c.group}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [cmds, q]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.cmdk-item.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const run = (c: Cmd | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((i) => Math.min(i + 1, shown.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(shown[sel]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  let lastGroup: Group | null = null;
  return createPortal(
    <div className="cmdk-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command menu">
        <div className="cmdk-input">
          <Icons.search />
          <input
            autoFocus
            placeholder="Search pages, servers and actions…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-list"
            aria-activedescendant={shown[sel] ? `cmd-${shown[sel].id}` : undefined}
          />
          <Kbd>Esc</Kbd>
        </div>
        <div className="cmdk-list" id="cmdk-list" role="listbox" ref={listRef}>
          {shown.length === 0 && <div className="cmdk-empty">Nothing matches “{q}”.</div>}
          {shown.map((c, i) => {
            const head = c.group !== lastGroup ? <div className="cmdk-group" key={`g-${c.group}`}>{c.group}</div> : null;
            lastGroup = c.group;
            return [
              head,
              <button
                key={c.id}
                id={`cmd-${c.id}`}
                type="button"
                role="option"
                aria-selected={i === sel}
                className={`cmdk-item ${i === sel ? 'sel' : ''}`}
                onMouseMove={() => i !== sel && setSel(i)}
                onClick={() => run(c)}
              >
                {c.icon}
                <span className="truncate">{c.label}</span>
                {c.hint && <span className="hint mono">{c.hint}</span>}
              </button>,
            ];
          })}
        </div>
        <div className="cmdk-foot">
          <span><Kbd>↑</Kbd><Kbd>↓</Kbd> to move</span>
          <span><Kbd>↵</Kbd> to open</span>
          <span><Kbd>esc</Kbd> to close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

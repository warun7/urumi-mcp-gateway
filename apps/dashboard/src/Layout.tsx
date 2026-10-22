import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { api } from './api';
import { useUser } from './auth';
import { CommandMenu } from './components/CommandMenu';
import { Avatar, Button, Kbd, Menu, Segmented } from './components/ui';
import { Icons, Logo } from './icons';
import { useTheme, type Theme } from './theme';
import type { Server } from './types';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function Layout() {
  const { me, isAdmin } = useUser();
  const [navOpen, setNavOpen] = useState(false);
  const [cmdk, setCmdk] = useState(false);
  const loc = useLocation();
  useEffect(() => setNavOpen(false), [loc.pathname]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdk((v) => !v);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // Attention counts for the nav: tools waiting for review, servers that are down.
  const servers = useQuery({ queryKey: ['servers'], queryFn: () => api<{ servers: Server[] }>('/servers'), refetchInterval: 15_000 });
  const list = servers.data?.servers ?? [];
  const pending = list.reduce((n, s) => n + (s.tools?.pending ?? 0), 0);
  const down = list.filter((s) => s.status === 'unreachable').length;
  const serversCount = isAdmin && (down || pending) ? { n: down || pending, tone: down ? 'err' : 'warn', title: down ? `${down} unreachable` : `${pending} tools to review` } : undefined;

  return (
    <div className="shell">
      <a href="#main" className="skip-link">Skip to content</a>
      <header className="mobile-bar">
        <Button variant="ghost" icon={<Icons.menu />} onClick={() => setNavOpen(true)} aria-label="Open navigation" />
        <Link to="/" className="brand"><Logo /><span className="brand-name">Urumi</span></Link>
        <div className="spacer" />
        <Button variant="ghost" icon={<Icons.search />} onClick={() => setCmdk(true)} aria-label="Search" />
      </header>

      <aside className={`sidebar ${navOpen ? 'open' : ''}`} aria-label="Sidebar">
        <Link to="/" className="brand">
          <Logo />
          <div>
            <div className="brand-name">Urumi</div>
            <div className="brand-sub">MCP Gateway</div>
          </div>
        </Link>
        <button type="button" className="search-trigger" onClick={() => setCmdk(true)}>
          <Icons.search />
          Search or jump to…
          <Kbd>{isMac ? '⌘K' : 'Ctrl K'}</Kbd>
        </button>

        <nav className="nav" aria-label="Main">
          <Item to="/" end icon={<Icons.home />}>Overview</Item>
          <Item to="/chat" icon={<Icons.chat />}>Chat</Item>

          <div className="nav-label">Gateway</div>
          <Item to="/servers" icon={<Icons.servers />} count={serversCount}>Servers</Item>
          {me.storesEnabled && <Item to="/stores" icon={<Icons.store />}>Stores</Item>}
          <Item to="/audit" icon={<Icons.audit />}>Audit log</Item>

          <div className="nav-label">Access</div>
          <Item to="/keys" icon={<Icons.key />}>API keys</Item>
          <Item to="/apps" icon={<Icons.apps />}>Connected apps</Item>

          {isAdmin && (
            <>
              <div className="nav-label">Team</div>
              <Item to="/members" icon={<Icons.users />}>Members</Item>
              <Item to="/permissions" icon={<Icons.lock />}>Permissions</Item>
            </>
          )}
        </nav>

        <div className="sidebar-foot">
          <UserMenu />
        </div>
      </aside>
      {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} />}

      <main className="main" id="main">
        <Outlet />
      </main>
      {cmdk && <CommandMenu servers={list} onClose={() => setCmdk(false)} />}
    </div>
  );
}

function Item({ to, end, icon, count, children }: { to: string; end?: boolean; icon: ReactNode; count?: { n: number; tone: string; title: string }; children: ReactNode }) {
  return (
    <NavLink to={to} end={end}>
      {icon}
      {children}
      {count && <span className={`nav-count ${count.tone}`} title={count.title}>{count.n}</span>}
    </NavLink>
  );
}

function UserMenu() {
  const { me } = useUser();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [theme, setTheme] = useTheme();

  const logout = async () => {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    sessionStorage.clear();
    qc.clear();
    nav('/login');
  };

  return (
    <Menu
      label="Account menu"
      placement="top"
      align="start"
      triggerClassName="user-btn"
      trigger={
        <>
          <Avatar name={me.user.name} />
          <span className="who">
            <span className="name truncate">{me.user.name}</span>
            <span className="role">{me.user.role === 'admin' ? 'Admin' : 'Member'}</span>
          </span>
          <Icons.upDown />
        </>
      }
      items={[
        { heading: me.user.email },
        { label: 'Account settings', icon: <Icons.user />, onSelect: () => nav('/account') },
        { separator: true },
        { node: <ThemePicker theme={theme} onChange={setTheme} /> },
        { separator: true },
        { label: 'Sign out', icon: <Icons.logout />, onSelect: () => void logout() },
      ]}
    />
  );
}

export function ThemePicker({ theme, onChange }: { theme: Theme; onChange: (t: Theme) => void }) {
  return (
    <div className="row-nowrap">
      <span className="small muted">Theme</span>
      <div className="spacer" />
      <Segmented
        size="sm"
        value={theme}
        onChange={onChange}
        options={[
          { value: 'system', label: <Icons.monitor />, title: 'Match system' },
          { value: 'light', label: <Icons.sun />, title: 'Light' },
          { value: 'dark', label: <Icons.moon />, title: 'Dark' },
        ]}
      />
    </div>
  );
}

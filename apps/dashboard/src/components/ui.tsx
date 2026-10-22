import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router';
import { ago, fullTime, initials } from '../format';
import { Icons } from '../icons';
import type { ServerStatus, ToolState } from '../types';

export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'accent';

// ---------------------------------------------------------------- buttons

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'danger' | 'ghost' | 'danger-solid';
  size?: 'sm' | 'lg';
  loading?: boolean;
  icon?: ReactNode;
};
export function Button({ variant, size, loading, icon, children, className, ...rest }: ButtonProps) {
  const iconOnly = !children && !!icon;
  const cls = ['btn', variant, size, iconOnly && 'icon', className].filter(Boolean).join(' ');
  return (
    <button type="button" {...rest} className={cls} disabled={rest.disabled || loading} aria-busy={loading || undefined}>
      {loading ? <span className="spinner" /> : icon}
      {children}
    </button>
  );
}

/** A react-router link styled as a button. */
export function LinkButton({ to, variant, size, icon, children }: { to: string; variant?: 'primary' | 'ghost'; size?: 'sm'; icon?: ReactNode; children: ReactNode }) {
  return (
    <Link to={to} className={['btn', variant, size].filter(Boolean).join(' ')}>
      {icon}
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------- badges and status

export function Badge({ tone, children, title, dot, pulse, icon }: { tone?: Tone; children: ReactNode; title?: string; dot?: boolean; pulse?: boolean; icon?: ReactNode }) {
  return (
    <span className={`badge ${tone ?? ''}`} title={title}>
      {dot && <span className={`dot ${tone ?? ''} ${pulse ? 'pulse' : ''}`} />}
      {icon}
      {children}
    </span>
  );
}

/** Dot + label: the default way to show a state in tables (quieter than a filled badge). */
export function Status({ tone, pulse, children, reason, title }: { tone?: 'ok' | 'warn' | 'err' | 'info'; pulse?: boolean; children: ReactNode; reason?: ReactNode; title?: string }) {
  return (
    <span className="status" title={title}>
      <span className={`dot ${tone ?? ''} ${pulse ? 'pulse' : ''}`} />
      {children}
      {reason && <span className="reason">{reason}</span>}
    </span>
  );
}

const SERVER_STATUS: Record<ServerStatus, { tone?: 'ok' | 'warn' | 'err'; label: string }> = {
  connected: { tone: 'ok', label: 'Connected' },
  pending: { tone: 'warn', label: 'Connecting' },
  unreachable: { tone: 'err', label: 'Unreachable' },
  disabled: { label: 'Disabled' },
};
export function StatusBadge({ status, reason }: { status: ServerStatus; reason?: string | null }) {
  const s = SERVER_STATUS[status] ?? { label: status };
  return (
    <Status tone={s.tone} pulse={status === 'pending'} title={reason ?? undefined}>
      {s.label}
    </Status>
  );
}

const TOOL_STATE: Record<ToolState, { tone?: 'ok' | 'warn' | 'err'; label: string }> = {
  active: { tone: 'ok', label: 'Active' },
  pending_new: { tone: 'warn', label: 'Needs review' },
  pending_changed: { tone: 'err', label: 'Changed' },
  disabled: { label: 'Disabled' },
  gone: { label: 'Removed upstream' },
};
export const ToolStateBadge = ({ state }: { state: ToolState }) => <Status tone={TOOL_STATE[state].tone}>{TOOL_STATE[state].label}</Status>;

export const AccessBadge = ({ access }: { access: 'read' | 'write' }) =>
  access === 'read' ? <Badge icon={<Icons.eye />}>Read</Badge> : <Badge tone="accent" icon={<Icons.edit />}>Write</Badge>;

export function Time({ iso }: { iso: string | null | undefined }) {
  return <span title={fullTime(iso)} className="nowrap tabular">{ago(iso)}</span>;
}

export function Avatar({ name, size }: { name: string; size?: 'sm' | 'lg' }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return <span className={`avatar c${h % 8} ${size ?? ''}`} aria-hidden="true">{initials(name)}</span>;
}

export const Kbd = ({ children }: { children: ReactNode }) => <kbd>{children}</kbd>;

// ---------------------------------------------------------------- form controls

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <span className="switch" title={label}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </span>
  );
}

export function Field({ label, hint, error, optional, children }: { label: string; hint?: ReactNode; error?: string; optional?: boolean; children: ReactNode }) {
  return (
    <div className="field">
      <label>
        {label}
        {optional && <span className="optional"> (optional)</span>}
      </label>
      {children}
      {error ? <span className="error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder, size }: { value: string; onChange: (v: string) => void; placeholder: string; size?: 'sm' }) {
  return (
    <div className={`search ${size ?? ''}`}>
      <Icons.search />
      <input className={`input ${size ?? ''}`} type="search" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} aria-label={placeholder} />
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, size }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; size?: 'sm' }) {
  return (
    <div className={`seg ${size ?? ''}`} role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" className={o.value === value ? 'on' : ''} role="radio" aria-checked={o.value === value} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs, className }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; count?: number; tone?: 'warn' }[]; className?: string }) {
  return (
    <div className={`tabs ${className ?? ''}`} role="tablist">
      {tabs.map((t) => (
        <button key={t.value} type="button" role="tab" aria-selected={t.value === value} className={t.value === value ? 'on' : ''} onClick={() => onChange(t.value)}>
          {t.label}
          {t.count !== undefined && <span className={`tab-count ${t.tone ?? ''}`}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- layout pieces

export function Card({ title, subtitle, actions, children, pad = true, footer, className }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; pad?: boolean; footer?: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || actions) && (
        <div className="card-head">
          <div className="titles">
            {title && <h2>{title}</h2>}
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions}
        </div>
      )}
      {pad ? <div className="card-body">{children}</div> : children}
      {footer && <div className="card-foot">{footer}</div>}
    </section>
  );
}

export function PageHead({ title, badge, desc, actions, crumbs }: { title: ReactNode; badge?: ReactNode; desc?: ReactNode; actions?: ReactNode; crumbs?: { to: string; label: string } }) {
  return (
    <header className="page-head">
      <div className="titles">
        {crumbs && (
          <nav className="crumbs" aria-label="Breadcrumb">
            <Link to={crumbs.to}><Icons.chevronLeft />{crumbs.label}</Link>
          </nav>
        )}
        {badge ? <div className="title-row"><h1>{title}</h1>{badge}</div> : <h1>{title}</h1>}
        {desc && <p>{desc}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}

export const Loading = ({ label = 'Loading…' }: { label?: string }) => (
  <div className="loading" role="status">
    <span className="spinner" /> {label}
  </div>
);

/** Placeholder rows shaped like a table while data loads. */
export const SkeletonRows = ({ rows = 4 }: { rows?: number }) => (
  <div className="skel-rows" role="status" aria-label="Loading">
    {Array.from({ length: rows }, (_, i) => (
      <div key={i} className="skel-row"><span className="skel" /><span className="skel" /><span className="skel" /><span className="skel" /></div>
    ))}
  </div>
);

export const Empty = ({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) => (
  <div className="empty">
    {icon && <div className="empty-icon">{icon}</div>}
    <h3>{title}</h3>
    {children && <p>{children}</p>}
    {action && <div className="empty-actions">{action}</div>}
  </div>
);

const CALLOUT_ICON = { info: Icons.info, warn: Icons.alert, err: Icons.alertCircle, ok: Icons.checkCircle };
export function Callout({ tone = 'info', title, children, action }: { tone?: 'info' | 'warn' | 'err' | 'ok'; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const Icon = CALLOUT_ICON[tone];
  return (
    <div className={`callout ${tone}`} role={tone === 'err' ? 'alert' : undefined}>
      <Icon />
      <div className="callout-body">
        {title && <div className="callout-title">{title}</div>}
        {children}
      </div>
      {action && <div className="callout-action">{action}</div>}
    </div>
  );
}

export const ErrorBox = ({ error }: { error: unknown }) => (error ? <Callout tone="err">{error instanceof Error ? error.message : String(error)}</Callout> : null);

// ---------------------------------------------------------------- overlays

export function Modal({ title, desc, onClose, children, footer, size }: { title: ReactNode; desc?: ReactNode; onClose: () => void; children?: ReactNode; footer?: ReactNode; size?: 'sm' | 'wide' }) {
  useEscape(onClose);
  // Portalled to <body> so no transformed or z-indexed ancestor can trap the fixed overlay.
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${size ?? ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className="titles">
            <h2>{title}</h2>
            {desc && <p>{desc}</p>}
          </div>
          <Button variant="ghost" size="sm" icon={<Icons.x />} onClick={onClose} aria-label="Close" />
        </div>
        {children && <div className="modal-body">{children}</div>}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ title, onClose, children, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEscape(onClose);
  return createPortal(
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className="titles"><h2 className="truncate">{title}</h2></div>
          <Button variant="ghost" size="sm" icon={<Icons.x />} onClick={onClose} aria-label="Close" />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </aside>
    </>,
    document.body,
  );
}

function useEscape(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && ref.current();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
}

/** A modal flag kept in the URL (?new=1), so pages and the command menu can open "Add …" dialogs by link. */
export function useParamFlag(name: string): [boolean, (on: boolean) => void] {
  const [params, setParams] = useSearchParams();
  const set = useCallback(
    (on: boolean) =>
      setParams(
        (p) => {
          const n = new URLSearchParams(p);
          if (on) n.set(name, '1');
          else n.delete(name);
          return n;
        },
        { replace: true },
      ),
    [name, setParams],
  );
  return [params.has(name), set];
}

// ---------------------------------------------------------------- dropdown menu

export type MenuItem =
  | { label: ReactNode; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean }
  | { separator: true }
  | { heading: ReactNode }
  | { node: ReactNode };

/** A small dropdown. Rendered in a portal with fixed positioning so table scroll containers can't clip it. */
export function Menu({ items, label, trigger, triggerClassName = 'btn ghost sm icon', align = 'end', placement = 'bottom' }: {
  items: MenuItem[];
  label: string;
  trigger?: ReactNode;
  triggerClassName?: string;
  align?: 'start' | 'end';
  placement?: 'bottom' | 'top';
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left?: number; right?: number; minWidth?: number }>({});

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    setPos({
      ...(placement === 'bottom' ? { top: r.bottom + 6 } : { bottom: window.innerHeight - r.top + 6 }),
      ...(align === 'end' ? { right: window.innerWidth - r.right } : { left: r.left }),
      minWidth: placement === 'top' ? r.width : undefined,
    });
  }, [open, align, placement]);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('.menu-item:not(:disabled)')?.focus();
    const close = (e: Event) => {
      if (menu.current?.contains(e.target as Node) || btn.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btn.current?.focus();
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const all = [...(menu.current?.querySelectorAll<HTMLButtonElement>('.menu-item:not(:disabled)') ?? [])];
        const i = all.indexOf(document.activeElement as HTMLButtonElement);
        all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
      }
    };
    const dismiss = () => setOpen(false);
    // Close when the trigger moves (its page or a container around it scrolls), not on unrelated scrolling.
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && btn.current && (t === document || t.contains(btn.current))) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  return (
    <>
      <button ref={btn} type="button" className={triggerClassName} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {trigger ?? <Icons.more />}
      </button>
      {open &&
        createPortal(
          <div ref={menu} className="menu" role="menu" style={pos}>
            {items.map((it, i) =>
              'separator' in it ? <div key={i} className="menu-sep" /> :
              'heading' in it ? <div key={i} className="menu-heading">{it.heading}</div> :
              'node' in it ? <div key={i} className="menu-node">{it.node}</div> : (
                <button
                  key={i}
                  type="button"
                  role="menuitem"
                  className={`menu-item ${it.danger ? 'danger' : ''}`}
                  disabled={it.disabled}
                  onClick={() => {
                    setOpen(false);
                    it.onSelect();
                  }}
                >
                  {it.icon}
                  {it.label}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

// ---------------------------------------------------------------- copy

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // The Clipboard API needs a secure context (plain-http deployments); fall back to a hidden textarea.
    const t = document.createElement('textarea');
    t.value = text;
    document.body.appendChild(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
}

export function CopyButton({ text, label, size = 'sm', variant = 'ghost' }: { text: string; label?: string; size?: 'sm'; variant?: 'ghost' | 'primary' }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size={size}
      variant={variant}
      className="copy"
      aria-label={label ?? 'Copy'}
      title={label ?? 'Copy'}
      icon={done ? <Icons.check /> : <Icons.copy />}
      onClick={async () => {
        await copyText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {label && (done ? 'Copied' : label)}
    </Button>
  );
}

export const Code = ({ children, className }: { children: string; className?: string }) => (
  <pre className={`code ${className ?? ''}`}>
    {children}
    <CopyButton text={children} />
  </pre>
);

/** A single-line value (a URL, a key prefix) with a copy button. */
export const CopyField = ({ value }: { value: string }) => (
  <div className="copy-row">
    <span className="value" title={value}>{value}</span>
    <CopyButton text={value} label="Copy" />
  </div>
);

// ---------------------------------------------------------------- toasts

type Toast = { id: number; text: string; err?: boolean };
const ToastCtx = createContext<(text: string, err?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, err?: boolean) => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, text, err }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), err ? 6000 : 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-host" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.err ? 'err' : ''}`}>
            {t.err ? <Icons.alertCircle /> : <Icons.checkCircle />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------------------------------------------------------------- confirm dialog

type ConfirmOpts = { title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean };
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);
/** `if (await confirm({ title, body, danger: true })) …`: an in-app dialog instead of window.confirm. */
export const useConfirm = () => useContext(ConfirmCtx);
export function ConfirmHost({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setReq({ ...o, resolve })), []);
  const close = (v: boolean) => {
    req?.resolve(v);
    setReq(null);
  };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {req && (
        <Modal
          size="sm"
          title={req.title}
          onClose={() => close(false)}
          footer={<>
            <Button onClick={() => close(false)}>Cancel</Button>
            <Button variant={req.danger ? 'danger-solid' : 'primary'} autoFocus onClick={() => close(true)}>{req.confirmLabel ?? 'Confirm'}</Button>
          </>}
        >
          {req.body && <div className="confirm-body">{req.body}</div>}
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}

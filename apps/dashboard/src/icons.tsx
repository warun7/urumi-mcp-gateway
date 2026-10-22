// Inline stroke icons (24-unit grid, 1.5px stroke, drawn at 16px) so the dashboard needs no icon library.
type IconProps = { className?: string };
const P = (d: string, sw = 1.5) =>
  function Icon({ className }: IconProps) {
    return (
      <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={d} />
      </svg>
    );
  };

export const Icons = {
  home: P('M4 4h7v9H4zM13 4h7v5h-7zM13 11h7v9h-7zM4 15h7v5H4z'),
  servers: P('M4 4.5h16v6H4zM4 13.5h16v6H4zM7.5 7.5h.01M7.5 16.5h.01'),
  chat: P('M20.5 12a8.5 8.5 0 0 1-12.3 7.6L3.5 20.5l1-4.4A8.5 8.5 0 1 1 20.5 12z'),
  key: P('M14.5 9.5a5 5 0 1 0-4.6 3.1L4 18.5V21h3v-2h2v-2h2l1.5-1.5M15.5 7.5h.01'),
  apps: P('M10 14a3.5 3.5 0 0 0 5 0l3.5-3.5a3.5 3.5 0 0 0-5-5L13 6M14 10a3.5 3.5 0 0 0-5 0l-3.5 3.5a3.5 3.5 0 0 0 5 5L11 18'),
  audit: P('M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01', 1.75),
  users: P('M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM21 20v-1a4 4 0 0 0-3-3.9M16 4.1a3.5 3.5 0 0 1 0 6.8'),
  lock: P('M5.5 11h13v9.5h-13zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11'),
  store: P('M3.5 9 5.5 4h13l2 5M3.5 9v11h17V9M3.5 9h17M9.5 20v-6h5v6'),
  user: P('M19 20.5v-1a4.5 4.5 0 0 0-4.5-4.5h-5A4.5 4.5 0 0 0 5 19.5v1M12 11.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'),
  logout: P('M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10'),
  menu: P('M4 7h16M4 12h16M4 17h16'),
  search: P('M10.5 17.5a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4.5-4.5'),
  plus: P('M12 5v14M5 12h14', 1.75),
  chevronRight: P('M9.5 6l6 6-6 6'),
  chevronDown: P('M6 9.5l6 6 6-6'),
  chevronLeft: P('M14.5 6l-6 6 6 6'),
  upDown: P('M8 9l4-4 4 4M8 15l4 4 4-4'),
  more: P('M5 12h.01M12 12h.01M19 12h.01', 2.75),
  copy: P('M9 9h11v11H9zM5 15H4V4h11v1'),
  check: P('M5 12.5l4.5 4.5L19 7', 2),
  x: P('M6 6l12 12M18 6 6 18'),
  external: P('M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'),
  refresh: P('M20 11a8 8 0 0 0-14.9-3M4.5 4v4h4M4 13a8 8 0 0 0 14.9 3M19.5 20v-4h-4'),
  alert: P('M12 3.5 2.5 20h19zM12 10v4M12 17h.01'),
  alertCircle: P('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5v5M12 16h.01'),
  info: P('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 7.5h.01'),
  checkCircle: P('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 12.5l2.5 2.5 4.5-5'),
  sun: P('M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2.5v2M12 19.5v2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M2.5 12h2M19.5 12h2M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4'),
  moon: P('M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z'),
  monitor: P('M3 4.5h18v12H3zM8 20.5h8M12 16.5v4'),
  send: P('M12 19V5M6 11l6-6 6 6', 2),
  stop: P('M7 7h10v10H7z', 2),
  bolt: P('M13 3 5 14h6l-1 7 8-11h-6z'),
  cube: P('M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12 4 7.5'),
  activity: P('M3 12h4l3-8 4 16 3-8h4'),
  plug: P('M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 0 1-11 0zM12 16.5V21'),
  trash: P('M4 7h16M9.5 7V4h5v3M6 7l1 13h10l1-13M10 11v5M14 11v5'),
  edit: P('M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4'),
  power: P('M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0'),
  eye: P('M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'),
  arrowRight: P('M5 12h14M13 6l6 6-6 6'),
  download: P('M12 4v11M7 10l5 5 5-5M5 20h14'),
  globe: P('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18'),
  terminal: P('M4 5h16v14H4zM8 10l2.5 2L8 14M13 14h3'),
  clock: P('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2'),
  mail: P('M3.5 5.5h17v13h-17zM4 6l8 7 8-7'),
  pause: P('M8 5v14M16 5v14', 2),
  play: P('M7 5l12 7-12 7z'),
  link: P('M10 14a3.5 3.5 0 0 0 5 0l3.5-3.5a3.5 3.5 0 0 0-5-5L13 6M14 10a3.5 3.5 0 0 0-5 0l-3.5 3.5a3.5 3.5 0 0 0 5 5L11 18'),
};

/** The Urumi mark: drawn with the theme's primary colours so it works on light and dark. */
export function Logo({ className = 'logo' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" />
      <path d="M10 9.5v7.5a6 6 0 0 0 12 0V9.5" fill="none" strokeWidth="3" strokeLinecap="round" />
      <circle cx="16" cy="17" r="2.2" />
    </svg>
  );
}

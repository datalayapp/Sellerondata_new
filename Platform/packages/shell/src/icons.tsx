import type { CSSProperties } from 'react';

const S = 'fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"';

// Static SVG fragments ported from the prototype icon set (_reference/prototype/core.js).
const ICONS = {
  chev: `<path ${S} d="M4 6l4 4 4-4"/>`,
  chevr: `<path ${S} d="M6 4l4 4-4 4"/>`,
  chevl: `<path ${S} d="M10 4L6 8l4 4"/>`,
  search: `<g ${S}><circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4L14 14"/></g>`,
  upload: `<g ${S}><path d="M8 11V2.8M4.8 6L8 2.8 11.2 6M2.8 13.5h10.4"/></g>`,
  download: `<g ${S}><path d="M8 2.8V11M4.8 7.8L8 11l3.2-3.2M2.8 13.5h10.4"/></g>`,
  arrow: `<g ${S}><path d="M2.5 8h11M9.5 4l4 4-4 4"/></g>`,
  back: `<g ${S}><path d="M13.5 8h-11M6.5 4l-4 4 4 4"/></g>`,
  plus: `<g ${S}><path d="M8 2.5v11M2.5 8h11"/></g>`,
  check: `<g ${S} stroke-width="1.5"><path d="M3.5 8.5l3 3 6-7"/></g>`,
  close: `<g ${S} stroke-width="1.4"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></g>`,
  warn: `<path d="M8 1.4L15 14.2H1z" fill="#f79009" stroke="#f79009" stroke-width="1.2" stroke-linejoin="round"/><path d="M8 5.8v4" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="12" r=".9" fill="#fff"/>`,
  info: `<circle cx="8" cy="8" r="7" fill="#1d5bd8"/><path d="M8 7.2v4.3" stroke="#fff" stroke-width="1.6"/><circle cx="8" cy="4.9" r=".95" fill="#fff"/>`,
  err: `<circle cx="8" cy="8" r="7" fill="#c4271b"/><path d="M8 4.3v4.6" stroke="#fff" stroke-width="1.6"/><circle cx="8" cy="11.3" r=".95" fill="#fff"/>`,
  ok: `<circle cx="8" cy="8" r="7" fill="#079455"/><path d="M4.8 8.2l2.2 2.2 4.2-4.6" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  camera: `<g ${S}><path d="M2 5h2.8l1.2-1.8h4l1.2 1.8H14v8H2z"/><circle cx="8" cy="8.8" r="2.4"/></g>`,
  ruler: `<g ${S}><rect x="1.5" y="5" width="13" height="6"/><path d="M4 5v2.5M6.5 5v1.6M9 5v2.5M11.5 5v1.6"/></g>`,
  scale: `<g ${S}><rect x="2" y="7" width="12" height="7"/><path d="M5.5 7V4.5h5V7"/><path d="M8 10.5l1.4-1.6"/></g>`,
  copy: `<g ${S}><rect x="5.5" y="5.5" width="8" height="8"/><path d="M3.5 10.5h-1v-8h8v1"/></g>`,
  doc: `<g ${S}><path d="M3.5 1.8h5.6l3.4 3.4v9H3.5z"/><path d="M9 1.8v3.5h3.5M5.6 8.5h4.8M5.6 11h4.8"/></g>`,
  box: `<g ${S}><path d="M8 1.8l5.8 2.9v6.6L8 14.2 2.2 11.3V4.7z"/><path d="M2.2 4.7L8 7.6l5.8-2.9M8 7.6v6.6"/></g>`,
  truck: `<g ${S}><path d="M1.5 4h8v7h-8zM9.5 6.5h3l2 2.2V11h-5"/><circle cx="4.5" cy="12" r="1.3"/><circle cx="11.5" cy="12" r="1.3"/></g>`,
  spin: `<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="1.8"/><path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
  edit: `<g ${S}><path d="M10.5 2.5l3 3-8 8h-3v-3z"/></g>`,
  calendar: `<g ${S}><rect x="2" y="3" width="12" height="11"/><path d="M2 6.5h12M5 1.8v2.5M11 1.8v2.5"/></g>`,
  table: `<g ${S}><rect x="2" y="2.5" width="12" height="11"/><path d="M2 6h12M2 9.5h12M6.5 6v7.5"/></g>`,
  eye: `<g ${S}><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></g>`,
  spark: `<g ${S}><path d="M7 1.8l1.2 3.4 3.4 1.2-3.4 1.2L7 11 5.8 7.6 2.4 6.4l3.4-1.2z"/><path d="M12.2 9.6l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z"/></g>`,
  refresh: `<g ${S}><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.8h-2.8"/></g>`,
  lock: `<g ${S}><rect x="3" y="7" width="10" height="7.5"/><path d="M5.2 7V5a2.8 2.8 0 0 1 5.6 0v2"/></g>`,
  flag: `<g ${S}><path d="M3.5 14.5v-12M3.5 2.8h8.5l-1.8 3 1.8 3H3.5"/></g>`,
  filter: `<g ${S}><path d="M2 3h12L9.5 8.5V13l-3 1.5v-6z"/></g>`,
  settings: `<g ${S}><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/></g>`,
  user: `<g ${S}><circle cx="8" cy="5.5" r="2.8"/><path d="M2.5 14c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5"/></g>`,
  trash: `<g ${S}><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 10h6.6L12 4"/></g>`,
  logout: `<g ${S}><path d="M6 2.5H2.5v11H6M10 5l3 3-3 3M13 8H6"/></g>`,
  key: `<g ${S}><circle cx="5" cy="10.5" r="2.8"/><path d="M7 8.5l6.5-6.5M11 4.5l1.8 1.8M9.5 6l1.3 1.3"/></g>`,
  up: `<g ${S}><path d="M4 10l4-4 4 4"/></g>`,
  down: `<g ${S}><path d="M4 6l4 4 4-4"/></g>`,
  calc: `<g ${S}><rect x="3" y="1.8" width="10" height="12.4"/><path d="M5.2 4.3h5.6M5.5 7.3h.1M8 7.3h.1M10.5 7.3h.1M5.5 9.8h.1M8 9.8h.1M10.5 9.8h.1M5.5 12.2h.1M8 12.2h.1M10.5 12.2h.1"/></g>`,
  share: `<g ${S}><circle cx="12" cy="3.6" r="1.8"/><circle cx="4" cy="8" r="1.8"/><circle cx="12" cy="12.4" r="1.8"/><path d="M5.6 7.1l4.8-2.6M5.6 8.9l4.8 2.6"/></g>`,
  mail: `<g ${S}><rect x="1.8" y="3.5" width="12.4" height="9"/><path d="M2 4l6 5 6-5"/></g>`,
  home: `<g ${S}><path d="M2.2 7.2L8 2.4l5.8 4.8"/><path d="M3.6 6.2v7.6h3.2V10h2.4v3.8h3.2V6.2"/></g>`,
  users: `<g ${S}><circle cx="6" cy="5.6" r="2.4"/><path d="M1.6 13.6c.5-2.6 2.3-3.9 4.4-3.9s3.9 1.3 4.4 3.9"/><path d="M10.4 3.4a2.3 2.3 0 0 1 0 4.4M12 9.9c1.3.4 2.2 1.6 2.4 3.7"/></g>`,
  menu: `<g ${S} stroke-width="1.4"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></g>`,
  gear: `<g ${S}><circle cx="8" cy="8" r="2.1"/><path d="M8 1.6l1.1 1.6 1.9-.4.4 1.9 1.6 1.1-.9 1.7.9 1.7-1.6 1.1-.4 1.9-1.9-.4L8 14.4l-1.1-1.6-1.9.4-.4-1.9-1.6-1.1.9-1.7-.9-1.7 1.6-1.1.4-1.9 1.9.4z"/></g>`,
  eyeoff: `<g ${S}><path d="M6.2 3.8A6.6 6.6 0 0 1 8 3.5c4.1 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.7 2.3M4.3 4.9C2.5 6.1 1.5 8 1.5 8S3.9 12.5 8 12.5c1 0 1.9-.3 2.7-.7"/><path d="M6.6 6.6a2 2 0 0 0 2.8 2.8M2 2l12 12"/></g>`,
  shield: `<g ${S}><path d="M8 1.8l5 1.9v4c0 3.2-2.2 5.4-5 6.5-2.8-1.1-5-3.3-5-6.5v-4z"/><path d="M5.6 8l1.7 1.7 3.1-3.3"/></g>`,
  clipboard: `<g ${S}><path d="M5.5 2.5h5v2h-5zM5.5 3.5h-2v10h9v-10h-2"/></g>`,
  building: `<g ${S}><path d="M3 14.2V2.2h6.5v12M9.5 6.5H13v7.7M1.8 14.2h12.4M5.2 5h2M5.2 7.6h2M5.2 10.2h2M11 9h.4M11 11.4h.4"/></g>`,
  chart: `<g ${S}><path d="M2 13.8h12.4M2 2.2v11.6"/><path d="M4.4 10.6l2.8-3.2 2.4 1.9 3.6-4.7"/></g>`,
  pulse: `<g ${S}><path d="M1.5 8.5h3l1.7-4.2 3 7.4 1.8-3.2h3.5"/></g>`,
  card: `<g ${S}><rect x="1.8" y="3.2" width="12.4" height="9.6" rx="1"/><path d="M1.8 6.4h12.4M4 10.2h2.6"/></g>`,
  phone: `<g ${S}><rect x="4.4" y="1.6" width="7.2" height="12.8" rx="1.2"/><path d="M7.2 12.4h1.6"/></g>`,
  laptop: `<g ${S}><rect x="3" y="3.6" width="10" height="7" rx=".8"/><path d="M1.5 12.6h13"/></g>`,
  help: `<g ${S}><circle cx="8" cy="8" r="6.4"/><path d="M6.2 6.3a1.8 1.8 0 1 1 2.6 1.6c-.5.3-.8.6-.8 1.2v.3M8 11.4h.01"/></g>`,
  globe: `<g ${S}><circle cx="8" cy="8" r="6.4"/><path d="M1.6 8h12.8M8 1.6c1.9 1.8 2.8 4 2.8 6.4S9.9 12.6 8 14.4C6.1 12.6 5.2 10.4 5.2 8S6.1 3.4 8 1.6z"/></g>`,
  external: `<g ${S}><path d="M6.6 3H3v10h10V9.4M9 2.8h4.2V7M13 3L7.6 8.4"/></g>`,
  dots: `<g fill="currentColor"><circle cx="3.2" cy="8" r="1.15"/><circle cx="8" cy="8" r="1.15"/><circle cx="12.8" cy="8" r="1.15"/></g>`,
  /** DeciShip panelinin "⋯" çizimi (noktalar daha sık, biraz iri). `dots` ile birleştirmek fark kataloğunda. */
  dotsnarrow: `<g fill="currentColor"><circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/></g>`,
  pause: `<g ${S}><path d="M5.4 3.4v9.2M10.6 3.4v9.2"/></g>`,
  play: `<g ${S}><path d="M5 3.2l7.6 4.8L5 12.8z"/></g>`,
  clock: `<g ${S}><circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.4 1.6"/></g>`,
  arrowup: `<g ${S} stroke-width="1.5"><path d="M8 13V3.4M4 7.2l4-4 4 4"/></g>`,
  arrowdown: `<g ${S} stroke-width="1.5"><path d="M8 3v9.6M4 8.8l4 4 4-4"/></g>`,
  minus: `<g ${S} stroke-width="1.5"><path d="M3.5 8h9"/></g>`,
  apps: `<g ${S}><path d="M2.6 2.6h4v4h-4zM9.4 2.6h4v4h-4zM2.6 9.4h4v4h-4zM9.4 9.4h4v4h-4z"/></g>`,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16, className, style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  return (
    <svg
      className={`i${className ? ` ${className}` : ''}`}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      style={{ width: size, height: size, ...style }}
      aria-hidden="true"
      focusable="false"
      data-i={name}
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}

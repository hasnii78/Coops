/** Minimal line icons for the bottom nav and headers. */
const base = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

export const IconCloset = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M12 3v18M9.5 11h.01M14.5 11h.01" /></svg>
);
export const IconCombos = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}><path d="M4 7h16M4 12h16M4 17h10" /></svg>
);
export const IconMe = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}><circle cx="12" cy="8" r="4" /><path d="M5 21c0-3.9 3.1-7 7-7s7 3.1 7 7" /></svg>
);
export const IconSaved = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" /></svg>
);
export const IconInbox = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5.4A8 8 0 1 1 21 12z" /></svg>
);
export const IconProfile = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="10" r="3" /><path d="M6.5 18.5a6.5 6.5 0 0 1 11 0" /></svg>
);
export const IconSearch = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
);
export const IconPlus = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}><path d="M12 5v14M5 12h14" /></svg>
);
export const IconHeart = ({ filled, ...p }) => (
  <svg viewBox="0 0 24 24" {...base} fill={filled ? 'currentColor' : 'none'} {...p}>
    <path d="M12 20s-7-4.5-7-9.5A4 4 0 0 1 12 8a4 4 0 0 1 7 2.5C19 15.5 12 20 12 20z" />
  </svg>
);
export const IconPin = ({ filled, ...p }) => (
  <svg viewBox="0 0 24 24" {...base} fill={filled ? 'currentColor' : 'none'} {...p}>
    <path d="M9 3h6l-1 6 4 3v2H6v-2l4-3z" /><path d="M12 14v7" />
  </svg>
);
export const IconSend = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}><path d="M4 12h14M13 6l6 6-6 6" /></svg>
);

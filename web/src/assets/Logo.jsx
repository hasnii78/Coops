/**
 * Inline version of the Pink Wardrobe mark, so it can inherit theme colours
 * where needed and render without a network request.
 */
export default function Logo({ size = 32, title = 'Pink Wardrobe' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" role="img" aria-label={title}>
      <defs>
        <linearGradient id="pwHairInline" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#F6D98A" />
          <stop offset="100%" stopColor="#D9A94B" />
        </linearGradient>
        <linearGradient id="pwDressInline" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#D9342A" />
          <stop offset="100%" stopColor="#A81E1E" />
        </linearGradient>
        <clipPath id="pwClipInline"><circle cx="128" cy="128" r="128" /></clipPath>
      </defs>
      <g clipPath="url(#pwClipInline)">
        <rect width="256" height="256" fill="#F4C0D1" />
        <circle cx="128" cy="132" r="92" fill="#FBEAF0" opacity="0.65" />
        <path d="M112 196c-1 20-2 34-3 46h17l3-46z" fill="#E8B99A" />
        <path d="M144 196c1 20 2 34 3 46h-17l-3-46z" fill="#E8B99A" />
        <path
          d="M128 74c-16 0-27 8-29 20-3 20-6 40-13 66-2 8 4 14 12 14h60c8 0 14-6 12-14-7-26-10-46-13-66-2-12-13-20-29-20z"
          fill="url(#pwDressInline)"
        />
        <path d="M103 128h50" stroke="#8B1A1A" strokeWidth="3" strokeLinecap="round" opacity="0.45" />
        <path d="M99 96c-6 14-8 30-7 44" stroke="#E8B99A" strokeWidth="11" strokeLinecap="round" fill="none" />
        <path d="M157 96c6 14 8 30 7 44" stroke="#E8B99A" strokeWidth="11" strokeLinecap="round" fill="none" />
        <rect x="119" y="62" width="18" height="20" rx="9" fill="#E8B99A" />
        <circle cx="128" cy="52" r="27" fill="#E8B99A" />
        <path
          d="M128 22c-19 0-31 13-31 31 0 14 2 26 5 39 2 8 9 12 16 12h20c7 0 14-4 16-12 3-13 5-25 5-39 0-18-12-31-31-31z"
          fill="url(#pwHairInline)"
        />
        <path d="M108 40c6-8 34-8 40 0-4-10-12-16-20-16s-16 6-20 16z" fill="#FBEAF0" opacity="0.35" />
      </g>
    </svg>
  );
}

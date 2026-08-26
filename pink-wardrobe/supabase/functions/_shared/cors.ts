// Shared CORS handling.
//
// The app runs from its own origin in a browser and from a Capacitor WebView
// inside the APK, so several origins are legitimate.

const ALLOWED_ORIGINS = [
  'http://localhost:5173',   // vite dev
  'http://localhost:4173',   // vite preview
  'https://localhost',       // Capacitor Android with androidScheme: https
  'capacitor://localhost',   // Capacitor iOS / legacy scheme
  'http://localhost',
];

export function corsHeaders(origin: string | null): Record<string, string> {
  const allowed =
    origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    // Worth logging: a blocked preflight looks identical to a broken function
    // from the client side, and this is the line that tells them apart.
    console.warn(`Request from unlisted origin: ${origin}`);
  }

  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type, x-purge-secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/**
 * Reply to a CORS preflight.
 *
 * Must be 204 with NO body: 204 is a null-body status, and the Response
 * constructor throws a TypeError if given content alongside it. Doing that
 * crashes the preflight, which the browser reports only as a failed request —
 * the caller sees "non-2xx status code" with no clue that CORS was the cause.
 */
export function preflight(origin: string | null): Response {
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export function json(
  body: unknown,
  status: number,
  origin: string | null,
): Response {
  if (status === 204 || status === 205 || status === 304) {
    // Guard the same trap for any other caller.
    return new Response(null, { status, headers: corsHeaders(origin) });
  }

  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });
}

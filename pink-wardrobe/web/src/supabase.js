import { createClient } from '@supabase/supabase-js';

/**
 * The anon key is the ONLY key that belongs in this bundle. It is safe to ship
 * — Row Level Security is what protects the data, not the secrecy of this key.
 *
 * The service role key and the FASHN key are server-side only and must never
 * appear in any file under src/.
 */
const rawUrl = (import.meta.env.VITE_SUPABASE_URL ?? '').trim();
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim();

/**
 * Configuration problems are reported, never thrown.
 *
 * Throwing here runs at module load, before React mounts, so the app renders
 * as a blank white page with the reason visible only in a console the user may
 * not be able to open. A misconfigured app must still boot far enough to say
 * what is wrong.
 */
export let configError = null;

if (!rawUrl || !anonKey) {
  configError =
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. ' +
    'They must be set when the app is built.';
}

/**
 * Normalise the project URL.
 *
 * The SDK appends paths like `/functions/v1/<name>` directly. A trailing slash
 * on the configured value therefore produces a double slash, which Supabase's
 * gateway rejects with "Invalid path specified in request URL" — an error that
 * looks like a broken function but is really a stray character in config.
 *
 * Copying the URL out of the dashboard picks up that slash easily, so it is
 * stripped here rather than relying on whoever set the variable.
 */
const url = rawUrl.replace(/\/+$/, '');

// A shape that does not look like a project URL is worth flagging, but it is
// only a warning: Supabase self-hosting and custom domains are legitimate, and
// refusing to start over a pattern miss would be worse than trying.
if (url && !/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(url)) {
  configError =
    `VITE_SUPABASE_URL does not look like a project URL: "${url}". ` +
    'Expected https://<project-ref>.supabase.co with no path or trailing slash.';
}

export const supabaseUrl = url;
export const supabaseAnonKey = anonKey;

export const supabase = createClient(url || 'https://placeholder.supabase.co', anonKey || 'placeholder', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // No email links or OAuth redirects are used, so there is nothing to parse
    // out of the URL — and leaving this on breaks the capacitor:// origin.
    detectSessionInUrl: false,
  },
});

/**
 * Invoke an Edge Function with the caller's session attached.
 *
 * supabase-js reports every failure as "Edge Function returned a non-2xx
 * status code", which tells the user nothing. The real reason is in the
 * response body, so it is dug out here and thrown instead.
 */
export async function callFunction(name, payload) {
  const { data, error } = await supabase.functions.invoke(name, { body: payload });

  if (!error) return data;

  const response = error.context;

  // No response at all means the request never completed — a blocked CORS
  // preflight, no network, or the function failing to boot. That is a very
  // different problem from a function that ran and rejected the input, so it
  // gets its own message rather than the opaque default.
  if (!response || typeof response.status !== 'number') {
    throw new Error(
      'Could not reach the server. Check your connection and try again.',
    );
  }

  let message = '';

  try {
    // Clone first: the body is a stream and may only be read once.
    const body = await (response.clone?.() ?? response).json();
    message = body?.error || body?.message || '';
    // `detail` carries the underlying cause when the function knows it.
    if (body?.detail) message = `${message} (${body.detail})`;
  } catch {
    try {
      message = (await (response.clone?.() ?? response).text())?.slice(0, 300) || '';
    } catch {
      message = '';
    }
  }

  if (!message) {
    message = response.status >= 500
      ? 'Something went wrong on the server. Try again in a moment.'
      : `Request failed (${response.status}).`;
  }

  const failure = new Error(message);
  failure.status = response.status;
  throw failure;
}

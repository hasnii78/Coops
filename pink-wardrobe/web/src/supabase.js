import { createClient } from '@supabase/supabase-js';

/**
 * The anon key is the ONLY key that belongs in this bundle. It is safe to ship
 * — Row Level Security is what protects the data, not the secrecy of this key.
 *
 * The service role key and the FASHN key are server-side only and must never
 * appear in any file under src/.
 */
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy .env.example to web/.env.local.',
  );
}

export const supabase = createClient(url, anonKey, {
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

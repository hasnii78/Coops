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

/** Invoke an Edge Function with the caller's session attached. */
export async function callFunction(name, payload) {
  const { data, error } = await supabase.functions.invoke(name, { body: payload });

  if (error) {
    // Edge Functions return { error } bodies; surface that rather than the
    // generic "non-2xx status code" wrapper.
    let message = error.message;
    try {
      const body = await error.context?.json?.();
      if (body?.error) message = body.error;
    } catch {
      // Keep the original message.
    }
    throw new Error(message);
  }

  return data;
}

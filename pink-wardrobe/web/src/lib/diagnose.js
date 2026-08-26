/**
 * In-app connection diagnostics.
 *
 * When a request fails at the network level, the browser deliberately hides
 * why: a blocked CORS preflight, a function that will not boot, and a wrong
 * project URL are all reported to JavaScript as the same opaque failure. The
 * real answer is in DevTools, which is not always available to the person
 * hitting the problem.
 *
 * These checks recover that information from inside the page.
 *
 * Every request here is a "simple" request — GET, no custom headers — so the
 * browser sends it without a preflight. That matters: if the preflight is what
 * is broken, a check that needed one would fail for the same reason and tell
 * us nothing.
 */

import { supabaseUrl, supabaseAnonKey } from '../supabase';

const TIMEOUT_MS = 12000;

async function timedFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Does the project host answer at all? */
async function checkProject() {
  try {
    // No apikey header, so no preflight. Any HTTP answer proves the host is
    // real and reachable; the status itself does not matter.
    const response = await timedFetch(`${supabaseUrl}/auth/v1/health`);
    return {
      label: 'Supabase project',
      ok: true,
      detail: `reachable (HTTP ${response.status})`,
    };
  } catch (error) {
    return {
      label: 'Supabase project',
      ok: false,
      detail:
        error.name === 'AbortError'
          ? 'timed out — check the URL and your connection'
          : `unreachable — ${error.message}. The project URL may be wrong.`,
    };
  }
}

/** Is the signup function deployed and able to start? */
async function checkSignupFunction() {
  const url = `${supabaseUrl}/functions/v1/signup`;

  try {
    const response = await timedFetch(url);
    const text = (await response.text()).slice(0, 300);

    if (response.status === 404) {
      return {
        label: 'signup function',
        ok: false,
        detail: 'HTTP 404 — not deployed to THIS project. The app and the deploy may point at different projects.',
      };
    }

    if (response.status >= 500) {
      return {
        label: 'signup function',
        ok: false,
        detail: `HTTP ${response.status} — deployed but failing to start. ${text}`,
      };
    }

    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }

    if (parsed?.ok) {
      return {
        label: 'signup function',
        ok: parsed.hasServiceRole && parsed.hasUrl,
        detail: parsed.hasServiceRole && parsed.hasUrl
          ? 'healthy'
          : `running, but its environment is incomplete (service role: ${parsed.hasServiceRole}, url: ${parsed.hasUrl})`,
      };
    }

    return { label: 'signup function', ok: false, detail: `HTTP ${response.status} — ${text}` };
  } catch (error) {
    return {
      label: 'signup function',
      ok: false,
      detail:
        error.name === 'AbortError'
          ? 'timed out'
          : `unreachable — ${error.message}`,
    };
  }
}

/** Can the database be queried with the configured key? */
async function checkDatabase() {
  try {
    // The key travels as a query parameter rather than a header, keeping this
    // a simple request. profiles is RLS-protected, so an empty result is the
    // expected success case for a signed-out caller.
    const response = await timedFetch(
      `${supabaseUrl}/rest/v1/profiles?select=id&limit=1&apikey=${encodeURIComponent(supabaseAnonKey)}`,
    );

    if (response.status === 401) {
      return { label: 'Database key', ok: false, detail: 'rejected — the publishable key looks wrong' };
    }

    return {
      label: 'Database key',
      ok: response.ok,
      detail: response.ok ? 'accepted' : `HTTP ${response.status}`,
    };
  } catch (error) {
    return { label: 'Database key', ok: false, detail: `unreachable — ${error.message}` };
  }
}

export async function diagnose() {
  const checks = [
    {
      label: 'Configured URL',
      ok: Boolean(supabaseUrl),
      // Public value, safe to display; seeing it is often the whole answer.
      detail: supabaseUrl || 'not set',
    },
    {
      label: 'Key type',
      ok: supabaseAnonKey.startsWith('sb_publishable_') || supabaseAnonKey.startsWith('eyJ'),
      detail: supabaseAnonKey.startsWith('sb_secret_')
        ? 'SECRET key in use — this must be the publishable key'
        : `${supabaseAnonKey.slice(0, 16)}… (${supabaseAnonKey.length} chars)`,
    },
  ];

  // Sequential, not parallel: if the project itself is unreachable, the later
  // checks add noise rather than information.
  checks.push(await checkProject());
  checks.push(await checkSignupFunction());
  checks.push(await checkDatabase());

  return checks;
}

/**
 * Fails the build if a server-side secret reached the client bundle.
 *
 * A plain grep for words like "service_role" does not work: the Supabase SDK
 * legitimately contains those strings in its own key-format detection, so a
 * naive check fires on every build and gets ignored — which is worse than no
 * check at all.
 *
 * This looks for secret *values* instead:
 *   - JWTs whose decoded payload claims the service_role
 *   - sb_secret_ / sbp_ tokens followed by actual key material
 *   - FASHN keys, which are only ever valid server-side
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '..', 'dist');

const findings = [];

/** Recursively collect text-ish files from the build output. */
async function collect(dir) {
  const files = [];

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collect(path)));
    } else if (/\.(js|mjs|css|html|json|map|webmanifest)$/.test(entry.name)) {
      files.push(path);
    }
  }

  return files;
}

function decodeJwtPayload(token) {
  try {
    const [, payload] = token.split('.');
    const normalised = payload.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(normalised, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function scan(path, text) {
  const relative = path.replace(distDir, 'dist');

  // 1. Supabase keys are JWTs. The anon key is fine and expected; a
  //    service_role key in the bundle is a total compromise of RLS.
  for (const token of text.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) ?? []) {
    const payload = decodeJwtPayload(token);
    if (payload?.role === 'service_role') {
      findings.push(`${relative}: a service_role JWT is in the bundle`);
    }
  }

  // 2. Newer Supabase secret-key format, with real key material after the
  //    prefix. The bare prefix appears in SDK source and is not a finding.
  if (/\bsb_secret_[A-Za-z0-9_-]{12,}/.test(text)) {
    findings.push(`${relative}: an sb_secret_ key is in the bundle`);
  }

  // 3. Supabase personal access token (used by CI, never by the app).
  if (/\bsbp_[A-Za-z0-9]{32,}/.test(text)) {
    findings.push(`${relative}: a Supabase access token is in the bundle`);
  }

  // 4. A FASHN key has no legitimate reason to exist client-side at all.
  if (/\bfa[-_][A-Za-z0-9]{16,}/.test(text)) {
    findings.push(`${relative}: what looks like a FASHN key is in the bundle`);
  }
}

const files = await collect(distDir);

for (const path of files) {
  scan(path, await readFile(path, 'utf8'));
}

if (findings.length) {
  console.error('\nServer-side secrets found in the client bundle:\n');
  for (const finding of new Set(findings)) console.error(`  ${finding}`);
  console.error(
    '\nAnything in dist/ is readable by anyone who downloads the app.\n' +
    'Remove the secret, then ROTATE it — it must be assumed compromised.\n',
  );
  process.exit(1);
}

console.log(`Bundle clean — scanned ${files.length} files, no server secrets found.`);

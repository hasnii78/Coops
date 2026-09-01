/**
 * The profile-load retry loop from context/AuthContext.jsx, mirrored here so
 * it can be checked against fake failures without a browser or a real
 * Supabase client. Keep the delays array and the branching in sync with the
 * real one if either changes.
 *
 * What this exists to prevent: a profile that failed to load once looked
 * identical to a profile that did not exist, and an existing account —
 * layers, closet, avatar, all of it already in Storage — got sent through
 * onboarding with no way back, because the only signal available was a
 * boolean that could not tell "not yet fetched" from "genuinely absent".
 */
import assert from 'node:assert/strict';

async function loadWithRetry(fetchProfile, { delays = [0, 1000, 2000, 4000] } = {}) {
  let sleepTotal = 0;

  for (const [attempt, delay] of delays.entries()) {
    sleepTotal += delay;
    const { data, error } = await fetchProfile();

    if (!error) return { profile: data ?? null, profileError: false, attempts: attempt + 1, sleepTotal };

    const lastAttempt = attempt === delays.length - 1;
    if (lastAttempt) return { profile: null, profileError: true, attempts: attempt + 1, sleepTotal };
  }
}

// ---- 1. succeeds first try: no retries burned, real data returned --------
{
  let calls = 0;
  const result = await loadWithRetry(async () => {
    calls += 1;
    return { data: { username: 'coops', avatar_path: 'x' }, error: null };
  });

  assert.equal(calls, 1, 'one call when the first succeeds');
  assert.equal(result.profileError, false);
  assert.equal(result.profile.username, 'coops');
  console.log('1 succeeds on the first try, no retry spent');
}

// ---- 2. one transient failure, then success: the exact bug scenario ------
{
  let calls = 0;
  const result = await loadWithRetry(async () => {
    calls += 1;
    if (calls === 1) return { data: null, error: { message: 'network blip' } };
    return { data: { username: 'coops', avatar_path: 'x', avatar_landmarks: {} }, error: null };
  });

  assert.equal(calls, 2, 'retried exactly once');
  assert.equal(result.profileError, false, 'the transient failure is not the final answer');
  assert.equal(result.profile.username, 'coops', 'the real account is what comes back');
  console.log('2 one glitch then success — this is the fresh-install case that broke coops');
}

// ---- 3. every attempt fails: an honest error, never "no avatar" ----------
{
  let calls = 0;
  const result = await loadWithRetry(async () => {
    calls += 1;
    return { data: null, error: { message: 'still down' } };
  });

  assert.equal(calls, 4, 'all four attempts made');
  assert.equal(result.profileError, true, 'reported as an error');
  assert.equal(result.profile, null);
  // The critical assertion: this state must never be read as "onboard them".
  // profileError=true is what tells App.jsx to show Retry instead of the
  // avatar screen — that branch is checked ahead of hasAvatar precisely so
  // this case cannot fall through to it.
  console.log('3 persistent failure reported as an error, not as "no account"');
}

// ---- 4. a real, successful "no profile yet" is not treated as an error ---
{
  const result = await loadWithRetry(async () => ({ data: null, error: null }));
  assert.equal(result.profileError, false, 'a clean empty result is not an error');
  assert.equal(result.profile, null, 'and is a real signal to onboard');
  console.log('4 a genuinely new account still reaches onboarding');
}

console.log('\nall assertions passed');

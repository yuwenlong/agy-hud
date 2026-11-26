import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expandHome, getAntigravityRoots } from './paths.mjs';
import * as tokenMod from './quota/token.mjs';
import * as cacheMod from './quota/cache.mjs';
import * as cloudMod from './quota/cloud.mjs';
import * as modelsMod from './quota/models.mjs';

const __filename = fileURLToPath(import.meta.url);
const WINDOWS_CREDENTIAL_REFRESH_DEBOUNCE_MS = 30 * 1000;
export const BACKGROUND_REFRESH_COOLDOWN_MS = 15 * 1000;
export const BACKGROUND_REFRESH_ATTEMPT_COOLDOWN_MS = BACKGROUND_REFRESH_COOLDOWN_MS;
export const RESET_EXPIRY_DEBOUNCE_MS = 2 * 1000;
let lastWindowsCredentialRefreshAt = 0;
const refreshAttempts = new Map();

function buildRefreshAttemptKey(tok, lastRefreshed, payload) {
  const tokHash = cacheMod.getTokenHash(tok) || '';
  return JSON.stringify([
    tokHash,
    lastRefreshed,
    payload?.expiresAt ?? null,
    payload?.data ?? null,
    payload?.providerQuota ?? null,
  ]);
}

function shouldThrottleRefreshAttempt(cachePath, attemptKey, now) {
  const scope = path.resolve(cachePath || 'default');
  const prev = refreshAttempts.get(scope);
  if (!prev || prev.fingerprint !== attemptKey) return false;
  return now >= prev.at && now - prev.at < BACKGROUND_REFRESH_ATTEMPT_COOLDOWN_MS;
}

function recordRefreshAttempt(cachePath, attemptKey, now) {
  const scope = path.resolve(cachePath || 'default');
  if (refreshAttempts.size >= 64 && !refreshAttempts.has(scope)) {
    const oldest = refreshAttempts.keys().next().value;
    if (oldest !== undefined) refreshAttempts.delete(oldest);
  }
  refreshAttempts.set(scope, { at: now, fingerprint: attemptKey });
}

export function resolveQuotaRoots(
  env = process.env,
  home = (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir(),
) {
  if (env.AGY_HUD_DATA_DIR?.trim()) return getAntigravityRoots(env, home);
  if (env.AGY_CONFIG_DIR?.trim()) {
    return [path.resolve(expandHome(env.AGY_CONFIG_DIR.trim(), home))];
  }
  return getAntigravityRoots(env, home);
}

export function resolveQuotaCachePath(
  env = process.env,
  home = (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir(),
) {
  if (env.AGY_HUD_DATA_DIR?.trim()) return cacheMod.getCachePath(env);
  if (env.AGY_CONFIG_DIR?.trim()) {
    return path.join(path.resolve(expandHome(env.AGY_CONFIG_DIR.trim(), home)), 'agy-hud-quota-cache.json');
  }
  return cacheMod.getCachePath(env);
}

export function buildRefreshArgs(cachePath, roots) {
  const args = [__filename, '--refresh'];
  if (typeof cachePath === 'string' && cachePath) {
    args.push(`--cache-path=${cachePath}`);
  }
  if (Array.isArray(roots)) {
    for (const root of roots) {
      if (typeof root === 'string' && root) args.push(`--root=${root}`);
    }
  }
  return args;
}

function triggerBackgroundRefresh({ cachePath, roots } = {}) {
  try {
    const subprocess = spawn(process.execPath, buildRefreshArgs(cachePath, roots), {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
    });
    subprocess.unref();
  } catch {}
}

function triggerWindowsCredentialRefresh(backgroundRefresh, now, debounceMs, refreshContext) {
  if (now - lastWindowsCredentialRefreshAt < debounceMs) return;
  lastWindowsCredentialRefreshAt = now;
  backgroundRefresh(refreshContext);
}

function isResetExpiredSinceLastRefresh(resetTime, lastRefreshed, now) {
  if (!resetTime) return false;
  const resetTs = Date.parse(resetTime);
  return Number.isFinite(resetTs) && lastRefreshed < resetTs && resetTs <= now;
}

function hasRecentlyExpiredReset(payload, lastRefreshed, now) {
  if (!payload || !Number.isFinite(lastRefreshed) || lastRefreshed <= 0) return false;
  if (Array.isArray(payload.data)) {
    for (const m of payload.data) {
      if (
        isResetExpiredSinceLastRefresh(m?.resetTime, lastRefreshed, now)
        || isResetExpiredSinceLastRefresh(m?.windows?.fiveHour?.resetTime, lastRefreshed, now)
        || isResetExpiredSinceLastRefresh(m?.windows?.weekly?.resetTime, lastRefreshed, now)
      ) {
        return true;
      }
    }
  }
  const pq = payload.providerQuota || payload.data?.providerQuota;
  if (pq && typeof pq === 'object') {
    for (const group of Object.values(pq)) {
      if (
        isResetExpiredSinceLastRefresh(group?.fiveHour?.resetTime, lastRefreshed, now)
        || isResetExpiredSinceLastRefresh(group?.weekly?.resetTime, lastRefreshed, now)
      ) {
        return true;
      }
    }
  }
  return false;
}

export async function getQuota(options = {}) {
  const {
    fast = false,
    platform = process.platform,
    tokenReader = tokenMod.readToken,
    backgroundRefresh = triggerBackgroundRefresh,
    credentialReader = tokenMod.readWindowsCredentialTokens,
    roots = resolveQuotaRoots(),
    windowsCredentialRefreshDebounceMs = WINDOWS_CREDENTIAL_REFRESH_DEBOUNCE_MS,
    cachePath = resolveQuotaCachePath(),
    now = Date.now(),
  } = options;

  const refreshContext = { cachePath, roots };
  const shouldRefreshWindowsCredential = fast && platform === 'win32';
  const refreshWindowsCredential = () => {
    if (!shouldRefreshWindowsCredential) return;
    triggerWindowsCredentialRefresh(backgroundRefresh, now, windowsCredentialRefreshDebounceMs, refreshContext);
  };

  const tok = tokenReader({
    platform,
    roots,
    credentialReader,
    skipWindowsCredential: fast && platform === 'win32',
    skipKeychain: fast,
    now,
  });

  if (!tok) {
    if (tokenMod.anyTokenFileExists(roots)) {
      const fallback = cacheMod.readCacheFallback(cachePath);
      if (fallback && cacheMod.isCachePayloadFresh(fallback, now) && now < fallback.expiresAt) return fallback.data;
    }
    refreshWindowsCredential();
    return modelsMod.createUnavailableQuotaResult('not_logged_in');
  }

  const payload = cacheMod.readCachePayload(tok, cachePath)
    || (tok.all && tok.all.slice(1).reduce((acc, t) => acc || cacheMod.readCachePayload(t, cachePath), null));
  const isFresh = payload && cacheMod.isCachePayloadFresh(payload, now) && now < payload.expiresAt;
  const tokenExpired = tokenMod.isTokenExpired(tok, now);
  const tokenRotated = cacheMod.didAccessTokenRotate(payload, tok);
  const needsRefresh = !tokenExpired && (!isFresh || tokenRotated);

  if (needsRefresh) {
    const lastRefreshed = payload ? (payload.lastRefreshed || 0) : cacheMod.readCacheLastRefreshed(cachePath);
    const elapsedSinceRefresh = now - lastRefreshed;
    const resetRecentlyExpired = !tokenRotated
      && elapsedSinceRefresh >= RESET_EXPIRY_DEBOUNCE_MS
      && hasRecentlyExpiredReset(payload, lastRefreshed, now);
    if (tokenRotated || elapsedSinceRefresh > BACKGROUND_REFRESH_COOLDOWN_MS || resetRecentlyExpired) {
      const attemptKey = buildRefreshAttemptKey(tok, lastRefreshed, payload);
      if (!shouldThrottleRefreshAttempt(cachePath, attemptKey, now)) {
        recordRefreshAttempt(cachePath, attemptKey, now);
        backgroundRefresh(refreshContext);
      }
    }
  }

  if (payload) return payload.data;
  if (tokenExpired) {
    refreshWindowsCredential();
    return modelsMod.createUnavailableQuotaResult('expired_token');
  }

  const fallback = cacheMod.readCacheFallback(cachePath);
  if (fallback) return fallback.data;
  return [];
}

/**
 * Redacted active account summary for caged logic (never contains access tokens).
 */
export function resolveActiveAccountSummary(env = process.env, home) {
  try {
    const roots = resolveQuotaRoots(env, home);
    const cachePath = resolveQuotaCachePath(env, home);
    const tok = tokenMod.readToken({ roots, skipKeychain: true, skipWindowsCredential: true });
    let email = null;
    if (tok) {
      if (tok.email && tok.sourceFormat !== 'oauth-creds') email = tok.email;
      else email = cacheMod.getCachedAccountEmail(tok, cachePath) || tok.email || null;
    }
    if (!email) {
      const geminiHome = path.join(path.dirname(roots[0]), '.gemini');
      try {
        const reg = JSON.parse(fsReadFile(path.join(geminiHome, 'google_accounts.json')));
        if (typeof reg?.active === 'string' && reg.active.includes('@')) email = reg.active;
      } catch {}
    }
    return { email, tier: cacheMod.getCachedTier(cachePath) };
  } catch {
    return { email: null, tier: null };
  }
}

function fsReadFile(p) {
  return fs.readFileSync(p, 'utf8');
}

export function parseRefreshArgs(argv = process.argv, env = process.env) {
  let cachePath;
  const roots = [];
  for (const arg of argv) {
    if (arg.startsWith('--cache-path=')) {
      const value = arg.slice('--cache-path='.length);
      if (value) cachePath = value;
    } else if (arg.startsWith('--root=')) {
      const value = arg.slice('--root='.length);
      if (value) roots.push(value);
    }
  }
  return {
    roots: roots.length > 0 ? roots : resolveQuotaRoots(env),
    cachePath: cachePath || resolveQuotaCachePath(env),
  };
}

export async function runBackgroundRefresh(options = {}) {
  const {
    roots = resolveQuotaRoots(),
    cachePath = resolveQuotaCachePath(),
    readTokenFn = tokenMod.readToken,
    clearTokenTempFn = tokenMod.clearTokenTemp,
    fetchQuotaFn = cloudMod.fetchQuotaFromCloud,
    fetchTierFn = cloudMod.fetchTierFromCloud,
    fetchEmailFn = cloudMod.fetchAccountEmail,
    writeCacheFn = cacheMod.writeCache,
  } = options;

  const tok = readTokenFn({ roots });
  if (!tok) return { status: 'not_logged_in' };

  const [fresh, tier, accountEmail] = await Promise.all([
    fetchQuotaFn(tok.accessToken),
    fetchTierFn(tok.accessToken),
    fetchEmailFn(tok.accessToken),
  ]);
  if (fresh && fresh.unavailableReason === 'auth_failed') {
    clearTokenTempFn(roots);
    return { status: 'auth_failed' };
  }
  if (Array.isArray(fresh) && !fresh.unavailableReason && fresh.length > 0) {
    writeCacheFn(fresh, tok, tier, accountEmail, fresh.providerQuota, cachePath);
    return { status: 'refreshed', count: fresh.length };
  }
  return { status: 'skipped', reason: fresh?.unavailableReason || 'empty_quota' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename && process.argv.includes('--refresh')) {
  try {
    await runBackgroundRefresh(parseRefreshArgs(process.argv, process.env));
  } catch {}
  process.exit(0);
}

export * from './quota/models.mjs';
export * from './quota/token.mjs';
export * from './quota/cache.mjs';
export * from './quota/cloud.mjs';

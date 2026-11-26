import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { quotaModule, CACHE_PATH } from './_helpers/quota-test-utils.mjs';

const { getQuota } = quotaModule;

describe('quota / getQuota orchestrator', () => {
  describe('fast path with cache', () => {
    test('returns cached quota without background refresh', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        fs.rmSync(CACHE_PATH, { force: true });
        const cachedQuota = [{
          id: 'gemini-3-flash-agent',
          displayName: 'Gemini 3.5 Flash (High)',
          remainingFraction: 0.42,
          resetTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }];
        quotaModule.writeCache(cachedQuota, 'cached-token');

        let refreshes = 0;
        const quota = await getQuota({
          fast: true,
          tokenReader: () => ({ accessToken: 'cached-token' }),
          backgroundRefresh: () => { refreshes += 1; },
        });

        assert.deepEqual(quota, [{ ...cachedQuota[0], windows: {} }]);
        assert.equal(refreshes, 0);
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });

    test('preserves fresh cache when the access token rotates', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        fs.rmSync(CACHE_PATH, { force: true });
        const tokenSourcePath = path.join('same-user', 'antigravity-oauth-token');
        const cachedQuota = [{
          id: 'gemini-3-flash-agent',
          displayName: 'Gemini 3.5 Flash (High)',
          remainingFraction: 0.77,
          resetTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }];
        quotaModule.writeCache(cachedQuota, {
          accessToken: 'old-access-token',
          sourcePath: tokenSourcePath,
        });

        let refreshes = 0;
        const quota = await getQuota({
          fast: true,
          tokenReader: () => ({
            accessToken: 'new-access-token',
            sourcePath: tokenSourcePath,
          }),
          backgroundRefresh: () => { refreshes += 1; },
        });

        assert.deepEqual(quota, [{ ...cachedQuota[0], windows: {} }]);
        assert.equal(refreshes, 1);
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });

    test('starts background refresh when no cache exists', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        fs.rmSync(CACHE_PATH, { force: true });
        let refreshes = 0;

        const quota = await getQuota({
          fast: true,
          tokenReader: () => ({ accessToken: 'uncached-token' }),
          backgroundRefresh: () => { refreshes += 1; },
        });

        assert.deepEqual(quota, []);
        assert.equal(refreshes, 1);
      } finally {
        if (previousCache !== null) fs.writeFileSync(CACHE_PATH, previousCache);
        else fs.rmSync(CACHE_PATH, { force: true });
      }
    });
  });

  describe('expired tokens', () => {
    test('reports expired tokens without spawning quota refresh', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        fs.rmSync(CACHE_PATH, { force: true });
        let refreshes = 0;

        const quota = await getQuota({
          fast: true,
          platform: 'linux',
          tokenReader: () => ({
            accessToken: 'expired-token',
            expiry: '2000-01-01T00:00:00.000Z',
            sourcePath: path.join('expired', 'oauth_creds.json'),
          }),
          backgroundRefresh: () => { refreshes += 1; },
        });

        assert.equal(quota.length, 0);
        assert.equal(quota.unavailableReason, 'expired_token');
        assert.equal(refreshes, 0);
      } finally {
        if (previousCache !== null) fs.writeFileSync(CACHE_PATH, previousCache);
        else fs.rmSync(CACHE_PATH, { force: true });
      }
    });

    test('reports expired_token when token is expired, even if fallback cache exists', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        const payload = {
          version: 3,
          expiresAt: Date.now() + 60000,
          lastRefreshed: Date.now() - 50000,
          cacheKeyHash: 'token-A-hash',
          tokenHash: 'token-A-hash',
          data: [{ id: 'gemini-3-flash-agent', remainingFraction: 0.77 }],
        };
        fs.writeFileSync(CACHE_PATH, JSON.stringify(payload), { mode: 0o600 });

        const result = await getQuota({
          fast: true,
          tokenReader: () => ({
            accessToken: 'token-B',
            sourcePath: '/token/B',
            expiry: new Date(Date.now() - 10000).toISOString(), // expired 10s ago
          }),
          backgroundRefresh: () => {},
        });

        assert.equal(result.unavailableReason, 'expired_token');
        assert.equal(result.length, 0);
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });
  });

  describe('Windows Credential Manager refresh', () => {
    test('fast path wakes credential refresh when no token is visible', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        fs.rmSync(CACHE_PATH, { force: true });
        let refreshes = 0;

        const quota = await getQuota({
          fast: true,
          platform: 'win32',
          tokenReader: () => null,
          backgroundRefresh: () => { refreshes += 1; },
          windowsCredentialRefreshDebounceMs: 0,
        });

        assert.equal(quota.length, 0);
        assert.equal(quota.unavailableReason, 'not_logged_in');
        assert.equal(refreshes, 1);
      } finally {
        if (previousCache !== null) fs.writeFileSync(CACHE_PATH, previousCache);
        else fs.rmSync(CACHE_PATH, { force: true });
      }
    });

    test('fast path wakes credential refresh when file token is expired', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        fs.rmSync(CACHE_PATH, { force: true });
        let refreshes = 0;

        const quota = await getQuota({
          fast: true,
          platform: 'win32',
          tokenReader: () => ({
            accessToken: 'expired-file-token',
            expiry: '2000-01-01T00:00:00.000Z',
            sourcePath: path.join('expired', 'oauth_creds.json'),
          }),
          backgroundRefresh: () => { refreshes += 1; },
          windowsCredentialRefreshDebounceMs: 0,
        });

        assert.equal(quota.length, 0);
        assert.equal(quota.unavailableReason, 'expired_token');
        assert.equal(refreshes, 1);
      } finally {
        if (previousCache !== null) fs.writeFileSync(CACHE_PATH, previousCache);
        else fs.rmSync(CACHE_PATH, { force: true });
      }
    });
  });

  describe('token-null fallback to fresh cache (with file-existence check)', () => {
    test('returns fresh cache when token file exists but is temporarily unreadable', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-token-transient-'));
      try {
        const tokenDir = path.join(tmp, 'antigravity-cli');
        fs.mkdirSync(tokenDir, { recursive: true });
        // Token file exists but contains garbage (simulates mid-write)
        fs.writeFileSync(path.join(tokenDir, 'antigravity-oauth-token'), '{corrupt');

        const cachedQuota = [{
          id: 'gemini-3-flash-agent',
          displayName: 'Gemini 3.5 Flash (High)',
          remainingFraction: 0.55,
          resetTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }];
        quotaModule.writeCache(cachedQuota, 'some-token');

        const quota = await getQuota({
          fast: true,
          tokenReader: () => null,
          backgroundRefresh: () => {},
          roots: [tokenDir],
        });

        assert.deepEqual(quota, [{ ...cachedQuota[0], windows: {} }]);
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('reports not_logged_in when genuinely logged out despite fresh cache', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-no-token-'));
      try {
        // Empty root — no token file exists at all
        const emptyDir = path.join(tmp, 'antigravity-cli');
        fs.mkdirSync(emptyDir, { recursive: true });

        const freshPayload = {
          version: 3,
          expiresAt: Date.now() + 60_000,
          lastRefreshed: Date.now(),
          cacheKeyHash: 'abc',
          tokenHash: 'def',
          data: [{ id: 'test', remainingFraction: 0.5, resetTime: null }],
        };
        fs.writeFileSync(CACHE_PATH, JSON.stringify(freshPayload), { mode: 0o600 });

        const quota = await getQuota({
          fast: true,
          tokenReader: () => null,
          backgroundRefresh: () => {},
          roots: [emptyDir],
        });

        assert.equal(quota.length, 0);
        assert.equal(quota.unavailableReason, 'not_logged_in');
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('reports not_logged_in when token is null and cache is expired', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-expired-'));
      try {
        const tokenDir = path.join(tmp, 'antigravity-cli');
        fs.mkdirSync(tokenDir, { recursive: true });
        fs.writeFileSync(path.join(tokenDir, 'antigravity-oauth-token'), '{corrupt');

        const expiredPayload = {
          version: 3,
          expiresAt: Date.now() - 1000,
          lastRefreshed: Date.now() - 600_000,
          cacheKeyHash: 'abc',
          tokenHash: 'def',
          data: [{ id: 'test', remainingFraction: 0.5 }],
        };
        fs.writeFileSync(CACHE_PATH, JSON.stringify(expiredPayload), { mode: 0o600 });

        const quota = await getQuota({
          fast: true,
          tokenReader: () => null,
          backgroundRefresh: () => {},
          roots: [tokenDir],
        });

        assert.equal(quota.length, 0);
        assert.equal(quota.unavailableReason, 'not_logged_in');
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('refresh dedup', () => {
    test('debounces background refresh using cache lastRefreshed even without token match', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        const recentPayload = {
          version: 3,
          expiresAt: Date.now() - 1000,
          lastRefreshed: Date.now() - 5000,
          cacheKeyHash: 'different-user',
          tokenHash: 'different-token',
          data: [{ id: 'test', remainingFraction: 0.5, resetTime: null }],
        };
        fs.writeFileSync(CACHE_PATH, JSON.stringify(recentPayload), { mode: 0o600 });

        let refreshes = 0;
        await getQuota({
          fast: true,
          tokenReader: () => ({ accessToken: 'new-unmatched-token', sourcePath: '/new/path' }),
          backgroundRefresh: () => { refreshes += 1; },
        });

        assert.equal(refreshes, 0, 'should not refresh when cache was recently refreshed');
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });

    test('falls back to readCacheFallback and returns data when token is unmatched', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        const payload = {
          version: 3,
          expiresAt: Date.now() + 60000,
          lastRefreshed: Date.now() - 50000,
          cacheKeyHash: 'token-A-hash',
          tokenHash: 'token-A-hash',
          data: [{ id: 'gemini-3-flash-agent', remainingFraction: 0.77 }],
        };
        fs.writeFileSync(CACHE_PATH, JSON.stringify(payload), { mode: 0o600 });

        let refreshes = 0;
        const result = await getQuota({
          fast: true,
          tokenReader: () => ({ accessToken: 'token-B', sourcePath: '/token/B' }),
          backgroundRefresh: () => { refreshes += 1; },
        });

        assert.equal(refreshes, 1, 'should trigger background refresh due to token rotation');
        assert.deepEqual(result, payload.data, 'should fall back and return the cached data to avoid Quota loading flicker');
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });

    test('passes skipKeychain matching fast flag to tokenReader', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        fs.rmSync(CACHE_PATH, { force: true });
        const seenSkipKeychain = [];

        await getQuota({
          fast: true,
          platform: 'linux',
          tokenReader: (opts) => {
            seenSkipKeychain.push(opts.skipKeychain);
            return null;
          },
          backgroundRefresh: () => {},
        });

        await getQuota({
          fast: false,
          platform: 'linux',
          tokenReader: (opts) => {
            seenSkipKeychain.push(opts.skipKeychain);
            return null;
          },
          backgroundRefresh: () => {},
        });

        assert.deepEqual(seenSkipKeychain, [true, false]);
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });

    test('triggers background refresh when cache is older than BACKGROUND_REFRESH_COOLDOWN_MS (15s)', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        assert.equal(quotaModule.BACKGROUND_REFRESH_COOLDOWN_MS, 15 * 1000);
        const stalePayload = {
          version: 3,
          expiresAt: Date.now() - 1000,
          lastRefreshed: Date.now() - 20_000,
          cacheKeyHash: 'different-user',
          tokenHash: 'different-token',
          data: [{ id: 'test', remainingFraction: 0.5, resetTime: null }],
        };
        fs.writeFileSync(CACHE_PATH, JSON.stringify(stalePayload), { mode: 0o600 });

        let refreshes = 0;
        await getQuota({
          fast: true,
          tokenReader: () => ({ accessToken: 'new-unmatched-token', sourcePath: '/new/path' }),
          backgroundRefresh: () => { refreshes += 1; },
        });

        assert.equal(refreshes, 1, 'should refresh once cooldown (15s) has elapsed');
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });

    test('triggers background refresh immediately when a cached resetTime expires after lastRefreshed (bypassing 15s cooldown after 2s debounce)', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        assert.equal(quotaModule.RESET_EXPIRY_DEBOUNCE_MS, 2 * 1000);
        const token = { accessToken: 'stable-token', sourcePath: '/stable/path' };
        const cacheKeyHash = quotaModule.getTokenCacheKeyHash(token);
        const tokenHash = quotaModule.getTokenHash(token);
        const now = Date.now();
        const lastRefreshed = now - 5_000; // 5s ago (< 15s cooldown, >= 2s reset debounce)
        const justExpiredIso = new Date(now - 1_000).toISOString(); // lastRefreshed < resetTs <= now

        const writeMatchingPayload = (overrides) => {
          const payload = {
            version: 3,
            expiresAt: now - 1_000,
            lastRefreshed,
            cacheKeyHash,
            tokenHash,
            data: [{ id: 'gemini-3-pro', remainingFraction: 0.5, resetTime: null }],
            ...overrides,
          };
          fs.writeFileSync(CACHE_PATH, JSON.stringify(payload), { mode: 0o600 });
        };

        // 1. Model top-level resetTime crossed after lastRefreshed -> triggers immediately despite < 15s cooldown
        writeMatchingPayload({
          data: [{ id: 'gemini-3-pro', remainingFraction: 0, resetTime: justExpiredIso }],
        });
        let refreshes = 0;
        await getQuota({
          fast: true,
          now,
          tokenReader: () => token,
          backgroundRefresh: () => { refreshes += 1; },
        });
        assert.equal(refreshes, 1, 'top-level data[].resetTime expiry should bypass 15s cooldown');

        // 2. Model windows.fiveHour / windows.weekly resetTime crossed -> triggers immediately
        writeMatchingPayload({
          data: [{
            id: 'gemini-3-pro',
            remainingFraction: 0.4,
            resetTime: new Date(now + 3600_000).toISOString(),
            windows: {
              fiveHour: { remainingFraction: 0, resetTime: justExpiredIso },
            },
          }],
        });
        refreshes = 0;
        await getQuota({
          fast: true,
          now,
          tokenReader: () => token,
          backgroundRefresh: () => { refreshes += 1; },
        });
        assert.equal(refreshes, 1, 'data[].windows.fiveHour.resetTime expiry should bypass 15s cooldown');

        // 3. providerQuota window resetTime crossed -> triggers immediately
        writeMatchingPayload({
          providerQuota: {
            google: {
              weekly: { remainingFraction: 0, resetTime: justExpiredIso },
            },
          },
        });
        refreshes = 0;
        await getQuota({
          fast: true,
          now,
          tokenReader: () => token,
          backgroundRefresh: () => { refreshes += 1; },
        });
        assert.equal(refreshes, 1, 'providerQuota window resetTime expiry should bypass 15s cooldown');

        // 4. Within 2s RESET_EXPIRY_DEBOUNCE_MS -> still debounced even though resetTime has expired
        writeMatchingPayload({
          expiresAt: lastRefreshed + 500,
          data: [{ id: 'gemini-3-pro', remainingFraction: 0, resetTime: new Date(lastRefreshed + 500).toISOString() }],
        });
        refreshes = 0;
        await getQuota({
          fast: true,
          now: lastRefreshed + 1_500,
          tokenReader: () => token,
          backgroundRefresh: () => { refreshes += 1; },
        });
        assert.equal(refreshes, 0, 'must respect 2s RESET_EXPIRY_DEBOUNCE_MS');

        // 5. Window that had already expired BEFORE lastRefreshed must NOT bypass 15s cooldown
        const oldExpiredIso = new Date(lastRefreshed - 2_000).toISOString();
        writeMatchingPayload({
          data: [{ id: 'gemini-3-pro', remainingFraction: 0, resetTime: oldExpiredIso }],
        });
        refreshes = 0;
        await getQuota({
          fast: true,
          now,
          tokenReader: () => token,
          backgroundRefresh: () => { refreshes += 1; },
        });
        assert.equal(refreshes, 0, 'pre-refresh expired resetTime must not repeatedly bypass 15s cooldown');

        // 6. Real writeCache integration: writeCache bounds expiresAt to earliest resetTime; advancing injected now triggers refresh
        fs.rmSync(CACHE_PATH, { force: true });
        const realNow = Date.now();
        const soonResetIso = new Date(realNow + 2_500).toISOString();
        quotaModule.writeCache(
          [{
            id: 'gemini-3-pro',
            remainingFraction: 0,
            resetTime: soonResetIso,
            windows: { fiveHour: { remainingFraction: 0, resetTime: soonResetIso } },
          }],
          token,
        );
        refreshes = 0;
        await getQuota({
          fast: true,
          now: realNow + 1_000,
          tokenReader: () => token,
          backgroundRefresh: () => { refreshes += 1; },
        });
        assert.equal(refreshes, 0, 'before resetTime expires cache remains fresh');

        await getQuota({
          fast: true,
          now: realNow + 3_000,
          tokenReader: () => token,
          backgroundRefresh: () => { refreshes += 1; },
        });
        assert.equal(refreshes, 1, 'once injected now passes resetTime (>= 2s after writeCache), triggers immediate refresh');
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });

    test('throttles repeated backgroundRefresh attempts during reset expiry when refresh fails and respects injected now for expiry checks', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-quota-backoff-'));
      try {
        const cachePath = path.join(tmp, 'quota-cache.json');
        const token = { accessToken: 'backoff-token', sourcePath: path.join(tmp, 'oauth_creds.json') };
        const baseNow = 1_700_000_000_000;
        const resetIso = new Date(baseNow + 2_500).toISOString();

        quotaModule.writeCache(
          [{
            id: 'gemini-3-pro',
            remainingFraction: 0,
            resetTime: resetIso,
            windows: { fiveHour: { remainingFraction: 0, resetTime: resetIso } },
          }],
          token,
          null,
          null,
          null,
          cachePath,
          baseNow,
        );

        // Injected now controls isCachePayloadFresh and isTokenExpired independently of Date.now()
        const rawPayload = quotaModule.readCachePayload(token, cachePath);
        assert.equal(quotaModule.isCachePayloadFresh(rawPayload, baseNow + 2_499), true);
        assert.equal(quotaModule.isCachePayloadFresh(rawPayload, baseNow + 2_500), false);
        assert.equal(quotaModule.isTokenExpired({ accessToken: 't', expiry: new Date(baseNow + 90_000).toISOString() }, baseNow), false);
        assert.equal(quotaModule.isTokenExpired({ accessToken: 't', expiry: new Date(baseNow + 60_000).toISOString() }, baseNow), true);

        // Simulate 1s polling ticks across 15s while offline (cache never updated)
        let refreshes = 0;
        for (let offset = 3_000; offset <= 17_000; offset += 1_000) {
          await getQuota({
            fast: true,
            now: baseNow + offset,
            cachePath,
            tokenReader: () => token,
            backgroundRefresh: () => { refreshes += 1; },
          });
        }
        assert.equal(refreshes, 1, 'must throttle repeated failed reset-expiry refreshes within cooldown window');

        // Once attempt cooldown (15s) has elapsed after initial attempt at baseNow + 3_000, allows a single retry
        await getQuota({
          fast: true,
          now: baseNow + 18_000,
          cachePath,
          tokenReader: () => token,
          backgroundRefresh: () => { refreshes += 1; },
        });
        assert.equal(refreshes, 2, 'allows retry once attempt cooldown has elapsed');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('AGY_CONFIG_DIR & runBackgroundRefresh consistency', () => {
    test('resolveQuotaRoots, resolveQuotaCachePath, and refresh arg helpers preserve AGY_CONFIG_DIR', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-cfg-dir-'));
      try {
        const home = path.join(tmp, 'home');
        const customCfg = path.join(tmp, 'custom-agy');
        const env = { HOME: home, USERPROFILE: home, AGY_CONFIG_DIR: customCfg, AGY_HUD_DATA_DIR: '' };

        const roots = quotaModule.resolveQuotaRoots(env, home);
        const cachePath = quotaModule.resolveQuotaCachePath(env, home);
        assert.deepEqual(roots, [path.resolve(customCfg)]);
        assert.equal(cachePath, path.join(path.resolve(customCfg), 'agy-hud-quota-cache.json'));

        const args = quotaModule.buildRefreshArgs(cachePath, roots);
        const parsed = quotaModule.parseRefreshArgs(args, {});
        assert.equal(parsed.cachePath, cachePath);
        assert.deepEqual(parsed.roots, roots);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('runBackgroundRefresh skips writing cache when quota probe fails with unavailableReason', async () => {
      let writeCount = 0;
      const unavailableEmpty = Object.assign([], { unavailableReason: 'network_error' });

      const res = await quotaModule.runBackgroundRefresh({
        roots: ['/nonexistent/root'],
        cachePath: '/nonexistent/cache.json',
        readTokenFn: () => ({ accessToken: 'tok-refresh' }),
        fetchQuotaFn: async () => unavailableEmpty,
        fetchTierFn: async () => 'Pro',
        fetchEmailFn: async () => 'user@example.com',
        writeCacheFn: () => { writeCount += 1; },
      });

      assert.equal(writeCount, 0, 'empty unavailable quota probe must not overwrite valid cache');
      assert.equal(res.status, 'skipped');
      assert.equal(res.reason, 'network_error');
    });
  });
});

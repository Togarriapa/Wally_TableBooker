import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { validateCards } from './wally-contract.js';

export const WALLY_ORIGIN = 'https://wally.criticaltechworks.com';
export const WALLY_CLIENT_ID = '82358e21-2576-4ef0-af19-4e8f06af0396';
export const WALLY_TENANT_ID = '61f30b8e-4f6b-44fe-9bc2-041e3a9f7346';
export const WALLY_SCOPE = `api://${WALLY_CLIENT_ID}/Wally.User openid profile offline_access`;
export const WALLY_TOKEN_URL = `https://login.microsoftonline.com/${WALLY_TENANT_ID}/oauth2/v2.0/token`;
export const WALLY_DEVICE_VERIFICATION_URLS = Object.freeze([
  'https://microsoft.com/devicelogin',
  'https://login.microsoft.com/device',
]);
const KEYCHAIN_HELPER = fileURLToPath(new URL('./keychain-session.py', import.meta.url));
const SIGNIN_FAILURE_CODES = new Set([
  'device_authorization_rejected', 'device_authorization_response_invalid',
  'device_grant_rejected', 'device_approval_expired', 'signin_interrupted',
  'session_validation_failed', 'session_persistence_failed',
]);
const OAUTH_ERROR_CODES = new Set([
  'access_denied', 'authorization_declined', 'bad_verification_code', 'expired_token',
  'invalid_client', 'unauthorized_client', 'invalid_grant', 'invalid_request',
  'invalid_scope', 'invalid_resource', 'interaction_required', 'consent_required',
  'temporarily_unavailable', 'server_error',
]);

function combineSignals(signal, lifecycleSignal) {
  return signal && lifecycleSignal && signal !== lifecycleSignal
    ? AbortSignal.any([signal, lifecycleSignal]) : signal ?? lifecycleSignal;
}

export class WallyAuthenticationError extends Error {
  constructor(message, { code, httpStatus, oauthError } = {}) {
    super(message);
    this.name = 'WallyAuthenticationError';
    this.signinDiagnostic = Object.freeze({
      code: SIGNIN_FAILURE_CODES.has(code) ? code : 'authentication_failed',
      ...(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { http_status: httpStatus } : {}),
      ...(OAUTH_ERROR_CODES.has(oauthError) ? { oauth_error: oauthError } : {}),
    });
  }
}

export function validateSession(session) {
  if (!session || typeof session.accessToken !== 'string' ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(session.accessToken) ||
      (session.authMode === 'browser'
        ? session.refreshToken !== undefined || !/^[a-f0-9-]{36}$/.test(session.captureId ?? '')
        : session.authMode !== undefined || typeof session.refreshToken !== 'string' || !/^[A-Za-z0-9._~-]+$/.test(session.refreshToken)) ||
      !Number.isFinite(session.expiresAt) || session.expiresAt <= 0) {
    throw new WallyAuthenticationError('Invalid Wally OAuth credentials; import a complete session locally.');
  }
  let claims;
  try { claims = JSON.parse(Buffer.from(session.accessToken.split('.')[1], 'base64url')); }
  catch { throw new WallyAuthenticationError('Invalid Wally access token; contents suppressed.'); }
  if (![WALLY_CLIENT_ID, `api://${WALLY_CLIENT_ID}`].includes(claims.aud) ||
      claims.tid !== WALLY_TENANT_ID || !Number.isFinite(claims.exp) ||
      session.expiresAt > claims.exp * 1000) {
    throw new WallyAuthenticationError('OAuth token does not match the pinned Wally application and expiry.');
  }
  if (session.authMode === 'browser') {
    if (typeof claims.oid !== 'string' || !claims.oid ||
        typeof claims.scp !== 'string' || !claims.scp.split(' ').includes('Wally.User')) {
      throw new WallyAuthenticationError('Browser authorization does not contain the required Wally user permission.');
    }
    return { accessToken: session.accessToken, expiresAt: session.expiresAt,
      authMode: 'browser', captureId: session.captureId };
  }
  return { accessToken: session.accessToken, refreshToken: session.refreshToken, expiresAt: session.expiresAt };
}

export class KeychainSessionStore {
  constructor(exec = execFileSync) { this.exec = exec; }
  load() {
    let encoded;
    try {
      encoded = this.exec('/usr/bin/python3', [KEYCHAIN_HELPER, 'read'],
        { timeout: 15_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch {
      throw new WallyAuthenticationError('Wally API credentials unavailable in Keychain. Import a session locally; no browser will open.');
    }
    try { return validateSession(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))); }
    catch { throw new WallyAuthenticationError('Wally Keychain session is invalid; import a complete session locally.'); }
  }

  save(session) {
    const encoded = Buffer.from(JSON.stringify(validateSession(session))).toString('base64');
    try {
      this.exec('/usr/bin/python3', [KEYCHAIN_HELPER, 'write'], {
        input: encoded, timeout: 15_000,
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { throw new Error('Could not persist Wally OAuth session in Keychain; credential details suppressed.'); }
    const saved = this.load();
    if (saved.accessToken !== session.accessToken || saved.refreshToken !== session.refreshToken ||
        saved.authMode !== session.authMode || saved.captureId !== session.captureId) {
      throw new Error('Wally Keychain write verification failed; booking must remain stopped.');
    }
  }
}

export class WallySession {
  constructor({ store = new KeychainSessionStore(), fetcher = fetch, now = Date.now, renewBrowserSession, signal } = {}) {
    this.store = store;
    this.fetcher = fetcher;
    this.now = now;
    this.renewBrowserSession = renewBrowserSession;
    this.signal = signal;
  }

  async token(force = false, { signal = this.signal } = {}) {
    signal = combineSignals(signal, this.signal);
    signal?.throwIfAborted();
    if (this.refreshing) {
      const token = await this.refreshing;
      signal?.throwIfAborted();
      return token;
    }
    if (!this.credentials || force) {
      const previous = this.credentials;
      const saved = await this.store.load();
      signal?.throwIfAborted();
      if (this.credentials === previous) this.credentials = validateSession(saved);
    }
    if (this.refreshing) {
      const token = await this.refreshing;
      signal?.throwIfAborted();
      return token;
    }
    if (!force && this.credentials.expiresAt > this.now() + 60_000) return this.credentials.accessToken;
    this.refreshing = this.refresh({ signal }).finally(() => { this.refreshing = undefined; });
    const token = await this.refreshing;
    signal?.throwIfAborted();
    return token;
  }

  async refresh({ signal = this.signal } = {}) {
    signal = combineSignals(signal, this.signal);
    signal?.throwIfAborted();
    if (this.credentials.authMode === 'browser') {
      if (!this.renewBrowserSession) {
        throw new WallyAuthenticationError('Wally authorization needs the installed Mac Chrome authentication bridge.');
      }
      const previousIdentity = JSON.parse(Buffer.from(this.credentials.accessToken.split('.')[1], 'base64url')).oid;
      const next = validateSession(await this.renewBrowserSession({ signal }));
      signal?.throwIfAborted();
      if (next.authMode !== 'browser' || next.expiresAt <= this.now() + 60_000) {
        throw new WallyAuthenticationError('Chrome did not supply a fresh Wally authorization.');
      }
      if (JSON.parse(Buffer.from(next.accessToken.split('.')[1], 'base64url')).oid !== previousIdentity) {
        throw new WallyAuthenticationError('The Wally account changed during browser authorization; request personal sign-in.');
      }
      this.credentials = next;
      return next.accessToken;
    }
    let response;
    try {
      response = await this.fetcher(WALLY_TOKEN_URL, {
        method: 'POST', redirect: 'error', credentials: 'omit',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: WALLY_ORIGIN },
        body: new URLSearchParams({ client_id: WALLY_CLIENT_ID, grant_type: 'refresh_token',
          refresh_token: this.credentials.refreshToken, scope: WALLY_SCOPE }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        if (response.status === 429 || response.status >= 500) {
          await response.body?.cancel();
          throw new Error(`Microsoft token renewal temporarily unavailable: HTTP ${response.status}; retry later.`);
        }
        const body = await response.json();
        if (['invalid_grant', 'interaction_required', 'login_required', 'consent_required'].includes(body.error)) {
          throw new WallyAuthenticationError('Microsoft requires a fresh Wally sign-in. Use Sign in on Mac and complete normal browser sign-in/MFA.');
        }
        throw new Error(`Microsoft rejected Wally OAuth configuration: HTTP ${response.status}; check the local worker.`);
      }
      return await this.persistTokens(await response.json(), { signal });
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof WallyAuthenticationError) throw error;
      throw new Error('Wally OAuth renewal or persistence failed. No booking was sent; retry or check the local worker.');
    }
  }

  async persistTokens(data, { signal = this.signal } = {}) {
    signal = combineSignals(signal, this.signal);
    signal?.throwIfAborted();
    if (data.token_type?.toLowerCase() !== 'bearer' || typeof data.access_token !== 'string' ||
        !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0 ||
        (data.refresh_token !== undefined && typeof data.refresh_token !== 'string')) {
      throw new WallyAuthenticationError('Microsoft returned an invalid OAuth token response; contents suppressed.');
    }
    let expiry;
    try { expiry = JSON.parse(Buffer.from(data.access_token.split('.')[1], 'base64url')).exp * 1000; }
    catch { throw new WallyAuthenticationError('Microsoft returned an invalid access token; contents suppressed.'); }
    const next = validateSession({ accessToken: data.access_token,
      refreshToken: data.refresh_token ?? this.credentials?.refreshToken,
      expiresAt: Math.min(expiry, this.now() + Number(data.expires_in) * 1000) });
    await this.store.save(next);
    signal?.throwIfAborted();
    this.credentials = next;
    return next.accessToken;
  }

  async signin({ onCode, signal, wait = delay }) {
    const options = { method: 'POST', redirect: 'error', credentials: 'omit',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } };
    let persisting = false;
    try {
      const start = await this.fetcher(WALLY_TOKEN_URL.replace('/token', '/devicecode'), {
        ...options, body: new URLSearchParams({ client_id: WALLY_CLIENT_ID, scope: WALLY_SCOPE }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
      });
      if (!start.ok) {
        let data;
        try { data = await start.json(); }
        catch {
          throw new WallyAuthenticationError(`Microsoft device authorization rejected: HTTP ${start.status}; non-JSON response suppressed.`, {
            code: 'device_authorization_rejected', httpStatus: start.status,
          });
        }
        throw new WallyAuthenticationError(`Microsoft device authorization rejected: HTTP ${start.status}. No browser fallback.`, {
          code: 'device_authorization_rejected', httpStatus: start.status, oauthError: data?.error,
        });
      }
      const code = await start.json();
      if (!WALLY_DEVICE_VERIFICATION_URLS.includes(code.verification_uri) ||
          !/^[A-Z0-9-]{6,20}$/.test(code.user_code) || typeof code.device_code !== 'string' ||
          !code.device_code || !Number.isInteger(code.expires_in) || code.expires_in < 1 ||
          code.expires_in > 1800 || !Number.isInteger(code.interval) || code.interval < 1 || code.interval > 60) {
        throw new WallyAuthenticationError('Invalid Microsoft device authorization response; contents suppressed.', {
          code: 'device_authorization_response_invalid',
        });
      }
      const deadline = this.now() + code.expires_in * 1000;
      await onCode({ verification_uri: code.verification_uri, user_code: code.user_code });
      let interval = code.interval;
      while (this.now() < deadline) {
        await wait(interval * 1000, undefined, { signal });
        if (this.now() >= deadline) break;
        const response = await this.fetcher(WALLY_TOKEN_URL, { ...options,
          body: new URLSearchParams({ client_id: WALLY_CLIENT_ID,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: code.device_code }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
        });
        const data = await response.json();
        if (response.ok) {
          persisting = true;
          return await this.persistTokens(data, { signal });
        }
        if (response.status === 400 && data.error === 'authorization_pending') continue;
        if (response.status === 400 && data.error === 'slow_down') { interval += 5; continue; }
        throw new WallyAuthenticationError(`Microsoft device sign-in failed: HTTP ${response.status}. Complete approved authentication manually; no browser fallback.`, {
          code: 'device_grant_rejected', httpStatus: response.status, oauthError: data?.error,
        });
      }
      throw new WallyAuthenticationError('Microsoft device sign-in expired before approval; run signin explicitly to try again.', {
        code: 'device_approval_expired',
      });
    } catch (error) {
      if (error instanceof WallyAuthenticationError && !persisting) throw error;
      const code = persisting ?
        (error instanceof WallyAuthenticationError ? 'session_validation_failed' : 'session_persistence_failed') :
        'signin_interrupted';
      throw new WallyAuthenticationError(error instanceof WallyAuthenticationError ? error.message :
        'Device sign-in interrupted or could not be persisted; no browser was opened.', { code });
    }
  }

  invalidate(accessToken) {
    if (this.credentials && (accessToken === undefined || this.credentials.accessToken === accessToken)) {
      this.credentials.expiresAt = 0;
    }
  }
  clear() { this.credentials = undefined; }
}

export class WallyApi {
  constructor(config, { session = new WallySession(), fetcher = fetch, settle = delay, recoverSession } = {}) {
    this.config = config;
    this.session = session;
    this.fetcher = fetcher;
    this.settle = settle;
    this.recoverSession = recoverSession;
    this.authorizationGeneration = 0;
  }

  async close() { this.session.clear(); }

  async authorize(force = false, { signal } = {}) {
    signal = combineSignals(signal, this.session.signal);
    signal?.throwIfAborted();
    if (this.recovering) {
      const token = await this.recovering;
      signal?.throwIfAborted();
      return token;
    }
    const generation = this.authorizationGeneration;
    let token;
    try { token = await this.session.token(force, { signal }); }
    catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof WallyAuthenticationError) || !this.recoverSession) throw error;
      if (generation !== this.authorizationGeneration) {
        if (this.recoveryError) throw this.recoveryError;
        token = await this.session.token(false, { signal });
      } else {
        if (!this.recovering) {
          this.recoveryError = undefined;
          this.recovering = (async () => {
            await this.recoverSession({ signal, error });
            signal?.throwIfAborted();
            const recovered = await this.session.token(false, { signal });
            signal?.throwIfAborted();
            return recovered;
          })().catch(error => {
            this.recoveryError = error;
            throw error;
          }).finally(() => {
            this.authorizationGeneration++;
            this.recovering = undefined;
          });
        }
        token = await this.recovering;
      }
    }
    signal?.throwIfAborted();
    return token;
  }

  async request(method, pathname, body, { signal } = {}) {
    signal = combineSignals(signal, this.session.signal);
    if (!((method === 'GET' && (pathname === '/api/v1/offices' ||
        pathname === `/api/v1/me/schedule?floorId=${this.config.floorId}`)) ||
        (method === 'POST' && pathname === '/api/v1/me/bookings') ||
        (method === 'DELETE' && /^\/api\/v1\/me\/bookings\/[A-Za-z0-9-]{8,80}$/.test(pathname)))) {
      throw new Error('Wally request is outside the API allowlist');
    }
    signal?.throwIfAborted();
    let token = await this.authorize(false, { signal });
    const generation = this.authorizationGeneration;
    let response;
    let text;
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      try {
        response = await this.fetcher(`${WALLY_ORIGIN}${pathname}`, {
        method, redirect: 'error', credentials: 'omit',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
        });
        if (response.status === 401) await response.body?.cancel();
        else text = await response.text();
      } catch {
        signal?.throwIfAborted();
        throw new Error(`Wally ${method} transport failed or response was interrupted; no automatic mutation retry.`);
      }
      if (response.status !== 401) break;
      this.session.invalidate(token);
      if (method !== 'GET' || attempt === 1) {
        throw new WallyAuthenticationError(`Wally ${method} rejected authorization: HTTP 401; no automatic mutation retry.`);
      }
      const replaced = this.session.credentials && this.session.credentials.accessToken !== token;
      if (!replaced && generation !== this.authorizationGeneration && this.recoveryError) throw this.recoveryError;
      token = await this.authorize(!replaced, { signal });
    }
    signal?.throwIfAborted();
    if (response.status === 403) throw new Error(`Wally ${method} access denied; check permissions, not session renewal.`);
    if (!response.ok) throw new Error(`Wally reservation ${method} failed: HTTP ${response.status}`);
    if (method !== 'GET') return { http_status: response.status };
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Wally API did not return JSON');
    try { return JSON.parse(text); }
    catch { throw new Error('Wally API returned invalid JSON; contents suppressed.'); }
  }

  async verifyLocation({ signal } = {}) {
    const offices = await this.request('GET', '/api/v1/offices', undefined, { signal });
    signal?.throwIfAborted();
    const office = Array.isArray(offices) && offices.find(o => o.id === this.config.officeId);
    if (!office || office.name !== this.config.office ||
        !office.floors?.some(f => f.id === this.config.floorId && f.name === this.config.floor)) {
      throw new Error('Wally office or floor does not match the configured location');
    }
  }

  async reauthenticate({ signal, force = true } = {}) {
    await this.authorize(force, { signal });
    await this.verifyLocation({ signal });
    return { status: 'api_session_refreshed' };
  }

  async snapshot(withAvailability, targetDate) {
    await this.verifyLocation();
    const schedule = await this.request('GET', `/api/v1/me/schedule?floorId=${this.config.floorId}`);
    if (!Array.isArray(schedule) || !schedule.length) throw new Error('Wally returned an invalid live schedule');
    const cards = schedule.map(day => {
      if (!day || typeof day !== 'object') throw new Error('Wally returned an invalid schedule day');
      const booking = day.booking;
      if (booking != null && (typeof booking !== 'object' ||
          typeof booking.id !== 'string' || !/^[A-Za-z0-9-]{8,80}$/.test(booking.id) ||
          booking.officeId !== this.config.officeId || booking.floorId !== this.config.floorId)) {
        throw new Error('Wally returned an invalid reservation or a reservation in another location');
      }
      if (booking == null && !Array.isArray(day.availableDesks) &&
          day.isOfficeUnavailable !== true && day.isFloorUnavailable !== true) {
        throw new Error('Wally did not return verified desk availability');
      }
      const available = booking != null ? [] : (day.availableDesks ?? []).map(d => {
        if (!d || typeof d.id !== 'string' || !/^[A-Za-z0-9-]{8,80}$/.test(d.id) ||
            typeof d.number !== 'string' || !/^\d{3}$/.test(d.number)) throw new Error('Wally returned an invalid available desk');
        return d.number;
      });
      if (new Set(available).size !== available.length ||
          (booking == null && new Set((day.availableDesks ?? []).map(d => d.id)).size !== available.length)) {
        throw new Error('Wally returned duplicate available desks');
      }
      return { date: day.date, booked: booking != null,
        ...(booking != null ? { desk: booking.deskNumber } : {}),
        available: withAvailability && (!targetDate || day.date === targetDate) ? available : [] };
    });
    validateCards(cards);
    this.schedule = schedule;
    return cards;
  }

  async book(item) {
    const cards = await this.snapshot(true, item.date);
    const current = cards.find(c => c.date === item.date);
    if (!current || current.booked || !current.available.includes(item.desk)) {
      throw new Error('Reservation or desk availability changed before booking; refresh before retrying');
    }
    const day = this.schedule.find(d => d.date === item.date);
    const desk = day.availableDesks.find(d => d.number === item.desk);
    const transport = await this.request('POST', '/api/v1/me/bookings', {
      date: item.date, deskId: desk.id, suggestion: { values: '', accepted: false },
    });
    const confirmed = (await this.snapshot(false)).find(c => c.date === item.date);
    if (!confirmed?.booked || confirmed.desk !== item.desk) throw new Error('Wally did not confirm the requested desk');
    return { ...item, status: 'confirmed', http_status: transport.http_status };
  }

  async cancel(item) {
    const cards = await this.snapshot(false);
    const current = cards.find(c => c.date === item.date);
    if (!current?.booked || current.desk !== item.desk) {
      throw new Error('Reservation changed before cancellation; refresh and select it again');
    }
    const booking = this.schedule.find(d => d.date === item.date).booking;
    let transport;
    try { transport = await this.request('DELETE', `/api/v1/me/bookings/${booking.id}`); }
    finally { await this.settle(2000); }
    if ((await this.snapshot(false)).find(c => c.date === item.date)?.booked !== false) {
      throw new Error('Wally did not confirm cancellation');
    }
    return transport;
  }
}

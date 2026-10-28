import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, PassThrough } from 'node:stream';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { browserSession, forwardBrowserSession, runChromeNativeHost, CHROME_EXTENSION_ID } from '../src/chrome-native-host.js';
import { signinOnMac, signinUsingChromeBridge, chromeBridgeRequest, browserSessionScript, chromeWindowsClosedScript } from '../src/mac-signin.js';
import { validateSession, WallySession, WallyApi, WALLY_ORIGIN, WALLY_CLIENT_ID, WALLY_TENANT_ID } from '../src/wally-api.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setImmediate as flush } from 'node:timers/promises';
import { lisbonToday } from '../src/worker.js';

const now = Date.now();
const captureId = '12345678-1234-1234-1234-123456789abc';
const token = extra => `header.${Buffer.from(JSON.stringify({
  aud: WALLY_CLIENT_ID, tid: WALLY_TENANT_ID, oid: 'synthetic-user',
  scp: 'Wally.User', exp: Math.floor(now / 1000) + 3600, ...extra,
})).toString('base64url')}.signature`;

test('browser grants are explicitly access-only and require pinned identity, permission, expiry and request', () => {
  const session = browserSession(token(), captureId, now);
  assert.equal(session.authMode, 'browser');
  assert.equal(session.refreshToken, undefined);
  assert.deepEqual(validateSession(session), session);
  for (const extra of [{ tid: 'other' }, { aud: 'other' }, { scp: 'User.Read' },
    { scp: 1 }, { oid: undefined }, { exp: now / 1000 + 30 }]) {
    assert.throws(() => browserSession(token(extra), captureId, now));
  }
  assert.throws(() => browserSession(token(), 'invalid', now));
  assert.throws(() => validateSession({ ...session, refreshToken: 'not-permitted' }));
  assert.throws(() => validateSession({ ...session, authMode: 'unknown' }));
});

test('browser authorization renews only on demand, coalesces expiry, never sends an opaque refresh token', async () => {
  let clock = now;
  let renewals = 0;
  const first = browserSession(token(), captureId, now);
  const next = browserSession(token({ exp: Math.floor(now / 1000) + 7200 }), captureId, now);
  const session = new WallySession({ now: () => clock, store: { load: async () => first },
    fetcher: () => assert.fail('Browser grants do not use Microsoft refresh-token HTTP'),
    renewBrowserSession: async () => { renewals++; return next; } });
  assert.equal(await session.token(), first.accessToken);
  assert.equal(renewals, 0);
  clock += 3600001;
  assert.deepEqual(await Promise.all([session.token(), session.token()]), [next.accessToken, next.accessToken]);
  assert.equal(renewals, 1);
});

test('missing or rejected browser bridge never returns stale success or changes identity', async () => {
  const previous = browserSession(token(), captureId, now);
  for (const renewBrowserSession of [undefined,
    async () => browserSession(token({ oid: 'another-user' }), captureId, now),
    async () => { throw Error('Browser authentication requires attention'); }]) {
    const session = new WallySession({ store: { load: () => previous }, now: () => now, renewBrowserSession });
    await assert.rejects(session.token(true), /bridge|account changed|attention/);
    assert.equal(session.credentials.accessToken, previous.accessToken);
  }
});

test('extension identity, origin permissions and main-world registration are narrowly pinned', async () => {
  const manifest = JSON.parse(await readFile(new URL('../chrome-extension/manifest.json', import.meta.url), 'utf8'));
  const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)]
    .map(n => 'abcdefghijklmnop'[n >> 4] + 'abcdefghijklmnop'[n & 15]).join('');
  assert.equal(id, CHROME_EXTENSION_ID);
  assert.deepEqual(manifest.host_permissions, [`${WALLY_ORIGIN}/*`]);
  assert.deepEqual(manifest.permissions, ['scripting', 'nativeMessaging']);
  assert.equal(manifest.content_scripts[0].world, 'MAIN');
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');
  for (const script of manifest.content_scripts) assert.deepEqual(script.matches, [`${WALLY_ORIGIN}/*`]);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
});

async function pageFixture() {
  const source = await readFile(new URL('../chrome-extension/capture-main.js', import.meta.url), 'utf8');
  const messages = [];
  let controller;
  class XHR {
    open() {}
    setRequestHeader() {}
    addEventListener(name, callback) { this.listener = callback; }
    removeEventListener(name, callback) { if (this.listener === callback) this.listener = undefined; }
  }
  const originalFetch = async () => new Response('{}', { status: 200 });
  const window = {
    fetch: originalFetch,
    addEventListener(name, callback) { controller = callback; },
    postMessage(message) { messages.push(message); },
  };
  window.top = window;
  vm.runInNewContext(source, { window, location: { origin: WALLY_ORIGIN, href: `${WALLY_ORIGIN}/homepage/book-a-desk` },
    XMLHttpRequest: XHR, URL, Headers, Request, WeakMap, Set, setTimeout, clearTimeout });
  const control = action => controller({ source: window, origin: WALLY_ORIGIN,
    data: { channel: 'wally-auth-bridge-v1', action, requestId: captureId } });
  control('start');
  return { window, XHR, messages, control, originalFetch };
}

test('main-world observer forwards only successful exact-origin GET bearer headers and detaches', async () => {
  for (const [method, url, expected] of [
    ['GET', `${WALLY_ORIGIN}/api/v1/offices`, true],
    ['POST', `${WALLY_ORIGIN}/api/v1/me/bookings`, false],
    ['DELETE', `${WALLY_ORIGIN}/api/v1/me/bookings/fixture`, false],
    ['GET', 'https://elsewhere.invalid/api/v1/offices', false],
    ['GET', `${WALLY_ORIGIN}/non-api`, false],
  ]) {
    const f = await pageFixture();
    await f.window.fetch(url, { method, headers: { Authorization: `Bearer ${token()}` } });
    assert.equal(f.messages.filter(m => m.action === 'grant').length, expected ? 1 : 0);
    f.control('stop');
    assert.equal(f.window.fetch, f.originalFetch);
  }
});

test('XHR observation validates method/origin/status and cannot reuse a previous request header', async () => {
  const f = await pageFixture();
  const xhr = new f.XHR();
  xhr.open('GET', '/api/v1/offices');
  xhr.setRequestHeader('authorization', `Bearer ${token()}`);
  xhr.open('POST', '/api/v1/me/bookings');
  assert.equal(xhr.listener, undefined);
  xhr.open('GET', '/api/v1/offices');
  xhr.setRequestHeader('authorization', `Bearer ${token()}`);
  xhr.status = 401;
  xhr.listener();
  assert.equal(f.messages.length, 0);
  xhr.status = 200;
  xhr.listener();
  assert.equal(f.messages[0].action, 'grant');
  assert.equal(xhr.listener, undefined);
  f.control('stop');
});

test('wrappers remain inert if website code has wrapped them before cleanup', async () => {
  const f = await pageFixture();
  const observed = f.window.fetch;
  f.window.fetch = (...args) => observed(...args);
  f.control('stop');
  await f.window.fetch(`${WALLY_ORIGIN}/api/v1/offices`, { headers: { Authorization: `Bearer ${token()}` } });
  assert.equal(f.messages.length, 0);
});

test('native framing rejects unapproved extensions, oversized messages and unrelated fields', async () => {
  for (const [origin, payload, expected] of [
    ['chrome-extension://unapproved/', Buffer.alloc(0), 'invalid_origin'],
    [`chrome-extension://${CHROME_EXTENSION_ID}/`, Buffer.from([255, 255, 255, 255]), 'invalid_grant'],
  ]) {
    const output = new PassThrough();
    const chunks = [];
    output.on('data', chunk => chunks.push(chunk));
    await runChromeNativeHost({ origin, input: Readable.from([payload]), output });
    const reply = Buffer.concat(chunks);
    assert.equal(reply.readUInt32LE(0), reply.length - 4);
    assert.equal(JSON.parse(reply.subarray(4)).code, expected);
    assert.doesNotMatch(reply.toString(), /synthetic-user|accessToken/);
  }
  assert.equal((await forwardBrowserSession({ type: 'deliver-browser-session', accessToken: token(),
    captureId, unexpected: true })).code, 'invalid_grant');
});

async function nativeFixture(t, {
  abortBeforeCallback = false, response = 'ready', holdHelperClose = false, holdCleanupClose = false,
  cleanupError = false, cleanupStatus = 'cleaned', windowProof = 'cleanup_failed',
  proofError = false, holdProofClose = false, deliverGrant = true,
  session: existingSession, clock = () => now, accessToken = () => token(),
} = {}) {
  const directory = await mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'wcb-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  const scripts = [];
  const saves = [];
  const events = [];
  let captures = 0, receivedId;
  let releaseHelper, releaseCleanup, releaseProof, helperReady, cleanupReady, proofReady;
  const helperCallback = new Promise(resolve => { helperReady = resolve; });
  const cleanupCallback = new Promise(resolve => { cleanupReady = resolve; });
  const proofCallback = new Promise(resolve => { proofReady = resolve; });
  const session = existingSession ?? { store: { save: async () => {} } };
  const originalSave = session.store.save;
  session.store.save = async value => {
    events.push('save');
    saves.push(value);
    await originalSave.call(session.store, value);
  };
  const execute = (file, args, options, callback) => {
    if (file === '/usr/bin/osascript') assert.deepEqual(args, ['-']);
    else {
      assert.equal(file, process.execPath);
      assert.equal(args.length, 1);
      assert.ok(args[0].endsWith('/chrome-background-client.js'));
    }
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = script => {
      scripts.push(script);
      queueMicrotask(async () => {
        const request = script.startsWith('{') ? JSON.parse(script) : undefined;
        if (request?.type === 'cancel') {
          const late = await forwardBrowserSession({ type: 'deliver-browser-session',
            accessToken: accessToken(), captureId: receivedId }, { directory, now: clock() });
          assert.equal(late.ok, false, 'The original socket must already be closed before cleanup');
          events.push('socket_closed');
          callback(cleanupError ? Error('PRIVATE-cleanup') : null, JSON.stringify({ status: cleanupStatus }));
          events.push('cleanup_callback');
          releaseCleanup = () => { events.push('cleanup_close'); child.emit('close'); };
          cleanupReady();
          if (!holdCleanupClose) releaseCleanup();
          return;
        }
        if (script.includes('count of windows')) {
          assert.equal(options.timeout, 2000);
          assert.equal(options.shell, false);
          events.push('window_proof');
          callback(proofError ? Error('PRIVATE-proof') : null,
            windowProof === 'malformed' ? 'not-json' : JSON.stringify({ status: windowProof }));
          releaseProof = () => { events.push('proof_close'); child.emit('close'); };
          proofReady();
          if (!holdProofClose) releaseProof();
          return;
        }
        if (request?.type !== 'start') {
          callback(null, '{"status":"encrypted_cache"}'); child.emit('close'); return;
        }
        const requestId = request.captureId;
        receivedId = requestId;
        captures++;
        if (deliverGrant) {
          const reply = await forwardBrowserSession({ type: 'deliver-browser-session',
            accessToken: accessToken(), captureId: requestId }, { directory, now: clock() });
          assert.equal(reply.ok, true);
        }
        if (abortBeforeCallback) controller.abort();
        callback(null, JSON.stringify({ status: typeof response === 'function' ? response(captures) : response }));
        events.push('helper_callback');
        releaseHelper = () => { events.push('helper_close'); child.emit('close'); };
        helperReady();
        if (!holdHelperClose) releaseHelper();
      });
    };
    return child;
  };
  return { session, saves, scripts, controller, events, execute, directory, helperCallback, cleanupCallback, proofCallback,
    releaseHelper: () => releaseHelper(), releaseCleanup: () => releaseCleanup(), releaseProof: () => releaseProof(),
    run: () => signinUsingChromeBridge({ session, execute, signal: controller.signal, directory, now: clock }) };
}

test('last-window native shutdown requires a valid grant and independently drained zero-window proof', async t => {
  for (const [response, cleanupStatus] of [
    ['ready', 'native_host_unavailable'], ['ready', 'cleanup_failed'],
    ['native_host_unavailable', 'native_host_unavailable'], ['native_host_unavailable', 'cleaned'],
  ]) {
    const f = await nativeFixture(t, { response, cleanupStatus,
      windowProof: 'cleaned', holdCleanupClose: true, holdProofClose: true });
    const running = f.run();
    await f.cleanupCallback;
    assert.equal(f.saves.length, 0);
    assert.equal(f.events.includes('window_proof'), false);
    f.releaseCleanup();
    await f.proofCallback;
    assert.equal(f.saves.length, 0);
    f.releaseProof();
    await running;
    assert.equal(f.saves.length, 1);
    assert.ok(f.events.indexOf('save') > f.events.indexOf('proof_close'));
    assert.match(f.scripts[2], /count of windows/);
    assert.doesNotMatch(f.scripts[2], /activate|make new|set |close window|minimized|javascript/);
  }
});

test('a replacement relay cannot acknowledge cleanup of a capture whose original transport was lost', async t => {
  const f = await nativeFixture(t, { response: 'native_host_unavailable', cleanupStatus: 'cleaned' });
  await assert.rejects(f.run(), error => error.code === 'cleanup_failed');
  assert.equal(f.saves.length, 0);
  assert.equal(f.events.includes('window_proof'), true);
});

test('zero-window cleanup proof fails closed on remaining windows, malformed replies or helper errors', async t => {
  for (const options of [{}, { windowProof: 'malformed' }, { proofError: true }]) {
    const f = await nativeFixture(t, { response: 'native_host_unavailable',
      cleanupStatus: 'native_host_unavailable', ...options });
    await assert.rejects(f.run(), error => error.code === 'cleanup_failed');
    assert.equal(f.saves.length, 0);
  }
});

test('zero-window verification cannot bypass an explicit account or persistence failure', async t => {
  for (const cleanupStatus of ['account_changed', 'invalid_grant', 'persistence_failed']) {
    const f = await nativeFixture(t, { response: 'native_host_unavailable', cleanupStatus, windowProof: 'cleaned' });
    await assert.rejects(f.run());
    assert.equal(f.events.includes('window_proof'), false);
    assert.equal(f.saves.length, 0);
  }
});

test('no grant or cancellation during zero-window verification can authorize persistence', async t => {
  const missing = await nativeFixture(t, { response: 'native_host_unavailable',
    cleanupStatus: 'native_host_unavailable', deliverGrant: false, windowProof: 'cleaned' });
  await assert.rejects(missing.run(), error => error.code === 'native_host_unavailable');
  assert.equal(missing.events.includes('window_proof'), false);
  assert.equal(missing.saves.length, 0);
  const aborted = await nativeFixture(t, { response: 'native_host_unavailable',
    cleanupStatus: 'native_host_unavailable', windowProof: 'cleaned', holdProofClose: true });
  const running = aborted.run();
  const rejected = assert.rejects(running, error => error.code === 'interrupted');
  await aborted.proofCallback;
  aborted.controller.abort();
  aborted.releaseProof();
  await rejected;
  assert.equal(aborted.saves.length, 0);
});

test('native-messaging handoff reaches only a pending private socket; worker alone saves after helper drainage', async t => {
  const f = await nativeFixture(t);
  await f.run();
  assert.equal(f.saves.length, 1);
  assert.equal(f.saves[0].authMode, 'browser');
  assert.equal(f.session.credentials.accessToken, token());
  assert.equal(f.scripts.length, 2);
  assert.equal(JSON.parse(f.scripts[1]).type, 'cancel');
  assert.equal((await forwardBrowserSession({ type: 'deliver-browser-session',
    captureId: f.saves[0].captureId, accessToken: token() }, { directory: f.directory })).ok, false);
});

test('save waits for helper close, socket shutdown and cleanup close independently', async t => {
  const f = await nativeFixture(t, { holdHelperClose: true, holdCleanupClose: true });
  const running = f.run();
  await f.helperCallback;
  await flush();
  assert.equal(f.scripts.length, 1);
  assert.equal(f.saves.length, 0);
  f.releaseHelper();
  await f.cleanupCallback;
  await flush();
  assert.equal(f.saves.length, 0);
  f.releaseCleanup();
  await running;
  assert.deepEqual(f.events, ['helper_callback', 'helper_close', 'socket_closed',
    'cleanup_callback', 'cleanup_close', 'save']);
});

test('abort while cleanup is held and cleanup failure both prevent all persistence', async t => {
  const f = await nativeFixture(t, { holdCleanupClose: true });
  const running = f.run();
  const rejected = assert.rejects(running, error => error.code === 'interrupted');
  await f.cleanupCallback;
  f.controller.abort();
  f.releaseCleanup();
  await rejected;
  assert.equal(f.saves.length, 0);
  assert.equal(f.session.credentials, undefined);
  const failed = await nativeFixture(t, { cleanupError: true });
  await assert.rejects(failed.run(), error => error.code === 'browser_failed' && !error.message.includes('PRIVATE'));
  assert.equal(failed.saves.length, 0);
  assert.equal(failed.session.credentials, undefined);
});

test('cache reuse never activates or changes user tabs and bridge requests contain only control metadata', async () => {
  assert.match(browserSessionScript(), /^if application "Google Chrome" is not running then return/);
  assert.doesNotMatch(browserSessionScript(), /activate|set active tab|set index|make new|close /);
  assert.deepEqual(JSON.parse(chromeBridgeRequest(captureId)), { type: 'start', captureId });
  assert.deepEqual(JSON.parse(chromeBridgeRequest(captureId, true)), { type: 'cancel', captureId });
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /worker may reopen ordinary Chrome/);
});

test('legacy refresh-token renewal never calls the Chrome authorization callback', async () => {
  let saved;
  const session = new WallySession({
    now: () => now,
    store: { load: () => ({ accessToken: token(), refreshToken: 'synthetic-refresh',
      expiresAt: Math.floor(now / 1000) * 1000 + 3600000 }), save: value => { saved = value; } },
    renewBrowserSession: () => assert.fail('Legacy OAuth must stay HTTP-only'),
    fetcher: async () => Response.json({ token_type: 'Bearer', access_token: token(),
      refresh_token: 'synthetic-rotated', expires_in: 3600 }),
  });
  await session.token(true);
  assert.equal(saved.refreshToken, 'synthetic-rotated');
  assert.equal(saved.authMode, undefined);
});

test('encrypted-cache handoff and expired browser renewal connect to confirmed HTTP-only booking, failing closed on renewal errors',
  async t => {
    for (const failRenewal of [false, true]) {
      let clock = now, persisted, renewals = 0, booked = false;
      const requests = [];
      const config = { office: 'Synthetic office', floor: 'Synthetic floor',
        officeId: 'synthetic-office', floorId: 'synthetic-floor' };
      const date = lisbonToday();
      const session = new WallySession({
        now: () => clock, store: { load: async () => persisted, save: async value => { persisted = value; } },
        fetcher: () => assert.fail('No synthetic refresh token or Microsoft request may be invented'),
      });
      const fixture = await nativeFixture(t, { session, clock: () => clock,
        accessToken: () => token({ exp: Math.floor(clock / 1000) + 3600 }),
        response: count => failRenewal && count > 1 ? 'capture_timeout' : 'ready' });
      session.renewBrowserSession = async () => { renewals++; await fixture.run(); return session.credentials; };
      await signinOnMac({ session, execute: fixture.execute, directory: fixture.directory,
        platform: 'darwin', now: () => clock });
      assert.equal(persisted.authMode, 'browser');
      assert.equal(persisted.refreshToken, undefined);
      assert.equal(fixture.saves.length, 1);
      const originalAccess = persisted.accessToken;
      clock += 3600001;
      const server = createServer(async (request, response) => {
        requests.push({ method: request.method, path: request.url });
        assert.equal(request.headers.authorization, `Bearer ${persisted.accessToken}`);
        assert.notEqual(persisted.accessToken, originalAccess);
        const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
        if (request.url === '/api/v1/offices') return json([{ id: config.officeId, name: config.office,
          floors: [{ id: config.floorId, name: config.floor }] }]);
        if (request.url.startsWith('/api/v1/me/schedule')) return json([{ date, ...(booked
          ? { booking: { id: 'synthetic-booking', deskNumber: '052', officeId: config.officeId, floorId: config.floorId } }
          : { availableDesks: [{ id: 'synthetic-desk052', number: '052' }] }) }]);
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/api/v1/me/bookings');
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        assert.equal(JSON.parse(Buffer.concat(chunks)).deskId, 'synthetic-desk052');
        booked = true;
        response.statusCode = 201;
        response.end();
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      try {
        const api = new WallyApi(config, { session, fetcher: (url, options) => {
          const parsed = new URL(url);
          assert.equal(parsed.origin, WALLY_ORIGIN);
          return fetch(`http://127.0.0.1:${server.address().port}${parsed.pathname}${parsed.search}`, options);
        } });
        if (failRenewal) {
          await assert.rejects(api.book({ date, desk: '052' }), error => error.code === 'capture_timeout');
          assert.equal(requests.length, 0);
          assert.equal(fixture.saves.length, 1);
        } else {
          assert.equal((await api.book({ date, desk: '052' })).status, 'confirmed');
          assert.equal(requests.filter(request => request.method === 'POST').length, 1);
          assert.equal(fixture.saves.length, 2);
          assert.equal(persisted.refreshToken, undefined);
        }
        assert.equal(renewals, 1);
        await api.close();
      } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    }
  });

test('abort or failed extension result discards a captured grant before Keychain save', async t => {
  for (const options of [{ abortBeforeCallback: true }, { response: 'capture_timeout' }]) {
    const f = await nativeFixture(t, options);
    await assert.rejects(f.run());
    assert.equal(f.saves.length, 0);
    assert.equal(f.session.credentials, undefined);
    assert.equal(JSON.parse(f.scripts.at(-1)).type, 'cancel');
  }
});

test('read-only Chrome cache and zero-window scripts compile without opening Chrome', { skip: process.platform !== 'darwin' }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wcb-compile-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync('/usr/bin/osacompile', ['-o', path.join(directory, 'cache.scpt')], {
    input: browserSessionScript(), encoding: 'utf8', timeout: 10000,
  });
  execFileSync('/usr/bin/osacompile', ['-o', path.join(directory, 'windows.scpt')], {
    input: chromeWindowsClosedScript(), encoding: 'utf8', timeout: 10000,
  });
});

test('startup validation reuses a valid stored browser grant; only explicit reauthentication forces Chrome', async () => {
  let renewals = 0;
  const stored = browserSession(token(), captureId, now);
  const next = browserSession(token({ exp: Math.floor(now / 1000) + 7200 }), captureId, now);
  const config = { officeId: 'o', office: 'Office', floorId: 'f', floor: 'Floor' };
  const session = new WallySession({ now: () => now, store: { load: async () => stored, save: async () => {} },
    renewBrowserSession: async () => { renewals++; return next; } });
  const api = new WallyApi(config, { session, fetcher: async () => new Response(JSON.stringify([
    { id: 'o', name: 'Office', floors: [{ id: 'f', name: 'Floor' }] }]),
  { status: 200, headers: { 'content-type': 'application/json' } }) });
  await api.reauthenticate({ force: false });
  assert.equal(renewals, 0, 'A restart with a valid grant must not open Chrome');
  await api.reauthenticate();
  assert.equal(renewals, 1);
});

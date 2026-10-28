import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { CHROME_EXTENSION_ID } from '../src/chrome-native-host.js';
import { WALLY_ORIGIN, WALLY_CLIENT_ID, WALLY_TENANT_ID } from '../src/wally-api.js';

async function exercise(t, mode) {
    const directory = await mkdtemp(path.join(tmpdir(), 'wally-extension-test-'));
    let context;
    t.after(async () => {
      await context?.close();
      await rm(directory, { recursive: true, force: true });
    });
    const extension = fileURLToPath(new URL('../chrome-extension/', import.meta.url));
    context = await chromium.launchPersistentContext(directory, {
      channel: 'chromium', headless: mode !== 'headed-native', viewport: null,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    await context.addCookies([{ name: 'synthetic-profile', value: 'same-normal-profile', url: WALLY_ORIGIN }]);
    const token = `header.${Buffer.from(JSON.stringify({
      aud: WALLY_CLIENT_ID, tid: WALLY_TENANT_ID, oid: 'synthetic-user',
      scp: 'Wally.User', exp: Math.floor(Date.now() / 1000) + 3600,
    })).toString('base64url')}.signature`;
    const requests = [];
    await context.route('https://**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      assert.equal(url.origin, WALLY_ORIGIN);
      assert.match(request.headers().cookie ?? '', /synthetic-profile=same-normal-profile/);
      requests.push({ method: request.method(), path: url.pathname });
      if (url.pathname === '/fixture-app.js') {
        return route.fulfill({ contentType: 'text/javascript', body:
          `setTimeout(() => fetch('/api/v1/offices', {headers:{Authorization:${JSON.stringify(`Bearer ${token}`)}}}), 250);` });
      }
      if (url.pathname === '/api/v1/offices') {
        assert.equal(request.method(), 'GET');
        return route.fulfill({ contentType: 'application/json', body: '[]' });
      }
      return route.fulfill({
        contentType: 'text/html',
        headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self'" },
        body: '<!doctype html><title>Synthetic Wally</title><script src="/fixture-app.js"></script><h1>Synthetic Wally</h1>',
      });
    });
    const background = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    assert.ok(background.url().startsWith(`chrome-extension://${CHROME_EXTENSION_ID}/`));
    await background.evaluate(mode => {
      const get = chrome.windows.get.bind(chrome.windows);
      if (mode === 'synthetic-state') {
        chrome.windows.get = async (...args) => {
          const actual = await get(...args);
          return args[0] === globalThis.syntheticWindowId
            ? { ...actual, state: 'minimized', focused: false } : actual;
        };
      }
      const getAll = chrome.windows.getAll.bind(chrome.windows);
      // The window modes exercise the windowless-Chrome fallback; the extension's host lookup filters by type.
      chrome.windows.getAll = async (...args) =>
        mode !== 'background-tab' && args[0]?.windowTypes ? [] : getAll(...args);
      const createTab = chrome.tabs.create.bind(chrome.tabs);
      chrome.tabs.create = async options => {
        globalThis.syntheticFocusBefore = (await chrome.windows.getLastFocused()).id;
        globalThis.syntheticTabOptions = options;
        const tab = await createTab(options);
        globalThis.syntheticTabId = tab.id;
        return tab;
      };
      const create = chrome.windows.create.bind(chrome.windows);
      chrome.windows.create = async options => {
        globalThis.syntheticFocusBefore = (await chrome.windows.getLastFocused()).id;
        globalThis.syntheticWindowOptions = options;
        const window = await create(options);
        globalThis.syntheticWindowId = window.id;
        return window;
      };
      const update = chrome.windows.update.bind(chrome.windows);
      chrome.windows.update = async (id, options) => {
        if (id !== globalThis.syntheticWindowId ||
            JSON.stringify(options) !== JSON.stringify({ state: 'minimized' })) {
          throw Error('Only owned state-only minimization is allowed');
        }
        return update(id, options);
      };
      const navigate = chrome.tabs.update.bind(chrome.tabs);
      chrome.tabs.update = async (id, options) => {
        if (globalThis.syntheticWindowId === undefined) return navigate(id, options);
        const actual = await chrome.windows.get(globalThis.syntheticWindowId);
        globalThis.syntheticWindowAtNavigation = { state: actual.state, focused: actual.focused };
        return navigate(id, options);
      };
      chrome.runtime.sendNativeMessage = async (host, message) => {
        globalThis.lastSyntheticHandoff = { host, message };
        globalThis.syntheticFocusDuring = (await chrome.windows.getLastFocused()).id;
        if (globalThis.syntheticTabId !== undefined) {
          globalThis.syntheticTabActiveAtHandoff = (await chrome.tabs.get(globalThis.syntheticTabId)).active;
          return { ok: true };
        }
        const actual = await chrome.windows.get(globalThis.syntheticWindowId);
        globalThis.syntheticWindowAtHandoff = { state: actual.state, focused: actual.focused };
        return { ok: true };
      };
    }, mode);
    const wally = await context.newPage();
    await Promise.all([
      wally.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/offices'),
      wally.goto(`${WALLY_ORIGIN}/homepage/book-a-desk`),
    ]);
    const secondWally = await context.newPage();
    await Promise.all([
      secondWally.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/offices'),
      secondWally.goto(`${WALLY_ORIGIN}/homepage/book-a-desk`),
    ]);
    const requestBaseline = requests.length;
    let userNavigations = 0;
    wally.on('framenavigated', () => userNavigations++);
    secondWally.on('framenavigated', () => userNavigations++);
    const helper = await context.newPage();
    const requestId = '12345678-1234-1234-1234-123456789abc';
    await helper.goto(`chrome-extension://${CHROME_EXTENSION_ID}/capture.html?request=${requestId}`);
    await helper.waitForFunction(() => document.body.dataset.status !== 'waiting', undefined, { timeout: 15000 });
    const status = await helper.getAttribute('body', 'data-status');
    if (mode === 'real-headless') {
      assert.equal(status, 'background_window_failed');
      const stopped = await background.evaluate(async () => ({
        handoff: globalThis.lastSyntheticHandoff ?? null,
        navigation: globalThis.syntheticWindowAtNavigation ?? null,
        ownedId: globalThis.syntheticWindowId,
        windows: (await chrome.windows.getAll()).map(window => window.id),
      }));
      assert.equal(stopped.handoff, null);
      assert.equal(stopped.navigation, null);
      assert.equal(stopped.windows.includes(stopped.ownedId), false);
      assert.equal(requests.length, requestBaseline, 'Unsupported minimization must not load Wally');
      assert.equal(userNavigations, 0);
      assert.equal((await context.pages()).includes(wally), true);
      assert.equal((await context.pages()).includes(secondWally), true);
      return;
    }
    assert.equal(status, 'ready');
    if (mode === 'background-tab') {
      const tabState = await background.evaluate(async () => ({
        options: globalThis.syntheticTabOptions,
        windowCreated: globalThis.syntheticWindowOptions !== undefined,
        ownedId: globalThis.syntheticTabId,
        activeAtHandoff: globalThis.syntheticTabActiveAtHandoff,
        focusBefore: globalThis.syntheticFocusBefore,
        focusDuring: globalThis.syntheticFocusDuring,
        tabs: (await chrome.tabs.query({})).map(tab => tab.id),
      }));
      assert.equal(tabState.windowCreated, false, 'An existing window must host the tab; no window may be created');
      assert.deepEqual({ ...tabState.options, windowId: 0 }, { windowId: 0, url: 'about:blank', active: false });
      assert.equal(tabState.activeAtHandoff, false, 'The authentication tab must stay in the background');
      assert.equal(tabState.focusDuring, tabState.focusBefore, 'Window focus must not change');
      assert.equal(tabState.tabs.includes(tabState.ownedId), false, 'Owned tab must close before ready');
      assert.equal(userNavigations, 0, 'Neither original Wally tab may reload or navigate');
      const handoff = await background.evaluate(() => globalThis.lastSyntheticHandoff);
      assert.deepEqual(handoff.message, { type: 'deliver-browser-session', captureId: requestId, accessToken: token });
      assert.equal((await context.pages()).includes(wally), true);
      assert.equal((await context.pages()).includes(secondWally), true);
      return;
    }
    const windowState = await background.evaluate(async () => ({
      options: globalThis.syntheticWindowOptions,
      ownedId: globalThis.syntheticWindowId,
      focusBefore: globalThis.syntheticFocusBefore,
      focusDuring: globalThis.syntheticFocusDuring,
      atNavigation: globalThis.syntheticWindowAtNavigation,
      atHandoff: globalThis.syntheticWindowAtHandoff,
      windows: (await chrome.windows.getAll()).map(window => window.id),
    }));
    assert.deepEqual(windowState.options, {
      url: 'about:blank', type: 'normal', focused: false, state: 'minimized',
    });
    assert.deepEqual(windowState.atNavigation, { state: 'minimized', focused: false });
    assert.deepEqual(windowState.atHandoff, { state: 'minimized', focused: false });
    if (mode === 'headed-native') {
      assert.equal(windowState.focusDuring, windowState.focusBefore, 'Chromium must retain the previously focused window');
    }
    assert.equal(windowState.windows.includes(windowState.ownedId), false, 'Owned window must close before ready');
    assert.equal(userNavigations, 0, 'Neither original Wally tab may reload or navigate');
    const handoff = await background.evaluate(() => globalThis.lastSyntheticHandoff);
    assert.equal(handoff.host, 'uk.togarriapahome.wally_auth');
    assert.deepEqual(handoff.message, { type: 'deliver-browser-session', captureId: requestId, accessToken: token });
    assert.doesNotMatch(await helper.textContent('body'), /header\.|signature|refresh_token/);
    assert.ok(requests.filter(request => request.path === '/api/v1/offices').length >= 1);
    assert.equal(requests.some(request => request.method !== 'GET'), false);
    assert.equal(requests.some(request => request.path.includes('bookings')), false);
    assert.equal((await context.pages()).includes(wally), true);
    assert.equal((await context.pages()).includes(secondWally), true);
}

test('real headless background tab in an existing window authorizes without new windows or focus changes',
  { timeout: 30000 }, t => exercise(t, 'background-tab'));

test('headless observer integration with explicitly synthetic owned-window state',
  { timeout: 30000 }, t => exercise(t, 'synthetic-state'));

test('real headless unsupported minimization fails closed without loading Wally',
  { timeout: 30000 }, t => exercise(t, 'real-headless'));

test('headed native minimized-window verification',
  { timeout: 30000, skip: process.env.WALLY_HEADED_NATIVE_TEST !== '1' },
  t => exercise(t, 'headed-native'));

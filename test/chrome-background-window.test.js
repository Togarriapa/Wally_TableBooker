import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { setImmediate as flush } from 'node:timers/promises';
import { CHROME_EXTENSION_ID } from '../src/chrome-native-host.js';
import { WALLY_ORIGIN } from '../src/wally-api.js';

const captureId = '12345678-1234-1234-1234-123456789abc';
const event = () => {
  const callbacks = [];
  return { addListener: callback => callbacks.push(callback),
    emit: (...args) => callbacks.map(callback => callback(...args)) };
};

async function fixture({ holdCreation = false, removeFails = false, nativeRejects = false,
  minimizeFails = false, holdMinimization = false, settlingReads = 0, hostWindow = false } = {}) {
  const events = [], timers = [], reports = [];
  const disconnected = event(), nativeMessage = event();
  let releaseCreation, releaseMinimization, receive;
  const tabs = [{ id: 1, windowId: 10 }, { id: 2, windowId: 10 }];
  const port = { onMessage: nativeMessage, onDisconnect: disconnected,
    postMessage: message => reports.push(message) };
  const chrome = {
    action: { onClicked: event() },
    runtime: {
      id: CHROME_EXTENSION_ID, onConnect: event(), onStartup: event(), onInstalled: event(),
      connectNative: () => port,
      onMessage: { addListener: callback => { receive = callback; } },
      sendNativeMessage: async () => {
        events.push('grant');
        return nativeRejects ? { ok: false, code: 'invalid_grant' } : { ok: true };
      },
    },
    windows: { getAll: async options => {
      assert.deepEqual(JSON.parse(JSON.stringify(options)), { windowTypes: ['normal'] });
      return hostWindow ? [{ id: 10, state: 'normal', focused: true }] : [];
    }, create: options => {
      assert.equal(hostWindow, false, 'Must not create a window while a user window can host a background tab');
      assert.deepEqual(JSON.parse(JSON.stringify(options)), {
        url: 'about:blank', type: 'normal', focused: false, state: 'minimized',
      });
      events.push('creating');
      return new Promise(resolve => {
        releaseCreation = () => {
          tabs.push({ id: 3, windowId: 20 });
          events.push('created');
          resolve({ id: 20, tabs: [{ id: 3 }] });
        };
        if (!holdCreation) releaseCreation();
      });
    }, update: async (id, options) => {
      assert.equal(hostWindow, false, 'Never minimize or refocus a window hosting a background tab');
      assert.equal(id, 20, 'Never change an existing user window');
      assert.deepEqual(JSON.parse(JSON.stringify(options)), { state: 'minimized' },
        'Updating focused:false deactivates Chrome; only request owned-window minimization');
      if (minimizeFails === 'throw') throw Error('Synthetic minimization failure');
      if (holdMinimization) await new Promise(resolve => { releaseMinimization = resolve; });
    }, get: async id => {
      assert.equal(id, 20);
      return { state: minimizeFails === 'normal' || settlingReads-- > 0 ? 'normal' : 'minimized',
        focused: minimizeFails === 'focused' };
    } },
    tabs: {
      create: async options => {
        assert.equal(hostWindow, true, 'Only an existing user window may host the authentication tab');
        assert.deepEqual(JSON.parse(JSON.stringify(options)), { windowId: 10, url: 'about:blank', active: false },
          'The authentication tab must never become active or focus its window');
        tabs.push({ id: 3, windowId: 10 });
        events.push('created-tab');
        return { id: 3, windowId: 10 };
      },
      reload: () => assert.fail('Must not reload any user tab'),
      update: async (id, options) => {
        assert.equal(id, 3);
        assert.deepEqual(JSON.parse(JSON.stringify(options)), { url: `${WALLY_ORIGIN}/homepage/book-a-desk` });
        events.push('navigate-owned');
      },
      query: async ({ windowId }) => tabs.filter(tab => windowId === undefined || tab.windowId === windowId),
      sendMessage: async () => {},
      remove: async ids => {
        if (removeFails) throw Error('Synthetic cleanup failure');
        for (const id of ids) {
          assert.equal(id, 3, 'Only the newly created authentication tab may close');
          tabs.splice(tabs.findIndex(tab => tab.id === id), 1);
        }
        events.push('closed');
      },
    },
  };
  const source = await readFile(new URL('../chrome-extension/background.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    chrome, URL, console: { warn: () => events.push('warning') },
    setTimeout: (callback, ms) => {
      if (ms === 100) { void flush().then(callback); return callback; }
      timers.push(callback); return callback;
    }, clearTimeout: () => {},
  });
  assert.deepEqual(JSON.parse(JSON.stringify(reports.shift())), { type: 'listen-browser-requests' });
  return { tabs, events, reports, timers,
    allowCleanup: () => { removeFails = false; },
    start: async () => { nativeMessage.emit({ type: 'start', captureId }); await flush(); },
    cancel: async () => { nativeMessage.emit({ type: 'cancel', captureId }); await flush(); },
    disconnect: async () => { disconnected.emit(); await flush(); },
    release: () => releaseCreation(),
    releaseMinimization: () => releaseMinimization(),
    grant: async (sender = { tab: { id: 3 }, frameId: 0, url: `${WALLY_ORIGIN}/homepage/book-a-desk` }) => {
      receive({ type: 'grant', requestId: captureId, accessToken: 'synthetic-only' }, sender, () => {});
      await flush();
    },
  };
}

test('background completion closes only owned tabs before reporting, preserving extra user tabs', async () => {
  const f = await fixture();
  await f.start();
  f.tabs.push({ id: 4, windowId: 20 });
  await f.grant();
  assert.deepEqual(f.tabs.map(tab => tab.id), [1, 2, 4]);
  assert.deepEqual(f.events, ['creating', 'created', 'navigate-owned', 'grant', 'closed']);
  assert.equal(f.reports.at(-1).code, 'ready');
});

test('cancellation waits for pending window creation and never navigates it afterward', async () => {
  const f = await fixture({ holdCreation: true });
  await f.start();
  await f.cancel();
  assert.equal(f.reports.length, 0);
  f.release();
  await flush();
  assert.deepEqual(f.events, ['creating', 'created', 'closed']);
  assert.deepEqual(f.tabs.map(tab => tab.id), [1, 2]);
  assert.equal(f.reports.at(-1).code, 'interrupted');
});

test('moved authentication tabs retain ownership and cannot escape cleanup or its failure gate', async () => {
  for (const removeFails of [false, true]) {
    const f = await fixture({ removeFails });
    await f.start();
    f.tabs.push({ id: 4, windowId: 20 });
    f.tabs.find(tab => tab.id === 3).windowId = 10;
    await f.grant();
    assert.equal(f.reports.at(-1).code, removeFails ? 'cleanup_failed' : 'ready');
    assert.deepEqual(f.tabs.map(tab => tab.id), removeFails ? [1, 2, 3, 4] : [1, 2, 4]);
    if (removeFails) {
      f.allowCleanup();
      await f.cancel();
      assert.deepEqual(f.tabs.map(tab => tab.id), [1, 2, 4]);
    }
  }
});

test('timeout, rejected grant and native disconnection all clean owned tabs', async () => {
  for (const outcome of ['timeout', 'reject', 'disconnect']) {
    const f = await fixture({ nativeRejects: outcome === 'reject' });
    await f.start();
    if (outcome === 'timeout') { f.timers[0](); await flush(); }
    else if (outcome === 'reject') await f.grant();
    else await f.disconnect();
    assert.deepEqual(f.tabs.map(tab => tab.id), [1, 2]);
    assert.equal(f.reports.at(-1).code,
      outcome === 'timeout' ? 'capture_timeout' : outcome === 'reject' ? 'invalid_grant' : 'interrupted');
  }
});

test('failed cleanup is reported as failure, never ready', async () => {
  const f = await fixture({ removeFails: true });
  await f.start();
  await f.grant();
  assert.equal(f.reports.at(-1).code, 'cleanup_failed');
  assert.ok(f.events.includes('warning'));
  f.allowCleanup();
  await f.cancel();
  assert.equal(f.reports.at(-1).code, 'interrupted');
  assert.deepEqual(f.tabs.map(tab => tab.id), [1, 2]);
});

test('minimization settles before navigation without deactivating Chrome or changing user windows', async () => {
  const f = await fixture({ settlingReads: 2 });
  await f.start();
  assert.equal(f.events.includes('navigate-owned'), false);
  for (let i = 0; i < 4; i++) await flush();
  assert.equal(f.events.includes('navigate-owned'), true);
  await f.cancel();
  assert.deepEqual(f.tabs.map(tab => tab.id), [1, 2]);
});

test('failed or focused minimization fails explicitly before Wally navigation and cleans up', async () => {
  for (const minimizeFails of ['normal', 'focused', 'throw']) {
    const f = await fixture({ minimizeFails });
    await f.start();
    for (let i = 0; i < 25; i++) await flush();
    assert.deepEqual(f.events, ['creating', 'created', 'closed']);
    assert.deepEqual(f.tabs.map(tab => tab.id), [1, 2]);
    assert.equal(f.reports.at(-1).code, 'background_window_failed');
  }
});

test('cancellation during minimization prevents late navigation and preserves user tabs', async () => {
  const f = await fixture({ holdMinimization: true });
  await f.start();
  await f.cancel();
  f.releaseMinimization();
  await flush();
  assert.deepEqual(f.events, ['creating', 'created', 'closed']);
  assert.deepEqual(f.tabs.map(tab => tab.id), [1, 2]);
  assert.equal(f.reports.at(-1).code, 'interrupted');
});

test('cleanup failure cannot revive a cancelled pending minimization or accept a late grant', async () => {
  const f = await fixture({ holdMinimization: true, removeFails: true });
  await f.start();
  await f.cancel();
  assert.equal(f.reports.at(-1).code, 'cleanup_failed');
  f.releaseMinimization();
  await flush();
  assert.equal(f.events.includes('navigate-owned'), false);
  await f.grant();
  assert.equal(f.events.includes('grant'), false);
  f.allowCleanup();
  await f.cancel();
  assert.deepEqual(f.tabs.map(tab => tab.id), [1, 2]);
});

test('existing Wally tabs, foreign origins, wrong requests and subframes cannot hand off a grant', async () => {
  const f = await fixture();
  await f.start();
  for (const sender of [
    { tab: { id: 1 }, frameId: 0, url: `${WALLY_ORIGIN}/homepage/book-a-desk` },
    { tab: { id: 3 }, frameId: 1, url: `${WALLY_ORIGIN}/homepage/book-a-desk` },
    { tab: { id: 3 }, frameId: 0, url: 'https://elsewhere.invalid/' },
  ]) await f.grant(sender);
  assert.equal(f.events.includes('grant'), false);
  await f.cancel();
});

test('an existing user window hosts an inactive tab without creating, minimizing or focusing windows', async () => {
  const f = await fixture({ hostWindow: true });
  await f.start();
  f.tabs.push({ id: 4, windowId: 10 });
  await f.grant();
  assert.deepEqual(f.events, ['created-tab', 'navigate-owned', 'grant', 'closed']);
  assert.deepEqual(f.tabs.map(tab => tab.id), [1, 2, 4]);
  assert.equal(f.reports.at(-1).code, 'ready');
});

test('background-tab cancellation and failed cleanup close only the owned tab', async () => {
  const cancelled = await fixture({ hostWindow: true });
  await cancelled.start();
  await cancelled.cancel();
  assert.deepEqual(cancelled.tabs.map(tab => tab.id), [1, 2]);
  assert.equal(cancelled.reports.at(-1).code, 'interrupted');
  const stuck = await fixture({ hostWindow: true, removeFails: true });
  await stuck.start();
  await stuck.grant();
  assert.equal(stuck.reports.at(-1).code, 'cleanup_failed');
  stuck.allowCleanup();
  await stuck.cancel();
  assert.deepEqual(stuck.tabs.map(tab => tab.id), [1, 2]);
});

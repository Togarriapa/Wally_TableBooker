const ORIGIN = 'https://wally.criticaltechworks.com';
const HOST = 'uk.togarriapahome.wally_auth';
let active;
let bridge;
let reconnectTimer;
let reconnectDelay = 1000;

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('capture.html') });
});

function finish(code) {
  const capture = active;
  if (!capture) return Promise.resolve();
  capture.stopping = true;
  if (capture.finishing) return capture.finishing;
  capture.finishing = (async () => {
    clearTimeout(capture.timer);
    if (capture.tabId !== undefined) {
      chrome.tabs.sendMessage(capture.tabId, { type: 'stop', requestId: capture.requestId }).catch(() => {});
    }
    let window;
    try { window = await capture.creation; }
    catch { code = 'browser_failed'; }
    if (window) {
      try {
        const owned = window.tabs?.map(tab => tab.id);
        if (!owned?.length || owned.some(id => !Number.isInteger(id))) throw Error('Missing owned tabs');
        const remaining = await chrome.tabs.query({});
        const ids = remaining.filter(tab => owned.includes(tab.id)).map(tab => tab.id);
        if (ids.length) {
          try { await chrome.tabs.remove(ids); }
          catch {
            const stillOpen = await chrome.tabs.query({});
            if (stillOpen.some(tab => ids.includes(tab.id))) throw Error('Owned tabs remain');
          }
          const stillOpen = await chrome.tabs.query({});
          if (stillOpen.some(tab => owned.includes(tab.id))) throw Error('Owned tabs remain');
        }
      } catch {
        console.warn('Wally authorization cleanup could not be confirmed.');
        code = 'cleanup_failed';
      }
    }
    if (code === 'cleanup_failed') capture.finishing = undefined;
    else active = undefined;
    try { capture.report(code); }
    catch { console.warn('Wally authorization completion channel disconnected.'); }
  })();
  return capture.finishing;
}

async function start(requestId, report, owner) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId ?? '')) {
    report('invalid_request'); return;
  }
  if (active) { report('busy'); return; }
  const capture = { requestId, report, owner };
  active = capture;
  capture.timer = setTimeout(() => { if (active === capture) void finish('capture_timeout'); }, 45000);
  let failure = 'browser_failed';
  try {
    // Creating and minimizing a window on macOS animates and reshuffles the user's windows, so
    // prefer an inactive tab in an existing window; only a windowless Chrome gets a minimized window.
    capture.creation = (async () => {
      const host = (await chrome.windows.getAll({ windowTypes: ['normal'] }))
        .find(candidate => candidate.state !== 'minimized') ?? null;
      if (!host) return chrome.windows.create({ url: 'about:blank', type: 'normal', focused: false, state: 'minimized' });
      const tab = await chrome.tabs.create({ windowId: host.id, url: 'about:blank', active: false });
      return { tabs: [tab] };
    })();
    const window = await capture.creation;
    if (capture.stopping) return;
    capture.tabId = window.tabs?.[0]?.id;
    if (!Number.isInteger(capture.tabId)) throw Error('Missing owned tab');
    if (window.id === undefined) {
      await chrome.tabs.update(capture.tabId, { url: `${ORIGIN}/homepage/book-a-desk` });
      return;
    }
    failure = 'background_window_failed';
    await chrome.windows.update(window.id, { state: 'minimized' });
    let minimized = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (capture.stopping) return;
      const current = await chrome.windows.get(window.id);
      if (capture.stopping) return;
      if (current.state === 'minimized' && !current.focused) { minimized = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (capture.stopping) return;
    if (!minimized) throw Error('Authentication window is not minimized');
    failure = 'browser_failed';
    await chrome.tabs.update(capture.tabId, { url: `${ORIGIN}/homepage/book-a-desk` });
  } catch { if (active === capture) await finish(failure); }
}

function scheduleReconnect() {
  if (bridge || reconnectTimer !== undefined) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(delay * 2, 15000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectBridge();
  }, delay);
}

function connectBridge() {
  if (bridge || reconnectTimer !== undefined) return;
  let port;
  try { port = chrome.runtime.connectNative(HOST); }
  catch {
    console.warn('Wally native connection failed; reconnecting automatically.');
    scheduleReconnect();
    return;
  }
  bridge = port;
  const failed = () => {
    if (bridge !== port) return;
    bridge = undefined;
    if (active?.owner === port) void finish('interrupted');
    try { port.disconnect(); }
    catch { console.warn('Wally disconnected native port could not be released.'); }
    console.warn('Wally background authentication relay disconnected; reconnecting automatically.');
    scheduleReconnect();
  };
  port.onMessage.addListener(message => {
    if (bridge !== port) return;
    if (message.type === 'listening') {
      reconnectDelay = 1000;
    } else if (message.type === 'start') {
      void start(message.captureId, code => {
        try { port.postMessage({ type: 'complete', captureId: message.captureId, code }); }
        catch {
          failed();
          console.warn('Wally native completion channel disconnected.');
        }
      }, port);
    } else if (message.type === 'cancel' && active?.owner === port &&
        active.requestId === message.captureId) {
      void finish('interrupted');
    }
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    failed();
  });
  try { port.postMessage({ type: 'listen-browser-requests' }); }
  catch { failed(); }
}

chrome.runtime.onStartup.addListener(connectBridge);
chrome.runtime.onInstalled.addListener(connectBridge);
connectBridge();

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'wally-capture' || !port.sender?.url ||
      new URL(port.sender.url).pathname !== '/capture.html' ||
      new URL(port.sender.url).protocol !== 'chrome-extension:' ||
      new URL(port.sender.url).hostname !== chrome.runtime.id) {
    port.disconnect();
    return;
  }
  port.onDisconnect.addListener(() => {
    if (active?.owner === port) void finish('interrupted');
  });
  port.onMessage.addListener(message => {
    if (message.type !== 'start') return;
    void start(message.requestId, code => port.postMessage({ code }), port);
  });
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const capture = active;
  if (!capture || capture.stopping || sender.tab?.id !== capture.tabId || sender.frameId !== 0 ||
      !sender.url || new URL(sender.url).origin !== ORIGIN) return;
  if (message.type === 'ready') { reply({ requestId: capture.requestId }); return; }
  if (message.requestId !== capture.requestId) return;
  if (message.type === 'timeout') { finish('capture_timeout'); return; }
  if (message.type !== 'grant' || capture.saving || typeof message.accessToken !== 'string' ||
      message.accessToken.length > 24000) return;
  capture.saving = true;
  chrome.runtime.sendNativeMessage(HOST, {
    type: 'deliver-browser-session', captureId: capture.requestId, accessToken: message.accessToken,
  }).then(result => {
    if (active === capture) finish(result?.ok === true ? 'ready' : result?.code ?? 'persistence_failed');
  }).catch(() => { if (active === capture) finish('native_host_unavailable'); });
});

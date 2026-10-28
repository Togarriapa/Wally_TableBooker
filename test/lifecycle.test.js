import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptsCommandEvent, commandFromEvent, dispatchCommand, isTransientHaError, lisbonToday, serveWorker, validateCommand } from '../src/worker.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('power-managed transport never executes an original command before wake confirmation', () => {
  const event = (id, type, action) => ({ id, type: 'event', event: {
    event_type: type, data: type === 'wally_local_awake_command' ? { command: { action } } : { action }
  } });
  assert.equal(acceptsCommandEvent(event(1, 'wally_local_command', 'cancel'), true), false);
  assert.equal(acceptsCommandEvent(event(1, 'wally_local_command', 'ping'), true), true);
  assert.equal(acceptsCommandEvent(event(2, 'wally_local_awake_command', 'cancel'), true), true);
  assert.equal(acceptsCommandEvent(event(2, 'wally_local_awake_command', 'ping'), true), false);
  assert.equal(acceptsCommandEvent(event(1, 'wally_local_command', 'cancel'), false), true);
  assert.equal(acceptsCommandEvent(event(2, 'wally_local_awake_command', 'cancel'), false), false);
  assert.equal(acceptsCommandEvent(event(1, 'unrelated_event', 'cancel'), true), false);
});

test('confirmed envelope preserves the complete original command and strict validation', () => {
  const command = {
    id: '12345678', action: 'retry_all', issued_at: new Date().toISOString(),
    target: { reservations: [{ date: '2099-10-21', expected_desk: '055' }] }
  };
  const message = { id: 2, type: 'event', event: {
    event_type: 'wally_local_awake_command', data: { command }
  } };
  assert.equal(acceptsCommandEvent(message, true), true);
  assert.equal(commandFromEvent(message), command);
  validateCommand(commandFromEvent(message));
  command.unexpected = 'must not be dropped';
  assert.throws(() => validateCommand(commandFromEvent(message)), /Unexpected command fields/);
  delete command.unexpected;
  command.issued_at = new Date(Date.now() - 301000).toISOString();
  assert.throws(() => validateCommand(commandFromEvent(message)), /Expired/);
});

test('wake probe acknowledges its exact command without API or booking side effects', async () => {
  const writes = [];
  await dispatchCommand({ id: 'wake-probe-test-1', action: 'ping', issued_at: new Date().toISOString() }, {
    ledger: { claim: async () => true },
    client: { snapshot: () => assert.fail('Probe cannot call Wally') },
    ha: { publish: async (...args) => writes.push(args), preferences: () => assert.fail('Probe cannot plan bookings') },
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 'sensor.wally_worker_heartbeat');
  assert.equal(writes[0][2].probe_id, 'wake-probe-test-1');
  assert.equal(writes[0][2].transport, 'direct_http');
  assert.ok(Number.isFinite(Date.parse(writes[0][2].last_seen)));
});
function fixture() {
  const controller = new AbortController();
  const writes = [];
  const intervals = new Map();
  let closed = false;
  const config = { allowBooking: false, officeId: '0GKKEDNM3E8D5', floorId: '0GKKEDQZKE8DD' };
  const client = {
    reauthenticate: async () => {},
    snapshot: async () => [],
    book: () => assert.fail('Booking-disabled startup must not create reservations'),
    close: async () => { closed = true; },
  };
  const ha = {
    publish: async (...args) => { writes.push(args); },
    preferences: async () => ({ config, automaticEnabled: false }),
    listen: async (_onCommand, signal, onReady) => {
      if (signal.aborted) return;
      onReady();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    },
  };
  return {
    controller, client, ha, writes, intervals, isClosed: () => closed,
    config,
    ledger: { claim: async () => true },
    now: () => new Date('2026-12-01T12:00:00Z'),
    timers: {
      setInterval: (callback, interval) => { intervals.set(interval, callback); return interval; },
      clearInterval: interval => intervals.delete(interval),
    },
  };
}

test('startup and a dispatched wake probe execute under an injected power lease', async () => {
  const f = fixture();
  let depth = 0;
  let leases = 0;
  f.power = {
    run: async operation => { leases++; depth++; try { return await operation(); } finally { depth--; } },
    status: async () => ({ power_error: false }),
  };
  f.client.reauthenticate = async () => assert.equal(depth, 1);
  const publish = f.ha.publish;
  f.ha.publish = async (...args) => {
    await publish(...args);
    if (args[2]?.probe_id === 'managed-probe-test') {
      assert.equal(depth, 1);
      f.controller.abort();
    }
  };
  f.ha.listen = async (onCommand, signal, onReady) => {
    onReady();
    onCommand({ id: 'managed-probe-test', action: 'ping', issued_at: new Date().toISOString() });
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  };
  await serveWorker(f);
  assert.ok(leases >= 2);
  assert.equal(depth, 0);
});

test('failed power acquisition prevents startup API authentication', async () => {
  const f = fixture();
  f.power = { run: async () => { throw new Error('No power assertion'); } };
  f.client.reauthenticate = () => assert.fail('Unprotected API work cannot start');
  await assert.rejects(serveWorker(f), /No power assertion/);
  assert.equal(f.isClosed(), true);
});

test('scheduled commands cannot overlap startup API authentication', async () => {
  const f = fixture();
  const navigation = deferred();
  f.client.reauthenticate = () => navigation.promise;
  const running = serveWorker(f);
  await flush();
  assert.equal(f.intervals.size, 0);
  navigation.resolve();
  await flush();
  assert.equal(f.intervals.size, 1);
  assert.equal(f.intervals.has(20_000), false, 'Home Assistant is the sole clock scheduler');
  assert.ok(f.writes.some(([entity, state]) => entity === 'sensor.wally_status' && state === 'ready'));
  f.controller.abort();
  await running;
  assert.equal(f.intervals.size, 0);
  assert.equal(f.isClosed(), true);
});

test('startup publishes pending reservation recovery before ready can clear attention', async () => {
  const f = fixture();
  f.reservationState = { data: { excludedDates: [], pending: { date: '2026-12-01', desk: '052' } } };
  f.client.snapshot = async () => { throw new Error('Recovery still needs attention'); };
  const running = serveWorker(f);
  await flush();
  f.controller.abort();
  await running;
  const ready = f.writes.findIndex(([entity, state]) => entity === 'sensor.wally_status' && state === 'ready');
  const recovery = f.writes.findIndex(([entity]) => entity === 'sensor.wally_reservation_recovery');
  assert.ok(recovery >= 0 && ready > recovery);
  assert.notEqual(f.writes[recovery][1], 'clear');
});

test('shutdown skips commands queued behind an in-flight refresh', async () => {
  const f = fixture();
  const refresh = deferred();
  let claims = 0;
  f.ledger.claim = async command => { if (command.action === 'refresh') claims++; return true; };
  f.client.snapshot = () => refresh.promise;
  f.ha.listen = async (onCommand, signal, onReady) => {
    onReady();
    onCommand({ id: 'first-refresh', action: 'refresh' });
    onCommand({ id: 'second-refresh', action: 'refresh' });
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  };
  const running = serveWorker(f);
  await flush();
  assert.equal(claims, 1);
  f.controller.abort();
  refresh.resolve([]);
  await running;
  assert.equal(claims, 1);
  assert.equal(f.isClosed(), true);
});
test('personal sign-in remains serialized under the power lease and shutdown cancels it before queued API work', async () => {
  const f = fixture();
  const grant = deferred();
  let enqueue;
  let started = false;
  let depth = 0;
  f.power = {
    run: async operation => { depth++; try { return await operation(); } finally { depth--; } },
    status: async () => ({ power_error: false }),
  };
  f.personalSignin = async ({ signal, onPrompt }) => {
    assert.equal(depth, 1);
    started = true;
    signal.addEventListener('abort', grant.resolve, { once: true });
    await onPrompt();
    await grant.promise;
    signal.throwIfAborted();
  };
  f.client.snapshot = () => assert.fail('Queued refresh cannot overlap or outlive personal sign-in');
  f.client.verifyLocation = () => assert.fail('Aborted sign-in cannot verify location');
  f.ha.listen = async (onCommand, signal, onReady) => {
    enqueue = onCommand;
    onReady();
    onCommand({ id: 'personal-signin-test', action: 'signin', issued_at: new Date().toISOString() });
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  };
  const running = serveWorker(f);
  await flush();
  assert.equal(started, true);
  enqueue({ id: 'queued-refresh-test', action: 'refresh', issued_at: new Date().toISOString() });
  await flush();
  f.controller.abort();
  await running;
  assert.equal(depth, 0);
  assert.equal(f.isClosed(), true);
  assert.equal(f.intervals.size, 0);
});

test('online heartbeat waits for subscription acknowledgement, including interval callbacks', async () => {
  const f = fixture();
  let acknowledge;
  let receive;
  let claims = 0;
  f.ledger.claim = async () => { claims++; return true; };
  f.ha.listen = async (onCommand, signal, onReady) => {
    receive = onCommand;
    acknowledge = onReady;
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  };
  const heartbeats = () => f.writes.filter(([entity]) => entity === 'sensor.wally_worker_heartbeat');
  const running = serveWorker(f);
  await flush();
  const interval = f.intervals.get(60_000);
  assert.equal(typeof acknowledge, 'function');
  assert.equal(typeof interval, 'function');
  assert.deepEqual(heartbeats(), []);
  interval();
  await flush();
  assert.deepEqual(heartbeats(), [], 'Pending subscription must not advertise online');
  assert.equal(claims, 0, 'Pending subscription must not queue a catch-up');
  acknowledge();
  await flush();
  assert.deepEqual(heartbeats().map(([, state]) => state), ['online']);
  acknowledge();
  await flush();
  assert.equal(heartbeats().length, 1, 'Readiness notification must be idempotent');
  interval();
  await flush();
  assert.deepEqual(heartbeats().map(([, state]) => state), ['online', 'online']);
  f.controller.abort();
  await running;
  const writesAfterShutdown = f.writes.length;
  acknowledge();
  interval();
  receive({ id: 'late-refresh', action: 'refresh' });
  await flush();
  assert.equal(f.writes.length, writesAfterShutdown);
  assert.equal(claims, 1, 'Only the acknowledged connection catch-up was claimed');
  assert.equal(heartbeats().at(-1)[1], 'offline');
});

test('shutdown while subscription is pending never publishes online, even on a late acknowledgement', async () => {
  const f = fixture();
  let acknowledge;
  f.ha.listen = async (_onCommand, signal, onReady) => {
    acknowledge = onReady;
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  };
  const running = serveWorker(f);
  await flush();
  const interval = f.intervals.get(60_000);
  assert.equal(typeof acknowledge, 'function');
  f.controller.abort();
  acknowledge();
  interval();
  await running;
  const heartbeats = f.writes.filter(([entity]) => entity === 'sensor.wally_worker_heartbeat');
  assert.deepEqual(heartbeats.map(([, state]) => state), ['offline']);
});

for (const delayedOnline of [1, 2]) {
  test(`offline heartbeat drains in-flight ${delayedOnline === 1 ? 'initial' : 'periodic'} online publication`, async () => {
    const f = fixture();
    const delayed = deferred();
    let online = 0;
    f.ha.publish = async (...args) => {
      if (args[0] === 'sensor.wally_worker_heartbeat' && args[1] === 'online' && ++online === delayedOnline) {
        await delayed.promise;
      }
      f.writes.push(args);
    };
    const running = serveWorker(f);
    await flush();
    if (delayedOnline === 2) {
      f.intervals.get(60_000)();
      await flush();
    }
    assert.equal(online, delayedOnline);
    f.controller.abort();
    await flush();
    assert.equal(f.writes.some(([entity, state]) => entity === 'sensor.wally_worker_heartbeat' && state === 'offline'), false);
    assert.equal(f.isClosed(), false);
    delayed.resolve();
    await running;
    const heartbeats = f.writes.filter(([entity]) => entity === 'sensor.wally_worker_heartbeat');
    assert.deepEqual(heartbeats.map(([, state]) => state), [
      ...Array(delayedOnline).fill('online'), 'offline',
    ]);
    assert.equal(f.isClosed(), true);
  });
}

test('00:01 startup cannot bypass the local booking gate', async () => {
  const f = fixture();
  let bookingCalls = 0;
  Object.assign(f.config, {
    desk: '001',
    fallbackDesks: '',
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    horizonDays: 1,
  });
  f.client.snapshot = async () => [
    { date: lisbonToday(), booked: false, available: ['001'] },
  ];
  f.client.book = async item => {
    bookingCalls++;
    return { ...item, status: 'confirmed' };
  };
  f.now = () => new Date('2026-12-02T00:01:00Z');
  f.ha.preferences = async () => ({ config: f.config, automaticEnabled: true });
  f.ha.listen = async (onCommand, signal, onReady) => {
    onReady();
    onCommand({ id: 'scheduled-ha-booking', action: 'book', issued_at: new Date().toISOString() });
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  };
  const running = serveWorker(f);
  await flush();
  assert.ok(f.writes.some(([entity, state]) => entity === 'sensor.wally_status' && state === 'attention_required'));
  f.controller.abort();
  await running;
  assert.equal(bookingCalls, 0, 'Booking-disabled startup must not attempt a reservation');
});

function bookingFixture() {
  const f = fixture();
  Object.assign(f.config, {
    allowBooking: true, office: 'Lisbon - KTower', floor: 'Floor 08',
    desk: '052', fallbackDesks: '055', weekdays: [1, 2, 3, 4, 5, 6, 7], horizonDays: 10,
  });
  const day = offset => new Date(Date.parse(`${lisbonToday()}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
  f.cards = [
    { date: day(0), booked: true, desk: '099', available: [] },
    { date: day(1), booked: false, available: ['052', '055'] },
    { date: day(2), booked: false, available: ['052'] },
  ];
  f.reservationState = { data: { excludedDates: [day(2)], pending: null } };
  f.commands = [];
  f.books = [];
  f.ledger.claim = async command => {
    validateCommand(command, f.now().getTime());
    f.commands.push(command);
    return true;
  };
  f.ha.preferences = async () => ({ config: f.config, automaticEnabled: true });
  f.ha.syncReservations = async () => {};
  f.client.snapshot = async () => structuredClone(f.cards);
  f.client.cancel = () => assert.fail('Reconnect Book Missing must never cancel a reservation');
  f.client.book = async item => {
    f.books.push(item);
    Object.assign(f.cards.find(c => c.date === item.date), { booked: true, desk: item.desk });
    return { ...item, status: 'confirmed' };
  };
  return f;
}

test('acknowledged reconnection at an arbitrary time books only missing unpaused dates using current preferences', async () => {
  const f = bookingFixture();
  f.config.desk = '055';
  const running = serveWorker(f);
  await flush();
  assert.equal(f.commands.length, 1);
  assert.match(f.commands[0].id, /^scheduled-reconnect-/);
  assert.equal(f.commands[0].issued_at, f.now().toISOString());
  assert.deepEqual(f.books, [{ date: f.cards[1].date, status: 'would_book', desk: '055' }]);
  assert.equal(f.cards[0].desk, '099');
  assert.equal(f.cards[2].booked, false);
  const result = f.writes.find(w => w[0] === 'sensor.wally_last_result');
  assert.equal(result[1], 'book');
  assert.equal(result[2].command_id, f.commands[0].id);
  assert.deepEqual(result[2].outcomes.map(o => o.status), ['preserved', 'confirmed', 'paused']);
  f.controller.abort();
  await running;
});

test('reconnect catch-up respects the automatic switch and local permission independently', async () => {
  for (const disabled of ['automatic', 'local']) {
    const f = bookingFixture();
    if (disabled === 'local') f.config.allowBooking = false;
    f.ha.preferences = async () => ({ config: f.config, automaticEnabled: disabled !== 'automatic' });
    const running = serveWorker(f);
    await flush();
    assert.equal(f.commands.length, 1);
    assert.deepEqual(f.books, []);
    assert.ok(f.writes.some(w => w[0] === 'sensor.wally_status' &&
      w[1] === (disabled === 'automatic' ? 'automatic_booking_disabled' : 'attention_required')));
    f.controller.abort();
    await running;
  }
});

test('only stale-heartbeat recovery queues another catch-up, not normal heartbeats or duplicate readiness', async () => {
  for (const gap of [60_000, 150_000, 150_001]) {
    const f = bookingFixture();
    let clock = f.now().getTime();
    f.now = () => new Date(clock);
    let acknowledge;
    f.ha.listen = async (_receive, signal, ready) => {
      acknowledge = ready;
      ready();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    };
    const running = serveWorker(f);
    await flush();
    assert.equal(f.commands.length, 1);
    acknowledge();
    clock += gap;
    f.intervals.get(60_000)();
    await flush();
    assert.equal(f.commands.length, gap > 150_000 ? 2 : 1);
    assert.equal(f.books.length, 1, 'A fresh catch-up must preserve the reservation created on first connection');
    assert.equal(new Set(f.commands.map(c => c.id)).size, f.commands.length);
    assert.equal(f.commands.at(-1).issued_at, new Date(gap > 150_000 ? clock : clock - gap).toISOString());
    f.controller.abort();
    await running;
  }
});

test('failed initial online publication cannot trigger reconnect booking', async () => {
  const f = bookingFixture();
  const publish = f.ha.publish;
  f.ha.publish = async (...args) => {
    if (args[0] === 'sensor.wally_worker_heartbeat' && args[1] === 'online') {
      throw new Error('Fixture heartbeat unavailable');
    }
    await publish(...args);
  };
  await assert.rejects(serveWorker(f), /Fixture heartbeat unavailable/);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.books, []);
});

test('manual commands wait behind an in-flight reconnect booking in the same serial queue', async () => {
  const f = bookingFixture();
  const booking = deferred();
  const book = f.client.book;
  let receive;
  let reads = 0;
  const snapshot = f.client.snapshot;
  f.client.snapshot = async (...args) => { reads++; return snapshot(...args); };
  f.client.book = async item => { await booking.promise; return book(item); };
  f.ha.listen = async (onCommand, signal, ready) => {
    receive = onCommand;
    ready();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  };
  const running = serveWorker(f);
  await flush();
  assert.equal(reads, 1);
  receive({ id: 'manual-after-reconnect', action: 'refresh', issued_at: f.now().toISOString() });
  await flush();
  assert.equal(reads, 1, 'Manual refresh must not navigate during catch-up booking');
  assert.equal(f.commands.length, 1);
  booking.resolve();
  await flush();
  assert.deepEqual(f.commands.map(c => c.action), ['book', 'refresh']);
  assert.equal(reads, 3, 'Booking reconciliation finishes before manual refresh');
  f.controller.abort();
  await running;
});

test('a later connection lifecycle gets a distinct fresh catch-up even at the same clock time', async () => {
  const ids = [];
  for (let connection = 0; connection < 2; connection++) {
    const f = bookingFixture();
    const running = serveWorker(f);
    await flush();
    assert.equal(f.commands.length, 1);
    ids.push(f.commands[0].id);
    f.controller.abort();
    await running;
  }
  assert.notEqual(ids[0], ids[1]);
});

const heartbeatStates = f => f.writes.filter(([entity]) => entity === 'sensor.wally_worker_heartbeat').map(([, state]) => state);

test('transient Home Assistant failures are classified; auth and client errors are permanent', () => {
  assert.equal(isTransientHaError(new TypeError('fetch failed')), true);
  assert.equal(isTransientHaError(Object.assign(new Error('HTTP 502'), { status: 502 })), true);
  assert.equal(isTransientHaError(Object.assign(new Error('HTTP 429'), { status: 429 })), true);
  assert.equal(isTransientHaError(Object.assign(new Error('HTTP 401'), { status: 401 })), false);
  assert.equal(isTransientHaError(Object.assign(new Error('HTTP 403'), { status: 403 })), false);
  assert.equal(isTransientHaError(new Error('Home Assistant rejected the Keychain credential')), false);
});

test('a single transient heartbeat failure is retried and the worker keeps running', async () => {
  const f = fixture();
  const publish = f.ha.publish;
  let failed = false;
  f.ha.publish = async (entity, state, ...rest) => {
    if (entity === 'sensor.wally_worker_heartbeat' && state === 'online' && !failed) {
      failed = true;
      throw new TypeError('fetch failed');
    }
    return publish(entity, state, ...rest);
  };
  const running = serveWorker({ ...f, backoff: async () => {} });
  await flush();
  f.intervals.get(60_000)();
  await flush();
  f.controller.abort();
  await running;
  assert.equal(failed, true);
  assert.deepEqual(heartbeatStates(f), ['online', 'offline'], 'The retried heartbeat must succeed');
});

test('consecutive transient heartbeat failures stop the worker with the original error', async () => {
  const f = fixture();
  const failure = new TypeError('fetch failed');
  const publish = f.ha.publish;
  let attempts = 0;
  f.ha.publish = async (entity, state, ...rest) => {
    if (entity === 'sensor.wally_worker_heartbeat' && state === 'online') {
      attempts++;
      throw failure;
    }
    return publish(entity, state, ...rest);
  };
  const outcome = serveWorker({ ...f, backoff: async () => {} }).then(() => null, error => error);
  await flush();
  for (let i = 0; i < 4; i++) { f.intervals.get(60_000)(); await flush(); }
  assert.equal(await outcome, failure);
  assert.equal(attempts, 5);
});

test('an authorization failure from Home Assistant stops the worker without retrying', async () => {
  const f = fixture();
  const rejected = Object.assign(new Error('HTTP 401'), { status: 401 });
  const publish = f.ha.publish;
  let attempts = 0;
  f.ha.publish = async (entity, state, ...rest) => {
    if (entity === 'sensor.wally_worker_heartbeat' && state === 'online') {
      attempts++;
      throw rejected;
    }
    return publish(entity, state, ...rest);
  };
  await assert.rejects(serveWorker({ ...f, backoff: async () => {} }), error => error === rejected);
  assert.equal(attempts, 1);
});

test('a dropped Home Assistant event connection reconnects and re-acknowledges the subscription', async () => {
  const f = fixture();
  let listens = 0;
  f.ha.listen = async (_onCommand, signal, onReady) => {
    listens++;
    if (listens === 1) throw new Error('Home Assistant WebSocket connection failed');
    onReady();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  };
  const running = serveWorker({ ...f, backoff: async () => {} });
  await flush();
  await flush();
  assert.equal(listens, 2, 'A transient drop must re-subscribe instead of exiting');
  assert.deepEqual(heartbeatStates(f), ['online'], 'Reconnected worker must re-advertise online once subscribed');
  f.controller.abort();
  await running;
  assert.deepEqual(heartbeatStates(f), ['online', 'offline']);
});

import { WallyApi, WallySession, WallyAuthenticationError, KeychainSessionStore, validateSession } from './wally-api.js';
import { FileSessionStore, resolveRuntime, probeConnectivity } from './app-runtime.js';
import { createSigninServer } from './signin-server.js';
import { isDate, validateCards } from './wally-contract.js';
import { MacPower } from './power-client.js';
import { signinOnMac, renewBrowserAuthorization, MacSigninError } from './mac-signin.js';
export { validateCards } from './wally-contract.js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, open as openFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const STATE_DIR = path.join(homedir(), 'Library/Application Support/WallyWorker');
export const CONFIG_PATH = path.join(STATE_DIR, 'config.json');
export const KEYCHAIN_SERVICE = 'uk.togarriapahome.wally-worker.home-assistant';
const ACTIONS = new Set(['ping', 'refresh', 'dry_run', 'book', 'reauthenticate', 'signin', 'cancel', 'retry', 'retry_all', 'resume', 'restore', 'arrival']);
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export function canRecoverOnMac(error) {
  return error instanceof WallyAuthenticationError && (!(error instanceof MacSigninError) ||
    ['background_window_failed', 'capture_timeout', 'signin_required'].includes(error.code));
}

export function localDiagnostic(error) {
  return String(error.message).replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/g, '[URL REDACTED]')
    .replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]+/g, '[REDACTED]')
    .split('\n').slice(0, 3).join(' ').slice(0, 500);
}

// Network blips and HA 5xx/408/429 are retried; auth, client errors and invalid responses are not.
export function isTransientHaError(error) {
  if (error?.status !== undefined) return error.status === 408 || error.status === 429 || error.status >= 500;
  return error?.name === 'TypeError' || error?.name === 'AbortError' || error?.name === 'TimeoutError' ||
    /WebSocket connection failed|event connection closed/.test(error?.message ?? '');
}

// Abort-aware sleep: shutdown must not wait out a retry delay.
export const sleep = (ms, signal) => delay(ms, undefined, { signal }).catch(() => {});

export async function retryTransient(operation, { attempts = 3, backoff = sleep, signal } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= attempts || !isTransientHaError(error) || signal?.aborted) throw error;
      await backoff(2000 * attempt, signal);
    }
  }
}

export function preferencesFromStates(states, base) {
  const get = id => {
    const state = states.find(s => s.entity_id === id)?.state;
    if (state === undefined || ['unknown', 'unavailable'].includes(state)) {
      throw new Error(`Booking preference unavailable: ${id}`);
    }
    return state;
  };
  const on = id => {
    const value = get(id);
    if (!['on', 'off'].includes(value)) throw new Error(`Invalid toggle: ${id}`);
    return value === 'on';
  };
  const automaticEnabled = on('input_boolean.wally_booking_enabled');
  const weekdays = DAYS.map((day, i) => on(`input_boolean.wally_${day}`) ? i + 1 : null)
    .filter(d => d !== null);
  const config = {
    ...base,
    office: get('input_text.wally_office'),
    floor: get('input_text.wally_floor'),
    desk: get('input_text.wally_desk'),
    fallbackDesks: get('input_text.wally_fallback_desks'),
    horizonDays: Number(get('input_number.wally_booking_horizon_days')),
    weekdays,
  };
  if (config.office !== base.office || config.floor !== base.floor) {
    throw new Error('Home Assistant location names do not match the pinned Wally office/floor IDs');
  }
  // No selected days is a valid preference: the resulting plan must contain no new bookings.
  validateConfig({ ...config, weekdays: weekdays.length ? weekdays : [1] });
  return { config, automaticEnabled };
}

export function validateConfig(c) {
  if (c.homeAssistant !== 'https://ha.togarriapahome.uk') {
    throw new Error('Home Assistant must use the configured HTTPS origin');
  }
  for (const key of ['officeId', 'floorId']) {
    if (!/^[A-Z0-9]{13}$/.test(c[key])) throw new Error(`Invalid ${key}`);
  }
  for (const key of ['office', 'floor']) {
    if (typeof c[key] !== 'string' || !c[key].trim()) throw new Error(`Invalid ${key}`);
  }
  if (!/^\d{3}$/.test(c.desk)) throw new Error('Desk must contain three digits');
  parseDesks(c.desk, c.fallbackDesks);
  if (!Array.isArray(c.weekdays) || !c.weekdays.length ||
      c.weekdays.some(d => !Number.isInteger(d) || d < 1 || d > 7)) {
    throw new Error('Weekdays must be ISO weekday numbers 1 through 7');
  }
  if (!Number.isInteger(c.horizonDays) || c.horizonDays < 1 || c.horizonDays > 30) {
    throw new Error('Booking horizon must be between 1 and 30 days');
  }
  if (typeof c.allowBooking !== 'boolean') throw new Error('allowBooking must be boolean');
  if (c.powerManagement !== undefined && typeof c.powerManagement !== 'boolean') {
    throw new Error('powerManagement must be boolean');
  }
  return c;
}

export function parseDesks(primary, fallback) {
  const result = [primary];
  if (typeof fallback !== 'string') throw new Error('Fallback desks must be text');
  for (const item of fallback.split(',').map(s => s.trim()).filter(Boolean)) {
    if (!/^\d{3}(?:-\d{3})?$/.test(item)) throw new Error('Invalid fallback desk range');
    const [start, end = start] = item.split('-').map(Number);
    if (end < start || end - start > 100) throw new Error('Invalid fallback desk range');
    for (let n = start; n <= end; n++) result.push(String(n).padStart(3, '0'));
  }
  return [...new Set(result)];
}

export function validateCommand(command, now = Date.now()) {
  if (!command || typeof command !== 'object' || Array.isArray(command) ||
      Object.keys(command).some(k => !['id', 'action', 'issued_at', 'target'].includes(k))) {
    throw new Error('Unexpected command fields');
  }
  if (typeof command.id !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(command.id) || !ACTIONS.has(command.action)) {
    throw new Error('Invalid command identity or action');
  }
  const issued = Date.parse(command.issued_at);
  if (!Number.isFinite(issued) || issued > now + 30_000 || now - issued > 300_000) {
    throw new Error('Expired or future-dated command');
  }
  if (command.action === 'signin' && command.id.startsWith('scheduled-')) {
    throw new Error('Personal sign-in requires an explicit request, not a scheduled command');
  }
  if (command.action === 'retry_all') {
    const target = command.target;
    const reservations = target?.reservations;
    if (!target || Object.keys(target).length !== 1 || !Array.isArray(reservations) ||
        !reservations.length || reservations.length > 30 ||
        reservations.some(r => !isReservationTarget(r) || r.date < lisbonToday(new Date(now))) ||
        new Set(reservations.map(r => r.date)).size !== reservations.length) {
      throw new Error('Invalid bulk reservation targets');
    }
  } else if (['cancel', 'retry', 'resume'].includes(command.action)) {
    if (!isReservationTarget(command.target, command.action === 'resume')) throw new Error('Invalid reservation target');
  } else if ('target' in command) {
    throw new Error('This command does not accept a target');
  }
  return command;
}

function isReservationTarget(target, resume = false) {
  const fields = resume ? ['date'] : ['date', 'expected_desk'];
  return target && typeof target === 'object' && !Array.isArray(target) &&
    Object.keys(target).length === fields.length && Object.keys(target).every(k => fields.includes(k)) &&
    isDate(target.date) && (resume || (typeof target.expected_desk === 'string' && /^\d{3}$/.test(target.expected_desk)));
}

export function lisbonToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = type => parts.find(p => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function planBookings(cards, config, today = lisbonToday()) {
  const start = Date.parse(`${today}T00:00:00Z`);
  return validateCards(cards).map(card => {
    const timestamp = Date.parse(`${card.date}T00:00:00Z`);
    if (card.booked) {
      return { date: card.date, status: 'preserved', desk: card.desk };
    }
    if (config.excludedDates?.includes(card.date)) return { date: card.date, status: 'paused' };
    const delta = (timestamp - start) / 86_400_000;
    const weekday = new Date(timestamp).getUTCDay() || 7;
    if (delta < 0 || delta > config.horizonDays || !config.weekdays.includes(weekday)) {
      return { date: card.date, status: 'not_requested' };
    }
    const desk = parseDesks(config.desk, config.fallbackDesks).find(d => card.available.includes(d));
    return { date: card.date, status: desk ? 'would_book' : 'no_preferred_desk', ...(desk ? { desk } : {}) };
  });
}

export function commandFromEvent(message) {
  return message.event?.event_type === 'wally_local_awake_command'
    ? message.event.data?.command : message.event?.data;
}

export function acceptsCommandEvent(message, powerManagement) {
  if (message.type !== 'event') return false;
  if (message.id === 1 && message.event?.event_type === 'wally_local_command') {
    return !powerManagement || message.event.data?.action === 'ping';
  }
  return powerManagement && message.id === 2 &&
    message.event?.event_type === 'wally_local_awake_command' && commandFromEvent(message)?.action !== 'ping';
}

export class HomeAssistant {
  constructor(config, runtime = resolveRuntime()) {
    this.origin = runtime.origin ?? config.homeAssistant;
    this.websocketUrl = runtime.websocketUrl ??
      `${this.origin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')}/api/websocket`;
    this.powerManagement = config.powerManagement === true;
    this.token = runtime.token ?? execFileSync('/usr/bin/security', [
      'find-generic-password', '-s', KEYCHAIN_SERVICE, '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (!this.token) throw new Error('Home Assistant credential is missing from Keychain');
  }

  async publish(entity, state, attributes) {
    const response = await fetch(`${this.origin}/api/states/${entity}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, attributes }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const error = new Error(`Home Assistant status publication failed: HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
  }

  async preferences(config) {
    const response = await fetch(`${this.origin}/api/states`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Home Assistant preference read failed: HTTP ${response.status}`);
    const states = await response.json();
    if (!Array.isArray(states)) throw new Error('Invalid Home Assistant state response');
    return preferencesFromStates(states, config);
  }

  async syncReservations(bookings, state) {
    const dates = [...new Set([...bookings.map(b => b.date), ...state.data.excludedDates])].sort();
    const options = ['Select a reservation', ...dates.map(date => {
      const booking = bookings.find(b => b.date === date);
      return `${date} | ${booking ? `Desk ${booking.desk}` : 'Paused'}`;
    })];
    const response = await fetch(`${this.origin}/api/services/input_select/set_options`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_id: 'input_select.wally_reservation', options }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Reservation selector update failed: HTTP ${response.status}`);
  }

  async listen(onCommand, signal, onReady = () => {}) {
    if (signal.aborted) return;
    const socket = new WebSocket(this.websocketUrl);
    await new Promise((resolve, reject) => {
      let ready = false;
      const subscriptions = this.powerManagement ? ['wally_local_command', 'wally_local_awake_command'] : ['wally_local_command'];
      const acknowledged = new Set();
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error('Home Assistant event subscription timed out'));
      }, 20_000);
      const stop = () => socket.close();
      signal.addEventListener('abort', stop, { once: true });
      socket.addEventListener('message', ({ data }) => {
        const message = JSON.parse(data);
        if (message.type === 'auth_required') {
          socket.send(JSON.stringify({ type: 'auth', access_token: this.token }));
        } else if (message.type === 'auth_invalid') {
          socket.close();
          reject(new Error('Home Assistant rejected the Keychain credential'));
        } else if (message.type === 'auth_ok') {
          subscriptions.forEach((event_type, index) => {
            socket.send(JSON.stringify({ id: index + 1, type: 'subscribe_events', event_type }));
          });
        } else if (message.type === 'result' && message.id >= 1 && message.id <= subscriptions.length) {
          if (!message.success) {
            socket.close();
            reject(new Error('Home Assistant rejected the event subscription'));
          } else {
            acknowledged.add(message.id);
            if (!ready && !signal.aborted && acknowledged.size === subscriptions.length) {
              ready = true;
              clearTimeout(timeout);
              onReady();
            }
          }
        } else if (ready && acceptsCommandEvent(message, this.powerManagement)) {
          onCommand(commandFromEvent(message));
        }
      });
      socket.addEventListener('error', () => {
        socket.close();
        reject(new Error('Home Assistant WebSocket connection failed'));
      });
      socket.addEventListener('close', () => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', stop);
        if (signal.aborted) resolve();
        else reject(new Error(ready ? 'Home Assistant event connection closed' : 'Home Assistant sign-in failed'));
      });
    });
  }
}

async function publishReservationState(ha, state) {
  await ha.publish('sensor.wally_paused_dates', String(state.data.excludedDates.length), {
    dates: state.data.excludedDates,
  });
  await ha.publish('sensor.wally_reservation_recovery', state.data.pending ? 'pending' : 'clear',
    state.data.pending ? { date: state.data.pending.date, desk: state.data.pending.desk } : {});
}

async function publishBookings(cards, config, ha, state, lastUpdated, reconciled = true) {
  const bookings = cards.filter(c => c.booked).map(c => ({
    date: c.date, desk: c.desk, office: config.office, floor: config.floor,
  }));
  if (ha) {
    await ha.publish('sensor.wally_bookings', reconciled ? 'ok' : 'stale', {
      bookings, lastUpdated, source: 'mac_local_worker',
    });
    if (state) {
      await publishReservationState(ha, state);
      if (reconciled) await ha.syncReservations(bookings, state);
    }
  }
  return bookings;
}

export async function runAction(action, config, client, ha, state, commandId) {
  if (!['refresh', 'dry_run', 'book', 'reauthenticate'].includes(action)) throw new Error('Unsupported action');
  if (action === 'book' && !config.allowBooking) throw new Error('Booking is locally disabled pending acceptance');
  if (action === 'reauthenticate') {
    return client.reauthenticate();
  }
  const cards = validateCards(await client.snapshot(action !== 'refresh'));
  const initialUpdated = new Date().toISOString();
  const outcomes = action === 'refresh' ? [] : planBookings(cards, {
    ...config, excludedDates: state?.data.excludedDates || [],
  });
  let bookingError;
  let authenticationError;
  if (action === 'book') {
    for (let i = 0; i < outcomes.length; i++) {
      if (outcomes[i].status !== 'would_book') continue;
      try {
        outcomes[i] = await client.book(outcomes[i]);
      } catch (error) {
        bookingError = error;
        if (error instanceof WallyAuthenticationError) authenticationError = error;
        outcomes[i] = { ...outcomes[i], status: 'failed_or_unconfirmed' };
        for (let j = i + 1; j < outcomes.length; j++) {
          if (outcomes[j].status === 'would_book') outcomes[j] = { ...outcomes[j], status: 'not_attempted' };
        }
        break;
      }
    }
  }
  let confirmedCards = cards;
  let reconciled = true;
  if (action === 'book') {
    try {
      confirmedCards = validateCards(await client.snapshot(false));
      authenticationError = undefined;
    } catch (error) {
      bookingError ||= error;
      if (error instanceof WallyAuthenticationError) authenticationError = error;
      reconciled = false;
    }
  }
  const lastUpdated = reconciled ? new Date().toISOString() : initialUpdated;
  const bookings = await publishBookings(confirmedCards, config, ha, state, lastUpdated, reconciled);
  if (ha) {
    if (action !== 'refresh') await ha.publish('sensor.wally_last_result', action, { command_id: commandId, outcomes, lastUpdated });
    await ha.publish('sensor.wally_status', authenticationError ? 'authentication_required' :
      bookingError || state?.data.pending ? 'attention_required' : 'ready', {
      lastUpdated, detail: authenticationError ? 'API authentication is unavailable. Use Renew authorization. If Microsoft needs interaction, complete normal Wally sign-in in ordinary Chrome on the Mac, then use Sign in on Mac.' :
        state?.data.pending ? 'An interrupted replacement needs original-desk recovery. Use Restore previous desk.' :
        bookingError ? 'Booking stopped. Inspect per-date outcomes and refresh before retrying.' : 'Mac-local worker connected',
    });
  }
  if (authenticationError) throw new WallyAuthenticationError('Booking stopped because API authentication remains unavailable. Use Renew authorization or complete normal Wally sign-in in ordinary Chrome on the Mac.');
  if (bookingError) throw new Error('Booking attempt stopped; inspect outcomes and refresh before retrying');
  return { status: 'ok', action, bookings, outcomes, lastUpdated };
}

export class ReservationState {
  constructor(filename, files = { open: openFile, rename }) {
    this.filename = filename;
    this.files = files;
    this.data = { excludedDates: [], pending: null };
  }

  async load() {
    let data;
    try { data = JSON.parse(await readFile(this.filename, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return;
    }
    this.validate(data);
    this.data = data;
  }

  validate(data) {
    if (!data || Object.keys(data).some(k => !['excludedDates', 'pending'].includes(k)) ||
        !Array.isArray(data.excludedDates) || data.excludedDates.some(d => !isDate(d)) ||
        new Set(data.excludedDates).size !== data.excludedDates.length ||
        (data.pending !== null && (!data.pending || Object.keys(data.pending).length !== 4 ||
          Object.keys(data.pending).some(k => !['date', 'desk', 'officeId', 'floorId'].includes(k)) ||
          !isDate(data.pending.date) || !/^\d{3}$/.test(data.pending.desk) ||
          !/^[A-Z0-9]{13}$/.test(data.pending.officeId) || !/^[A-Z0-9]{13}$/.test(data.pending.floorId) ||
          !data.excludedDates.includes(data.pending.date)))) {
      throw new Error('Invalid reservation recovery state');
    }
  }

  async commit(data) {
    this.validate(data);
    const file = await this.files.open(`${this.filename}.tmp`, 'w', 0o600);
    try {
      await file.writeFile(JSON.stringify(data));
      await file.sync();
    } finally { await file.close(); }
    await this.files.rename(`${this.filename}.tmp`, this.filename);
    const directory = await this.files.open(path.dirname(this.filename), 'r');
    try { await directory.sync(); }
    finally { await directory.close(); }
    this.data = data;
  }

  async pause(date, pending = null) {
    await this.commit({
      excludedDates: [...new Set([...this.data.excludedDates, date])].sort(),
      pending: pending || (this.data.pending?.date === date ? null : this.data.pending),
    });
  }

  async resume(date) {
    await this.commit({
      excludedDates: this.data.excludedDates.filter(d => d !== date),
      pending: this.data.pending?.date === date ? null : this.data.pending,
    });
  }
}

function targetCard(cards, date) {
  const card = cards.find(c => c.date === date);
  if (!card) throw new Error('Selected date is not in the live Wally schedule');
  return card;
}

async function restoreOriginal(config, client, state) {
  const original = state.data.pending;
  if (!original) throw new Error('No original reservation is awaiting recovery');
  if (original.officeId !== config.officeId || original.floorId !== config.floorId ||
      original.date < lisbonToday()) {
    throw new Error('Original reservation location or date cannot be safely restored');
  }
  let cards = validateCards(await client.snapshot(true, original.date));
  let current = targetCard(cards, original.date);
  if (current.booked) {
    await state.resume(original.date);
    return { cards, outcome: { date: original.date, desk: current.desk,
      status: current.desk === original.desk ? 'original_preserved' : 'reservation_preserved' } };
  }
  if (current.available.includes(original.desk)) {
    try { await client.book({ date: original.date, desk: original.desk }); }
    catch (error) { console.error(`Original-desk attempt requires reconciliation: ${localDiagnostic(error)}`); }
    cards = validateCards(await client.snapshot(false));
    current = targetCard(cards, original.date);
    if (current.booked) {
      await state.resume(original.date);
      return { cards, outcome: { date: original.date, desk: current.desk,
        status: current.desk === original.desk ? 'restored_previous' : 'reservation_preserved' } };
    }
  }
  return { cards, outcome: { date: original.date, desk: original.desk, status: 'restoration_failed' } };
}

export async function runReservationAction(command, config, client, ha, state, publishCompletion = true) {
  if (!config.allowBooking) throw new Error('Reservation changes are locally disabled');
  if (!state) throw new Error('Durable reservation state is required');
  const { action, target } = command;
  if (!['cancel', 'retry', 'resume', 'restore'].includes(action)) throw new Error('Invalid reservation action');
  if (target && action !== 'resume' && target.date < lisbonToday()) throw new Error('Past reservations cannot be changed');
  let cards = validateCards(await client.snapshot(false));
  const initialUpdated = new Date().toISOString();
  let outcome;
  let preferenceAudit;
  let operationError;
  let reconciled = true;
  if (action === 'restore') {
    ({ cards, outcome } = await restoreOriginal(config, client, state));
  } else if (action === 'resume') {
    await state.resume(target.date);
    outcome = { date: target.date, status: 'automatic_booking_resumed' };
  } else {
    const original = targetCard(cards, target.date);
    if (!original.booked || original.desk !== target.expected_desk) {
      throw new Error('Selected reservation changed. Refresh and select it again before retrying');
    }
    const candidates = parseDesks(config.desk, config.fallbackDesks);
    if (action === 'retry') preferenceAudit = {
      original_desk: original.desk, order: candidates, snapshots: [], checks: [],
    };
    {
      if (action === 'retry' && state.data.pending) {
        throw new Error('Restore or explicitly resume the unresolved date before another replacement');
      }
      await state.pause(original.date, action === 'retry' ? {
        date: original.date, desk: original.desk, officeId: config.officeId, floorId: config.floorId,
      } : null);
      if (ha) await publishReservationState(ha, state);
      try {
        const cancelled = await client.cancel(original);
        if (preferenceAudit && Number.isInteger(cancelled?.http_status)) {
          preferenceAudit.cancellation_http_status = cancelled.http_status;
        }
        cards = validateCards(await client.snapshot(action === 'retry', original.date));
        const empty = targetCard(cards, original.date);
        if (empty.booked) throw new Error('Wally did not confirm cancellation');
        if (action === 'cancel') {
          outcome = { date: original.date, desk: original.desk, status: 'cancelled_and_paused' };
        } else {
          preferenceAudit.snapshots.push({
            observed_at: new Date().toISOString(), available: [...empty.available],
          });
          for (const desk of candidates) {
            const check = { desk, snapshot: preferenceAudit.snapshots.length - 1, result: 'unavailable' };
            preferenceAudit.checks.push(check);
            if (!targetCard(cards, original.date).available.includes(desk)) continue;
            check.result = 'attempted';
            try {
              const booked = await client.book({ date: original.date, desk });
              if (Number.isInteger(booked?.http_status)) check.http_status = booked.http_status;
            } catch (error) {
              check.error = localDiagnostic(error);
              console.error(`Preferred-desk attempt requires reconciliation: ${check.error}`);
            }
            cards = validateCards(await client.snapshot(true, original.date));
            const current = targetCard(cards, original.date);
            check.result = current.booked ?
              (current.desk === desk ? 'confirmed' : 'reservation_preserved') : 'not_booked';
            if (current.booked) {
              check.verified_desk = current.desk;
              await state.resume(original.date);
              outcome = { date: original.date, desk: current.desk,
                status: current.desk === desk ? 'confirmed' : 'reservation_preserved' };
              break;
            }
            preferenceAudit.snapshots.push({
              observed_at: new Date().toISOString(), available: [...current.available],
            });
          }
        }
      } catch (error) {
        operationError = localDiagnostic(error);
        console.error(`Reservation ${action} needs reconciliation: ${localDiagnostic(error)}`);
      }
      if (!outcome) {
        try {
          if (action === 'retry') ({ cards, outcome } = await restoreOriginal(config, client, state));
          else {
            cards = validateCards(await client.snapshot(false));
            outcome = { date: original.date, desk: original.desk,
              status: targetCard(cards, original.date).booked ? 'cancellation_failed' : 'cancelled_and_paused' };
          }
        } catch (error) {
          console.error(`Reservation recovery could not be verified: ${localDiagnostic(error)}`);
          reconciled = false;
          outcome = { date: original.date, desk: original.desk, status: 'change_unconfirmed' };
        }
      }
    }
  }
  const lastUpdated = reconciled ? new Date().toISOString() : initialUpdated;
  const bookings = await publishBookings(cards, config, ha, state, lastUpdated, reconciled);
  if (preferenceAudit) outcome.preference_audit = preferenceAudit;
  if (operationError) outcome.detail = operationError;
  const attention = ['restoration_failed', 'cancellation_failed', 'change_unconfirmed',
    'reservation_preserved'].includes(outcome.status) ||
    (action === 'retry' && ['original_preserved', 'restored_previous'].includes(outcome.status));
  if (ha && publishCompletion) {
    await ha.publish('sensor.wally_last_result', action, { command_id: command.id, outcomes: [outcome], lastUpdated });
    await ha.publish('sensor.wally_status', attention || state.data.pending ? 'attention_required' : 'ready', {
      lastUpdated, detail: ['original_preserved', 'restored_previous'].includes(outcome.status) && action === 'retry' ?
        `Rebook did not complete. Your original desk ${outcome.desk} ${outcome.status === 'restored_previous' ? 'was restored' : 'is still booked'}.${operationError ? ` ${operationError}` : ''}` :
        outcome.status === 'restoration_failed' ?
        'Preferred replacement failed and the original desk could not be restored. Open Wally or use Restore previous desk.' :
        `Reservation result: ${outcome.status.replaceAll('_', ' ')}.`,
    });
  }
  return { status: attention || state.data.pending ? 'attention_required' : 'ok', action, bookings, outcomes: [outcome], lastUpdated };
}

export async function runRebookAll(command, config, client, ha, state) {
  validateCommand(command);
  if (command.action !== 'retry_all') throw new Error('Invalid bulk reservation action');
  if (!config.allowBooking) throw new Error('Reservation changes are locally disabled');
  if (!state || state.data.pending) throw new Error('Resolve existing reservation recovery before rebooking all');
  const targets = command.target.reservations;
  const cards = validateCards(await client.snapshot(false));
  for (const target of targets) {
    const current = targetCard(cards, target.date);
    if (!current.booked || current.desk !== target.expected_desk) {
      throw new Error('Reservation list changed. Refresh and confirm the current reservations');
    }
  }
  const outcomes = [];
  let stopped = false;
  for (const target of targets) {
    if (stopped) {
      outcomes.push({ date: target.date, desk: target.expected_desk, status: 'not_attempted' });
      continue;
    }
    try {
      if (ha) await ha.publish('sensor.wally_status', 'working', {
        command: 'retry_all', date: target.date, completed: outcomes.length, total: targets.length,
        detail: `Rebooking ${target.date} (${outcomes.length + 1} of ${targets.length}). Later reservations have not been changed.`,
      });
      const result = await runReservationAction({ ...command, action: 'retry', target }, config, client, ha, state, false);
      outcomes.push(...result.outcomes);
      stopped = result.status !== 'ok' || result.outcomes[0].status !== 'confirmed';
    } catch (error) {
      const detail = localDiagnostic(error);
      console.error(`Bulk rebook stopped at ${target.date}: ${detail}`);
      outcomes.push({ date: target.date, desk: target.expected_desk, status: 'failed_or_unconfirmed', detail });
      stopped = true;
    }
  }
  const lastUpdated = new Date().toISOString();
  const confirmed = outcomes.filter(o => o.status === 'confirmed').length;
  if (ha) {
    await ha.publish('sensor.wally_last_result', 'retry_all', { command_id: command.id, outcomes, lastUpdated });
    await ha.publish('sensor.wally_status', stopped ? 'attention_required' : 'ready', {
      lastUpdated, detail: stopped ?
        `Rebook all stopped: ${confirmed} of ${targets.length} rebooked. Check per-date outcomes and recovery. Later reservations were not changed.` :
        `Rebook all completed: ${confirmed} reservations verified in Wally.`,
    });
  }
  return { status: stopped ? 'attention_required' : 'ok', action: 'retry_all', outcomes, lastUpdated };
}

export async function runArrivalCheck(command, config, client, ha, state) {
  const date = lisbonToday();
  if (lisbonToday(new Date(command.issued_at)) !== date) {
    throw new Error('Arrival request belongs to a different Lisbon day');
  }
  let cards = validateCards(await client.snapshot(false));
  const current = cards.find(card => card.date === date);
  let result;
  if (current?.booked) {
    result = { status: 'already_booked', desk: current.desk };
  } else if (!current) {
    result = { status: 'date_unavailable' };
  } else if (!config.allowBooking) {
    result = { status: 'booking_disabled' };
  } else if (state.data.excludedDates.includes(date)) {
    result = { status: 'date_paused' };
  } else {
    const preferences = await ha.preferences(config);
    config = preferences.config;
    client.config = config;
    cards = validateCards(await client.snapshot(true, date));
    const latest = targetCard(cards, date);
    if (latest.booked) {
      result = { status: 'already_booked', desk: latest.desk };
    } else {
      const desk = parseDesks(config.desk, config.fallbackDesks).find(d => latest.available.includes(d));
      let verified = true;
      if (desk) {
        if (lisbonToday() !== date) throw new Error('Lisbon day changed before arrival booking');
        try { await client.book({ date, desk }); }
        catch (error) { console.error(`Arrival booking requires reconciliation: ${localDiagnostic(error)}`); }
        try { cards = validateCards(await client.snapshot(false)); }
        catch (error) {
          console.error(`Arrival booking could not be verified: ${localDiagnostic(error)}`);
          verified = false;
        }
      }
      const finalCard = cards.find(card => card.date === date);
      result = !verified || !finalCard ? { status: 'check_failed' } :
        finalCard.booked ? { status: 'booked', desk: finalCard.desk } : { status: 'booking_failed' };
    }
  }
  const lastUpdated = new Date().toISOString();
  await publishBookings(cards, config, ha, state, lastUpdated, result.status !== 'check_failed');
  const outcome = { date, ...result };
  await ha.publish('sensor.wally_arrival_result', result.status, {
    command_id: command.id, ...outcome, lastUpdated,
  });
  await ha.publish('sensor.wally_status', ['already_booked', 'booked'].includes(result.status) ? 'ready' : 'attention_required', {
    lastUpdated, detail: `Work arrival: ${result.status.replaceAll('_', ' ')}.`,
  });
  return outcome;
}

export class CommandLedger {
  constructor(filename, clock = Date.now) {
    this.filename = filename;
    this.clock = clock;
    this.entries = [];
  }

  async load() {
    try { this.entries = JSON.parse(await readFile(this.filename, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.entries = [];
    }
    if (!Array.isArray(this.entries) || this.entries.some(entry =>
      !entry || typeof entry.id !== 'string' || !Number.isFinite(entry.expiresAt))) {
      throw new Error('Invalid command ledger');
    }
  }

  async claim(command) {
    validateCommand(command, this.clock());
    this.entries = this.entries.filter(entry => entry.expiresAt >= this.clock());
    if (this.entries.some(entry => entry.id === command.id)) return false;
    if (this.entries.length >= 5000) throw new Error('Too many live commands; refusing additional requests');
    this.entries.push({ id: command.id, expiresAt: Date.parse(command.issued_at) + 300_000 });
    await writeFile(`${this.filename}.tmp`, JSON.stringify(this.entries), { mode: 0o600 });
    await rename(`${this.filename}.tmp`, this.filename);
    return true;
  }
}

export async function dispatchCommand(raw, { config, client, ha, ledger, reservationState, personalSignin, signal }) {
  if (!await ledger.claim(raw)) return;
  if (raw.action === 'ping') {
    return ha.publish('sensor.wally_worker_heartbeat', 'online', {
      last_seen: new Date().toISOString(), transport: 'direct_http', probe_id: raw.id,
    });
  }
  if (raw.action === 'signin') {
    if (!personalSignin) throw new WallyAuthenticationError('Personal browser sign-in is available only on the Mac worker.');
    client.config = config;
    await ha.publish('sensor.wally_status', 'authentication_in_progress', {
      detail: 'Starting Wally authorization through ordinary Chrome on the Mac. No booking is requested.',
    });
    await personalSignin({ signal, onPrompt: () => ha.publish('sensor.wally_status', 'authentication_in_progress', {
      detail: 'Obtaining Wally authorization in an inactive background Chrome tab that closes afterward. Existing tabs and window focus stay unchanged; reservation operations remain HTTP-only.',
    }) });
    signal?.throwIfAborted();
    await client.verifyLocation({ signal });
    signal?.throwIfAborted();
    return runAction('refresh', config, client, ha, reservationState);
  }
  if (raw.action === 'reauthenticate') {
    client.config = config;
    await runAction('reauthenticate', config, client, ha);
    return runAction('refresh', config, client, ha, reservationState);
  }
  if (raw.action === 'arrival') {
    // Check existing reservations even if booking preferences are temporarily unavailable.
    client.config = config;
    await ha.publish('sensor.wally_status', 'working', { command: raw.action });
    return runArrivalCheck(raw, config, client, ha, reservationState);
  }
  const preferences = ['book', 'dry_run', 'retry', 'retry_all'].includes(raw.action) ? await ha.preferences(config) : { config };
  if (raw.id.startsWith('scheduled-') && raw.action === 'book' && !preferences.automaticEnabled) {
    await ha.publish('sensor.wally_status', 'automatic_booking_disabled', {
      detail: 'Scheduled booking skipped: Home Assistant automatic booking is off.',
    });
    return;
  }
  client.config = preferences.config;
  await ha.publish('sensor.wally_status', 'working', { command: raw.action });
  if (raw.action === 'retry_all') return runRebookAll(raw, preferences.config, client, ha, reservationState);
  if (['cancel', 'retry', 'resume', 'restore'].includes(raw.action)) {
    return runReservationAction(raw, preferences.config, client, ha, reservationState);
  }
  return runAction(raw.action, preferences.config, client, ha, reservationState, raw.id);
}

export async function signinFromCli(client, { personalSignin = signinOnMac, onPrompt } = {}) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.once(signal, stop);
  try {
    await personalSignin({ session: client.session, signal: controller.signal, onPrompt });
    controller.signal.throwIfAborted();
    await client.verifyLocation({ signal: controller.signal });
    controller.signal.throwIfAborted();
  } finally {
    try { await client.close(); }
    finally { for (const signal of signals) process.removeListener(signal, stop); }
  }
}

async function main() {
  const action = process.argv[2];
  if (!['serve', 'auth-server', 'probe', 'signin', 'reauthenticate', 'auth-import', 'refresh', 'dry_run'].includes(action)) {
    throw new Error('Usage: worker.js signin|probe|auth-server|auth-import|reauthenticate|refresh|dry_run|serve');
  }
  if (action === 'probe') {
    const results = await probeConnectivity();
    console.log(JSON.stringify(results));
    if (results.some(result => !result.reachable)) process.exitCode = 1;
    return;
  }
  const runtime = resolveRuntime();
  if (action === 'auth-server' && runtime.mode !== 'app') throw new Error('The sign-in screen requires the explicit HA app runtime.');
  const stateDir = runtime.stateDir;
  const config = validateConfig(JSON.parse(await readFile(path.join(stateDir, 'config.json'), 'utf8')));
  if (runtime.mode === 'app' && config.powerManagement) throw new Error('Mac power management is not supported in the HA app.');
  if (runtime.mode === 'app' && ['auth-import', 'signin'].includes(action)) {
    throw new Error('Use personal sign-in in the app ingress screen; credential import and logged device codes are disabled.');
  }
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const store = runtime.mode === 'app' ? new FileSessionStore(path.join(stateDir, 'oauth')) : new KeychainSessionStore();
  if (action === 'auth-import') {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (Buffer.byteLength(input) > 65536) throw new Error('OAuth credential input exceeds the local size limit');
    }
    let session;
    try { session = JSON.parse(input); }
    catch { throw new Error('Invalid OAuth session JSON; contents suppressed'); }
    await store.save(validateSession(session));
    console.log('Wally OAuth session stored in Mac Keychain. Run reauthenticate to verify it through HTTP.');
    return;
  }
  const ha = action === 'serve' ? new HomeAssistant(config, runtime) : null;
  const ledger = new CommandLedger(path.join(stateDir, 'commands.json'));
  if (action === 'serve') await ledger.load();
  const reservationState = new ReservationState(path.join(stateDir, 'reservations.json'));
  await reservationState.load();
  const controller = new AbortController();
  const renewalSignal = controller.signal;
  const progress = () => ha?.publish('sensor.wally_status', 'authentication_in_progress', {
    detail: 'Automatically reusing Wally authorization from ordinary Chrome before requesting personal sign-in. Existing windows stay unchanged; reservation operations remain HTTP-only.',
  });
  const session = new WallySession({ store, signal: renewalSignal,
    renewBrowserSession: runtime.mode === 'mac' ? async ({ signal } = {}) => {
      await progress();
      return renewBrowserAuthorization(session, {
        signal: signal ? AbortSignal.any([signal, renewalSignal]) : renewalSignal });
    } : undefined });
  const client = new WallyApi(config, { session, recoverSession: runtime.mode === 'mac' ? async ({ signal, error } = {}) => {
    if (!canRecoverOnMac(error)) throw error;
    await progress();
    await signinOnMac({ session,
      signal: signal ? AbortSignal.any([signal, renewalSignal]) : renewalSignal, onPrompt: progress });
  } : undefined });
  if (action === 'signin') {
    await signinFromCli(client, { onPrompt: async () => {
      console.log('Reusing the existing Wally session from ordinary Chrome. No separate profile or device code is used.');
    } });
    console.log('API sign-in verified; OAuth credentials stored in Mac Keychain.');
    return;
  }
  if (!['serve', 'auth-server'].includes(action)) {
    try { console.log(JSON.stringify(await runAction(action, config, client, null, reservationState))); }
    finally { await client.close(); }
    return;
  }
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.once('SIGHUP', stop);
  let signinServer;
  try {
    if (runtime.mode === 'app') {
      signinServer = createSigninServer({ client, allowSignin: action === 'auth-server' });
      await signinServer.listen();
    }
    if (action === 'auth-server') {
      if (!controller.signal.aborted) {
        await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }));
      }
    } else {
      await serveWorker({ config, client, ha, ledger, reservationState, controller,
        personalSignin: runtime.mode === 'mac' ? options => signinOnMac({ session: client.session, ...options }) : undefined });
    }
  }
  finally {
    await signinServer?.close();
    if (action === 'auth-server') await client.close();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGHUP', stop);
  }
}

export async function serveWorker({
  config, client, ha, ledger, reservationState, controller = new AbortController(),
  timers = globalThis, now = () => new Date(),
  power = config.powerManagement ? new MacPower() : null,
  personalSignin, backoff = sleep,
}) {
  const withPower = operation => power ? power.run(operation) : operation();
  const retry = operation => retryTransient(operation, { backoff, signal: controller.signal });
  let queue = Promise.resolve();
  let heartbeatWork = Promise.resolve();
  let subscribed = false;
  let lastHeartbeatAt;
  let heartbeatFailures = 0;
  let listenFailures = 0;
  let fatalError;
  let heartbeat;
  const stopWithError = error => {
    fatalError ||= error;
    controller.abort();
  };
  const MAX_HEARTBEAT_FAILURES = 5, MAX_LISTEN_FAILURES = 5;
  const onCommand = raw => {
    if (controller.signal.aborted) return;
    queue = queue.then(async () => {
      if (controller.signal.aborted) return;
      try {
        await withPower(() => dispatchCommand(raw, { config, client, ha, ledger, reservationState,
          personalSignin, signal: controller.signal }));
      } catch (error) {
        console.error(`Worker command failed (${error.name}): ${localDiagnostic(error)}`);
        if (raw?.action === 'arrival' && /^[a-zA-Z0-9-]{8,80}$/.test(raw.id)) {
          await ha.publish('sensor.wally_arrival_result', 'check_failed', {
            command_id: raw.id, date: lisbonToday(), lastUpdated: new Date().toISOString(),
          });
        }
        await retry(() => ha.publish('sensor.wally_status', error instanceof WallyAuthenticationError ? 'authentication_required' : 'attention_required', {
          detail: error instanceof WallyAuthenticationError ? error.message :
            'Command failed. Check the local API worker and OAuth session; no automatic retry.',
        }));
      }
    }).catch(error => {
      console.error(`Worker status publication failed (${error.name}); stopping event intake.`);
      stopWithError(error);
    });
  };
  const publishHeartbeat = () => {
    heartbeatWork = heartbeatWork.then(async () => {
      if (!subscribed || controller.signal.aborted) return;
      const seen = now();
      const reconnected = lastHeartbeatAt === undefined || seen.getTime() - lastHeartbeatAt > 150_000;
      await ha.publish('sensor.wally_worker_heartbeat', 'online', { last_seen: seen.toISOString(), transport: 'direct_http' });
      if (power) {
        const state = await power.status();
        await ha.publish('sensor.wally_power', state.power_error ? 'attention_required' : 'running', {
          ...state, lastUpdated: seen.toISOString(),
        });
      }
      lastHeartbeatAt = seen.getTime();
      heartbeatFailures = 0;
      if (reconnected && !controller.signal.aborted) {
        onCommand({ id: `scheduled-reconnect-${randomUUID()}`, action: 'book', issued_at: now().toISOString() });
      }
    }).catch(error => {
      // A failed heartbeat leaves lastHeartbeatAt stale, so the next success triggers the reconnect catch-up.
      if (isTransientHaError(error) && ++heartbeatFailures < MAX_HEARTBEAT_FAILURES) {
        console.error(`Worker heartbeat failed (${error.name}; retrying ${heartbeatFailures}/${MAX_HEARTBEAT_FAILURES}): ${localDiagnostic(error)}`);
        return;
      }
      console.error(`Worker heartbeat failed (${error.name}): ${localDiagnostic(error)}`);
      stopWithError(error);
    });
  };
  const onReady = () => {
    if (subscribed || controller.signal.aborted) return;
    subscribed = true;
    listenFailures = 0;
    publishHeartbeat();
  };
  try {
    let authenticated = false;
    try {
      // Validate with the stored session; forcing renewal here opened Chrome on every launchd restart.
      await withPower(() => client.reauthenticate({ force: false }));
      authenticated = true;
    } catch (error) {
      if (!(error instanceof WallyAuthenticationError)) throw error;
      await ha.publish('sensor.wally_status', 'authentication_required', { detail: error.message });
    }
    if (controller.signal.aborted) return;
    if (reservationState) await retry(() => publishReservationState(ha, reservationState));
    if (authenticated) {
      await retry(() => ha.publish('sensor.wally_status', 'ready', {
        detail: 'Wally API session validated. Waiting for Home Assistant command subscription.',
        booking_accepted_locally: config.allowBooking,
      }));
    }
    if (authenticated && reservationState?.data.pending) {
      try { await withPower(() => runReservationAction({ action: 'restore' }, config, client, ha, reservationState)); }
      catch (error) {
        console.error(`Startup reservation recovery requires attention: ${localDiagnostic(error)}`);
        await ha.publish('sensor.wally_status', 'attention_required', {
          detail: 'Interrupted replacement could not be recovered. Renew the API session, then use Restore previous desk.',
        });
      }
    }
    console.log('API worker connected. Daily times are managed by Home Assistant.');
    heartbeat = timers.setInterval(publishHeartbeat, 60_000);
    for (;;) {
      try { await ha.listen(onCommand, controller.signal, onReady); break; }
      catch (error) {
        if (controller.signal.aborted || !isTransientHaError(error) || ++listenFailures >= MAX_LISTEN_FAILURES) throw error;
        console.error(`Home Assistant event connection lost (${localDiagnostic(error)}); reconnecting.`);
        subscribed = false;
        await backoff(Math.min(30_000, 2000 * 2 ** (listenFailures - 1)), controller.signal);
      }
    }
  } finally {
    controller.abort();
    if (heartbeat !== undefined) timers.clearInterval(heartbeat);
    await queue;
    await heartbeatWork;
    try {
      await ha.publish('sensor.wally_status', 'offline', { detail: 'API worker stopped' });
      await ha.publish('sensor.wally_worker_heartbeat', 'offline', { last_seen: new Date().toISOString() });
    }
    catch (error) { console.error(`Offline status publication failed: ${localDiagnostic(error)}`); }
    finally { await client.close(); }
  }
  if (fatalError) throw fatalError;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`Worker stopped (${error.name}): ${localDiagnostic(error)}`);
    process.exitCode = 1;
  });
}

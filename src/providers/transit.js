import { cached } from '../cache.js';
import { getConfig } from '../config.js';

const FEED_URL = 'https://bustime.ttc.ca/gtfsrt/trips';

function varint(bytes, cursor) {
  let value = 0n;
  let shift = 0n;
  while (cursor.i < bytes.length && shift <= 70n) {
    const byte = bytes[cursor.i++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7n;
  }
  throw new Error('invalid protobuf varint');
}

function fields(bytes, visit) {
  const cursor = { i: 0 };
  while (cursor.i < bytes.length) {
    const key = Number(varint(bytes, cursor));
    const number = key >>> 3;
    const wire = key & 7;
    if (wire === 0) {
      visit(number, wire, varint(bytes, cursor));
    } else if (wire === 2) {
      const length = Number(varint(bytes, cursor));
      const end = cursor.i + length;
      if (end > bytes.length) throw new Error('truncated protobuf field');
      visit(number, wire, bytes.subarray(cursor.i, end));
      cursor.i = end;
    } else if (wire === 1) {
      cursor.i += 8;
    } else if (wire === 5) {
      cursor.i += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
    if (cursor.i > bytes.length) throw new Error('truncated protobuf field');
  }
}

const textDecoder = new TextDecoder();
const text = bytes => textDecoder.decode(bytes);

function decodeEvent(bytes) {
  const event = {};
  fields(bytes, (field, wire, value) => {
    if (field === 2 && wire === 0) event.time = Number(value);
  });
  return event;
}

function decodeStop(bytes) {
  const stop = {};
  fields(bytes, (field, wire, value) => {
    if (field === 2 && wire === 2) stop.arrival = decodeEvent(value);
    if (field === 3 && wire === 2) stop.departure = decodeEvent(value);
    if (field === 4 && wire === 2) stop.stopId = text(value);
  });
  return stop;
}

function decodeTrip(bytes) {
  const trip = {};
  fields(bytes, (field, wire, value) => {
    if (field === 5 && wire === 2) trip.routeId = text(value);
    if (field === 6 && wire === 0) trip.directionId = Number(value);
  });
  return trip;
}

function decodeTripUpdate(bytes) {
  const update = { stopTimeUpdate: [] };
  fields(bytes, (field, wire, value) => {
    if (field === 1 && wire === 2) update.trip = decodeTrip(value);
    if (field === 2 && wire === 2) update.stopTimeUpdate.push(decodeStop(value));
  });
  return update;
}

export function decodeFeed(bytes) {
  const feed = { entity: [] };
  fields(bytes, (field, wire, value) => {
    if (field !== 2 || wire !== 2) return;
    const entity = {};
    fields(value, (entityField, entityWire, entityValue) => {
      if (entityField === 3 && entityWire === 2) entity.tripUpdate = decodeTripUpdate(entityValue);
    });
    if (entity.tripUpdate) feed.entity.push(entity);
  });
  return feed;
}

function seconds(value) {
  if (value == null) return null;
  if (typeof value === 'object' && typeof value.toNumber === 'function') return value.toNumber();
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function parseTransitFeed(feed, cfg, nowMs = Date.now()) {
  const stopId = String(cfg.stopId || '').trim();
  if (!stopId) return { ok: false, configured: false, items: [], error: 'stop not configured' };
  const routeFilter = new Set((cfg.routes || []).map(String));
  const directionFilter = cfg.direction === 0 || cfg.direction === 1 ? cfg.direction : null;
  const now = Math.floor(nowMs / 1000);
  const items = [];
  for (const entity of feed.entity || []) {
    const update = entity.tripUpdate;
    const trip = update?.trip || {};
    const route = String(trip.routeId || '');
    if (routeFilter.size && !routeFilter.has(route)) continue;
    if (directionFilter !== null && Number(trip.directionId) !== directionFilter) continue;
    for (const stop of update?.stopTimeUpdate || []) {
      if (String(stop.stopId || '') !== stopId) continue;
      const at = seconds(stop.arrival?.time) ?? seconds(stop.departure?.time);
      if (at == null || at < now - 30) continue;
      items.push({
        route: route || '?',
        direction: trip.directionId,
        directionLabel: cfg.directionLabel || '',
        minutes: Math.max(0, Math.round((at - now) / 60)),
        arrivalTime: at * 1000
      });
    }
  }
  items.sort((a, b) => a.arrivalTime - b.arrivalTime);
  return {
    ok: true,
    configured: true,
    stopId,
    stopName: cfg.stopName || `Stop ${stopId}`,
    items: items.slice(0, 6),
    source: 'TTC GTFS-Realtime'
  };
}

export async function getTransit() {
  const cfg = getConfig().transit;
  if (!String(cfg.stopId || '').trim()) {
    return { ok: false, configured: false, items: [], stopName: cfg.stopName, error: 'stop not configured' };
  }
  return cached(`ttc:${cfg.stopId}:${(cfg.routes || []).join(',')}:${cfg.direction ?? ''}`, 60 * 1000, async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const response = await fetch(FEED_URL, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'DayPane/0.3.3', Accept: 'application/x-protobuf' }
      });
      if (!response.ok) return { ok: false, configured: true, items: [], error: `http ${response.status}` };
      const bytes = new Uint8Array(await response.arrayBuffer());
      const feed = decodeFeed(bytes);
      return parseTransitFeed(feed, cfg);
    } catch (error) {
      return { ok: false, configured: true, items: [], error: error.name === 'AbortError' ? 'timeout' : error.message };
    } finally {
      clearTimeout(timer);
    }
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFeed, parseTransitFeed, parseUmoPredictions } from '../src/providers/transit.js';

const v = value => {
  const out = [];
  let n = BigInt(value);
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return out;
};
const bytes = (field, payload) => [...v((field << 3) | 2), ...v(payload.length), ...payload];
const str = (field, value) => bytes(field, [...new TextEncoder().encode(value)]);
const scalar = (field, value) => [...v(field << 3), ...v(value)];

test('transit remains honest when unconfigured', () => {
  assert.deepEqual(parseTransitFeed({}, {}), {
    ok: false, configured: false, items: [], error: 'stop not configured'
  });
});

test('transit filters stop, route and direction and sorts predictions', () => {
  const now = 2_000_000_000;
  const entity = (stopId, routeId, directionId, offset) => ({
    tripUpdate: {
      trip: { routeId, directionId },
      stopTimeUpdate: [{ stopId, arrival: { time: now + offset } }]
    }
  });
  const result = parseTransitFeed({ entity: [
    entity('1234', '501', 0, 720), entity('1234', '501', 0, 180),
    entity('9999', '501', 0, 60), entity('1234', '504', 0, 60),
    entity('1234', '501', 1, 60)
  ] }, { stopId: '1234', stopName: 'Queen St', routes: ['501'], direction: 0, directionLabel: 'Eastbound' }, now * 1000);
  assert.equal(result.ok, true);
  assert.deepEqual(result.items.map(x => x.minutes), [3, 12]);
  assert.equal(result.items[0].directionLabel, 'Eastbound');
});

test('minimal decoder reads TTC trip update fields without a runtime protobuf dependency', () => {
  const event = scalar(2, 2_000_000_180);
  const stop = [...bytes(2, event), ...str(4, '1234')];
  const trip = [...str(5, '501'), ...scalar(6, 1)];
  const update = [...bytes(1, trip), ...bytes(2, stop)];
  const entity = bytes(3, update);
  const feed = decodeFeed(Uint8Array.from(bytes(2, entity)));
  assert.equal(feed.entity[0].tripUpdate.trip.routeId, '501');
  assert.equal(feed.entity[0].tripUpdate.trip.directionId, 1);
  assert.equal(feed.entity[0].tripUpdate.stopTimeUpdate[0].stopId, '1234');
  assert.equal(feed.entity[0].tripUpdate.stopTimeUpdate[0].arrival.time, 2_000_000_180);
});

test('UmoIQ stop predictions accept singleton JSON objects and retain route filtering', () => {
  const data = { predictions: {
    routeTag: '161', stopTitle: 'Dovercourt Rd At Dupont St',
    direction: { title: 'East - 161 Rogers Rd', prediction: [
      { minutes: '9', epochTime: '2000000540000', branch: '161' },
      { minutes: '26', epochTime: '2000001560000', branch: '161' }
    ] }
  } };
  const result = parseUmoPredictions(data, {
    stopId: '10766', stopName: 'Dovercourt Rd at Dupont St', routes: ['161'], directionLabel: 'Eastbound'
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items.map(x => x.minutes), [9, 26]);
  assert.equal(result.items[0].route, '161');
  assert.equal(result.items[0].directionLabel, 'Eastbound');
});

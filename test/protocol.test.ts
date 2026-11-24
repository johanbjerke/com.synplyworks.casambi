import assert from 'assert';
import {
  classifyWireStatus,
  controlTargetMatches,
  interpretCasambiMessage,
  isSessionHttpStatus,
  parseUnitState,
  toUnitId,
} from '../lib/protocol';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(err);
  }
}

test('known openWireSucceed is a successful open', () => {
  const result = classifyWireStatus('openWireSucceed');
  assert.strictEqual(result.treatAsOpen, true);
  assert.strictEqual(result.known, true);
  assert.strictEqual(result.kind, 'open');
});

test('legacy open wireStatus is still accepted', () => {
  const result = classifyWireStatus('open');
  assert.strictEqual(result.treatAsOpen, true);
  assert.strictEqual(result.known, true);
});

test('renamed success-like wireStatus is accepted and marked unknown', () => {
  const result = classifyWireStatus('wireOpenedSuccessfully');
  assert.strictEqual(result.treatAsOpen, true);
  assert.strictEqual(result.known, false);
  assert.strictEqual(result.kind, 'open');
});

test('invalidSession is classified as session, not open', () => {
  const result = classifyWireStatus('invalidSession');
  assert.strictEqual(result.treatAsOpen, false);
  assert.strictEqual(result.kind, 'session');
});

test('human too-many-wires message is busy', () => {
  const result = classifyWireStatus('Only one wire allowed per network!');
  assert.strictEqual(result.kind, 'busy');
  assert.strictEqual(result.treatAsOpen, false);
});

test('keyAuthorizeFailed is auth failure', () => {
  const result = classifyWireStatus('keyAuthorizeFailed');
  assert.strictEqual(result.kind, 'auth');
  assert.strictEqual(result.treatAsOpen, false);
});

test('invalidValueType is a value error', () => {
  const result = classifyWireStatus('invalidValueType');
  assert.strictEqual(result.kind, 'value');
  assert.strictEqual(result.treatAsOpen, false);
});

test('unknown error-like status is not treated as open', () => {
  const result = classifyWireStatus('protocolVersionMismatch');
  assert.strictEqual(result.treatAsOpen, false);
  assert.strictEqual(result.known, false);
});

test('toUnitId coerces numeric strings used by Homey device data', () => {
  assert.strictEqual(toUnitId('12'), 12);
  assert.strictEqual(toUnitId(7), 7);
});

test('toUnitId rejects non-integers', () => {
  assert.throws(() => toUnitId('track-a'));
});

test('parseUnitState reads official dimLevel + controls payload', () => {
  const parsed = parseUnitState({
    id: 45,
    online: true,
    dimLevel: 0.5,
    controls: [{ type: 'Dimmer', value: 0.5 }],
  });
  assert.strictEqual(parsed.online, true);
  assert.strictEqual(parsed.dimLevel, 0.5);
  assert.strictEqual(parsed.on, true);
});

test('parseUnitState falls back to Dimmer control when dimLevel is missing', () => {
  const parsed = parseUnitState({
    id: 2,
    controls: [{ type: 'Dimmer', name: 'dimmer0', value: 0.25 }],
  });
  assert.strictEqual(parsed.dimLevel, 0.25);
  assert.strictEqual(parsed.on, true);
  assert.strictEqual(parsed.online, undefined);
});

test('parseUnitState understands OnOff control without dimmer', () => {
  const parsed = parseUnitState({
    controls: [{ type: 'OnOff', value: 0 }],
  });
  assert.strictEqual(parsed.on, false);
  assert.strictEqual(parsed.dimLevel, undefined);
});

test('parseUnitState uses the on boolean when present', () => {
  const parsed = parseUnitState({ on: true, online: true });
  assert.strictEqual(parsed.on, true);
  assert.strictEqual(parsed.online, true);
});

test('interpretCasambiMessage maps pong', () => {
  const actions = interpretCasambiMessage({ response: 'pong' });
  assert.deepStrictEqual(actions, [{ type: 'pong' }]);
});

test('interpretCasambiMessage maps unitChanged', () => {
  const payload = { method: 'unitChanged', id: 1, dimLevel: 1 };
  const actions = interpretCasambiMessage(payload);
  assert.strictEqual(actions.length, 1);
  assert.strictEqual(actions[0].type, 'unitChanged');
});

test('interpretCasambiMessage maps networkUpdated', () => {
  const actions = interpretCasambiMessage({ method: 'networkUpdated', wire: 1 });
  assert.strictEqual(actions[0].type, 'networkUpdated');
});

test('interpretCasambiMessage maps peerChanged', () => {
  const actions = interpretCasambiMessage({ method: 'peerChanged', online: false });
  assert.strictEqual(actions[0].type, 'peerChanged');
});

test('interpretCasambiMessage flags unknown methods for logging', () => {
  const actions = interpretCasambiMessage({ method: 'fixtureFirmwareUpdated', wire: 1 });
  assert.strictEqual(actions[0].type, 'unhandled-method');
  if (actions[0].type === 'unhandled-method') {
    assert.strictEqual(actions[0].method, 'fixtureFirmwareUpdated');
  }
});

test('interpretCasambiMessage flags unexpected payloads', () => {
  const actions = interpretCasambiMessage({ foo: 'bar' });
  assert.strictEqual(actions[0].type, 'unexpected');
});

test('interpretCasambiMessage treats renamed open ack as wire-open', () => {
  const actions = interpretCasambiMessage({ wireStatus: 'openWireOk', ref: 'x' });
  assert.strictEqual(actions[0].type, 'wire-open');
  if (actions[0].type === 'wire-open') {
    assert.strictEqual(actions[0].known, false);
  }
});

test('HTTP 401/403 are session failures', () => {
  assert.strictEqual(isSessionHttpStatus(401), true);
  assert.strictEqual(isSessionHttpStatus(403), true);
  assert.strictEqual(isSessionHttpStatus(500), false);
});

test('controlTargetMatches confirms a dimmer command from dimLevel', () => {
  assert.strictEqual(controlTargetMatches({ id: 3, dimLevel: 0.5 }, { Dimmer: { value: 0.5 } }), 'match');
  assert.strictEqual(controlTargetMatches({ id: 3, dimLevel: 0.51 }, { Dimmer: { value: 0.5 } }), 'match');
  assert.strictEqual(controlTargetMatches({ id: 3, dimLevel: 0.2 }, { Dimmer: { value: 0.5 } }), 'mismatch');
});

test('controlTargetMatches confirms off from dimLevel 0 or controls', () => {
  assert.strictEqual(controlTargetMatches({ id: 3, dimLevel: 0 }, { OnOff: { value: 0 }, Dimmer: { value: 0 } }), 'match');
  assert.strictEqual(
    controlTargetMatches({ id: 3, controls: [{ type: 'Dimmer', value: 0 }] }, { Dimmer: { value: 0 } }),
    'match',
  );
  assert.strictEqual(controlTargetMatches({ id: 3, on: true }, { Dimmer: { value: 0 } }), 'mismatch');
});

test('controlTargetMatches cannot judge colour-only commands', () => {
  assert.strictEqual(controlTargetMatches({ id: 3, dimLevel: 0.4 }, { RGB: { hue: 0.1, sat: 1 } }), 'unknown');
  assert.strictEqual(controlTargetMatches({ id: 3 }, { Dimmer: { value: 0.4 } }), 'unknown');
});

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}

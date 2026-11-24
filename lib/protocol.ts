/**
 * Casambi cloud WebSocket protocol helpers.
 *
 * Official docs (developer.casambi.com / docs.casambi.com, 2026):
 *   - OPEN success wireStatus is `openWireSucceed` (older servers used `open`)
 *   - PING reply is `{ response: "pong" }`
 *   - Event methods: unitChanged, peerChanged, networkUpdated
 *   - Control unit IDs are integers
 *
 * Casambi has changed acknowledgement strings before (open → openWireSucceed).
 * These helpers accept known values, treat success-like unknowns as open so
 * control is not blocked, and label everything else for clear logging.
 */

export const KNOWN_WIRE_OPEN_STATUSES = ['open', 'openWireSucceed'];

export const KNOWN_WIRE_ERROR_STATUSES = [
  'keyAuthenticateFailed',
  'keyAuthorizeFailed',
  'invalidSession',
  'tooManyWires',
  'invalidValueType',
  'invalidData',
  'unauthorized',
];

export type WireStatusKind =
  | 'open'
  | 'auth'
  | 'session'
  | 'busy'
  | 'value'
  | 'error'
  | 'unknown';

export interface WireStatusClassification {
  kind: WireStatusKind;
  status: string;
  known: boolean;
  treatAsOpen: boolean;
}

export type CasambiAction =
  | { type: 'pong' }
  | { type: 'wire-open'; status: string; known: boolean }
  | { type: 'wire-session-invalid'; status: string }
  | { type: 'wire-auth-failed'; status: string }
  | { type: 'wire-busy'; status: string }
  | { type: 'wire-error'; status: string; known: boolean }
  | { type: 'unitChanged'; payload: Record<string, unknown> }
  | { type: 'peerChanged'; payload: Record<string, unknown> }
  | { type: 'networkUpdated'; payload: Record<string, unknown> }
  | { type: 'unhandled-method'; method: string; payload: Record<string, unknown> }
  | { type: 'unexpected'; payload: unknown; reason: string };

export interface ParsedUnitState {
  id?: number | string;
  online?: boolean;
  on?: boolean;
  dimLevel?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function classifyWireStatus(status: unknown): WireStatusClassification {
  const text = status === undefined || status === null ? '' : String(status);
  const lower = text.toLowerCase();
  const knownOpen = KNOWN_WIRE_OPEN_STATUSES.indexOf(text) !== -1;
  const knownError = KNOWN_WIRE_ERROR_STATUSES.indexOf(text) !== -1;

  if (knownOpen) {
    return { kind: 'open', status: text, known: true, treatAsOpen: true };
  }

  if (text === 'invalidSession' || lower.indexOf('invalid session') !== -1) {
    return { kind: 'session', status: text, known: knownError, treatAsOpen: false };
  }

  if (
    text === 'keyAuthenticateFailed'
    || text === 'keyAuthorizeFailed'
    || lower.indexOf('keyauthenticate') !== -1
    || lower.indexOf('keyauthorize') !== -1
    || lower.indexOf('unauthorized') !== -1
  ) {
    return { kind: 'auth', status: text, known: knownError, treatAsOpen: false };
  }

  if (
    text === 'tooManyWires'
    || lower.indexOf('toomanywires') !== -1
    || lower.indexOf('too many wires') !== -1
    || lower.indexOf('only one wire') !== -1
  ) {
    return { kind: 'busy', status: text, known: knownError, treatAsOpen: false };
  }

  if (text === 'invalidValueType' || text === 'invalidData' || lower.indexOf('invalid') !== -1) {
    return { kind: 'value', status: text, known: knownError, treatAsOpen: false };
  }

  // Unknown acknowledgement: if it looks like a successful open, accept it so
  // a renamed wireStatus (the open → openWireSucceed change) does not brick control.
  const looksLikeSuccess = (
    (lower.indexOf('open') !== -1 && lower.indexOf('fail') === -1)
    || lower.indexOf('succeed') !== -1
    || lower.indexOf('success') !== -1
  );
  if (looksLikeSuccess) {
    return { kind: 'open', status: text, known: false, treatAsOpen: true };
  }

  return { kind: 'unknown', status: text, known: false, treatAsOpen: false };
}

export function toUnitId(deviceId: unknown): number {
  if (typeof deviceId === 'number' && Number.isFinite(deviceId)) {
    return deviceId;
  }
  const parsed = parseInt(String(deviceId), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Casambi unit id is not an integer: ${String(deviceId)}`);
  }
  return parsed;
}

function isDimmerControl(control: Record<string, unknown>): boolean {
  const type = String(control.type || '').toLowerCase();
  const name = String(control.name || '').toLowerCase();
  return type === 'dimmer' || name === 'dimmer' || name.indexOf('dimmer') === 0;
}

function isOnOffControl(control: Record<string, unknown>): boolean {
  const type = String(control.type || '').toLowerCase();
  const name = String(control.name || '').toLowerCase();
  return type === 'onoff' || name === 'onoff' || name === 'on/off';
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

export function parseUnitState(state: unknown): ParsedUnitState {
  const record = asRecord(state);
  if (!record) {
    return {};
  }

  const parsed: ParsedUnitState = {};
  if (record.id !== undefined) {
    parsed.id = record.id as number | string;
  }

  if (typeof record.online === 'boolean') {
    parsed.online = record.online;
  }

  if (typeof record.on === 'boolean') {
    parsed.on = record.on;
  }

  const topDim = numericValue(record.dimLevel);
  if (topDim !== undefined) {
    parsed.dimLevel = topDim;
  }

  if (Array.isArray(record.controls)) {
    for (let i = 0; i < record.controls.length; i += 1) {
      const control = asRecord(record.controls[i]);
      if (!control) {
        continue;
      }
      const value = numericValue(control.value);
      if (parsed.dimLevel === undefined && isDimmerControl(control) && value !== undefined) {
        parsed.dimLevel = value;
      }
      if (parsed.on === undefined && isOnOffControl(control) && value !== undefined) {
        parsed.on = value > 0;
      }
    }
  }

  if (parsed.on === undefined && parsed.dimLevel !== undefined) {
    parsed.on = parsed.dimLevel > 0;
  }

  return parsed;
}

export function interpretCasambiMessage(data: unknown): CasambiAction[] {
  const record = asRecord(data);
  if (!record) {
    return [{ type: 'unexpected', payload: data, reason: 'non-object websocket payload' }];
  }

  const actions: CasambiAction[] = [];

  if (record.response === 'pong') {
    actions.push({ type: 'pong' });
  }

  if ('wireStatus' in record) {
    const classified = classifyWireStatus(record.wireStatus);
    if (classified.treatAsOpen) {
      actions.push({ type: 'wire-open', status: classified.status, known: classified.known });
    } else if (classified.kind === 'session') {
      actions.push({ type: 'wire-session-invalid', status: classified.status });
    } else if (classified.kind === 'auth') {
      actions.push({ type: 'wire-auth-failed', status: classified.status });
    } else if (classified.kind === 'busy') {
      actions.push({ type: 'wire-busy', status: classified.status });
    } else {
      actions.push({
        type: 'wire-error',
        status: classified.status,
        known: classified.known,
      });
    }
  }

  if (typeof record.method === 'string') {
    if (record.method === 'unitChanged') {
      actions.push({ type: 'unitChanged', payload: record });
    } else if (record.method === 'peerChanged') {
      actions.push({ type: 'peerChanged', payload: record });
    } else if (record.method === 'networkUpdated') {
      actions.push({ type: 'networkUpdated', payload: record });
    } else if (record.method !== 'ping') {
      actions.push({ type: 'unhandled-method', method: record.method, payload: record });
    }
  }

  if (actions.length === 0) {
    actions.push({
      type: 'unexpected',
      payload: data,
      reason: 'no method, wireStatus, or pong in server message',
    });
  }

  return actions;
}

export function isSessionHttpStatus(status: number): boolean {
  return status === 401 || status === 403;
}

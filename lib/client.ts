import fetch, {HeaderInit} from 'node-fetch';
import WebSocket from 'ws';
import {
  classifyWireStatus,
  controlTargetMatches,
  interpretCasambiMessage,
  isSessionHttpStatus,
  toUnitId,
} from './protocol';

export const BASE_URL = 'https://door.casambi.com/v1';

const PING_INTERVAL_MS = 60 * 1000;
const PONG_GRACE_MS = 20 * 1000;
// Casambi has no command ack. A controlUnit is confirmed when the unit's
// new state comes back (unitChanged) or shows up in REST state.
const ACK_TIMEOUT_MS = 10 * 1000;
// Pongs arrive every PING_INTERVAL_MS, so this much silence means the
// socket is open on our side but dead on the server side.
const RX_SILENT_MS = 3 * 60 * 1000;
// OPEN must be acknowledged (openWireSucceed) or controls queue forever.
const OPEN_ACK_TIMEOUT_MS = 30 * 1000;
const MAX_HEALTH_EVENTS = 40;
const STATE_POLL_INTERVAL_MS = 60 * 1000;
const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 60 * 1000;
const TOOMANY_WIRES_BACKOFF_MS = 30 * 1000;
const MAX_QUEUED_CONTROLS = 40;

export interface Network {
  id: string;
  mac: string;
  name: string;
  type: string;
  grade: string;
  sessionId: string;
}

export interface NetworkList {
  [id: string]: Network;
}

interface SocketStates {
  [networkId: string]: WebSocket;
}

interface WireState {
  opened: boolean;
  queue: string[];
}

interface WireStates {
  [networkId: string]: WireState;
}

export interface Device {
  id: string;
  name: string;
  on: boolean;
  online: boolean;
  condition: number;
  activeSceneId: number;
  address: string;
  image: string;
  firmwareVersion: string;
  position: number;
  fixtureId: number;
  groupId: number;
  type: string;
}

interface Devices {
  [id: string]: Device;
}

export interface NetworkState {
  id: string;
  grade: string;
  address: string;
  name: string;
  type: string;
  timezone: string;
  gateway: any;
  units: Devices;
  groups: Array<any>;
  scenes: Array<any>;
  dimLevel: string;
  activeScenes: Array<any>;
}

interface Dictionary {
  [key: string]: string | boolean | number;
}

interface UnitChangedHandler {
  (state: any): void
}

interface UnitChangedHandlerId {
  deviceId: number;
  unitChangedCallback: UnitChangedHandler;
}

interface UnitChangedHandlerNetworkList {
  [networkId: string]: Array<UnitChangedHandlerId>;
}

interface PendingAck {
  unitId: number;
  data: string;
  targetControls: unknown;
  sentAt: number;
  retried: boolean;
  timer: NodeJS.Timeout;
}

export interface NetworkHealth {
  networkId: string;
  socketOpenedAt?: number;
  wireOpenedAt?: number;
  lastWireStatus?: string;
  lastRxAt?: number;
  lastPingAt?: number;
  lastPongAt?: number;
  lastUnitChangedAt?: number;
  lastControlSentAt?: number;
  lastControlAckAt?: number;
  lastAckVia?: string;
  controlOk: boolean | null;
  controlsSent: number;
  controlsAcked: number;
  ackTimeouts: number;
  consecutiveAckFailures: number;
  reconnects: number;
  lastReconnectAt?: number;
  lastReconnectReason?: string;
  lastRestOkAt?: number;
  lastRestError?: string;
  unitsTotal?: number;
  unitsOffline?: number;
  events: Array<{ at: string; msg: string }>;
}

interface SocketMeta {
  generation: number;
  lastPongAt: number;
  pingAt: number;
}

export default class Client {
  protected token: string;

  protected username: string;

  protected password: string;

  protected networks?: NetworkList;

  protected wire = 1;

  protected sockets: SocketStates = {};

  protected wireStates: WireStates = {};

  protected pingTimers: { [networkId: string]: NodeJS.Timer } = {};

  protected pollTimers: { [networkId: string]: NodeJS.Timer } = {};

  protected reconnectTimers: { [networkId: string]: NodeJS.Timer } = {};

  protected socketMeta: { [networkId: string]: SocketMeta } = {};

  protected reconnectDelayMs: { [networkId: string]: number } = {};

  protected headers: Dictionary = {
    'Content-Type': 'application/json',
  };

  protected loginInFlight?: Promise<NetworkList>;

  protected gatewayName?: string;

  protected lastUnitChangedAt: { [networkId: string]: number } = {};

  protected unitChangedNetworkCallbacks: UnitChangedHandlerNetworkList = {};

  protected pendingAcks: { [networkId: string]: { [unitId: string]: PendingAck } } = {};

  protected retriedControls: Set<string> = new Set();

  protected health: { [networkId: string]: NetworkHealth } = {};

  constructor(token: string, username: string, password: string) {
    this.token = token;
    this.username = username;
    this.password = password;

    this.headers['X-Casambi-Key'] = token;
  }

  async testCredentials(): Promise<boolean> {
    try {
      return !!await this.getNetworks();
    } catch {
      return false;
    }
  }

  async getNetworks(): Promise<NetworkList> {
    if (!this.isAuthenticated()) {
      await this.login();
    }

    if (!this.networks) {
      throw new Error('Still not authenticated');
    }

    return this.networks;
  }

  async getNetwork(networkId: string): Promise<Network> {
    return this.getNetworks().then((networks: NetworkList) => {
      const network = networks[networkId];
      if (!network) {
        throw new Error(`Unknown Casambi network ${networkId}`);
      }
      return network;
    });
  }

  async getNetworkState(networkId: string): Promise<NetworkState> {
    return this.fetchNetworkState(networkId, true);
  }

  async addUnitChangedHandler(networkId: string, deviceId: number, unitChangedCallback: UnitChangedHandler) {
    console.log(`Connecting socket for device to network ${networkId}`);

    if (!(networkId in this.unitChangedNetworkCallbacks)) {
      this.unitChangedNetworkCallbacks[networkId] = [];
    }

    const handlers = this.unitChangedNetworkCallbacks[networkId];
    const existing = handlers.find((handler) => String(handler.deviceId) === String(deviceId));
    if (existing) {
      existing.unitChangedCallback = unitChangedCallback;
    } else {
      handlers.push({ deviceId, unitChangedCallback });
    }

    const network = await this.getNetwork(networkId);
    this.getSocket(network);
    this.ensurePoll(networkId);
  }

  async updateDeviceState(
    networkId: string,
    deviceId: number,
    targetControls: {}, // { Dimmer: { value: 0.5 } },
  ) {
    const network = await this.getNetwork(networkId);
    const socket = this.getSocket(network);
    this.ensureWireState(networkId);
    this.ensurePoll(networkId);

    const data = JSON.stringify({
      wire: this.wire,
      method: 'controlUnit',
      id: toUnitId(deviceId),
      targetControls,
    });

    const wireState = this.wireStates[networkId];
    console.log(
      'Client.updateDeviceState',
      deviceId,
      JSON.stringify(targetControls),
      'socketOpen=', socket.readyState === WebSocket.OPEN,
      'wireOpened=', wireState ? wireState.opened : false,
    );

    if (socket.readyState === WebSocket.OPEN && wireState && wireState.opened) {
      this.sendControl(socket, networkId, data);
    } else {
      console.log('Client.updateDeviceState: wire not ready, queueing control message');
      this.enqueueControl(networkId, data);
    }
  }

  protected rawSend(socket: WebSocket, data: string) {
    console.log('Client.rawSend ->', data);
    socket.send(data);
  }

  protected ensureWireState(networkId: string): WireState {
    if (!this.wireStates[networkId]) {
      this.wireStates[networkId] = { opened: false, queue: [] };
    }
    return this.wireStates[networkId];
  }

  protected enqueueControl(networkId: string, data: string) {
    const wireState = this.ensureWireState(networkId);
    wireState.queue.push(data);
    while (wireState.queue.length > MAX_QUEUED_CONTROLS) {
      wireState.queue.shift();
      console.log('Client: dropped oldest queued control message (queue full)');
    }
  }

  protected flushQueue(socket: WebSocket, networkId: string) {
    const wireState = this.wireStates[networkId];
    if (!wireState || !wireState.opened) {
      return;
    }
    while (wireState.queue.length > 0) {
      const msg = wireState.queue.shift() as string;
      console.log('Client.flushQueue: sending queued control message');
      this.sendControl(socket, networkId, msg);
    }
  }

  protected getSocket(network: Network): WebSocket {
    const existing = this.sockets[network.id];
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      return existing;
    }

    return this.openSocket(network);
  }

  protected openSocket(network: Network): WebSocket {
    const networkId = network.id;
    // Keep any queued controls across reconnects. The first connection has
    // an empty queue, so this is safe for a fresh open too.
    this.discardSocket(networkId, true);

    const previous = this.socketMeta[networkId];
    const generation = (previous ? previous.generation : 0) + 1;
    this.socketMeta[networkId] = {
      generation,
      lastPongAt: Date.now(),
      pingAt: 0,
    };

    console.log(`Opening socket for networkId ${networkId} generation ${generation}`);
    const socket = new WebSocket('wss://door.casambi.com/v1/bridge/', this.token);
    this.sockets[networkId] = socket;
    const wireState = this.ensureWireState(networkId);
    wireState.opened = false;

    const pingTimer = setInterval(() => {
      this.sendKeepAlive(networkId);
    }, PING_INTERVAL_MS);
    this.pingTimers[networkId] = pingTimer;

    socket.on('open', () => {
      if (!this.isCurrentSocket(networkId, socket, generation)) {
        return;
      }
      this.getHealthEntry(networkId).socketOpenedAt = Date.now();
      this.sendOpenMessage(networkId, socket).catch((err) => {
        console.log('Client: failed to send OPEN message', err);
      });
      setTimeout(() => {
        if (this.isCurrentSocket(networkId, socket, generation) && !this.ensureWireState(networkId).opened) {
          this.healthEvent(networkId, 'OPEN not acknowledged within 30s, reconnecting');
          this.scheduleReconnect(networkId, 'open-ack-timeout');
        }
      }, OPEN_ACK_TIMEOUT_MS);
    });

    socket.on('message', (raw: WebSocket.RawData) => {
      if (!this.isCurrentSocket(networkId, socket, generation)) {
        return;
      }
      this.getHealthEntry(networkId).lastRxAt = Date.now();
      this.handleSocketMessage(networkId, socket, raw);
    });

    socket.on('error', (event: WebSocket.ErrorEvent) => {
      console.log('WebSocket Error:', event && (event as any).message ? (event as any).message : event);
      if (!this.isCurrentSocket(networkId, socket, generation)) {
        return;
      }
      this.scheduleReconnect(networkId, 'error');
    });

    socket.on('close', (code: number, reason: Buffer) => {
      const reasonText = reason ? reason.toString() : '';
      console.log('WebSocket Closed!', code, reasonText);
      if (!this.isCurrentSocket(networkId, socket, generation)) {
        return;
      }
      this.scheduleReconnect(networkId, `close ${code} ${reasonText}`.trim());
    });

    return socket;
  }

  protected isCurrentSocket(networkId: string, socket: WebSocket, generation: number): boolean {
    const meta = this.socketMeta[networkId];
    return this.sockets[networkId] === socket && !!meta && meta.generation === generation;
  }

  protected async sendOpenMessage(networkId: string, socket: WebSocket) {
    const network = await this.getNetwork(networkId);
    const reference = `homey-${networkId}-${Date.now()}`;
    const type = 1; // FRONTEND — required to be allowed to control units

    const OPEN = JSON.stringify({
      method: 'open',
      id: network.id,
      session: network.sessionId,
      ref: reference,
      wire: this.wire,
      type,
    });
    console.log('WebSocket open: sending OPEN message');
    this.rawSend(socket, OPEN);
  }

  protected handleSocketMessage(networkId: string, socket: WebSocket, raw: WebSocket.RawData) {
    const text = typeof raw === 'string' ? raw : raw.toString();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.log('Client: failed to parse websocket message', text);
      return;
    }

    const actions = interpretCasambiMessage(data);
    for (let i = 0; i < actions.length; i += 1) {
      this.applyAction(networkId, socket, actions[i], data);
    }
  }

  protected applyAction(
    networkId: string,
    socket: WebSocket,
    action: ReturnType<typeof interpretCasambiMessage>[number],
    raw: unknown,
  ) {
    switch (action.type) {
      case 'pong': {
        const meta = this.socketMeta[networkId];
        if (meta) {
          meta.lastPongAt = Date.now();
        }
        this.getHealthEntry(networkId).lastPongAt = Date.now();
        console.log('Client: keep-alive pong received');
        break;
      }
      case 'wire-open': {
        this.ensureWireState(networkId).opened = true;
        this.reconnectDelayMs[networkId] = RECONNECT_MIN_MS;
        {
          const h = this.getHealthEntry(networkId);
          h.wireOpenedAt = Date.now();
          h.lastWireStatus = action.status;
        }
        this.healthEvent(networkId, `wire opened (${action.status})`);
        if (!action.known) {
          console.log(
            `Client: WARNING unknown open acknowledgement "${action.status}" - treating as wire open. Full message:`,
            JSON.stringify(raw),
          );
        } else {
          console.log(`Client: wire ${this.wire} opened for ${networkId} (status "${action.status}"), flushing queue`);
        }
        this.flushQueue(socket, networkId);
        this.publishNetworkState(networkId).catch((err) => {
          console.log('Client: failed to publish network state', err);
        });
        break;
      }
      case 'wire-session-invalid': {
        console.log(
          `Client: WARNING wire status "${action.status}" - session expired, re-authenticating. Full message:`,
          JSON.stringify(raw),
        );
        this.refreshSessionAndReconnect(networkId).catch((err) => {
          console.log('Client: session refresh failed', err);
        });
        break;
      }
      case 'wire-auth-failed': {
        console.log(
          `Client: ERROR API key rejected ("${action.status}"). Control will not work until Casambi enables WebSocket on this key. Full message:`,
          JSON.stringify(raw),
        );
        break;
      }
      case 'wire-busy': {
        console.log(
          `Client: WARNING "${action.status}" - too many wires. Backing off before reconnect. Full message:`,
          JSON.stringify(raw),
        );
        this.reconnectDelayMs[networkId] = Math.max(
          this.reconnectDelayMs[networkId] || RECONNECT_MIN_MS,
          TOOMANY_WIRES_BACKOFF_MS,
        );
        this.scheduleReconnect(networkId, 'tooManyWires');
        break;
      }
      case 'wire-error': {
        const knownLabel = action.known ? 'known' : 'UNKNOWN';
        console.log(
          `Client: WARNING ${knownLabel} wireStatus "${action.status}" - control messages may be rejected. Full message:`,
          JSON.stringify(raw),
        );
        this.getHealthEntry(networkId).lastWireStatus = action.status;
        this.healthEvent(networkId, `wireStatus "${action.status}"`);
        // A non-value error on an open wire (e.g. the server closed the wire)
        // leaves us sending into nothing. Re-open instead of staying stale.
        if (classifyWireStatus(action.status).kind !== 'value') {
          this.ensureWireState(networkId).opened = false;
          this.scheduleReconnect(networkId, `wireStatus ${action.status}`);
        }
        break;
      }
      case 'unitChanged': {
        if (!this.ensureWireState(networkId).opened) {
          this.wireStates[networkId].opened = true;
          this.flushQueue(socket, networkId);
        }
        this.lastUnitChangedAt[networkId] = Date.now();
        this.getHealthEntry(networkId).lastUnitChangedAt = Date.now();
        console.log('Client: webSocket method=unitChanged data:', JSON.stringify(action.payload));
        this.checkAck(networkId, action.payload, 'unitChanged');
        this.dispatchUnit(networkId, action.payload);
        break;
      }
      case 'peerChanged': {
        console.log('Client: peerChanged', JSON.stringify(action.payload));
        const online = (action.payload as { online?: boolean }).online;
        if (online === false) {
          console.log('Client: Casambi gateway/peer went offline for', networkId);
        } else if (online === true) {
          console.log('Client: Casambi gateway/peer came online for', networkId);
        }
        this.publishNetworkState(networkId, { trustRestOnline: true }).catch((err) => {
          console.log('Client: failed to publish network state after peerChanged', err);
        });
        break;
      }
      case 'networkUpdated': {
        console.log(
          'Client: networkUpdated - fetching REST state and re-opening the wire (Casambi firmware/config change). Full message:',
          JSON.stringify(action.payload),
        );
        this.handleNetworkUpdated(networkId).catch((err) => {
          console.log('Client: failed to handle networkUpdated', err);
        });
        break;
      }
      case 'unhandled-method': {
        console.log(
          `Client: unexpected server method "${action.method}". Full message:`,
          JSON.stringify(action.payload),
        );
        break;
      }
      case 'unexpected': {
        console.log(
          `Client: unexpected server message (${action.reason}):`,
          JSON.stringify(action.payload),
        );
        break;
      }
      default:
        break;
    }
  }

  protected dispatchUnit(networkId: string, unit: any) {
    if (!(networkId in this.unitChangedNetworkCallbacks)) {
      return;
    }

    const state = this.gatewayName ? { ...unit, gatewayName: this.gatewayName } : unit;
    this.unitChangedNetworkCallbacks[networkId].forEach(({ deviceId, unitChangedCallback }) => {
      if (deviceId === unit.id || String(deviceId) === String(unit.id)) {
        unitChangedCallback(state);
      }
    });
  }

  // REST state includes each unit's `online` flag even when the WebSocket
  // does not push a unitChanged snapshot. Homey uses that flag to show the
  // gateway as offline instead of a live on/off control.
  protected async publishNetworkState(networkId: string, opts?: { trustRestOnline?: boolean }) {
    const state = await this.getNetworkState(networkId);
    const gatewayName = state.gateway && state.gateway.name;
    if (gatewayName) {
      this.gatewayName = gatewayName;
    }

    const units = state.units ? Object.values(state.units) : [];
    const offline = units.filter((unit) => unit && unit.online === false).length;
    {
      const h = this.getHealthEntry(networkId);
      h.lastRestOkAt = Date.now();
      h.lastRestError = undefined;
      h.unitsTotal = units.length;
      h.unitsOffline = offline;
    }
    const lastWs = this.lastUnitChangedAt[networkId];
    const wsFresh = !!lastWs && (Date.now() - lastWs) < (2 * STATE_POLL_INTERVAL_MS);
    const trustRestOnline = (opts && opts.trustRestOnline) || !wsFresh;
    console.log(
      `Client: network state gateway="${this.gatewayName || 'unknown'}" units=${units.length} offline=${offline} wsFresh=${wsFresh}`,
    );

    units.forEach((unit) => {
      if (!unit) {
        return;
      }
      if (!trustRestOnline && unit.online === false) {
        // Websocket recently proved the mesh is live. Do not flap Homey to
        // unavailable just because a REST snapshot still says online:false.
        const copy: Device = { ...unit };
        delete (copy as { online?: boolean }).online;
        this.dispatchUnit(networkId, copy);
        return;
      }
      this.dispatchUnit(networkId, unit);
    });
  }

  protected async handleNetworkUpdated(networkId: string) {
    try {
      await this.publishNetworkState(networkId, { trustRestOnline: true });
    } catch (err) {
      if (this.isLikelySessionError(err)) {
        await this.refreshSessionAndReconnect(networkId);
        return;
      }
      throw err;
    }

    // A fresh socket+OPEN is more reliable after firmware/config changes than
    // re-using the existing wire (which can return tooManyWires).
    this.reconnectDelayMs[networkId] = RECONNECT_MIN_MS;
    this.scheduleReconnect(networkId, 'networkUpdated');
  }

  protected sendKeepAlive(networkId: string) {
    const socket = this.sockets[networkId];
    const meta = this.socketMeta[networkId];
    if (!socket || socket.readyState !== WebSocket.OPEN || !meta) {
      return;
    }

    const pingAt = Date.now();
    meta.pingAt = pingAt;
    this.getHealthEntry(networkId).lastPingAt = pingAt;
    const { generation } = meta;
    this.rawSend(socket, JSON.stringify({
      method: 'ping',
      wire: this.wire,
    }));
    setTimeout(() => {
      const current = this.socketMeta[networkId];
      if (!current || current.generation !== generation || this.sockets[networkId] !== socket) {
        return;
      }
      if (current.lastPongAt < pingAt) {
        console.log('Client: no pong within grace period, reconnecting', networkId);
        this.healthEvent(networkId, 'no pong within 20s, reconnecting');
        this.scheduleReconnect(networkId, 'pong-timeout');
      }
    }, PONG_GRACE_MS);
  }

  protected ensurePoll(networkId: string) {
    if (this.pollTimers[networkId]) {
      return;
    }
    this.pollTimers[networkId] = setInterval(() => {
      this.pollNetwork(networkId).catch((err) => {
        console.log('Client: periodic state poll failed', err);
      });
    }, STATE_POLL_INTERVAL_MS);
  }

  protected async pollNetwork(networkId: string) {
    try {
      await this.publishNetworkState(networkId);
    } catch (err) {
      if (this.isLikelySessionError(err)) {
        await this.refreshSessionAndReconnect(networkId);
        return;
      }
      console.log('Client: poll could not fetch network state', err);
      this.getHealthEntry(networkId).lastRestError = err instanceof Error ? err.message : String(err);
    }

    const socket = this.sockets[networkId];
    if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
      const network = await this.getNetwork(networkId);
      this.getSocket(network);
      return;
    }

    // Open-but-dead socket: nothing (not even pongs) received for a while.
    const h = this.getHealthEntry(networkId);
    const wireState = this.wireStates[networkId];
    if (socket.readyState === WebSocket.OPEN && wireState && wireState.opened) {
      const lastRx = h.lastRxAt || h.wireOpenedAt || 0;
      if (Date.now() - lastRx > RX_SILENT_MS) {
        this.healthEvent(networkId, 'no websocket traffic for 3 min, reconnecting');
        this.scheduleReconnect(networkId, 'rx-silent');
      }
    }
  }

  protected scheduleReconnect(networkId: string, reason: string) {
    if (this.reconnectTimers[networkId]) {
      console.log(`Client: reconnect already scheduled for ${networkId} (${reason})`);
      return;
    }

    this.discardSocket(networkId, true);
    {
      const h = this.getHealthEntry(networkId);
      h.reconnects += 1;
      h.lastReconnectAt = Date.now();
      h.lastReconnectReason = reason;
    }

    const delay = this.reconnectDelayMs[networkId] || RECONNECT_MIN_MS;
    const nextDelay = Math.min(Math.max(delay, RECONNECT_MIN_MS) * 2, RECONNECT_MAX_MS);
    this.reconnectDelayMs[networkId] = nextDelay;

    console.log(`Client: reconnecting ${networkId} in ${delay}ms (${reason})`);
    this.reconnectTimers[networkId] = setTimeout(() => {
      delete this.reconnectTimers[networkId];
      this.getNetwork(networkId).then((network) => {
        this.getSocket(network);
      }).catch((err) => {
        console.log('Client: reconnect failed to resolve network', err);
        this.scheduleReconnect(networkId, 'resolve-failed');
      });
    }, delay);
  }

  protected discardSocket(networkId: string, keepQueue: boolean) {
    const socket = this.sockets[networkId];
    if (this.pingTimers[networkId]) {
      clearInterval(this.pingTimers[networkId]);
      delete this.pingTimers[networkId];
    }

    if (socket) {
      socket.removeAllListeners();
      try {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
      } catch (err) {
        console.log('Client: error closing discarded socket', err);
      }
      delete this.sockets[networkId];
    }

    const wireState = this.wireStates[networkId];
    if (wireState) {
      wireState.opened = false;
      if (!keepQueue) {
        wireState.queue = [];
      }
    }
  }

  protected async refreshSessionAndReconnect(networkId: string) {
    this.networks = undefined;
    await this.login();
    this.reconnectDelayMs[networkId] = RECONNECT_MIN_MS;
    this.scheduleReconnect(networkId, 'session-refresh');
  }

  protected async fetchNetworkState(networkId: string, retryOnSessionError: boolean): Promise<NetworkState> {
    const NETWORK_STATE_URL = `${BASE_URL}/networks/${networkId}/state`;
    const h = {
      ...this.headers,
      'X-Casambi-Session': (await this.getNetwork(networkId)).sessionId,
    };

    const response = await fetch(NETWORK_STATE_URL, {
      method: 'GET',
      headers: h,
    });

    const body = await response.text();
    if (!response.ok) {
      console.log('getting devices failed:', body);
      if (retryOnSessionError && isSessionHttpStatus(response.status)) {
        this.networks = undefined;
        await this.login();
        return this.fetchNetworkState(networkId, false);
      }
      throw new Error(`getting devices failed: ${body}`);
    }

    try {
      return JSON.parse(body) as NetworkState;
    } catch (err) {
      throw new Error(`getting devices failed: invalid JSON: ${body}`);
    }
  }

  // ---- control confirmation and health -------------------------------------

  protected getHealthEntry(networkId: string): NetworkHealth {
    if (!this.health[networkId]) {
      this.health[networkId] = {
        networkId,
        controlOk: null,
        controlsSent: 0,
        controlsAcked: 0,
        ackTimeouts: 0,
        consecutiveAckFailures: 0,
        reconnects: 0,
        events: [],
      };
    }
    return this.health[networkId];
  }

  protected healthEvent(networkId: string, msg: string) {
    console.log(`Client: health ${networkId}: ${msg}`);
    const h = this.getHealthEntry(networkId);
    h.events.push({ at: new Date().toISOString(), msg });
    while (h.events.length > MAX_HEALTH_EVENTS) {
      h.events.shift();
    }
  }

  protected sendControl(socket: WebSocket, networkId: string, data: string) {
    this.rawSend(socket, data);
    const h = this.getHealthEntry(networkId);
    h.lastControlSentAt = Date.now();
    h.controlsSent += 1;

    let parsed: { id?: unknown; targetControls?: unknown };
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const unitId = Number(parsed.id);
    if (!Number.isFinite(unitId)) {
      return;
    }

    if (!this.pendingAcks[networkId]) {
      this.pendingAcks[networkId] = {};
    }
    const pending = this.pendingAcks[networkId];
    const key = String(unitId);
    if (pending[key]) {
      // A newer command for the same unit supersedes the older one.
      clearTimeout(pending[key].timer);
    }
    const retried = this.retriedControls.has(data);
    this.retriedControls.delete(data);
    const entry: PendingAck = {
      unitId,
      data,
      targetControls: parsed.targetControls,
      sentAt: Date.now(),
      retried,
      timer: setTimeout(() => {
        this.onAckTimeout(networkId, entry).catch((err) => {
          console.log('Client: ack timeout handling failed', err);
        });
      }, ACK_TIMEOUT_MS),
    };
    pending[key] = entry;
  }

  protected resolveAck(networkId: string, entry: PendingAck, via: string) {
    const pending = this.pendingAcks[networkId];
    if (!pending || pending[String(entry.unitId)] !== entry) {
      return;
    }
    clearTimeout(entry.timer);
    delete pending[String(entry.unitId)];
    const h = this.getHealthEntry(networkId);
    h.lastControlAckAt = Date.now();
    h.lastAckVia = via;
    h.controlsAcked += 1;
    if (h.controlOk === false || h.consecutiveAckFailures > 0) {
      this.healthEvent(networkId, `control confirmed again (unit ${entry.unitId} via ${via})`);
    }
    h.consecutiveAckFailures = 0;
    h.controlOk = true;
    console.log(`Client: control for unit ${entry.unitId} confirmed via ${via} after ${Date.now() - entry.sentAt}ms`);
  }

  protected checkAck(networkId: string, unit: any, via: string) {
    const pending = this.pendingAcks[networkId];
    if (!pending || !unit || unit.id === undefined) {
      return;
    }
    const entry = pending[String(unit.id)];
    if (!entry) {
      return;
    }
    // 'mismatch' may be an intermediate fade level; keep waiting until timeout.
    if (controlTargetMatches(unit, entry.targetControls) !== 'mismatch') {
      this.resolveAck(networkId, entry, via);
    }
  }

  protected async onAckTimeout(networkId: string, entry: PendingAck) {
    const pending = this.pendingAcks[networkId];
    if (!pending || pending[String(entry.unitId)] !== entry) {
      return;
    }

    // Last chance: the command may have worked without an event (e.g. the
    // unit was already at that level). REST state is the cloud's view of
    // the luminaire as reported by the gateway.
    let restUnit: any;
    try {
      const state = await this.fetchNetworkState(networkId, true);
      restUnit = state.units ? (state.units as any)[String(entry.unitId)] : undefined;
      if (!restUnit && state.units) {
        restUnit = Object.values(state.units).find((u: any) => u && String(u.id) === String(entry.unitId));
      }
    } catch (err) {
      console.log('Client: REST check after ack timeout failed', err);
    }
    if (pending[String(entry.unitId)] !== entry) {
      return; // superseded or acked meanwhile
    }
    if (restUnit && controlTargetMatches(restUnit, entry.targetControls) !== 'mismatch') {
      this.resolveAck(networkId, entry, 'rest');
      return;
    }

    delete pending[String(entry.unitId)];
    const h = this.getHealthEntry(networkId);
    h.ackTimeouts += 1;
    h.consecutiveAckFailures += 1;
    const offline = restUnit && restUnit.online === false ? ' (unit offline in Casambi)' : '';

    if (!entry.retried) {
      this.healthEvent(
        networkId,
        `unit ${entry.unitId} did not confirm control within 10s${offline}; reconnecting and resending once`,
      );
      this.retriedControls.add(entry.data);
      this.enqueueControl(networkId, entry.data);
      this.ensureWireState(networkId).opened = false;
      this.reconnectDelayMs[networkId] = RECONNECT_MIN_MS;
      this.scheduleReconnect(networkId, 'control-ack-timeout');
      return;
    }

    h.controlOk = false;
    this.healthEvent(
      networkId,
      `unit ${entry.unitId} still not confirmed after reconnect${offline}; refreshing Casambi session`,
    );
    this.refreshSessionAndReconnect(networkId).catch((err) => {
      console.log('Client: session refresh after ack failure failed', err);
    });
  }

  getHealth(): NetworkHealth[] {
    const now = Date.now();
    return Object.keys(this.health).map((networkId) => {
      const h = this.health[networkId];
      const socket = this.sockets[networkId];
      const wireState = this.wireStates[networkId];
      const pending = this.pendingAcks[networkId] || {};
      const states = ['connecting', 'open', 'closing', 'closed'];
      return {
        ...h,
        events: h.events.slice(-15),
        socketState: socket ? states[socket.readyState] : 'none',
        wireOpened: !!(wireState && wireState.opened),
        queued: wireState ? wireState.queue.length : 0,
        pendingAcks: Object.keys(pending).length,
        rxAgeSec: h.lastRxAt ? Math.round((now - h.lastRxAt) / 1000) : null,
        restAgeSec: h.lastRestOkAt ? Math.round((now - h.lastRestOkAt) / 1000) : null,
      } as NetworkHealth;
    });
  }

  protected isLikelySessionError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    const lower = message.toLowerCase();
    return lower.indexOf('401') !== -1
      || lower.indexOf('403') !== -1
      || lower.indexOf('invalid session') !== -1
      || lower.indexOf('unauthorized') !== -1;
  }

  protected isAuthenticated = (): boolean => {
    return !!this.networks;
  };

  protected async login(): Promise<NetworkList> {
    if (this.loginInFlight) {
      return this.loginInFlight;
    }

    this.loginInFlight = this.performLogin().then((networks) => {
      this.loginInFlight = undefined;
      return networks;
    }, (err) => {
      this.loginInFlight = undefined;
      throw err;
    });

    return this.loginInFlight;
  }

  protected async performLogin(): Promise<NetworkList> {
    delete this.headers['X-Casambi-Session'];

    const AUTHENTICATE_URL = `${BASE_URL}/networks/session`;
    const response = await fetch(AUTHENTICATE_URL, {
      method: 'POST',
      body: JSON.stringify({
        email: this.username,
        password: this.password,
      }),
      headers: this.headers as HeaderInit,
    });

    const body = await response.text();
    if (!response.ok) {
      console.log(`authentication failed for ${this.username}: `, body);
      throw new Error(`authentication failed: ${body}`);
    }

    try {
      this.networks = JSON.parse(body) as NetworkList;
    } catch (err) {
      throw new Error(`authentication failed: invalid JSON: ${body}`);
    }

    console.log(`authentication succeeded for ${this.username}`);
    return this.networks;
  }
}

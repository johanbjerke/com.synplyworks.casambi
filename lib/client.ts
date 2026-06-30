import fetch, {HeaderInit} from 'node-fetch';
import WebSocket from 'ws';
import LuminaireDevice from "../drivers/luminaires/device";

export const BASE_URL = 'https://door.casambi.com/v1';

export interface Network {
  id: string;
  mac: string;
  name: string;
  type: string;
  grade: string;
  sessionId: string;
}

export interface NetworkList {
  // expires_at: number;
  [id: string]: Network;
}

interface SocketStates {
  [id: string]: WebSocket;
}

// Tracks whether the OPEN handshake for a given wire/socket has been
// acknowledged by the server. Control messages must only be sent on a
// wire that has been successfully opened, otherwise the server silently
// drops them (this is the main cause of the "read-only" behaviour).
interface WireState {
  opened: boolean;
  // queued control messages waiting for the wire to open
  queue: string[];
}

interface WireStates {
  [id: string]: WireState;
}

export interface Device {
  // scheduleId: string;
  id: string;
  name: string;
  // isOnline: boolean;
  // model: string;
  // manufacturer: string;
  // properties: Array<any>;
  // parameters: Object
  // _etag: string;
  // bdrSetting: number;
  // priority: number;
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
  [key: string]: Array<UnitChangedHandlerId>;
}

export default class Client {
  protected token: string;

  protected username: string;

  protected password: string;

  protected networks?: NetworkList;

  protected wire = 1;

  protected sockets: SocketStates = {};

  protected wireStates: WireStates = {};

  protected timers: { [key: string]: NodeJS.Timer } = {};

  protected headers: Dictionary = {
    'Content-Type': 'application/json',
  };

  protected isLoggingIn = false;

  protected unitChangedNetworkCallbacks: UnitChangedHandlerNetworkList = {};
  protected connectedDevices: { [key: string]: LuminaireDevice } = {};


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
      // console.log('Searching network in networkList', networkId, networks);
      return networks[networkId];
    });
  }

  async getNetworkState(networkId: string): Promise<NetworkState> {
    const NETWORK_STATE_URL = `${BASE_URL}/networks/${networkId}/state`;
    const h = {
      ...this.headers,
      'X-Casambi-Session': (await this.getNetwork(networkId)).sessionId,
    };

    // console.log('getting devices from:', NETWORK_STATE_URL, 'with headers:', h);
    const response = await fetch(NETWORK_STATE_URL, {
      method: 'GET',
      headers: h,
    });

    if (!response.ok) {
      console.log('getting devices failed:', await response.text());
      throw new Error(`getting devices failed: ${await response.text()}`);
    }

    const networkState = await response.json() as NetworkState;

    console.log('getting devices succeeded!');
    // console.dir(networkState);

    return networkState;
  }

  async addUnitChangedHandler(networkId: string, deviceId: number, unitChangedCallback: UnitChangedHandler) {
    console.log(`Connecting socket for device to network ${networkId}`);

    const network = await this.getNetwork(networkId);
    const sessionKey = `${network.id}-${network.sessionId}`;
    if (!(sessionKey in this.unitChangedNetworkCallbacks)) {
      this.unitChangedNetworkCallbacks[sessionKey] = [];
    }

    this.unitChangedNetworkCallbacks[sessionKey].push({ deviceId, unitChangedCallback });
    this.getSocket(network); // connect if not already

    // unitChangedCallback(); // TODO: update data for current deviceId if present
  }

  async updateDeviceState(
    networkId: string,
    deviceId: number,
    targetControls: {}, // { Dimmer: { value: 0.5 } },
  ) {
    const network = await this.getNetwork(networkId);
    const socket = this.getSocket(network);
    const sessionKey = `${network.id}-${network.sessionId}`;

    const data = JSON.stringify({
      wire: this.wire,
      method: 'controlUnit',
      id: deviceId,
      targetControls,
    });

    const wireState = this.wireStates[sessionKey];
    console.log(
      'Client.updateDeviceState',
      deviceId,
      JSON.stringify(targetControls),
      'socketOpen=', socket.readyState === WebSocket.OPEN,
      'wireOpened=', wireState ? wireState.opened : false,
    );

    // Only send once the wire has been OPENed (acknowledged by the server).
    // If the socket is connected but the wire is not yet open, queue the
    // message and flush it from the OPEN-ack / unitChanged handler.
    if (socket.readyState === WebSocket.OPEN && wireState && wireState.opened) {
      this.rawSend(socket, data);
    } else if (wireState) {
      console.log('Client.updateDeviceState: wire not ready, queueing control message');
      wireState.queue.push(data);
    } else {
      console.log('Client.updateDeviceState: no wire state available, message dropped');
    }
  }

  // Centralised raw send so all outgoing messages are logged consistently.
  protected rawSend(socket: WebSocket, data: string) {
    console.log('Client.rawSend ->', data);
    socket.send(data);
  }

  protected flushQueue(socket: WebSocket, sessionKey: string) {
    const wireState = this.wireStates[sessionKey];
    if (!wireState || !wireState.opened) {
      return;
    }
    while (wireState.queue.length > 0) {
      const msg = wireState.queue.shift() as string;
      console.log('Client.flushQueue: sending queued control message');
      this.rawSend(socket, msg);
    }
  }

  protected getSocket(network: Network): WebSocket {
    const sessionKey = `${network.id}-${network.sessionId}`;

    if (!this.sockets[sessionKey]) {
      console.log(`Opening socket for networkId ${network.id} and sessionId ${network.sessionId}`);
      // Pass the API key as the WebSocket sub-protocol, as required by Casambi.
      this.sockets[sessionKey] = new WebSocket('wss://door.casambi.com/v1/bridge/', this.token);
      const socket = this.sockets[sessionKey];

      // initialise wire state for this socket
      this.wireStates[sessionKey] = { opened: false, queue: [] };

      // ping every 4 minutes to keep socket alive (server closes idle wires after 5 min)
      const timer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          // console.log('ping to keep alive: ', timer);
          const PING = JSON.stringify({
            method: 'ping',
            wire: this.wire,
          });

          this.rawSend(socket, PING);
        }
      }, 4 * 60 * 1000);
      this.timers[sessionKey] = timer;

      socket.on('open', (): void => {
        const reference = 'REFERENCE-ID'; // Reference handle created by client to link messages to relevant callbacks
        const type = 1; // Client type, use value 1 (FRONTEND) - required to be allowed to control units

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
      });

      socket.onmessage = (event: WebSocket.MessageEvent): void => {
        let data: any;
        try {
          data = JSON.parse(event.data.toString());
        } catch (e) {
          console.log('Client: failed to parse websocket message', event.data.toString());
          return;
        }

        // Log every server response so that silent rejections become visible.
        // The server reports problems via `wireStatus` (e.g. "invalidValueType",
        // "tooManyWires", "unauthorized") which were previously ignored entirely.
        if ('wireStatus' in data) {
          console.log('Client: webSocket server wireStatus response:', JSON.stringify(data));

          // A successful OPEN is acknowledged with a wireStatus of "open"
          // (and includes the network state). Mark the wire as opened and
          // flush any control messages that were queued while connecting.
          if (data.wireStatus === 'open') {
            this.wireStates[sessionKey].opened = true;
            console.log(`Client: wire ${this.wire} opened for ${sessionKey}, flushing queue`);
            this.flushQueue(socket, sessionKey);
          } else {
            // Any other wireStatus is an error condition worth surfacing.
            console.log(`Client: WARNING wire status "${data.wireStatus}" - control messages may be rejected`);
          }
        }

        if ('method' in data) {
          if (data.method === 'unitChanged') {
            // Initial device state info and device state changed event.
            // Receiving these confirms the wire is alive; ensure it is marked open.
            if (!this.wireStates[sessionKey].opened) {
              this.wireStates[sessionKey].opened = true;
              this.flushQueue(socket, sessionKey);
            }

            console.log("Client: webSocket.onmessage(event) method=unitChanged data: ", JSON.stringify(data));
            if (sessionKey in this.unitChangedNetworkCallbacks) {
              this.unitChangedNetworkCallbacks[sessionKey].forEach(({ deviceId, unitChangedCallback }) => {
                if (deviceId === data.id) {
                  unitChangedCallback(data);
                }
              }); // TODO: for devices else info log and store lateststate for later usage
            }
          } else if (data.method === 'networkUpdated') {
            // Network changed event, for example device added to a group within the network
            // Network setting or composition has somehow changed.
            // Fetching latest network information from REST API and
            // re-sending the OPEN message to WebSocket is recommended. *
            console.log('Client: networkUpdated event received');
          } else if (data.method === 'peerChanged') {
            // Devices online changed event, for example new device has joined the network
            // In most cases no action required.
          } else {
            console.log('Client: unhandled websocket method', data.method, JSON.stringify(data));
          }
        }
      };

      socket.on('error', (event: WebSocket.ErrorEvent): void => {
        console.log('WebSocket Error (Reconnecting...):', event);

        this.reconnect(network, timer);
      });

      socket.onclose = (event: WebSocket.CloseEvent): void => {
        console.log('WebSocket Closed! Reconnecting...', event && (event as any).code, event && (event as any).reason);

        this.reconnect(network, timer);
      };

      // } else {
      //   console.log(`Reusing socket for networkId ${network.id} with sessionId ${network.sessionId}`);
    }

    return this.sockets[sessionKey];
  }

  protected reconnect(network: Network, timer: NodeJS.Timer) {
    const sessionKey = `${network.id}-${network.sessionId}`;
    clearInterval(timer);
    if (this.timers[sessionKey]) {
      clearInterval(this.timers[sessionKey]);
      delete this.timers[sessionKey];
    }
    delete this.sockets[sessionKey];
    delete this.wireStates[sessionKey];

    // Debounce reconnect to avoid the connection storm that previously caused
    // Casambi to revoke this app's API key (10000+ connections/minute).
    setTimeout(() => {
      this.getSocket(network); // reconnect socket
    }, 5000);
  }

  protected isAuthenticated = (): boolean => {
    return !!this.networks; // TODO: && Date.now() < this.networks.expires_at;
  };

  protected async login(): Promise<NetworkList> {
    if (this.isLoggingIn) {
      // wait when already logging and retry returning result eventually
      await new Promise((resolve) => setTimeout(resolve, 100));
      return this.getNetworks();
    }

    this.isLoggingIn = true;
    delete this.headers['X-Casambi-Session'];

    const AUTHENTICATE_URL = `${BASE_URL}/networks/session`;
    // console.log('authenticating at: ', AUTHENTICATE_URL, {
    const response = await fetch(AUTHENTICATE_URL, {
      method: 'POST',
      body: JSON.stringify({
        email: this.username,
        password: this.password,
      }),
      headers: this.headers as HeaderInit,
    });

    if (!response.ok) {
      this.isLoggingIn = false;
      console.log(`authentication failed for ${this.username}: `, await response.text());
      throw new Error(`authentication failed: ${await response.text()}`);
    }

    this.networks = await response.json() as NetworkList;
    this.isLoggingIn = false;

    console.log(`authentication succeeded for ${this.username}`);
    // console.log(response.json, this.auth);

    return this.networks;
  }
}

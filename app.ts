import * as crypto from 'crypto';
import WebSocket from 'ws';
import Client, {Network} from './lib/client';
import LuminaireDevice from './drivers/luminaires/device';

const Homey = require('homey');

// Start debugger only if one isn't already active. Newer Homey CLI versions
// start their own inspector, so calling inspector.open() again throws
// "Inspector is already activated" and crashes the app on startup.
if (process.env.DEBUG === "1") {
  const inspector = require("inspector");
  if (!inspector.url()) {
    try {
      inspector.open(9229, "0.0.0.0", false);
    } catch (err) {
      console.log("Could not open inspector (probably already active):", err);
    }
  }
}

export default class CasambiApp extends Homey.App {
  protected clients: { [key: string]: Client } = {};

  protected startedAt = Date.now();

  onInit() {
    this.startedAt = Date.now();
    this.log('Casambi is running...');
  }

  /**
   * Wire/control health for the watchdog (GET /api/app/com.synplyworks.casambi/health).
   * healthy = websocket open, wire opened, traffic in the last 3 min (pongs
   * arrive every minute), REST state fresh, and the last light command was
   * confirmed (or none sent yet). Contains no credentials or session ids.
   */
  getHealth() {
    const now = Date.now();
    const networks = Object.values(this.clients).reduce(
      (all: any[], client) => all.concat(client.getHealth()), [],
    );
    const uptimeSec = Math.round((now - this.startedAt) / 1000);
    const problems: string[] = [];
    networks.forEach((n: any) => {
      if (n.socketState !== 'open') problems.push(`${n.networkId}: socket ${n.socketState}`);
      if (!n.wireOpened) problems.push(`${n.networkId}: wire not opened`);
      if (n.rxAgeSec === null || n.rxAgeSec > 180) problems.push(`${n.networkId}: no websocket traffic for ${n.rxAgeSec}s`);
      if (n.restAgeSec === null || n.restAgeSec > 180) problems.push(`${n.networkId}: REST state stale (${n.restAgeSec}s)`);
      if (n.controlOk === false) problems.push(`${n.networkId}: last light command not confirmed`);
    });
    if (networks.length === 0) problems.push('no Casambi network connected');
    // Give a fresh start a minute to connect before calling it unhealthy.
    const warmingUp = uptimeSec < 90;
    return {
      version: this.homey.manifest.version,
      uptimeSec,
      healthy: problems.length === 0,
      warmingUp,
      problems,
      networks,
    };
  }

  getClientForUser(username: string, password: string): Client {
    // The same account can be saved with different email casing, which
    // opened two WebSocket sessions to the same network.
    const normalizedUser = `${username}`.trim().toLowerCase();
    this.log(`Casambi getClientFor: ${normalizedUser}`);

    const key = crypto.createHash('md5').update(normalizedUser + password).digest('hex');

    if (!(key in this.clients)) {
      this.clients[key] = new Client(Homey.env.API_KEY, normalizedUser, password);
    // } else {
      // this.log(` - returning client ${username} from cache`);
    }

    return this.clients[key];
  }

  async updateDeviceState(device: LuminaireDevice, state: {}) {
    const client = this.getClientForUser(device.getSettings().username, device.getSettings().password);

    await client.updateDeviceState(device.getData().network_id, device.getData().id, state);
  }

  async connectDevice(device: LuminaireDevice) {
    const client = this.getClientForUser(device.getSettings().username, device.getSettings().password);

    client.addUnitChangedHandler(device.getData().network_id, device.getData().id, device.updateState.bind(device));
  }
}

module.exports = CasambiApp;

# Casambi → Homey integration: "read-only" diagnosis & fix

## Symptom
- App authenticates, lists networks and luminaires correctly.
- Device state is read correctly (lights show up with current on/off + dim).
- **No control works** — on/off and dim changes have no effect on the lights.
- **No errors shown** in the Homey GUI.

This "reads work, writes silently fail" pattern is the key clue: the REST
side (auth + network state) and the inbound WebSocket events (`unitChanged`)
are fine, but outbound control (`controlUnit`) is being dropped or rejected
without the app noticing.

## Candidate causes analysed (multiple angles)

1. **Message format wrong?** — No. The `controlUnit` payload
   `{ wire, method:"controlUnit", id, targetControls:{ Dimmer:{ value:0..1 } } }`
   exactly matches the official Casambi developer docs and a known-working
   LogicMachine implementation. Format is correct.

2. **`escape()` / `decodeURIComponent()` corrupting the payload?** — Unlikely
   to be the root cause for ASCII JSON, but it is deprecated and was removed.

3. **Control sent before the wire is OPEN (race condition)?** — **YES, likely.**
   `updateDeviceState` only checked `socket.readyState === OPEN`, but the
   Casambi wire requires a successful `OPEN` message handshake before
   `controlUnit` is accepted. A socket can be physically OPEN while the wire
   handshake has not completed, so control messages are silently discarded.

4. **App is blind to server rejections?** — **YES.** The Casambi server reports
   problems via `wireStatus` (e.g. `unauthorized`, `invalidValueType`,
   `tooManyWires`, `Only one wire allowed per network!`). The original code
   never inspected `wireStatus`, so every rejection failed silently — exactly
   matching "no errors in the GUI".

5. **API key revoked / restricted by Casambi?** — **Plausible and documented.**
   In May 2024 a Casambi cloud architect publicly stated they *revoked the API
   key for this exact app* because it was opening 10,000+ WebSocket
   connections per minute, and would only re-enable it once the implementation
   was fixed. A revoked or read-restricted key can still allow session auth and
   cached `unitChanged` reads while control commands are refused — which fits
   the symptom precisely.
   Source: Homey community thread "[APP][Pro] Casambi Controller".

## Fixes applied (v0.5.0)

### `lib/client.ts`
- **Wire-open tracking + control queueing.** Control messages are only sent
  after the server acknowledges the wire (`wireStatus: "open"`) or once the
  first `unitChanged` proves the wire is live. Until then they are queued and
  flushed — fixing the OPEN-before-control race.
- **Full server-response logging.** Every `wireStatus` is logged and any
  non-`open` status raises a WARNING. Silent rejections are now visible in the
  app logs (run `homey app run` to watch them).
- Removed deprecated `escape()` / `decodeURIComponent()` wrapping.
- **Debounced reconnect (5s)** to prevent the connection storm that previously
  caused Casambi to revoke the API key.
- Reset `isLoggingIn` on auth failure so the client can recover.

### `drivers/luminaires/device.ts`
- Use the dedicated **`OnOff`** control for on/off (with `Dimmer` fallback).
- Clamp `dim` to the required 0..1 range.
- Added **`ColorTemperature`** and **`RGB` hue/sat** listeners (guarded by
  `hasCapability`) so the declared colour capabilities actually do something.
- Parse `dimLevel` from a `controls[]` array as a fallback.
- **Rethrow control errors** so failures surface in the Homey UI instead of
  being swallowed.

## How to verify / next steps
1. `npm install` then `homey app run` (Homey CLI) to run the app in dev mode
   and watch the live logs.
2. Try toggling a light. Watch for:
   - `Client.rawSend -> {"wire":1,"method":"controlUnit",...}` (we sent it)
   - `wireStatus` responses from the server.
3. **If you see `wireStatus: "unauthorized"` (or control is accepted in logs
   but nothing happens), the API key is the problem** — it was revoked/limited
   by Casambi. Contact Casambi support (support@casambi.com) to obtain a
   WebSocket-enabled, control-capable API key and set it as `API_KEY` in the
   app's `env.json` / Homey environment.
4. If you see `tooManyWires` / "Only one wire allowed per network", the app is
   opening duplicate wires — the debounced reconnect should help, but confirm
   only one socket per network exists.

## v0.6.4 — control/state unreliable again after Casambi firmware

### Symptom
- On/off works only intermittently; dim and state reporting drop out.
- The same 11 luminaires also show as unavailable in Home Assistant.
- Pattern repeats whenever Casambi rolls out firmware.

There were no runtime Homey logs for this incident. The conclusions below
are from the current Casambi cloud docs (2026), the upstream Homey app,
Home Assistant / homebridge / aiocasambi clients, and a code review of
this fork.

### What the current protocol actually looks like
Official docs still use `wss://door.casambi.com/v1/bridge/` with the API
key as the sub-protocol. After connect, the client must send OPEN
(`type: 1` FRONTEND). Success is `wireStatus: "openWireSucceed"` (this
fork already accepted the older `"open"` as well). Keep-alive is an
application `ping` every ~4 minutes; the reply is `{ "response": "pong" }`.
`networkUpdated` means the network/firmware/config changed: **re-fetch
REST state and re-send OPEN**. `peerChanged` reports gateway join/leave.
`controlUnit` IDs are integers. Sessions expire; REST then returns 401
and the wire returns `invalidSession`.

### Root cause (best evidence)
Several bugs stacked so the app could not recover after a Casambi-side
drop — the same class of failure as HA showing every light unavailable:

1. **Stale websocket close/error killed the replacement connection.**
   `reconnect()` deleted the socket map entry but left the old socket's
   `onclose`/`onerror` handlers attached. When Casambi dropped the idle
   or firmware-updated wire, the old close event ran *after* a new socket
   had been opened and tore that one down too. Control then only worked
   in the brief window while a socket happened to be live. This also
   matches the historical connection-storm / revoked-API-key problem.

2. **`networkUpdated` was ignored.** Casambi documents this as the
   firmware/config-change event and tells clients to refresh REST + OPEN.
   The app only logged it, so a firmware rollout left the wire stale
   until Homey was restarted.

3. **Sessions never refreshed.** `this.networks` was cached forever and
   sockets were keyed by `networkId-sessionId`. `invalidSession` / REST
   401 was logged as a warning; the client kept reconnecting with the
   dead session. Device handlers registered on the old session key would
   also have been orphaned after a re-login.

4. **Availability got stuck.** v0.6.1 marks lights unavailable when REST
   `online === false` (gateway down — also what HA displays). Recovery
   required a later event with `online === true`. After a firmware blip
   `unitChanged` often has dim/on state but omits `online`, so Homey
   stayed unavailable even once the gateway was back.

5. **Queued controls were dropped** on reconnect, and **string unit ids**
   from Homey device data can make Casambi reply `invalidValueType`.

No current handshake field rename was found beyond the already-handled
`open` → `openWireSucceed` change. The app now treats success-like
unknown `wireStatus` values as open, and logs the full payload for any
unknown method/status so the next firmware change is obvious in Homey
logs.

### Fixes applied (v0.6.4)
- Generation-guarded sockets: close/error on a discarded socket is ignored.
- Socket/handler maps keyed by network id; re-login on `invalidSession`/401.
- Handle `networkUpdated` (REST refresh + re-OPEN) and `pong`; poll REST
  every 60s so gateway return is noticed even without a websocket event.
- Exponential reconnect backoff; keep the control queue across reconnects.
- Send integer `controlUnit` ids; parse OnOff / missing `dimLevel`.
- Recover availability on any non-offline state update.
- Log unknown server messages in full.

### What to watch in Homey logs after install
- `wire … opened … (status "openWireSucceed")` then `flushing queue`
- `networkUpdated` followed by a new OPEN
- `peerChanged` / `gateway="…" units=N offline=M`
- `keep-alive pong received`
- `WARNING unknown open acknowledgement` or `unexpected server method` —
  paste those lines if control breaks again; they are the next protocol change.
- `ERROR API key rejected` — the key is not WebSocket-enabled.
- `session expired, re-authenticating` — should recover by itself.

## v0.6.5: "available but no control"

Symptom: lights stay available in Homey, but commands do nothing.

Why 0.6.4 could not notice it:
- `controlUnit` is fire-and-forget. Casambi has no command ack, so a
  command sent into a dead wire just disappears.
- Availability is driven by the REST poll (`online` per unit), which goes
  through a different path (HTTPS) than control (WebSocket wire). REST can be
  fine while the wire is dead, so devices stay available.
- `wire.opened` was set once and never cleared, except on socket close. A
  later non-open `wireStatus` (server closed or rejected the wire) was only
  logged, and an OPEN that was never acknowledged left every control queued
  forever.
- Pong timeouts were only checked at the next ping (2 min), and a socket
  that is open locally but dead upstream (half-open TCP) was never detected.

What the app does now:
- Every `controlUnit` waits up to 10 s for proof that it worked: a
  `unitChanged` for that unit matching the target dim level, or failing
  that, the REST state matching it. If there is no proof, it reconnects
  (new socket and OPEN) and resends that command once. If the resend also
  isn't confirmed, `controlOk` becomes false and the Casambi session is
  refreshed (re-login and reconnect).
- Ping every 60 s, and reconnect if there's no pong within 20 s.
- Reconnect if the OPEN isn't acknowledged within 30 s, if nothing arrives
  on the socket for 3 min, or on any non-value `wireStatus` error.
- `GET /api/app/com.synplyworks.casambi/health` reports socket and wire
  state, last rx/pong/unitChanged/REST times, command sent/acked counts,
  `controlOk`, reconnect counts and reasons, and the last 15 health events.
  It contains no credentials.

Limit: an idle wire can't be proven to reach the luminaires without
sending a command, and we never send probe commands because they could
change a light visibly. Between commands, health means the cloud wire is
alive. The first command after a silent break is confirmed (or recovered)
within about 10 to 20 s.

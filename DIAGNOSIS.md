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

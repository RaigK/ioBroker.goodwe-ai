# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                                          # mocha, 10s timeout, all of tests/
npx mocha tests/register.test.js --timeout 10000  # single test file
```

Node `>=18` is required (pinned in `package.json` `engines`). Test failures on older Node are not bugs in the adapter.

**`npm run lint` does not work.** The script is `eslint .`, but eslint is not a dependency and no eslint config exists in the repo. Either wire it up properly (add `eslint` plus a flat config) or leave it alone — do not report lint as "passing".

**`mocha` and `chai` are not direct devDependencies.** They resolve transitively through `@iobroker/testing`. A dependency bump that drops them breaks the whole suite with a confusing `Cannot find module 'chai'`; if that happens, add them explicitly rather than pinning `@iobroker/testing` back.

Tests are pure unit tests — they require `lib/*` directly and never start the adapter or open a socket, so they run with no inverter present.

## Architecture

An **ioBroker adapter** (daemon mode) for Goodwe solar inverters (ET/EH/BT series). It polls the inverter over Modbus and exposes every value as an ioBroker state. The register map is ported from the [Home Assistant goodwe integration](https://github.com/marcelblijleven/goodwe) (`goodwe/et.py`) — when adding or fixing a register, check that file first; addresses, scales, and enum values should match it.

### Key files

- `main.js` — the whole adapter: `GoodweAiAdapter extends utils.Adapter`. Transport lifecycle, poll loop, register decoding, state writes, reconnect backoff. No sub-modules.
- `lib/registers.js` — the register map: 108 register definitions across 9 groups, plus the `REGISTER_GROUPS` label table. Pure data.
- `lib/transport-udp.js` — hand-rolled UDP-8899 Modbus RTU client for the legacy Wi-Fi-Kit dongle. No Modbus library involved; frame building, CRC16, and parsing are all local.

### Transport selection

`config.protocol` picks the client at connect time in `connect()`:
- `tcp` (default) → `modbus-serial`'s `ModbusRTU` over TCP port 502. For LAN-Kit / Ezlink3000.
- `udp` → `GoodweUdpClient` over UDP port 8899. For the old Wi-Fi-Kit (web UI on port 80, SSID `Solar-WiFi…`, no Modbus TCP).

`GoodweUdpClient` deliberately mimics `ModbusRTU`'s surface (`connectUDP`, `setID`, `setTimeout`, `readHoldingRegisters`, `writeRegister`, `writeRegisters`, `close`) so the read/write code in `main.js` never branches on protocol. **Keep that surface identical** — any new call added to the read or write path must exist on both clients.

UDP specifics worth knowing before touching `lib/transport-udp.js`:
- The gateway prepends a **2-byte prefix** to inbound frames that requests don't carry. `parseResponse` skips `data[0..1]`, and `verifyCrc` computes CRC16 over `data[2 .. crcOffset]`. Test vectors live in `tests/transport-udp.test.js`.
- CRC is Modbus RTU (poly `0xA001`, init `0xFFFF`), transmitted **little-endian** in the frame.
- Exactly one request is in flight at a time: `_exchange` chains onto `this._inflight`. Modbus RTU has no transaction ID, so the reply is matched by shape instead — never bypass `_exchange`.
- `classifyReply` is that matcher, and it is the reason `_onMessage` is not a plain resolve. The Wi-Fi-Kit sometimes answers late or twice, so a datagram is judged against the in-flight request's `expected` and returns one of three verdicts: `'match'` (hand to `parseResponse`), `'stale'` (a reply to an *earlier* request — drop it and keep waiting for the real one, up to the timeout), `'broken'` (addressed to this request but damaged — reject so `_exchange` retries at once). Widening a check here trades a lost poll for a silently mismatched one; keep the stale/broken split.
- Transport errors are retried twice (`this.retries = 2`); a Modbus *exception* response (`err.modbusErrorCode` set) is thrown immediately and not retried.

### Adapter lifecycle

1. `onReady()` → `createObjects()` → `subscribeStates('settings.*')` → `connect()`
2. Connection established → `startPolling()` (immediate poll, then `setInterval`)
3. Each poll → `readAllRegisters()` → `calculateDerivedValues()` → stamp `info.lastUpdate`
4. User writes a writable state → `onStateChange` converts the value and writes the Modbus register
5. Poll throws → mark disconnected, clear the interval, `scheduleReconnect()` (5s × attempt, capped at 30s, max 10 attempts, then it gives up permanently)
6. `onUnload()` → clear timers, close the client

**Writable-state subscription is required and explicit.** Without `subscribeStates('settings.*')` in `onReady()`, `onStateChange` never fires for user writes (a real bug, fixed in 0.1.2). Any new writable group outside `settings` needs its own `subscribeStates` call.

`poll()` is re-entrancy-guarded by `this.isPolling`, so a poll that outruns the interval is skipped, not queued.

### Polling and register blocks

`readAllRegisters()` reads **five fixed blocks on every poll**, with a 300 ms `sleep` after each (the Wi-Fi-Kit drops back-to-back requests):

| Start | Count | Contents |
|---|---|---|
| 35100 | 125 | main sensors — PV, grid, battery, backup, load, temps, energy counters |
| 36000 | 60 | meter / CT |
| 37000 | 25 | BMS |
| 47000 | 1 | `work_mode_set` |
| 47511 | 2 | `ems_mode` |

Blocks are read whole and then sliced: `processRegisters` maps each register to `data[reg.address - block.start]`. Consequences:
- **Registers outside these five windows are never read.** Adding a definition elsewhere silently does nothing until a block is added or widened.
- Block boundaries are hard-coded in `readAllRegisters()`, *not* derived from the register map.
- A block whose read fails logs a warning and the poll continues — one dead block does not drop the connection. Only an error thrown outside the per-block `try` triggers reconnect.

### Register decoding

Conventions that are easy to get wrong:

- **`dataType` vs `type`.** `reg.dataType` is the *Modbus wire* type (`int16`, `uint16`, `int32`, `uint32`, `string`, `bit`; default `uint16`). `reg.type` is the *ioBroker state* type (`'number'` / `'string'`). Unrelated fields — mixing them up produces objects that look right and decode wrong.
- **`words: 2` is mandatory on every `int32`/`uint32`** — enforced by `tests/register.test.js`. `decodeRegister` reads the second word regardless, but `words` is what `string` decoding actually iterates over.
- `reg.key` is **not** written in the definitions; it is auto-injected at the bottom of `registers.js` (`for (const [key, reg] of Object.entries(REGISTERS)) { reg.key = key; }`). A test asserts this.
- Scale is applied after decoding and rounded to 3 decimals: `Math.round(value * scale * 1000) / 1000`.
- `reg.states` maps a numeric code to a label *and* goes with `type: 'string'` — the state stores `'Normal'`, not `0`. `onStateChange` reverse-maps the label back to the number before writing.
- `reg.group` is a **display grouping, not a block.** `meter` mixes registers from 35191+ and 36000+.
- Battery `ibattery1` / `pbattery1`: positive = charging, negative = discharging.

Synthetic states created directly in `createObjects()` rather than from `REGISTERS`: `pv.pv_sum` (ppv1+ppv2+ppv3+ppv4, computed in `calculateDerivedValues`), `info.connection`, `info.lastUpdate`, and `info.firmwareVersion` — note the last one **is created but never written**; there is no firmware or serial-number register in the map despite the object existing.

### Writable settings

Only two registers are writable: `settings.work_mode_set` (47000) and `settings.ems_mode` (47511).

**`work_mode_set` Off Grid has cross-register side-effects.** Writing `Off Grid` (value 1) also writes 45252 `backup_supply = 1` and 45248 `cold_start = 4`. Switching back to *any* other mode resets `backup_supply = 0`. Those two addresses appear nowhere in `registers.js` — they are literals in `onStateChange`. This mirrors the Home Assistant integration; any refactor of the write path must preserve it.

**`work_mode_set` vs `ems_mode` are independent layered controls, not aliases.**
- `work_mode_set` (47000) = high-level inverter mode (General / Off Grid / Backup / Eco / Peak Shaving / Self Use).
- `ems_mode` (47511) = low-level EMS battery behavior *within* the current work mode (Auto, Charge PV, Discharge PV, Import AC, Export AC, Conserve, Off Grid, Battery Standby, Buy/Sell Power, Charge/Discharge Battery).

Setting one does not imply the other.

`onStateChange` dispatches purely on `obj.native.register`, which `createObjects()` copies from the register map — a state without it is ignored. Writes use FC 0x06 (single register) only.

### Adapter name

The adapter is named **`goodwe-ai`** (renamed from `goodwe` in 0.3.0). The name is set in exactly two
places that must stay in sync — `io-package.json` `common.name` and the `super({ ...options, name:
'goodwe-ai' })` call in `main.js` — and it is what ioBroker uses as the object namespace. Changing
either one alone produces an adapter whose objects land under a namespace the admin UI doesn't know.

References to *Goodwe* the manufacturer (inverter models, the Wi-Fi-Kit, `GoodweUdpClient`, the
upstream HA integration) are deliberately **not** renamed — only the adapter's own identity is.

### State object structure

`goodwe-ai.<instance>.<group>.<name>`, with groups `inverter`, `pv`, `grid`, `battery`, `backup`, `load`, `meter`, `bms`, `settings`, plus `info`. Group labels in `REGISTER_GROUPS` are German, as are all register `name` fields.

### Configuration

Config fields live in **three** places that must agree: `admin/jsonConfig.json` (the admin UI form), `io-package.json` `native` (defaults for new instances), and the `this.config.<x> || <default>` fallbacks in `main.js`. Adding a field means touching all three.

| Field | Default | Notes |
|---|---|---|
| `protocol` | `tcp` | `tcp` or `udp` — see Transport selection |
| `host` | `192.168.1.1` | inverter IP |
| `port` | 502 / 8899 | `main.js` derives the default from `protocol`; the UI leaves it blank |
| `unitId` | `247` | Goodwe ET default |
| `pollInterval` | `30` | seconds |
| `timeout` | `10` | seconds, converted to ms at connect |

## Release convention

A version bump touches four places, and the changelogs are bilingual:
1. `package.json` `version`
2. `io-package.json` `common.version`
3. `io-package.json` `common.news.<version>` — `{ "en": …, "de": … }`
4. `README.md` `## Changelog` — German, newest first

The README is German end-to-end (user-facing docs, tables, troubleshooting); code, identifiers, and commit messages are English. Log messages in `main.js` are mixed German/English — match whatever the surrounding function already uses.

# Device Discovery

> Last updated: 2026-10-11

Device Discovery lets Launchers on the same LAN find each other: every few seconds it
broadcasts a short self-introduction and listens for everyone else's. You no longer need
`ifconfig` in a terminal to see each machine's name and IP — think of it as
**Bluetooth for your LAN**.

> Quick start: Settings → Device Discovery → set a **device display name** → back on the
> page press **Start discovery** → other Launchers running discovery on the same LAN show
> up automatically.

## What it does

- This-device card: name, IPv4 / IPv6, platform icon (Linux / Windows / macOS / Android)
  and desktop session, UDP port, broadcast status.
- Device list: one card per discovered device — name, platform icon, IPv4 / IPv6, last
  seen time.
- **Send once**: broadcast a self-introduction immediately instead of waiting for the
  next interval.
- **Verify (blue check)**: when both sides share the same password, a blue check appears
  next to the device name.
- Boot service: enable it in Settings → Boot Services and discovery starts automatically
  with every launch (off by default).

## UI tour

| Area        | Position      | Notes                                                        |
| ----------- | ------------- | ------------------------------------------------------------ |
| Toolbar     | Top of page   | Send once / Start (Stop) discovery / settings gear           |
| This device | Below toolbar | Name, platform, IPv4, IPv6, port, broadcast status           |
| Device list | Main body     | One card per device; cards dim after 10s without a broadcast |
| Empty state | When empty    | Prompts you to start discovery                               |

Card buttons: **Verify** appears for unverified peers when a shared password is set;
verified devices show **Remove verification**.

## Common tasks

### Set the device display name

Click the gear icon (top right) or go to Settings → Device Discovery, fill in the
**device display name** and save. The name is broadcast to other Launchers on the LAN —
it's what they see in their list. Up to 32 characters.

Port (default 47820) and broadcast interval (default 5s) live in the same place;
**after changing port / interval, stop and restart a running discovery task**.

### Start / stop discovery

- **Start discovery**: starts a background task (visible in the sidebar's Background
  Tasks panel with its log) that broadcasts every interval and keeps listening.
- **Stop discovery**: the button on the page, or stop the "设备发现" task in the
  Background Tasks panel.
- To start automatically with every launch: Settings → Boot Services → enable
  "设备发现". The service is marked **terminated on quit** — closing the Launcher kills
  it without a dialog (it only carries names and IPs).

### Set up verification (blue check)

Verification is off by default. To enable it, enter the **same shared password** on the
**two devices you want to trust** (Settings → Device Discovery → Verification).

- After a peer is discovered, a verification packet is pushed automatically; a matching
  password yields the blue check.
- You can also press **Verify** on a device card to trigger it manually.
- The password is encrypted at rest; the UI and `config-get` only ever see "is it set".
- Press **Remove verification** (or remove the chip in settings) to revoke a check.

## What the packets look like

Both packet types travel over UDP broadcast (`255.255.255.255:47820`) and stay inside the
local broadcast domain (routers / VLANs block broadcast — a hard limit of the transport).

**Announce packet** (sent every interval):

```
[16B random AES-128 key][4B name byte length][ciphertext]
ciphertext = AES-128-CTR(key, zero IV) over:
  name UTF-8 || IPv4(4B) || IPv6(16B) || platform(1B) || desktop(1B)
```

- The key is freshly random on every send, so outsiders just see random bytes;
- name, IPs and platform go through one length-preserving stream cipher — no Caesar
  shift: IPv4 often contains long runs of `0x00` (e.g. `10.0.0.1`), and a per-byte "+k"
  would expose that pattern.

**Verify packet** (AES-256-CTR under the shared password, then broadcast):

```
[kind(1B: request/reply)][timestamp(8B)][name length(2B)][name][random padding(0–48B)]
```

- No "your device name" field: verification also goes over broadcast, and the random
  trailing padding obfuscates the packet length;
- the timestamp only guards against replay (±2 minutes accepted);
- a decryptable "request" triggers exactly one "reply", so the exchange can never loop
  into a broadcast storm.

## CLI

```bash
discoverer.config-get                                  # view config (password → is-set only)
discoverer.config-save --deviceName "Study desktop"    # rename
discoverer.self                                        # this device
discoverer.peers                                       # discovered devices
discoverer.announce                                    # broadcast once now
discoverer.start                                       # start the discovery task
discoverer.verify --name "Study desktop"               # send a verify request
discoverer.unverify --name "Study desktop"             # remove the blue check
```

## FAQ

**The page is empty?** Three possibilities: discovery isn't started; no device name is
set; no other Launcher is broadcasting on the LAN (the peer must also run discovery with
the same port).

**Can't see a particular device?** UDP broadcast doesn't cross routers / VLANs. Check
that both machines share a broadcast domain (same switch / same Wi-Fi) and that the
firewall allows the UDP port.

**IP shows "unknown"?** The peer didn't report an IPv4 (IPv6-only environment); the
packet's source address is shown instead, and "unknown" only when even that is missing.

**Verification keeps failing?** The shared password must match exactly; the timestamp
window is ±2 minutes, so a large clock skew between the machines also fails.

**A change didn't take effect?** After changing port / interval, stop and restart the
discovery task.

**What happens to the task when I close the Launcher?** A boot-service discovery task is
marked "terminated on quit" — no dialog, it just dies. A manually started task follows
the global rule (confirm dialog while tasks are running).

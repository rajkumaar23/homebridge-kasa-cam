# homebridge-kasa-cam

HomeKit **on/off (privacy) control** for TP-Link **Kasa cameras** (EC70 "Spot Pan Tilt", and other models using the same protocol).

Each camera shows up as a **Switch** in HomeKit:
- **On** = camera enabled
- **Off** = privacy mode (camera disabled — same as "Camera Off" in the app)

Setup is just your **TP-Link account email + password** and each camera's **local IP**. No app capture, no rooted phone.

> For the **video stream**, bridge the camera's local stream (port 19443) with something like [go2rtc](https://github.com/AlexxIT/go2rtc). This plugin only handles the on/off control that stream tools can't do.

## Configuration

```json
{
  "platforms": [
    {
      "platform": "KasaCam",
      "name": "Kasa Cam",
      "email": "you@example.com",
      "password": "your-tplink-account-password",
      "pollSeconds": 30,
      "cameras": [
        { "ip": "192.168.1.50" },
        { "ip": "192.168.1.51", "name": "Bedroom" }
      ]
    }
  ]
}
```

That's it — `deviceId`, `model`, and the default name are auto-detected from each camera's local `get_sysinfo`. (If a camera isn't reachable on the same LAN as Homebridge, give its `deviceId` explicitly and omit `ip`; state will then be read via the cloud.)

## How it works

Current Kasa camera firmware (e.g. EC70 `2.3.x`) has **no local control path**:
- UDP/TCP `9999` answers `get_sysinfo` (read) but **ignores** `set_*` commands.
- The HTTPS API on `19443` serves only the video stream — no control endpoint.
- The official app controls the camera **exclusively via the TP-Link cloud** (confirmed by packet capture: block the cloud while keeping LAN, and the app's on/off spins forever and never touches the camera locally).

So this plugin:
- **Reads** on/off state **locally** over UDP `9999` (`get_sysinfo` → `camera_switch`) — fast, works offline.
- **Writes** on/off via the **TP-Link cloud passthrough** API, signed exactly like the Tapo app signs its requests.

### Auth & signing (baked in)

Login and request signing use HMAC-SHA1 with **app-global signing keys** that ship inside the official app — not per-user secrets — so they're built into this plugin and you never configure them:

```
Content-MD5    = base64(MD5(body))
stringToSign   = Content-MD5 + "\n" + "9999999999" + "\n" + Nonce + "\n" + <request-path>
Signature      = hex( HMAC-SHA1(secret, stringToSign) )
X-Authorization: Timestamp=9999999999, Nonce=<uuid>, AccessKey=<key>, Signature=<sig>
```

The on/off command relayed through passthrough is:

```json
{ "smartlife.cam.ipcamera.switch": { "set_is_enable": { "value": "on" } } }
```

The plugin generates and persists its own `terminalUUID` on first run.

## Status

- ✅ Local state read (EC70, UDP 9999)
- ✅ Cloud login + signed passthrough (email + password only)
- ✅ On/off command verified end-to-end
- Tested against: **EC70(US)** fw `2.3.27`

## License

MIT

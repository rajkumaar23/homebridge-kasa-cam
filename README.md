# homebridge-kasa-cam

HomeKit **on/off (privacy) control** for TP-Link **Kasa cameras** (EC70 "Spot Pan Tilt", and other models using the same protocol).

Each camera shows up in HomeKit with up to three switches:
- **Camera on/off** (always present) — **On** = enabled, **Off** = privacy mode (same as "Camera Off" in the app)
- **Status LED** (optional) — toggle the camera's indicator LED
- **Motion detection** (optional) — enable/disable motion detection

The LED and motion switches are on by default and can each be turned off via `exposeLed` / `exposeMotionDetection`.

Setup is just your **TP-Link account email + password** and each camera's **local IP**. No app capture, no rooted phone.

Optionally, it can also expose a **live video tile** (see [Video](#video-optional) below).

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
      "exposeLed": true,
      "exposeMotionDetection": true,
      "cameras": [
        { "ip": "192.168.1.50" },
        { "ip": "192.168.1.51", "name": "Bedroom" }
      ]
    }
  ]
}
```

That's it — `deviceId`, `model`, and the default name are auto-detected from each camera's local `get_sysinfo`. (If a camera isn't reachable on the same LAN as Homebridge, give its `deviceId` explicitly and omit `ip`; state will then be read via the cloud.)

## Video (optional)

Kasa cameras have no RTSP/ONVIF and use a proprietary stream, so point this plugin at a feed that **ffmpeg can read** — easiest is a [go2rtc](https://github.com/AlexxIT/go2rtc) RTSP endpoint (go2rtc's `kasa://` source does the hard demuxing). Set `source` (ffmpeg input args, like `homebridge-camera-ffmpeg`) on a camera and a HomeKit **camera tile** appears:

```json
{
  "ip": "192.168.1.50",
  "source": "-rtsp_transport tcp -i rtsp://127.0.0.1:8554/living_room",
  "stillImageSource": "-i http://127.0.0.1:1984/api/frame.jpeg?src=living_room"
}
```

Requirements / notes:
- **ffmpeg** must be installed on the Homebridge host (set `ffmpegPath` if it's not on `PATH`).
- **`source`** / **`stillImageSource`** are ffmpeg input arg strings; `stillImageSource` defaults to `source` if omitted.
- With video, on/off (privacy) becomes the **camera tile's native "Camera Off"** control (no separate switch). Set `privacyAsSwitch: true` if that control doesn't appear on your iOS version and you'd rather have a standalone switch.
- **Video only** for now — HomeKit audio needs AAC-ELD (`libfdk_aac`), which most ffmpeg builds lack.
- Set `copyVideo: true` to pass H.264 through without re-encoding (much lower CPU); turn it off if the picture is glitchy.
- The camera tile is a separate accessory from the on/off switch.

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

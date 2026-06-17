'use strict';
// Minimal HAP CameraStreamingDelegate modelled on homebridge-camera-ffmpeg. `videoInput` and
// `stillInput` are ffmpeg input arg strings (e.g. "-rtsp_transport tcp -i rtsp://host:8554/cam1"
// and "-i http://host:1984/api/frame.jpeg?src=cam1"). ffmpeg pulls the source and serves SRTP
// to HomeKit; snapshots are a single ffmpeg frame from `stillInput` (resized to the request).
// Video-only for now (HomeKit audio needs AAC-ELD / libfdk_aac, which most ffmpeg builds lack).
// A UDP socket on the video return port acts as an RTCP timeout watchdog so a dead session
// doesn't leave ffmpeg running.
const { spawn } = require('child_process');
const dgram = require('dgram');

const RTCP_TIMEOUT_MS = 5000;
const splitArgs = (s) => s.trim().split(/\s+/);

class StreamingDelegate {
  constructor(hap, log, name, videoInput, stillInput, ffmpegPath, opts = {}) {
    this.hap = hap;
    this.log = log;
    this.name = name;
    this.videoInput = videoInput;              // ffmpeg input args for the live feed
    this.stillInput = stillInput || videoInput; // ffmpeg input args for snapshots
    this.ffmpeg = ffmpegPath || 'ffmpeg';
    this.copyVideo = !!opts.copyVideo;
    this.pending = {};   // sessionID -> prepared info (incl. return socket)
    this.ongoing = {};   // sessionID -> { ff, socket, clearTimer }
    this.controller = null;
  }

  // --- snapshots: one ffmpeg frame from the still input ---
  handleSnapshotRequest(request, callback) {
    const args = [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      ...splitArgs(this.stillInput),
      '-frames:v', '1', '-vf', `scale=${request.width}:-2`,
      '-f', 'image2', '-',
    ];
    const ff = spawn(this.ffmpeg, args, { env: process.env });
    const chunks = [];
    let err = '';
    ff.stdout.on('data', (d) => chunks.push(d));
    ff.stderr.on('data', (d) => (err += d.toString()));
    ff.on('error', (e) => callback(e));
    ff.on('close', (code) => {
      const buf = Buffer.concat(chunks);
      if (code === 0 && buf.length > 0) callback(undefined, buf);
      else callback(new Error(`snapshot ffmpeg exited ${code}: ${err.slice(0, 200)}`));
    });
    setTimeout(() => ff.kill('SIGKILL'), 8000);
  }

  // --- stream setup ---
  async prepareStream(request, callback) {
    let response;
    try {
      const socket = dgram.createSocket(request.addressVersion === 'ipv6' ? 'udp6' : 'udp4');
      socket.on('error', (e) => this.log.debug(`[${this.name}] return socket error: ${e.message}`));
      const videoReturnPort = await new Promise((res, rej) => {
        socket.once('error', rej);
        socket.bind(0, () => res(socket.address().port));
      });
      const videoSSRC = this.hap.CameraController.generateSynchronisationSource();
      const audioSSRC = this.hap.CameraController.generateSynchronisationSource();

      this.pending[request.sessionID] = {
        address: request.targetAddress,
        videoPort: request.video.port,
        videoSSRC,
        videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]).toString('base64'),
        video: request.video,
        socket,
      };
      // HomeKit expects both video AND audio blocks (an audio codec is advertised),
      // even though we currently only send video.
      response = {
        video: { port: videoReturnPort, ssrc: videoSSRC, srtp_key: request.video.srtp_key, srtp_salt: request.video.srtp_salt },
        audio: { port: videoReturnPort, ssrc: audioSSRC, srtp_key: request.audio.srtp_key, srtp_salt: request.audio.srtp_salt },
      };
    } catch (e) {
      this.log.error(`[${this.name}] prepareStream failed: ${e.message}`);
      callback(e);
      return;
    }
    callback(undefined, response); // call exactly once, outside the try
  }

  handleStreamRequest(request, callback) {
    const id = request.sessionID;
    if (request.type === 'start') {
      const s = this.pending[id];
      const v = request.video;
      if (!s) { callback(new Error('no prepared session')); return; }
      delete this.pending[id];

      const vEnc = this.copyVideo
        ? ['-c:v', 'copy']
        : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
           '-pix_fmt', 'yuv420p', '-color_range', 'mpeg', '-r', String(v.fps),
           '-b:v', `${v.max_bit_rate}k`, '-bufsize', `${2 * v.max_bit_rate}k`, '-maxrate', `${v.max_bit_rate}k`];

      const args = [
        '-nostdin', '-hide_banner', '-loglevel', 'error',
        ...splitArgs(this.videoInput),
        '-an', '-sn', '-dn',
        ...vEnc,
        '-payload_type', String(v.pt),
        '-ssrc', String(s.videoSSRC),
        '-f', 'rtp',
        '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
        '-srtp_out_params', s.videoSRTP,
        `srtp://${s.address}:${s.videoPort}?rtcpport=${s.videoPort}&pkt_size=1316`,
      ];

      this.log.debug(`[${this.name}] starting stream: ffmpeg ${args.join(' ')}`);
      const ff = spawn(this.ffmpeg, args, { env: process.env });
      ff.stderr.on('data', (d) => this.log.debug(`[${this.name}] ffmpeg: ${d.toString().trim()}`));
      ff.on('error', (e) => this.log.error(`[${this.name}] ffmpeg error: ${e.message}`));
      ff.on('close', (code) => { if (code && code !== 255) this.log.warn(`[${this.name}] stream ffmpeg exited ${code}`); });

      // RTCP timeout watchdog: if HomeKit stops sending, force-stop so ffmpeg doesn't orphan.
      const armTimer = () => setTimeout(() => {
        this.log.debug(`[${this.name}] stream timed out (no RTCP)`);
        if (this.controller) this.controller.forceStopStreamingSession(id);
        this.stopSession(id);
      }, RTCP_TIMEOUT_MS);
      let timer = armTimer();
      s.socket.on('message', () => { clearTimeout(timer); timer = armTimer(); });

      this.ongoing[id] = { ff, socket: s.socket, clearTimer: () => clearTimeout(timer) };
      callback();
    } else if (request.type === 'reconfigure') {
      callback();
    } else if (request.type === 'stop') {
      this.stopSession(id);
      callback();
    } else {
      callback();
    }
  }

  stopSession(id) {
    const o = this.ongoing[id];
    if (o) {
      if (o.clearTimer) o.clearTimer();
      if (o.ff) o.ff.kill('SIGKILL');
      if (o.socket) try { o.socket.close(); } catch (e) { /* already closed */ }
      delete this.ongoing[id];
    }
    const p = this.pending[id];
    if (p && p.socket) { try { p.socket.close(); } catch (e) { /* */ } delete this.pending[id]; }
  }
}

module.exports = { StreamingDelegate };

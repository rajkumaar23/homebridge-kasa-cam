'use strict';
// Minimal HAP CameraStreamingDelegate: pulls a source URL (e.g. go2rtc RTSP) via ffmpeg
// and serves it to HomeKit over SRTP. Video-only for now (HomeKit audio needs AAC-ELD /
// libfdk_aac, which most ffmpeg builds don't ship). Snapshots are a single ffmpeg frame.
const { spawn } = require('child_process');
const dgram = require('dgram');

function reservePort() {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.once('error', reject);
    s.bind(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

class StreamingDelegate {
  constructor(hap, log, name, streamUrl, ffmpegPath, opts = {}) {
    this.hap = hap;
    this.log = log;
    this.name = name;
    this.streamUrl = streamUrl;
    this.ffmpeg = ffmpegPath || 'ffmpeg';
    this.copyVideo = !!opts.copyVideo; // -c:v copy (low CPU) vs libx264 transcode (compatible)
    this.pending = {};   // sessionID -> prepared info
    this.ongoing = {};   // sessionID -> ffmpeg process
    this.controller = null;
  }

  // --- snapshots ---
  handleSnapshotRequest(request, callback) {
    const args = [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-rtsp_transport', 'tcp', '-i', this.streamUrl,
      '-frames:v', '1', '-vf', `scale=${request.width}:-2`,
      '-f', 'image2', '-',
    ];
    const ff = spawn(this.ffmpeg, args, { env: process.env });
    const chunks = [];
    ff.stdout.on('data', (d) => chunks.push(d));
    let err = '';
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
    try {
      const videoReturnPort = await reservePort();
      const videoSSRC = this.hap.CameraController.generateSynchronisationSource();
      this.pending[request.sessionID] = {
        address: request.targetAddress,
        videoPort: request.video.port,
        videoReturnPort,
        videoSSRC,
        videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]).toString('base64'),
        video: request.video,
      };
      callback(undefined, {
        video: {
          port: videoReturnPort,
          ssrc: videoSSRC,
          srtp_key: request.video.srtp_key,
          srtp_salt: request.video.srtp_salt,
        },
      });
    } catch (e) {
      callback(e);
    }
  }

  handleStreamRequest(request, callback) {
    const id = request.sessionID;
    if (request.type === 'start') {
      const s = this.pending[id];
      const v = request.video;
      if (!s) { callback(new Error('no prepared session')); return; }

      const vEnc = this.copyVideo
        ? ['-c:v', 'copy']
        : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
           '-pix_fmt', 'yuv420p', '-color_range', 'mpeg', '-r', String(v.fps),
           '-b:v', `${v.max_bit_rate}k`, '-bufsize', `${2 * v.max_bit_rate}k`, '-maxrate', `${v.max_bit_rate}k`];

      const args = [
        '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-rtsp_transport', 'tcp', '-i', this.streamUrl,
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
      this.ongoing[id] = ff;
      delete this.pending[id];
      callback();
    } else if (request.type === 'reconfigure') {
      callback();
    } else if (request.type === 'stop') {
      const ff = this.ongoing[id];
      if (ff) { ff.kill('SIGKILL'); delete this.ongoing[id]; }
      callback();
    } else {
      callback();
    }
  }
}

module.exports = { StreamingDelegate };

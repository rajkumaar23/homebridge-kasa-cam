'use strict';
// HomeKit Secure Video recording delegate. Producing a fragmented-MP4 stream via ffmpeg is what
// makes HomeKit treat this as an HKSV camera and show the native operating-mode controls
// (Off / Detect / Stream / Record) — which is the only way to get the native "Camera Off".
// EXPERIMENTAL: HKSV is hard to validate without an iOS device + Home hub (+ iCloud+ for actual
// recording); errors are contained so they can't take down Homebridge.
const { spawn } = require('child_process');

const H264_PROFILE = { 0: 'baseline', 1: 'main', 2: 'high' };       // HAP H264Profile -> ffmpeg
const H264_LEVEL = { 0: '3.1', 1: '3.2', 2: '4.0' };                // HAP H264Level -> ffmpeg

// Yield top-level MP4 boxes from a readable stream: [uint32 size][4-char type][body].
async function* readBoxes(readable) {
  let buf = Buffer.alloc(0);
  for await (const chunk of readable) {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 8) {
      const size = buf.readUInt32BE(0);
      if (size < 8 || buf.length < size) break;
      yield { type: buf.toString('ascii', 4, 8), data: buf.subarray(0, size) };
      buf = buf.subarray(size);
    }
  }
}

// Group boxes into HKSV fragments: first yield = init (ftyp+moov), then each moof+mdat pair.
async function* readFragments(readable) {
  let acc = [];
  let gotInit = false;
  for await (const box of readBoxes(readable)) {
    acc.push(box.data);
    if (!gotInit && box.type === 'moov') { gotInit = true; yield Buffer.concat(acc); acc = []; }
    else if (gotInit && box.type === 'mdat') { yield Buffer.concat(acc); acc = []; }
  }
}

class RecordingDelegate {
  constructor(hap, log, name, videoInput, ffmpegPath) {
    this.hap = hap;
    this.log = log;
    this.name = name;
    this.videoInput = videoInput;
    this.ffmpeg = ffmpegPath || 'ffmpeg';
    this.configuration = undefined;
    this.processes = {}; // streamId -> ffmpeg
    this.closed = {};    // streamId -> bool
  }

  updateRecordingActive(active) { this.log.debug(`[${this.name}] HKSV recording active: ${active}`); }
  updateRecordingConfiguration(config) { this.configuration = config; }

  buildArgs() {
    const c = this.configuration;
    const v = c.videoCodec.parameters;
    const [w, h, fps] = [c.videoCodec.resolution[0], c.videoCodec.resolution[1], c.videoCodec.resolution[2]];
    const fragSec = Math.max(1, Math.round((c.mediaContainerConfiguration.fragmentLength || 4000) / 1000));
    const audioSr = (c.audioCodec && c.audioCodec.samplerate === 0) ? 8000
      : (c.audioCodec && c.audioCodec.samplerate === 1) ? 16000 : 32000; // HAP AudioRecordingSamplerate
    return [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      ...this.videoInput.trim().split(/\s+/),
      '-sn', '-dn',
      '-c:v', 'libx264',
      '-profile:v', H264_PROFILE[v.profile] || 'high',
      '-level:v', H264_LEVEL[v.level] || '4.0',
      '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-r', String(fps),
      '-b:v', `${v.bitRate}k`, '-maxrate', `${v.bitRate}k`, '-bufsize', `${2 * v.bitRate}k`,
      '-force_key_frames', `expr:gte(t,n_forced*${fragSec})`,
      '-vf', `scale=${w}:${h}`,
      '-c:a', 'aac', '-ar', String(audioSr), '-ac', '1', '-b:a', '32k',
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset',
      '-max_muxing_queue_size', '1024',
      'pipe:1',
    ];
  }

  async *handleRecordingStreamRequest(streamId) {
    this.closed[streamId] = false;
    if (!this.configuration) { this.log.warn(`[${this.name}] HKSV stream requested with no configuration`); return; }
    let ff;
    try {
      ff = spawn(this.ffmpeg, this.buildArgs(), { env: process.env });
      this.processes[streamId] = ff;
      ff.stderr.on('data', (d) => this.log.debug(`[${this.name}] hksv ffmpeg: ${d.toString().trim()}`));
      ff.on('error', (e) => this.log.error(`[${this.name}] hksv ffmpeg error: ${e.message}`));

      // Buffer one fragment ahead so the final packet can be flagged isLast.
      let prev = null;
      for await (const frag of readFragments(ff.stdout)) {
        if (this.closed[streamId]) break;
        if (prev !== null) yield { data: prev, isLast: false };
        prev = frag;
      }
      if (prev !== null && !this.closed[streamId]) yield { data: prev, isLast: true };
    } catch (e) {
      this.log.error(`[${this.name}] HKSV stream failed: ${e.message}`);
    } finally {
      if (ff) ff.kill('SIGKILL');
      delete this.processes[streamId];
    }
  }

  closeRecordingStream(streamId, reason) {
    this.log.debug(`[${this.name}] HKSV stream ${streamId} closed (reason ${reason})`);
    this.closed[streamId] = true;
    const ff = this.processes[streamId];
    if (ff) { ff.kill('SIGKILL'); delete this.processes[streamId]; }
  }

  acknowledgeStream(streamId) { this.closeRecordingStream(streamId, 0); }
}

module.exports = { RecordingDelegate };

'use strict';
// Reverse-engineered TP-Link Tapo cloud client for Kasa camera on/off (privacy) control.
//
// Current Kasa camera firmware (e.g. EC70) has NO local write path (verified: UDP/TCP 9999
// ignore SET; HTTPS 19443 has no control endpoint; the official app controls it only via
// cloud). So on/off goes through the cloud "passthrough" API. State is read locally over
// UDP 9999 (get_sysinfo), which DOES still work.
//
// Cloud request signing (captured from the Tapo Android app):
//   Content-MD5  = base64(MD5(body))
//   stringToSign = Content-MD5 + "\n" + "9999999999" + "\n" + Nonce + "\n" + <path>
//   Signature    = hex(HMAC-SHA1(secret, stringToSign))
//   header X-Authorization: Timestamp=9999999999, Nonce=<uuid>, AccessKey=<key>, Signature=<sig>
// Two key pairs are used: one for /api/v2/account|common (auth) and one for passthrough.

const https = require('https');
const dgram = require('dgram');
const crypto = require('crypto');

const TIMESTAMP = '9999999999';

function sign(secret, contentMd5, nonce, path) {
  const sts = [contentMd5, TIMESTAMP, nonce, path].join('\n');
  return crypto.createHmac('sha1', secret).update(sts).digest('hex');
}

function commonQS(cfg, extra = '') {
  const p = new URLSearchParams({
    appName: 'TP-Link_Tapo_Android', appVer: '3.18.506', netType: 'wifi',
    termID: cfg.terminalUUID, ospf: 'Android 11', brand: 'TPLINK', locale: 'en_IN',
    model: 'Redmi Note 4', termName: 'Xiaomi Redmi Note 4', termMeta: '1',
  });
  return (extra ? extra + '&' : '') + p.toString();
}

function signedPost(host, path, qs, bodyObj, accessKey, secret) {
  const body = Buffer.from(JSON.stringify(bodyObj));
  const contentMd5 = crypto.createHash('md5').update(body).digest('base64');
  const nonce = crypto.randomUUID();
  const signature = sign(secret, contentMd5, nonce, path);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host, path: `${path}?${qs}`, method: 'POST',
      rejectUnauthorized: false, // TP-Link serves an intermediate Node can't chain-verify
      headers: {
        'Content-Type': 'application/json',
        'Content-MD5': contentMd5,
        'X-Authorization': `Timestamp=${TIMESTAMP}, Nonce=${nonce}, AccessKey=${accessKey}, Signature=${signature}`,
        'User-Agent': 'okhttp/4.11.0',
        'Content-Length': body.length,
      },
    }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString())); } catch (e) { reject(new Error('bad JSON from ' + host)); } });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('cloud request timeout')));
    req.write(body); req.end();
  });
}

class TapoCloud {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.token = null;
    this.appServerHost = new URL(cfg.appServerUrl || 'https://n-use1-wap.i.tplinkcloud.com').hostname;
    this.loginHost = new URL(cfg.loginUrl || 'https://n-wap.i.tplinkcloud.com').hostname;
  }

  async login() {
    const { email, password, terminalUUID, auth } = this.cfg;
    const r = await signedPost(this.loginHost, '/api/v2/account/login', commonQS(this.cfg), {
      appType: 'TP-Link_Tapo_Android', appVersion: '3.18.506',
      cloudPassword: password, cloudUserName: email, platform: 'Android 11',
      refreshTokenNeeded: false, supportBindAccount: false,
      terminalMeta: '1', terminalName: 'Xiaomi Redmi Note 4', terminalUUID,
    }, auth.accessKey, auth.secret);
    // TP-Link nests real auth errors under result.errorCode even when outer error_code is 0
    if (r.error_code !== 0 || !r.result || !r.result.token) {
      const inner = r.result && (r.result.errorMsg || r.result.errorCode);
      throw new Error(`login failed: ${r.msg || inner || JSON.stringify(r)}`);
    }
    this.token = r.result.token;
    if (r.result.appServerUrlV2) this.appServerHost = new URL(r.result.appServerUrlV2).hostname;
    this.log.debug('[cloud] logged in, token acquired');
    return this.token;
  }

  async passthrough(deviceId, requestData, retry = true) {
    if (!this.token) await this.login();
    const { passthrough: pt } = this.cfg;
    const r = await signedPost(this.appServerHost, '/api/v2/common/passthrough',
      commonQS(this.cfg, `token=${this.token}`),
      { deviceId, requestData: JSON.stringify(requestData) },
      pt.accessKey, pt.secret);
    if ((r.error_code === -20651 || r.error_code === -20675) && retry) { // token expired/invalid
      this.log.debug('[cloud] token expired, re-logging in');
      this.token = null;
      return this.passthrough(deviceId, requestData, false);
    }
    if (r.error_code !== 0) throw new Error(`passthrough error ${r.error_code}: ${r.msg || ''}`);
    return JSON.parse(r.result.responseData);
  }

  // on/off (privacy). enable=true -> camera ON, false -> privacy/OFF
  async setCameraEnabled(deviceId, enable) {
    const resp = await this.passthrough(deviceId, {
      'smartlife.cam.ipcamera.switch': { set_is_enable: { value: enable ? 'on' : 'off' } },
    });
    const err = resp['smartlife.cam.ipcamera.switch'].set_is_enable.err_code;
    if (err !== 0) throw new Error(`device rejected set_is_enable: err_code ${err}`);
  }

  async getCameraEnabledCloud(deviceId) {
    const resp = await this.passthrough(deviceId, { system: { get_sysinfo: {} } });
    return resp.system.get_sysinfo.system.camera_switch === 'on';
  }
}

// ---- Local state read over the classic Kasa UDP 9999 protocol (works on EC70, read-only) ----
function xorEncrypt(s) { const b = Buffer.from(s, 'utf8'), o = Buffer.alloc(b.length); let k = 0xAB; for (let i = 0; i < b.length; i++) { k ^= b[i]; o[i] = k; } return o; }
function xorDecrypt(b) { const o = Buffer.alloc(b.length); let k = 0xAB; for (let i = 0; i < b.length; i++) { o[i] = k ^ b[i]; k = b[i]; } return o; }

function getLocalSysinfo(ip, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; sock.close(); reject(new Error('local read timeout')); } }, timeout);
    sock.on('message', (m) => {
      if (done) return; done = true; clearTimeout(t); sock.close();
      try { resolve(JSON.parse(xorDecrypt(m).toString('utf8')).system.get_sysinfo.system); }
      catch (e) { reject(new Error('bad local response')); }
    });
    sock.on('error', (e) => { if (!done) { done = true; clearTimeout(t); sock.close(); reject(e); } });
    sock.send(xorEncrypt(JSON.stringify({ system: { get_sysinfo: {} } })), 9999, ip);
  });
}

async function getCameraEnabledLocal(ip) {
  const sys = await getLocalSysinfo(ip);
  return sys.camera_switch === 'on';
}

module.exports = { TapoCloud, getCameraEnabledLocal, getLocalSysinfo };

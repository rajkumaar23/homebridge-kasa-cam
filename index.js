'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TapoCloud, getLocalSysinfo } = require('./lib/tplink');
const { StreamingDelegate } = require('./lib/streaming');
const { RecordingDelegate } = require('./lib/recording');

const PLUGIN_NAME = 'homebridge-kasa-cam';
const PLATFORM_NAME = 'KasaCam';

// Feature catalog. "power" (camera on/off) is mandatory; the rest are opt-in via config.
// sysField = the field in local get_sysinfo (read without cloud); null => read via cloud.
const FEATURES = {
  power:  { ns: 'smartlife.cam.ipcamera.switch',       get: 'get_is_enable', set: 'set_is_enable', sysField: 'camera_switch', label: '',        mandatory: true },
  led:    { ns: 'smartlife.cam.ipcamera.led',          get: 'get_status',    set: 'set_status',    sysField: 'led_status',    label: ' LED',    cfg: 'exposeLed' },
  motion: { ns: 'smartlife.cam.ipcamera.motionDetect', get: 'get_is_enable', set: 'set_is_enable', sysField: null,            label: ' Motion', cfg: 'exposeMotionDetection' },
};

let Service, Characteristic;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, KasaCamPlatform);
};

class KasaCamPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = [];           // cached accessories from disk
    this.managed = [];               // [{ accessory, cam, feature }]
    this.stateCache = new Map();     // `${deviceId}:${feature}` -> bool
    this.privacyUpdaters = new Map();// deviceId -> [(on)=>void] : keep switch + camera mode in sync

    if (!this.config.email || !this.config.password) {
      this.log.error('Config requires "email" and "password" (your TP-Link account).');
      return;
    }
    this.enabled = {
      power: true,
      led: this.config.exposeLed !== false,
      motion: this.config.exposeMotionDetection !== false,
    };

    const uuidFile = path.join(api.user.storagePath(), 'kasa-cam-terminal-uuid');
    let terminalUUID;
    try { terminalUUID = fs.readFileSync(uuidFile, 'utf8').trim(); } catch (e) { /* none yet */ }
    if (!terminalUUID) {
      terminalUUID = crypto.randomBytes(16).toString('hex').toUpperCase();
      try { fs.writeFileSync(uuidFile, terminalUUID); } catch (e) { this.log.warn('could not persist terminalUUID:', e.message); }
    }
    this.cloud = new TapoCloud({ email: this.config.email, password: this.config.password, terminalUUID }, log);

    api.on('didFinishLaunching', () => this.setup());
  }

  configureAccessory(accessory) { this.accessories.push(accessory); }

  featuresFor() { return Object.keys(FEATURES).filter((k) => this.enabled[k]); }

  // Privacy (camera on/off) can be controlled from multiple places (the on/off switch and the
  // HKSV camera mode). Register each control's characteristic updater, and push a change to all
  // of them so they stay in sync immediately rather than only on the next poll.
  registerPrivacy(deviceId, updater) {
    if (!this.privacyUpdaters.has(deviceId)) this.privacyUpdaters.set(deviceId, []);
    this.privacyUpdaters.get(deviceId).push(updater);
  }
  applyPrivacy(deviceId, on) {
    this.stateCache.set(`${deviceId}:power`, on);
    for (const u of this.privacyUpdaters.get(deviceId) || []) { try { u(on); } catch (e) { /* */ } }
  }
  async setPrivacy(deviceId, on) {
    await this.cloud.setCameraEnabled(deviceId, on);
    this.applyPrivacy(deviceId, on);
  }

  async setup() {
    const cams = this.config.cameras || [];
    if (!cams.length) this.log.warn('No cameras configured. Add cameras with at least an "ip".');

    // Build the set of accessories we want: one per (camera, enabled feature).
    const desired = new Map(); // uuid -> { cam, feature }
    for (const cam of cams) {
      try { await this.resolveCamera(cam); }
      catch (e) { this.log.error(`Skipping camera ${cam.name || cam.ip || cam.deviceId}: ${e.message}`); continue; }
      // Standalone on/off switch: always for non-video cameras; for video cameras only if HKSV
      // is disabled (privacyAsSwitch) or explicitly added to complement the native mode (privacySwitch).
      const wantSwitch = !cam.source || this.config.privacyAsSwitch || this.config.privacySwitch;
      for (const feature of this.featuresFor()) {
        if (feature === 'power' && !wantSwitch) continue;
        const uuid = this.api.hap.uuid.generate(`${PLATFORM_NAME}:${cam.deviceId}:${feature}`);
        desired.set(uuid, { cam, feature });
      }
      if (cam.source) {
        // ':cam2' (not ':camera') so the accessory cached by <=0.4.0 — which has a
        // manually-added CameraOperatingMode service that collides with the HKSV
        // controller's own — is discarded as stale and rebuilt fresh.
        const uuid = this.api.hap.uuid.generate(`${PLATFORM_NAME}:${cam.deviceId}:cam2`);
        desired.set(uuid, { cam, feature: 'camera' });
      }
    }

    // Remove stale cached accessories: disabled features, removed cameras, and the
    // old single-accessory layout from <=0.2.0 (whose UUID won't be in `desired`).
    const stale = this.accessories.filter((a) => !desired.has(a.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.accessories = this.accessories.filter((a) => desired.has(a.UUID));
    }

    for (const [uuid, { cam, feature }] of desired) this.setupAccessory(uuid, cam, feature);

    this.pollMs = (this.config.pollSeconds || 30) * 1000;
    setInterval(() => this.refreshAll(), this.pollMs);
    this.refreshAll();
  }

  async resolveCamera(cam) {
    if (cam.ip && (!cam.deviceId || !cam.model)) {
      const sys = await getLocalSysinfo(cam.ip);
      cam.deviceId = cam.deviceId || sys.deviceId;
      cam.model = cam.model || sys.model;
      cam.name = cam.name || sys.alias;
    }
    if (!cam.deviceId) throw new Error('no deviceId and could not read it locally (provide "ip" or "deviceId")');
    cam.name = cam.name || `Kasa Cam ${cam.deviceId.slice(0, 6)}`;
  }

  setupAccessory(uuid, cam, feature) {
    if (feature === 'camera') { this.setupCameraAccessory(uuid, cam); return; }
    const spec = FEATURES[feature];
    const name = cam.name + spec.label; // e.g. "Living Room", "Living Room LED", "Living Room Motion"

    let accessory = this.accessories.find((a) => a.UUID === uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
      this.log.info(`Added: ${name}`);
    } else {
      accessory.displayName = name;
    }

    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'TP-Link Kasa')
      .setCharacteristic(Characteristic.Model, cam.model || 'Kasa Camera')
      .setCharacteristic(Characteristic.Name, name)
      .setCharacteristic(Characteristic.SerialNumber, `${cam.deviceId}:${feature}`);

    const svc = accessory.getService(Service.Switch) || accessory.addService(Service.Switch, name);
    svc.setCharacteristic(Characteristic.Name, name);
    if (Characteristic.ConfiguredName) svc.setCharacteristic(Characteristic.ConfiguredName, name);
    svc.getCharacteristic(Characteristic.On)
      .onGet(() => this.stateCache.get(`${cam.deviceId}:${feature}`) ?? true)
      .onSet(async (value) => {
        try {
          if (feature === 'power') {
            await this.setPrivacy(cam.deviceId, !!value); // syncs the camera mode too
          } else {
            await this.cloud.setFeature(cam.deviceId, spec.ns, spec.set, !!value);
            this.stateCache.set(`${cam.deviceId}:${feature}`, !!value);
          }
          this.log.info(`${name}: ${value ? 'ON' : 'OFF'}`);
        } catch (e) {
          this.log.error(`${name}: set failed: ${e.message}`);
          throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
      });
    if (feature === 'power') this.registerPrivacy(cam.deviceId, (on) => svc.updateCharacteristic(Characteristic.On, on));

    this.managed.push({ accessory, cam, feature, svc });
  }

  setupCameraAccessory(uuid, cam) {
    const hap = this.api.hap;
    const name = `${cam.name} Camera`;
    let accessory = this.accessories.find((a) => a.UUID === uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory(name, uuid, hap.Categories.CAMERA);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
      this.log.info(`Added camera (video): ${name}`);
    }
    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'TP-Link Kasa')
      .setCharacteristic(Characteristic.Model, cam.model || 'Kasa Camera')
      .setCharacteristic(Characteristic.SerialNumber, `${cam.deviceId}:camera`);

    // ffmpeg input arg strings (homebridge-camera-ffmpeg style), e.g.
    // source: "-rtsp_transport tcp -i rtsp://host:8554/cam1"
    // stillImageSource: "-i http://host:1984/api/frame.jpeg?src=cam1"
    const delegate = new StreamingDelegate(hap, this.log, name, cam.source, cam.stillImageSource, this.config.ffmpegPath, {
      copyVideo: !!this.config.copyVideo,
    });

    const resolutions = [
      [320, 180, 30], [320, 240, 15], [480, 270, 30], [640, 360, 30],
      [640, 480, 30], [1280, 720, 30], [1280, 960, 30], [1920, 1080, 30],
    ];
    const h264 = {
      profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH],
      levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0],
    };

    // HKSV (recording) is what makes HomeKit expose the native operating-mode controls
    // (incl. the on/off "Camera Off"). Enabled unless privacyAsSwitch is set.
    const hksv = !this.config.privacyAsSwitch;
    let recordingDelegate = null;
    const options = {
      cameraStreamCount: 2,
      delegate,
      streamingOptions: {
        supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: { resolutions, codec: h264 },
        audio: { codecs: [{ type: hap.AudioStreamingCodecType.AAC_ELD, samplerate: hap.AudioStreamingSamplerate.KHZ_16 }] },
      },
    };
    if (hksv) {
      recordingDelegate = new RecordingDelegate(hap, this.log, name, cam.source, this.config.ffmpegPath);
      options.recording = {
        delegate: recordingDelegate,
        options: {
          prebufferLength: 4000,
          mediaContainerConfiguration: [{ type: hap.MediaContainerType.FRAGMENTED_MP4, fragmentLength: 4000 }],
          video: { type: hap.VideoCodecType.H264, parameters: h264, resolutions },
          audio: { codecs: [{ type: hap.AudioRecordingCodecType.AAC_LC, samplerate: hap.AudioRecordingSamplerate.KHZ_32, audioChannels: 1, bitrateMode: 0 }] },
        },
      };
      options.sensors = { motion: true }; // HKSV needs a motion (or occupancy) sensor
    }

    const controller = new hap.CameraController(options);
    delegate.controller = controller;
    accessory.configureController(controller);

    // Wire the native Camera Off (operating mode) to the device's cloud privacy.
    let om = null;
    if (hksv && controller.recordingManagement) {
      om = controller.recordingManagement.operatingModeService;
      om.getCharacteristic(Characteristic.HomeKitCameraActive)
        .onGet(() => ((this.stateCache.get(`${cam.deviceId}:power`) ?? true) ? 1 : 0))
        .onSet(async (value) => {
          try {
            await this.setPrivacy(cam.deviceId, value === 1); // syncs the switch too
            this.log.info(`${name}: camera ${value === 1 ? 'ON' : 'OFF (privacy)'}`);
          } catch (e) {
            this.log.error(`${name}: privacy set failed: ${e.message}`);
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
          }
        });
      this.registerPrivacy(cam.deviceId, (on) => om.updateCharacteristic(Characteristic.HomeKitCameraActive, on ? 1 : 0));
    }
    this.managed.push({ accessory, cam, feature: 'camera', om });
  }

  async refreshAll() {
    const sysCache = new Map(); // ip -> sys (one local read per camera per cycle)
    const getSys = async (ip) => {
      if (!sysCache.has(ip)) { try { sysCache.set(ip, await getLocalSysinfo(ip)); } catch (e) { sysCache.set(ip, null); } }
      return sysCache.get(ip);
    };
    const privacyDone = new Set(); // poll camera on/off once per device, sync all its controls
    for (const { cam, feature, svc } of this.managed) {
      try {
        if (feature === 'power' || feature === 'camera') {
          if (privacyDone.has(cam.deviceId)) continue;
          privacyDone.add(cam.deviceId);
          const sys = cam.ip ? await getSys(cam.ip) : null;
          const on = sys ? sys.camera_switch === 'on' : await this.cloud.getCameraEnabledCloud(cam.deviceId);
          this.applyPrivacy(cam.deviceId, on); // updates the switch + camera mode + cache
          continue;
        }
        const spec = FEATURES[feature];
        if (!spec) continue;
        let on;
        if (spec.sysField && cam.ip) {
          const sys = await getSys(cam.ip);
          on = sys ? sys[spec.sysField] === 'on' : await this.cloud.getFeatureCloud(cam.deviceId, spec.ns, spec.get);
        } else {
          on = await this.cloud.getFeatureCloud(cam.deviceId, spec.ns, spec.get);
        }
        this.stateCache.set(`${cam.deviceId}:${feature}`, on);
        svc.updateCharacteristic(Characteristic.On, on);
      } catch (e) {
        this.log.debug(`${cam.name} ${feature}: refresh failed: ${e.message}`);
      }
    }
  }
}

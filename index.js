'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TapoCloud, getCameraEnabledLocal, getLocalSysinfo } = require('./lib/tplink');

const PLUGIN_NAME = 'homebridge-kasa-cam';
const PLATFORM_NAME = 'KasaCam';

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
    this.accessories = [];
    this.stateCache = new Map();

    if (!this.config.email || !this.config.password) {
      this.log.error('Config requires "email" and "password" (your TP-Link account). Nothing else is needed.');
      return;
    }

    // Generate + persist our own terminalUUID (no per-user capture; a fresh UUID logs in fine).
    const uuidFile = path.join(api.user.storagePath(), 'kasa-cam-terminal-uuid');
    let terminalUUID;
    try { terminalUUID = fs.readFileSync(uuidFile, 'utf8').trim(); } catch (e) { /* none yet */ }
    if (!terminalUUID) {
      terminalUUID = crypto.randomBytes(16).toString('hex').toUpperCase();
      try { fs.writeFileSync(uuidFile, terminalUUID); } catch (e) { this.log.warn('could not persist terminalUUID:', e.message); }
    }

    // Signing keys default to the baked-in app constants — users configure nothing here.
    this.cloud = new TapoCloud({ email: this.config.email, password: this.config.password, terminalUUID }, log);

    api.on('didFinishLaunching', () => this.setup());
  }

  configureAccessory(accessory) { this.accessories.push(accessory); }

  async setup() {
    const cams = this.config.cameras || [];
    if (!cams.length) this.log.warn('No cameras configured. Add cameras with at least an "ip" (deviceId is auto-detected).');
    for (const cam of cams) {
      try {
        await this.resolveCamera(cam);
        this.addCamera(cam);
      } catch (e) {
        this.log.error(`Skipping camera ${cam.name || cam.ip || cam.deviceId}: ${e.message}`);
      }
    }
    this.pollMs = (this.config.pollSeconds || 30) * 1000;
    setInterval(() => this.refreshAll(), this.pollMs);
    this.refreshAll();
  }

  // Fill in deviceId / model / name from the camera's local get_sysinfo when possible.
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

  addCamera(cam) {
    const uuid = this.api.hap.uuid.generate(PLATFORM_NAME + ':' + cam.deviceId);
    let accessory = this.accessories.find((a) => a.UUID === uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory(cam.name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info(`Added camera switch: ${cam.name}`);
    }
    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'TP-Link Kasa')
      .setCharacteristic(Characteristic.Model, cam.model || 'Kasa Camera')
      .setCharacteristic(Characteristic.SerialNumber, cam.deviceId);

    const svc = accessory.getService(Service.Switch) || accessory.addService(Service.Switch, cam.name);
    svc.getCharacteristic(Characteristic.On)
      .onGet(() => this.stateCache.get(cam.deviceId) ?? true)
      .onSet(async (value) => {
        try {
          await this.cloud.setCameraEnabled(cam.deviceId, !!value);
          this.stateCache.set(cam.deviceId, !!value);
          this.log.info(`${cam.name}: camera turned ${value ? 'ON' : 'OFF (privacy)'}`);
        } catch (e) {
          this.log.error(`${cam.name}: failed to set camera ${value ? 'on' : 'off'}: ${e.message}`);
          throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
      });
    accessory._cam = cam;
    accessory._svc = svc;
  }

  async refreshAll() {
    for (const accessory of this.accessories) {
      const cam = accessory._cam;
      if (!cam) continue;
      try {
        let on;
        if (cam.ip) {
          try { on = await getCameraEnabledLocal(cam.ip); }
          catch (e) { on = await this.cloud.getCameraEnabledCloud(cam.deviceId); }
        } else {
          on = await this.cloud.getCameraEnabledCloud(cam.deviceId);
        }
        this.stateCache.set(cam.deviceId, on);
        accessory._svc.updateCharacteristic(Characteristic.On, on);
      } catch (e) {
        this.log.debug(`${cam.name}: state refresh failed: ${e.message}`);
      }
    }
  }
}

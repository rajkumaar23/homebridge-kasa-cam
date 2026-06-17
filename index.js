'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TapoCloud, getLocalSysinfo } = require('./lib/tplink');

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
    this.accessories = [];
    this.stateCache = new Map(); // `${deviceId}:${feature}` -> bool

    if (!this.config.email || !this.config.password) {
      this.log.error('Config requires "email" and "password" (your TP-Link account).');
      return;
    }
    // Optional features default ON (the on/off switch is always present regardless).
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

  async setup() {
    const cams = this.config.cameras || [];
    if (!cams.length) this.log.warn('No cameras configured. Add cameras with at least an "ip".');
    for (const cam of cams) {
      try { await this.resolveCamera(cam); this.addCamera(cam); }
      catch (e) { this.log.error(`Skipping camera ${cam.name || cam.ip || cam.deviceId}: ${e.message}`); }
    }
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

  featuresFor() {
    return Object.keys(FEATURES).filter((k) => this.enabled[k]);
  }

  addCamera(cam) {
    const uuid = this.api.hap.uuid.generate(PLATFORM_NAME + ':' + cam.deviceId);
    let accessory = this.accessories.find((a) => a.UUID === uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory(cam.name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info(`Added camera: ${cam.name}`);
    }
    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'TP-Link Kasa')
      .setCharacteristic(Characteristic.Model, cam.model || 'Kasa Camera')
      .setCharacteristic(Characteristic.SerialNumber, cam.deviceId);

    const wanted = this.featuresFor();

    // remove services for features that are now disabled
    accessory.services
      .filter((s) => s.subtype && FEATURES[s.subtype] && !wanted.includes(s.subtype))
      .forEach((s) => accessory.removeService(s));

    for (const feature of wanted) {
      const spec = FEATURES[feature];
      const svcName = cam.name + spec.label;
      let svc = accessory.getServiceById(Service.Switch, feature);
      if (!svc) svc = accessory.addService(Service.Switch, svcName, feature);
      svc.setCharacteristic(Characteristic.Name, svcName);
      svc.getCharacteristic(Characteristic.On)
        .onGet(() => this.stateCache.get(`${cam.deviceId}:${feature}`) ?? true)
        .onSet(async (value) => {
          try {
            await this.cloud.setFeature(cam.deviceId, spec.ns, spec.set, !!value);
            this.stateCache.set(`${cam.deviceId}:${feature}`, !!value);
            this.log.info(`${svcName}: ${value ? 'ON' : 'OFF'}`);
          } catch (e) {
            this.log.error(`${svcName}: set failed: ${e.message}`);
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
          }
        });
    }
    accessory._cam = cam;
  }

  async refreshAll() {
    for (const accessory of this.accessories) {
      const cam = accessory._cam;
      if (!cam) continue;
      const wanted = this.featuresFor();
      // one local read covers power + led (both in get_sysinfo); motion needs cloud
      let sys = null;
      if (cam.ip && wanted.some((f) => FEATURES[f].sysField)) {
        try { sys = await getLocalSysinfo(cam.ip); } catch (e) { /* fall back to cloud per-feature */ }
      }
      for (const feature of wanted) {
        const spec = FEATURES[feature];
        try {
          let on;
          if (spec.sysField && sys) on = sys[spec.sysField] === 'on';
          else on = await this.cloud.getFeatureCloud(cam.deviceId, spec.ns, spec.get);
          this.stateCache.set(`${cam.deviceId}:${feature}`, on);
          const svc = accessory.getServiceById(Service.Switch, feature);
          if (svc) svc.updateCharacteristic(Characteristic.On, on);
        } catch (e) {
          this.log.debug(`${cam.name}${spec.label}: refresh failed: ${e.message}`);
        }
      }
    }
  }
}

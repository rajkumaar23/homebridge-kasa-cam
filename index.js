'use strict';
const { TapoCloud, getCameraEnabledLocal } = require('./lib/tplink');

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
    this.cloud = new TapoCloud(this.config, log);
    // local state cache so HomeKit "get" is instant; refreshed on a timer
    this.stateCache = new Map(); // deviceId -> bool

    if (!this.config.email || !this.config.auth || !this.config.passthrough) {
      this.log.error('Missing config: email, auth{accessKey,secret}, passthrough{accessKey,secret} are required.');
      return;
    }
    api.on('didFinishLaunching', () => this.setup());
  }

  configureAccessory(accessory) { this.accessories.push(accessory); }

  setup() {
    const cams = this.config.cameras || [];
    for (const cam of cams) this.addCamera(cam);
    // periodic local refresh of on/off state
    this.pollMs = (this.config.pollSeconds || 30) * 1000;
    setInterval(() => this.refreshAll(), this.pollMs);
    this.refreshAll();
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
        // prefer fast local read; fall back to cloud if the camera IP isn't reachable
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

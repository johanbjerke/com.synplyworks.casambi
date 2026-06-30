import Homey from 'homey';
import CasambiApp from '../../app';

export default class LuminaireDevice extends Homey.Device {
  protected app?: CasambiApp;

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.app = this.homey.app as unknown as CasambiApp;

    await this.app.connectDevice(this);

    // onoff + dim
    this.registerMultipleCapabilityListener(['onoff', 'dim'], async ({ onoff, dim }) => {
      try {
        if (onoff === false) {
          // Use the dedicated OnOff control for turning off, with Dimmer as
          // a fallback for fixtures that only expose a Dimmer control.
          await this.app!.updateDeviceState(this, { OnOff: { value: 0 }, Dimmer: { value: 0 } });
        } else if (onoff === true && dim === undefined) {
          await this.app!.updateDeviceState(this, { OnOff: { value: 1 } });
        } else if (dim !== undefined) {
          // Dimmer value must be in the 0..1 range (Homey `dim` is already 0..1).
          const value = Math.max(0, Math.min(1, dim));
          await this.app!.updateDeviceState(this, { Dimmer: { value } });
        }
      } catch (err) {
        this.error('Failed to update onoff/dim state', err);
        throw err; // surface the failure to the Homey UI instead of silently swallowing it
      }
    });

    // colour temperature (Kelvin) - only if the capability exists on this device
    if (this.hasCapability('light_temperature')) {
      this.registerCapabilityListener('light_temperature', async (value: number) => {
        try {
          // Homey light_temperature is 0..1 (0 = coldest). Map to a sensible Kelvin range.
          const minK = 2700;
          const maxK = 6500;
          const kelvin = Math.round(maxK - value * (maxK - minK));
          await this.app!.updateDeviceState(this, { ColorTemperature: { value: kelvin }, Colorsource: { source: 'TW' } });
        } catch (err) {
          this.error('Failed to update colour temperature', err);
          throw err;
        }
      });
    }

    // hue / saturation colour - only if the capabilities exist
    if (this.hasCapability('light_hue') && this.hasCapability('light_saturation')) {
      this.registerMultipleCapabilityListener(['light_hue', 'light_saturation'], async ({ light_hue, light_saturation }) => {
        try {
          const hue = light_hue ?? this.getCapabilityValue('light_hue') ?? 0;
          const sat = light_saturation ?? this.getCapabilityValue('light_saturation') ?? 1;
          await this.app!.updateDeviceState(this, { RGB: { hue, sat }, Colorsource: { source: 'RGB' } });
        } catch (err) {
          this.error('Failed to update colour', err);
          throw err;
        }
      });
    }

    this.log('LuminaireDevice has been initialized');
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('LuminaireDevice has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   */
  async onSettings({ oldSettings: {}, newSettings: {}, changedKeys: [] }): Promise<string | void> {
    this.log('LuminaireDevice settings where changed');
  }

  /**
   * onRenamed is called when the user updates the device's name.
   */
  async onRenamed(name: string) {
    this.log('LuminaireDevice was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('LuminaireDevice has been deleted');
  }

  updateState(state: any) {
    console.log('LuminaireDevice.updateState with state: ', JSON.stringify(state));

    // The unitChanged event reports state either as a top-level dimLevel
    // or inside a `controls` array. Handle both for robustness.
    let dimLevel: number | undefined;

    if ('dimLevel' in state && state.dimLevel != undefined) {
      dimLevel = state.dimLevel;
    } else if (Array.isArray(state.controls)) {
      const dimmer = state.controls.find((c: any) => c && (c.type === 'Dimmer' || c.name === 'dimmer'));
      if (dimmer && dimmer.value != undefined) {
        dimLevel = dimmer.value;
      }
    }

    if (dimLevel != undefined) {
      if (!dimLevel) {
        this.setCapabilityValue('onoff', false).catch(this.error);
      } else {
        this.setCapabilityValue('onoff', true).catch(this.error);
        this.setCapabilityValue('dim', dimLevel).catch(this.error);
      }
    } else {
      console.log('LuminaireDevice.updateState! Could not update, no dimlevel in state!', JSON.stringify(state));
    }
  }
}

module.exports = LuminaireDevice;

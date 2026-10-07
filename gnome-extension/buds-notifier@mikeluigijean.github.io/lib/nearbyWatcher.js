// Swift-Pair-like: a paired headset advertises nearby but isn't connected. Pure JS.
import {matchesDevice} from './patterns.js';

export class NearbyWatcher {
    // presenter: {nearby(device, onConnect, replaces) -> handle, close(handle),
    //             connectFailed(device, error, replaces) -> handle}
    // devices(): [{path, alias, patterns, connected}]
    // nameAt(path) -> advertised name of a BlueZ device object (e.g. a random-address LE entry)
    // connect(device) -> Promise (rejects with an Error)
    constructor({presenter, devices, nameAt, connect, cooldownMs, now = () => Date.now()}) {
        this._presenter = presenter;
        this._devices = devices;
        this._nameAt = nameAt;
        this._connect = connect;
        this.cooldownMs = cooldownMs;
        this._now = now;
        this._lastShown = new Map();  // device path -> time
        this._handles = new Map();    // device path -> handle
    }

    // Returns the matched device (for logging/tests) or null.
    onDeviceFound(advertiserPath) {
        const name = this._nameAt(advertiserPath);
        const device = this._devices().find(d => matchesDevice(name, d.patterns));
        if (!device || device.connected)
            return null;

        // Headsets advertise from several random addresses at once; the cooldown dedupes them.
        const now = this._now();
        const last = this._lastShown.get(device.path);
        if (last !== undefined && now - last < this.cooldownMs)
            return null;
        this._lastShown.set(device.path, now);

        this._handles.set(device.path, this._presenter.nearby(
            device, () => this._onConnectClicked(device), this._handles.get(device.path) ?? null));
        return device;
    }

    onConnectedChanged(device, connected) {
        if (!connected)
            return;
        const handle = this._handles.get(device.path);
        if (handle) {
            this._presenter.close(handle);
            this._handles.delete(device.path);
        }
    }

    forget(devicePath) {
        this._lastShown.delete(devicePath);
        this._handles.delete(devicePath);
    }

    async _onConnectClicked(device) {
        try {
            await this._connect(device);
            // Success is announced by the connection watcher.
        } catch (e) {
            // The headset often reconnects by itself while our request is pending, which makes
            // the request fail (e.g. br-connection-refused) although the outcome is "connected".
            if (this._devices().find(d => d.path === device.path)?.connected)
                return;
            this._handles.set(device.path, this._presenter.connectFailed(
                device, e.message, this._handles.get(device.path) ?? null));
        }
    }
}

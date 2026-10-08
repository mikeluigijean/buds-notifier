// Preferences: status checks (from the running extension over D-Bus), devices, behaviour, test.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const BUS_NAME = 'io.github.mikeluigijean.BudsNotifier.Shell';
const OBJECT_PATH = '/io/github/mikeluigijean/BudsNotifier/Shell';
const IFACE = 'io.github.mikeluigijean.BudsNotifier.Shell1';
const BUDSLINK_URL = 'https://flathub.org/apps/io.github.maniacx.BudsLink';
const EXPERIMENTAL_COMMANDS = [
    'sudo cp /etc/bluetooth/main.conf /etc/bluetooth/main.conf.bak',
    "sudo sed -i 's/^#Experimental = false/Experimental = true/' /etc/bluetooth/main.conf",
    'sudo systemctl restart bluetooth',
].join('\n');

function callExtension(method, params = null) {
    const reply = Gio.DBus.session.call_sync(BUS_NAME, OBJECT_PATH, IFACE, method, params, null,
        Gio.DBusCallFlags.NONE, 3000, null);
    return reply.recursiveUnpack()[0];
}

function statusRow(title, subtitle, ok) {
    const row = new Adw.ActionRow({title, subtitle, subtitle_selectable: true});
    row.add_prefix(new Gtk.Image({
        icon_name: ok === true ? 'emblem-ok-symbolic' : ok === false ? 'dialog-warning-symbolic' : 'dialog-information-symbolic',
    }));
    return row;
}

export default class BudsNotifierPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(640, 760);

        const page = new Adw.PreferencesPage({title: 'Buds Notifier', icon_name: 'audio-headphones-symbolic'});
        window.add(page);

        let status = null;
        try {
            status = JSON.parse(callExtension('Status'));
        } catch {
            status = null;
        }

        // ---- status ----
        const statusGroup = new Adw.PreferencesGroup({title: 'Status'});
        page.add(statusGroup);
        if (!status) {
            statusGroup.add(statusRow('Extension not running',
                'Enable it in the Extensions app. On Wayland, a newly installed extension appears after logging out and back in.', false));
        } else {
            statusGroup.add(statusRow('Bluetooth', status.bluez ? 'Connected to BlueZ' : 'BlueZ not available', status.bluez));
            statusGroup.add(status.cardsAllowed
                ? statusRow('Popup cards', 'Shown top-right', true)
                : statusRow('Popup cards', 'Do Not Disturb is on: events go to the notification list', null));

            const budslink = status.budslink.installed
                ? statusRow('Left / right / case battery', 'BudsLink is installed', true)
                : statusRow('Left / right / case battery', 'Optional: install BudsLink from Flathub. Without it, one battery level is shown.', null);
            if (!status.budslink.installed) {
                const button = new Gtk.Button({label: 'Open Flathub', valign: Gtk.Align.CENTER});
                button.connect('clicked', () => new Gtk.UriLauncher({uri: BUDSLINK_URL}).launch(window, null, null));
                budslink.add_suffix(button);
            }
            statusGroup.add(budslink);

            const nearby = status.nearby;
            const experimentalOff = nearby.adapters.length && nearby.adapters.every(a => a.features === null);
            if (nearby.hardwareFiltering) {
                statusGroup.add(statusRow('Nearby card', nearby.patterns.length
                    ? `Listening for: ${nearby.patterns.join(', ')}`
                    : 'Ready (no paired headset to listen for)', true));
            } else if (experimentalOff) {
                const row = statusRow('Nearby card: one-time setup needed',
                    'Enable BlueZ experimental features (run in a terminal; Bluetooth devices reconnect briefly):\n' +
                    EXPERIMENTAL_COMMANDS, null);
                const copy = new Gtk.Button({icon_name: 'edit-copy-symbolic', valign: Gtk.Align.CENTER,
                    tooltip_text: 'Copy commands'});
                copy.connect('clicked', () => window.get_clipboard().set(EXPERIMENTAL_COMMANDS));
                row.add_suffix(copy);
                statusGroup.add(row);
            } else {
                statusGroup.add(statusRow('Nearby card unavailable',
                    'Your Bluetooth adapter has no hardware advertisement filtering. Continuous scanning would drain battery, so the nearby card stays off.', false));
            }
        }

        // ---- devices ----
        const devicesGroup = new Adw.PreferencesGroup({
            title: 'Devices',
            description: 'Paired earbuds and headsets are watched automatically. Speakers and other audio devices can be added.',
        });
        page.add(devicesGroup);
        const devices = status?.devices ?? [];
        if (!devices.length)
            devicesGroup.add(new Adw.ActionRow({title: 'No paired audio devices', subtitle: 'Pair them in Settings → Bluetooth'}));
        for (const d of devices) {
            const row = new Adw.SwitchRow({
                title: d.alias,
                subtitle: [d.connected ? 'Connected' : 'Not connected', d.battery && d.connected ? d.battery : null]
                    .filter(Boolean).join(' · '),
                active: d.watched,
            });
            row.connect('notify::active', () => {
                const address = d.address.toUpperCase();
                const without = key => settings.get_strv(key).filter(a => a !== address);
                if (d.headset) {
                    settings.set_strv('excluded-devices', row.active
                        ? without('excluded-devices') : [...without('excluded-devices'), address]);
                } else {
                    settings.set_strv('included-devices', row.active
                        ? [...without('included-devices'), address] : without('included-devices'));
                }
            });
            devicesGroup.add(row);
        }

        // ---- behaviour ----
        const behaviour = new Adw.PreferencesGroup({title: 'Notifications'});
        page.add(behaviour);
        const spin = (key, title, subtitle, lower, upper) => {
            const row = new Adw.SpinRow({
                title, subtitle,
                adjustment: new Gtk.Adjustment({lower, upper, step_increment: 1, page_increment: 5}),
            });
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            behaviour.add(row);
        };
        const toggle = (key, title, subtitle) => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            behaviour.add(row);
        };
        spin('low-battery-percent', 'Low battery warning (%)', 'Based on the lowest earbud; the case is ignored', 1, 50);
        spin('low-battery-rearm-percent', 'Warn again after charging to (%)', null, 2, 100);
        toggle('nearby-enabled', 'Nearby card', 'When a paired headset is close but not connected');
        spin('nearby-cooldown-seconds', 'Nearby card cooldown (seconds)', null, 10, 3600);
        spin('nearby-rssi-found', 'Nearby signal threshold (dBm)', 'Closer to 0 = the headset must be nearer', -126, 20);
        toggle('use-budslink', 'Use BudsLink', 'Left / right / case battery when BudsLink is installed');

        // ---- test ----
        const testGroup = new Adw.PreferencesGroup({title: 'Test'});
        page.add(testGroup);
        const testRow = new Adw.ActionRow({title: 'Show a test card', subtitle: 'Appears top-right for a few seconds'});
        const testButton = new Gtk.Button({label: 'Show', valign: Gtk.Align.CENTER, sensitive: Boolean(status)});
        testButton.connect('clicked', () => {
            try {
                callExtension('ShowTestCard');
            } catch (e) {
                console.warn(`buds-notifier prefs: ${e.message}`);
            }
        });
        testRow.add_suffix(testButton);
        testGroup.add(testRow);
    }
}

// Popup card widget: header (icon, title, subtitle, close), battery row, action buttons.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

const BAR_WIDTH = 64;
const LOW_LEVEL = 15;

const SLOTS = [
    ['left', 'Left'],
    ['right', 'Right'],
    ['case', 'Case'],
    ['single', 'Battery'],
];

export const BudsCard = GObject.registerClass({
    Signals: {
        'action': {param_types: [GObject.TYPE_STRING]},
        'dismiss': {},
    },
}, class BudsCard extends St.BoxLayout {
    _init(gicon) {
        super._init({
            style_class: 'buds-card',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            track_hover: true,
        });
        this._gicon = gicon;
    }

    // card: {kind, title, subtitle, battery?, actions?}
    setContent(card) {
        this.destroy_all_children();
        this.style_class = `buds-card buds-card-${card.kind}`;

        const header = new St.BoxLayout({style_class: 'buds-card-header'});
        header.add_child(new St.Icon({gicon: this._gicon, style_class: 'buds-card-icon'}));

        const titles = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        titles.add_child(new St.Label({text: card.title ?? '', style_class: 'buds-card-title'}));
        if (card.subtitle)
            titles.add_child(new St.Label({text: card.subtitle, style_class: 'buds-card-subtitle'}));
        header.add_child(titles);

        const close = new St.Button({
            style_class: 'buds-card-close',
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 14}),
            y_align: Clutter.ActorAlign.START,
        });
        close.connect('clicked', () => this.emit('dismiss'));
        header.add_child(close);
        this.add_child(header);

        const battery = this._buildBattery(card.battery);
        if (battery)
            this.add_child(battery);

        const actions = card.actions ?? [];
        if (actions.length) {
            const row = new St.BoxLayout({style_class: 'buds-card-actions', x_expand: true});
            for (const {id, label} of actions) {
                const button = new St.Button({
                    label,
                    style_class: id === 'connect' ? 'button buds-card-button default' : 'button buds-card-button',
                    can_focus: true,
                    x_expand: true,
                });
                button.connect('clicked', () => this.emit('action', id));
                row.add_child(button);
            }
            this.add_child(row);
        }
    }

    _buildBattery(battery) {
        if (!battery)
            return null;
        const row = new St.BoxLayout({style_class: 'buds-card-battery', x_expand: true});
        for (const [key, name] of SLOTS) {
            const slot = battery[key];
            if (slot === null || slot === undefined)
                continue;
            // single may be a bare number; left/right/case are {level, charging}
            const level = typeof slot === 'number' ? slot : slot.level;
            const charging = typeof slot === 'object' && slot.charging;
            row.add_child(this._buildSlot(name, level, charging));
        }
        return row.get_n_children() ? row : null;
    }

    _buildSlot(name, level, charging) {
        const slot = new St.BoxLayout({
            style_class: 'buds-card-slot',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        slot.add_child(new St.Label({text: name, style_class: 'buds-card-slot-name'}));
        slot.add_child(new St.Label({
            text: `${level}%${charging ? ' ⚡' : ''}`,
            style_class: 'buds-card-slot-level',
        }));

        const track = new St.Widget({style_class: 'buds-card-bar', width: BAR_WIDTH});
        const fill = new St.Widget({
            style_class: level <= LOW_LEVEL ? 'buds-card-bar-fill low' : 'buds-card-bar-fill',
            width: Math.max(2, Math.round(BAR_WIDTH * Math.min(level, 100) / 100)),
        });
        track.add_child(fill);
        slot.add_child(track);
        return slot;
    }
});

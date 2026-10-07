// Battery model shared by watchers and cards. Pure JS (testable with plain gjs).
//
// A battery is {slots: [{key, label, level, charging}]}; key is 'left', 'right',
// 'case', 'single' or 'other'. Cases never count towards low-battery warnings.

const UNAVAILABLE = new Set(['disconnected', 'not-reported']);

export function fromSingle(level) {
    return level === null || level === undefined
        ? null
        : {slots: [{key: 'single', label: 'Battery', level, charging: false}]};
}

function slotKey(icon) {
    if (/left/i.test(icon))
        return 'left';
    if (/right/i.test(icon))
        return 'right';
    if (/case/i.test(icon))
        return 'case';
    return 'other';
}

const LABELS = {left: 'Left', right: 'Right', case: 'Case'};

// BudsLink Device.State / Config JSON -> battery, or null when nothing is reported.
// Slot meaning comes from Config's battery<n>Icon (e.g. earbuds-stem-left, case-normal).
export function parseBudsLink(stateJson, configJson) {
    let state, config;
    try {
        state = JSON.parse(stateJson);
        config = configJson ? JSON.parse(configJson) : {};
    } catch {
        return null;
    }

    const slots = [];
    for (let n = 1; n <= 3; n++) {
        const level = state[`battery${n}Level`];
        const status = state[`battery${n}Status`];
        if (!Number.isInteger(level) || UNAVAILABLE.has(status) || status === undefined)
            continue;
        const key = slotKey(config[`battery${n}Icon`] ?? '');
        slots.push({key, label: LABELS[key] ?? `Battery ${n}`, level, charging: status === 'charging'});
    }
    if (slots.length === 1 && slots[0].key === 'other')
        slots[0].label = 'Battery';
    return slots.length ? {slots} : null;
}

// Level the low-battery warning is based on: the lowest non-case slot.
export function lowestLevel(battery) {
    const levels = (battery?.slots ?? []).filter(s => s.key !== 'case').map(s => s.level);
    return levels.length ? Math.min(...levels) : null;
}

export function hasBuds(battery) {
    return (battery?.slots ?? []).some(s => s.key !== 'case');
}

export function batteryText(battery) {
    if (!battery?.slots.length)
        return 'Battery: unknown';
    return battery.slots
        .map(s => `${s.label} ${s.level}%${s.charging ? ' (charging)' : ''}`)
        .join(' · ');
}

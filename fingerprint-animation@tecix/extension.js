// SPDX-License-Identifier: GPL-2.0-or-later
// Fingerprint Animation: a Touch ID–style HUD that shows when the fingerprint
// reader is waiting for a finger, reading it, and whether it matched.
//
// It listens to fprintd's broadcast D-Bus signals on the system bus, so it
// works for every fingerprint prompt: sudo in a terminal, polkit dialogs,
// the lock screen, and anything else that goes through PAM/fprintd.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {drawGlyph, easeOutCubic, easeOutQuad, mix} from './glyph.js';

const FPRINT_BUS_NAME = 'net.reactivated.Fprint';
const FPRINT_DEVICE_IFACE = 'net.reactivated.Fprint.Device';

// Used when the Shell has no accent colour API (GNOME 46).
const DEFAULT_ACCENT = [0.21, 0.52, 0.89, 1];
const IDLE = [1, 1, 1, 0.34];
const GREEN = [0.2, 0.82, 0.48, 1];
const RED = [1, 0.3, 0.37, 1];
const AMBER = [1, 0.72, 0.2, 1];

const FADE_IN_MS = 180;
const FADE_OUT_MS = 220;
const SUCCESS_HOLD_S = 1.1;
const FAILURE_HOLD_S = 1.1;
const RETRY_HOLD_S = 1.0;
// The reading animation (ridges traced from the centre out) always plays for
// this long before a result is shown. Many readers report the touch and the
// result in the same instant, which would otherwise skip it.
const SCAN_S = 0.75;
// Colour crossfade into the result colour.
const RESULT_FADE_S = 0.25;
// After the reader stops listening, wait this long for a result before hiding.
const STOP_GRACE_MS = 400;
// ... or this long once a finger touched it: readers that match on the
// computer stop listening while they still process the print.
const TOUCHED_STOP_GRACE_MS = 3000;

const State = {
    HIDDEN: 'hidden',
    WAITING: 'waiting',
    SCANNING: 'scanning',
    SUCCESS: 'success',
    FAILURE: 'failure',
    RETRY: 'retry',
};

function retryMessage(result) {
    switch (result) {
    case 'verify-swipe-too-short':
        return _('Swipe was too short');
    case 'verify-finger-not-centered':
        return _('Center your finger on the sensor');
    case 'verify-remove-and-retry':
        return _('Lift your finger and try again');
    default:
        return _('Try again');
    }
}

/**
 * Watches fprintd on the system bus and reports what the reader is doing.
 *
 * Signals are matched on the well-known name net.reactivated.Fprint, which
 * only fprintd (root, via D-Bus policy) can own; GDBus checks the sender
 * against the name's current owner, so other processes can't drive the HUD.
 * Payloads are still type-checked before use.
 */
class FprintWatcher {
    constructor(callbacks) {
        this._cb = callbacks;
        this._bus = Gio.DBus.system;
        this._ids = [
            this._bus.signal_subscribe(
                FPRINT_BUS_NAME, FPRINT_DEVICE_IFACE, null, null, null,
                Gio.DBusSignalFlags.NONE,
                (_c, _s, path, _i, signal, params) => this._onDeviceSignal(path, signal, params)),
            this._bus.signal_subscribe(
                FPRINT_BUS_NAME, 'org.freedesktop.DBus.Properties', 'PropertiesChanged',
                null, FPRINT_DEVICE_IFACE, Gio.DBusSignalFlags.NONE,
                (_c, _s, path, _i, _sig, params) => this._onPropertiesChanged(path, params)),
        ];
    }

    _onDeviceSignal(path, signal, params) {
        if (signal === 'VerifyStatus') {
            if (params.get_type_string() !== '(sb)')
                return;
            const [result, done] = params.deep_unpack();
            this._cb.verifyStatus(result, done);
        } else if (signal === 'VerifyFingerSelected') {
            this._cb.verifyStarted();
        }
    }

    _onPropertiesChanged(path, params) {
        if (params.get_type_string() !== '(sa{sv}as)')
            return;
        const [, changed] = params.deep_unpack();
        const flag = name => {
            const v = changed[name];
            return v?.get_type_string() === 'b' ? v.get_boolean() : null;
        };
        const needed = flag('finger-needed');
        if (needed !== null)
            this._cb.fingerNeeded(needed);
        const present = flag('finger-present');
        if (present !== null)
            this._cb.fingerPresent(present);
    }

    destroy() {
        for (const id of this._ids)
            this._bus.signal_unsubscribe(id);
        this._ids = [];
    }
}

const FingerprintHud = GObject.registerClass(
class FingerprintHud extends Clutter.Actor {
    _init() {
        super._init({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            reactive: false,
            visible: false,
        });
        this.add_constraint(new Layout.MonitorConstraint({primary: true}));

        this._box = new St.BoxLayout({
            style_class: 'fp-hud',
            opacity: 0,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });
        // St.BoxLayout:orientation is new in GNOME 48; :vertical before that.
        if ('orientation' in this._box)
            this._box.orientation = Clutter.Orientation.VERTICAL;
        else
            this._box.vertical = true;
        this.add_child(this._box);

        this._area = new St.DrawingArea({
            style_class: 'fp-hud-glyph',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._area.connectObject('repaint', area => this._repaint(area), this);
        this._box.add_child(this._area);

        this._label = new St.Label({
            style_class: 'fp-hud-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._label.clutter_text.line_wrap = true;
        this._label.clutter_text.ellipsize = 0;
        this._label.clutter_text.line_alignment = 1; // Pango.Alignment.CENTER
        this._box.add_child(this._label);

        this._timeline = new Clutter.Timeline({
            actor: this._area,
            duration: 1000,
            repeat_count: -1,
        });
        this._timeline.connectObject('new-frame', () => this._onFrame(), this);

        // The theme context re-emits 'changed' when the accent colour changes.
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        this._themeContext.connectObject('changed', () => this._updateAccent(), this);
        this._accent = DEFAULT_ACCENT;
        this._updateAccent();

        this._state = State.HIDDEN;
        this._stateStart = 0;
        this._fill = 0; // radial fill reached so far, carried across states
        this._fingerNeeded = false;
        this._sawFingerNeeded = false; // the reader reports finger-needed
        this._fingerPresent = false;
        this._listening = false;
        this._touchedThisAttempt = false;
        this._resolveId = 0;
        this._stopId = 0;
        this._pendingId = 0;

        this.connect('destroy', () => this._onDestroy());
    }

    _updateAccent() {
        // St.ThemeContext.get_accent_color() exists since GNOME 47.
        if (typeof this._themeContext.get_accent_color !== 'function')
            return;
        const [color] = this._themeContext.get_accent_color();
        this._accent = [color.red / 255, color.green / 255, color.blue / 255, 1];
        this._area.queue_repaint();
    }

    // --- fprintd events -------------------------------------------------

    verifyStarted() {
        this._touchedThisAttempt = false;
        this._listening = true;
        this._clearStopTimeout();
        // finger-needed normally follows right away; showing the HUD here as
        // well covers readers and fprintd builds that don't report it.
        if (!this._isBusy() && this._state !== State.SCANNING)
            this._enterIdleOrWaiting();
    }

    fingerNeeded(needed) {
        this._fingerNeeded = needed;
        this._sawFingerNeeded = true;
        this._listening = needed;
        this._clearStopTimeout();
        if (needed) {
            this._touchedThisAttempt = false;
            if (this._isBusy())
                return; // let the result animation finish, _resolve() picks it up
            this._enterIdleOrWaiting();
        } else if (!this._pendingId &&
                   (this._state === State.WAITING || this._state === State.SCANNING)) {
            // The reader stopped listening. A result may still be on its way;
            // if none arrives, the prompt was cancelled.
            const grace = this._touchedThisAttempt ? TOUCHED_STOP_GRACE_MS : STOP_GRACE_MS;
            this._stopId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, grace, () => {
                this._stopId = 0;
                if (this._state === State.WAITING || this._state === State.SCANNING)
                    this._hide();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    fingerPresent(present) {
        this._fingerPresent = present;
        if (present) {
            this._touchedThisAttempt = true;
            if (!this._isBusy())
                this._setState(State.SCANNING);
        }
    }

    verifyStatus(result, done) {
        if (done)
            this._listening = false;
        switch (result) {
        case 'verify-match':
            this._showResult(State.SUCCESS, _('Fingerprint recognized'), SUCCESS_HOLD_S, true);
            break;
        case 'verify-no-match':
            // fprintd also reports no-match when a prompt is cancelled (after
            // it stopped listening, with no touch); don't flash an error then.
            if (this._sawFingerNeeded && !this._touchedThisAttempt &&
                !this._fingerNeeded && this._state !== State.SCANNING) {
                this._hide();
                break;
            }
            this._touchedThisAttempt = false;
            this._showResult(State.FAILURE, _('Not recognized'), FAILURE_HOLD_S);
            break;
        case 'verify-retry-scan':
        case 'verify-swipe-too-short':
        case 'verify-finger-not-centered':
        case 'verify-remove-and-retry':
            this._showResult(State.RETRY, retryMessage(result), RETRY_HOLD_S);
            break;
        default: // verify-disconnected, verify-unknown-error, …
            if (done)
                this._hide();
        }
    }

    // --- state machine --------------------------------------------------

    _isBusy() {
        return this._pendingId !== 0 ||
            this._state === State.SUCCESS ||
            this._state === State.FAILURE ||
            this._state === State.RETRY;
    }

    _showResult(state, message, holdS, finished = false) {
        this._clearPending();
        this._clearStopTimeout();
        const apply = () => {
            this._setState(state, message);
            this._scheduleResolve(holdS, finished);
        };
        // Let the reading animation play out first, even when the reader
        // reported the touch and the result at the same moment (or never
        // reported the touch at all).
        if (this._state === State.HIDDEN || this._state === State.WAITING)
            this._setState(State.SCANNING);
        const waitMs = this._state === State.SCANNING
            ? Math.ceil((SCAN_S - this._elapsed()) * 1000) : 0;
        if (waitMs <= 16) {
            apply();
            return;
        }
        this._pendingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, waitMs, () => {
            this._pendingId = 0;
            apply();
            return GLib.SOURCE_REMOVE;
        });
    }

    _enterIdleOrWaiting() {
        // The lock and login screens keep the reader listening the whole time
        // they are up, so there only show the HUD once a finger touches it.
        const alwaysListening = Main.sessionMode.isLocked || Main.sessionMode.isGreeter;
        if (alwaysListening && !this._fingerPresent)
            this._hide();
        else
            this._setState(this._fingerPresent ? State.SCANNING : State.WAITING);
    }

    _scheduleResolve(seconds, finished = false) {
        this._clearResolveTimeout();
        this._resolveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, seconds * 1000, () => {
            this._resolveId = 0;
            if (!finished && this._listening)
                this._enterIdleOrWaiting();
            else
                this._hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    _setState(state, message = null) {
        const ongoing = state === State.WAITING || state === State.SCANNING;
        if (!ongoing || state !== this._state) {
            // Results carry on from the fill the scan reached.
            if (ongoing)
                this._fill = 0;
            this._stateStart = GLib.get_monotonic_time();
        }
        if (state === State.WAITING || state === State.SCANNING)
            this._clearResolveTimeout();
        this._state = state;

        this._label.text = message ?? {
            [State.WAITING]: _('Touch the fingerprint sensor'),
            [State.SCANNING]: _('Reading fingerprint…'),
        }[state] ?? '';
        this._show();
        this._area.queue_repaint();
    }

    _show() {
        if (!this.visible) {
            this.visible = true;
            this._box.opacity = 0;
            this._box.set_scale(0.86, 0.86);
            this._timeline.start();
        }
        const parent = this.get_parent();
        parent?.set_child_above_sibling(this, null);
        this._box.remove_transition('opacity');
        // Opacity gets its own easing: EASE_OUT_BACK overshoots past 255,
        // and opacity is 8-bit, so it would wrap round and blink.
        this._box.ease({
            opacity: 255,
            duration: FADE_IN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._box.ease({
            scale_x: 1,
            scale_y: 1,
            duration: FADE_IN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    _hide() {
        this._clearResolveTimeout();
        this._clearStopTimeout();
        this._clearPending();
        if (this._state === State.HIDDEN)
            return;
        this._frozen = this._params(); // keep the last look while fading out
        this._state = State.HIDDEN;
        this._box.ease({
            opacity: 0,
            scale_x: 0.92,
            scale_y: 0.92,
            duration: FADE_OUT_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: isFinished => {
                if (isFinished && this._state === State.HIDDEN) {
                    this.visible = false;
                    this._timeline.stop();
                    this._box.translation_x = 0;
                }
            },
        });
    }

    _clearResolveTimeout() {
        if (this._resolveId) {
            GLib.source_remove(this._resolveId);
            this._resolveId = 0;
        }
    }

    _clearPending() {
        if (this._pendingId) {
            GLib.source_remove(this._pendingId);
            this._pendingId = 0;
        }
    }

    _clearStopTimeout() {
        if (this._stopId) {
            GLib.source_remove(this._stopId);
            this._stopId = 0;
        }
    }

    // --- animation ------------------------------------------------------

    _elapsed() {
        return (GLib.get_monotonic_time() - this._stateStart) / 1e6;
    }

    _onFrame() {
        // Shake on failure / retry.
        const t = this._elapsed();
        let dx = 0;
        if (this._state === State.FAILURE || this._state === State.RETRY) {
            const dur = 0.55;
            const amp = this._state === State.FAILURE ? 12 : 6;
            if (t < dur)
                dx = amp * Math.sin(t * Math.PI * 2 * 6) * (1 - t / dur);
        }
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._box.translation_x = dx * scale;
        this._area.queue_repaint();
    }

    _params() {
        const t = this._elapsed();
        const accent = this._accent;
        const p = {
            base: IDLE, lit: accent, fill: 0, wave: -1, ripple: -1,
            ridgeAlpha: 1, check: -1, cross: -1,
        };

        switch (this._state) {
        case State.WAITING:
            p.base = mix(IDLE, [...accent.slice(0, 3), 0.7], 0.35);
            p.ripple = (t % 1.8) / 1.8;
            p.ridgeAlpha = 0.8 + 0.2 * Math.cos(t * Math.PI * 2 / 1.8);
            break;
        case State.HIDDEN:
            return this._frozen ?? p;
        case State.SCANNING:
            // Ridges are traced from the centre outwards, with a bright
            // front, then a shimmer keeps sweeping while the reader decides.
            this._fill = Math.max(this._fill, easeOutQuad(t / SCAN_S));
            p.fill = this._fill;
            p.wave = t < SCAN_S ? this._fill : ((t - SCAN_S) % 1.0) / 1.0;
            break;
        case State.SUCCESS: {
            const c = easeOutCubic(t / RESULT_FADE_S);
            p.lit = mix(accent, GREEN, c);
            p.fill = this._fill + (1 - this._fill) * c;
            const k = Math.max(0, t - RESULT_FADE_S);
            p.ridgeAlpha = 1 - 0.85 * easeOutCubic(k / 0.3);
            p.check = k / 0.5;
            break;
        }
        case State.FAILURE: {
            const c = easeOutCubic(t / RESULT_FADE_S);
            p.base = mix(IDLE, mix(IDLE, RED, 0.5), c);
            p.lit = mix(accent, RED, c);
            p.fill = this._fill + (1 - this._fill) * c;
            p.ridgeAlpha = t < 0.6 ? 1 : 1 - 0.8 * easeOutCubic((t - 0.6) / 0.25);
            p.cross = t < 0.6 ? -1 : (t - 0.6) / 0.35;
            break;
        }
        case State.RETRY:
            p.lit = mix(accent, AMBER, easeOutCubic(t / RESULT_FADE_S));
            p.fill = this._fill * (1 - easeOutCubic(t / 0.6));
            break;
        }
        return p;
    }

    _repaint(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const size = Math.min(w, h);
        cr.translate((w - size) / 2, (h - size) / 2);
        drawGlyph(cr, size, this._params());
        cr.$dispose();
    }

    _onDestroy() {
        this._clearResolveTimeout();
        this._clearStopTimeout();
        this._clearPending();
        this._timeline.stop();
        this._timeline.disconnectObject(this);
        this._timeline = null;
        this._area.disconnectObject(this);
        this._themeContext.disconnectObject(this);
        this._themeContext = null;
    }
});

export default class FingerprintAnimationExtension extends Extension {
    enable() {
        this._hud = new FingerprintHud();
        Main.uiGroup.add_child(this._hud);
        this._watcher = new FprintWatcher({
            verifyStarted: () => this._hud.verifyStarted(),
            fingerNeeded: v => this._hud.fingerNeeded(v),
            fingerPresent: v => this._hud.fingerPresent(v),
            verifyStatus: (r, d) => this._hud.verifyStatus(r, d),
        });
    }

    disable() {
        // Kept enabled on the lock screen (session-modes: unlock-dialog) and
        // the GDM login screen (gdm) so the animation also shows when
        // unlocking or logging in with a fingerprint.
        this._watcher?.destroy();
        this._watcher = null;
        this._hud?.destroy();
        this._hud = null;
    }
}

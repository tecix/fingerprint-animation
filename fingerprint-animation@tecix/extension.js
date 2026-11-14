// SPDX-License-Identifier: GPL-2.0-or-later
// Fingerprint Animation: a Touch ID–style HUD that shows when the fingerprint
// reader is waiting for a finger, reading it, and whether it matched.
//
// It listens to fprintd's broadcast D-Bus signals on the system bus, so it
// works for every fingerprint prompt: sudo in a terminal, polkit dialogs,
// the lock screen, and anything else that goes through PAM/fprintd.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {drawGlyph, easeOutCubic, easeOutQuad, mix} from './glyph.js';

const FPRINT_BUS_NAME = 'net.reactivated.Fprint';
const FPRINT_DEVICE_IFACE = 'net.reactivated.Fprint.Device';
const BLUR_MY_SHELL_UUID = 'blur-my-shell@aunetx';

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
// Login screen: after a match the check stays frozen until GDM replaces the
// greeter with your session; this only clears it if that never happens.
const GREETER_SUCCESS_TIMEOUT_S = 15;
const RETRY_HOLD_S = 1.0;
// Tracing the ridges in while a finger is on the sensor.
const SCAN_TRACE_S = 0.9;
// Results show at once; their animation finishes the trace in the result
// colour within this time, crossfading the colour meanwhile.
const RESULT_SWEEP_S = 0.3;
const RESULT_FADE_S = 0.2;
// When the check mark / cross starts drawing.
const MARK_DELAY_S = 0.18;
const FAILURE_MARK_DELAY_S = 0.4;
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

// Rounds the corners of the actor it is attached to (the blurred backdrop),
// with a one-pixel anti-aliased edge.
const CornerMaskEffect = GObject.registerClass(
class CornerMaskEffect extends Shell.GLSLEffect {
    _init() {
        super._init();
        this._sizeLocation = this.get_uniform_location('fp_size');
        this._radiusLocation = this.get_uniform_location('fp_radius');
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, `
            uniform vec2 fp_size;
            uniform float fp_radius;
        `, `
            vec2 p = cogl_tex_coord_in[0].xy * fp_size - 0.5 * fp_size;
            vec2 q = abs(p) - 0.5 * fp_size + vec2(fp_radius);
            float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - fp_radius;
            cogl_color_out *= 1.0 - smoothstep(-0.75, 0.75, d);
        `, false);
    }

    setGeometry(width, height, radius) {
        this.set_uniform_float(this._sizeLocation, 2, [width, height]);
        this.set_uniform_float(this._radiusLocation, 1, [radius]);
        this.queue_repaint();
    }
});

// True while a backdrop paints its clone of the Shell UI; the HUD skips
// drawing itself then, so it doesn't end up inside its own backdrop.
let paintingBackdrop = false;

// A clone of the Shell UI (wallpaper, windows, panels), shifted so it lines
// up with the screen behind this actor, and clipped to it.
const BackdropLayer = GObject.registerClass(
class BackdropLayer extends Clutter.Actor {
    _init() {
        super._init({clip_to_allocation: true});
        this._offset = [0, 0];
        this._clone = new Clutter.Clone({source: Main.uiGroup});
        this.add_child(this._clone);
    }

    vfunc_paint(paintContext) {
        paintingBackdrop = true;
        try {
            super.vfunc_paint(paintContext);
        } finally {
            paintingBackdrop = false;
        }
    }

    setOffset(x, y) {
        if (this._offset[0] === x && this._offset[1] === y)
            return;
        this._offset = [x, y];
        this.queue_relayout();
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const source = Main.uiGroup;
        const [sx, sy] = source.get_position();
        const [sw, sh] = source.get_size();
        const x = sx - this._offset[0];
        const y = sy - this._offset[1];
        this._clone.allocate(new Clutter.ActorBox({x1: x, y1: y, x2: x + sw, y2: y + sh}));
    }
});

/**
 * Blurred copy of whatever is behind the HUD, with rounded corners.
 *
 * Shell.BlurEffect's background mode can't be clipped to a rounded shape, so
 * this blurs a clone of the Shell UI instead and masks its corners. It is
 * only ever used in the user session, never on the lock or login screen.
 */
const BlurredBackdrop = GObject.registerClass(
class BlurredBackdrop extends Clutter.Actor {
    _init(radius, brightness) {
        super._init({x_expand: true, y_expand: true, clip_to_allocation: true});
        this.cornerRadius = 0;
        this._mask = new CornerMaskEffect();
        this.add_effect(this._mask);

        this._layer = new BackdropLayer();
        this._blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius, brightness});
        this._layer.add_effect(this._blur);
        this.add_child(this._layer);
    }

    setBlur(radius, brightness) {
        this._blur.radius = radius;
        this._blur.brightness = brightness;
    }

    // Take the size of the HUD box, not of the (screen-sized) clone.
    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(_forWidth) {
        return [0, 0];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const width = box.get_width();
        const height = box.get_height();
        this._layer.allocate(new Clutter.ActorBox({x2: width, y2: height}));
        this._mask.setGeometry(width, height, this.cornerRadius);
    }

    // Keep the clone aligned with the screen behind the HUD (called every
    // frame while the HUD is up; the HUD moves when it shakes).
    track() {
        const [x, y] = this.get_transformed_position();
        if (Number.isFinite(x) && Number.isFinite(y))
            this._layer.setOffset(Math.round(x), Math.round(y));
    }
});

const FingerprintHud = GObject.registerClass(
class FingerprintHud extends Clutter.Actor {
    _init(settings) {
        super._init({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            reactive: false,
            visible: false,
        });
        this.add_constraint(new Layout.MonitorConstraint({primary: true}));

        // The frame carries the fade, scale and shake animations; it holds
        // the optional blurred backdrop and the HUD box on top of it.
        this._frame = new St.Widget({
            style_class: 'fp-hud-frame',
            layout_manager: new Clutter.BinLayout(),
            opacity: 0,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });
        this.add_child(this._frame);

        this._box = new St.BoxLayout({style_class: 'fp-hud'});
        // St.BoxLayout:orientation is new in GNOME 48; :vertical before that.
        if ('orientation' in this._box)
            this._box.orientation = Clutter.Orientation.VERTICAL;
        else
            this._box.vertical = true;
        this._frame.add_child(this._box);
        this._backdrop = null;

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

        this._settings = settings;
        this._settings.connectObject('changed', () => this._updateBlur(), this);
        Main.extensionManager.connectObject('extension-state-changed',
            (_m, ext) => {
                if (ext.uuid === BLUR_MY_SHELL_UUID)
                    this._updateBlur();
            }, this);
        Main.sessionMode.connectObject('updated', () => this._updateBlur(), this);

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

        this.connect('destroy', () => this._onDestroy());
        this._updateBlur();
    }

    vfunc_paint(paintContext) {
        if (!paintingBackdrop)
            super.vfunc_paint(paintContext);
    }

    _updateAccent() {
        // St.ThemeContext.get_accent_color() exists since GNOME 47.
        if (typeof this._themeContext.get_accent_color !== 'function')
            return;
        const [color] = this._themeContext.get_accent_color();
        this._accent = [color.red / 255, color.green / 255, color.blue / 255, 1];
        this._area.queue_repaint();
    }

    // --- background blur ------------------------------------------------

    _wantsBlur() {
        // Never on the lock or login screen: the backdrop is a copy of the
        // desktop, which must stay hidden there.
        if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter)
            return false;
        switch (this._settings.get_string('blur-mode')) {
        case 'on':
            return true;
        case 'off':
            return false;
        default: // 'auto': match Blur my Shell when it is running
            return Main.extensionManager.lookup(BLUR_MY_SHELL_UUID)?.state ===
                ExtensionState.ACTIVE;
        }
    }

    _updateBlur() {
        const radius = this._settings.get_int('blur-radius');
        const brightness = this._settings.get_double('blur-brightness');
        if (this._wantsBlur()) {
            if (!this._backdrop) {
                this._backdrop = new BlurredBackdrop(radius, brightness);
                this._frame.insert_child_below(this._backdrop, this._box);
                this._box.add_style_class_name('fp-hud-blurred');
            }
            const scale = this._themeContext.scale_factor;
            this._backdrop.setBlur(radius * scale, brightness);
            this._syncCornerRadius();
        } else if (this._backdrop) {
            this._backdrop.destroy();
            this._backdrop = null;
            this._box.remove_style_class_name('fp-hud-blurred');
        }
    }

    _syncCornerRadius() {
        if (!this._backdrop || !this._box.get_stage())
            return;
        this._backdrop.cornerRadius = this._box.get_theme_node()
            .get_border_radius(St.Corner.TOPLEFT);
        this._backdrop.queue_relayout();
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
        } else if (this._state === State.WAITING || this._state === State.SCANNING) {
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
        return this._state === State.SUCCESS ||
            this._state === State.FAILURE ||
            this._state === State.RETRY;
    }

    // The login screen gets static frames only: after a match GDM loads the
    // session and the greeter gets few frames, so any animation would stutter.
    _static() {
        return Main.sessionMode.isGreeter;
    }

    _showResult(state, message, holdS, finished = false) {
        // Like Touch ID, the result shows the moment the reader decides. The
        // trace isn't waited for: the result animation completes it on the
        // way (see _params()).
        this._clearStopTimeout();
        this._setState(state, message);
        if (state === State.SUCCESS && this._static()) {
            // Freeze on the check: no hold, no fade-out, no work at all while
            // the session loads.
            this._clearResolveTimeout();
            this._resolveId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
                GREETER_SUCCESS_TIMEOUT_S, () => {
                    this._resolveId = 0;
                    this._hide(true);
                    return GLib.SOURCE_REMOVE;
                });
            return;
        }
        this._scheduleResolve(holdS, finished);
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
            if (ongoing || this._state === State.HIDDEN || this._state === State.WAITING)
                this._fill = 0;
            this._stateStart = GLib.get_monotonic_time();
        }
        if (ongoing)
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
            this._frame.opacity = 0;
            this._frame.set_scale(0.86, 0.86);
            if (!this._static())
                this._timeline.start();
            this._syncCornerRadius();
        }
        const parent = this.get_parent();
        parent?.set_child_above_sibling(this, null);
        this._frame.remove_transition('opacity');
        const duration = this._static() ? 0 : FADE_IN_MS;
        // Opacity gets its own easing: EASE_OUT_BACK overshoots past 255,
        // and opacity is 8-bit, so it would wrap round and blink.
        this._frame.ease({
            opacity: 255,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._frame.ease({
            scale_x: 1,
            scale_y: 1,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    _hide(immediately = false) {
        this._clearResolveTimeout();
        this._clearStopTimeout();
        if (this._state === State.HIDDEN)
            return;
        this._frozen = this._params(); // keep the last look while fading out
        this._state = State.HIDDEN;
        if (immediately) {
            this._frame.remove_all_transitions();
            this._frame.opacity = 0;
            this.visible = false;
            this._timeline.stop();
            this._frame.translation_x = 0;
            return;
        }
        this._frame.ease({
            opacity: 0,
            scale_x: 0.92,
            scale_y: 0.92,
            duration: FADE_OUT_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: isFinished => {
                if (isFinished && this._state === State.HIDDEN) {
                    this.visible = false;
                    this._timeline.stop();
                    this._frame.translation_x = 0;
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
        this._frame.translation_x = dx * this._themeContext.scale_factor;
        this._backdrop?.track();
        this._area.queue_repaint();
    }

    _params() {
        const t = this._elapsed();
        const accent = this._accent;
        const p = {
            base: IDLE, lit: accent, fill: 0, wave: -1, ripple: -1,
            ridgeAlpha: 1, check: -1, cross: -1,
        };
        // Results finish the trace quickly in the result colour, from
        // wherever the reading got to, so the ridges always read in.
        const sweep = from => {
            p.fill = from + (1 - from) * easeOutQuad(t / RESULT_SWEEP_S);
            p.wave = t < RESULT_SWEEP_S ? p.fill : -1;
        };

        if (this._static()) {
            // One final-looking frame per state (see _static()).
            switch (this._state) {
            case State.HIDDEN:
                return this._frozen ?? p;
            case State.SUCCESS:
                return Object.assign(p, {lit: GREEN, fill: 1, ridgeAlpha: 0.15, check: 1});
            case State.FAILURE:
                return Object.assign(p, {
                    base: mix(IDLE, RED, 0.5), lit: RED, fill: 1, ridgeAlpha: 0.2, cross: 1,
                });
            case State.RETRY:
                return Object.assign(p, {lit: AMBER, fill: 1});
            default: // WAITING (not shown there), SCANNING
                return Object.assign(p, {fill: 1});
            }
        }

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
            this._fill = Math.max(this._fill, easeOutQuad(t / SCAN_TRACE_S));
            p.fill = this._fill;
            p.wave = t < SCAN_TRACE_S ? this._fill : ((t - SCAN_TRACE_S) % 1.0) / 1.0;
            break;
        case State.SUCCESS: {
            p.lit = mix(accent, GREEN, easeOutCubic(t / RESULT_FADE_S));
            sweep(this._fill);
            const k = Math.max(0, t - MARK_DELAY_S);
            p.ridgeAlpha = 1 - 0.85 * easeOutCubic(k / 0.3);
            p.check = t < MARK_DELAY_S ? -1 : k / 0.45;
            break;
        }
        case State.FAILURE: {
            const c = easeOutCubic(t / RESULT_FADE_S);
            p.base = mix(IDLE, mix(IDLE, RED, 0.5), c);
            p.lit = mix(accent, RED, c);
            sweep(this._fill);
            const k = t - FAILURE_MARK_DELAY_S;
            p.ridgeAlpha = k < 0 ? 1 : 1 - 0.8 * easeOutCubic(k / 0.25);
            p.cross = k < 0 ? -1 : k / 0.35;
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
        this._timeline.stop();
        this._timeline.disconnectObject(this);
        this._timeline = null;
        this._area.disconnectObject(this);
        this._themeContext.disconnectObject(this);
        this._themeContext = null;
        this._settings.disconnectObject(this);
        this._settings = null;
        Main.extensionManager.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
    }
});

export default class FingerprintAnimationExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._hud = new FingerprintHud(this._settings);
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
        this._settings = null;
    }
}

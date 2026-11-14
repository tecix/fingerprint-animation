// SPDX-License-Identifier: GPL-2.0-or-later
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const BLUR_MODES = ['auto', 'on', 'off'];

export default class FingerprintAnimationPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(560, 400);

        const page = new Adw.PreferencesPage({icon_name: 'preferences-system-symbolic'});
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: _('Background blur'),
            description: _('Blur what is behind the HUD, like Blur my Shell does for the rest of the Shell. Never used on the lock or login screen.'),
        });
        page.add(group);

        const mode = new Adw.ComboRow({
            title: _('Blur'),
            model: Gtk.StringList.new([
                _('Automatic (when Blur my Shell is on)'),
                _('Always'),
                _('Never'),
            ]),
        });
        const syncMode = () => {
            mode.selected = Math.max(0, BLUR_MODES.indexOf(settings.get_string('blur-mode')));
        };
        syncMode();
        settings.connect('changed::blur-mode', syncMode);
        mode.connect('notify::selected', () => {
            settings.set_string('blur-mode', BLUR_MODES[mode.selected] ?? 'auto');
        });
        group.add(mode);

        const radius = Adw.SpinRow.new_with_range(1, 100, 1);
        radius.title = _('Strength');
        radius.subtitle = _('Blur radius in pixels');
        settings.bind('blur-radius', radius, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(radius);

        const brightness = Adw.SpinRow.new_with_range(0, 1, 0.05);
        brightness.title = _('Brightness');
        brightness.digits = 2;
        settings.bind('blur-brightness', brightness, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(brightness);
    }
}

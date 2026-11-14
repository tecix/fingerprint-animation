// Render a contact sheet of glyph states to a PNG, for checking the drawing
// without reloading GNOME Shell:  gjs -m tools/preview.js out.png
import Cairo from 'cairo';
import System from 'system';
import {drawGlyph} from '../fingerprint-animation@tecix/glyph.js';

const out = ARGV[0] ?? 'preview.png';
const CELL = 200;
const WHITE = [1, 1, 1, 0.35];
const ACCENT = [0.21, 0.52, 0.89, 1];
const GREEN = [0.2, 0.82, 0.48, 1];
const RED = [1, 0.3, 0.37, 1];

const frames = [
    {base: WHITE, lit: ACCENT, fill: 0, wave: -1, ripple: 0.4, check: -1, cross: -1},
    {base: WHITE, lit: ACCENT, fill: 0.3, wave: 0.3, ripple: -1, check: -1, cross: -1},
    {base: WHITE, lit: ACCENT, fill: 0.7, wave: 0.7, ripple: -1, check: -1, cross: -1},
    {base: WHITE, lit: GREEN, fill: 1, wave: -1, ripple: -1, check: -1, cross: -1},
    {base: WHITE, lit: GREEN, fill: 1, wave: -1, ripple: -1, ridgeAlpha: 0.2, check: 0.5, cross: -1},
    {base: WHITE, lit: GREEN, fill: 1, wave: -1, ripple: -1, ridgeAlpha: 0, check: 1, cross: -1},
    {base: RED, lit: RED, fill: 1, wave: -1, ripple: -1, check: -1, cross: -1},
    {base: WHITE, lit: RED, fill: 1, wave: -1, ripple: -1, ridgeAlpha: 0.15, check: -1, cross: 1},
];

const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, CELL * 4, CELL * 2);
const cr = new Cairo.Context(surface);
cr.setSourceRGB(0.12, 0.12, 0.13);
cr.paint();
frames.forEach((f, i) => {
    cr.save();
    cr.translate((i % 4) * CELL + 20, Math.floor(i / 4) * CELL + 20);
    drawGlyph(cr, CELL - 40, f);
    cr.restore();
});
surface.writeToPNG(out);
cr.$dispose();
System.exit(0);

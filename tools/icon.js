// Render the extension icon (PNG + SVG) from the same glyph the HUD draws.
//   gjs -m tools/icon.js OUTDIR
import Cairo from 'cairo';
import System from 'system';
import {drawGlyph} from '../fingerprint-animation@tecix/glyph.js';

const outDir = ARGV[0] ?? '.';
const BLUE = [0.21, 0.52, 0.89, 1];

function roundedRect(cr, x, y, w, h, r) {
    cr.newPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

function paint(cr, size) {
    const m = size * 0.06;
    const s = size - 2 * m;
    roundedRect(cr, m, m, s, s, s * 0.22);
    const bg = new Cairo.LinearGradient(0, m, 0, m + s);
    bg.addColorStopRGB(0, 0.19, 0.19, 0.21);
    bg.addColorStopRGB(1, 0.09, 0.09, 0.1);
    cr.setSource(bg);
    cr.fillPreserve();
    cr.setSourceRGBA(1, 1, 1, 0.1);
    cr.setLineWidth(size / 128);
    cr.stroke();

    const g = s * 0.78;
    cr.save();
    cr.translate(m + (s - g) / 2, m + (s - g) / 2);
    drawGlyph(cr, g, {
        base: [1, 1, 1, 0.34], lit: BLUE, fill: 0.72, wave: 0.62,
        ripple: -1, ridgeAlpha: 1, check: -1, cross: -1,
    });
    cr.restore();
}

for (const size of [256, 512]) {
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, size, size);
    const cr = new Cairo.Context(surface);
    paint(cr, size);
    surface.writeToPNG(`${outDir}/icon-${size}.png`);
    cr.$dispose();
}

const svg = new Cairo.SVGSurface(`${outDir}/icon.svg`, 256, 256);
const cr = new Cairo.Context(svg);
paint(cr, 256);
cr.$dispose();
svg.finish();
System.exit(0);

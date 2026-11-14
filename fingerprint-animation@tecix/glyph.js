// SPDX-License-Identifier: GPL-2.0-or-later
// Cairo drawing of the animated fingerprint glyph.
// Pure drawing code (no Shell imports) so it can be rendered offline too.

// Ridges in a 100×100 box, as arcs around a common centre, squashed
// horizontally into a fingertip-shaped oval.
// Angles in degrees, cairo convention (0 = right, 90 = down, -90 = top).
const CX = 50;
const CY = 57;
const SX = 0.8; // horizontal squash of the oval
const RIDGES = [
    // [radius, startAngle, endAngle]
    [4, -200, 20],
    [11, -212, -35],
    [11, -14, 30],
    [18, -218, -118],
    [18, -98, 42],
    [25, -222, -45],
    [25, -24, 48],
    [32, -216, -150],
    [32, -134, 22],
    [32, 36, 52],
    [39, -206, -96],
    [39, -78, 12],
    [46, -162, -112],
    [46, -96, -42],
];
const MAX_R = 46;

function deg(a) {
    return a * Math.PI / 180;
}

function setRGBA(cr, c, alpha = 1) {
    cr.setSourceRGBA(c[0], c[1], c[2], (c[3] ?? 1) * alpha);
}

function clamp01(x) {
    return Math.max(0, Math.min(1, x));
}

export function easeOutCubic(t) {
    t = clamp01(t);
    return 1 - (1 - t) ** 3;
}

/**
 * Draw the glyph.
 *
 * @param {object} cr cairo context
 * @param {number} size side of the square area in pixels
 * @param {object} p params
 * @param {number[]} p.base ridge colour when idle [r,g,b,a]
 * @param {number[]} p.lit colour of ridges that are "read"
 * @param {number} p.fill 0..1 how far (radially) ridges are lit
 * @param {number} p.wave 0..1 position of the bright scanning wavefront, <0 = none
 * @param {number} p.ripple 0..1 phase of the waiting ripple ring, <0 = none
 * @param {number} p.ridgeAlpha overall ridge opacity
 * @param {number} p.check 0..1 progress of the check mark, <0 = none
 * @param {number} p.cross 0..1 progress of the failure mark, <0 = none
 */
export function drawGlyph(cr, size, p) {
    const s = size / 100;
    cr.save();
    cr.scale(s, s);
    cr.setLineCap(1); // ROUND
    cr.setLineJoin(1);

    // Waiting ripple: a soft ring expanding out of the glyph.
    if (p.ripple >= 0) {
        const t = easeOutCubic(p.ripple);
        const r = 30 + t * 18;
        cr.setLineWidth(2.2);
        setRGBA(cr, p.lit, 0.75 * (1 - p.ripple));
        cr.arc(50, 50, r, 0, 2 * Math.PI);
        cr.stroke();
    }

    const ridgeAlpha = p.ridgeAlpha ?? 1;
    if (ridgeAlpha > 0) {
        const lw = 4.2;
        const fillR = p.fill * (MAX_R + 6);

        const strokeRidge = (r, path) => {
            // Base colour.
            cr.setLineWidth(lw);
            path();
            let lit = clamp01((fillR - r + 4) / 8);
            let color = p.base;
            if (lit > 0)
                color = mix(p.base, p.lit, lit);
            setRGBA(cr, color, ridgeAlpha);
            cr.stroke();

            // Scanning wavefront: brighten ridges near the front.
            if (p.wave >= 0) {
                const front = p.wave * (MAX_R + 12) - 6;
                const d = Math.abs(r - front);
                const glow = clamp01(1 - d / 7);
                if (glow > 0) {
                    cr.setLineWidth(lw + 2.5 * glow);
                    path();
                    setRGBA(cr, mix(p.lit, [1, 1, 1, 1], 0.55), ridgeAlpha * glow);
                    cr.stroke();
                }
            }
        };

        for (const [r, a0, a1] of RIDGES) {
            strokeRidge(r, () => {
                // Build the path in the squashed space, stroke in the
                // normal one so line widths stay even.
                cr.save();
                cr.translate(CX, CY);
                cr.scale(SX, 1);
                cr.newPath();
                cr.arc(0, 0, r, deg(a0), deg(a1));
                cr.restore();
            });
        }
    }

    if (p.check >= 0)
        drawMark(cr, p.lit, p.check, [[33, 51], [45, 63], [68, 38]]);
    if (p.cross >= 0) {
        drawMark(cr, p.lit, clamp01(p.cross * 2), [[37, 37], [63, 63]], false);
        drawMark(cr, p.lit, clamp01(p.cross * 2 - 1), [[63, 37], [37, 63]], false);
    }

    cr.restore();
}

// Circle + polyline drawn progressively, like a pen stroke.
function drawMark(cr, color, t, pts, withCircle = true) {
    if (t <= 0)
        return;
    const e = easeOutCubic(t);
    if (withCircle) {
        cr.setLineWidth(4.5);
        setRGBA(cr, color, 1);
        cr.newPath();
        cr.arc(50, 50, 38, deg(-90), deg(-90 + 360 * clamp01(e * 1.6)));
        cr.stroke();
    }

    const segs = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
        const len = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        segs.push(len);
        total += len;
    }
    let remaining = total * clamp01(withCircle ? (e - 0.25) / 0.75 : e);
    if (remaining <= 0)
        return;

    cr.setLineWidth(6);
    setRGBA(cr, color, 1);
    cr.newPath();
    cr.moveTo(...pts[0]);
    for (let i = 1; i < pts.length && remaining > 0; i++) {
        const f = Math.min(1, remaining / segs[i - 1]);
        const [x0, y0] = pts[i - 1];
        const [x1, y1] = pts[i];
        cr.lineTo(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f);
        remaining -= segs[i - 1];
    }
    cr.stroke();
}

export function mix(a, b, t) {
    return [0, 1, 2, 3].map(i => (a[i] ?? 1) + ((b[i] ?? 1) - (a[i] ?? 1)) * t);
}

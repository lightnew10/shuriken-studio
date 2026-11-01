"""
Content checks on images bound for Roblox. Roblox moderation removes any image with a QR code in it
("Directing Users Off-Platform"), and the removal counts against the uploader's account, so a decorative
QR code on a vending machine's pay panel is not harmless detail. This finds real ones before an upload does.

A QR code is recognised by its three finder patterns: concentric squares that read dark-light-dark-light-
dark in the ratio 1:1:3:1:1 along any line through their centre, standing at three corners of a square.

What it does NOT catch: a painted lookalike whose corner marks are not in that ratio (a dot in a box), or a
code baked so small that its modules are under about 2 px. Moderation removes those too (it does not check
that a code scans), so the rule in the copilot's instructions is the real protection; this is a second net.
"""

import numpy as np


def _gray(px):
    """(h, w) brightness in 0-1 from an (h, w, 3|4) float array, at most 1024 px on a side."""
    a = np.asarray(px, dtype=np.float32)
    g = a[..., :3].mean(-1) if a.ndim == 3 else a
    while max(g.shape) > 1024:
        h, w = (g.shape[0] // 2) * 2, (g.shape[1] // 2) * 2
        g = g[:h, :w].reshape(h // 2, 2, w // 2, 2).mean((1, 3))
    return g


def _runs(line):
    """Run-length encoding of a boolean line: (starts, lengths, values)."""
    change = np.flatnonzero(line[1:] != line[:-1]) + 1
    starts = np.concatenate(([0], change))
    lengths = np.diff(np.concatenate((starts, [len(line)])))
    return starts, lengths, line[starts]


def _finder_hits(line):
    """Centres and module sizes of 1:1:3:1:1 dark-light-dark-light-dark stretches on one line."""
    starts, lengths, values = _runs(line)
    n = len(lengths)
    if n < 5:
        return []
    L = np.stack([lengths[i:n - 4 + i] for i in range(5)], axis=1).astype(np.float32)
    module = L.sum(1) / 7.0
    tol = module * 0.5
    ok = values[: n - 4] & (module >= 1.0)
    for i, want in enumerate((1, 1, 3, 1, 1)):
        ok &= np.abs(L[:, i] - want * module) <= tol * (1.5 if want == 3 else 1.0)
    idx = np.flatnonzero(ok)
    return [(float(starts[i + 2] + lengths[i + 2] / 2.0), float(module[i])) for i in idx]


def _box_mean(g, r):
    """Mean over a (2r+1) square around each pixel (edges clamped), by an integral image."""
    p = np.pad(g, r, mode="edge").astype(np.float64)
    c = np.pad(p.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    k = 2 * r + 1
    return ((c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]) / (k * k)).astype(np.float32)


def _walk(dark, x, y, dx, dy):
    """Run lengths dark-light-dark-light-dark through (x, y) along (dx, dy), or None when the line leaves
    the image or (x, y) isn't dark."""
    h, w = dark.shape
    if not dark[y, x]:
        return None
    out = []
    for sign in (1, -1):
        cx, cy, want, runs, n = x, y, True, [], 0
        while len(runs) < 3:
            cx += sign * dx
            cy += sign * dy
            if not (0 <= cx < w and 0 <= cy < h):
                return None
            if dark[cy, cx] == want:
                n += 1
            else:
                runs.append(n)
                n, want = 1, not want
            if n > 400:
                return None
        out.append(runs)
    a, b = out
    return [b[2], b[1], a[0] + b[0] + 1, a[1], a[2]]


def _is_finder(dark, x, y):
    """Whether the dark pixel at (x, y) sits in a finder pattern: 1:1:3:1:1 down the column and along both
    diagonals too (any line through the centre of concentric squares reads the same)."""
    for dx, dy in ((0, 1), (1, 1), (1, -1)):
        r = _walk(dark, x, y, dx, dy)
        if r is None:
            return False
        m = sum(r) / 7.0
        if m < 0.7 or any(abs(v - k * m) > (0.75 if k == 1 else 1.3) * m * 0.75 for v, k in zip(r, (1, 1, 3, 1, 1))):
            return False
    return True


def _find(dark, w, h):
    cands = []
    for y in range(h):
        for x, m in _finder_hits(dark[y]):
            xi = int(min(w - 1, max(0, round(x))))
            if _is_finder(dark, xi, y):
                cands.append((x, float(y), m))
    if len(cands) < 6:
        return []
    # One point per finder pattern.
    centres = []
    for x, y, m in cands:
        for c in centres:
            if abs(c[0] / c[3] - x) <= 3.5 * m and abs(c[1] / c[3] - y) <= 3.5 * m:
                c[0] += x
                c[1] += y
                c[2] += m
                c[3] += 1
                break
        else:
            centres.append([x, y, m, 1])
    # A real finder pattern is read on several neighbouring rows; a chance hit in noise on one.
    pts = [(c[0] / c[3], c[1] / c[3], c[2] / c[3]) for c in centres if c[3] >= 2][:60]
    found = []
    for i in range(len(pts)):
        for j in range(len(pts)):
            for k in range(j + 1, len(pts)):
                if i in (j, k):
                    continue
                a, b, c = pts[i], pts[j], pts[k]  # a is the corner of the right angle
                ms = (a[2], b[2], c[2])
                if max(ms) > 1.35 * min(ms):
                    continue
                ab, ac = np.hypot(b[0] - a[0], b[1] - a[1]), np.hypot(c[0] - a[0], c[1] - a[1])
                bc = np.hypot(c[0] - b[0], c[1] - b[1])
                # Finder centres of the smallest code are 14 modules apart, of the largest 170.
                if not 11 * min(ms) <= min(ab, ac) <= 180 * max(ms) or abs(ab - ac) > 0.12 * max(ab, ac) or abs(bc - np.sqrt(2) * (ab + ac) / 2) > 0.12 * bc:
                    continue
                cx, cy = (b[0] + c[0]) / 2.0, (b[1] + c[1]) / 2.0
                if not any(abs(f["x"] * w - cx) < ab * 0.5 and abs(f["y"] * h - cy) < ab * 0.5 for f in found):
                    found.append({"x": round(cx / w, 3), "y": round(cy / h, 3), "size": round(float(ab + 7 * np.mean(ms)) / max(w, h), 3)})
    return found


def qr_codes(px):
    """Where an image holds a QR code: [{"x", "y", "size"}] in 0-1 of the image (the centre of the three
    finder patterns and the code's rough size). Empty when it finds none. Dark on light or light on dark
    (a glow mask), at any rotation. See the top of the file for what it misses."""
    g = _gray(px)
    h, w = g.shape
    if h < 21 or w < 21:
        return []
    lo, hi = np.percentile(g, 0.5), np.percentile(g, 99.5)
    if hi - lo < 0.12:
        return []
    found = []
    # Against the whole image's middle value, and against each pixel's surroundings (a code on a shaded or busy texture).
    local = _box_mean(g, max(8, min(h, w) // 12))
    for dark in (g < (lo + hi) / 2.0, g < local - 0.04 * (hi - lo)):
        for mask in (dark, ~dark):
            for f in _find(mask, w, h):
                if not any(abs(f["x"] - o["x"]) < 0.05 and abs(f["y"] - o["y"]) < 0.05 for o in found):
                    found.append(f)
    return found


def image_pixels(img):
    """A Blender image as an (h, w, 4) array, or None when it has no pixels."""
    w, h = img.size
    if not w or not h:
        return None
    px = np.empty(w * h * 4, dtype=np.float32)
    try:
        img.pixels.foreach_get(px)
    except Exception:  # noqa: BLE001
        return None
    return px.reshape(h, w, 4)


def scan_image(img):
    """What Roblox would remove an image for: [text]. Today: QR codes."""
    px = image_pixels(img)
    if px is None:
        return []
    hits = qr_codes(px)
    return ["a QR code (%s)" % ", ".join("at %d%%, %d%% of the image" % (round(f["x"] * 100), round((1 - f["y"]) * 100)) for f in hits[:3])] if hits else []

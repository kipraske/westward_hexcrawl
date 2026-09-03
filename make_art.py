#!/usr/bin/env python3
"""
make_art.py — draw the 15 biome tiles as SVG line art.

    python3 make_art.py        # writes art/*.svg

Hand-drawn hex-map style: ink strokes over a colour wash, the way someone
sketching their own map would do it. Generated rather than hand-authored so a
motif can be changed in one place instead of fifteen, and so re-running gives
byte-identical output (each biome seeds its own RNG) — a regenerate shouldn't
churn the diff.

Tiles are 200x231, the √3:2 ratio of a pointy-top hex, and get clipped to the
hex by CSS. Motifs run to the edges on purpose; the corners are cut off.
"""

import math
import os
import random

W, H = 200, 231
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "art")


# ── motif helpers ───────────────────────────────────────────────────────
# Each returns SVG fragments. Positions come from a jittered grid rather than
# pure random placement: pure random clumps and leaves holes, which reads as
# noise instead of terrain.
def grid(rng, cols, rows, jitter=0.42, margin=0.10):
    step_x, step_y = W / cols, H / rows
    for row in range(rows):
        for col in range(cols):
            # offset alternate rows so the lattice doesn't show
            off = step_x / 2 if row % 2 else 0
            x = col * step_x + step_x / 2 + off + rng.uniform(-1, 1) * step_x * jitter
            y = row * step_y + step_y / 2 + rng.uniform(-1, 1) * step_y * jitter
            if -W * margin < x < W * (1 + margin) and -H * margin < y < H * (1 + margin):
                yield x, y


def pine(rng, x, y, s):
    """Conifer: two stacked triangles and a trunk."""
    w = s * 0.62
    return [
        f'<path d="M{x:.1f} {y-s:.1f} L{x-w*0.72:.1f} {y-s*0.34:.1f} L{x+w*0.72:.1f} {y-s*0.34:.1f} Z"/>',
        f'<path d="M{x:.1f} {y-s*0.66:.1f} L{x-w:.1f} {y:.1f} L{x+w:.1f} {y:.1f} Z"/>',
        f'<path d="M{x:.1f} {y:.1f} L{x:.1f} {y+s*0.22:.1f}"/>',
    ]


def broadleaf(rng, x, y, s):
    """Round canopy on a short trunk."""
    r = s * 0.55
    return [
        f'<path d="M{x-r:.1f} {y-r*0.6:.1f} q{r*0.15:.1f} {-r*1.25:.1f} {r:.1f} {-r*1.2:.1f}'
        f' q{r*0.9:.1f} {r*0.05:.1f} {r:.1f} {r*1.2:.1f}'
        f' q{-r*0.5:.1f} {r*0.75:.1f} {-r*2:.1f} 0 Z"/>',
        f'<path d="M{x:.1f} {y-r*0.5:.1f} L{x:.1f} {y+s*0.3:.1f}"/>',
    ]


def dead_tree(rng, x, y, s):
    """Bare crooked trunk with a few branches."""
    lean = rng.uniform(-0.22, 0.22)
    top = y - s
    out = [f'<path d="M{x:.1f} {y+s*0.15:.1f} Q{x+s*lean:.1f} {y-s*0.4:.1f} {x+s*lean*1.7:.1f} {top:.1f}"/>']
    for i in range(3):
        t = 0.3 + i * 0.24
        bx = x + s * lean * t * 1.7
        by = y + s * 0.15 - (s * 1.15) * t
        d = s * rng.uniform(0.24, 0.38) * (1 if i % 2 else -1)
        out.append(f'<path d="M{bx:.1f} {by:.1f} q{d*0.6:.1f} {-s*0.12:.1f} {d:.1f} {-s*0.26:.1f}"/>')
    return out


def peak(rng, x, y, s):
    """Mountain: asymmetric triangle, one interior ridge, a snow zigzag.

    CENTRE-anchored, not base-anchored. The first version put the apex at
    y - s, so a peak landing near the top of the tile had its summit sliced
    off by the edge while the middle of the tile went bare — 37px of ink ended
    up above y=0. Spreading each peak either side of its grid point keeps the
    distribution even and the summits inside the frame.
    """
    w = s * 0.86
    lean = rng.uniform(-0.14, 0.14) * s      # asymmetry, so they aren't clones
    apex_x, apex_y = x + lean, y - s * 0.55
    base_y = y + s * 0.45
    out = [
        f'<path d="M{apex_x:.1f} {apex_y:.1f} L{x-w:.1f} {base_y:.1f}'
        f' L{x+w:.1f} {base_y:.1f} Z"/>',
        # interior ridge, falling away from the summit
        f'<path d="M{apex_x:.1f} {apex_y:.1f} L{apex_x-w*0.24:.1f} {apex_y+s*0.44:.1f}'
        f' L{apex_x+w*0.08:.1f} {apex_y+s*0.72:.1f}"/>',
    ]
    if s > 30:
        # snow line, kept inside the silhouette: at 32% of the way down the
        # face the triangle is only 32% as wide, so the zigzag is scaled to fit
        t = 0.32
        sy = apex_y + (base_y - apex_y) * t
        half = w * t * 0.86
        out.append(
            f'<path d="M{apex_x-half:.1f} {sy:.1f} l{half*0.5:.1f} {s*0.07:.1f}'
            f' l{half*0.55:.1f} {-s*0.08:.1f} l{half*0.6:.1f} {s*0.09:.1f}'
            f' l{half*0.45:.1f} {-s*0.05:.1f}"/>')
    return out


def ridge(rng, x, y, s):
    """A distant range: open polyline, no baseline, so it reads as far off."""
    pts, cx = [], x - s * 1.4
    cy = y + s * 0.35
    out = [f'M{cx:.1f} {cy:.1f}']
    for i in range(rng.randint(2, 3)):
        cx += s * rng.uniform(0.5, 0.8)
        out.append(f'L{cx:.1f} {y - s * rng.uniform(0.3, 0.6):.1f}')
        cx += s * rng.uniform(0.5, 0.8)
        out.append(f'L{cx:.1f} {cy:.1f}')
    return [f'<path d="{" ".join(out)}"/>']


def tuft(rng, x, y, s):
    """Grass: three splayed blades."""
    out = []
    for k, lean in enumerate((-0.42, 0.0, 0.42)):
        h = s * rng.uniform(0.7, 1.05)
        out.append(f'<path d="M{x:.1f} {y:.1f} q{lean*s*0.5:.1f} {-h*0.6:.1f} {lean*s:.1f} {-h:.1f}"/>')
    return out


def reed(rng, x, y, s):
    """Marsh reed: a stem with a seed head."""
    lean = rng.uniform(-0.2, 0.2)
    return [
        f'<path d="M{x:.1f} {y:.1f} q{lean*s*0.4:.1f} {-s*0.55:.1f} {lean*s:.1f} {-s:.1f}"/>',
        f'<path d="M{x+lean*s:.1f} {y-s:.1f} l0 {s*0.26:.1f}" stroke-width="3.4"/>',
    ]


def ripple(rng, x, y, s):
    """Open water: a flat tilde."""
    return [f'<path d="M{x-s:.1f} {y:.1f} q{s*0.5:.1f} {-s*0.32:.1f} {s:.1f} 0'
            f' q{s*0.5:.1f} {s*0.32:.1f} {s:.1f} 0"/>']


def dune(rng, x, y, s):
    """Desert: a long shallow crest."""
    return [f'<path d="M{x-s*1.5:.1f} {y:.1f} q{s*0.75:.1f} {-s*0.5:.1f} {s*1.5:.1f} {-s*0.06:.1f}'
            f' q{s*0.8:.1f} {s*0.16:.1f} {s*1.4:.1f} {s*0.3:.1f}"/>']


def cactus(rng, x, y, s):
    return [f'<path d="M{x:.1f} {y:.1f} L{x:.1f} {y-s:.1f}"/>',
            f'<path d="M{x:.1f} {y-s*0.5:.1f} q{-s*0.42:.1f} 0 {-s*0.42:.1f} {-s*0.34:.1f}"/>',
            f'<path d="M{x:.1f} {y-s*0.68:.1f} q{s*0.38:.1f} 0 {s*0.38:.1f} {-s*0.3:.1f}"/>']


def crack(rng, x, y, s):
    pts, cx, cy = [], x - s, y
    for _ in range(4):
        cx += s * rng.uniform(0.35, 0.62)
        cy += s * rng.uniform(-0.28, 0.28)
        pts.append(f"L{cx:.1f} {cy:.1f}")
    return [f'<path d="M{x-s:.1f} {y:.1f} {" ".join(pts)}"/>']


def shard(rng, x, y, s):
    """Ice: an angular splinter."""
    return [f'<path d="M{x:.1f} {y-s:.1f} L{x+s*0.4:.1f} {y:.1f} L{x:.1f} {y+s*0.28:.1f}'
            f' L{x-s*0.4:.1f} {y:.1f} Z"/>']


def sparkle(rng, x, y, s):
    return [f'<path d="M{x:.1f} {y-s:.1f} Q{x:.1f} {y:.1f} {x+s:.1f} {y:.1f}'
            f' Q{x:.1f} {y:.1f} {x:.1f} {y+s:.1f}'
            f' Q{x:.1f} {y:.1f} {x-s:.1f} {y:.1f}'
            f' Q{x:.1f} {y:.1f} {x:.1f} {y-s:.1f} Z" class="fill"/>']


def palm(rng, x, y, s):
    out = [f'<path d="M{x:.1f} {y:.1f} q{s*0.18:.1f} {-s*0.55:.1f} {s*0.1:.1f} {-s:.1f}"/>']
    for a in (-1.0, -0.55, 0.55, 1.0):
        out.append(f'<path d="M{x+s*0.1:.1f} {y-s:.1f} q{a*s*0.45:.1f} {-s*0.22:.1f} {a*s*0.8:.1f} {s*0.12:.1f}"/>')
    return out


# ── the fifteen biomes ──────────────────────────────────────────────────
# stops: the colour wash, unchanged from the gradients these replace.
# ink:   stroke colour. layers: (motif, cols, rows, size-range, opacity, width)
BIOMES = {
    "forest": dict(stops=("#4c7a3f", "#33592d", "#1f3a20"), ink="#162a15",
                   layers=[(pine, 4, 6, (26, 34), .55, 2.2), (broadleaf, 3, 4, (16, 22), .38, 2.0)]),
    "enchanted-forest": dict(stops=("#4fa08a", "#3a7a72", "#37525f"), ink="#123038",
                             layers=[(pine, 4, 5, (24, 32), .45, 2.2), (sparkle, 4, 5, (5, 9), .6, 1.4)]),
    "haunted-forest": dict(stops=("#5a6660", "#3b4744", "#232c2b"), ink="#151b1a",
                           layers=[(dead_tree, 4, 5, (30, 42), .6, 2.0)]),
    "jungle": dict(stops=("#3f8f4a", "#256b36", "#144424"), ink="#0d2a17",
                   layers=[(palm, 3, 4, (30, 40), .5, 2.2), (broadleaf, 4, 5, (18, 26), .42, 2.0)]),
    # Two layers: a faint distant range behind, solid peaks in front. Three
    # big peaks left the tile mostly empty; more and smaller fills it and
    # reads as a mountain region rather than three loose triangles.
    "mountains": dict(stops=("#9aa3ab", "#6b7580", "#454d57"), ink="#2b323a",
                      layers=[(ridge, 3, 5, (20, 30), .30, 2.0),
                              (peak, 4, 6, (26, 38), .58, 2.4)]),
    "cavern": dict(stops=("#4a4740", "#302e2a", "#1a1917"), ink="#0d0c0b",
                   layers=[(shard, 4, 5, (14, 24), .5, 2.0), (crack, 3, 4, (22, 34), .4, 1.8)]),
    "desert": dict(stops=("#d9bb7c", "#c09a58", "#96733c"), ink="#7a5a2c",
                   layers=[(dune, 2, 5, (26, 38), .5, 2.2), (cactus, 2, 3, (20, 28), .45, 2.2)]),
    "shadowy-desert": dict(stops=("#8a7f8f", "#645a70", "#413a4d"), ink="#2e2739",
                           layers=[(dune, 2, 5, (26, 38), .5, 2.2)]),
    "flame-scorched-desert": dict(stops=("#d98a4a", "#b4552c", "#7d2f1c"), ink="#5e1f11",
                                  layers=[(dune, 2, 4, (26, 38), .45, 2.2), (crack, 3, 4, (20, 32), .5, 1.8)]),
    "plains": dict(stops=("#9c8f4e", "#7d7a3c", "#5d5f2c"), ink="#4a4a1f",
                   layers=[(tuft, 5, 7, (14, 20), .5, 1.9)]),
    "temperate-grasslands": dict(stops=("#93a24f", "#6f8b3d", "#54702f"), ink="#3d5220",
                                 layers=[(tuft, 6, 8, (14, 20), .5, 1.9)]),
    "tropical-grassland": dict(stops=("#b0a63f", "#7f9433", "#5c7328"), ink="#465420",
                               layers=[(tuft, 5, 7, (14, 20), .45, 1.9), (broadleaf, 2, 3, (20, 26), .4, 2.0)]),
    "frozen-lands": dict(stops=("#cfe0e8", "#9dbccd", "#6d8ea6"), ink="#4a6d84",
                         layers=[(shard, 4, 5, (16, 26), .45, 2.0), (dune, 2, 4, (26, 36), .35, 2.0)]),
    "swamp": dict(stops=("#5d6b3e", "#40522f", "#2b3a26"), ink="#1d2a1a",
                  layers=[(reed, 5, 6, (22, 32), .5, 2.0), (ripple, 3, 5, (14, 20), .4, 1.8)]),
    "swamps": dict(stops=("#4e5c37", "#354528", "#222f1f"), ink="#151f14",
                   layers=[(reed, 5, 6, (22, 32), .5, 2.0), (ripple, 3, 5, (14, 20), .4, 1.8)]),
}


def build(name, spec):
    rng = random.Random(name)          # seeded by name => stable output
    a, b, c = spec["stops"]
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" '
        f'width="{W}" height="{H}" preserveAspectRatio="xMidYMid slice">',
        '<defs><linearGradient id="g" x1="0" y1="0" x2=".55" y2="1">'
        f'<stop offset="0" stop-color="{a}"/><stop offset=".55" stop-color="{b}"/>'
        f'<stop offset="1" stop-color="{c}"/></linearGradient></defs>',
        f'<rect width="{W}" height="{H}" fill="url(#g)"/>',
    ]
    for motif, cols, rows, (lo, hi), opacity, width in spec["layers"]:
        parts.append(
            f'<g fill="none" stroke="{spec["ink"]}" stroke-width="{width}" '
            f'stroke-linecap="round" stroke-linejoin="round" opacity="{opacity}">')
        for x, y in grid(rng, cols, rows):
            parts += motif(rng, x, y, rng.uniform(lo, hi))
        parts.append("</g>")
    # `.fill` lets a motif opt into being solid (sparkles) inside a stroked group
    parts.append(f'<style>.fill{{fill:{spec["ink"]};stroke:none}}</style>')
    parts.append("</svg>")
    return "\n".join(parts)


def main():
    os.makedirs(OUT, exist_ok=True)
    total = 0
    for name, spec in BIOMES.items():
        svg = build(name, spec)
        path = os.path.join(OUT, f"{name}.svg")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(svg)
        total += len(svg)
        print(f"  {name:24} {len(svg):>6,} bytes")
    print(f"\n{len(BIOMES)} tiles, {total:,} bytes total ({total/1024:.1f} KB)")


if __name__ == "__main__":
    main()

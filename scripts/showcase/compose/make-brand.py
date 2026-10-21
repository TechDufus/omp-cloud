#!/usr/bin/env python3
"""Writes the omp-cloud brand SVGs into docs/assets/brand/.

    python3 -m venv /tmp/venv && /tmp/venv/bin/pip install fonttools
    /tmp/venv/bin/python scripts/showcase/compose/make-brand.py

Outputs logo-mark.svg (512x512), logo-dark.svg and logo-light.svg (horizontal lockups). The wordmark is
Adwaita Sans (SIL OFL, an Inter derivative, the dashboard's sans on Linux) converted to outlines, so the
SVGs need no installed font. The committed SVGs are the source of truth; re-run only to change the design.
"""

from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

FONT = "/usr/share/fonts/Adwaita/AdwaitaSans-Regular.ttf"
OUT = Path(__file__).resolve().parents[3] / "docs" / "assets" / "brand"

# The omp stats accent (src/dashboard/client/kit/styles.css): cyan to pink, darker stops for light grounds.
THEMES = {
    "dark": {"a": "#5ad8e6", "m": "#a07bf2", "b": "#ed4abf", "ink": "#ededef"},
    "light": {"a": "#1fa9bb", "m": "#8f5fe0", "b": "#d42ea3", "ink": "#151518"},
}

# The cloud: three lobes over a rounded base, with a prompt chevron and a block cursor knocked out
# (the cursor echoes omp's blocky pi). Coordinates are in a 512 box and optically centered.
CLOUD = """\
<circle cx="170" cy="276" r="78"/>
<circle cx="286" cy="234" r="112"/>
<circle cx="388" cy="296" r="66"/>
<rect x="58" y="286" width="396" height="104" rx="52"/>"""
KNOCK = """\
<path d="M196 250 L252 306 L196 362" fill="none" stroke="#000" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/>
<rect x="284" y="318" width="46" height="46" rx="9" fill="#000"/>"""


def mark_defs(uid: str, t: dict[str, str]) -> str:
    return f"""<linearGradient id="{uid}-g" x1="56" y1="150" x2="456" y2="400" gradientUnits="userSpaceOnUse">
<stop offset="0" stop-color="{t['a']}"/><stop offset=".5" stop-color="{t['m']}"/><stop offset="1" stop-color="{t['b']}"/></linearGradient>
<mask id="{uid}-m" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
<g fill="#fff">
{CLOUD}
</g>
{KNOCK}
</mask>"""


def mark_body(uid: str) -> str:
    return f'<rect width="512" height="512" fill="url(#{uid}-g)" mask="url(#{uid}-m)"/>'


def wordmark(text: str, size: float) -> tuple[list[tuple[str, float, float]], float, float]:
    """Outlines per character: (path d, x offset, width), total advance, cap-height baseline offset."""
    font = TTFont(FONT)
    font = instantiateVariableFont(font, {"wght": 600, "opsz": 32}, inplace=False)
    gs = font.getGlyphSet()
    cmap = font.getBestCmap()
    scale = size / font["head"].unitsPerEm
    x = 0.0
    parts = []
    for ch in text:
        name = cmap[ord(ch)]
        pen = SVGPathPen(gs, ntos=lambda v: f"{v:.2f}".rstrip("0").rstrip("."))
        gs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x, 0)))
        parts.append((pen.getCommands(), x, gs[name].width * scale))
        x += gs[name].width * scale
    return parts, x, font["OS/2"].sxHeight * scale


def lockup(theme: str) -> str:
    t = THEMES[theme]
    uid = f"oc-{theme}"
    h = 128
    size = 76.0
    parts, adv, xh = wordmark("omp-cloud", size)
    split = 3  # "omp" in ink, "-cloud" in the gradient
    mark_scale = h / 440  # the cloud's drawn extent is ~396 x 330; give it breathing room
    gap = 6
    text_x = h + gap
    base = h / 2 + xh / 2  # x-height centered on the mark
    w = text_x + adv + 4
    ink = "".join(f'<path d="{d}"/>' for d, _, _ in parts[:split])
    grad = "".join(f'<path d="{d}"/>' for d, _, _ in parts[split:])
    x_ink = text_x
    x_grad = text_x  # each outline already carries its own x offset
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{w:.0f}" height="{h}" viewBox="0 0 {w:.2f} {h}" role="img" aria-label="omp-cloud">
<title>omp-cloud</title>
<defs>
{mark_defs(uid, t)}
<linearGradient id="{uid}-t" x1="{parts[split][1]:.1f}" y1="0" x2="{adv:.1f}" y2="0" gradientUnits="userSpaceOnUse">
<stop offset="0" stop-color="{t['a']}"/><stop offset=".5" stop-color="{t['m']}"/><stop offset="1" stop-color="{t['b']}"/></linearGradient>
</defs>
<g transform="translate({h / 2 - 256 * mark_scale:.2f} {h / 2 - 256 * mark_scale:.2f}) scale({mark_scale:.5f})">
{mark_body(uid)}
</g>
<g transform="translate({x_ink:.2f} {base:.2f})" fill="{t['ink']}">{ink}</g>
<g transform="translate({x_grad:.2f} {base:.2f})" fill="url(#{uid}-t)">{grad}</g>
</svg>
"""


def mark_svg() -> str:
    t = THEMES["dark"]
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-label="omp-cloud mark">
<title>omp-cloud</title>
<defs>
{mark_defs("oc", t)}
</defs>
{mark_body("oc")}
</svg>
"""


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "logo-mark.svg").write_text(mark_svg())
    for theme in THEMES:
        (OUT / f"logo-{theme}.svg").write_text(lockup(theme))
    print("wrote", sorted(p.name for p in OUT.glob("*.svg")))

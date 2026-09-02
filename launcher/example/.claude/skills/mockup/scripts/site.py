#!/usr/bin/env python3
"""Menu and gallery for a /mockup preview, generated from <scratch>/manifest.json:

  {
    "title": "Checkout button",
    "pages": [
      {"title": "Checkout button", "path": "/checkout-button",
       "variants": [{"label": "A — current", "query": "?v=a"},
                    {"label": "B — sheet", "query": "?v=b"},
                    {"label": "B, light theme", "query": "?v=b&theme=light"}]}
    ],
    "gallery": [
      {"title": "B — tap Pay", "caption": "spinner for a second",
       "files": ["b-tap.gif", "b-tap-strip.png"]}
    ]
  }

  site.py menu <scratch>          -> <scratch>/public/menu/index.html   (served at /)
  site.py gallery <scratch>       -> <scratch>/public/gallery/index.html (served at /gallery/)
  site.py gif <frames_dir> <out> [interval_ms]
                                  -> <out>.gif (looping) + <out>-strip.png (8 frames)
The reviewer only ever opens /: every page, variant and image is one tap from the menu.
"""

from __future__ import annotations

import html
import json
import sys
from pathlib import Path

STYLE = (
    "<style>body{font-family:system-ui;background:#111;color:#eee;margin:24px;max-width:960px}"
    "h1{font-size:20px}h2{font-size:15px;margin:22px 0 8px;color:#aaa}a{color:#7dd3fc}"
    "ul{padding-left:0;list-style:none;margin:0}li{margin:0}"
    "li a{display:block;padding:12px 14px;margin:6px 0;background:#1b1b1f;border:1px solid #333;"
    "border-radius:10px;text-decoration:none;font-size:15px}li a:hover{background:#26262c}"
    ".row{display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start}figure{margin:0;max-width:100%}"
    "img{max-width:375px;width:100%;border:1px solid #444;border-radius:12px;display:block;margin-bottom:8px}"
    "figcaption{margin:8px 0 6px;font-size:14px;max-width:375px}</style>"
)


def load(scratch: Path) -> dict:
    p = scratch / "manifest.json"
    return json.loads(p.read_text()) if p.exists() else {}


def head(title: str) -> str:
    return (
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
        f"<title>{html.escape(title)}</title>{STYLE}"
    )


def menu(scratch: Path) -> None:
    m = load(scratch)
    title = m.get("title") or "Mockup"
    out = [head(title), f"<h1>{html.escape(title)}</h1>"]
    for page in m.get("pages", []):
        out.append(f"<h2>{html.escape(page['title'])}</h2><ul>")
        variants = page.get("variants") or [{"label": page["title"], "query": ""}]
        for v in variants:
            href = html.escape(page["path"] + v.get("query", ""))
            out.append(f'<li><a href="{href}">{html.escape(v["label"])}</a></li>')
        out.append("</ul>")
    if (scratch / "public/gallery/index.html").exists() or m.get("gallery"):
        out.append('<h2>Images</h2><ul><li><a href="/gallery/">Stills and GIFs</a></li></ul>')
    if not m.get("pages"):
        out.append("<p>No pages listed yet — add them to manifest.json.</p>")
    dest = scratch / "public/menu/index.html"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text("".join(out))


def gallery(scratch: Path) -> None:
    m = load(scratch)
    title = m.get("title") or "Mockup"
    cards = "".join(
        f"<figure><figcaption><b>{html.escape(i['title'])}</b>"
        f"{' — ' + html.escape(i['caption']) if i.get('caption') else ''}</figcaption>"
        + "".join(f'<img src="{html.escape(f)}" loading="lazy">' for f in i.get("files", []))
        + "</figure>"
        for i in m.get("gallery", [])
    )
    dest = scratch / "public/gallery/index.html"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(
        head(f"{title} — images") + f'<h1>{html.escape(title)} — images</h1><p><a href="/">← menu</a></p>'
        f'<div class="row">{cards}</div>'
    )


def gif(frames_dir: str, out: str, interval_ms: int = 100) -> None:
    from PIL import Image

    paths = sorted(Path(frames_dir).glob("*.png"))
    if not paths:
        sys.exit(f"no frames in {frames_dir}")
    frames = [Image.open(p).convert("RGB") for p in paths]
    frames[0].save(f"{out}.gif", save_all=True, append_images=frames[1:], duration=interval_ms, loop=0)
    picked = frames[:: max(1, len(frames) // 8)][:8]
    w, h = picked[0].size
    strip = Image.new("RGB", (w * len(picked) + 12 * (len(picked) - 1), h), "#222")
    for i, f in enumerate(picked):
        strip.paste(f, (i * (w + 12), 0))
    strip.save(f"{out}-strip.png")
    print(f"{out}.gif ({len(frames)} frames), {out}-strip.png ({len(picked)} frames)")


if __name__ == "__main__":
    cmd, *args = sys.argv[1:] or ["help"]
    if cmd == "menu" and len(args) == 1:
        menu(Path(args[0]))
    elif cmd == "gallery" and len(args) == 1:
        gallery(Path(args[0]))
    elif cmd == "gif" and 2 <= len(args) <= 3:
        gif(args[0], args[1], int(args[2]) if len(args) == 3 else 100)
    else:
        sys.exit(__doc__)

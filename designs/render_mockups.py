#!/usr/bin/env python3
"""Regenerate the pixel-art reference mockups in designs/*.png.

This is a design-only utility. It requires Pillow and intentionally renders at a
low logical resolution before nearest-neighbour scaling.
"""

from __future__ import annotations

from pathlib import Path
import random
import textwrap

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).parent
SCALE = 3
W, H = 480, 300

C = {
    "space": "#070A18",
    "space2": "#0D1330",
    "panel": "#101A36",
    "panel2": "#17254A",
    "line": "#2B3F70",
    "cyan": "#55E6FF",
    "mint": "#87F5C5",
    "pink": "#FF5CA8",
    "orange": "#FFC857",
    "red": "#FF5B6E",
    "white": "#F4F0FF",
    "muted": "#8391BE",
    "base": "#253866",
    "deep": "#050711",
}

MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
MONO_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
CJK = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
CJK_BOLD = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"

# Latin UI and pixel art are composed at the low logical resolution and scaled
# with nearest-neighbour filtering. CJK glyphs are intentionally deferred and
# rendered directly at output resolution so their strokes remain smooth and
# readable, as required by UI_SPEC.md.
_HIGH_RES_CJK: list[tuple[tuple[int, int], str, int, str, bool, str | None]] = []


def font(size: int, bold: bool = False, cjk: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(CJK_BOLD if cjk and bold else CJK if cjk else MONO_BOLD if bold else MONO, size)


def txt(d: ImageDraw.ImageDraw, xy: tuple[int, int], value: str, size: int = 7,
        fill: str = C["white"], bold: bool = False, cjk: bool = False,
        anchor: str | None = None) -> None:
    if cjk:
        _HIGH_RES_CJK.append((xy, value, size, fill, bold, anchor))
        return
    d.text(xy, value, font=font(size, bold, False), fill=fill, anchor=anchor,
           stroke_width=0)


def panel(d: ImageDraw.ImageDraw, box: tuple[int, int, int, int], fill: str = C["panel"],
          border: str = C["line"], accent: str | None = None) -> None:
    x0, y0, x1, y1 = box
    d.rectangle(box, fill=fill, outline=border, width=1)
    # Pixel-cut corners.
    d.point((x0, y0), fill=C["space"])
    d.point((x1, y0), fill=C["space"])
    d.point((x0, y1), fill=C["space"])
    d.point((x1, y1), fill=C["space"])
    if accent:
        d.rectangle((x0 + 1, y0 + 1, x0 + 3, y1 - 1), fill=accent)


def stars(d: ImageDraw.ImageDraw, seed: int, top: int = 0, bottom: int = H) -> None:
    r = random.Random(seed)
    for _ in range(105):
        x, y = r.randrange(W), r.randrange(top, bottom)
        col = r.choice([C["muted"], C["cyan"], C["white"], C["pink"]])
        d.point((x, y), fill=col)
        if r.random() < 0.08:
            d.point((x + 1, y), fill=col)


def scanlines(d: ImageDraw.ImageDraw, top: int = 0, bottom: int = H) -> None:
    for y in range(top, bottom, 4):
        d.line((0, y, W, y), fill="#080D20")


def progress(d: ImageDraw.ImageDraw, box: tuple[int, int, int, int], value: float,
             color: str = C["mint"], segments: int = 12) -> None:
    x0, y0, x1, y1 = box
    d.rectangle(box, fill=C["deep"], outline=C["line"])
    gap = 1
    inner_w = x1 - x0 - 2
    seg_w = max(1, (inner_w - (segments - 1) * gap) // segments)
    active = round(value * segments)
    for i in range(segments):
        sx = x0 + 1 + i * (seg_w + gap)
        d.rectangle((sx, y0 + 1, sx + seg_w - 1, y1 - 1), fill=color if i < active else C["panel2"])


def keycap(d: ImageDraw.ImageDraw, x: int, y: int, key: str, active: bool = False) -> None:
    fill = C["cyan"] if active else C["deep"]
    fg = C["deep"] if active else C["cyan"]
    d.rectangle((x, y, x + 13, y + 12), fill=fill, outline=C["cyan"])
    txt(d, (x + 7, y + 6), key.upper(), 7, fg, True, anchor="mm")


def alien(d: ImageDraw.ImageDraw, x: int, y: int, hanzi: str, active: bool = False,
          danger: bool = False, small: bool = False, show_hanzi: bool = True) -> None:
    glyph_size = 10 if small else 12
    # Expand the cockpit to the measured character count instead of forcing
    # multi-character words through the old one-glyph window. The generous
    # vertical area keeps ascenders/descenders away from the saucer bezel.
    glyph_count = max(1, len(hanzi))
    screen_w = max(22 if small else 24, glyph_count * glyph_size + 8)
    body_w = max(31 if small else 36, screen_w + 8)
    screen_half = screen_w // 2
    body_half = body_w // 2
    screen_top = y - (13 if small else 15)
    screen_bottom = y + 5
    body_top = screen_bottom + 1
    body_bottom = body_top + 7
    leg_bottom = body_bottom + 5
    color = C["red"] if danger else C["pink"] if active else C["cyan"]
    if active:
        d.rectangle((x - body_half - 4, screen_top - 4,
                     x + body_half + 4, leg_bottom + 4), outline=C["orange"])
        d.line((x - body_half - 4, screen_top - 4,
                x - body_half + 1, screen_top - 4), fill=C["white"])
    # Antennae, enlarged character screen, and saucer body.
    d.line((x - screen_half + 4, screen_top,
            x - screen_half + 1, screen_top - 5), fill=color)
    d.line((x + screen_half - 4, screen_top,
            x + screen_half - 1, screen_top - 5), fill=color)
    d.rectangle((x - screen_half, screen_top, x + screen_half, screen_bottom),
                fill=C["panel2"], outline=color)
    d.rectangle((x - body_half, body_top, x + body_half, body_bottom), fill=color)
    d.rectangle((x - body_half + 4, body_top + 2,
                 x + body_half - 4, body_top + 4), fill=C["panel"])
    d.rectangle((x - body_half + 4, body_bottom + 1,
                 x - body_half + 10, leg_bottom), fill=color)
    d.rectangle((x + body_half - 10, body_bottom + 1,
                 x + body_half - 4, leg_bottom), fill=color)
    if show_hanzi:
        txt(d, (x, (screen_top + screen_bottom) // 2), hanzi, glyph_size,
            C["white"], True, True, "mm")


def base(d: ImageDraw.ImageDraw, y: int = 195) -> None:
    d.rectangle((0, y + 10, W, y + 15), fill=C["base"])
    d.rectangle((0, y + 16, W, y + 18), fill=C["line"])
    for x in range(4, W, 24):
        d.rectangle((x, y + 5, x + 14, y + 10), fill=C["base"])
        d.rectangle((x + 4, y, x + 10, y + 5), fill=C["line"])
    # Player turret.
    d.rectangle((231, y - 2, 249, y + 11), fill=C["orange"])
    d.rectangle((237, y - 11, 243, y - 1), fill=C["white"])
    d.rectangle((224, y + 8, 256, y + 14), fill=C["pink"])


def hud(d: ImageDraw.ImageDraw, streak: str = "12", score: str = "018420",
        mastered: str = "84/300") -> None:
    panel(d, (7, 6, 473, 28), C["panel"])
    txt(d, (15, 17), "HSK 1", 8, C["cyan"], True, anchor="lm")
    txt(d, (72, 17), "SCORE", 6, C["muted"], True, anchor="lm")
    txt(d, (103, 17), score, 8, C["white"], True, anchor="lm")
    txt(d, (194, 17), "STREAK", 6, C["muted"], True, anchor="lm")
    txt(d, (237, 17), "x" + streak, 8, C["orange"], True, anchor="lm")
    txt(d, (303, 17), "MASTERED", 6, C["muted"], True, anchor="lm")
    progress(d, (359, 12, 424, 22), 0.28, C["mint"], 10)
    txt(d, (431, 17), mastered, 6, C["white"], True, anchor="lm")


def new_canvas(seed: int, arena: bool = False) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    _HIGH_RES_CJK.clear()
    im = Image.new("RGB", (W, H), C["space"])
    d = ImageDraw.Draw(im)
    stars(d, seed, 0, 215 if arena else H)
    scanlines(d)
    return im, d


def save(im: Image.Image, name: str, scale: int = SCALE) -> None:
    output = im.resize((im.width * scale, im.height * scale), Image.Resampling.NEAREST)
    high_res = ImageDraw.Draw(output)
    for (x, y), value, size, fill, bold, anchor in _HIGH_RES_CJK:
        high_res.text((x * scale, y * scale), value,
                      font=font(size * scale, bold, True), fill=fill,
                      anchor=anchor, stroke_width=0)
    output.save(OUT / name, optimize=True)
    _HIGH_RES_CJK.clear()


def deck_select() -> None:
    im, d = new_canvas(11)
    txt(d, (W // 2 + 1, 23), "HANZI DEFENDER", 19, C["pink"], True, anchor="mm")
    txt(d, (W // 2, 21), "HANZI DEFENDER", 19, C["white"], True, anchor="mm")
    txt(d, (W // 2, 39), "CHOOSE A SECTOR TO DEFEND", 7, C["cyan"], True, anchor="mm")
    txt(d, (17, 55), "PILOT  LOCAL-01", 6, C["muted"], True)
    txt(d, (464, 55), "AUTO-SAVE  ONLINE", 6, C["mint"], True, anchor="ra")

    values = [(.28, "84 / 300", "CONTINUE"), (.08, "16 / 200", "CONTINUE"),
              (0, "0 / 500", "DEPLOY"), (0, "0 / 1000", "DEPLOY"),
              (0, "0 / 1600", "DEPLOY"), (1, "1798 / 1798", "CLEARED")]
    for i, (v, count, action) in enumerate(values):
        col, row = i % 3, i // 3
        x, y = 16 + col * 151, 65 + row * 88
        border = C["cyan"] if i == 0 else C["mint"] if v == 1 else C["line"]
        panel(d, (x, y, x + 139, y + 77), C["panel"], border, C["pink"] if i == 0 else None)
        txt(d, (x + 10, y + 14), f"HSK {i + 1}", 12, C["white"], True)
        txt(d, (x + 127, y + 15), "◆" if v == 1 else f"{round(v*100):02d}%", 7,
            C["mint"] if v == 1 else C["orange"], True, anchor="ra")
        txt(d, (x + 10, y + 31), "WORDS MASTERED", 5, C["muted"], True)
        txt(d, (x + 129, y + 31), count, 6, C["white"], True, anchor="ra")
        progress(d, (x + 10, y + 38, x + 129, y + 47), v, C["mint"], 12)
        d.rectangle((x + 10, y + 56, x + 129, y + 70), fill=C["cyan"] if i == 0 else C["panel2"],
                    outline=C["cyan"] if i == 0 else C["line"])
        txt(d, (x + 70, y + 63), "▶ " + action, 6, C["deep"] if i == 0 else C["muted"],
            True, anchor="mm")
    panel(d, (16, 251, 464, 287), C["panel"])
    txt(d, (28, 264), "NEXT MISSION", 6, C["muted"], True)
    txt(d, (28, 278), "HSK 1  •  216 WORDS REMAIN  •  LAST PLAYED 2H AGO", 7, C["white"], True)
    keycap(d, 428, 261, "↵", True)
    save(im, "01-deck-select.png")


def battle_pinyin() -> None:
    im, d = new_canvas(21, True)
    hud(d)
    alien(d, 83, 70, "爱")
    alien(d, 211, 91, "朋友")
    alien(d, 360, 58, "水")
    alien(d, 297, 139, "学习", True)
    alien(d, 128, 151, "学校", danger=True)
    d.line((297, 158, 297, 183), fill=C["orange"])
    for y in range(162, 184, 5):
        d.rectangle((294, y, 300, y + 1), fill=C["orange"])
    base(d)
    # Console.
    panel(d, (7, 218, 473, 293), C["panel"], C["line"], C["cyan"])
    panel(d, (15, 226, 112, 285), C["space2"], C["line"])
    txt(d, (24, 238), "LOCKED TARGET", 5, C["muted"], True)
    txt(d, (64, 261), "学习", 24, C["white"], True, True, "mm")
    txt(d, (64, 278), "ALTITUDE 31%", 5, C["red"], True, anchor="mm")
    txt(d, (126, 235), "TYPE PINYIN — NO TONE MARKS", 7, C["cyan"], True)
    d.rectangle((126, 245, 458, 270), fill=C["deep"], outline=C["cyan"], width=1)
    txt(d, (138, 258), "xue xi_", 13, C["white"], True, anchor="lm")
    txt(d, (126, 283), "ENTER  FIRE", 6, C["orange"], True, anchor="lm")
    txt(d, (458, 283), "ESC  PAUSE", 6, C["muted"], True, anchor="ra")
    save(im, "02-battle-pinyin.png")


def battle_meaning() -> None:
    im, d = new_canvas(31, True)
    hud(d, "13", "018668")
    alien(d, 83, 70, "爱")
    alien(d, 211, 91, "朋友")
    alien(d, 360, 58, "水")
    alien(d, 297, 139, "学习", True)
    alien(d, 128, 151, "学校", danger=True)
    d.line((297, 158, 297, 184), fill=C["mint"])
    base(d)
    panel(d, (7, 214, 473, 295), C["panel"], C["line"], C["mint"])
    panel(d, (15, 222, 122, 287), C["space2"], C["line"])
    txt(d, (25, 231), "PINYIN CONFIRMED", 5, C["mint"], True)
    txt(d, (68, 249), "学习", 19, C["white"], True, True, "mm")
    txt(d, (68, 266), "xuéxí  ♪", 8, C["cyan"], True, anchor="mm")
    txt(d, (68, 280), "SELECT MEANING", 5, C["orange"], True, anchor="mm")
    choices = [("A", "to practice"), ("S", "to explain"), ("D", "to study / learn"),
               ("F", "to prepare"), ("H", "a classroom"), ("J", "a question"),
               ("K", "knowledge"), ("L", "a lesson")]
    for i, (key, label) in enumerate(choices):
        col, row = i % 4, i // 4
        x, y = 133 + col * 83, 222 + row * 34
        correct = key == "D"
        d.rectangle((x, y, x + 77, y + 29), fill=C["panel2"],
                    outline=C["mint"] if correct else C["line"])
        d.rectangle((x + 3, y + 5, x + 16, y + 18), fill=C["deep"], outline=C["cyan"])
        txt(d, (x + 10, y + 11), key, 7, C["cyan"], True, anchor="mm")
        wrapped = textwrap.wrap(label, width=13)[:2]
        for j, line in enumerate(wrapped):
            txt(d, (x + 20, y + 7 + j * 8), line, 5, C["white"], True)
    txt(d, (458, 291), "R  REPLAY AUDIO", 5, C["muted"], True, anchor="ra")
    save(im, "03-battle-meaning.png")


def miss_feedback() -> None:
    im, d = new_canvas(44, True)
    hud(d, "00", "018668")
    # Danger beam and landed alien.
    # These background enemies sit behind the later correction panel; omit
    # their deferred glyph layer so it cannot draw over that foreground panel.
    alien(d, 80, 72, "朋友", show_hanzi=False)
    alien(d, 352, 66, "水", show_hanzi=False)
    d.polygon([(183, 108), (219, 108), (240, 199), (161, 199)], fill="#25132B")
    for x in range(166, 238, 9):
        d.line((201, 112, x, 196), fill=C["red"])
    alien(d, 201, 181, "学习", danger=True, show_hanzi=False)
    base(d)
    # Feedback overlay.
    panel(d, (91, 45, 389, 173), C["panel"], C["red"], C["red"])
    txt(d, (240, 61), "// SIGNAL BREACH //", 9, C["red"], True, anchor="mm")
    txt(d, (240, 84), "学习", 26, C["white"], True, True, "mm")
    txt(d, (240, 105), "xuéxí", 10, C["cyan"], True, anchor="mm")
    txt(d, (240, 123), "TO STUDY; TO LEARN", 9, C["orange"], True, anchor="mm")
    d.line((110, 137, 370, 137), fill=C["line"])
    txt(d, (115, 151), "STREAK RESET", 6, C["muted"], True)
    txt(d, (365, 151), "PRIORITY 70  ▶  100", 6, C["red"], True, anchor="ra")
    txt(d, (240, 164), "CORRECTION LOGGED • THIS WORD WILL RETURN", 5, C["mint"], True, anchor="mm")
    panel(d, (7, 218, 473, 293), C["panel"], C["line"])
    txt(d, (240, 240), "AN ALIEN LANDED — NO LIVES LOST", 8, C["white"], True, anchor="mm")
    txt(d, (240, 258), "KEEP DEFENDING. PROGRESS WAS AUTO-SAVED.", 6, C["muted"], True, anchor="mm")
    progress(d, (146, 271, 334, 280), .68, C["red"], 20)
    txt(d, (240, 288), "NEXT TARGET IN 0.8s", 5, C["cyan"], True, anchor="mm")
    save(im, "04-miss-feedback.png")


def summary() -> None:
    im, d = new_canvas(55)
    txt(d, (W // 2, 22), "DEFENSE REPORT", 16, C["white"], True, anchor="mm")
    txt(d, (W // 2, 40), "HSK 1  •  18:42 SESSION", 7, C["cyan"], True, anchor="mm")
    stats = [("SCORE", "+24,860", C["orange"]), ("ACCURACY", "91%", C["mint"]),
             ("BEST STREAK", "x27", C["pink"]), ("WORDS SEEN", "146", C["cyan"])]
    for i, (label, value, color) in enumerate(stats):
        x = 16 + i * 113
        panel(d, (x, 57, x + 103, 103), C["panel"])
        txt(d, (x + 51, 70), label, 5, C["muted"], True, anchor="mm")
        txt(d, (x + 51, 88), value, 12, color, True, anchor="mm")
    panel(d, (16, 114, 305, 245), C["panel"], C["line"], C["mint"])
    txt(d, (29, 130), "SECTOR MASTERY", 8, C["white"], True)
    txt(d, (292, 130), "84 / 300", 7, C["mint"], True, anchor="ra")
    progress(d, (29, 139, 292, 151), .28, C["mint"], 24)
    txt(d, (29, 168), "+12", 14, C["mint"], True)
    txt(d, (68, 168), "NEW WORDS MASTERED", 6, C["muted"], True)
    txt(d, (29, 191), "7", 14, C["red"], True)
    txt(d, (51, 191), "WORDS NEED REINFORCEMENT", 6, C["muted"], True)
    txt(d, (29, 215), "NEXT UP", 5, C["muted"], True)
    for i, h in enumerate(["学习", "时候", "准备", "认识"]):
        d.rectangle((29 + i * 61, 222, 80 + i * 61, 238), fill=C["space2"], outline=C["line"])
        txt(d, (55 + i * 61, 230), h, 8, C["white"], True, True, "mm")
    panel(d, (316, 114, 464, 245), C["panel"])
    txt(d, (329, 130), "SAVE STATUS", 6, C["muted"], True)
    txt(d, (329, 147), "✓ ALL PROGRESS SAVED", 7, C["mint"], True)
    txt(d, (329, 169), "LAST CHECKPOINT", 5, C["muted"], True)
    txt(d, (329, 181), "JUST NOW", 7, C["white"], True)
    d.rectangle((329, 203, 451, 230), fill=C["cyan"], outline=C["white"])
    txt(d, (390, 216), "CONTINUE", 8, C["deep"], True, anchor="mm")
    d.rectangle((16, 258, 232, 285), fill=C["panel2"], outline=C["line"])
    txt(d, (124, 271), "RETURN TO SECTORS", 7, C["muted"], True, anchor="mm")
    d.rectangle((248, 258, 464, 285), fill=C["pink"], outline=C["white"])
    txt(d, (356, 271), "DEFEND AGAIN", 7, C["deep"], True, anchor="mm")
    save(im, "05-session-summary.png")


def settings() -> None:
    im, d = new_canvas(66)
    txt(d, (W // 2, 24), "SYSTEM SETTINGS", 16, C["white"], True, anchor="mm")
    txt(d, (W // 2, 42), "TUNE THE INVASION — ALL ENEMIES SHARE ONE SPEED", 6, C["cyan"], True, anchor="mm")
    panel(d, (54, 59, 426, 249), C["panel"], C["line"], C["cyan"])
    txt(d, (75, 78), "INVASION PRESSURE", 8, C["white"], True)
    txt(d, (75, 97), "ENEMY SPAWN RATE", 6, C["muted"], True)
    txt(d, (402, 97), "1 EVERY 3.0s", 7, C["orange"], True, anchor="ra")
    # Spawn-rate slider.
    d.rectangle((76, 110, 402, 115), fill=C["deep"], outline=C["line"])
    d.rectangle((77, 111, 273, 114), fill=C["orange"])
    d.rectangle((267, 105, 279, 121), fill=C["white"], outline=C["orange"])
    txt(d, (76, 129), "RELAXED  5.0s", 5, C["muted"], True)
    txt(d, (402, 129), "INTENSE  1.5s", 5, C["muted"], True, anchor="ra")
    txt(d, (75, 151), "ENEMY SPEED", 6, C["muted"], True)
    txt(d, (402, 151), "STANDARD  1.00x", 7, C["mint"], True, anchor="ra")
    # Speed slider.
    d.rectangle((76, 164, 402, 169), fill=C["deep"], outline=C["line"])
    d.rectangle((77, 165, 235, 168), fill=C["mint"])
    d.rectangle((229, 159, 241, 175), fill=C["white"], outline=C["mint"])
    txt(d, (76, 183), "SLOW  0.65x", 5, C["muted"], True)
    txt(d, (402, 183), "FAST  1.50x", 5, C["muted"], True, anchor="ra")
    panel(d, (75, 197, 405, 230), C["space2"], C["line"])
    txt(d, (88, 207), "TARGETING RULE", 5, C["muted"], True)
    txt(d, (88, 220), "◆ CLOSEST TO BASE IS ALWAYS HIGHLIGHTED", 6, C["orange"], True)
    txt(d, (392, 207), "FIXED", 5, C["cyan"], True, anchor="ra")
    d.rectangle((54, 262, 231, 288), fill=C["panel2"], outline=C["line"])
    txt(d, (142, 275), "CANCEL", 7, C["muted"], True, anchor="mm")
    d.rectangle((249, 262, 426, 288), fill=C["cyan"], outline=C["white"])
    txt(d, (337, 275), "APPLY SETTINGS", 7, C["deep"], True, anchor="mm")
    save(im, "06-settings.png")


def mobile() -> None:
    _HIGH_RES_CJK.clear()
    w, h = 240, 420
    im = Image.new("RGB", (w, h), C["space"])
    d = ImageDraw.Draw(im)
    r = random.Random(77)
    for _ in range(80):
        d.point((r.randrange(w), r.randrange(255)), fill=r.choice([C["muted"], C["cyan"], C["white"]]))
    for y in range(0, h, 4):
        d.line((0, y, w, y), fill="#080D20")
    panel(d, (5, 6, 235, 29), C["panel"])
    txt(d, (12, 17), "HSK 1", 7, C["cyan"], True, anchor="lm")
    txt(d, (68, 17), "018668", 7, C["white"], True, anchor="lm")
    txt(d, (131, 17), "STREAK x13", 6, C["orange"], True, anchor="lm")
    alien(d, 47, 68, "爱", small=True)
    alien(d, 180, 83, "水", small=True)
    alien(d, 119, 145, "学习", active=True, small=True)
    alien(d, 55, 191, "学校", danger=True, small=True)
    # Compact base.
    d.rectangle((0, 232, w, 241), fill=C["base"])
    d.rectangle((108, 222, 132, 239), fill=C["orange"])
    d.rectangle((117, 213, 123, 224), fill=C["white"])
    panel(d, (5, 250, 235, 414), C["panel"], C["line"], C["mint"])
    txt(d, (15, 261), "学习", 15, C["white"], True, True)
    txt(d, (58, 262), "xuéxí  ♪", 7, C["cyan"], True)
    txt(d, (225, 262), "TAP A MEANING", 5, C["orange"], True, anchor="ra")
    choices = [("A", "to practice"), ("S", "to explain"), ("D", "to study / learn"),
               ("F", "to prepare"), ("H", "a classroom"), ("J", "a question"),
               ("K", "knowledge"), ("L", "a lesson")]
    for i, (key, label) in enumerate(choices):
        col, row = i % 2, i // 2
        x, y = 13 + col * 110, 276 + row * 31
        d.rectangle((x, y, x + 103, y + 25), fill=C["panel2"], outline=C["line"])
        d.rectangle((x + 3, y + 5, x + 16, y + 18), fill=C["deep"], outline=C["cyan"])
        txt(d, (x + 10, y + 11), key, 7, C["cyan"], True, anchor="mm")
        txt(d, (x + 21, y + 12), label, 5, C["white"], True, anchor="lm")
    save(im, "07-mobile-meaning.png", 3)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    deck_select()
    battle_pinyin()
    battle_meaning()
    miss_feedback()
    summary()
    settings()
    mobile()
    print("Wrote 7 mockups to", OUT)

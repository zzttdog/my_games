# -*- coding: utf-8 -*-
"""生成 score_side_C.jpg / score_side_D.jpg —— 与 A/B 提示卡同风格(840x1417 竖版五段式)"""
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 840, 1417
FONT = r'C:\Windows\Fonts\msyh.ttc'

def font(sz):
    return ImageFont.truetype(FONT, sz)

def hexpoly(cx, cy, s):
    pts = []
    for i in range(6):
        a = 3.1415926 / 180 * (60 * i)
        pts.append((cx + s * __import__('math').cos(a), cy + s * __import__('math').sin(a)))
    return pts

def draw_board_sketch(d, cx, cy, s, cols, holes=None, dry=None):
    """画版图轮廓: hex 网格; holes=空穴(灰描边不填), dry=干旱格(深灰)"""
    holes = holes or set()
    dry = dry or set()
    cells = []
    for q, (r0, r1) in cols.items():
        for r in range(r0, r1 + 1):
            cells.append((q, r))
    # 中心对齐偏移
    xs = [q for q, r in cells]; ys = [r for q, r in cells]
    x0 = (min(xs) + max(xs)) / 2; y0 = (min(ys) + max(ys)) / 2
    for (q, r) in cells:
        k = '%d,%d' % (q, r)
        if holes and k in holes:
            continue
        x = cx + (q - x0) * s * 1.55
        y = cy + (r - y0) * s * 1.80 + (q % 2) * s * 0.9
        if dry and k in dry:
            d.polygon(hexpoly(x, y, s * 0.98), fill=(70, 76, 84), outline=(120, 128, 138))
        else:
            d.polygon(hexpoly(x, y, s * 0.98), fill=(222, 205, 178), outline=(150, 128, 96))
    if holes:
        for k in holes:
            q, r = map(int, k.split(','))
            x = cx + (q - x0) * s * 1.55
            y = cy + (r - y0) * s * 1.80 + (q % 2) * s * 0.9
            d.polygon(hexpoly(x, y, s * 0.98), outline=(150, 128, 96), width=2)

def panel(d, y, h, bg):
    d.rounded_rectangle([22, y, W - 22, y + h], radius=18, fill=bg)

def disc(d, cx, cy, r, color, short=None):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color, outline=(30, 30, 30), width=2)
    if short:
        f = font(int(r * 1.1))
        d.text((cx, cy), short, font=f, fill=(255, 255, 255), anchor='mm')

def wheel(d, cx, cy, r, n=6, colors=None, mark=None):
    colors = colors or ['#4a7fb5', '#8d6a45', '#6aa84f', '#d9a13a', '#8a8d94', '#c0483a']
    for i in range(n):
        a0 = -90 + i * 360 / n
        a1 = -90 + (i + 1) * 360 / n
        d.pieslice([cx - r, cy - r, cx + r, cy + r], a0, a1, fill=colors[i], outline=(30, 30, 30))
    d.ellipse([cx - r * 0.42, cy - r * 0.42, cx + r * 0.42, cy + r * 0.42], fill=(240, 232, 214), outline=(30, 30, 30))

def label(d, x, y, t, sz, fill):
    d.text((x, y), t, font=font(sz), fill=fill)

def make_card(fname, side, title_note, panels_cfg, board_cols, holes=None, dry=None, dark=False):
    im = Image.new('RGB', (W, H), (232, 218, 194) if not dark else (40, 58, 56))
    d = ImageDraw.Draw(im)
    # 顶栏
    d.rounded_rectangle([22, 22, W - 22, 130], radius=16, fill=(180, 150, 110) if not dark else (58, 44, 38))
    label(d, 40, 42, side + '面提示卡', 44, (255, 250, 235))
    label(d, 40, 96, title_note, 24, (255, 250, 235))
    # 版图小样
    draw_board_sketch(d, W / 2, 245, 30, board_cols, holes, dry)
    d.text((W / 2, 340), '版图示意', font=font(20), fill=(90, 74, 52) if not dark else (220, 205, 180), anchor='mm')
    # 五段
    y = 400
    ph = (H - 400 - 60 - 30) / len(panels_cfg)
    for (cap, drawfn) in panels_cfg:
        bg = (214, 194, 160) if not dark else (74, 58, 48)
        panel(d, y, ph, bg)
        label(d, 40, y + 18, cap, 26, (70, 54, 38) if not dark else (240, 226, 200))
        drawfn(d, y, ph)
        y += ph + 12
    im.save(fname, quality=92)
    print('saved', fname, im.size)

# ---- C 面 ----
def numrow(d, x0, y, vals, r, color, gap=90):
    cx = x0
    for v in vals:
        disc(d, cx, y, r, color)
        d.text((cx, y + r + 16), str(v), font=font(24), fill=(60, 50, 40), anchor='mm')
        cx += gap

def p_trees_c(d, y, h):
    cy = y + h * 0.62
    disc(d, 130, cy, 34, '#6aa84f')
    d.text((130, cy + 48), '1', font=font(24), fill=(60, 50, 40), anchor='mm')
    disc(d, 250, cy, 42, '#5d9a45')
    d.text((250, cy + 58), '3', font=font(24), fill=(60, 50, 40), anchor='mm')
    disc(d, 385, cy, 50, '#4f8538')
    d.text((385, cy + 68), '7', font=font(24), fill=(60, 50, 40), anchor='mm')
    d.text((540, cy), '树高1/2/3', font=font(22), fill=(90, 74, 52), anchor='lm')
    d.text((540, cy + 34), '同A面规则', font=font(22), fill=(90, 74, 52), anchor='lm')

def p_trees_d(d, y, h):
    cy = y + h * 0.62
    disc(d, 130, cy, 34, '#6aa84f')
    d.text((130, cy + 48), '2', font=font(24), fill=(60, 50, 40), anchor='mm')
    disc(d, 250, cy, 42, '#5d9a45')
    d.text((250, cy + 58), '4', font=font(24), fill=(60, 50, 40), anchor='mm')
    disc(d, 385, cy, 50, '#4f8538')
    d.text((385, cy + 68), '9', font=font(24), fill=(60, 50, 40), anchor='mm')
    d.text((540, cy), '树高1/2/3', font=font(22), fill=(90, 74, 52), anchor='lm')
    d.text((540, cy + 34), '仅在常规格计分', font=font(22), fill=(150, 60, 40), anchor='lm')

def p_mnt(d, y, h):
    cy = y + h * 0.62
    disc(d, 130, cy, 34, '#8a8d94', '1')
    d.text((130, cy + 48), '1', font=font(24), fill=(60, 50, 40), anchor='mm')
    disc(d, 250, cy, 42, '#7a7d84', '3')
    d.text((250, cy + 58), '3', font=font(24), fill=(60, 50, 40), anchor='mm')
    disc(d, 385, cy, 50, '#6a6d74', '7')
    d.text((385, cy + 68), '7', font=font(24), fill=(60, 50, 40), anchor='mm')
    d.text((540, cy), '山高1/2/3', font=font(22), fill=(90, 74, 52), anchor='lm')
    d.text((540, cy + 34), '同A面规则', font=font(22), fill=(90, 74, 52), anchor='lm')

def p_field(d, y, h, pts, note):
    cy = y + h * 0.62
    disc(d, 130, cy, 34, '#d9a13a', '黄')
    d.text((130, cy + 48), str(pts), font=font(28), fill=(60, 50, 40), anchor='mm')
    d.text((260, cy), '≥2个黄色标记连片', font=font(22), fill=(90, 74, 52), anchor='lm')
    d.text((260, cy + 34), note, font=font(22), fill=(150, 60, 40) if '常规' in note else (90, 74, 52), anchor='lm')

def p_build_c(d, y, h):
    cy = y + h * 0.62
    wheel(d, 130, cy, 46)
    d.text((130, cy + 62), '≥4色(含红)', font=font(22), fill=(150, 60, 40), anchor='mm')
    disc(d, 320, cy, 42, '#c0483a', '建')
    d.text((320, cy + 60), '8分', font=font(30), fill=(150, 60, 40), anchor='mm')
    d.text((470, cy), '被≥4种不同颜色包围', font=font(22), fill=(90, 74, 52), anchor='lm')
    d.text((470, cy + 34), '(含红色)才得8分,否则0分', font=font(22), fill=(150, 60, 40), anchor='lm')

def p_build_d(d, y, h):
    cy = y + h * 0.62
    wheel(d, 130, cy, 46)
    d.text((130, cy + 62), '≥3色', font=font(22), fill=(90, 74, 52), anchor='mm')
    disc(d, 320, cy, 42, '#c0483a', '建')
    d.text((320, cy + 60), '5分', font=font(30), fill=(90, 74, 52), anchor='mm')
    d.text((470, cy), '被≥3种颜色包围', font=font(22), fill=(90, 74, 52), anchor='lm')
    d.text((470, cy + 34), '同A面规则', font=font(22), fill=(90, 74, 52), anchor='lm')

def p_water(d, y, h):
    cy = y + h * 0.62
    x = 60
    for i in range(1, 8):
        disc(d, x, cy, 26, '#4a7fb5')
        d.text((x, cy + 40), str(i), font=font(22), fill=(60, 50, 40), anchor='mm')
        x += 72
    d.text((600, cy), '河流1-7', font=font(22), fill=(90, 74, 52), anchor='lm')
    d.text((600, cy + 36), '0·2·5·8·11·15·+4', font=font(22), fill=(90, 74, 52), anchor='lm')

C_COLS = {0: [0, 2], 1: [0, 3], 2: [-1, 2], 3: [-1, 3], 4: [-2, 1], 5: [-2, 1], 6: [-3, -1]}
D_COLS = {0: [0, 1], 1: [0, 2], 2: [-1, 1], 3: [-1, 2], 4: [-2, 0], 5: [-2, 1], 6: [-3, 0], 7: [-3, -2]}
D_DRY = {'1,0', '1,1', '2,0', '2,1', '3,-1', '3,0', '4,-1', '4,0', '5,-2', '5,-1', '5,0', '6,-1', '6,-2'}

make_card(r'E:\vscode_workspace\Trae_projects\Harmonies\Images\aid\score_side_C.jpg', 'C',
          '中央无格·建筑4色8分', [
              ('树木(同A)', p_trees_c), ('山脉(同A)', p_mnt), ('原野(同A)', lambda d, y, h: p_field(d, y, h, 5, '同A面规则')),
              ('建筑·C面', p_build_c), ('水·河流(同A)', p_water),
          ], C_COLS, holes={'3,1'})

make_card(r'E:\vscode_workspace\Trae_projects\Harmonies\Images\aid\score_side_D.jpg', 'D',
          '干旱格·树/原野仅常规格计分', [
              ('树木·D面', p_trees_d), ('山脉(同A)', p_mnt), ('原野·D面', lambda d, y, h: p_field(d, y, h, 6, '≥1格为常规格才6分')),
              ('建筑(同A)', p_build_d), ('水·河流(同A)', p_water),
          ], D_COLS, dry=D_DRY, dark=True)
print('done')

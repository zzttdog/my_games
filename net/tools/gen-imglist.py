# -*- coding: utf-8 -*-
"""
生成 net/client/img-list.js —— 开局预加载用的图片清单。

用法：python net/gen-imglist.py
产出：net/client/img-list.js，包含 harmonies / castle 两组 essential(首屏必需) 与 rest(后台补齐)。

规则：
  * 只列原图扩展名(.png/.jpg/.jpeg)。.webp 是 server.js 按 Accept 协商的副本，
    请求原 URL 即可，绝不能把副本也放进清单（否则会下载两份）。
  * 开发参考素材（Images/ref/gpt/**、官方旧版、*_v2、未被代码引用的 ref 杂图）不列入。
  * 新增卡图后重跑本脚本即可；清单是静态数据，页面运行时零依赖。
"""
import os, json, re

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
IMG_EXT = ('.png', '.jpg', '.jpeg', '.gif', '.webp')
ORIG_EXT = ('.png', '.jpg', '.jpeg', '.gif')


def rel_files(base, prefix, skip_fullsize=False):
    """列出 base 目录下所有原图，返回相对游戏页目录的 POSIX 路径。

    skip_fullsize=True 时，若同目录存在 <原名>-web.<原扩展名>，就跳过全尺寸原图：
    姬路城四张版图同时有 board-base.jpg 与 board-base-web.jpg，页面只引用 -web。
    """
    out = []
    d = os.path.join(ROOT, base)
    if not os.path.isdir(d):
        return out
    for dirpath, _dirs, files in os.walk(d):
        for f in files:
            if not f.lower().endswith(ORIG_EXT):
                continue
            if skip_fullsize and '-web' not in f:
                stem, ext = os.path.splitext(f)
                if os.path.isfile(os.path.join(dirpath, stem + '-web' + ext)):
                    continue
            full = os.path.join(dirpath, f)
            p = os.path.relpath(full, ROOT).replace('\\', '/')
            out.append(p[len(prefix):] if p.startswith(prefix) else p)
    return sorted(out)


def webp_size(game_base, rel):
    """返回实际会传输的字节数（优先 .webp 副本，否则原图）。

    gen-webp.py 的副本命名是「原名 + .webp」，如 精灵牌01.png.webp，
    不是把扩展名替换掉；server.js 也是按这个规则找副本。"""
    orig = os.path.join(ROOT, game_base, rel)
    w = orig + '.webp'
    p = w if os.path.isfile(w) else orig
    return os.path.getsize(p) if os.path.isfile(p) else 0


def fmt(n):
    return '%.1f MB' % (n / 1024.0 / 1024.0)


def h_prio(p):
    """自然和弦的加载顺序：先画得出来的，再画要看的。

    冷缓存回源只有 ~12KB/s，2MB 的清单必然超过超时阈值，所以「先加载谁」
    比「加载多少」更决定体验：棋盘底图排最前，超时放行时版图已经画出来了，
    不会重演线上「黑棋盘」。记分卡已在 rest 里，不参与排序。"""
    if p == 'Images/res/board_A.jpg':
        return (0, p)
    if p == 'Images/res/board_B.jpg':
        return (1, p)
    if p == 'Images/res/board_C.png':
        return (2, p)
    if p == 'Images/res/board_D.png':
        return (3, p)
    if p.startswith('Images/res/'):
        return (4, p)          # 六张地形图，画版图时就要
    if '/保护区/' in p:
        return (5, p)
    if '/动物/' in p:
        return (6, p)          # 市场卡，开局就摊开
    if '/Pulse/' in p:
        return (7, p)
    if '/精灵/' in p:
        return (8, p)
    if '/自然之灵/' in p:
        return (9, p)
    return (10, p)


# ── 游戏目录来自根 games.json，新增游戏只改那一份清单 ─────────────────────
with open(os.path.join(ROOT, 'games.json'), 'r', encoding='utf-8') as f:
    GAMES = json.load(f)['games']

# ── 自然和弦 ──────────────────────────────────────────────────────────────
HB = GAMES['harmonies']['dir']
HP = HB + '/'
all_h = rel_files(os.path.join(HB, 'Images'), HP)
h_ess, h_rest = [], []
for p in all_h:
    if '/ref/gpt/' in p or '/自然之灵/官方旧版/' in p or p.startswith('Images/ref/'):
        # ref 下只保留游戏真正用到的卡背
        if p != 'Images/ref/card_back_dark.jpg':
            continue
    if re.search(r'_v2\.(jpg|png)$', p):
        continue
    if p.startswith('Images/patterns/'):
        continue  # 未被代码引用
    if '/保护区/' in p and p.endswith('_b.jpg'):
        h_rest.append(p)      # 完成面：建成后才显示，后台补齐
    elif p.startswith('Images/aid/'):
        # 记分卡：设置页由 <img src> 直接请求，不受预加载影响；且 4 张共 400KB+，
        # 占 essential 近两成，冷启动时把它排在后面不值当。
        h_rest.append(p)
    else:
        h_ess.append(p)

# ── 姬路城 ────────────────────────────────────────────────────────────────
CB = GAMES['castle']['dir']
CP = CB + '/'
all_c = rel_files(os.path.join(CB, 'assets'), CP, skip_fullsize=True)
c_ess, c_rest = [], []
for p in all_c:
    # 郊外卡数量最多、且开局后陆续才翻出，放后台补齐
    if '/cut/outskirt-a/' in p or '/cut/outskirt-b/' in p:
        c_rest.append(p)
    else:
        c_ess.append(p)

data = {
    'harmonies': {'essential': sorted(h_ess, key=h_prio), 'rest': sorted(h_rest)},
    'castle': {'essential': sorted(c_ess), 'rest': sorted(c_rest)},
}

for k, base in (('harmonies', HB), ('castle', CB)):
    e = sum(webp_size(base, p) for p in data[k]['essential'])
    r = sum(webp_size(base, p) for p in data[k]['rest'])
    print('%s: essential %d 张 / %s ; rest %d 张 / %s' %
          (k, len(data[k]['essential']), fmt(e), len(data[k]['rest']), fmt(r)))

out = os.path.join(ROOT, 'net', 'client', 'img-list.js')
with open(out, 'w', encoding='utf-8') as f:
    f.write('/* 由 net/tools/gen-imglist.py 生成，勿手改。路径相对各自游戏页目录。\n')
    f.write('   essential = 开局前必须加载完；rest = 放行后后台继续分批补齐。 */\n')
    f.write('window.MG_IMG_LIST = ' + json.dumps(data, ensure_ascii=False, indent=1) + ';\n')
print('written:', out, os.path.getsize(out), 'bytes')

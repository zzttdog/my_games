# -*- coding: utf-8 -*-
"""
生成 net/client/img-list.js —— 开局预加载用的图片清单。

用法：python net/gen-imglist.py
产出：net/client/img-list.js，包含 harmonies / castle 两组 essential(首屏必需) 与 rest(后台补齐)。

规则：
  * 清单列实际请求路径：有 <原名>.webp 时列 WebP，否则列原图。
    GitHub Pages 没有服务端 Accept 协商，静态站必须显式请求 WebP；
    页面中的 MGImg 会在 WebP 加载失败时回退原图，避免旧浏览器白图。
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


def orig_rel(rel):
    """把实际请求路径还原成原图路径，方便按旧规则过滤。"""
    return rel[:-5] if rel.lower().endswith('.webp') else rel


def served_rel(game_base, rel):
    """返回页面应请求的路径：有原图同名 .webp 就用 WebP。"""
    full = os.path.join(ROOT, game_base, rel)
    return rel + '.webp' if os.path.isfile(full + '.webp') else rel


def webp_size(game_base, rel):
    """返回清单中该路径的实际字节数（现在 rel 已经是实际请求路径）。"""
    full = os.path.join(ROOT, game_base, rel)
    return os.path.getsize(full) if os.path.isfile(full) else 0


def fmt(n):
    return '%.1f MB' % (n / 1024.0 / 1024.0)


def h_prio(p):
    """自然和弦的加载顺序：先画得出来的，再画要看的。

    冷缓存回源只有 ~12KB/s，2MB 的清单必然超过超时阈值，所以「先加载谁」
    比「加载多少」更决定体验：棋盘底图排最前，超时放行时版图已经画出来了，
    不会重演线上「黑棋盘」。记分卡已在 rest 里，不参与排序。"""
    q = orig_rel(p)
    if q == 'Images/res/board_A.jpg':
        return (0, p)
    if q == 'Images/res/board_B.jpg':
        return (1, p)
    if q == 'Images/res/board_C.png':
        return (2, p)
    if q == 'Images/res/board_D.png':
        return (3, p)
    if q.startswith('Images/res/'):
        return (4, p)          # 六张地形图，画版图时就要
    if '/保护区/' in q:
        return (5, p)
    if '/动物/' in q:
        return (6, p)          # 市场卡，开局就摊开
    if '/Pulse/' in q:
        return (7, p)
    if '/精灵/' in q:
        return (8, p)
    if '/自然之灵/' in q:
        return (9, p)
    return (10, p)


# ── 游戏目录来自根 games.json，新增游戏只改那一份清单 ─────────────────────
with open(os.path.join(ROOT, 'games.json'), 'r', encoding='utf-8') as f:
    GAMES = json.load(f)['games']

# ── 自然和弦 ──────────────────────────────────────────────────────────────
HB = GAMES['harmonies']['dir']
HP = HB + '/'
all_h = [served_rel(HB, p) for p in rel_files(os.path.join(HB, 'Images'), HP)]
h_ess, h_rest = [], []
for p in all_h:
    q = orig_rel(p)
    if '/ref/gpt/' in q or '/自然之灵/官方旧版/' in q or q.startswith('Images/ref/'):
        # ref 下只保留游戏真正用到的卡背
        if q != 'Images/ref/card_back_dark.jpg':
            continue
    if re.search(r'_v2\.(jpg|png)$', q):
        continue
    if q.startswith('Images/patterns/'):
        continue  # 未被代码引用
    if '/保护区/' in q and q.endswith('_b.jpg'):
        h_rest.append(p)      # 完成面：建成后才显示，后台补齐
    elif q.startswith('Images/aid/'):
        # 记分卡：设置页由 <img src> 直接请求，不受预加载影响；且 4 张共 400KB+，
        # 占 essential 近两成，冷启动时把它排在后面不值当。
        h_rest.append(p)
    else:
        h_ess.append(p)

# ── 姬路城 ────────────────────────────────────────────────────────────────
CB = GAMES['castle']['dir']
CP = CB + '/'
all_c = [served_rel(CB, p) for p in rel_files(os.path.join(CB, 'assets'), CP, skip_fullsize=True)]
c_ess, c_rest = [], []
for p in all_c:
    q = orig_rel(p)
    # 郊外卡数量最多、且开局后陆续才翻出，放后台补齐
    if '/cut/outskirt-a/' in q or '/cut/outskirt-b/' in q:
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
HELPER = '''/* MGImg：静态 Pages 优先请求 WebP；加载失败时由页面 onerror / loadImg 回退原图。 */
window.MGImg = window.MGImg || (function () {
  'use strict';
  function webp(src) {
    if (!src || typeof src !== 'string') return src;
    if (/^(?:data:|blob:|https?:)/i.test(src)) return src;
    if (/\\.webp(?:[?#]|$)/i.test(src)) return src;
    return /\\.(?:jpe?g|png)(?:[?#]|$)/i.test(src)
      ? src.replace(/(\\.(?:jpe?g|png))(?=[?#]|$)/i, '$1.webp')
      : src;
  }
  function fallback(el) {
    try {
      var s = (el && (el.currentSrc || el.src)) || '';
      if (!/\\.webp(?:[?#]|$)/i.test(s)) return;
      el.onerror = null;
      el.src = s.replace(/\\.webp(?=[?#]|$)/i, '');
    } catch (e) {}
  }
  return { webp: webp, fallback: fallback };
})();
'''
with open(out, 'w', encoding='utf-8') as f:
    f.write('/* 由 net/tools/gen-imglist.py 生成，勿手改。路径相对各自游戏页目录。\n')
    f.write('   essential = 开局前必须加载完；rest = 放行后后台继续分批补齐。\n')
    f.write('   有 WebP 副本时列 .webp；MGImg 负责加载失败回退原图。 */\n')
    f.write(HELPER)
    f.write('window.MG_IMG_LIST = ' + json.dumps(data, ensure_ascii=False, indent=1) + ';\n')
print('written:', out, os.path.getsize(out), 'bytes')

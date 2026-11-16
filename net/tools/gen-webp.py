"""为图片生成同目录的 <原名>.webp 副本，供 net/server/server.js 做内容协商。

URL / 文件名 / 游戏代码全部不变；不支持 WebP 或纯静态部署时自动回退原图。

两条原则：
1. 只在小 18% 以上时才写入，避免产生无谓文件。
2. 按「实际显示尺寸 × 2（高 DPI）」限制像素，再压到 WebP —— 原图普遍比显示需求
   大 2~4 倍（保护区卡源图 1208×1882，页面上只显示 176px 宽），只调质量收效很有限。

⚠ 例外：Harmonies 的四张棋盘底图（res/board_A|B|C|D）**绝对不能改像素尺寸**。
   底图是贴到 canvas 上的：A/B 面用固定仿射矩阵 `setTransform(0.2330, ...)` 后
   `drawImage(bg, 0, 0)`，C/D 面用 `naturalWidth * s` 计算绘制尺寸 —— 两种写法都
   依赖源图的原始像素数，缩小会让版图和六边形格心错位。这四张只重新压缩。

用法：
    python net/tools/gen-webp.py            # 生成 / 更新全部
    python net/tools/gen-webp.py --dry      # 只统计，不写文件
"""
import io
import os
import sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DRY = '--dry' in sys.argv
Image.MAX_IMAGE_PIXELS = None

EXTS = ('.jpg', '.jpeg', '.png')
MIN_SIZE = 20 * 1024
BOARD_KEEP = ('board_a.jpg', 'board_b.jpg', 'board_c.png', 'board_d.png')


def cap_for(rel):
    """按页面实际显示尺寸给最长边上限（0 = 保持原始像素）。"""
    r = rel.replace('\\', '/').lower()
    name = r.rsplit('/', 1)[-1]
    if '/harmonies/images/res/' in '/' + r:
        if name in BOARD_KEEP:
            return 0, 82           # 画布仿射贴图，必须保持原尺寸；q82 与首次生成一致（135K→99K）
        return 220, 82             # 地形标记，绘制时会被缩到 R*2
    if '/harmonies/images/cards/' in '/' + r:
        return 480, 82             # 市场卡 / 保护区卡 / 精灵卡 / 自然之灵
    if '/harmonies/自然和弦' in '/' + r:
        return 480, 82
    if '/the white castle/assets/cards/' in '/' + r:
        return 480, 82
    if '/the white castle/assets/' in '/' + r:
        return 2000, 84            # 版图用 <img style="width:100%"> 铺满，留足余量
    return 0, 84


made = skipped = failed = 0
before = after = 0
targets = [
    os.path.join(ROOT, 'Harmonies', 'Images'),
    os.path.join(ROOT, 'Harmonies', '自然和弦（含律动扩）'),
    os.path.join(ROOT, 'The White Castle', 'assets'),
]

for base in targets:
    if not os.path.isdir(base):
        continue
    for dirpath, _, files in os.walk(base):
        for name in files:
            if not name.lower().endswith(EXTS):
                continue
            src = os.path.join(dirpath, name)
            dst = src + '.webp'
            size = os.path.getsize(src)
            if size < MIN_SIZE:
                continue
            rel = os.path.relpath(src, ROOT)
            if '/images/ref/' in '/' + rel.replace('\\', '/').lower():
                continue               # 参考图，游戏运行时不会请求
            cap, q = cap_for(rel)
            before += size
            try:
                with Image.open(src) as im:
                    im.load()
                    if im.mode not in ('RGB', 'RGBA'):
                        im = im.convert('RGBA' if 'A' in im.getbands() else 'RGB')
                    w, h = im.size
                    if cap and max(w, h) > cap:
                        k = cap / float(max(w, h))
                        im = im.resize((max(1, int(w * k)), max(1, int(h * k))), Image.LANCZOS)
                    buf = io.BytesIO()
                    im.save(buf, 'WEBP', quality=q, method=4)
                    data = buf.getvalue()
                # 判定门槛分两种：
                #   cap>0 时像素被缩小过，只有明显变小（<82%）才值得写入，否则说明重编码没收益；
                #   cap==0 时像素原样保留（棋盘底图），只要比原图小就是纯赚（board_A 138K→99K）。
                if len(data) < (size if cap == 0 else size * 0.82):
                    if not DRY:
                        with open(dst, 'wb') as f:
                            f.write(data)
                    made += 1
                    after += len(data)
                else:
                    # 重编码没收益（原图本身已压得很好）：删掉可能存在的陈旧副本，
                    # 否则服务端会继续内容协商到一个更旧/更差的 .webp
                    skipped += 1
                    after += size
                    if not DRY and os.path.exists(dst):
                        try:
                            os.remove(dst)
                        except OSError:
                            pass
            except Exception as e:
                failed += 1
                after += size
                print('ERR %s :: %s' % (rel, e), flush=True)
            n = made + skipped + failed
            if n % 60 == 0:
                print('progress %d ...' % n, flush=True)

print('%s made=%d skipped=%d failed=%d' % ('[dry]' if DRY else '', made, skipped, failed))
print('original=%.1f MB  delivered=%.1f MB  saved=%.1f MB (%.0f%%)' % (
    before / 1048576, after / 1048576, (before - after) / 1048576,
    100 * (before - after) / max(1, before)))

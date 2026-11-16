# -*- coding: utf-8 -*-
"""从根目录 games.json 生成 net/client/games.js。

浏览器端不能同步读取 JSON，所以生成一个等价的 window.MG_GAMES；
games.json 仍是唯一手写源，改完它重跑本脚本即可。
用法：python net/tools/gen-games-js.py
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, 'games.json')
OUT = os.path.join(ROOT, 'net', 'client', 'games.js')

with open(SRC, 'r', encoding='utf-8') as f:
    data = json.load(f)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w', encoding='utf-8') as f:
    f.write('/* 由 games.json 生成，勿手改；修改请改 games.json 后重跑 net/tools/gen-games-js.py */\n')
    f.write('window.MG_GAMES = ')
    f.write(json.dumps(data, ensure_ascii=False, indent=2))
    f.write(';\n')

print('written:', OUT, os.path.getsize(OUT), 'bytes')

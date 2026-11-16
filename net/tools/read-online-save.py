#!/usr/bin/env python3
"""读取线上对局存档（房主自动上传到 net/server/saves/）。

用法：
  python net/tools/read-online-save.py --list
  python net/tools/read-online-save.py --game harmonies --room 9999
  python net/tools/read-online-save.py --game harmonies --room 9999 --match mabc --history
  python net/tools/read-online-save.py --file net/server/saves/xxx.json --json

默认输出摘要（轮次、玩家分数、卡/保护区等常见字段），--json 输出完整 JSON。
AI 也可以直接读取 net/server/saves/<game>-<room>-<match>.json。
"""
import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SAVE_DIR = ROOT / "net" / "server" / "saves"


def load(path):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def summary(path, data):
    state = data.get("state") if isinstance(data.get("state"), dict) else data
    out = {
        "file": str(path),
        "game": data.get("game"),
        "mode": data.get("mode"),
        "room": data.get("room"),
        "match": data.get("match"),
        "savedAt": data.get("savedAt") or data.get("at"),
    }
    for k in ("round", "turn", "cur", "over", "roundN", "deckN", "pouchN"):
        if k in state:
            out[k] = state[k]
    players = state.get("players")
    if isinstance(players, list):
        out["players"] = []
        for i, p in enumerate(players):
            if not isinstance(p, dict):
                continue
            row = {"seat": i}
            for k in ("name", "score", "total", "cards", "animals", "spirits", "sanct", "cubes"):
                if k in p:
                    row[k] = p[k]
            out["players"].append(row)
    if isinstance(state.get("cards"), list):
        out["cardsInHand"] = len(state["cards"])
    if isinstance(state.get("market"), list):
        out["market"] = len(state["market"])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="列出已有存档")
    ap.add_argument("--game", default="harmonies")
    ap.add_argument("--room", default=None)
    ap.add_argument("--match", default=None)
    ap.add_argument("--file", default=None)
    ap.add_argument("--history", action="store_true", help="读取 .jsonl 历史")
    ap.add_argument("--json", action="store_true", help="输出完整 JSON")
    args = ap.parse_args()

    if not SAVE_DIR.is_dir():
        print(f"没有存档目录：{SAVE_DIR}")
        return 1
    if args.list:
        for p in sorted(SAVE_DIR.glob("*.json")):
            print(p.name)
        return 0

    if args.file:
        path = Path(args.file)
        if not path.is_absolute():
            path = ROOT / path
        if not path.exists():
            print(f"找不到：{path}")
            return 1
        if args.history:
            print(path.read_text(encoding="utf-8"))
            return 0
        data = load(path)
        print(json.dumps(data if args.json else summary(path, data), ensure_ascii=False, indent=2))
        return 0

    if not args.room:
        print("需要 --room，或用 --file / --list")
        return 1
    if args.match:
        path = SAVE_DIR / f"{args.game}-{args.room}-{args.match}.json"
        if not path.exists():
            print(f"找不到：{path}")
            return 1
    else:
        candidates = sorted(SAVE_DIR.glob(f"{args.game}-{args.room}-*.json"), key=lambda p: p.stat().st_mtime)
        if not candidates:
            print(f"没有找到 {args.game} 房间 {args.room} 的存档")
            return 1
        path = candidates[-1]

    if args.history:
        hp = path.with_suffix(".jsonl")
        print(hp.read_text(encoding="utf-8") if hp.exists() else "没有历史记录")
        return 0
    data = load(path)
    print(json.dumps(data if args.json else summary(path, data), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

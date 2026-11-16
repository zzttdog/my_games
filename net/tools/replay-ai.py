#!/usr/bin/env python3
"""AI 复盘：读取游戏里「导出复盘」产生的 JSON，输出结构化摘要。

用法：
  python net/tools/replay-ai.py --file mygames-replay-harmonies-8888-mabc-....json
  python net/tools/replay-ai.py --file <replay.json> --json
  python net/tools/replay-ai.py --list

复盘包由 net/client/save.js 在联机房主窗口生成：
  · frames = 每个回合开始时的紧凑状态
  · events = 游戏日志（每一条新动作）
  · final  = 终局状态 + scoreBoard 明细
  · log    = 完整游戏日志

脚本只读取导出文件，不连接浏览器，也不依赖服务端。
"""
import argparse
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DIR = ROOT / "net" / "replays"
TERRAIN = ["water", "mountain", "trunk", "tree", "field", "building"]
TYPE_CN = {
    "water": "河流", "mountain": "山岩", "trunk": "树干",
    "tree": "树冠", "field": "田野", "building": "建筑",
}


def load(path):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def state_of(pack):
    final = pack.get("final") or {}
    return final.get("state") or pack.get("current", {}).get("state") or {}


def scores_of(pack):
    final = pack.get("final") or {}
    return final.get("scores") or pack.get("current", {}).get("scores") or []


def board_stats(player):
    board = player.get("board") or {}
    tops = Counter()
    heights = Counter()
    animals = 0
    spirits = 0
    for cell in board.values():
        stack = cell.get("stack") or []
        if stack:
            tops[stack[-1]] += 1
            heights[len(stack)] += 1
        if "cube" in cell:
            animals += 1
        if "spirit" in cell:
            spirits += 1
    cards = player.get("cards") or []
    done_cards = sum(1 for c in cards if c.get("done"))
    sancts = player.get("sancts") or []
    done_s = sum(1 for s in sancts if s.get("done"))
    return {
        "board_cells": len(board),
        "filled_cells": sum(heights.values()),
        "tops": dict(tops),
        "heights": dict(heights),
        "animals": animals,
        "spirits": spirits,
        "cards": len(cards),
        "cards_done": done_cards,
        "sancts": len(sancts),
        "sancts_done": done_s,
        "cubesPlaced": player.get("cubesPlaced", 0),
    }


def player_rows(pack):
    st = state_of(pack)
    scores = scores_of(pack)
    cfg = pack.get("cfg") or {}
    kinds = cfg.get("seatKinds") or []
    names = cfg.get("names") or {}
    rows = []
    for i, p in enumerate(st.get("players") or []):
        kind = kinds[i] if i < len(kinds) else ("ai" if p.get("isAI") else "human")
        sc = scores[i] if i < len(scores) else {}
        rows.append({
            "seat": i,
            "name": names.get(str(i)) or p.get("name") or f"P{i}",
            "kind": kind,
            "is_ai": kind == "ai" or bool(p.get("isAI")),
            "score": sc.get("total") if isinstance(sc, dict) else None,
            "score_detail": sc if isinstance(sc, dict) else {},
            **board_stats(p),
        })
    return rows


def recommendation(pack, rows):
    st = state_of(pack)
    notes = []
    if not rows:
        return ["没有可读的玩家状态。"]
    ai_rows = [r for r in rows if r["is_ai"]]
    human_rows = [r for r in rows if not r["is_ai"]]
    if ai_rows and human_rows:
        best_ai = max((r["score"] or 0) for r in ai_rows)
        best_h = max((r["score"] or 0) for r in human_rows)
        if best_ai < best_h:
            notes.append(f"AI 最高分 {best_ai}，真人最高分 {best_h}；差距 {best_h - best_ai} 分。")
        elif best_ai > best_h:
            notes.append(f"AI 最高分 {best_ai}，真人最高分 {best_h}；AI 领先 {best_ai - best_h} 分。")
    for r in ai_rows:
        if r["sancts"] and r["sancts_done"] < r["sancts"]:
            notes.append(
                f"AI 座位 {r['seat']} 持有 {r['sancts']} 个保护区、完成 {r['sancts_done']} 个；"
                "保护区占用了未完成卡位。"
            )
        if r["cards"] and r["cards_done"] == 0:
            notes.append(f"AI 座位 {r['seat']} 有 {r['cards']} 张动物卡但 0 张完成，卡位可能被死卡堵住。")
        elif r["cards"] and r["cards_done"] / r["cards"] < 0.5:
            notes.append(
                f"AI 座位 {r['seat']} 动物卡完成率 {r['cards_done']}/{r['cards']}，"
                "取卡时没有足够接近完成的图案。"
            )
        tops = r["tops"]
        if not tops:
            notes.append(f"AI 座位 {r['seat']} 终局版图几乎没有地形，终局分主要来自动物/保护区。")
        elif sum(tops.values()) and (tops.get("tree", 0) == 0 and tops.get("mountain", 0) == 0):
            notes.append(f"AI 座位 {r['seat']} 没有树/山高度结构，地形分偏低。")
        if r["sancts_done"] == 0 and r["sancts"] >= 2:
            notes.append(f"AI 座位 {r['seat']} 拿了多个保护区但一个也没建成，建议降低保护区优先级。")
    if st.get("round") and st.get("round") < 8:
        notes.append(f"终局只到第 {st.get('round')} 轮，请确认是否中途导出，而不是完整对局。")
    if not notes:
        notes.append("没有发现明显的结构性问题；建议结合下面的逐条事件看关键回合。")
    return notes


def markdown(pack, rows):
    cfg = pack.get("cfg") or {}
    final = pack.get("final") or {}
    lines = []
    lines.append(f"# 对局复盘 · {pack.get('game')} · 房间 {pack.get('room')}")
    lines.append("")
    lines.append(f"- 比赛：`{pack.get('match')}`")
    lines.append(f"- 导出时间：{pack.get('exportedAt') or pack.get('finishedAt') or '-'}")
    lines.append(f"- 终局：第 {final.get('round') or state_of(pack).get('round')} 轮")
    lines.append(f"- 配置：{cfg.get('total')} 席 / {cfg.get('humans')} 真人 / {cfg.get('difficulty', '-')}")
    lines.append("")
    lines.append("## 最终比分")
    lines.append("")
    lines.append("| 座位 | 玩家 | 类型 | 总分 | 地形 | 动物 | 保护区 | 其他 |")
    lines.append("|---:|---|---|---:|---:|---:|---:|---:|")
    for r in rows:
        d = r["score_detail"] or {}
        other = "/".join(
            f"{k}:{d.get(k, 0)}" for k in ("spirit", "elf") if d.get(k)
        ) or "-"
        lines.append(
            f"| {r['seat']} | {r['name']} | {'AI' if r['is_ai'] else '真人'} | "
            f"{r['score'] if r['score'] is not None else '-'} | "
            f"{d.get('tree', 0)+d.get('mountain', 0)+d.get('field', 0)+d.get('building', 0)+d.get('water', 0)} | "
            f"{d.get('animal', 0)} | {d.get('sanctPts', 0)} | {other} |"
        )
    lines.append("")
    lines.append("## 版图 / 卡牌")
    lines.append("")
    lines.append("| 座位 | 已填格 | 地形顶面 | 动物方块 | 精灵 | 完成动物卡 | 保护区(完成/持有) |")
    lines.append("|---:|---:|---|---:|---:|---:|---:|")
    for r in rows:
        tops = "、".join(f"{TYPE_CN.get(k, k)}:{v}" for k, v in sorted(r["tops"].items())) or "-"
        lines.append(
            f"| {r['seat']} | {r['filled_cells']}/{r['board_cells']} | {tops} | "
            f"{r['animals']} | {r['spirits']} | {r['cards_done']}/{r['cards']} | "
            f"{r['sancts_done']}/{r['sancts']} |"
        )
    lines.append("")
    lines.append("## AI 自评 / 改进点")
    lines.append("")
    for n in recommendation(pack, rows):
        lines.append(f"- {n}")
    lines.append("")
    events = pack.get("events") or []
    if events:
        lines.append("## 关键事件（最后 40 条）")
        lines.append("")
        for e in events[-40:]:
            lines.append(f"- R{e.get('round', '?')} · 座位 {e.get('cur', '?')} · {e.get('text', '')}")
        lines.append("")
    if final.get("state"):
        lines.append("## 终局原始状态")
        lines.append("")
        lines.append("```json")
        lines.append(json.dumps(final["state"], ensure_ascii=False, indent=2)[:12000])
        lines.append("```")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default=None, help="导出的复盘 JSON")
    ap.add_argument("--list", action="store_true", help="列出 net/replays 下的复盘包")
    ap.add_argument("--json", action="store_true", help="输出机器可读摘要")
    args = ap.parse_args()

    if args.list:
        if not DEFAULT_DIR.is_dir():
            print(f"没有复盘目录：{DEFAULT_DIR}（把导出的 JSON 放进去即可）")
            return 0
        for p in sorted(DEFAULT_DIR.glob("*.json")):
            print(p.name)
        return 0

    if not args.file:
        ap.error("需要 --file，或使用 --list")
    path = Path(args.file)
    if not path.is_absolute():
        path = ROOT / path
    if not path.exists():
        ap.error(f"找不到文件：{path}")
    pack = load(path)
    if pack.get("kind") != "mygames.replay":
        ap.error("这不是 my_games 复盘包（kind 应为 mygames.replay）")
    rows = player_rows(pack)
    if args.json:
        print(json.dumps({
            "meta": {k: pack.get(k) for k in ("game", "room", "match", "exportedAt", "finishedAt")},
            "finalRound": (pack.get("final") or {}).get("round"),
            "players": rows,
            "review": recommendation(pack, rows),
        }, ensure_ascii=False, indent=2))
    else:
        print(markdown(pack, rows))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

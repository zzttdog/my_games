# my_games

《自然和弦》（Harmonies）与《姬路城》（The White Castle）的网页版 + 联机大厅。

## 快速开始

```powershell
# 在项目根目录
npm start                 # node net/server/server.js，默认 http://localhost:8080
# 或只做静态预览
python -m http.server 8099 --directory .
```

入口：

- 单机 / 联机选择：`/index.html`
- 联机大厅：`/net/client/play.html?game=harmonies`（castle 同理）
- 手机缩放外壳：`/net/client/phone.html?game=castle`
- 旧地址 `/net/play.html`、`/net/phone.html` 会自动跳转到 `net/client/`，旧链接不会断。

## 目录

```text
my_games/
├── games.json                 # 唯一游戏清单（新增游戏先改这里）
├── index.html                 # 首页卡片，运行时读 games.json
├── Harmonies/
│   ├── index.html             # 薄入口：HTML + 样式/脚本引用
│   ├── css/game.css
│   └── js/
│       ├── data.js            # 卡表 / 版图 / 类型常量
│       ├── game.js            # G、setup、回合开始、建版图
│       ├── rules.js           # 放置、保护区、匹配、计分
│       ├── render.js          # 版图 / 市场 / 手牌 / 玩家卡
│       ├── ui.js              # 点击、取卡、放方块、结束回合
│       ├── ai.js              # AI 调参与决策
│       └── main.js            # 设置界面、缩放、预览、事件绑定
├── The White Castle/          # 姬路城本体（多文件结构）
├── net/
│   ├── server/                # server.js、warmup.js
│   ├── client/                # play.html、phone.html、bridge.js、save.js、preload.js、img-list.js、games.js、mobile-shell.js
│   ├── tools/                 # gen-games-js.py、gen-imglist.py、gen-webp.py
│   └── play.html / phone.html / server.js / warmup.js   # 旧入口兼容层
└── P1-P2-项目结构梳理.md
```

## 配置与素材流水线

1. 改 `games.json`（游戏名、入口、手机入口、联机默认规则、素材目录）。
2. 生成浏览器配置：`python net/tools/gen-games-js.py`（写 `net/client/games.js`，勿手改）。
3. 生成 WebP 副本：`python net/tools/gen-webp.py`。
4. 生成预加载清单：`python net/tools/gen-imglist.py`（只保留有 `-web` 副本的压缩版图，不再列全尺寸原图）。
5. 联机预热：`node net/server/warmup.js`（域名 / sharecode 从 `games.json` 的 `runtime` 读取，也可用 `MG_BASE` 覆盖）。

## 存档

- 单机存档键：`mygames.save.<game>.solo`；联机主机存档键：`mygames.save.<game>.net`。
- 联机只有主机（`net_seat=0`）读写，客机纯镜像。
- 浏览器安全限制下，外部工具不能直接读你的 localStorage。需要把线上对局交给复盘工具时，在游戏页控制台执行：

```js
MGSave.exportFile()
```

会下载一个 `mygames-<game>-<mode>-<时间>.json`。导入用 `MGSave.importFile()`，选择同一个 JSON 即可。

## 已知边界

- P2 拆分保持经典脚本 + 全局函数名，方便 `save.js` / `bridge.js` 继续通过 `window.eval('G')` 和全局函数工作；不是 ES Module，没有构建步骤。
- `net/client/bridge.js` 的 per-game 适配器已收敛为 `ADAPTERS` 注册表；联机桥时序敏感，暂不拆成多个网络请求文件。
- 手机适配共用 `mobile-shell.js` 的断点 / 内容高度 / 最小宽度；`phone.html` 只保留薄壳，样式在 `solo-phone.css`，逻辑在 `solo-phone.js`。
- 项目没有 git 时，动大结构前请手动备份。

## 体积现状与瘦身建议

当前工作区约 **319.4 MB**，但运行时真正需要的大约 **65–70 MB**。主要占用：

| 目录 / 文件 | 占用 | 是否运行时需要 |
|---|---:|---|
| 根 `.git` | 229.9 MB | 否（版本历史；部署/打包不需要） |
| `Harmonies/自然和弦（含律动扩）` | 110.2 MB | 否（规则书/Mod 原始素材，含 49 MB zip） |
| `Harmonies/Images/ref` | 73.7 MB（其中 `ref/gpt` 47.7 MB） | 只有 `ref/card_back_dark.jpg` 被 `render.js` 引用，其余是设计参考 |
| `Harmonies/Images/cards` | 23.6 MB | 是（卡图） |
| `The White Castle/assets` | 39 MB | 是（但四张全尺寸版图可移出部署包） |
| `The White Castle/.git` | 31.2 MB | 否（子仓库历史） |

建议（按风险从低到高，均未在本轮执行删除）：

1. 部署/打包排除根 `.git` 与 `The White Castle/.git`，只发布运行文件。
2. 把 `Harmonies/自然和弦（含律动扩）` 移到项目外或 `_archive/`，不要让静态服务器暴露 110 MB 原始素材。
3. `Images/ref` 只保留 `card_back_dark.jpg`；`ref/gpt`、`res/*_v2`、`patterns`、`官方旧版` 移到 `_archive/`，确认无引用后再删。
4. `The White Castle/assets` 的全尺寸版图（`board-base/board-matcha/domain-base/domain-matcha`）移到 `_src/`，运行时只留 `-web` 版本；这样既减部署体积，也避免误引用。
5. 如需保留历史又减小 `.git`，在有 git 的机器上执行 `git gc --aggressive --prune=now`；当前命令行没有 git，别在没备份时手工删 `.git`。
## 线上存档自动镜像（给 AI / 复盘工具读）

联机房主窗口现在会把手里的存档镜像到服务端，**AI 不需要读浏览器 localStorage**，直接读文件即可：

```text
net/server/saves/<game>-<room>-<match>.json    # 最新快照
net/server/saves/<game>-<room>-<match>.jsonl   # 状态变化历史（按状态签名去重）
```

接口：

```text
POST /net/save?game=harmonies&room=9999&match=mabc
GET  /net/save?game=harmonies&room=9999&match=mabc
GET  /net/save?game=harmonies&room=9999&match=mabc&history=1
GET  /net/save?list=1
```

- 只有联机主机（`net_seat=0`）上传；客机没有本地状态，不上传。
- 上传节流 1.5 秒；`net/server/saves/` 已加入 `.gitignore`，不通过静态服务暴露。
- AI 读取：

```powershell
python net/tools/read-online-save.py --list
python net/tools/read-online-save.py --game harmonies --room 9999
python net/tools/read-online-save.py --game harmonies --room 9999 --history
```

也可以直接 `Read` 上面路径的 `.json` 文件。

## 联机流畅度改动（2026-11-16）

- 服务端 SSE 广播排除发送者自己，少一次回环传输和 JSON 解析。
- `bridge.js` 的整状态广播从“立即 + 400ms + 1000ms 三遍”改为“60ms 合并 + 立即 + 500ms 补一次”，连续动作只发最后一份快照。
- 本地状态兜底轮询从 200ms 放宽到 300ms；AI 节拍从 200ms 放宽到 300ms。
- 主机存档轮询从 250ms 放宽到 400ms；上线存档上传节流 1.5 秒。
- 进入对局后停止大厅的在线心跳和名单重绘（原先 1s / 700ms 常驻）。
- `bridge.js` 暴露 `window.MGNetStat`：`tx/rx`、字节数、`lastLatency`、`lastApplyMs`，可在控制台查看。

## 瘦身归档（2026-11-16）

项目从 **514.3 MB** 降到 **319.4 MB**，移出的约 195 MB 非运行时素材在：

```text
E:\vscode_workspace\Trae_projects\my_games_archive_20261116
```

归档说明和恢复命令见该目录的 `ARCHIVE-README.md`。根 `.git`（229.9 MB）和 `The White Castle/.git`（31.2 MB）仍未动，等待确认。
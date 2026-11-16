# my_games

《自然和弦》（Harmonies）与《姬路城》（The White Castle）的网页版 + 联机大厅。

在线站点：<https://zzttdog.github.io/my_games/>

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
│   ├── tools/                 # gen-games-js.py、gen-imglist.py、gen-webp.py、replay-ai.py
│   └── play.html / phone.html / server.js / warmup.js   # 旧入口兼容层
└── P1-P2-项目结构梳理.md
```

## 配置与素材流水线

1. 改 `games.json`（游戏名、入口、手机入口、联机默认规则、素材目录）。
2. 生成浏览器配置：`python net/tools/gen-games-js.py`（写 `net/client/games.js`，勿手改）。
3. 生成 WebP 副本：`python net/tools/gen-webp.py`。
4. 生成预加载清单：`python net/tools/gen-imglist.py`（有 WebP 副本时列 `.webp`，页面 `MGImg` 加载失败回退原图；不再列全尺寸重复图）。
5. 联机预热：`node net/server/warmup.js`（域名 / sharecode 从 `games.json` 的 `runtime` 读取，也可用 `MG_BASE` 覆盖）。

## 存档

- 单机存档键：`mygames.save.<game>.solo`；联机主机存档键：`mygames.save.<game>.net`。
- 联机只有主机（`net_seat=0`）读写，客机纯镜像。
- 浏览器安全限制下，外部工具不能直接读你的 localStorage。需要把线上对局交给复盘工具时，在游戏页控制台执行：

```js
MGSave.exportFile()
```

会下载一个 `mygames-<game>-<mode>-<时间>.json`。导入用 `MGSave.importFile()`，选择同一个 JSON 即可。

## AI 复盘（联机房主）

静态 GitHub Pages 不能写 `/net/save`，所以联机复盘走“房主本地记录 + 手动导出 JSON”：

1. 联机房主窗口右下角会出现“导出复盘”按钮；点击下载
   `mygames-replay-<game>-<room>-<match>-<时间>.json`。
2. 复盘包只由主机记录，包含：
   - `frames`：每个回合开始时的紧凑状态（玩家版图 / 卡牌 / 保护区 / 公共市场 / 供应区 / 牌堆数量）；
   - `events`：游戏日志中的每一条动作；
   - `final`：终局状态 + `scoreBoard` 分数明细；
   - `log`：完整游戏日志。
3. 把导出的 JSON 交给 AI，或在本机跑：

```powershell
python net/tools/replay-ai.py --file mygames-replay-harmonies-9999-mabc-....json
python net/tools/replay-ai.py --file <replay.json> --json
```

`--json` 输出机器可读的玩家统计和改进点；默认输出 Markdown 复盘报告。
复盘包存在主机浏览器 `localStorage` 的 `mygames.replay.<game>.<room>.<match>`；
中途也可以导出当前快照，不要求打完。

限制：
- 只有房主能记录；客机没有完整状态，按钮不会出现。
- PeerJS / 静态 Pages 不会自动上传，必须手动导出。
- 复盘包不包含隐藏牌堆/袋子的全部内容，只保留数量；这是为了避免 localStorage 配额和给 AI 塞无效信息。



- P2 拆分保持经典脚本 + 全局函数名，方便 `save.js` / `bridge.js` 继续通过 `window.eval('G')` 和全局函数工作；不是 ES Module，没有构建步骤。
- `net/client/bridge.js` 的 per-game 适配器已收敛为 `ADAPTERS` 注册表；联机桥时序敏感，暂不拆成多个网络请求文件。
- 手机适配共用 `mobile-shell.js` 的断点 / 内容高度 / 最小宽度；`phone.html` 只保留薄壳，样式在 `solo-phone.css`，逻辑在 `solo-phone.js`。
- 项目没有 git 时，动大结构前请手动备份。

## 体积现状与瘦身建议

当前工作区约 **58.4 MB**（2026-11-16 删除旧 `.git` 后）。运行时需要的主要是：
`Harmonies/Images/cards`、`The White Castle/assets` 的 `-web` 版图、以及游戏脚本 / CSS。

旧版本库已清理：

| 已删除 | 原占用 | 说明 |
|---|---:|---|
| 根 `.git` | 229.9 MB | 旧版本历史；已按用户确认删除 |
| `The White Castle/.git` | 31.2 MB | 子项目历史；已按用户确认删除 |

非运行时素材仍保留在本机项目外的
`E:\vscode_workspace\Trae_projects\my_games_archive_20261116`。
删除后本地不再有 git 历史；需要版本管理时，请在云主机部署树或重新初始化仓库。

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

## 联机修复（2026-11-16）

- **2 真人 + AI 时 AI 不行动**：`bridge.js` 为了把“自己”映射到本地玩家 0，会重排 `players`；
  原版 `advanceTurn()` 仍按本地数组顺序 `(G.cur + 1) % G.n` 交棒，客机结束回合会跳回房主而不是 AI。
  已在桥内覆盖 `window.advanceTurn`：把本地 `cur` 换算成 wire 座位，`nextWire = (curWire + 1) % total`，
  再映射回本地；回合清理、`round` 递增、`aiTurn()` 调用仍走原逻辑。
- **供应区 / 手牌标记没有官方图案**：`.tok` 的 CSS 相对路径原来解析到 `Harmonies/css/Images/res/...`，
  已改为 `../Images/res/...`（六种地形：water / mountain / trunk / tree / field / building）。
- 联机页 iframe 增加 `_v=20261116f` 版本参数，避免浏览器继续用旧 `save.js`；改前端脚本后记得同步 bump。

## 静态资源缓存（2026-11-16）

- 本地 Node 静态服务：图片是 `public, max-age=86400`；游戏脚本 / 样式 / 联机桥 / PeerJS 使用 `?v=20261116f` 版本地址，带版本参数的 JS/CSS 返回 `public, max-age=31536000, immutable`；HTML 保持 `no-cache`。
- GitHub Pages 不能自定义缓存头，GitHub 自身固定约 `max-age=600`；版本号仍保证更新后不会继续用旧脚本，缓存命中时传输量仍是 0 或 304。
- 联机页不再用 `fetch(..., { cache: 'no-store' })` 拉 `bridge.js` 和 `peerjs.min.js`，改为版本地址 + `force-cache`；刷新大厅和进入房间都不会重新下载这两个脚本。
- 游戏页首屏预热过一次并完整完成后，会在 `localStorage` 记一个 `mygames.preload.warm.<game>`，之后不再弹全屏“正在载入游戏资源”遮罩；图片仍由游戏自身的 `<img>` 从浏览器缓存读取。
- **改前端文件时统一 bump 版本号**：`net/client/play.html` 的 `CACHE_V`、两个游戏 `index.html` 里的 `?v=`、以及 `save.js?v=` 必须一起改，否则浏览器会继续用旧缓存。



- 服务端 SSE 广播排除发送者自己，少一次回环传输和 JSON 解析。
- `bridge.js` 的整状态广播从“立即 + 400ms + 1000ms 三遍”改为“60ms 合并 + 立即 + 500ms 补一次”，连续动作只发最后一份快照。
- 本地状态兜底轮询从 200ms 放宽到 300ms；AI 节拍从 200ms 放宽到 300ms。
- 主机存档轮询从 250ms 放宽到 400ms；上线存档上传节流 1.5 秒。
- 进入对局后停止大厅的在线心跳和名单重绘（原先 1s / 700ms 常驻）。
- `bridge.js` 暴露 `window.MGNetStat`：`tx/rx`、字节数、`lastLatency`、`lastApplyMs`，可在控制台查看。

## PeerJS 跨设备联机（2026-11-16，可选）

- 入口仍是 `net/client/play.html`。静态部署检测不到 Node `/ping` 时默认勾选 **PeerJS 测试**；也可以在生产服务器上手动勾选。
- 勾选后房间 URL 带 `peer=1`；房主/客机用同一 4 位房间号建立 WebRTC DataChannel，不再请求 `/net/room`。
- 大厅和 `bridge.js` 都保留 `net` / `local` 分支：Node SSE 与同浏览器 BroadcastChannel 仍可用。
- PeerJS 库已内置在 `net/client/vendor/peerjs.min.js`（1.5.4，MIT），不依赖 CDN。
- 默认使用 PeerJS Cloud 信令。当前只加 STUN，没有 TURN；双方处于对称 NAT / 移动网络时可能连不上。正式长期用建议自建 PeerServer + coturn，并在 `play.html` / `bridge.js` 替换信令和 ICE 配置。
- PeerJS 只解决联机，不解决线上存档：静态站没有 `/net/save`；房主仍写本地 `localStorage`。AI 复盘请用“导出复盘”按钮，不依赖服务端。

## 瘦身归档（2026-11-16）

项目从 **514.3 MB** 降到 **58.4 MB**（含删除旧 `.git` 后的最终体积）；移出的约 195 MB 非运行时素材在：

```text
E:\vscode_workspace\Trae_projects\my_games_archive_20261116
```

归档说明和恢复命令见该目录的 `ARCHIVE-README.md`。根 `.git`（229.9 MB）和 `The White Castle/.git`（31.2 MB）已按确认删除。
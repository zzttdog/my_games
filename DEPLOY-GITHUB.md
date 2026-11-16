# GitHub Pages 部署说明

## 站点入口

- 根目录 `index.html` 是入口。
- GitHub Pages 的发布源设为 `main` 分支 `/`（根目录）。
- 仓库内已放 `.nojekyll`，避免 Jekyll 处理带下划线/中文路径的资源。

## 能力边界

GitHub Pages 是纯静态托管：

- **单机 vs AI**：可用。
- **同一浏览器、同一站点的多个窗口联机**：可用（BroadcastChannel 兜底）。
- **跨设备 / 跨浏览器联机**：可用 **PeerJS 测试模式**（房主/客机通过 WebRTC 直连）；大厅检测不到 Node 服务时默认勾选。
  - 依赖 PeerJS Cloud 信令与 STUN；当前没有 TURN，双方处于对称 NAT / 移动网络时可能连不上。
  - 正式长期使用建议自建 PeerServer + coturn，并把客户端信令/ICE 配置指向自己的服务。
- **线上对局存档 `/net/save`**：只有 Node 服务提供；GitHub Pages 上该接口为 404。
- PeerJS 模式不会上传 `/net/save`；房主只写浏览器本地存档。要让 AI 自动读线上对局，需要另接 Cloudflare Worker/Supabase 等中心端点。
- 所有对局存档都在本地 `net/server/saves/`，已加入 `.gitignore`，不会提交到仓库。

## 本地开发

```bash
npm start
# http://localhost:8080/
```

单独静态预览：

```bash
python -m http.server 8099
```

## 目录

- `Harmonies/` 自然和弦
- `The White Castle/` 姬路城 + 茶道扩
- `net/client/` 联机大厅与客户端
- `net/client/vendor/peerjs.min.js` 内置 PeerJS 1.5.4（MIT）
- `net/server/` Node 联机与存档服务
- `net/tools/` 图片清单、游戏清单、线上存档读取脚本

## PeerJS 测试参数

- 房间链接带 `peer=1` 时启用；大厅静态部署默认勾选。
- 房主/客机必须使用同一游戏、同一 4 位房间号。
- 浏览器需允许 WebRTC；企业网络若禁用 UDP/WebRTC，PeerJS 会连接失败。

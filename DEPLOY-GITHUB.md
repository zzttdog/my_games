# GitHub Pages 部署说明

## 站点入口

- 根目录 `index.html` 是入口。
- GitHub Pages 的发布源设为 `main` 分支 `/`（根目录）。
- 仓库内已放 `.nojekyll`，避免 Jekyll 处理带下划线/中文路径的资源。

## 能力边界

GitHub Pages 是纯静态托管：

- **单机 vs AI**：可用。
- **同一浏览器、同一站点的多个窗口联机**：可用（BroadcastChannel 兜底）。
- **跨设备 / 跨浏览器联机**：不可用；必须运行 Node 服务：

```bash
npm start
# 或 node net/server/server.js
```

- **线上对局存档 `/net/save`**：只有 Node 服务提供；GitHub Pages 上该接口为 404。
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
- `net/server/` Node 联机与存档服务
- `net/tools/` 图片清单、游戏清单、线上存档读取脚本

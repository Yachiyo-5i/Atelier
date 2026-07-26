# Atelier · Image Generations

JS 全栈文生图客户端。配置与图片持久化到本地 `data/`（不会打进二进制）。

- **Web 前端**（`public/`）：浏览器访问，`./run.sh` 启动
- **Express 后端**（`server/`）

## 功能

- **文生图** `POST /v1/images/generations`
- **图片编辑** `POST /v1/images/edits`：上传参考图 / 从结果区加入，再按 Prompt 改图
- 多 Provider 配置与切换、模型列表过滤、自动/手动本地存图、历史 Prompt

## 快速启动

```bash
# 优先使用已打包二进制 dist/atelier；没有则回退 node 源码
./run.sh
```

浏览器打开 http://localhost:3000

## 打包为二进制

```bash
npm install
npm run build
# 产出: dist/atelier  (~58MB, macOS arm64)
./run.sh
# 或
./dist/atelier
```

- **不包含** 你的 `data/config.json`、历史 prompt、本地图片
- 首次运行会在可执行文件旁创建 `data/`（或通过 `ATELIER_HOME` 指定）

```bash
PORT=3000 ATELIER_HOME=/path/to/home ./dist/atelier
```

## 开发

```bash
npm install
npm start          # node server/index.js
npm run dev        # 热重载
```

## 目录

```
run.sh                 # 根目录启动脚本
dist/atelier           # 打包产物
server/                # Express 后端
public/                # JS web 前端静态资源
data/                  # 运行时数据（不入库、不打包）
scripts/build-binary.mjs   # 打包二进制（npm run build）
```

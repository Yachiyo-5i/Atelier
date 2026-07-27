# Atelier · Image Generations

本地优先的文生图工作台。JS 全栈(Express 后端 + 原生 JS 前端),可打包为 **macOS / Windows 独立桌面客户端**(Tauri 壳 + Node sidecar),也可作为 Web 服务运行。

## 功能

- **文生图** `POST /v1/images/generations`、**图片编辑** `POST /v1/images/edits`(上传/拖拽/粘贴参考图)
- 多 Provider(OpenAI 兼容 API)配置与切换、模型列表过滤
- **本地图库**:生成结果自动物化到本地磁盘(规避临时 CDN 403),支持保存/删除/清理未保存
- 历史 Prompt、参数回填

## 桌面客户端(推荐)

```bash
npm install
npm run desktop:dev                # 开发:构建 sidecar + tauri dev
npm run desktop:build              # 当前架构安装包(dmg / nsis)
npm run desktop:build:universal    # macOS Universal(arm64+x86_64 合一)
```

依赖:Node ≥ 18、Rust 工具链(rustup)。

架构:Tauri 壳启动打包好的 Node 后端(sidecar),后端绑定 `127.0.0.1` 随机端口,并要求每次启动随机生成的 token(壳经 `/?token=` 换成 HttpOnly Cookie),数据存放在系统标准位置:

- macOS: `~/Library/Application Support/com.yachiyo.atelier/data/`
- Windows: `%APPDATA%\com.yachiyo.atelier\data\`

CI:推送 `main` 或 `v*` tag 会自动触发 `.github/workflows/desktop.yml`,产出 **macOS Universal**(单个 dmg 同时支持 Apple Silicon 与 Intel,后端 sidecar 经 `lipo` 合并)与 **Windows x64**(nsis + msi)安装包,并自动发布 GitHub Release。`v*` tag 使用版本标签,`main` push 和 workflow_dispatch 使用 `build-<run number>` 标签。macOS 签名公证需配置 `APPLE_*` secrets(未配置则产出未签名包)。

## Web 模式

```bash
./run.sh            # 优先用打包二进制 dist/atelier,否则回退 node 源码
# 浏览器打开 http://localhost:3000
```

环境变量:`PORT`(0 = 随机)、`HOST`(默认 127.0.0.1)、`ATELIER_HOME`(数据目录)、`ATELIER_TOKEN`(设置后所有请求需带 token)。

## 开发

```bash
npm start          # node server/index.js
npm run dev        # 热重载
npm run build      # 打包后端为单文件二进制 dist/atelier
```

## 目录

```
server/                    # Express 后端(API、图库、Provider 代理)
public/                    # 前端静态资源
src-tauri/                 # Tauri 桌面壳(spawn sidecar → webview)
scripts/build-binary.mjs   # pkg 打包后端二进制
scripts/prepare-sidecar.mjs# 将二进制按 target triple 放入 src-tauri/binaries
scripts/gen-icon.mjs       # 生成图标源图(assets/icon-source.png)
data/                      # Web 模式运行时数据(不入库)
```

## API 说明(本地)

- `GET /api/images?offset&limit&includeTemp` 图库列表(新→旧)
- `DELETE /api/images/local/:id` 删除本地图片
- `POST /api/images/save` `{localId}` 将临时图转正;或 `{url|b64_json}` 手动保存
- 关闭「自动保存」时,生成结果仍会物化到磁盘但标记为临时(temp),7 天后启动时清理;「清理未保存」按钮可立即清除

# Velxio OSS Desktop (Unofficial)

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Status: unofficial](https://img.shields.io/badge/status-unofficial-red.svg)](#disclaimer--免责声明)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6.svg)](#requirements--需求)

非官方 Velxio 桌面封装:用 **Electron** 把 Velxio 开源 Web 前端打包成离线桌面应用。
本项目与 Velxio 官方**无关联**,不包含任何 Pro 许可证密钥或专有验证逻辑。
以 **AGPLv3** 发布,完整源码见本仓库。

> **Unofficial community desktop wrapper for Velxio. Built with Electron. AGPLv3.
> Not affiliated with the Velxio project. Ships no Pro keys and no proprietary
> validation logic.**

---

## Disclaimer / 免责声明

- 这**不是** Velxio 官方产品,与 Velxio 项目及其作者**没有任何关联**,也未获其认可或赞助。
- 不包含任何 Pro 许可证密钥、订阅校验、试用期或专有验证逻辑。
- 本仓库**不含** Velxio 的官方 Logo 或商标。应用图标为本项目原创设计,由
  [`desktop/scripts/generate-icon.mjs`](desktop/scripts/generate-icon.mjs) 以纯 Node 生成。
- **本仓库不代收任何捐款,也不含任何联盟营销链接。** 上游项目自己的赞助入口与
  硬件合作伙伴致谢,完整保存在 [UPSTREAM_README.md](UPSTREAM_README.md) 中存档;
  那些账户与基础设施属于**上游**,与本封装无关。
- Velxio 核心代码版权归原作者 **David Montero Crespo** 及贡献者所有,遵循 AGPLv3。
  本项目属于衍生作品,同样以 AGPLv3 发布。
- 对上游文件的修改已在 [NOTICE](NOTICE) 中逐项列出(AGPLv3 §5a)。
- 基于上游仓库 commit `f1514587` 构建。

## 快速开始 / Quick start

### 1. 构建前端

```bash
cd frontend
npm install
npx vite build          # 产物输出到 frontend/dist
```

### 2. 安装并启动桌面壳

```bash
cd desktop
npm install             # 安装 Electron
npm start               # 启动桌面应用
```

### 3. (可选)启用本地编译后端

桌面壳会**自动探测并拉起**本地 Velxio 后端。没有后端时,编辑器、`.vlx` 项目、
以及**浏览器内的 AVR / RP2040 仿真**依然可用,只是无法编译新代码。

```bash
cd backend
python -m venv venv
venv/Scripts/pip install -r requirements.txt      # Windows
# source venv/bin/activate && pip install -r requirements.txt   # macOS / Linux
```

要让 Arduino 代码**真正编译**成 `.hex`,还需要 `arduino-cli`。不必系统安装:
把便携版解压到仓库本地的 `.tools/arduino-cli/`,壳子会自动把它加进后端 PATH。

```bash
arduino-cli core update-index
arduino-cli core install arduino:avr
```

## 这个壳子做了什么

| 能力 | 说明 |
| --- | --- |
| 离线桌面应用 | 前端全部本地加载,不依赖网络 CDN |
| 同源反向代理 | 本地 HTTP 服务托管 `dist/`,并把 `/api`、`/health` 与 WebSocket 转发到本地后端。**无需修改上游前后端代码,也不需要放宽 CORS** |
| 桌面引导注入 | 在页面脚本执行前注入 `window.__VELXIO_API_BASE__` —— 这正是上游 [`frontend/src/lib/apiBase.ts`](frontend/src/lib/apiBase.ts) 为桌面宿主预留的钩子 |
| 本地后端托管 | 自动探测 `backend/venv` 或系统 Python 并拉起 uvicorn,退出时回收进程 |
| 便携工具链 | 自动把仓库本地 `.tools/` 加进后端 PATH,零系统安装、零提权 |
| 安全默认值 | `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true` |
| 无商业逻辑 | 不含许可证门禁、Pro Key、试用期、授权校验或任何专有逻辑 |

设计取舍与实现细节见 [desktop/README.md](desktop/README.md)。

## Requirements / 需求

| 组件 | 用途 | 说明 |
| --- | --- | --- |
| Node.js 20+ | 构建前端、运行壳子 | 必需 |
| 已构建的 `frontend/dist` | 界面本体 | `cd frontend && npm install && npx vite build` |
| Python 3.10+ 与 `backend/requirements.txt` | 编译代码 | 可选;没有它仿真照样跑 |
| `arduino-cli` + `arduino:avr` | 编译 Arduino 代码 | 可选;可放 `.tools/arduino-cli/` |

## 已知限制 / Known limitations

1. **安装包不捆绑 Python 后端**,只带源码。有可用解释器时壳子才自动拉起;
   否则进入"纯前端模式"(编辑器、`.vlx` 项目、浏览器内 AVR / RP2040 仿真)。
2. **QEMU 系板卡**(ESP32 全系、STM32、树莓派 Linux)依赖 QEMU 库,而 OSS 上游
   出于授权原因**故意不发布**这些库,因此本封装同样不具备。
3. 首次启动后端较慢:一旦 `arduino-cli` 可用,后端启动时会更新的多个板卡索引
   (`core update-index`),实测约 48 秒(索引已缓存时),冷启动更久。
   可用 `VELXIO_BACKEND_TIMEOUT_MS` 调整等待上限。
4. 未配置代码签名,Windows/macOS 首次启动会有安全提示。

## 项目结构

```
desktop/                    Electron 桌面壳(本项目新增)
├── main.cjs                主进程:启动后端 + 窗口 + 菜单
├── lib/server.cjs          静态服务 + /api 与 WebSocket 同源反向代理
├── lib/backend.cjs         本地 Python 后端托管
├── preload.cjs             contextIsolation 安全的 preload
├── scripts/                原创图标生成、独立 serve、CDP 截图
└── test/                   冒烟测试与端到端编译测试
frontend/ backend/ ...      上游 Velxio 源码(未修改)
```

## 归属与许可 / Attribution & License

- **上游项目**:<https://github.com/davidmonterocrespo24/velxio>(基准提交 `f1514587`)
- **上游原始 README 存档**:[UPSTREAM_README.md](UPSTREAM_README.md)
- **修改记录**:[NOTICE](NOTICE) · **免责声明**:[DISCLAIMER.md](DISCLAIMER.md)
- **许可证**:AGPLv3 —— 全文见 [LICENSE](LICENSE)。Velxio 核心 © David Montero
  Crespo 及贡献者;本项目为衍生作品,以同一许可证发布。

"Velxio" 一词仅用于说明本封装的对象,属指称性合理使用,不表示任何关联。

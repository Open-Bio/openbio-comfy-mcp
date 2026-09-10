# OpenBio Comfy MCP

[English](README.md) | [简体中文](README.zh-CN.md)

[![许可证：MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/openbio-comfy-mcp.svg)](https://www.npmjs.com/package/openbio-comfy-mcp)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933.svg)](https://nodejs.org/)
[![ComfyUI 0.33.0+](https://img.shields.io/badge/ComfyUI-0.33.0%2B-blue.svg)](https://github.com/Comfy-Org/ComfyUI)

让 Cursor、Codex、Claude 或其他本地 AI **查看、修改并排队执行**你 ComfyUI 里当前打开的工作流画布。

它走 ComfyUI 自己的图、选择、分组、撤销和 Queue 按钮，不会帮你保存工作流。

这不是 [Comfy 官方 MCP](https://docs.comfy.org/agent-tools/mcp)。官方 Cloud MCP 在云端出图，`comfy-mcp` 跑的是工作流文件。本项目改的是你屏幕上正在打开的那张图，并可以按 Queue 把它跑起来。

## 可以让 AI 做什么

两边都装好、并且开着一个 ComfyUI 窗口之后，可以这样说：

- 现在画布上有什么？
- 加一个节点、把这两个连上、挪一下这个组。
- 搜一下**这台** ComfyUI 里装了哪些节点。
- 把节点打成原生子图，或再拆开。
- 把当前画布排队，完成后拿到输出文件路径。

修改会立刻出现在画布上。一次 ComfyUI 撤销会整批还原。排队走的是和 Queue 按钮相同的路径。

## 安装

必须做 **两步**。Manager 只装 ComfyUI 这一侧；AI 客户端还要单独接 MCP 服务器。

### 1. 安装 ComfyUI 扩展

打开 ComfyUI Manager，搜索 `OpenBio Comfy MCP` 或 `openbio-comfy-mcp`，安装后重启 ComfyUI。用工具时请保持浏览器或 Desktop 窗口开着。

扩展没有额外的 Python 依赖。Registry 版本已带打包好的 MCP 服务器。

确认中继可用：

```powershell
Invoke-RestMethod http://127.0.0.1:8188/openbio-comfy-mcp/health
```

应返回 `"ok": true`。端口不是 `8188` 时换成你的端口。

### 2. 接到 MCP Host

MCP Host 所用环境的 `PATH` 上要有 Node.js 20+。写发布包即可，不必填本机文件路径：

```json
{
  "mcpServers": {
    "openbio-comfy-mcp": {
      "command": "npx",
      "args": ["-y", "openbio-comfy-mcp@latest"]
    }
  }
}
```

#### Codex

```powershell
codex mcp add openbio-comfy-mcp -- npx -y openbio-comfy-mcp@latest
codex mcp get openbio-comfy-mcp --json
```

添加后重启 Codex 客户端。Desktop、CLI 和 IDE 扩展共用同一套配置。参见 [Codex MCP 文档](https://developers.openai.com/codex/mcp)。

#### Cursor

把上面的 JSON 写进 `~/.cursor/mcp.json`（全局）或项目里的 `.cursor/mcp.json`，然后重载 MCP。

#### 其他 stdio Host（Claude Desktop、Claude Code 等）

同样使用 `npx -y openbio-comfy-mcp@latest`。各 Host 的配置键可能不同，命令必须是 `npx`。

本地 ComfyUI 会自动发现。开了多个 ComfyUI 进程，也只需注册一次 MCP。

## 环境要求

- ComfyUI 0.33.0 或更高
- ComfyUI 运行环境为 Python 3.10 或更高
- MCP Host 的 PATH 上有 Node.js 20 或更高
- 能拉起本地 stdio 服务器的 MCP Host
- 使用工具时保持一个 ComfyUI 页面打开

## 配置

| 变量 | 默认值 | 什么时候设 |
| --- | --- | --- |
| `OPENBIO_COMFY_URL` | 不设置（自动发现） | 把这次 MCP 连接钉在某一个实例上，例如 `http://127.0.0.1:8189` 或 `http://192.168.1.13:8188`。 |
| `OPENBIO_COMFY_REGISTRY_DIR` | `~/.openbio-comfy-mcp/instances` | 覆盖共享注册目录。ComfyUI 和 MCP Host 必须用同一个路径。 |

每个要编辑的 ComfyUI 实例都要装这个扩展。各后端会把地址写进共享目录。发现范围是回环和私有网段（`192.168.x.x`、`10.x`、`172.16–31.x`），不支持公网地址。ComfyUI 监听 `0.0.0.0` 时仍会登记成 `127.0.0.1`；从另一台机器控制时，把 `OPENBIO_COMFY_URL` 设成那台机器的局域网地址，例如 `http://192.168.1.13:8188`。

多个实例同时在线时，默认选最近获得焦点的页面。需要指定时可以说「改 8189 端口上的工作流」。`list_instances` 会列出 `instance_id`、状态和已连接画布。

## 工具

| 工具 | 影响 | 用途 |
| --- | --- | --- |
| `list_instances` | 只读 | 列出本地实例和已连接画布。 |
| `inspect_canvas` | 只读 | 查看当前图、子图，或指定节点/分组。 |
| `search_nodes` | 只读 | 搜索该 ComfyUI 已安装的节点类型。 |
| `inspect_node_type` | 只读 | 读取某个 `class_type` 的原生结构。 |
| `present_canvas` | 仅界面 | 切换图、选中对象、按需适配视口。 |
| `apply_canvas_patch` | 写入画布 | 原子化执行一批可撤销的图编辑。 |
| `queue_canvas` | 排队当前画布 | 等同于 Queue 按钮，包括 seed 控件。返回 `prompt_id` 和 `prompt_ids`，不等待、不保存。 |
| `inspect_prompt` | 只读 | 查看排队任务状态，以及输出文件名、本地路径和查看 URL。失败是 `error`，不是 `completed`。 |
| `wait_for_prompt` | 只读 | 轮询直到该任务完成、失败或超时。 |

常见流程：先检查 → 需要时搜节点类型 → 发一次补丁 → `queue_canvas` → `wait_for_prompt` → 图改错了就在 ComfyUI 里撤销。

完整操作集合见 [docs/spec.md](docs/spec.md)。

## 安全

- MCP 进程的操作系统权限与拉起它的 Host 相同。
- `apply_canvas_patch` 会改当前打开的工作流。`queue_canvas` 会在你的 GPU 上跑这张图。若 Host 会审核写入工具，请把这两个都打开审核。
- 服务器不监听端口。画布命令只接受回环和私有网段请求。这不是 ComfyUI 的登录层；不要把未认证的 ComfyUI 暴露到公网。
- 检查结果可能包含提示词、文件名和控件值。后续如何处理取决于你的 MCP Host 和模型提供方。

## 故障排查

- `NO_LIVE_CANVAS`：打开或刷新 ComfyUI 页面，并保持连接。
- Host 里没有工具：确认 PATH 上有 Node 20+，命令是 `npx -y openbio-comfy-mcp@latest`，然后重启 Host。
- 健康检查路由不存在：扩展没加载。确认装在 `custom_nodes` 下，重启 ComfyUI，看控制台。
- `STALE_CANVAS`：重新检查，再发新补丁。
- `PROMPT_TIMEOUT`：`wait_for_prompt` 结束时任务还在跑。再调 `inspect_prompt`，或再等一次。
- `AMBIGUOUS_INSTANCE`：多个实例且焦点不明确。先 `list_instances`，再传入 `instance_id` 或 `canvas_id`。
- `INSTANCE_UNAVAILABLE` / `INSTANCE_NOT_FOUND`：该 ComfyUI 已关掉或刚重启。重新列出并检查。
- 端口 `5173` 的 Vite 前端：不会加载自定义节点的 JavaScript。请用 ComfyUI 自己提供的前端。

## 更新与卸载

Manager 用户：在 Manager 里更新扩展，重启 ComfyUI 并刷新页面。MCP Host 下次 `npx` 时会拉取 `@latest`。

先删 Host 注册（Codex：`codex mcp remove openbio-comfy-mcp`），再卸载自定义节点，最后重启 ComfyUI。

## 源码安装

开发本扩展，或无法使用 Manager 时：

```powershell
$ComfyRoot = "C:\path\to\ComfyUI"
Set-Location "$ComfyRoot\custom_nodes"
git clone https://github.com/Open-Bio/openbio-comfy-mcp.git
Set-Location .\openbio-comfy-mcp
npm ci
```

```bash
cd /path/to/ComfyUI/custom_nodes
git clone https://github.com/Open-Bio/openbio-comfy-mcp.git
cd openbio-comfy-mcp
npm ci
```

Git 仓库放在 ComfyUI 外面时，用 Junction 或符号链接挂到 `custom_nodes`，再在仓库里运行 `npm ci`。不要把同一个仓库挂到多个自定义节点目录。

对本仓库做本地 MCP 调试时，可以继续用 `node dist/openbio-comfy-mcp.mjs`，不必走 `npx`。

```bash
npm ci
npm test
```

Python 中继测试请用 ComfyUI 同一个解释器：

```powershell
C:\path\to\ComfyUI\.venv\Scripts\python.exe `
  -m pytest --rootdir=tests -c pyproject.toml tests -q
```

独立的 ComfyUI_frontend Vite 开发服务器（`pnpm dev`，通常是 `5173`）不会加载自定义节点的 JavaScript。请打开 ComfyUI 自己提供的界面。

## 许可证

OpenBio Comfy MCP 使用 [MIT License](LICENSE) 发布。

本项目使用官方 [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)，以及 ComfyUI 文档中的 [V3](https://docs.comfy.org/custom-nodes/v3_migration) 和 [JavaScript 扩展](https://docs.comfy.org/custom-nodes/js/javascript_overview)接口。

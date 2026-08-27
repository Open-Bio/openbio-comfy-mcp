# OpenBio Comfy MCP

[English](README.md) | [简体中文](README.zh-CN.md)

[![许可证：MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933.svg)](https://nodejs.org/)
[![ComfyUI 0.33.0+](https://img.shields.io/badge/ComfyUI-0.33.0%2B-blue.svg)](https://github.com/Comfy-Org/ComfyUI)

OpenBio Comfy MCP 是一个本地 [Model Context Protocol](https://modelcontextprotocol.io/) 服务器和 ComfyUI V3 扩展，用于检查和编辑当前在 ComfyUI 画布中打开的工作流。它使用 ComfyUI 原生的图、选择、分组、脏状态和撤销机制；不会自动排队、执行或保存工作流。

> [!IMPORTANT]
> 本项目目前通过源码安装，尚未发布到 Comfy Registry，因此暂时无法在 ComfyUI Manager 中搜索或安装。

## 功能

- 以紧凑的结构化 MCP 输出检查当前活动画布。
- 搜索已连接 ComfyUI 中安装的全部节点类型。
- 检查指定节点类型的完整原生结构定义。
- 选择并聚焦原生节点或分组，不修改工作流。
- 添加、删除、连接、断开、配置和移动节点。
- 添加、更新、适配、移动和删除 ComfyUI 原生分组。
- 将一批修改作为一个原子化、可撤销的 ComfyUI 原生事务执行。
- 在更改实时画布之前拒绝过期或无效的补丁。
- 保持 MCP 传输在本机：stdio 服务器不监听端口，画布命令只接受来自回环地址的请求。

## 架构

```text
MCP Host 应用（Codex 或其他本地 Host）
        | MCP over stdio
        v
Node.js MCP Server
        | ComfyUI HTTP
        v
Python V3 扩展中继
        | ComfyUI WebSocket 事件
        v
浏览器页面扩展 -> 当前 app.canvas.graph
```

浏览器页面是实时图的唯一权威来源。Python 扩展负责将请求与已连接页面关联，Node.js stdio 服务器不保存权威的工作流副本。该扩展不注册 ComfyUI 执行节点，也不会修改 ComfyUI Core、ComfyUI_frontend、Desktop 或工作流文件格式。

## 环境要求

- ComfyUI 0.33.0 或更高版本
- ComfyUI 运行环境使用 Python 3.10 或更高版本
- Node.js 20 或更高版本
- 支持本地 stdio 服务器的 MCP Host 应用
- 使用工具时保持一个 ComfyUI 浏览器或 Desktop 页面处于打开状态

ComfyUI 扩展本身没有额外的 Python 包依赖。`npm ci` 只安装 Node.js MCP 服务器依赖，不会修改 ComfyUI 的 Python 环境。

## 安装

### 标准源码安装

将仓库直接克隆到 ComfyUI 的 `custom_nodes` 目录，然后安装 MCP 服务器依赖。

Windows PowerShell：

```powershell
$ComfyRoot = "C:\path\to\ComfyUI"
Set-Location "$ComfyRoot\custom_nodes"
git clone https://github.com/Open-Bio/openbio-comfy-mcp.git
Set-Location .\openbio-comfy-mcp
npm ci
```

Linux 或 macOS：

```bash
cd /path/to/ComfyUI/custom_nodes
git clone https://github.com/Open-Bio/openbio-comfy-mcp.git
cd openbio-comfy-mcp
npm ci
```

安装后重启 ComfyUI，在浏览器中打开界面，并确认扩展路由可用：

```powershell
Invoke-RestMethod http://127.0.0.1:8188/openbio-comfy-mcp/health
```

预期响应为 `{ "ok": true }`。

### 用于开发的同级仓库

如需让修改保留在独立仓库中，可以把 Git 仓库放在 ComfyUI 外部，再通过链接暴露给 ComfyUI。

Windows PowerShell：

```powershell
$ComfyRoot = "C:\path\to\ComfyUI"
$Repo = "C:\path\to\openbio-comfy-mcp"

New-Item -ItemType Junction `
  -Path "$ComfyRoot\custom_nodes\openbio-comfy-mcp" `
  -Target $Repo

Set-Location $Repo
npm ci
```

Linux 或 macOS：

```bash
ln -s /path/to/openbio-comfy-mcp /path/to/ComfyUI/custom_nodes/openbio-comfy-mcp
cd /path/to/openbio-comfy-mcp
npm ci
```

不要通过多个自定义节点根目录重复暴露同一个仓库。

## 连接 MCP Host

### Codex

使用绝对路径注册本地 stdio 服务器：

```powershell
$Repo = (Resolve-Path "C:\path\to\openbio-comfy-mcp").Path

codex mcp add openbio-comfy-mcp `
  --env OPENBIO_COMFY_URL=http://127.0.0.1:8188 `
  -- node "$Repo\mcp_host\cli.mjs"

codex mcp get openbio-comfy-mcp --json
codex mcp list --json
```

添加服务器后重启 Codex 客户端。同一 Codex 主机上的 Codex Desktop、CLI 和 IDE 扩展会共享 MCP 配置。参见 [Codex MCP 官方文档](https://developers.openai.com/codex/mcp)。

### 其他 stdio MCP Host

对于采用 `mcpServers` JSON 配置的 Host，请将下面示例中的路径替换为绝对路径：

```json
{
  "mcpServers": {
    "openbio-comfy-mcp": {
      "command": "node",
      "args": ["C:\\path\\to\\openbio-comfy-mcp\\mcp_host\\cli.mjs"],
      "env": {
        "OPENBIO_COMFY_URL": "http://127.0.0.1:8188"
      }
    }
  }
}
```

不同 Host 的配置键可能不同。命令必须启动 `mcp_host/cli.mjs`，`OPENBIO_COMFY_URL` 必须指向本机 ComfyUI 服务器。

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OPENBIO_COMFY_URL` | `http://127.0.0.1:8188` | 本地 MCP 服务器连接的 ComfyUI 基础地址。 |

## 工具

| 工具 | 影响 | 用途 |
| --- | --- | --- |
| `inspect_canvas` | 只读 | 检查紧凑拓扑，或查看指定原生节点/分组引用的详情。 |
| `search_nodes` | 只读 | 搜索已连接 ComfyUI 的 `/object_info` 目录。 |
| `inspect_node_type` | 只读 | 读取一个准确 `class_type` 的完整原生结构。 |
| `present_canvas` | 仅界面状态 | 选择并按需聚焦原生对象，不修改工作流。 |
| `apply_canvas_patch` | 写入实时画布 | 原子化执行一批可撤销的节点、连线或分组操作。 |

推荐的编辑流程：

1. 调用 `inspect_canvas`，保存返回的 `canvas_id` 和 `revision`。
2. 添加不熟悉的节点类型前，使用 `search_nodes` 和 `inspect_node_type`。
3. 发送一个 `apply_canvas_patch`，使用检查结果中的 `canvas_id`，并将 `revision` 作为 `base_revision`。
4. 可选调用 `present_canvas`，选择并聚焦已修改对象。
5. 再次检查；如果结果不符合预期，使用 ComfyUI 原生撤销命令。

准确的公开行为和操作集合见 [docs/spec.md](docs/spec.md)。

## 前端开发说明

独立的 ComfyUI_frontend Vite 开发服务器（`pnpm dev`，通常为端口 `5173`）不会加载自定义节点提供的 JavaScript 扩展。因此 OpenBio Comfy MCP 无法连接到只由该开发服务器提供的画布。请使用 ComfyUI 后端自身提供的前端，或者先构建前端，再让 ComfyUI 使用该构建作为前端根目录。

安装或更新本仓库后，应重启 ComfyUI 并刷新浏览器页面，使页面扩展被加载。

## 安全与隐私

- 只安装来自可信来源的 MCP 服务器。本地服务器与启动它的 MCP Host 应用具有相同的操作系统权限。
- 将 `apply_canvas_patch` 视为具有写入能力的工具，并在 MCP Host 中检查或批准它的使用。它会修改所选页面当前打开的工作流，但整个补丁可以通过一次原生撤销还原。
- stdio MCP 服务器不监听网络端口，只会访问配置的 ComfyUI HTTP 服务器，默认为 `http://127.0.0.1:8188`。
- 画布命令只接受来自回环地址的请求。这个限制并不是 ComfyUI 的通用身份验证层；不要把未认证的 ComfyUI 服务器暴露给不可信网络。
- 本桥接只暴露类型化图操作，不提供任意 JavaScript、DOM、文件系统、Shell、工作流排队或执行能力。
- 画布检查可能包含工作流名称、路径、节点标题、提示词、文件名、样本标识和控件值。后续数据处理取决于所连接 MCP Host 和模型提供方的隐私政策及配置。
- 页面断开时返回 `NO_LIVE_CANVAS`；系统不会退回到后台修改工作流文件。

## 故障排查

- `NO_LIVE_CANVAS`：打开或刷新一个 ComfyUI 页面，并保持连接。
- Host 中没有工具：运行 `npm ci`，检查 `cli.mjs` 的绝对路径，然后重启 MCP Host 应用。
- 健康检查路由不存在：确认仓库位于 `custom_nodes` 下或已正确链接，然后重启 ComfyUI 并检查控制台导入错误。
- `STALE_CANVAS`：重新调用 `inspect_canvas`，使用新返回的版本构建补丁。
- 同时打开多个页面：默认使用最近获得焦点的 ComfyUI 页面；无法消除歧义时会返回错误，而不会猜测目标。
- 端口 `5173` 的开发页面无法连接：按上面的说明改用由 ComfyUI 后端提供的前端。

## 更新与卸载

更新源码安装及其锁定的 Node.js 依赖：

```bash
git pull --ff-only
npm ci
```

更新后重启 ComfyUI，并刷新浏览器页面。

卸载时，先删除 MCP Host 注册。Codex 用户运行：

```powershell
codex mcp remove openbio-comfy-mcp
```

然后从 `ComfyUI/custom_nodes` 删除克隆的 `openbio-comfy-mcp` 目录；如果使用同级开发仓库，则只删除 Junction/符号链接。最后重启 ComfyUI。

## 开发

安装 Node.js 依赖并运行 MCP/页面扩展测试：

```bash
npm ci
npm test
```

使用运行 ComfyUI 的同一个解释器执行 Python 中继测试：

```powershell
C:\path\to\ComfyUI\.venv\Scripts\python.exe `
  -m pytest --rootdir=tests -c pyproject.toml tests -q
```

仓库结构：

```text
mcp_host/                 Node.js stdio MCP 服务器
openbio_comfy_mcp/        ComfyUI V3 Python 中继扩展
web/                      实时页面扩展和画布桥接
tests/                    Node.js 和 Python 测试
docs/spec.md              公开行为和安全边界
```

欢迎提交 Issue 和 Pull Request。请让修改保持在项目文档定义的实时画布和本地传输边界内，并在提交前运行两套测试。

## 许可证

OpenBio Comfy MCP 使用 [MIT License](LICENSE) 发布。

本项目使用官方 [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)，并采用 ComfyUI 文档中的 [V3 扩展](https://docs.comfy.org/custom-nodes/v3_migration)和 [JavaScript 扩展](https://docs.comfy.org/custom-nodes/js/javascript_overview)机制。

# Research Locus：发给朋友的安装说明

这是旧版 0.1.0 ZIP 的安装说明。当前 GitHub 市场版 0.1.1 请使用 [安装、侧栏与使用教程](install-and-use.zh-CN.md)，填写来源 `HERRY423/Research-locus`、Git 引用 `main`、稀疏路径留空。

这是本地预览版 0.1.0，包含独立项目首页、科研共审和回放剧场。需要 Node.js 22 或以上版本。安装包已带预构建页面、服务器及运行依赖，不需要 npm install、编译或模型 API key。

## 方式一：桌面插件安装

适用：支持本地插件市场和 stdio MCP 的 ChatGPT 桌面 Work / Codex 客户端。实际入口是否显示，取决于客户端版本、账户和管理员策略；尚未在朋友的客户端完成验收。

1. 将 `research-locus-friend-kit.zip` 解压到自己的固定目录，例如 `C:\Tools\research-locus-friend-kit`。不要只复制里面的 `plugin.json`。
2. 在终端运行 `node --version`，确认是 v22 或以上。若找不到 Node，先安装 Node.js，再重启桌面客户端，使它获得更新后的 PATH。
3. 如果已安装 Codex CLI，运行：

   ```powershell
   codex plugin marketplace add "C:\Tools\research-locus-friend-kit"
   ```

   参数必须是直接包含 `.agents` 和 `plugins` 的目录。如果解压软件多套了一层目录，请进入里面那层。此命令只登记市场来源，下一步才是安装插件。

   没有 CLI 时，在桌面客户端将这个目录作为本地项目打开，使用随包提供的 `.agents/plugins/marketplace.json` 项目市场。如果当前客户端不发现项目市场，先用下方本地预览方式，不要把 ZIP 当成浏览器扩展安装。
4. 完全退出并重新打开桌面客户端。进入 Plugins / 插件目录，选择来源 **Research Locus Local**，找到 **Research Locus** 并安装、启用。
5. 新建聊天。支持 MCP Extensions 的宿主应能发现全局 **Research Locus** 入口和会话内 **Claim & Evidence Review** 入口。打开全局入口后，在首页创建项目与会话；进入会话，点击左侧「回放剧场」查看已保存的操作。

这条安装路线依据 [OpenAI 插件打包文档](https://developers.openai.com/plugins/build/plugins)。目录结构已经配好：

```text
research-locus-friend-kit/
  .agents/plugins/marketplace.json
  INSTALL.zh-CN.md
  plugins/research-locus/
    plugin.json
    mcp.json
    .codex-plugin/plugin.json
    scripts/launch.mjs
    dist/
    node_modules/
    skills/
```

**首次检查**：能打开项目首页、创建空白会话、添加一条测试论断、回看该修改、关闭后重新打开。工具列表存在不等于原生页面已成功加载。若只有工具没有侧栏入口，请记录客户端名称和版本，这通常需要检查该宿主的扩展支持。

## 方式二：直接本地预览

不依赖宿主插件入口。在解压后的市场根目录打开终端：

```powershell
node ./plugins/research-locus/scripts/launch.mjs --http
```

保持终端运行，浏览器打开 `http://127.0.0.1:4317/`。停止服务使用 Ctrl+C。这是本地网页预览，不代表已装入 ChatGPT。已有程序占用 4317 时，Windows 可先运行 `$env:PORT='4319'`，再启动并访问 4319。

macOS / Linux 使用相同 Node 命令；桌面插件入口是否可用仍取决于相应客户端。不要把这个 localhost 地址发给别人当成你的服务器地址；每位朋友应在自己的电脑启动自己的副本。

## 方式三：其他 MCP 客户端

支持 stdio 的客户端可使用下列配置，路径替换为自己的真实解压路径。不同客户端的配置文件位置和外层结构可能不同。

```json
{
  "mcpServers": {
    "research-locus": {
      "command": "node",
      "args": ["C:/Tools/research-locus-friend-kit/plugins/research-locus/scripts/launch.mjs"]
    }
  }
}
```

普通 MCP 客户端可能只显示工具；独立首页、侧栏、文件入口等需要 MCP Apps / OpenAI 扩展支持。

## 数据位置与排障

默认数据路径：

- Windows：`%LOCALAPPDATA%\ResearchLocus\`
- macOS：`~/Library/Application Support/ResearchLocus/`
- Linux：`$XDG_DATA_HOME/ResearchLocus/`，未设置时为 `~/.local/share/ResearchLocus/`

`state.json` 是明确标记的初始合成示例；新项目和会话在 `catalog/` 下独立保存。安装包不带原开发者的 `.locus`、会话、日志、配置或密钥。同一用户的插件和本地预览默认共用这个数据目录。当前版本每个数据目录只应运行一个服务进程；切换使用方式时先关闭原进程，避免多个实例写入同一档案。需要独立实例时，在启动前设置 `LOCUS_DATA_DIR` 指向另一目录；已有高级 `LOCUS_STATE_PATH` / `LOCUS_CATALOG_DIR` 设置仍优先。更新前应备份自己的数据目录。

- 找不到 `node`：检查 PATH，必要时在客户端配置中把 command 改成 Node 的绝对路径。
- 找不到模块：完整重新解压，确保 `node_modules` 与 `dist` 同在插件根目录，不要只拷贝启动文件。
- 插件没有出现在目录中：核对市场根目录与来源，重启客户端；必要时运行 `codex plugin marketplace list` 检查登记的路径。
- 有页面但没有文件入口：最新规范把原生文件入口、文件访问与 composer mentions 列为桌面能力；不要用网页或手机是否出现这些入口判断安装成功。

## 网页版 ChatGPT 与公开分享

这个包没有已部署的远程地址。不能在 ChatGPT 网页添加 `127.0.0.1`、磁盘路径或 ZIP 来代替远程 MCP 服务。官方开发者连接流程使用公网 HTTPS 或 Secure MCP Tunnel，公开提交需要部署的 HTTPS 端点；本项目尚未完成远程认证、多人数据隔离、注册服务 MRTR 表单及原生宿主验收。参见 [官方连接与测试流程](https://developers.openai.com/plugins/deploy/connect-chatgpt)。本次没有创建隧道、部署服务器或发布到公共目录。

能力按 [MCP Extensions 规范](https://github.com/openai/mcp-extensions/blob/ca16cb3bc015baaa1b849082d8755bbef18770cb/docs/spec.md) 核对；其中 Web 指 Work browser，不包含 classic ChatGPT。完整代码核对记录见插件里的 `docs/spec-audit-2026-10-05.md`。

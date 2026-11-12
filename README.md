# 霁羽 · Jiyu

<img align="right" src="assets/readme/jiyu-mascot.png" width="260" alt="霁羽：手持信件的银发信使" />

**雪霁捎信，连接不止。**

霁羽是一个独立维护的 QQ 互操作项目。它将 QQ 会话中的消息和事件整理为 OneBot v11 接口，让机器人、脚本和其他应用可以通过统一的方式接入。

项目提供 WebUI、多账号管理、HTTP / WebSocket 适配，以及供开发者使用的 SDK 和 MCP 工具。与此同时，霁羽正在研究不依赖 QQ 客户端或 Hook 的独立协议实现。

[快速开始](#快速开始) · [独立协议进展](#独立协议进展) · [开发与文档](#开发与文档) · [问题反馈](https://github.com/shizukugo/Jiyu/issues)

<br clear="both" />

> [!CAUTION]
> **霁羽（Jiyu）是独立的第三方项目，与腾讯 / QQ 无隶属或授权关系。**项目仅供学习与技术研究，请遵守《QQ 用户协议》及适用法律；软件按“现状”提供，使用风险自负。详见 [EULA.md](EULA.md)。
>
> **Disclaimer:** Jiyu is an independent third-party project, unaffiliated with Tencent / QQ. It is provided for study and research only, “as is” and without warranty.

## 霁羽能做什么

| 功能 | 说明 |
| --- | --- |
| OneBot v11 | 将 QQ 事件转换为 OneBot 事件，并提供动作接口供应用调用。 |
| HTTP 与 WebSocket | 支持 HTTP 服务端 / 上报，以及 WebSocket 服务端 / 客户端接入。 |
| 多账号 | 按账号管理会话、身份映射、消息存储和连接配置。 |
| 消息与媒体 | 处理文本、图片、语音、视频、文件、回复、提及、转发及常见卡片。 |
| WebUI | 查看账号状态和日志，配置连接，并调试 OneBot 动作。 |
| 开发者工具 | 提供 TypeScript SDK 和 MCP 工具，方便构建自己的应用。 |

**当前运行方式：**正式运行时仍依赖 QQ 客户端进程和 Hook。独立协议部分尚处于研发阶段，暂未替代当前接入方式。

## 快速开始

### 环境要求

- Node.js **24.22.1 及以上的 24.x**，或 **26.12.1 及以上**；不支持 25.x。
- pnpm **11.25.0**。
- 当前接入方式所需的 QQ 客户端及相应运行环境。

仓库包含 Windows x64、Linux x64 和 Linux arm64 对应的原生构建输入；实际可用性还取决于平台和客户端环境。

### 从源码构建

```bash
git clone https://github.com/shizukugo/Jiyu.git
cd Jiyu
pnpm install --frozen-lockfile
pnpm run build:all
```

构建完成后进入 `dist`：

```bash
cd dist
```

**Windows：**运行 `launcher.bat`。启动器使用 PATH 中的 Node.js。

**Linux：**运行以下命令：

```bash
chmod +x launcher.sh
./launcher.sh
```

启动后打开 `http://127.0.0.1:5099`。如果端口被占用，程序可能选择其他端口，请以启动日志显示的地址为准。首次初始化时，WebUI 初始密码会输出到启动日志；登录后按照界面引导接入 QQ 进程并配置 OneBot 连接。

### Docker 构建

仓库的 **Jiyu Docker Build** 工作流会在分支推送后构建 `linux/amd64` 镜像并执行基础检查，但该工作流不向镜像仓库推送。也可以在仓库根目录手动构建：

```bash
docker build --platform linux/amd64 -t jiyu:local .
```

镜像不包含 QQ 客户端或图形环境；构建通过不代表当前 QQ 接入环境已经配置完成。

### 更新说明

霁羽的自有更新源尚未启用：应用内更新检查、下载和更新源探测目前均不可用。若启动时发现当前安装目录或当前系统临时目录中存在历史待处理更新，程序会停止启动并保留现场。处理前请停止使用同一安装目录的其他进程，并检查相关历史临时目录、路径别名和事务记录；该检查不提供跨进程锁，也不覆盖所有历史临时目录。

## 独立协议进展

霁羽希望逐步减少对客户端进程的依赖。当前已经实现部分协议编解码、响应处理和参考格式的扫码／注册组件，并使用离线数据与本地回环测试验证这些模块。

**签名、服务端身份验证、真实 QQ 登录与互通、完整在线注册及心跳，以及接入现有 Bridge，仍在研究和实现中。**合成测试通过不代表已经可以脱离 QQ 客户端运行。

详细的静态证据、实现边界和未解决问题见 [独立协议研发记录](packages/protocol/DIRECT_PROTOCOL.md)。

## 开发与文档

```bash
pnpm typecheck
pnpm lint
pnpm test
```

| 内容 | 入口 |
| --- | --- |
| OneBot v11 | [OneBot v11 规范](https://github.com/botuniverse/onebot-11) |
| WebUI | [WebUI 文档](packages/webui/README.md) |
| TypeScript SDK | [SDK 文档](packages/sdk/README.md) |
| MCP | [MCP 文档](packages/mcp/README.md) |
| 独立协议 | [协议研发记录](packages/protocol/DIRECT_PROTOCOL.md) |
| 计划 | [RoadMap.md](RoadMap.md) |

仓库内部的包名、配置项和命令目前仍使用 `@snowluma/*` 与 `SNOWLUMA_*`；这些是现有兼容接口，并不表示霁羽已发布自己的同名软件包。部分包文档仍可能保留原项目的更新或发布说明，请以本 README 和当前实现为准。

遇到问题或有改进建议，可以在 [Jiyu Issues](https://github.com/shizukugo/Jiyu/issues) 反馈。

## 霁羽的贡献者

以下展示的是 **Jiyu 仓库**的 GitHub 提交贡献者统计；其他形式的贡献未必包含在内。

<a href="https://github.com/shizukugo/Jiyu/graphs/contributors"><img src="https://contrib.rocks/image?repo=shizukugo/Jiyu" alt="Jiyu 仓库贡献者" /></a>

## 来源与许可

霁羽独立维护，与 SnowLuma 官方项目无隶属关系。本仓库参考了 SnowLuma 的架构与实现，也保留了部分源自 SnowLuma 的代码和资源；相关著作权、署名与原有许可声明继续适用。项目还参考了 [LagrangeV2](https://github.com/LagrangeDev/LagrangeV2) 的协议定义和 [NapCatQQ](https://github.com/NapNeko/NapCatQQ) 的实现思路。

仓库保留的 [LICENSE](LICENSE) 是**源码可见非商业许可，并非 OSI 开源许可**。商业使用、基于本软件开发或发布其他项目，以及公开发布修改版或衍生版，均须遵守其中的事先书面授权条件；随附原生附加组件的许可范围另见该文件。使用前请同时阅读 [EULA.md](EULA.md) 和 [PRIVACY.md](PRIVACY.md)。

原项目声明：SnowLuma 是独立的第三方项目，与腾讯 / QQ 无隶属或授权关系。项目仅供学习与技术研究，请遵守《QQ 用户协议》及适用法律；软件按“现状”提供，使用风险自负。详见 [EULA.md](EULA.md)。

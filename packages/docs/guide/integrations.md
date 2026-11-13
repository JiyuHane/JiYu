# OneBot、WebUI、SDK 与 MCP

## OneBot

OneBot 层负责动作校验与分发、事件转换、消息存储以及 HTTP / WebSocket 适配。根据你的应用选择对应的传输方式，按账号配置连接和访问凭据。

- [OneBot v11 规范](https://github.com/botuniverse/onebot-11)
- [OneBot 12 候选标准](https://12.onebot.dev/)
- [霁羽 OneBot 12 配置与支持范围](https://github.com/JiyuHane/JiYu/blob/dev/packages/onebot/ONEBOT_V12.md)
- [HTTP SSE 事件流说明](https://github.com/JiyuHane/Jiyu/blob/dev/packages/onebot/HTTP_SSE.md)
- [OneBot 实现目录](https://github.com/JiyuHane/Jiyu/tree/dev/packages/onebot)

## WebUI

WebUI 管理运行状态、OneBot 配置和日志；它需要对应的运行时后端。首次登录和地址说明见[快速开始](/guide/getting-started)。

- [WebUI 使用与交互说明](https://github.com/JiyuHane/Jiyu/blob/dev/packages/webui/README.md)

### 本地插件

在「系统设置 → 霁羽 → 插件」中可以浏览社区索引，并按账号显式启用手动放在 `data/plugin-packages/<插件 ID>` 下的本地插件。插件在霁羽主进程内运行，具有该进程的权限；停用不等于卸载，也不保证插件自行启动的后台任务全部结束。社区索引仅提供第三方元数据，列入索引不代表已经安装或与霁羽兼容。

插件兼容层是独立实现的部分 NapCat 接口，原项目及各插件的作者和许可声明保持独立。具体支持范围、目录和已知限制见[插件兼容说明](https://github.com/JiyuHane/JiYu/blob/dev/packages/onebot/PLUGIN_COMPAT.md)。

## TypeScript SDK

仓库内的 TypeScript SDK 使用包名 `@harehane/sdk`，提供 OneBot HTTP / WebSocket 客户端、事件处理中间件与消息构造工具。原有 `@snowluma/sdk` 包名并非自动别名；包的发布状态和可用版本以对应 npm 条目为准。

- [SDK 指南](https://github.com/JiyuHane/Jiyu/blob/dev/packages/sdk/README.md)
- [消息构造与事件](https://github.com/JiyuHane/Jiyu/blob/dev/packages/sdk/MESSAGING.md)
- [流式传输](https://github.com/JiyuHane/Jiyu/blob/dev/packages/sdk/STREAMING.md)

## MCP

仓库内 MCP 服务默认提供动作目录查询；连接 OneBot HTTP 端点后可按配置启用执行能力，写操作有单独的模式开关。详细参数和模式见仓库指南。

- [MCP 指南](https://github.com/JiyuHane/Jiyu/blob/dev/packages/mcp/README.md)
- [MCP Agent 功能](https://github.com/JiyuHane/Jiyu/blob/dev/packages/mcp/AGENT_FEATURES.md)

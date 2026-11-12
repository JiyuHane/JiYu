# OneBot、WebUI、SDK 与 MCP

## OneBot

OneBot 层负责动作校验与分发、事件转换、消息存储以及 HTTP / WebSocket 适配。根据你的应用选择对应的传输方式，按账号配置连接和访问凭据。

- [OneBot v11 规范](https://github.com/botuniverse/onebot-11)
- [HTTP SSE 事件流说明](https://github.com/JiyuHane/Jiyu/blob/dev/packages/onebot/HTTP_SSE.md)
- [OneBot 实现目录](https://github.com/JiyuHane/Jiyu/tree/dev/packages/onebot)

## WebUI

WebUI 管理运行状态、OneBot 配置和日志；它需要对应的运行时后端。首次登录和地址说明见[快速开始](/guide/getting-started)。

- [WebUI 使用与交互说明](https://github.com/JiyuHane/Jiyu/blob/dev/packages/webui/README.md)

## TypeScript SDK

仓库内的 `@snowluma/sdk` 提供 OneBot HTTP / WebSocket 客户端、事件处理中间件与消息构造工具。包名是现有兼容接口；请按仓库中的版本和说明使用，勿将上游包的发布状态当作霁羽自己的发布状态。

- [SDK 指南](https://github.com/JiyuHane/Jiyu/blob/dev/packages/sdk/README.md)
- [消息构造与事件](https://github.com/JiyuHane/Jiyu/blob/dev/packages/sdk/MESSAGING.md)
- [流式传输](https://github.com/JiyuHane/Jiyu/blob/dev/packages/sdk/STREAMING.md)

## MCP

仓库内 MCP 服务默认提供动作目录查询；连接 OneBot HTTP 端点后可按配置启用执行能力，写操作有单独的模式开关。详细参数和模式见仓库指南。

- [MCP 指南](https://github.com/JiyuHane/Jiyu/blob/dev/packages/mcp/README.md)
- [MCP Agent 功能](https://github.com/JiyuHane/Jiyu/blob/dev/packages/mcp/AGENT_FEATURES.md)

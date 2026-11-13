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

已启用的插件可显式读取其静态配置描述与配置，并对受支持的简单字段调用插件的保存钩子；配置操作可能执行插件代码，读取配置和保存分别调用插件钩子。设置界面不支持插件自定义 HTML 或动态配置控件。保存成功表示插件钩子已返回，持久化由插件决定；同账号插件重启后需重新读取，其他并发修改也可能被整体保存覆盖。数值遵循 JavaScript Number 语义，不保留原始 JSON 数字写法。

第三方插件由其作者或提供方独立开发、维护和运营，霁羽与其无从属或合作关系，展示不代表背书。霁羽不对第三方插件的代码、数据处理、运行结果及相关损失承担责任；相关问题请联系对应插件作者或提供方。

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

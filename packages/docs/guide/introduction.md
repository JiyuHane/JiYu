# 认识霁羽

霁羽（Jiyu）是独立维护的 QQ 互操作项目：它将 QQ 会话中的消息与事件整理为 OneBot v11 接口，让机器人、脚本和其他应用以统一方式接入。

## 项目提供什么

- **OneBot v11**：动作、事件及 HTTP / WebSocket 适配。
- **WebUI**：查看账号状态和日志，配置连接并调试动作。
- **开发者工具**：TypeScript SDK 和 MCP 服务。
- **多账号**：按账号管理会话、身份映射、消息存储和连接配置。

霁羽侧重协议运行时，机器人的工作流和回复逻辑由接入方实现。功能的具体适用范围以对应模块和实际运行结果为准。

::: warning 当前接入方式
当前运行仍依赖 QQ 客户端进程和 Hook；独立协议是尚未接入正式运行链路的研究模块。详情见[运行方式与现状](/guide/runtime)及[独立协议研究](/guide/protocol)。
:::

霁羽是独立第三方项目，与腾讯 / QQ 无隶属或授权关系。仓库内部仍有 `@snowluma/*` 包名和 `SNOWLUMA_*` 配置项，这是现有兼容接口，并不表示霁羽已发布自己的同名软件包。

## 许可与来源

霁羽独立维护，仓库保留了部分源自 SnowLuma 的代码、资源和许可声明。[LICENSE](https://github.com/JiyuHane/Jiyu/blob/dev/LICENSE) 是源码可见非商业许可，并非 OSI 开源许可；原生附加组件与第三方组件分别适用其中说明的许可。项目身份、许可来源和有限数据处理信息见[霁羽项目说明](https://github.com/JiyuHane/Jiyu/blob/dev/JIYU_NOTICE.md)；使用前也请阅读 [EULA](https://github.com/JiyuHane/Jiyu/blob/dev/EULA.md) 和 [PRIVACY](https://github.com/JiyuHane/Jiyu/blob/dev/PRIVACY.md)。

# 霁羽项目说明 / Jiyu project notice

## 项目与来源 / Project and origin

霁羽（Jiyu）是独立维护的 QQ 互操作项目，仓库为 <https://github.com/JiyuHane/Jiyu>。项目继承了部分 SnowLuma 软件、资源和原始声明，并研究减少对 QQ 客户端进程及 Hook 依赖的实现。霁羽与 SnowLuma 官方项目独立维护；现存的 `SnowLuma` 名称、包名与配置标识也可能用于兼容。

Jiyu is an independently maintained QQ interoperability project at <https://github.com/JiyuHane/Jiyu>. It inherits parts of the SnowLuma software, assets and original notices, and researches implementations with less dependence on QQ client processes and hooks. Jiyu is maintained independently of the official SnowLuma project; existing `SnowLuma` names, package names and configuration identifiers may also serve compatibility purposes.

## 版权与许可 / Copyright and licensing

- 本仓库保留 SnowLumaDevs 的原著作权署名、[LICENSE](LICENSE) 完整原文，以及 [EULA.md](EULA.md) 和 [PRIVACY.md](PRIVACY.md) 中 SnowLuma 随附原始文件的全文。EULA 和隐私说明前的霁羽维护说明用于区分来源，并非对原文的替换。
- The repository retains SnowLumaDevs' original copyright attribution, the complete original [LICENSE](LICENSE), and the full text of the SnowLuma documents accompanying [EULA.md](EULA.md) and [PRIVACY.md](PRIVACY.md). The Jiyu maintenance notes preceding those documents identify their origin; they do not replace the original text.
- 原 `LICENSE` 是源码可见非商业许可，并非 OSI 定义的开源许可。它对商业使用、基于该软件开发、发布或分发其他项目、公开发布修改版或衍生版等事项设有事先取得著作权人书面授权的要求，具体以原文为准。本说明不判断任何人是否已取得该授权。
- The original `LICENSE` is a source-available non-commercial license, not an OSI-defined open-source license. It requires prior written authorization from the copyright holder for matters including commercial use, developing, publishing or distributing another project based on the software, and publicly releasing modified or derivative versions; consult the original text for the exact terms. This notice makes no determination about whether any person has obtained such authorization.
- 专有原生组件不属于原源码许可的授权范围，相关权利和使用条件须另行查看原许可及适用的随附条款；第三方组件遵循各自许可。
- Proprietary native components are outside the original source license's grant; consult the original license and applicable accompanying terms separately for their rights and conditions. Third-party components follow their respective licenses.
- 原 EULA 第 5.4 条对将专有组件并入第三方 Docker 镜像、通过自动化脚本部署等事项另有事先书面授权要求；仓库提供构建工作流不代表这些事项的授权状态已获确认。
- Section 5.4 of the original EULA separately requires prior written authorization for matters including bundling proprietary components in third-party Docker images or deploying them through automation. Providing a build workflow does not establish that such authorization has been confirmed.

## 数据处理：有限信息 / Data handling: limited information

当前源码表明，运行时可能处理 QQ 账号、消息、配置及日志等信息。根据使用的功能、部署与用户配置，连接和数据传输可能涉及 QQ 服务及 CDN、OneBot HTTP 上报或反向 WebSocket、通知 Webhook 或邮件服务、媒体地址以及自定义外部服务，例如音乐签名服务。部分登录或相关功能可能涉及账号信息、会话或其他凭据；本地日志、控制台输出和可选备份也可能包含敏感信息。浏览器加载的资源请求与服务端请求的发起主体可能不同。

The current source indicates that runtime operation may process information such as QQ accounts, messages, configuration and logs. Depending on features used, deployment and user configuration, connections and data transfers may involve QQ services and CDNs, OneBot HTTP reporting or reverse WebSocket connections, notification webhooks or mail services, media URLs, and custom external services such as music-signing services. Some login or related features may involve account information, sessions or other credentials; local logs, console output and optional backups may also contain sensitive information. Browser resource requests and server-side requests may have different initiators.

以上示例并非完整数据流清单，也不是所有构建或部署的处理承诺。具体接收方、数据类别、保存期限以及遥测状况仍需结合实际版本、配置、外部依赖及部署环境核实。SnowLuma 原始隐私说明中的各项声明保留其原始语境，不自动视为霁羽已经核验并生效的承诺。

These examples are not an exhaustive data-flow inventory or a commitment covering every build or deployment. Specific recipients, data categories, retention periods and telemetry status require verification against the actual version, configuration, external dependencies and deployment environment. Statements in SnowLuma's original privacy notice retain their original context and are not automatically verified, effective commitments by Jiyu.

## 联系与说明性质 / Contact and status

一般项目问题可在 [Jiyu Issues](https://github.com/JiyuHane/Jiyu/issues) 咨询；安全或隐私问题也可先在公开 issue 咨询合适的私下联系渠道，**请勿公开粘贴个人信息、凭据或敏感日志**。目前尚未确认专门的霁羽隐私或安全邮箱。

General project questions may be raised at [Jiyu Issues](https://github.com/JiyuHane/Jiyu/issues). For security or privacy matters, a public issue may be used to ask for an appropriate private contact channel; **do not post personal information, credentials or sensitive logs**. A dedicated Jiyu privacy or security email address has not been confirmed.

本文件仅为项目说明，不是新的 EULA 或正式隐私政策，不自行确立自然人或法定主体，也不修改原许可或转移原权利。正式条款或隐私政策可在维护者确认相关事实与主体后另行起草。

This document is a project notice, not a new EULA or formal privacy policy. It does not itself establish a natural person or legal entity, amend the original license, or transfer original rights. Formal terms or a privacy policy may be drafted separately after the maintainer confirms the relevant facts and responsible parties.

# Jiyu / 霁羽：显式直连注册验证器

本工具复用现有 WT multiplex owner 与本地 signer adapter。仅在显式调用时建立 TCP 和启动签名进程；导入、构建、`--help` 均无登录副作用。它是扫码注册验证器，尚未接入 Core / WebUI / OneBot；静态构建和隔离测试不代表真实 QQ 登录成功。

## 使用

在仓库根目录，使用项目要求的 Node 版本：

```sh
node tools/direct-qq-login/build.mjs
node tools/direct-qq-login/test.mjs
node node_modules/typescript/bin/tsc -p tools/direct-qq-login/tsconfig.json
node node_modules/.cache/jiyu-direct-login/runner.mjs --help
node node_modules/.cache/jiyu-direct-login/runner.mjs --config /PRIVATE/config.json
# 完成注册后立即关闭，而非短时持有：
node node_modules/.cache/jiyu-direct-login/runner.mjs --config /PRIVATE/config.json --close-after-register
```

构建使用现有 Proton Vite 插件，产物只进入被忽略的缓存目录，不调整根依赖、Core 或发布构建。复制并填写 [候选配置](config.example.json)，将实际配置保存在私有且不受 Git 跟踪的位置。所有字段显式给出，未知字段报配置错误；`signer.executable/args/cwd` 由调用者提供，支持本地进程或调用者自行配置的 SSH 命令，工具不会推断 SSH 密钥或主机。子进程使用 `shell:false`。

`statePath` 是只含版本与随机 16 字节 GUID 的持久文件。首次独占创建，后续复用；损坏状态报错而非重置设备。`outDir` 是唯一二维码输出目录；只写随机命名 PNG/JPEG，不写 URL、二维码签名或票据。二维码保留在该私有目录供操作者查看和管理。POSIX 新目录/文件权限为 0700/0600，现有二维码目录和状态文件须无组/其他用户权限；Windows 请由调用者配置私有 ACL。路径可以相对配置文件，推荐私有绝对路径；本目录的 `*.local.json`、`state/`、`qr/` 已忽略。

JSONL 状态包括 `qr-ready`（含 `qrImage` 路径）、`waiting-scan`、`waiting-confirmation`、`confirmed`、`registering`、`online`、`failed`、`closed`。轮询间隔固定为 2000ms。全流程有 `attemptTimeoutMs`，签名、连接、每笔事务也有独立时限。只有真正完成登录票据取得、UID 投影及注册响应的 `retCode=0` 且业务值精确为 `register success` 才打印 `online`。流程不会自动发消息。

`onlineHoldMs` 为注册后显式持有窗口，范围 0–900000ms（15 分钟）；[候选配置](config.example.json) 仍为 15000ms，JSON 字段与原有三参数调用保持兼容。持有值在调用入口快照，后续修改配置对象不会更改本次时限。没有自动 heartbeat/Alive 调度，也不保证服务端在整个窗口内保持连接；它不是持续 Bridge。底层 lease 从 owner 创建时起计算，包含剩余登录时限与持有窗口，最大 1500000ms，低于其 `0x7fffffff` 上限。SIGINT/SIGTERM、超时、失败和显式关闭都等待已启动的资源创建与实际 TCP/签名子进程关闭。只保证 adapter 的直接子进程清理；远端 SSH 执行生命周期由调用者的 signer 命令负责。

## 同一次扫码继续使用 owner

缓存中的 ESM 入口也导出 `readConfig`、`startDirectLogin`，导入不会执行 CLI：

```js
import { readConfig, startDirectLogin } from './node_modules/.cache/jiyu-direct-login/runner.mjs';
const config = await readConfig('/PRIVATE/config.json');
const controller = await startDirectLogin(config, (event) => console.log(JSON.stringify(event)));
// controller.owner 是同一 TCP/ECDH/登录上下文的现有 WtMultiplexReference。
// 业务调用须由调用方显式发起；本工具没有收件人，也不自动发消息。
try {
  // 由调用者接续现有 owner；短持有时限仍生效。
} finally {
  await controller.close();
}
```

默认 `controller.confirmedUin` 仅作为调用方内存身份，不写日志/状态文件；显式启用下述 vault 时，身份与票据一起加密保存。`whenClosed` 和 `close()` 成功结算表示资源清理结束；任一清理失败仍等待其余资源结算，再以固定错误码保留失败结果。后续扩展应复用 owner，不在同一 socket 上另叠 packet client。

## 加密账号保存与显式恢复

默认关闭。旧 JSON v1 配置、三/四参数调用和仅有历史文件的情况都不会自动启用持久化。当前 vault 支持 Linux；其它平台在接触设备/二维码路径前返回 `account-store-platform-unsupported`。将数据放在稳定私有目录，勿放进 `node_modules`、构建缓存或临时目录；若使用虚拟机，其完整磁盘/backing chain 也要独立持久保存。

```sh
# 首次扫码：真正注册并完成加密落盘后才报告 online。
node node_modules/.cache/jiyu-direct-login/runner.mjs --config /PRIVATE/config.json \
  --save-account --account-vault /PRIVATE/state/vault --account-keys /PRIVATE/config/keys \
  --account-slot 0123456789abcdef0123456789abcdef --close-after-register

# 后续显式恢复：UIN 是所保存账号的 QQ 号；不会取新二维码或重放业务。
node node_modules/.cache/jiyu-direct-login/runner.mjs --config /PRIVATE/config.json \
  --restore-account UIN --account-vault /PRIVATE/state/vault --account-keys /PRIVATE/config/keys \
  --account-slot 0123456789abcdef0123456789abcdef --close-after-register
```

三个路径/槽位参数必须和保存或恢复模式一起给出；两种模式互斥，`slotId` 是32位小写十六进制。`statePath` 仍只保存设备 GUID；恢复只读现有 GUID，缺失、损坏、链接或不可信父路径都报错，不随机生成替代身份。保持原来的 profile、签名命令集合和 native build/hash；网关及可执行文件位置不属于账号协议身份。

```js
import { readConfig, startDirectLogin, restoreDirectLogin } from './node_modules/.cache/jiyu-direct-login/runner.mjs';
const config = await readConfig('/PRIVATE/config.json');
const signal = new AbortController().signal;
const onState = (event) => console.log(JSON.stringify(event));
const store = {
  vaultRoot: '/PRIVATE/state/vault',
  keyRoot: '/PRIVATE/config/keys',
  slotId: '0123456789abcdef0123456789abcdef',
};
const first = await startDirectLogin(config, onState, signal, undefined, store);
const uin = first.confirmedUin;
await first.close();
const restored = await restoreDirectLogin(config, { ...store, uin }, onState, signal);
// restored.owner 复用同一套活动业务接口；没有 fetch/poll/loginAndRegister 或假 qrImage。
await restored.close();
```

- [vault](<account-vault.ts>) 保存有界二进制快照：UIN、UID、GUID、D2、D2Key、A1、A2。AES-256-GCM、独立随机主密钥和每条随机 salt/nonce；认证绑定账号、协议/profile 摘要、设备、槽位、代际。票据不转为 JSON/base64 字符串，不出现在状态日志。
- 使用0700/0600、可信父链、同fd属性复查、独占 `flock`、CAS和存活 guard。提交顺序为临时文件 fsync → rename → 目录 fsync；rename 后失败明确报 `commit-uncertain`，不会冒充 durable 或盲目回滚。单 vault 同时只由一个进程持有。
- [适配层](<account-persistence.ts>) 在真实注册及密钥 capability 提交后等待 checkpoint；期间不交付 online。`saving-account`、`account-saved` 与 `accountRevision` 只描述本地持久化；`opening-account-store`、`loading-account`、`restoring` 也不等于上线。
- 恢复在新连接、新 owner/reservation 下真正执行 SsoInfoSync；认证解密文件只是加载成功。注册响应通过原账户/序列/命令/原始帧检查和业务判断后才 online。既有消息、好友及心跳调用仍需显式发起。
- 当前恢复只使用保存的 D2/D2Key/A2 注册，不做 A1 自动换票、自动 QR 回退或定时续登。有效期尚未确定；失败保留原文件。普通 close 擦 RAM，不删除凭据；库的显式 `revoke` 使用认证 tombstone，CLI 不自动调用它。
- 备份时一起保护 vault、独立 key 目录、设备状态和原配置。遗失主密钥时不生成新密钥覆盖旧记录。加密文件与主密钥同属当前系统用户；不宣称对该用户或系统管理员隔离，也没有外部防回滚锚点。

当前协议矩阵1289项、工具层288项通过；另有真实 Linux vault/崩溃测试9项和设备状态读取测试25项。真实 QQ 扫码后已完成加密保存、上线及好友申请。随后在全新 Node/签名进程中从保存的凭据直接完成 SsoInfoSync，未取二维码、未重放申请；SsoHeartBeat 与25次 Alive 回复成功，配置/同步推送正常。恢复前后密文字节保持一致。测试会话已主动关闭，数据保留；这证明本次保存及新进程恢复，不证明票据无限有效或已实现自动续期。

可复现的验证命令与本轮结果：

```sh
# 64 files / 1289 tests passed
pnpm --filter @snowluma/protocol test tests/direct/wt tests/direct/sso-reference tests/direct/raw-session --maxWorkers=2
# 4 files / 288 tests passed
node tools/direct-qq-login/test.mjs --maxWorkers=2
# strict tool typecheck and full release build passed
pnpm exec tsc -p tools/direct-qq-login/tsconfig.json
pnpm run build:all
```

上述定向回归和构建结果不等于整个工作区测试在所有平台均通过；Windows 上既有符号链接权限限制需与本轮真实 Linux 验证区分。

## 显式接收已验证推送正文

默认仍只接收状态事件，不向调用者交付消息正文，也不在日志中记录正文。第四参数是可选的 `DirectLoginPushOptions`，同时要求 `onPushBody` 与 `maxPushBodyBytes`；错误参数在创建文件、启动签名进程或连接网络前报配置错误。

```js
// onMessage 由调用者实现；只消费收到的正文，不隐含任何自动回复。
async function connectWithMessages(config, onMessage, signal) {
  return startDirectLogin(config, (event) => console.log(JSON.stringify(event)), signal, {
    maxPushBodyBytes: 64 * 1024,
    onPushBody: onMessage,
  });
}
```

- 回调为 `(body: Uint8Array, meta) => void | Promise<void>`。`body` 是现有 owner 解密并解压后的 SSO 业务正文，通常是 MsgPush protobuf，尚未转换为消息事件。`meta` 为只读 `{ uin, sequence, command, retCode }`；其中 `uin` 是当前登录账户，而非消息发送者，`retCode` 原样传递。
- 仅成功注册后，经现有 D2 路由、账户/命令/序列与原始收帧关联策略验证的推送才串行进入回调。注册期间排队的消息在注册成功后交付；验证失败不调用正文回调。
- 回调须按 `meta.command` 分派：实测的 `trpc.msg.olpush.OlPushService.MsgPush` 与 `ConfigPushSvc.PushReq` 都出现协议 12 和 13，分别为这两个精确命令接纳两种变体。`trpc.msg.register_proxy.RegisterProxy.InfoSyncPush` 和 `trpc.msg.register_proxy.RegisterProxy.PushParams` 仍只接受协议 12。四者都要求本账号的 D2 加密包，未知命令不泛化放行。配置／同步通知不是聊天 protobuf；工具仅有界交付，不自动解析、应用配置或回复确认。
- `maxPushBodyBytes` 范围为 1–2097152，限制解压后的独立正文副本；超限关闭 owner。现有原始帧限制仍为 2 MiB，推送队列仍限制为 32 帧／4 MiB。SSO 解压器可能先分配至其自身的 16 MiB 上限，然后再检查较小的交付限制。
- `body` 是借用缓冲区，在回调结束或会话提前关闭时擦除。如需跨异步边界留存，应在首次 `await` 前显式 `Uint8Array.from(body)`；副本的管理由调用方负责。
- 回调抛错／返回 rejected Promise 会终止 owner，丢弃后续排队交付并等待实际 TCP／签名子进程清理。回调中可 `await controller.close()`；关闭不等待任意未结束的用户回调，但会立即撤销借用正文。成功持有到期时采用同一清理路径。

工具不添加心跳调度、自动发信、Core／WebUI／Hook 或其它账户上下文。以上关联检查仍不是服务器密码学认证，含义与下面的策略说明一致。

## 已有实测与好友接口状态

Linux 客户端的本地签名链路已完成真实扫码登录、`SsoInfoSync` 注册和后续心跳；没有启动 QQ 桌面客户端、注入进程或调用公共签名服务。本地 signer 仍使用该 Linux 版本的官方原生组件，不宣称是纯算法替代。

同一 `controller.owner` 还提供实验性的 `friendRequest`，复用当前连接，支持只读设置查询和显式单次申请。参数、签名命令及结果含义见 [好友请求说明](<../../packages/protocol/DIRECT_PROTOCOL.md#experimental-linux-outbound-friend-requests>)；本 CLI 没有自动加友、自动重试或新的 OneBot action。

首次申请返回 `result=0/errorCode=0`，但接收端和发送端列表均未见生效，因此该响应本身没有证明加友成功。后续在操作者明确要求下仅追加一次申请，先完成账号加密保存，再收到 `result=1/errorCode=170` 与文本“好友添加请求已发送，需对方确认。”；**操作者已确认接收端收到并通过**。这是接收端人工验证，不把非零响应或设置查询伪装成好友列表证明，也未发送私聊。

运行时另外定位了两种分流缺口：`ConfigPushSvc.PushReq` 的协议12变体，以及好友通过后 `MsgPush` 的协议13/D2变体。两者均已按精确命令修复并通过回归，保留D2、账户和原始帧关联检查，不据此倒推首次申请未生效的原因。

## 候选参数与来源

[候选配置](config.example.json) 不是已验证的完整 54395 协议画像。每个 profile 字段都标注 `reference`、`target-metadata` 或 `local-policy`：

- **target-metadata**：目标 Linux x64 资源清单中的 version=`3.2.35-54395`、buildVersion=`54395`、appid.linux=`537391511`。后两者映射到 `clientVersion` / `subAppId` 是 **inferred candidate mapping**，并非清单中存在同名协议字段。核对的清单 SHA256 为 `68f4d6c83c396ca90fde51af1fdf4eafb40b20bd7151bc187c4128194d5afa7f`。
- **reference**：[固定 Core Linux profile](https://github.com/LagrangeDev/Lagrange.Core/blob/e1bd4baa16fa86ef000154e3eecb7816a29b63a7/Lagrange.Core/Common/BotAppInfo.cs#L33-L55) 的 AppId、SsoVersion、位图、SDK、平台和包名。该参考原始版本仍是 3.2.26-46494；该候选组合已通过本地 54395 签名链路完成真实取码、扫码确认、登录和注册；这不证明每个字段都与官方客户端逐一相同，也不证明所有业务与长时间在线均已验证。`apkSignatureHex` 是参考的 UTF-8 `com.tencent.qq`，不是 MD5。
- **local-policy**：稳定设备名、零填充 unknown21 / TLV124、随机 GUID。参考的 `Skip(21)` / `Skip(12)` 不证明原始字节为零。运行时 ECDH 与 `randomKey` 均新建且在同一 attempt 中保留；随机 16 字节 randomKey 是本地明确选择，区别于 Core 新会话初始零 16 字节、Clear 时才随机的默认行为。
- Linux PC 的 `reserve.msgType` / `ntCoreVersion` 用 JSON `null` 表示**不编码该字段**；不是 0，也不是 Android 的 32 / 100。依据 [SsoPacker](https://github.com/LagrangeDev/Lagrange.Core/blob/e1bd4baa16fa86ef000154e3eecb7816a29b63a7/Lagrange.Core/Internal/Packets/Struct/SsoPacker.cs#L100-L110)。signCommands 显式列出当前三种请求，未来接续其它命令须同步检查签名分类。
- IPv4 参考网关 `msfwifi.3g.qq.com:8080`；IPv6 `msfwifiv6.3g.qq.com:14000`，均为纯 TCP。设置对应的 `family` 与端口；不自动切网关或降级。

## 校验含义与诊断

[关联策略](policy.ts) 不是恒真回调：

1. 在本次已连接 socket 上记录真正发出的帧摘要与真正收到的完整帧摘要；校验生命周期、签名输入的账户/命令/序列/请求体摘要，以及回调中的请求/响应。摘要只驻内存，不输出。
2. WT 原始响应再次经现有 zero-key service/SSO decoder 验证 protocol、encryption、外层 UIN、命令、序列和 retCode；同时检查 requestOicq 与签名体摘要一致。
3. context 验证 SSO/operation、OICQ 命令和已有序列约束。QR OICQ UIN、Code2d UIN/序列与 businessAppId 在参考中是 opaque，检查数值域而不捏造回显等式。唯一确认账户是已验证 poll 业务中的正 uint32 UIN，等 `owner.poll()` 真正返回 confirmed 后才永久 `signer.bindUin`，再登录。
4. D2 密钥不导出给 CLI。注册/后续响应先由现有 multiplex 私有 D2 路由验证账户、命令、序列，再关联原始收发帧和签名 tuple；业务 decoder 最终判断注册成功。push 仅接受该 owner/账户的已验证路由，工具本身不记录内容。

TCP/DNS、摘要关联、序列号与 QQ-TEA **没有提供服务器密码学认证或消息 MAC**。这里的回调 true 仅表示满足本地关联策略。现有 mux 额外强制 QR 响应外层 UIN=请求 UIN 0；这不是 Core 已验证的服务器回显承诺。若实包不符，可能在 CLI context 回调前结束。

现有 decoder 已处理外层 OICQ/Code2d 头，参考 [WtLogin](https://github.com/LagrangeDev/Lagrange.Core/blob/e1bd4baa16fa86ef000154e3eecb7816a29b63a7/Lagrange.Core/Internal/Packets/Login/WtLogin.cs#L426-L492)。真实 fetch 响应已确认：三个 TLV 消费 726 字节，紧随其后仅有一个 Code2d `0x03` 结束标记。attempt 的切片回调新增可选 `trailingByte` 元数据；本策略对 fetch/poll 要求末字节确为 `0x03`，再选择 `[0, bodyLength - 1)`，login 仍为 `[0, bodyLength)`。通用 TLV 解码器继续严格检查完整长度；缺标记、错误标记和重复标记均失败，不尝试多种切片择一接受。

失败及关闭事件还包含有限白名单的 `transportClose` 和 `io` 计数：写调用数、完整接收帧数、Node socket 读写字节数。Node 写字节数可能含本地排队数据，不代表服务端收到或接受。WT 事务超时可能先取消内层请求，所以无响应时既可能看到 `raw-cancelled`，也可能看到内层自己的 `raw-timeout`；结合阶段、期限与收发计数判断。

CLI 状态日志只输出上述受限元数据，不输出底层异常文本、帧、签名、票据或账户；显式传入第四参数时，仅向调用方的回调交付正文与所述元数据，不自动写日志或文件。隔离回归使用真正的 loopback TCP 与 Node JSONL 子进程，覆盖同一上下文扫码/注册、错误账户、失败注册、取消、时限和清理；另验证 15 分钟计时器配置、旧三参数行为、注册前排队／注册后串行交付、正文与解压大小限制、回调抛错／异步失败／主动关闭以及借用缓冲区擦除。15 分钟上限采用计时器参数检查，未实等整个窗口；这些合成数据不构成真实 QQ 互通证据。

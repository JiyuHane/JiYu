# OneBot 12 本地文件传输

这里的「本地」是指文件字节暂存在霁羽运行时内存，不是让 SDK 读取本机文件路径，也不会把文件发到 QQ。请先启用对应账号的 OneBot 12 监听器，使用该监听器的地址和访问凭据。OneBot v11 接口不受影响。

## 选择接口

调用 `get_supported_actions`，核对当前监听器公布的动作；公布动作不代表支持它的所有模式或所有文件 ID。

| 场景 | 动作 | 支持范围 |
| --- | --- | --- |
| 一次提交或读取小文件 | `upload_file` / `get_file`，使用 `type: 'data'` | JSON 中的字节使用规范的带填充 Base64（需要时补 `=`）；使用返回的本地文件 ID 读取 |
| 分片上传 | `upload_file_fragmented` | `prepare` 预留空间并返回草稿 ID，`transfer` 顺序提交片段，`finish` 核对整文件 SHA-256 并返回可读取的 ID |
| 分片下载 | `get_file_fragmented` | `prepare` 返回名称、字节数和 SHA-256，`transfer` 返回指定范围；越过文件尾的范围会报错，不会被截短 |

分片读取不接受草稿 ID、旧的 v11 文件 ID 或 QQ 图片、语音和视频句柄。`get_file` 的部分 URL 模式是另一项能力，详见[服务端支持范围](https://github.com/JiyuHane/JiYu/blob/dev/packages/onebot/ONEBOT_V12.md#local-data-uploads)。本地文件能力不支持按路径或 URL 上传，也不会自动发送消息。

## TypeScript 示例：上传后读回

仓库中的 `@harehane/sdk/v12` 提供可选的 `uploadOneBot12FragmentedFile` 和 `downloadOneBot12FragmentedFile`。使用含这两个导出的 SDK 构建；仓库代码不代表 npm 当前已发布该功能。示例接收配置好的 `OneBot12HttpClient` 和应用自行准备的 `Uint8Array`，不读取磁盘或记录访问凭据。

```ts
import {
    downloadOneBot12FragmentedFile,
    uploadOneBot12FragmentedFile,
    type OneBot12HttpClient,
} from '@harehane/sdk/v12';

export async function roundTrip(
    client: OneBot12HttpClient,
    bytes: Uint8Array,
    signal?: AbortSignal,
) {
    const actions = await client.request('get_supported_actions', {}, { signal });
    if (
        actions.status !== 'ok' ||
        !Array.isArray(actions.data) ||
        !actions.data.includes('upload_file_fragmented') ||
        !actions.data.includes('get_file_fragmented')
    ) {
        throw new Error('当前监听器未公布分片上传或下载动作');
    }

    const options = { maxBytes: 256 * 1024, chunkSize: 64 * 1024, timeoutMs: 15_000, signal };
    const upload = await uploadOneBot12FragmentedFile(client, 'example.bin', bytes, options);
    if (upload.status === 'failed') {
        return { operation: 'upload', result: upload } as const;
    }

    const download = await downloadOneBot12FragmentedFile(client, upload.fileId, {
        ...options,
        expectedSha256: upload.sha256,
    });
    return { operation: 'download', result: download } as const;
}
```

上传助手在预约草稿前复制输入并计算摘要；空文件跳过 `transfer`。下载助手要求每片解码长度和请求一致，整文件摘要匹配后才返回 `bytes`。示例使用上传前算出的摘要核对读回结果；仅信任服务端上报的摘要，只能验证内容是否一致，不能验证来源。

在浏览器中使用这些助手需要安全上下文提供 Web Crypto。`timeoutMs` 分别约束每次完整上传或下载，不是两者合用的期限；`signal` 可以取消示例中的各个请求。业务失败保留发生阶段及响应，输入错误、超时、校验错误等会以 Promise 拒绝返回。具体选项见 [SDK OneBot 12 指南](https://github.com/JiyuHane/JiYu/blob/dev/packages/sdk/ONEBOT_V12.md#opt-in-bounded-upload)。

## 容量、生命周期与失败处理

- 霁羽单文件最多 **256 KiB**。每个监听器的草稿和已完成文件合计最多 **32 项、4 MiB**，达到上限时不会主动淘汰尚未过期的项目。
- 文件 ID 只对同一账号、同一监听器代际有效。分片上传的有效期从 `prepare` 开始，普通上传从初次上传开始，均为 **10 分钟**；读写不会续期，关闭或更换监听器会使旧 ID 失效。
- SDK 不自动重试、断点续传或回滚。超时、取消或响应丢失时，服务端可能已记录分片甚至完成上传；不要把失败当作未发生写入。没有取消草稿的动作，未完成草稿可能占用配额直到过期或监听器关闭。
- 当前验证使用内存数据、假传输和 OneBot 运行时夹具；不代表真实 QQ 文件互通、其他 OneBot 实现或线上网络已经验证。

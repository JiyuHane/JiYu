# Jiyu 本地签名工作进程

[worker.py](worker.py) 是独立、显式启动的 Python JSONL 工作进程。它加载指定版本的 QQ Linux 原生组件并调用该组件的签名入口；**不是纯 TypeScript/Python 签名算法移植**。这里没有公共签名服务、HTTP 监听、QQ 桌面启动、进程查找或 Hook，也没有账号/UIN 参数。应用接线由调用方持有的子进程适配器负责。

Jiyu（霁羽）是独立维护的互操作项目，继承部分 SnowLuma 内容及原始声明；保留的 `SnowLuma` 标识可能用于兼容。项目身份及权利说明见 [JIYU_NOTICE.md](../../JIYU_NOTICE.md)、原始 [LICENSE](../../LICENSE) 和贡献说明 [CONTRIBUTING.md](../../CONTRIBUTING.md)。本目录没有改写这些声明，也不把第三方组件的权利归于 Jiyu。

## 组成与执行边界

- [worker.py](worker.py)：纯输入/输出解析、ELF 检查、固定 manifest、延迟原生加载、串行 JSONL 循环。
- [test_worker.py](test_worker.py)：本地 fake backend / fake FFI 单测；不加载 QQ 组件、不连网。包括使用独立 Python 子进程验证 fd 输出隔离，子进程同样只运行本目录的假实现。
- [host_symbols.c](host_symbols.c)：仅导出 `void qq_magic_napi_register(void *)` 空实现。它只满足宿主符号名称，不实现 N-API，不注册实际 QQ 宿主。

导入模块、显示 `--help`、运行单测均不触发原生加载。生产路径只通过显式 CLI 启动；不要在应用进程内直接实例化 `NativeBackend`，否则 CLI 的文件描述符隔离和进程生命周期隔离不会生效。本工具未加入自动启动、安装脚本或默认测试任务。

## 固定版本与静态 ABI 依据

仅接受如下 manifest；没有 `--rva`、`--sha256`、环境变量偏移或扫描猜测功能：

| 项目 | 固定值 |
| --- | --- |
| 构建 | QQ Linux `3.2.35-54395` |
| 文件 | 调用方提供的 `wrapper.node`，ELF64 little-endian、x86-64、ET_DYN |
| SHA-256 | `dc5209e20002735e31a20c9cded0a807d1db4779277dec66c9221ea28a870328` |
| MSFSign RVA | `0x6856284` |
| RX PT_LOAD | VA `0x299e300`，文件偏移 `0x299d300`，filesz/memsz `0x6475100` |

本次独立静态复核使用只读 radare2 fallback；该分析会话未注册 REA MCP，未重复安装。完整文件 SHA-256 与上表相符；ELF 程序头确认 RX 区间为 `[0x299e300, 0x8e13400)`。在此代码段内 VA = 文件偏移 + `0x1000`，所以只读 raw 映射用 `-m0x1000`；这个映射不适用于所有 rodata/其他段。复核命令示意：

```sh
radare2 -N -n -a x86 -b64 -m0x1000 -q \
  -c 'e scr.color=0; s 0x3523110; pd 125; s 0x352329a; pd 52; s 0x6856284; pd 96' \
  /absolute/path/to/wrapper.node
```

从已知 caller entry `0x3523110` 对齐解码，`0x3523278–0x352329a` 选择 command 的 C 字符串地址，设置 body/length/32-bit value/out 并调用 `0x6856284`。被调入口 `0x6856295–0x68562a2` 保存对应寄存器：

| SysV 寄存器 | worker 传入值 |
| --- | --- |
| `rdi` | 以 NUL 结尾的 ASCII command |
| `rsi` | body 地址；空 body 仍分配至少 1 字节可用存储 |
| `edx` | body 的 32-bit 字节长度 |
| `ecx` | `sequence` 的原始 u32 位模式 |
| `r8` | 0x300 字节输出区地址 |

输入协议将第四参数命名为 `sequence`，值不做有符号范围收窄，位模式保持不变。此前将日志 `module_id` 归到此参数是误读：对 `0x35232a5–0x35232e5` 及 formatter 的复核表明，该占位实际接收 command 字符串，另一个占位接收 body 长度。上游 `SendMsfRequestInternal` 的已观察 seq 数据流与两份公开 standalone 的实际调用均支持传入请求 seq，而非固定 0；具体实时 QR 链路仍需验证。详见 [参数复核证据](../../packages/protocol/DIRECT_PROTOCOL.md#local-signer-and-live-login-integration-work)。函数栈上的 `[rsp+0x1a8]` 是经过六次 push 与 `sub rsp,0x178` 后的返回地址，**不是额外输入参数**。

`0x3523301–0x3523346` 及入口保存的 out 指针共同确认输出布局：

| 字段 | 数据偏移 | 长度字节偏移 | 最大长度 |
| --- | --- | --- | --- |
| token | `0x000` | `0x0ff` | 255 |
| extra | `0x100` | `0x1ff` | 255 |
| sign | `0x200` | `0x2ff` | 255 |

每次调用输出区先置零、前后加 32 字节 canary，返回后先检查 canary，再按长度字节取副本；空 sign 判失败。worker 不解释未知 native 返回值（FFI restype 为 `None`），也不把 canary 当作任意越界、崩溃或内部副作用的证明。已有更广的静态上下文见 [DIRECT_PROTOCOL.md](../../packages/protocol/DIRECT_PROTOCOL.md)。静态 ABI 核对不等于实际动态链接或签名结果已验证。

## Linux 准备与显式启动

要求 Python 3.9+、Linux x86-64/glibc、可用的 `/proc/self/fd`。使用系统提供的 `libdl.so.2`、`libgnutls.so.30`；后者通常来自发行版的 `libgnutls30` 包。原始组件及其依赖由调用方另行放置，不随本目录提供。

构建最小宿主符号库（在仓库根目录执行）：

```sh
cc -std=c11 -O2 -shared -fPIC -fvisibility=hidden \
  -Wl,-z,relro,-z,now \
  -o tools/local-qq-sign/libqq_host_symbols.so \
  tools/local-qq-sign/host_symbols.c
```

被分析组件直接声明依赖 `libvips-cpp.so.42`（样本的 sharp-lib）、`libbugly.so`（样本 app 目录）、`libX11.so.6`、`libX11-xcb.so.1`、`libXext.so.6`、`libuuid.so.1`、`libz.so.1`，以及标准 pthread/rt/m/gcc_s/libc/动态加载器。**部署应保留同一已校验原始包中的传递依赖及目录关系，而非只复制 wrapper、vips、bugly 三个文件。** 父任务核对的 bundled `DT_NEEDED` 链还包括：

| 引入方 | 同包依赖 | 额外系统依赖 |
| --- | --- | --- |
| `libbugly.so` | `libcrbase.so`、`libunwind-x86_64.so.8`、`libssh2.so.1` | `libgssapi_krb5.so.2` |
| `libunwind-x86_64.so.8` | `libunwind.so.8` | 标准 gcc_s/z/libc/动态加载器 |
| `libssh2.so.1` | — | `libgcrypt.so.20` |
| `libvips-cpp.so.42` | — | `libstdc++.so.6`、`libresolv.so.2` |

这些同包库应从与固定 wrapper 对应的同一 DEB 提取，保留原有 SONAME/文件名链接，并使 app、sharp-lib 及其他实际依赖目录对加载器可见；系统库则由发行版提供，并一并满足其自身的传递依赖。重复 `--preload` 只控制显式项的加载顺序，不替代其依赖闭包。父任务的首次 Linux 真实加载失败已定位到缺失上述传递依赖，尚不构成 ABI 不匹配证据；补齐依赖后的加载和实际签名仍需后续实测。

父分析记录的最高 GLIBC 版本声明为 2.17；这不替代实际发行版依赖检查。Debian 12/Python 3.11 的 92 项离线测试及 Linux helper 编译已由父任务验证通过，原生调用状态见下文。

**在启动 Python 前**设置动态加载器的查找路径。worker 不在运行中修改 `LD_LIBRARY_PATH` 并声称加载器会重新读取它。以下路径均由调用方提供并替换：

```sh
APP_DIR=/absolute/path/to/qq/resources/app
SHARP_LIB_DIR=/absolute/path/to/sharp-lib
HELPER=/absolute/path/to/libqq_host_symbols.so

LD_LIBRARY_PATH="$APP_DIR:$SHARP_LIB_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
python3 -B tools/local-qq-sign/worker.py \
  --wrapper "$APP_DIR/wrapper.node" \
  --host-symbols "$HELPER"
```

如需显式按顺序预加载，可重复 `--preload`，每项必须为绝对路径：

```sh
LD_LIBRARY_PATH="$APP_DIR:$SHARP_LIB_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
python3 -B tools/local-qq-sign/worker.py \
  --preload "$SHARP_LIB_DIR/libvips-cpp.so.42" \
  --preload "$APP_DIR/libbugly.so" \
  --wrapper "$APP_DIR/wrapper.node" \
  --host-symbols "$HELPER"
```

加载顺序为调用方给定的预加载项、`libgnutls.so.30`、helper，最后 wrapper。预加载使用 `RTLD_NOW | RTLD_GLOBAL`，wrapper 使用原始 `libdl.dlopen` 的 `RTLD_LAZY | RTLD_LOCAL`，避免 `ctypes.CDLL` 自动加入 `RTLD_NOW` 使未使用的 N-API 引用提前解析。显式预加载项本身也是可执行原生依赖，不受 wrapper 的固定哈希覆盖。

加载 wrapper 前先流式检查完整 SHA-256，再检查 ELF 头、程序头、固定 RX 布局和入口的 file-backed RX 边界。紧接着在独立 native worker 中设置并回读 `resource.RLIMIT_CORE = (0, 0)`，成功后才预加载依赖，以禁用内核 core dump；普通 import 和 fake backend 循环不改进程 limits，单测使用假 resource。该限制不控制原生组件自行写出的日志或其他文件。通过只读打开的 `/proc/self/fd/<fd>` 加载已验证 inode，描述符保留到工作进程结束；原件保持只读，不打补丁、不在样本目录落文件。inode 校验避免路径替换混入另一文件，但不是文件系统快照；调用方仍应阻止原件在验证/使用期间被原地写入。`/proc/self/fd` 路径会改变 `$ORIGIN` 解析，故前述启动前依赖路径/显式预加载是必要的部署配置，尤其是 app 和 sharp-lib 目录。

地址通过 **该次 dlopen 返回的精确 handle** 调用 `dlinfo(handle, RTLD_DI_LINKMAP, ...)` 得到 `l_addr`，再加固定 RVA；没有进程地图扫描或模块名 substring 匹配。

## JSONL 协议 1

成功加载后，stdout 第一行恰为以下结构，之后每个请求一行，串行处理，不自动重试：

```json
{"type":"ready","protocol":1,"build":"3.2.35-54395","sha256":"dc5209e20002735e31a20c9cded0a807d1db4779277dec66c9221ea28a870328"}
```

输入必须是 UTF-8 JSON 对象，仅含下列四个字段：

```json
{"id":1,"command":"test.Command","sequence":0,"body":"0001aaff"}
```

- `id`：`1..9007199254740991` 的整数；布尔值、浮点数和字符串无效。
- `command`：1..256 个 ASCII 字符，含 NUL 的值无效；不隐式 trim，不接受 Unicode 替换。
- `sequence`：`0..4294967295` 的整数；布尔值、浮点数和字符串无效。
- `body`：偶数字符数的 ASCII hex，最多 1 MiB 解码字节；可为空，可用大写输入，空白和 `0x` 前缀无效。

对象重复 key（包括 escape 后相同的 key）、未知 key、缺失 key、非 JSON、非对象、NaN/Infinity 都失败。为绑定解析器资源，额外限制 JSON 嵌套最多 16 层，整数 token 最多 17 字符（包括负号），**原始单行最多 `2 * 1048576 + 4096 = 2101248` 字节（含 LF/CRLF）**；大量空白或把整个 body 写成 `\u0030` 等 escape 的表示也受此线上限约束。正常紧凑 JSON 足以容纳最大 body。EOF 前最后一行可以没有 LF。

成功示例仅表示形状，字节来自测试假实现，不是实际 QQ 签名向量：

```json
{"id":1,"result":{"sign":"abcd","token":"12","extra":"34"}}
```

三个字段均为小写 hex，分别最多 255 字节；sign 至少 1 字节，token/extra 可空。错误仅包含固定小写 kebab-case code：

```json
{"id":1,"error":{"code":"invalid-body"}}
```

对尚未可信解析的 id（坏 JSON、重复 key、超长行或不合法 id）使用 `null`。不回显请求、路径、异常字符串、body 或命令。

| 类别 | code / 行为 |
| --- | --- |
| 输入 | `invalid-json`、`duplicate-key`、`invalid-request`、`invalid-id`、`invalid-command`、`invalid-sequence`、`invalid-body`；返回错误后继续下一行 |
| 超长 | `line-too-long`；只读到上限 + 1 字节，发送 id=null 错误后退出 1，不排空、不二次解析残片 |
| 输出 | `empty-sign`；该请求失败，可继续；`output-guard`、`invalid-output`、`native-call-failed` 则发送错误并退出 1 |
| 启动 | `invalid-arguments`、`unsupported-platform`、`image-io`、`image-changed`、`hash-mismatch`、`invalid-elf`、`abi-mismatch`、`core-limit-failed`、`preload-failed`、`dlopen-failed`、`link-map-failed`、`native-bind-failed`、`startup-failed`；发送 id=null 错误，无 ready，退出 2 |
| 生命周期 | `io-failed`、`backend-close-failed` 只作固定 stderr 诊断并退出 1；未分类请求异常为 `internal-error`，返回错误后退出 1 |

CLI 在加载前复制协议/诊断文件描述符，然后把原生组件可见的 fd 1 和 2 重定向至空设备，持续到进程退出（含析构阶段）。stdout 仅写协议；stderr 仅写 `local-qq-sign: <固定code>`，`--help` 是固定帮助文本例外。原生组件自己的 stdout/stderr 被舍弃，因此这些通道的错误细节不可用于排障；使用退出状态和固定 code。该方式不是限制组件文件/网络副作用的沙箱，Python 源码没有联网调用也不证明原生组件内部行为；实际验证应由外部环境隔离控制。

EOF 正常关闭并退出 0；SIGINT/SIGTERM 记录 `stopped` 并退出 `128 + signal`。原生库不主动 `dlclose`，其内部线程/析构状态未知，由独立进程结束回收。阻塞原生调用中的信号处理可能延迟，崩溃或加载器 fatal error 可能直接退出而没有 JSON 错误行；父适配器应使用进程退出/超时处理并终止失效子进程，不自动重放请求。释放局部可变缓冲不构成内存擦除保证。

## 离线、原生验证与待验证事项

在仓库根目录执行（不要求原始组件或 helper 文件）：

```sh
python3 -B -m unittest discover -s tools/local-qq-sign -p test_worker.py -v
```

测试覆盖输入边界/重复 key/布尔数值/深度/超长终止、三槽长度/窗口/canary、异常脱敏、精确 FFI 五参数与固定 handle 的加载编排、空 body、串行性、EOF/信号/关闭、哈希失败先于加载、导入无 ctypes/原生加载，以及原始 fd 输出隔离。它们只使用本目录的假 backend 和假 ctypes，不证明真实原生签名的正确性。

父任务已在 **Debian 12 / Python 3.11.2** 运行上述测试，**92/92 通过**，并完成 Linux helper 编译。首次原生加载发现同包传递依赖缺失；补齐同一已校验 DEB 的依赖闭包、核对 7 个 ELF 哈希和 16 项系统库加载后，实际原生调用也通过：

- 在无外部网络接口的 namespace 内以非 root 用户加载固定 ELF，调用 `wtlogin.trans_emp`、`wtlogin64.trans_emp`、`wtlogin.login`；输入是 4/4/8 字节合成业务体，序号分别为 1/2/4。
- 三次均返回 **sign 48 字节、token 0 字节、extra 0 字节**；中间穿插的 NUL 命令返回 `invalid-command`。ready、响应关联、非空签名检查和正常退出码 0 全部通过。
- [Node 进程适配器](../../packages/protocol/src/direct/local-qq-sign-worker.ts) 经本机 SSH 调用同一隔离 worker 的三次测试也通过，包括初始 UIN `0` 的排队调用、绑定合成 UIN `10001`、跨账号调用被拦截、实际子进程关闭，以及来宾侧无 worker 进程残留。没有发送真实账号请求。

这些结果证明固定构建的独立加载、实际函数调用与进程协议能够工作，**不证明 QQ 服务端接受返回值**，也不证明任意输入都应有相同长度或空 token/extra。未运行 QQ 桌面，未 attach/Hook，未完成真实扫码、登录或消息投递。整合阶段的 73 项 Node/保留字段测试、显式源码和测试严格类型检查、工作区 `pnpm typecheck` 与 `pnpm lint` 均通过；全工作区测试和发行构建尚未运行。更多证据见 [DIRECT_PROTOCOL.md](../../packages/protocol/DIRECT_PROTOCOL.md#local-signer-and-live-login-integration-work)。

## 公开参考与来源

- [Micuks/ntqq-sign-server 的 sign.py](https://raw.githubusercontent.com/Micuks/ntqq-sign-server/master/sign.py)：父任务已审阅的 standalone 调用背景。
- [nimeng1299/SignServer 的 sign.c](https://raw.githubusercontent.com/nimeng1299/SignServer/main/src/sign.c)：父任务提供的宿主注册符号 ABI 背景。

这里只根据静态 ABI 事实独立实现封送、验证和进程协议，**没有复制/移植这些项目（包括 AGPL 实现）的代码**。`qq_magic_napi_register(void *)` 空实现的声明依据是公开参考，并已用于上述固定构建的实际加载与合成输入签名验证；该结果不代表完整 N-API 兼容。参考链接不是对其许可的重授予，也不假定外部代码可按本仓库许可再分发。第三方原生组件和参考项目仍适用各自条款，本目录不附带原始 QQ 二进制或依赖。

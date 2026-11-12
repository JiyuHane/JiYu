# 快速开始

此页介绍从源码构建及现有运行方式。独立协议尚未取代 QQ 客户端接入。

## 准备环境

- Node.js **24.22.1 及以上的 24.x**，或 **26.12.1 及以上**；项目固定版本见仓库 `.node-version`。
- pnpm **11.25.0**。
- 当前接入方式所需的 QQ 客户端及相应运行环境。

仓库包含 Windows x64、Linux x64 与 Linux arm64 的原生构建输入；实际可用性取决于平台和客户端环境。

## 从源码构建

```sh
git clone https://github.com/JiyuHane/Jiyu.git
cd Jiyu
pnpm install --frozen-lockfile
pnpm run build:all
```

构建完成后进入 `dist`。Windows 下运行 `launcher.bat`；Linux 下运行：

```sh
cd dist
chmod +x launcher.sh
./launcher.sh
```

Windows 启动器使用 PATH 中的 Node.js。以上命令会启动运行时；仅构建或阅读文档时无需启动。

## 打开管理界面

启动后访问 `http://127.0.0.1:5099`。如果端口被占用，程序可能选择其他端口，以启动日志中的地址为准。首次初始化时，WebUI 初始密码输出在启动日志；登录后按照界面引导接入 QQ 进程，并配置 OneBot 连接。

下一步可阅读[运行方式与现状](/guide/runtime)和[接入与开发](/guide/integrations)。

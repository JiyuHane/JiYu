# 开发与文档

## 工作区验证

在仓库根目录安装依赖后，可以运行：

```sh
pnpm typecheck
pnpm lint
pnpm test
```

`pnpm dev` 会启动 Core 并可能连接本地 QQ 进程；`pnpm dev:web` 启动需要 WebUI 后端的前端。只修改文档时无需启动 QQ。

## 文档站

站点使用 VitePress 默认主题，文档源位于 `packages/docs`。从仓库根目录执行：

```sh
pnpm --filter @jiyu/docs dev
pnpm --filter @jiyu/docs build
pnpm --filter @jiyu/docs preview
```

默认按站点根路径构建。若部署在子路径，在构建时将 `JIYU_DOCS_BASE` 设为以 `/` 开始和结束的路径，例如 `/Jiyu/`；各段仅使用英文字母、数字、`.`、`_`、`~` 或 `-`，且不能为 `.` 或 `..`。站点面向支持现代 JavaScript 的浏览器。部署配置由维护者决定；文档站构建不会修改现有部署流程。

## 参与项目

源代码和反馈入口：[JiyuHane/Jiyu](https://github.com/JiyuHane/Jiyu)。仓库保留的[贡献指南](https://github.com/JiyuHane/Jiyu/blob/dev/CONTRIBUTING.md)和[许可](https://github.com/JiyuHane/Jiyu/blob/dev/LICENSE)包含贡献与使用条款；其中部分上游项目名称和链接可能尚未更新。

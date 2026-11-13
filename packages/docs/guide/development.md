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

文档站的目标地址为 [docs.harehane.dev](https://docs.harehane.dev/)；部署完成后仍需通过 GitHub Pages 和实际访问验收。仓库的 Jiyu Docs 工作流在推送 `dev` 时构建并部署，也支持手动触发；面向 `dev` 的 PR 仅构建。工作流使用 `JIYU_DOCS_BASE=/`，通过 GitHub Pages Actions 发布，不生成 CNAME 文件；自定义域名由仓库 Pages 设置管理。

默认按站点根路径构建。若部署在子路径，在构建时将 `JIYU_DOCS_BASE` 设为以 `/` 开始和结束的路径，例如 `/Jiyu/`；各段仅使用英文字母、数字、`.`、`_`、`~` 或 `-`，且不能为 `.` 或 `..`。站点面向支持现代 JavaScript 的浏览器。

## 参与项目

源代码和反馈入口：[JiyuHane/Jiyu](https://github.com/JiyuHane/Jiyu)。仓库保留的[贡献指南](https://github.com/JiyuHane/Jiyu/blob/dev/CONTRIBUTING.md)和[许可](https://github.com/JiyuHane/Jiyu/blob/dev/LICENSE)包含贡献与使用条款；其中部分上游项目名称和链接可能尚未更新。

import { defineConfig } from 'vitepress';

const base = process.env.JIYU_DOCS_BASE || '/';
if (
  !/^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(base) ||
  base.split('/').some((part) => part === '.' || part === '..')
) {
  throw new Error(
    'JIYU_DOCS_BASE must be / or an absolute slash-terminated path with URL-safe segments',
  );
}

export default defineConfig({
  title: '霁羽文档',
  description: '霁羽 Jiyu 的使用与开发指南',
  lang: 'zh-CN',
  // The workspace esbuild override requires a modern build target with VitePress 1.x.
  vite: { build: { target: 'esnext' } },
  base,
  head: [['link', { rel: 'icon', href: `${base}jiyu-icon.png` }]],
  themeConfig: {
    logo: '/jiyu-icon.png',
    siteTitle: '霁羽 Jiyu',
    nav: [
      { text: '指南', link: '/guide/introduction' },
      { text: '快速开始', link: '/guide/getting-started' },
      { text: '独立协议', link: '/guide/protocol' },
      { text: '源码仓库', link: 'https://github.com/JiyuHane/Jiyu' },
    ],
    sidebar: [
      {
        text: '开始使用',
        items: [
          { text: '认识霁羽', link: '/guide/introduction' },
          { text: '快速开始', link: '/guide/getting-started' },
          { text: '运行方式与现状', link: '/guide/runtime' },
        ],
      },
      {
        text: '接入与开发',
        items: [
          { text: 'OneBot、WebUI、SDK 与 MCP', link: '/guide/integrations' },
          { text: '独立协议研究', link: '/guide/protocol' },
          { text: '开发与文档', link: '/guide/development' },
        ],
      },
    ],
    search: { provider: 'local' },
    outline: { label: '本页目录', level: [2, 3] },
    docFooter: { prev: '上一篇', next: '下一篇' },
    darkModeSwitchLabel: '外观',
    sidebarMenuLabel: '菜单',
    returnToTopLabel: '返回顶部',
    footer: {
      message: '霁羽是独立维护的第三方项目。',
      copyright: '项目与第三方组件适用各自许可，详见仓库 LICENSE。',
    },
  },
});

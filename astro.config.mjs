// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import starlight from '@astrojs/starlight';
import starlightThemeSix from '@six-tech/starlight-theme-six';
import tina from '@tinacms/astro/integration';
import { tinaAdminDevRedirect } from '@tinacms/astro/vite';

const isDev = process.env.NODE_ENV === 'development';

const userManual = [
	{ label: '开始', slug: 'user-manual/getting-started' },
	{ label: '别像弱智一样提问', slug: 'user-manual/scientific-question' },
	{ label: '安装', slug: 'user-manual/installation' },
	{ label: '进阶使用', slug: 'user-manual/advance' },
	{ label: '模拟器支持', slug: 'user-manual/emulator-support' },
	{ label: '消息推送', slug: 'user-manual/notify' },
	{ label: '百鬼夜行', slug: 'user-manual/hyakkiyakou' },
	{ label: '协同系统', slug: 'user-manual/team-flow' },
	{ label: '常见问题', slug: 'user-manual/frequently-asked-questions' },
	{ label: '任务列表', slug: 'user-manual/task-list' },
	{ label: '问题反馈', slug: 'user-manual/issue-reporting' },
];

const development = [
	{ label: '导言', slug: 'development/preamble' },
	{ label: 'Pull Request', slug: 'development/pull-request' },
	{ label: '用户选项', slug: 'development/user-option' },
	{ label: '操控设备', slug: 'development/manipulation-device' },
	{ label: '过程元素', slug: 'development/process-element' },
	{ label: '调试', slug: 'development/debugging' },
	{ label: '日志系统', slug: 'development/log' },
	{ label: '异常', slug: 'development/exception' },
	{ label: '装饰器', slug: 'development/decorators' },
	{ label: '开发工具', slug: 'development/dev-tools' },
	{ label: '游戏逻辑复用', slug: 'development/game-logic-reuse' },
	{ label: '编写任务示例', slug: 'development/task-example' },
];

export default defineConfig({
	site: 'https://www.onmyojiautoscript.cn',
	output: 'static',
	adapter: node({ mode: 'middleware', experimentalDisableStreaming: true }),
	integrations: [
		tina(),
		starlight({
			customCss: ['./src/styles/custom.css'],
			plugins: [
				starlightThemeSix({
					navLinks: [
						{ label: '用户手册', link: '/user-manual/getting-started/' },
						{ label: '开发文档', link: '/development/preamble/' },
					],
				}),
			],
			title: 'OnmyojiAutoScript',
			description: '阴阳师小助手，一键托管。',
			logo: {
				src: './src/assets/logo-head.png',
				alt: 'OnmyojiAutoScript',
				replacesTitle: false,
			},
			favicon: '/img/logo.ico',
			locales: {
				root: { label: '简体中文', lang: 'zh-CN' },
			},
			// Public pages are prerendered. TinaIsland keeps the editor's
			// on-demand refresh route available for static pages.
			prerender: true,
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/runhey/OnmyojiAutoScript' },
			],
			components: {
				Header: './src/components/Header.astro',
				MarkdownContent: './src/components/TinaMarkdownContent.astro',
				PageTitle: './src/components/TinaPageTitle.astro',
			},
			sidebar: [
				{ label: '用户手册', items: userManual },
				{ label: '开发文档', items: development },
			],
			pagination: true,
			lastUpdated: true,
			credits: false,
		}),
	],
	...(isDev
		? {
			vite: {
				plugins: [tinaAdminDevRedirect()],
				server: {
					proxy: {
						// Keep the browser on Astro's port while forwarding Tina's local
						// admin UI and GraphQL endpoint to the Tina dev server.
						'/admin': 'http://localhost:4001',
						'/graphql': 'http://localhost:4001',
					},
				},
			},
		}
		: {}),
});

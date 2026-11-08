/**
 * Supabase for DeepSeek Harness: Client half.
 *
 * Registers the "Supabase" settings page: two sign-in paths (browser OAuth
 * with organization choice, or a personal access token), connection status,
 * guardrail documentation, and getting-started steps. Visible copy goes
 * through the Client locale service and styling uses only host theme tokens.
 * The page is wrapped in an error boundary so a fault shows a readable card
 * instead of an empty panel.
 */
window.__ModuleLoader__.load({
	id: 'dsh-supabase',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		// --- Locale dictionaries (en and zh are the required baselines) ------
		const DICT = {
			en: {
				nav: 'Supabase',
				title: 'Supabase',
				subtitle: 'Connect agents to Supabase projects with MCP tools, agent skills, and safety guardrails.',
				connection: 'Connection',
				tokenStateLabel: 'Access token',
				tokenConfigured: 'Configured',
				tokenMissing: 'Not configured',
				endpointLabel: 'MCP endpoint',
				endpointHelp: 'Set the SUPABASE_MCP_URL environment variable to scope to one project or to enable read-only mode, for example https://mcp.supabase.com/mcp?project_ref=<ref>&read_only=true.',
				authIntro: 'Choose whichever sign-in works best for you. Both give the agent the same tools.',
				signInTitle: 'Connect Supabase account (recommended)',
				signInBody: 'Sign in with your Supabase account in the browser. You pick the organization during sign-in, so the projects that organization owns are what this session can reach. Tokens refresh automatically.',
				signInButton: 'Open Supabase sign-in',
				signInNote: 'Opens supabase.com in a new tab and returns here automatically. If no tab opens in your shell, use the copy button and open the link in your browser.',
				copyLink: 'Copy sign-in link',
				copied: 'Copied. Paste it into your browser.',
				signInNoUrl: 'The sign-in link is not available yet. Run /supabase-auth in any session and open the link it prints.',
				tokenTitle: 'Use a personal access token',
				tokenBody: 'Best for CI, headless setups, or when browser sign-in is not available. Create a scoped token that is limited to the projects and permissions the task needs.',
				tokenLabel: 'Personal access token',
				tokenPlaceholder: 'sbp_...',
				tokenHelp: 'Stored in the DSH credential store as SUPABASE_ACCESS_TOKEN. It never appears in configuration files, chat, or model context.',
				tokenCreateLink: 'Create a token at supabase.com/dashboard/account/tokens',
				save: 'Save token',
				remove: 'Remove',
				saving: 'Saving...',
				saved: 'Saved. The Supabase MCP connection reloads automatically and the mcp__supabase__* tools appear shortly.',
				removed: 'Token removed.',
				saveFailed: 'Could not save the token: ',
				storeUnavailable: 'The credential store is not reachable from this page, so token entry is unavailable here. You can still export SUPABASE_ACCESS_TOKEN in the environment.',
				safety: 'Safety guardrails',
				safetyIntro: 'The agent asks for your confirmation before:',
				safetyDestructive: 'Destructive SQL: DROP, TRUNCATE, or DELETE/UPDATE without WHERE',
				safetyCostly: 'Chargeable operations: creating projects or branches',
				safetyProject: 'Project-affecting operations: deploys, branch merges, resets, deletions, pauses',
				safetyNote: 'Toggles live in the plugin configuration (Plugins, then Supabase). Confirmations add to DSH approval prompts rather than replacing them.',
				capabilities: 'What this plugin provides',
				capTools: 'Supabase MCP tools (mcp__supabase__*): query data, manage migrations, deploy Edge Functions, read logs and advisors, search docs',
				capSkills: 'Agent skills: supabase and supabase-postgres-best-practices, loaded on demand',
				capCommands: 'Commands: /supabase (status), /supabase-auth (sign-in link), /supabase-connect (reload), /supabase-review (security checklist)',
				capTool: 'Agent tool: supabase_status',
				started: 'Getting started',
				step1: 'Sign in with either method above.',
				step2: 'Run /supabase-connect in any session to reload the connection.',
				step3: 'Ask the agent something, for example: What tables are in my database?',
				docs: 'Supabase MCP documentation',
				docsLabel: 'Docs',
				boundaryTitle: 'This page hit an error',
				boundaryBody: 'The Supabase settings page could not render. The plugin itself is still active. Error details:'
			},
			zh: {
				nav: 'Supabase',
				title: 'Supabase',
				subtitle: '通过 MCP 工具、智能体技能与安全护栏，把智能体连接到 Supabase 项目。',
				connection: '连接',
				tokenStateLabel: '访问令牌',
				tokenConfigured: '已配置',
				tokenMissing: '未配置',
				endpointLabel: 'MCP 端点',
				endpointHelp: '可用环境变量 SUPABASE_MCP_URL 限定单个项目或启用只读模式，例如 https://mcp.supabase.com/mcp?project_ref=<ref>&read_only=true。',
				authIntro: '两种登录方式任选其一，给智能体带来的工具完全相同。',
				signInTitle: '连接 Supabase 账号（推荐）',
				signInBody: '在浏览器中登录 Supabase 账号。登录时选择组织，本会话即可访问该组织拥有的项目。令牌会自动续期。',
				signInButton: '打开 Supabase 登录',
				signInNote: '将在新标签页打开 supabase.com，并自动返回。如果你的宿主没有打开标签页，请使用复制按钮，在浏览器中打开链接。',
				copyLink: '复制登录链接',
				copied: '已复制，请粘贴到浏览器中打开。',
				signInNoUrl: '登录链接暂不可用。请在任意会话中运行 /supabase-auth，并打开它输出的链接。',
				tokenTitle: '使用个人访问令牌',
				tokenBody: '适合 CI、无界面环境，或无法使用浏览器登录的场景。请创建仅限所需项目与权限的作用域令牌。',
				tokenLabel: '个人访问令牌',
				tokenPlaceholder: 'sbp_...',
				tokenHelp: '保存在 DSH 凭据存储（SUPABASE_ACCESS_TOKEN），不会出现在配置文件、聊天或模型上下文中。',
				tokenCreateLink: '在 supabase.com/dashboard/account/tokens 创建令牌',
				save: '保存令牌',
				remove: '移除',
				saving: '保存中...',
				saved: '已保存。Supabase MCP 连接会自动重载，mcp__supabase__* 工具稍后可用。',
				removed: '令牌已移除。',
				saveFailed: '无法保存令牌：',
				storeUnavailable: '本页无法访问凭据存储，因此无法在此输入令牌。仍可在环境变量中导出 SUPABASE_ACCESS_TOKEN。',
				safety: '安全护栏',
				safetyIntro: '智能体在以下操作前会请求你的确认：',
				safetyDestructive: '破坏性 SQL：DROP、TRUNCATE，或没有 WHERE 的 DELETE/UPDATE',
				safetyCostly: '计费操作：创建项目或分支',
				safetyProject: '影响项目的操作：部署、分支合并、重置、删除、暂停',
				safetyNote: '开关位于插件配置（插件，然后 Supabase）。确认是对 DSH 审批提示的补充，不会替代审批。',
				capabilities: '本插件提供',
				capTools: 'Supabase MCP 工具（mcp__supabase__*）：查询数据、管理迁移、部署 Edge Functions、读取日志与顾问、搜索文档',
				capSkills: '智能体技能：supabase 与 supabase-postgres-best-practices，按需加载',
				capCommands: '命令：/supabase（状态）、/supabase-auth（登录链接）、/supabase-connect（重载）、/supabase-review（安全检查清单）',
				capTool: '智能体工具：supabase_status',
				started: '开始使用',
				step1: '使用上方任一方式登录。',
				step2: '在任意会话中运行 /supabase-connect 以重载连接。',
				step3: '向智能体提问，例如：我的数据库里有哪些表？',
				docs: 'Supabase MCP 文档',
				docsLabel: '文档',
				boundaryTitle: '页面出错了',
				boundaryBody: 'Supabase 设置页无法渲染，但插件本身仍在运行。错误详情：'
			}
		};

		// --- Component-local styles: theme tokens only ------------------------
		const CSS = `
.dsh-supabase-page { display: flex; flex-direction: column; gap: 16px; padding: 16px 20px; max-width: 720px; }
.dsh-supabase-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.dsh-supabase-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); margin: 0; }
.dsh-supabase-sub { font-size: 13px; color: var(--dsw-alias-label-secondary); margin: 0; line-height: 1.5; }
.dsh-supabase-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dsh-supabase-label { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); min-width: 120px; }
.dsh-supabase-value { font-size: 13px; color: var(--dsw-alias-label-primary); word-break: break-all; }
.dsh-supabase-input { flex: 1; min-width: 220px; padding: 7px 10px; font-size: 13px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; outline: none; }
.dsh-supabase-input:focus { border-color: var(--dsw-alias-brand-primary); }
.dsh-supabase-btn { display: inline-flex; align-items: center; padding: 8px 16px; font-size: 13px; font-weight: 600; border-radius: 6px; border: 1px solid transparent; cursor: pointer; text-decoration: none; }
.dsh-supabase-btn-primary { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
.dsh-supabase-btn-primary:disabled { opacity: 0.5; cursor: default; }
.dsh-supabase-btn-ghost { background: transparent; color: var(--dsw-alias-label-secondary); border-color: var(--dsw-alias-border-l2); }
.dsh-supabase-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
.dsh-supabase-note { font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.5; margin: 0; }
.dsh-supabase-list { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; }
.dsh-supabase-list li { font-size: 13px; color: var(--dsw-alias-label-primary); line-height: 1.5; }
.dsh-supabase-status { font-size: 12px; line-height: 1.5; margin: 0; color: var(--dsw-alias-label-secondary); }
.dsh-supabase-link { color: var(--dsw-alias-brand-primary); text-decoration: none; }
.dsh-supabase-link:hover { text-decoration: underline; }
.dsh-supabase-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
`;

		return {
			inject: ['slots', 'locale'],
			apply(ctx) {
				// Locale namespace; en and zh are the required baselines.
				let t = (key) => (DICT.en[key] ?? key);
				try {
					if (ctx.locale && typeof ctx.locale.register === 'function') {
						try {
							ctx.locale.register('supabase', { en: DICT.en, zh: DICT.zh });
						} catch (firstError) {
							ctx.locale.register('supabase', 'en', DICT.en);
							ctx.locale.register('supabase', 'zh', DICT.zh);
						}
					}
					if (ctx.locale && typeof ctx.locale.bind === 'function') {
						const bound = ctx.locale.bind('supabase');
						if (typeof bound === 'function') t = (key) => { try { return bound(key) || DICT.en[key] || key; } catch { return DICT.en[key] ?? key; } };
					}
				} catch (error) {
					console.error('[dsh-supabase] locale registration failed:', error);
				}

				// Remote access is generated and may be absent or gated. Every
				// touch is guarded so the page renders regardless.
				function credentialsRemote() {
					try {
						const remote = ctx.remote;
						if (!remote) return undefined;
						const credentials = remote.credentials;
						if (!credentials) return undefined;
						return credentials;
					} catch {
						return undefined;
					}
				}

				function authStartUrl() {
					try {
						const injected = (typeof globalThis !== 'undefined' && globalThis.__DSH_SUPABASE__) || (typeof window !== 'undefined' && window.__DSH_SUPABASE__);
						if (injected && typeof injected.authStartUrl === 'string' && injected.authStartUrl.indexOf('http') === 0) return injected.authStartUrl;
					} catch { /* fall through */ }
					try {
						const origin = (typeof window !== 'undefined' && window.location && typeof window.location.origin === 'string') ? window.location.origin : '';
						if (origin.indexOf('http') === 0) return origin + '/supabase/auth/start';
					} catch { /* fall through */ }
					return '';
				}

				function ErrorCard(props) {
					return h('div', { className: 'dsh-supabase-card' },
						h('h3', { className: 'dsh-supabase-title' }, t('boundaryTitle')),
						h('p', { className: 'dsh-supabase-sub' }, t('boundaryBody')),
						h('p', { className: 'dsh-supabase-status' }, String(props.error || 'unknown error'))
					);
				}

				// Class error boundary when the React build provides one, so a
				// render fault shows a readable card instead of a blank panel.
				let SupabaseSettingsSeat = SupabaseSettingsPage;
				if (React.Component) {
											class SupabaseErrorBoundary extends React.Component {
						constructor(props) {
							super(props);
							this.state = { error: null };
						}
						static getDerivedStateFromError(error) {
							return { error };
						}
						render() {
							if (this.state.error) return h('div', { className: 'dsh-supabase-page' }, h('style', null, CSS), h(ErrorCard, { error: this.state.error }));
							return this.props.children;
						}
					}
					SupabaseSettingsSeat = function SupabaseSettingsSeat() {
						return h(SupabaseErrorBoundary, null, h(SupabaseSettingsPage));
					};
				}

				function SupabaseSettingsPage() {
					const [token, setToken] = React.useState('');
					const [busy, setBusy] = React.useState(false);
					const [status, setStatus] = React.useState('');
					const [configured, setConfigured] = React.useState(null);
					const [showLink, setShowLink] = React.useState(false);
					const [copied, setCopied] = React.useState(false);

					const refresh = React.useCallback(() => {
						const remote = credentialsRemote();
						if (!remote || typeof remote.describe !== 'function') return;
						try {
							const result = remote.describe(['SUPABASE_ACCESS_TOKEN']);
							if (result && typeof result.then === 'function') {
								result.then((info) => {
									try {
										const entry = info && info['SUPABASE_ACCESS_TOKEN'];
										setConfigured(Boolean(entry && entry.configured));
									} catch { setConfigured(null); }
								}, () => setConfigured(null));
							}
						} catch { setConfigured(null); }
					}, []);

					React.useEffect(() => { refresh(); }, [refresh]);

					const save = () => {
						const remote = credentialsRemote();
						if (!remote || typeof remote.set !== 'function') { setStatus(t('storeUnavailable')); return; }
						if (token.length === 0) return;
						setBusy(true);
						setStatus('');
						try {
							const result = remote.set('SUPABASE_ACCESS_TOKEN', token);
							Promise.resolve(result).then(() => {
								setToken('');
								setBusy(false);
								setStatus(t('saved'));
								refresh();
							}, (error) => {
								setBusy(false);
								setStatus(t('saveFailed') + (error && error.message ? error.message : String(error)));
							});
						} catch (error) {
							setBusy(false);
							setStatus(t('saveFailed') + (error && error.message ? error.message : String(error)));
						}
					};

					const remove = () => {
						const remote = credentialsRemote();
						if (!remote || typeof remote.unset !== 'function') { setStatus(t('storeUnavailable')); return; }
						setBusy(true);
						setStatus('');
						try {
							const result = remote.unset('SUPABASE_ACCESS_TOKEN');
							Promise.resolve(result).then(() => {
								setBusy(false);
								setStatus(t('removed'));
								refresh();
							}, (error) => {
								setBusy(false);
								setStatus(t('saveFailed') + (error && error.message ? error.message : String(error)));
							});
						} catch (error) {
							setBusy(false);
							setStatus(t('saveFailed') + (error && error.message ? error.message : String(error)));
						}
					};

					const endpoint = 'https://mcp.supabase.com/mcp';
					const signInUrl = authStartUrl();
					const openSignIn = () => {
						setShowLink(true);
						if (!signInUrl) return;
						try {
							const opened = window.open(signInUrl, '_blank', 'noopener');
							if (opened && typeof opened === 'object' && 'opener' in opened) opened.opener = null;
						} catch { /* the copyable link below covers shells that block opens */ }
					};
					const copySignInLink = () => {
						if (!signInUrl) return;
						const done = () => setCopied(true);
						try {
							if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
								Promise.resolve(navigator.clipboard.writeText(signInUrl)).then(done, done);
							} else {
								done();
							}
						} catch { done(); }
					};
					const stateColor = configured === true ? 'var(--dsw-alias-state-success-primary)' : configured === false ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-idle-primary)';

					return h('div', { className: 'dsh-supabase-page' },
						h('style', null, CSS),
						h('div', { className: 'dsh-supabase-card' },
							h('h2', { className: 'dsh-supabase-title' }, t('title')),
							h('p', { className: 'dsh-supabase-sub' }, t('subtitle'))
						),
						h('div', { className: 'dsh-supabase-card' },
							h('h3', { className: 'dsh-supabase-title' }, t('connection')),
							h('div', { className: 'dsh-supabase-row' },
								h('span', { className: 'dsh-supabase-label' }, t('tokenStateLabel')),
								h('span', { className: 'dsh-supabase-value' },
									h('span', { className: 'dsh-supabase-dot', style: { background: stateColor } }),
									configured === true ? t('tokenConfigured') : t('tokenMissing'))
							),
							h('div', { className: 'dsh-supabase-row' },
								h('span', { className: 'dsh-supabase-label' }, t('endpointLabel')),
								h('span', { className: 'dsh-supabase-value' }, endpoint)
							),
							h('p', { className: 'dsh-supabase-note' }, t('endpointHelp'))
						),
						h('div', { className: 'dsh-supabase-card' },
							h('h3', { className: 'dsh-supabase-title' }, t('signInTitle')),
							h('p', { className: 'dsh-supabase-sub' }, t('authIntro')),
							h('p', { className: 'dsh-supabase-sub' }, t('signInBody')),
							signInUrl ? h('div', { className: 'dsh-supabase-actions' },
								h('button', { className: 'dsh-supabase-btn dsh-supabase-btn-primary', type: 'button', onClick: openSignIn }, t('signInButton')),
								h('button', { className: 'dsh-supabase-btn dsh-supabase-btn-ghost', type: 'button', onClick: copySignInLink }, t('copyLink'))
							) : h('p', { className: 'dsh-supabase-note' }, t('signInNoUrl')),
							showLink && signInUrl ? h('div', { className: 'dsh-supabase-row' },
								h('a', { className: 'dsh-supabase-link', href: signInUrl, target: '_blank', rel: 'noreferrer' }, signInUrl)
							) : null,
							copied ? h('p', { className: 'dsh-supabase-status', 'aria-live': 'polite' }, t('copied')) : null,
							h('p', { className: 'dsh-supabase-note' }, t('signInNote'))
						),
						h('div', { className: 'dsh-supabase-card' },
							h('h3', { className: 'dsh-supabase-title' }, t('tokenTitle')),
							h('p', { className: 'dsh-supabase-sub' }, t('tokenBody')),
							h('div', { className: 'dsh-supabase-row' },
								h('label', { className: 'dsh-supabase-label', htmlFor: 'dsh-supabase-token' }, t('tokenLabel')),
								h('input', {
									id: 'dsh-supabase-token', className: 'dsh-supabase-input', type: 'password',
									autoComplete: 'off', spellCheck: false, placeholder: t('tokenPlaceholder'),
									value: token, disabled: busy,
									onChange: (event) => setToken(event.target.value)
								}),
								h('button', { className: 'dsh-supabase-btn dsh-supabase-btn-primary', type: 'button', disabled: busy || token.length === 0, onClick: save }, busy ? t('saving') : t('save')),
								configured === true ? h('button', { className: 'dsh-supabase-btn dsh-supabase-btn-ghost', type: 'button', disabled: busy, onClick: remove }, t('remove')) : null
							),
							h('p', { className: 'dsh-supabase-note' }, t('tokenHelp'), ' ', h('a', { className: 'dsh-supabase-link', href: 'https://supabase.com/dashboard/account/tokens', target: '_blank', rel: 'noreferrer' }, t('tokenCreateLink'))),
							status ? h('p', { className: 'dsh-supabase-status', 'aria-live': 'polite' }, status) : null
						),
						h('div', { className: 'dsh-supabase-card' },
							h('h3', { className: 'dsh-supabase-title' }, t('safety')),
							h('p', { className: 'dsh-supabase-sub' }, t('safetyIntro')),
							h('ul', { className: 'dsh-supabase-list' },
								h('li', null, t('safetyDestructive')),
								h('li', null, t('safetyCostly')),
								h('li', null, t('safetyProject'))
							),
							h('p', { className: 'dsh-supabase-note' }, t('safetyNote'))
						),
						h('div', { className: 'dsh-supabase-card' },
							h('h3', { className: 'dsh-supabase-title' }, t('capabilities')),
							h('ul', { className: 'dsh-supabase-list' },
								h('li', null, t('capTools')),
								h('li', null, t('capSkills')),
								h('li', null, t('capCommands')),
								h('li', null, t('capTool'))
							)
						),
						h('div', { className: 'dsh-supabase-card' },
							h('h3', { className: 'dsh-supabase-title' }, t('started')),
							h('ol', { className: 'dsh-supabase-list' },
								h('li', null, t('step1')),
								h('li', null, t('step2')),
								h('li', null, t('step3'))
							),
							h('p', { className: 'dsh-supabase-note' },
								h('a', { className: 'dsh-supabase-link', href: 'https://supabase.com/docs/guides/ai-tools/mcp', target: '_blank', rel: 'noreferrer' }, t('docsLabel')), ' ', t('docs'))
						)
					);
				}

				return ctx.slots.inject('settings.section', () => ctx.slots.register({
					name: 'settings.section',
					id: 'supabase',
					order: 30,
					label: () => t('nav')
				}, SupabaseSettingsSeat));
			}
		};
	}
});

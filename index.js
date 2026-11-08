/**
 * Supabase for DeepSeek Harness: Host half.
 *
 * Registers:
 *  - the supabase and supabase-postgres-best-practices agent skills
 *    (vendored from supabase/agent-skills, MIT) on the skill registry;
 *  - a bounded Supabase guidance section on the system prompt;
 *  - human commands: /supabase, /supabase-auth, /supabase-connect,
 *    /supabase-review;
 *  - the supabase_status agent tool;
 *  - a tools/pre-execute guardrail that asks the user before destructive SQL,
 *    chargeable operations, and project-affecting Supabase MCP calls;
 *  - browser OAuth sign-in over local web routes (discovery, dynamic client
 *    registration, PKCE, callback, token refresh) plus personal access
 *    token support through the credential store;
 *  - automatic MCP reconnect whenever the credential changes.
 *
 * The MCP connection itself is the sibling supabase-mcp Loader row, so its
 * tools appear as mcp__supabase__*, the naming the Supabase skills expect.
 *
 * Every registration is individually guarded. Failures land in
 * .diagnostics.json next to this module and in the /supabase report.
 *
 * @module dsh-supabase
 */
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Cordis plugin name used by loader diagnostics. */
const name = "supabase";
/** Services required for this plugin to activate. */
const inject = ["commands", "skills", "systemPrompt", "tools"];

/** Env-style credential key that carries the current access token. */
const TOKEN_KEY = "SUPABASE_ACCESS_TOKEN";
/** Credential record (<scope>/<id>) holding the OAuth grant (refresh token). */
const OAUTH_RECORD = "dsh-supabase/oauth";
/** Loader entry id of the sibling MCP connection row. */
const MCP_ROW_ID = "supabase-mcp";
/** Reserved skill provider name is `runtime`; this provider uses its own. */
const PROVIDER_NAME = "supabase-plugin";
/** Standard precedence rank for packaged skill providers (BUNDLED_SKILL_RANK). */
const SKILL_RANK = 600;
/** Local route path that starts the browser sign-in. */
const AUTH_START_PATH = "/supabase/auth/start";
/** Local route path the browser returns to after signing in. */
const AUTH_CALLBACK_PATH = "/supabase/auth/callback";
/** The hosted Supabase MCP endpoint this bundle connects to. */
const DEFAULT_MCP_URL = "https://mcp.supabase.com/mcp";

// --- Optional first-party helpers -----------------------------------------
// Profile-installed bundles normally cannot resolve the dsh installation's
// packages through Node's module resolution. When the loader does resolve
// them, use the real helpers; otherwise fall back to plain values, which the
// runtime accepts because the branded types are compile-time only.

let defineTool = (definition) => definition;
let commandDefinitionId = (value) => value;
try {
	const toolsModule = await import("@deepseek-ai/dsh-tools");
	if (typeof toolsModule.defineTool === "function") defineTool = toolsModule.defineTool;
} catch { /* fall back to identity */ }
try {
	const brandModule = await import("@deepseek-ai/dsh-commands/brand");
	if (typeof brandModule.CommandDefinitionId === "function") commandDefinitionId = brandModule.CommandDefinitionId;
} catch { /* fall back to identity */ }

/** Registration diagnostics surfaced to the user and written to disk. */
const diagnostics = [];
function record(ok, feature, detail) {
	diagnostics.push({ feature, ok, ...(detail === undefined ? {} : { detail: String(detail) }) });
}
function flushDiagnostics() {
	void writeFile(
		fileURLToPath(new URL("./.diagnostics.json", import.meta.url)),
		JSON.stringify({ updatedAt: new Date().toISOString(), diagnostics }, null, 2)
	).catch(() => {});
}

// ---------------------------------------------------------------------------
// Skills (vendored from https://github.com/supabase/agent-skills, MIT)
// ---------------------------------------------------------------------------

const SKILLS_ROOT = new URL("./skills/", import.meta.url);

/** Skill candidates exactly as shipped in the vendored SKILL.md frontmatter. */
const CANDIDATES = [
	{
		name: "supabase",
		description: "Use when doing ANY task involving Supabase. Triggers: Supabase products (Database, Auth, Edge Functions, Realtime, Storage, Vectors, Cron, Queues); client libraries and SSR integrations (supabase-js, @supabase/ssr) in Next.js, React, SvelteKit, Astro, Remix; auth issues (login, logout, sessions, JWT, cookies, getSession, getUser, getClaims, RLS); Supabase CLI or MCP server; schema changes, migrations, declarative schemas, security audits, Postgres extensions (pg_graphql, pg_cron, pg_vector); debugging and troubleshooting errors or unexpected behavior on Supabase projects (HTTP errors, Postgres errors, RLS surprises, permission denied, schema cache issues, timeouts, Edge Function crashes, Realtime drops, Storage failures) and reading or querying logs (Logs Explorer, ClickHouse).",
		dir: "supabase"
	},
	{
		name: "supabase-postgres-best-practices",
		description: "Postgres best practices maintained by Supabase, for Postgres running anywhere. Load this skill BEFORE writing or changing anything that lives in a Postgres database: creating or altering tables and columns (including choosing column types), schema design, migrations and declarative schema files, RLS policies and the tests that verify them, indexes, triggers, database functions, queues and scheduled jobs (pg_cron, pgmq), vector/semantic search (pgvector), and restoring dumps (pg_restore) or importing data. Also load it when diagnosing slow queries, high CPU, timeouts, EXPLAIN plans, connection exhaustion, locking, bloat, or rows visible to the wrong user or tenant. This is not just a performance guide: schema, migration, security, and SQL authoring tasks need these rules too, even for a one-column change or a single query.",
		dir: "supabase-postgres-best-practices"
	}
];

/** Build the badge-style skill provider over the vendored skill directories. */
function buildSkillProvider() {
	return {
		name: PROVIDER_NAME,
		list: () => Promise.resolve(CANDIDATES.map((candidate) => ({
			name: candidate.name,
			description: candidate.description,
			invocation: { modelInvocable: true, userInvocable: true },
			provider: PROVIDER_NAME,
			source: "bundled",
			rank: SKILL_RANK,
			resourceBase: { kind: "directory", path: fileURLToPath(new URL(`./${candidate.dir}/`, SKILLS_ROOT)) },
			locator: new URL(`./${candidate.dir}/SKILL.md`, SKILLS_ROOT)
		}))),
		async get(candidate) {
			const match = CANDIDATES.find((entry) => entry.name === candidate.name);
			if (match === undefined) throw new Error(`dsh-supabase: unknown skill ${candidate.name}`);
			return {
				...candidate,
				content: await readFile(new URL(`./${match.dir}/SKILL.md`, SKILLS_ROOT), "utf8")
			};
		}
	};
}

// ---------------------------------------------------------------------------
// System prompt guidance (detail lives in the skills; this orients the model)
// ---------------------------------------------------------------------------

const GUIDANCE = `Supabase tools (mcp__supabase__*) connect to the user's Supabase projects. Load the supabase skill before Supabase work and supabase-postgres-best-practices before writing Postgres SQL or schema changes. Prefer the search_docs tool over recalling Supabase APIs from memory. Use the narrowest tool and query that answers the task: the connection may be project-scoped or read-only, and those limits are intentional. Destructive SQL, chargeable operations (create_project, create_branch), and project-affecting calls pause for explicit user confirmation. Never work around a confirmation or simulate its result. Never print access tokens, service_role keys, or secret values into chat, files, or tool arguments.`;

// ---------------------------------------------------------------------------
// Guardrail: ask before risky Supabase MCP calls (the hooks equivalent)
// ---------------------------------------------------------------------------

/** SQL shapes that can lose data or weaken security without a WHERE clause. */
const DESTRUCTIVE_SQL_PATTERNS = [
	/\bdrop\s+(table|schema|database|function|trigger|view|index|role|user|policy|sequence|extension|type)\b/i,
	/\btruncate(\s+table)?\b/i,
	/\bdelete\s+from\b(?![^;]*\bwhere\b)/i,
	/\bupdate\b[^;]*\bset\b(?![^;]*\bwhere\b)/i,
	/\balter\s+table\b[^;]*\bdrop\b/i,
	/\b(revoke|grant)\s+/i,
	/\bcreate\s+(or\s+replace\s+)?(role|user)\b/i
];

/** Supabase MCP calls grouped by why they need explicit confirmation. */
const CONFIRM_CATEGORIES = {
	costly: ["create_project", "create_branch"],
	projectAffecting: [
		"pause_project", "delete_branch", "reset_branch", "merge_branch",
		"delete_notebook", "deploy_edge_function", "update_storage_config"
	]
};

/** Recursively collect every string inside a tool-arguments value. */
function collectStrings(value, out) {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
	else if (value !== null && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, out);
	return out;
}

/** Build the pre-execute ask decision for one risky call. */
function askDecision(reason, en, zh) {
	return { kind: "ask", reason, displayReason: { en, zh } };
}

// ---------------------------------------------------------------------------
// Browser OAuth (the recommended sign-in) over local web routes
// ---------------------------------------------------------------------------

/** Pending sign-in attempts, keyed by state. */
const pendingAuth = new Map();
/** Cached dynamic client registration, keyed by token endpoint. */
const registeredClients = new Map();
/** Live refresh timer, if any. */
let refreshTimer;

const base64url = (buffer) => Buffer.from(buffer).toString("base64url");

/** Discover the OAuth endpoints behind an MCP server URL (MCP authorization spec). */
async function discoverOAuth(mcpUrl, fetchFn) {
	const wellKnown = async (url) => {
		const response = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
		if (!response.ok) throw new Error(`metadata request failed (${response.status})`);
		return response.json();
	};
	let authorizationServer;
	try {
		const probe = await fetchFn(mcpUrl, { signal: AbortSignal.timeout(10_000) });
		const challenge = probe.headers.get("www-authenticate") ?? "";
		const resourceMatch = /resource_metadata="([^"]+)"/i.exec(challenge);
		if (resourceMatch !== null) {
			const resource = await wellKnown(resourceMatch[1]);
			authorizationServer = resource.authorization_servers?.[0];
		}
	} catch { /* fall through to the origin default */ }
	if (typeof authorizationServer !== "string") {
		authorizationServer = new URL(mcpUrl).origin;
	}
	for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
		try {
			const metadata = await wellKnown(new URL(path, authorizationServer).toString());
			if (typeof metadata.authorization_endpoint === "string" && typeof metadata.token_endpoint === "string") {
				return {
					authorizationEndpoint: metadata.authorization_endpoint,
					tokenEndpoint: metadata.token_endpoint,
					registrationEndpoint: typeof metadata.registration_endpoint === "string" ? metadata.registration_endpoint : undefined
				};
			}
		} catch { /* try the next metadata document */ }
	}
	throw new Error("could not discover Supabase OAuth endpoints");
}

/** Register this client with the authorization server (dynamic client registration). */
async function registerClient(metadata, redirectUri, fetchFn) {
	const cached = registeredClients.get(metadata.tokenEndpoint);
	if (cached !== undefined) return cached;
	let clientId = "dsh-supabase";
	if (metadata.registrationEndpoint !== undefined) {
		const response = await fetchFn(metadata.registrationEndpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				client_name: "DeepSeek Harness (dsh-supabase)",
				redirect_uris: [redirectUri],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none"
			}),
			signal: AbortSignal.timeout(10_000)
		});
		if (response.ok) {
			const body = await response.json();
			if (typeof body.client_id === "string") clientId = body.client_id;
		}
	}
	registeredClients.set(metadata.tokenEndpoint, clientId);
	return clientId;
}

/** Build the authorize URL and remember the PKCE verifier for the callback. */
async function buildAuthorizeUrl(redirectUri, fetchFn, mcpUrl) {
	const metadata = await discoverOAuth(mcpUrl, fetchFn);
	const clientId = await registerClient(metadata, redirectUri, fetchFn);
	const state = base64url(randomBytes(24));
	const verifier = base64url(randomBytes(48));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	pendingAuth.set(state, { verifier, redirectUri, createdAt: Date.now() });
	for (const [key, entry] of pendingAuth) {
		if (Date.now() - entry.createdAt > 15 * 60 * 1000) pendingAuth.delete(key);
	}
	const url = new URL(metadata.authorizationEndpoint);
	url.searchParams.set("client_id", clientId);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("state", state);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	return { url: url.toString(), state, metadata, clientId };
}

/** Exchange an authorization code for tokens. */
async function exchangeCode(metadata, clientId, pending, code, fetchFn) {
	const response = await fetchFn(metadata.tokenEndpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: pending.redirectUri,
			client_id: clientId,
			code_verifier: pending.verifier
		}).toString(),
		signal: AbortSignal.timeout(15_000)
	});
	if (!response.ok) throw new Error(`token exchange failed (${response.status})`);
	return response.json();
}

/** Refresh an expired access token. */
async function refreshTokens(metadata, clientId, refreshToken, fetchFn) {
	const response = await fetchFn(metadata.tokenEndpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: clientId
		}).toString(),
		signal: AbortSignal.timeout(15_000)
	});
	if (!response.ok) throw new Error(`token refresh failed (${response.status})`);
	return response.json();
}

/** Minimal, self-contained result page for the browser tab. */
function resultPage(title, body) {
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
		`<style>body{font-family:system-ui,sans-serif;background:#101317;color:#e8eaed;display:flex;` +
		`align-items:center;justify-content:center;min-height:100vh;margin:0}main{max-width:420px;` +
		`padding:32px 36px;background:#1a1f26;border:1px solid #2a313a;border-radius:12px;line-height:1.6}` +
		`h1{font-size:20px;margin:0 0 10px}p{margin:0;color:#9aa4b0;font-size:14px}</style></head>` +
		`<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`,
		{ status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
	);
}

// ---------------------------------------------------------------------------
// Token plumbing: credential store, in-process env bridge, reconnect
// ---------------------------------------------------------------------------

/** Nudge the MCP row to reload so a rotated token or URL takes effect. */
async function reconnect(ctx) {
	const editor = ctx.get("configEditor");
	if (editor === undefined) return "Automatic reconnect is unavailable in this profile. Reload the profile or restart DSH to apply credential changes.";
	try {
		const entry = editor.entries().find((candidate) => candidate.id === MCP_ROW_ID);
		if (entry === undefined) return "The supabase-mcp connection row is not present in this profile; reinstall the dsh-supabase bundle.";
		// Editing an ordinary config field restarts the row and re-evaluates its
		// Loader expressions. The toolCallTimeoutMs value keeps its documented
		// meaning while toggling between two valid values to force the reload.
		await editor.edit(entry, (current) => {
			const nextTimeout = current.toolCallTimeoutMs === 60001 ? 60000 : 60001;
			return { ...current, toolCallTimeoutMs: nextTimeout };
		});
		return "Supabase MCP connection reloaded. Tools appear as mcp__supabase__* shortly.";
	} catch (error) {
		return `Could not reload the Supabase MCP connection: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/**
 * Commit a new access token: credential store first (the source of truth),
 * then the in-process environment bridge the MCP row's Loader expression
 * reads, then a reconnect.
 */
async function commitAccessToken(ctx, accessToken) {
	const credentials = ctx.get("credentials");
	if (credentials !== undefined) {
		await credentials.set(TOKEN_KEY, accessToken);
	}
	process.env[TOKEN_KEY] = accessToken;
	return reconnect(ctx);
}

/** Store the OAuth grant record used for later refreshes. */
async function commitGrant(ctx, payload) {
	const credentials = ctx.get("credentials");
	if (credentials === undefined) return;
	await credentials.modifyRecord(OAUTH_RECORD, async () => ({ kind: "grant", payload }));
}

/** Schedule a proactive token refresh before the access token expires. */
function scheduleRefresh(ctx, expiresIn, metadata, clientId, fetchFn, log) {
	if (refreshTimer !== undefined) clearTimeout(refreshTimer);
	if (typeof expiresIn !== "number" || expiresIn <= 0) return;
	const delay = Math.max(30_000, expiresIn * 1000 * 0.75);
	refreshTimer = setTimeout(() => {
		void (async () => {
			try {
				const credentials = ctx.get("credentials");
				const record = await credentials?.readRecord(OAUTH_RECORD);
				const refreshToken = record?.payload?.refresh_token;
				if (typeof refreshToken !== "string") return;
				const tokens = await refreshTokens(metadata, clientId, refreshToken, fetchFn);
				if (typeof tokens.access_token === "string") {
					await commitGrant(ctx, {
						refresh_token: typeof tokens.refresh_token === "string" ? tokens.refresh_token : refreshToken,
						token_url: metadata.tokenEndpoint,
						client_id: clientId,
						expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000
					});
					await commitAccessToken(ctx, tokens.access_token);
					scheduleRefresh(ctx, tokens.expires_in, metadata, clientId, fetchFn, log);
				}
			} catch (error) {
				log(`Supabase token refresh failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		})();
	}, delay);
	// A refresh timer must never keep a process alive on its own.
	if (typeof refreshTimer.unref === "function") refreshTimer.unref();
}

// ---------------------------------------------------------------------------
// Human commands and status
// ---------------------------------------------------------------------------

const REVIEW_CHECKLIST = `Supabase security review checklist (run before shipping schema, auth, RLS, views, storage, or user-data changes):
1. RLS is enabled on every table in exposed schemas (public by default), with policies that match the access model instead of blanket auth.uid() copies.
2. No authorization decision reads user_metadata / raw_user_meta_data; use app_metadata.
3. Views use WITH (security_invoker = true) (Postgres 15+), or are otherwise protected from RLS bypass.
4. UPDATE policies have both USING and WITH CHECK; auth.role() is not used (deprecated); TO authenticated is combined with an ownership predicate (no BOLA/IDOR).
5. SECURITY DEFINER functions are justified, live outside exposed schemas where possible, and check auth.uid() in the body; supabase db advisors or MCP get_advisors run clean.
6. service_role or secret keys appear nowhere in public clients (watch NEXT_PUBLIC_* in Next.js); Management API, CLI, and MCP use scoped personal access tokens.
7. Deleting a user is followed by session and token invalidation where the app needs strict guarantees.
8. Storage upserts grant INSERT + SELECT + UPDATE; public grants come with RLS.
9. Package installs pin versions and commit lockfiles.`;

/** Report the integration status as one bounded human-readable block. */
async function statusText(ctx, config) {
	const credentials = ctx.get("credentials");
	let tokenState = "not configured";
	let authMethod = "none";
	if (credentials !== undefined) {
		try {
			const info = await credentials.describe(TOKEN_KEY);
			if (info?.configured) tokenState = `configured (${info.source ?? "stored"})`;
		} catch {
			if (process.env[TOKEN_KEY]) tokenState = "configured (environment)";
		}
		try {
			const record = await credentials.readRecord(OAUTH_RECORD);
			if (record?.payload?.refresh_token !== undefined) authMethod = "browser sign-in (Supabase account)";
			else if (tokenState.startsWith("configured")) authMethod = "personal access token";
		} catch { /* keep the fallback */ }
	}
	const endpoint = process.env.SUPABASE_MCP_URL || DEFAULT_MCP_URL;
	const failed = diagnostics.filter((entry) => !entry.ok);
	const origin = typeof ctx.get === "function" ? safeOrigin(ctx) : undefined;
	return [
		"Supabase integration status",
		`- Access token: ${tokenState}`,
		`- Sign-in method: ${authMethod}`,
		`- MCP endpoint: ${endpoint}`,
		"- MCP tools: mcp__supabase__* (they appear once the connection authenticates)",
		"- Skills: supabase, supabase-postgres-best-practices",
		`- Guardrails: destructive SQL ${config.confirmDestructiveSql ? "asks" : "off"}; chargeable operations ${config.confirmCostlyOperations ? "asks" : "off"}; project-affecting operations ${config.confirmProjectAffecting ? "asks" : "off"}`,
		failed.length === 0 ? "- Features: all registered" : `- Features: ${failed.length} failed (${failed.map((entry) => entry.feature).join(", ")})`,
		tokenState.startsWith("configured")
			? "Next step: run /supabase-connect to reload the connection, then ask the agent to list your tables."
			: `Next step: open Settings > Supabase and click "Connect Supabase account", or paste a scoped personal access token.${origin === undefined ? "" : ` Browser sign-in link: ${origin}${AUTH_START_PATH}`}`
	].join("\n");
}

/** The web GUI origin, when the listener is up. */
function safeOrigin(ctx) {
	try {
		const webServer = ctx.get("webServer");
		return webServer?.getOrigin?.();
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/**
 * Register Supabase skills, guidance, commands, guardrails, auth routes, and
 * the token watch on the composed Harness.
 * @param ctx - composed context carrying the registries this plugin uses.
 * @param config - the Loader row config (guardrail toggles).
 */
function apply(ctx, config) {
	const toggles = {
		confirmDestructiveSql: config?.confirmDestructiveSql !== false,
		confirmCostlyOperations: config?.confirmCostlyOperations !== false,
		confirmProjectAffecting: config?.confirmProjectAffecting !== false
	};
	const log = (message) => console.error(`[dsh-supabase] ${message}`);
	const fetchFn = (...args) => globalThis.fetch(...args);
	const mcpUrl = () => process.env.SUPABASE_MCP_URL || DEFAULT_MCP_URL;

	ctx.effect(function* () {
		// --- Skills -----------------------------------------------------------
		try {
			yield ctx.skills.registerProvider(() => buildSkillProvider());
			record(true, "skills");
		} catch (error) {
			record(false, "skills", error instanceof Error ? error.message : error);
		}

		// --- System prompt guidance ------------------------------------------
		try {
			yield ctx.systemPrompt.section({ name: "supabase:guidance", order: 9000, text: GUIDANCE });
			record(true, "prompt-section");
		} catch (error) {
			record(false, "prompt-section", error instanceof Error ? error.message : error);
		}

		// --- Guardrail: confirm risky Supabase MCP calls ---------------------
		try {
			yield ctx.on("tools/pre-execute", async (exec, next) => {
				if (typeof exec.name !== "string" || !exec.name.startsWith("mcp__supabase__")) return next();
				const tool = exec.name.slice("mcp__supabase__".length);
				if (tool === "execute_sql" || tool === "apply_migration") {
					if (!toggles.confirmDestructiveSql) return next();
					const sql = collectStrings(exec.arguments ?? {}, []).join("\n");
					if (DESTRUCTIVE_SQL_PATTERNS.some((pattern) => pattern.test(sql))) {
						return askDecision(
							`${exec.name} contains destructive SQL (drops, truncates, or DELETE/UPDATE without WHERE)`,
							`${exec.name} contains destructive SQL (DROP, TRUNCATE, or DELETE/UPDATE without WHERE). Confirm to run it against the database.`,
							`${exec.name} 包含破坏性 SQL（DROP、TRUNCATE，或没有 WHERE 的 DELETE/UPDATE）。确认后才会对数据库执行。`
						);
					}
					return next();
				}
				if (CONFIRM_CATEGORIES.costly.includes(tool)) {
					if (!toggles.confirmCostlyOperations) return next();
					return askDecision(
						`${exec.name} creates billable Supabase resources`,
						`${exec.name} creates billable Supabase resources. Confirm to proceed (charges may apply).`,
						`${exec.name} 会创建计费的 Supabase 资源。确认后才会继续（可能产生费用）。`
					);
				}
				if (CONFIRM_CATEGORIES.projectAffecting.includes(tool)) {
					if (!toggles.confirmProjectAffecting) return next();
					return askDecision(
						`${exec.name} changes or affects an existing Supabase project`,
						`${exec.name} changes or affects an existing Supabase project (deploys, branch operations, pauses, or deletions). Confirm to proceed.`,
						`${exec.name} 会更改或影响现有 Supabase 项目（部署、分支操作、暂停或删除）。确认后才会继续。`
					);
				}
				return next();
			});
			record(true, "guardrail");
		} catch (error) {
			record(false, "guardrail", error instanceof Error ? error.message : error);
		}

		// --- Browser OAuth routes -------------------------------------------
		try {
			const webServer = ctx.get("webServer");
			if (webServer === undefined) throw new Error("webServer service unavailable in this profile");
			// Publish the real sign-in URL into the page boot data. Shells that
			// do not serve the UI over http (window.location.origin is unusable
			// there) still receive it through the index injection table.
			yield ctx.on("webserver/index-inject", (table) => {
				const origin = safeOrigin(ctx);
				if (origin === undefined) return;
				table.push({ kind: "global", name: "__DSH_SUPABASE__", value: { authStartUrl: `${origin}${AUTH_START_PATH}` } });
			});
			yield webServer.register({
				kind: "exact",
				path: AUTH_START_PATH,
				resource: async () => {
					try {
						const redirectUri = `${safeOrigin(ctx)}${AUTH_CALLBACK_PATH}`;
						const { url } = await buildAuthorizeUrl(redirectUri, fetchFn, mcpUrl());
						return new Response(null, { status: 302, headers: { location: url } });
					} catch (error) {
						return resultPage("Sign-in could not start", `Could not reach Supabase sign-in: ${error instanceof Error ? error.message : String(error)}. You can paste a personal access token in Settings instead.`);
					}
				}
			});
			yield webServer.register({
				kind: "exact",
				path: AUTH_CALLBACK_PATH,
				resource: async (request) => {
					const params = new URL(request.url).searchParams;
					try {
						const errorParam = params.get("error");
						if (errorParam !== null) {
							return resultPage("Sign-in was cancelled", `Supabase reported: ${errorParam}. You can try again or paste a personal access token in Settings.`);
						}
						const state = params.get("state") ?? "";
						const pending = pendingAuth.get(state);
						pendingAuth.delete(state);
						if (pending === undefined) return resultPage("Sign-in could not finish", "The sign-in attempt expired or was already used. Start again from Settings.");
						const code = params.get("code");
						if (code === null) return resultPage("Sign-in could not finish", "No authorization code arrived. Start again from Settings.");
						const metadata = await discoverOAuth(mcpUrl(), fetchFn);
						const clientId = await registerClient(metadata, pending.redirectUri, fetchFn);
						const tokens = await exchangeCode(metadata, clientId, pending, code, fetchFn);
						if (typeof tokens.access_token !== "string") throw new Error("the token response carried no access token");
						await commitGrant(ctx, {
							refresh_token: typeof tokens.refresh_token === "string" ? tokens.refresh_token : "",
							token_url: metadata.tokenEndpoint,
							client_id: clientId,
							expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000
						});
						await commitAccessToken(ctx, tokens.access_token);
						scheduleRefresh(ctx, tokens.expires_in, metadata, clientId, fetchFn, log);
						return resultPage("Supabase connected", "You are signed in with your Supabase account. The organization you chose during sign-in decides which projects this session can reach. Close this tab and return to DeepSeek Harness.");
					} catch (error) {
						return resultPage("Sign-in could not finish", `The token exchange failed: ${error instanceof Error ? error.message : String(error)}. You can paste a personal access token in Settings instead.`);
					}
				}
			});
			record(true, "auth-routes");
		} catch (error) {
			record(false, "auth-routes", error instanceof Error ? error.message : error);
		}

		// --- Commands --------------------------------------------------------
		const handler = (fn) => async (invocation) => {
			try {
				return await fn(invocation);
			} catch (error) {
				return { kind: "error", text: `Supabase command failed: ${error instanceof Error ? error.message : String(error)}` };
			}
		};
		const commands = [
			{
				name: "supabase",
				description: "Show Supabase connection and safety status",
				handler: handler(() => statusText(ctx, toggles).then((text) => ({ kind: "success", text })))
			},
			{
				name: "supabase-auth",
				description: "Get the browser link to connect your Supabase account",
				handler: handler(async () => {
					const origin = safeOrigin(ctx);
					if (origin === undefined) return { kind: "error", text: "The web GUI is not running in this profile, so browser sign-in is unavailable. Paste a personal access token in Settings instead." };
					return { kind: "success", text: `Open this link to sign in to Supabase in your browser (the organization you choose there decides which projects this session can reach):\n${origin}${AUTH_START_PATH}\n\nPrefer a token? Paste a scoped personal access token in Settings > Supabase.` };
				})
			},
			{
				name: "supabase-connect",
				description: "Reload the Supabase MCP connection after signing in or setting a token",
				handler: handler(async () => {
					const status = await statusText(ctx, toggles);
					const reload = await reconnect(ctx);
					return { kind: "success", text: `${status}\n\n${reload}` };
				})
			},
			{
				name: "supabase-review",
				description: "Show the Supabase security review checklist",
				handler: handler(async () => ({ kind: "success", text: REVIEW_CHECKLIST }))
			}
		];
		for (const command of commands) {
			try {
				yield ctx.commands.register({
					definitionId: commandDefinitionId("dsh-supabase"),
					name: command.name,
					description: command.description,
					handler: command.handler
				});
				record(true, `command:${command.name}`);
			} catch (error) {
				record(false, `command:${command.name}`, error instanceof Error ? error.message : error);
			}
		}

		// --- Agent tool (user-only authority stays out of the tool set) -------
		try {
			yield ctx.tools.register(defineTool({
				name: "supabase_status",
				description: "Report the Supabase integration status: access-token state, MCP endpoint, skills, and safety guard settings.",
				parameters: {},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						required: ["status"],
						properties: {
							status: { type: "string", description: "Human-readable integration status." }
						}
					},
					render: (_args, value) => [{ type: "text", text: value.status }]
				},
				async execute(_args, exec) {
					if (exec.agent === undefined) throw new Error("supabase_status requires an agent Session");
					return { status: await statusText(ctx, toggles) };
				}
			}));
			record(true, "tool:supabase_status");
		} catch (error) {
			record(false, "tool:supabase_status", error instanceof Error ? error.message : error);
		}

		// --- Credential watch: env bridge plus reconnect on change -----------
		try {
			const credentials = ctx.get("credentials");
			if (credentials !== undefined) {
				yield ctx.on("credentials/reference-updated", (ref) => {
					if (String(ref) !== TOKEN_KEY) return;
					void (async () => {
						try {
							const hit = await credentials.resolve(TOKEN_KEY);
							if (hit?.value) process.env[TOKEN_KEY] = hit.value;
							else delete process.env[TOKEN_KEY];
							await reconnect(ctx);
						} catch (error) {
							log(`credential update handling failed: ${error instanceof Error ? error.message : String(error)}`);
						}
					})();
				});
				record(true, "credential-watch");
			} else {
				record(false, "credential-watch", "credentials service unavailable");
			}
		} catch (error) {
			record(false, "credential-watch", error instanceof Error ? error.message : error);
		}

		// --- Hydrate the env bridge from the store, then refresh if stale ----
		try {
			const credentials = ctx.get("credentials");
			if (credentials !== undefined) {
				void (async () => {
					try {
						const hit = await credentials.resolve(TOKEN_KEY);
						if (hit?.value && !process.env[TOKEN_KEY]) process.env[TOKEN_KEY] = hit.value;
						const record = await credentials.readRecord(OAUTH_RECORD);
						const payload = record?.payload ?? {};
						if (payload.refresh_token && payload.token_url && Date.now() > (payload.expires_at ?? 0) - 5 * 60 * 1000) {
							const metadata = { tokenEndpoint: payload.token_url, authorizationEndpoint: "", registrationEndpoint: undefined };
							const tokens = await refreshTokens(metadata, payload.client_id ?? "dsh-supabase", payload.refresh_token, fetchFn);
							if (typeof tokens.access_token === "string") {
								await commitGrant(ctx, {
									refresh_token: typeof tokens.refresh_token === "string" ? tokens.refresh_token : payload.refresh_token,
									token_url: payload.token_url,
									client_id: payload.client_id,
									expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000
								});
								await commitAccessToken(ctx, tokens.access_token);
								scheduleRefresh(ctx, tokens.expires_in, metadata, payload.client_id ?? "dsh-supabase", fetchFn, log);
							}
						} else if (payload.refresh_token) {
							scheduleRefresh(ctx, Math.max(0, ((payload.expires_at ?? 0) - Date.now()) / 1000), { tokenEndpoint: payload.token_url ?? "", authorizationEndpoint: "", registrationEndpoint: undefined }, payload.client_id ?? "dsh-supabase", fetchFn, log);
						}
					} catch (error) {
						log(`startup token hydration failed: ${error instanceof Error ? error.message : String(error)}`);
					}
				})();
				record(true, "token-hydration");
			} else {
				record(false, "token-hydration", "credentials service unavailable");
			}
		} catch (error) {
			record(false, "token-hydration", error instanceof Error ? error.message : error);
		}

		flushDiagnostics();
		yield () => {
			if (refreshTimer !== undefined) clearTimeout(refreshTimer);
		};
	}, "dsh-supabase lifecycle");
}

export { apply, inject, name };

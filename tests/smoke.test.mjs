/**
 * End-to-end smoke tests for dsh-supabase.
 *
 * These tests execute the real plugin artifacts:
 *  - index.js `apply()` against a recording Host context: skills, prompt
 *    section, guardrail listener, commands (invoked), the agent tool
 *    (executed), the credential watch, and the full browser OAuth flow
 *    (discovery, dynamic client registration, PKCE, callback, token commit);
 *  - the skill provider against the real vendored SKILL.md files;
 *  - client.js `apply()` against a recording Client context, including a
 *    render through the error boundary.
 *
 * Run with: node tests/smoke.test.mjs
 */
import assert from "node:assert/strict";

// --- Host-side E2E ---------------------------------------------------------

const { apply } = await import("../index.js");

function makeCtx() {
	const recorded = { providers: [], sections: [], listeners: [], commands: [], tools: [], edited: [], routes: [], sets: [], unsets: [], deleted: [], records: [], approvalPolicy: undefined, questions: [], nextAnswer: undefined, questionsDisabled: false };
	const recordStore = new Map();
	const ctx = {
		fiber: { entry: { id: "supabase", name: "dsh-supabase" } },
		effect(fn) {
			const gen = fn();
			for (const _disposer of gen) { /* registration walk */ }
		},
		skills: {
			registerProvider(factory) {
				recorded.providers.push(factory());
				return () => {};
			}
		},
		systemPrompt: {
			section(section) {
				recorded.sections.push(section);
				return () => {};
			}
		},
		on(name, handler) {
			recorded.listeners.push({ name, handler });
			return () => {};
		},
		commands: {
			register(definition) {
				recorded.commands.push(definition);
				return () => {};
			}
		},
		tools: {
			register(definition) {
				recorded.tools.push(definition);
				return () => {};
			},
			definitions: () => [...recorded.tools, { name: "mcp__supabase__list_tables" }, { name: "mcp__supabase__execute_sql" }]
		},
		get(name) {
			if (name === "approval") {
				return { overrideOf: () => recorded.approvalPolicy };
			}
			if (name === "userQuestions") {
				if (recorded.questionsDisabled) return undefined;
				return {
					ask: async (request) => {
						recorded.questions.push(request);
						return recorded.nextAnswer;
					}
				};
			}
			if (name === "credentials") {
				return {
					describe: async () => ({ configured: true, source: "test-store" }),
					resolve: async () => ({ value: "stored-token", source: "test-store" }),
					readRecord: async (key) => recordStore.get(key),
					modifyRecord: async (key, mutate) => {
						const entry = await mutate(recordStore.get(key)?.payload);
						recordStore.set(key, entry);
						recorded.records.push({ key, ...entry });
					},
					set: async (key, value) => {
						recorded.sets.push({ key, value });
					},
					unset: async (key) => {
						recorded.unsets.push(key);
					},
					deleteRecord: async (key) => {
						recordStore.delete(key);
						recorded.deleted.push(key);
					}
				};
			}
			if (name === "configEditor") {
				return {
					// The installed row id is profile-chosen; lookup must go through
					// the row's effective configuration.
					entries: () => [{ id: "some-other-row" }],
					configuration: () => [
						{ entry: { id: "unity-row" }, inherited: {}, override: { serverName: "unity" } },
						{ entry: { id: "mcp-row-42" }, inherited: {}, override: { serverName: "supabase", toolCallTimeoutMs: 60000 } }
					],
					edit: async (entry, change) => {
						recorded.edited.push({ entryId: entry.id, config: change({ toolCallTimeoutMs: 60000 }) });
					}
				};
			}
			if (name === "webServer") {
				return {
					getOrigin: () => "http://127.0.0.1:63928",
					register(route) {
						recorded.routes.push(route);
						return () => {};
					}
				};
			}
			return undefined;
		}
	};
	return { ctx, recorded };
}

// Stub the OAuth world: MCP probe, metadata discovery, DCR, token endpoint.
const realFetch = globalThis.fetch;
const oauthCalls = [];
const tokenBodies = [];
let tokenFailBody;
let tokenResponse = { access_token: "at-123", refresh_token: "rt-123", expires_in: 3600 };
globalThis.fetch = async (url, options = {}) => {
	const target = String(url);
	oauthCalls.push({ target, method: options.method ?? "GET" });
	if (target === "https://mcp.supabase.com/mcp") {
		return new Response(null, {
			status: 401,
			headers: { "www-authenticate": 'Bearer resource_metadata="https://meta.example/rm"' }
		});
	}
	if (target === "https://meta.example/rm") {
		return Response.json({ authorization_servers: ["https://auth.example"] });
	}
	if (target === "https://auth.example/.well-known/oauth-authorization-server") {
		return Response.json({
			authorization_endpoint: "https://auth.example/authorize",
			token_endpoint: "https://auth.example/token",
			registration_endpoint: "https://auth.example/register"
		});
	}
	if (target === "https://auth.example/register" && (options.method ?? "GET") === "POST") {
		return Response.json({ client_id: "test-client", client_secret: "s3cret", token_endpoint_auth_method: "client_secret_post" });
	}
	if (target === "https://auth.example/token" && (options.method ?? "GET") === "POST") {
		tokenBodies.push(String(options.body ?? ""));
		if (tokenFailBody !== undefined) {
			return new Response(JSON.stringify({ error: "invalid_request", message: tokenFailBody }), {
				status: 422,
				headers: { "content-type": "application/json" }
			});
		}
		return Response.json(tokenResponse);
	}
	return new Response("not found", { status: 404 });
};

const { ctx, recorded } = makeCtx();
apply(ctx, {});

// Skills: provider lists both candidates with valid rank and serves real content.
assert.equal(recorded.providers.length, 1, "one skill provider registered");
const provider = recorded.providers[0];
assert.equal(provider.name, "supabase-plugin");
const candidates = await provider.list();
assert.equal(candidates.length, 2, "two skill candidates");
for (const candidate of candidates) {
	assert.ok(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.name), `kebab-case name: ${candidate.name}`);
	assert.equal(candidate.rank, 600, "bundled rank");
	assert.equal(candidate.invocation.modelInvocable, true);
}
const loaded = await provider.get(candidates.find((c) => c.name === "supabase"));
assert.ok(loaded.content.includes("Security checklist"), "vendored supabase SKILL.md content loads");
const loadedPg = await provider.get(candidates.find((c) => c.name === "supabase-postgres-best-practices"));
assert.ok(loadedPg.content.includes("Postgres best practices"), "vendored postgres SKILL.md content loads");

// Prompt section.
assert.equal(recorded.sections.length, 1, "one prompt section");
assert.ok(recorded.sections[0].text.includes("mcp__supabase__"), "guidance names the tool namespace");

// Auth routes registered on the web server, each mirrored under /api for the shell fetch bridge.
assert.equal(recorded.routes.length, 10, "five routes, each mirrored under /api");
const paths = recorded.routes.map((r) => r.path);
assert.deepEqual(paths, [
	"/supabase/auth/whoami", "/api/supabase/auth/whoami",
	"/supabase/auth/disconnect", "/api/supabase/auth/disconnect",
	"/supabase/guard", "/api/supabase/guard",
	"/supabase/auth/start", "/api/supabase/auth/start",
	"/supabase/auth/callback", "/api/supabase/auth/callback"
]);
const startRoute = recorded.routes.find((r) => r.path === "/supabase/auth/start");
const callbackRoute = recorded.routes.find((r) => r.path === "/supabase/auth/callback");
const whoamiRoute = recorded.routes.find((r) => r.path === "/api/supabase/auth/whoami");

// Whoami reports the Host origin to any shell.
const whoami = await whoamiRoute.resource(new Request("http://127.0.0.1:63928/api/supabase/auth/whoami"));
assert.equal(whoami.status, 200, "whoami answers");
const whoamiBody = await whoami.json();
assert.equal(whoamiBody.authStartUrl, "http://127.0.0.1:63928/supabase/auth/start", "whoami reports the sign-in URL");

// Browser OAuth start: discovery + DCR + PKCE redirect.
const startResponse = await startRoute.resource(new Request("http://127.0.0.1:63928/supabase/auth/start"));
assert.equal(startResponse.status, 302, "start redirects to Supabase");
const authorizeUrl = new URL(startResponse.headers.get("location"));
assert.equal(authorizeUrl.origin, "https://auth.example");
assert.equal(authorizeUrl.searchParams.get("client_id"), "test-client");
assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
assert.ok(authorizeUrl.searchParams.get("code_challenge").length > 20, "PKCE challenge present");
const state = authorizeUrl.searchParams.get("state");
assert.ok(state.length > 10, "state present");
assert.equal(authorizeUrl.searchParams.get("redirect_uri"), "http://127.0.0.1:63928/supabase/auth/callback");

// Browser OAuth callback: code exchange, credential commit, env bridge, reconnect.
const callbackResponse = await callbackRoute.resource(
	new Request(`http://127.0.0.1:63928/supabase/auth/callback?code=abc&state=${state}`)
);
assert.equal(callbackResponse.status, 200, "callback answers the browser");
const html = await callbackResponse.text();
assert.ok(html.includes("Supabase connected"), "success page rendered");
assert.deepEqual(recorded.sets, [{ key: "SUPABASE_ACCESS_TOKEN", value: "at-123" }], "access token committed to the credential store");
assert.equal(process.env.SUPABASE_ACCESS_TOKEN, "at-123", "env bridge carries the token to the MCP row");
const grant = recorded.records.find((r) => r.key === "dsh-supabase/oauth");
assert.equal(grant.payload.refresh_token, "rt-123", "refresh token stored as a grant record");
assert.equal(grant.payload.client_secret, "s3cret", "client secret kept in the grant for refreshes");
assert.ok(tokenBodies.length > 0 && tokenBodies[0].includes("client_secret=s3cret"), "token exchange presents the registered client secret");
assert.ok(recorded.edited.some((e) => e.entryId === "mcp-row-42"), "connection reload finds the row by configuration");

// Callback errors surface as friendly pages, never as crashes.
const badState = await callbackRoute.resource(new Request("http://127.0.0.1:63928/supabase/auth/callback?code=abc&state=nope"));
assert.equal(badState.status, 200);
assert.ok((await badState.text()).includes("expired"), "unknown state gets a friendly page");
const declined = await callbackRoute.resource(new Request("http://127.0.0.1:63928/supabase/auth/callback?error=access_denied"));
assert.ok((await declined.text()).includes("cancelled"), "declined sign-in gets a friendly page");

// A failing token exchange echoes the server's own error body to the user.
tokenFailBody = "client_secret required";
const start2 = await startRoute.resource(new Request("http://127.0.0.1:63928/supabase/auth/start"));
const state2 = new URL(start2.headers.get("location")).searchParams.get("state");
const failed = await callbackRoute.resource(new Request(`http://127.0.0.1:63928/supabase/auth/callback?code=abc&state=${state2}`));
assert.ok((await failed.text()).includes("client_secret required"), "server error body is echoed on failure");
tokenFailBody = undefined;

// Commands: six registered with distinct plugin-namespaced identities.
assert.deepEqual(recorded.commands.map((c) => c.name), ["supabase", "supabase-auth", "supabase-connect", "supabase-disconnect", "supabase-guard", "supabase-review"]);
assert.equal(new Set(recorded.commands.map((c) => c.definitionId)).size, 6, "each command carries its own definitionId");
const status = await recorded.commands[0].handler({});
assert.equal(status.kind, "success");
assert.ok(status.text.includes("Supabase integration status"), "status command output");
assert.ok(status.text.includes("configured (test-store)"), "status reads the credential store");
assert.ok(status.text.includes("2 ready (mcp__supabase__*)"), "status reports the live MCP tool count");
assert.ok(status.text.includes("browser sign-in"), "status reports the sign-in method");
const auth = await recorded.commands[1].handler({});
assert.equal(auth.kind, "success");
assert.ok(auth.text.includes("/supabase/auth/start"), "auth command returns the sign-in link");
const connect = await recorded.commands[2].handler({});
assert.equal(connect.kind, "success");
assert.ok(connect.text.includes("reloaded"), "connect command reloads the MCP row");
assert.ok(recorded.edited.some((e) => e.entryId === "mcp-row-42" && e.config.toolCallTimeoutMs === 60001), "reconnect nudges the matched MCP row");
const review = await recorded.commands.find((c) => c.name === "supabase-review").handler({});
assert.ok(review.text.includes("RLS is enabled"), "review checklist output");

// Agent tool: registered and executable.
assert.equal(recorded.tools.length, 1, "one agent tool");
assert.equal(recorded.tools[0].name, "supabase_status");
const toolResult = await recorded.tools[0].execute({}, { agent: {} });
assert.ok(toolResult.status.includes("Supabase integration status"), "tool execute returns status");

// Guardrail: destructive SQL, cost, project-affecting, and passthrough.
const guard = recorded.listeners.find((l) => l.name === "tools/pre-execute").handler;
const allow = () => ({ kind: "allow" });
const call = (name, args) => guard({ name, arguments: args, agent: {} }, allow);

let decision = await call("mcp__supabase__execute_sql", { query: "drop table users" });
assert.equal(decision.kind, "ask", "DROP TABLE asks");
assert.ok(decision.displayReason.en && decision.displayReason.zh, "localized ask text");
decision = await call("mcp__supabase__execute_sql", { query: "delete from users" });
assert.equal(decision.kind, "ask", "DELETE without WHERE asks");
decision = await call("mcp__supabase__execute_sql", { query: "update users set active = true" });
assert.equal(decision.kind, "ask", "UPDATE without WHERE asks");
decision = await call("mcp__supabase__apply_migration", { query: "truncate table sessions" });
assert.equal(decision.kind, "ask", "TRUNCATE asks");
decision = await call("mcp__supabase__execute_sql", { query: "select * from users where id = 1" });
assert.equal(decision.kind, "allow", "SELECT passes");
decision = await call("mcp__supabase__apply_migration", {
	name: "m",
	query: "create table t (id int); alter table t enable row level security; create policy p on t for update to authenticated using (true); grant select, insert, update on t to anon, authenticated;"
});
assert.equal(decision.kind, "allow", "standard DDL and GRANT are not destructive");
decision = await call("mcp__supabase__execute_sql", { query: "drop table users" });
assert.ok(decision.reason.includes("DROP"), "the block names the matched pattern");
decision = await call("mcp__supabase__execute_sql", { query: "delete from users where id = 1" });
assert.equal(decision.kind, "allow", "DELETE with WHERE passes");
decision = await call("mcp__supabase__execute_sql", { query: "update users set active = true where id = 1" });
assert.equal(decision.kind, "allow", "UPDATE with WHERE passes");
decision = await call("mcp__supabase__create_project", { name: "x" });
assert.equal(decision.kind, "ask", "create_project asks (charges)");
decision = await call("mcp__supabase__deploy_edge_function", { slug: "fn" });
assert.equal(decision.kind, "ask", "deploy_edge_function asks (project-affecting)");
decision = await call("mcp__supabase__list_tables", {});
assert.equal(decision.kind, "allow", "read-only Supabase tools pass");
decision = await call("read", { file_path: "x" });
assert.equal(decision.kind, "allow", "non-Supabase tools pass untouched");

// Toggles: disabled categories pass.
const { ctx: ctx2, recorded: r2 } = makeCtx();
apply(ctx2, { confirmDestructiveSql: false, confirmCostlyOperations: false, confirmProjectAffecting: false });
const guard2 = r2.listeners.find((l) => l.name === "tools/pre-execute").handler;
decision = await guard2({ name: "mcp__supabase__execute_sql", arguments: { query: "drop table users" }, agent: {} }, allow);
assert.equal(decision.kind, "allow", "guardrail toggle disables the ask");

// Credential watch: token change bridges env and reloads, other keys do not.
const watch = recorded.listeners.find((l) => l.name === "credentials/reference-updated").handler;
watch("OTHER_KEY");
const editsBefore = recorded.edited.length;
watch("SUPABASE_ACCESS_TOKEN");
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(recorded.edited.length, editsBefore + 1, "token change reloads the MCP row");

// Index injection publishes the real sign-in URL to every shell.
const injectHandler = recorded.listeners.find((l) => l.name === "webserver/index-inject").handler;
const injectTable = [];
injectHandler(injectTable);
assert.equal(injectTable.length, 1, "one index injection row");
assert.equal(injectTable[0].kind, "global", "global boot row");
assert.equal(injectTable[0].name, "__DSH_SUPABASE__");
assert.equal(injectTable[0].value.authStartUrl, "http://127.0.0.1:63928/supabase/auth/start", "Host origin carried to the page");

// Without approval prompts the guard asks through the user-question dialogue,
// the channel that works even where prompts are disabled (proven by the
// ask_user_question flow in real sessions).
recorded.approvalPolicy = "never";
recorded.nextAnswer = { answers: [{ id: "supabase-guard", selected: ["Yes, proceed"] }] };
const viaDialogue = await call("mcp__supabase__apply_migration", { name: "m", query: "drop table users" });
assert.equal(viaDialogue.kind, "allow", "an approved question answer runs the call");
assert.equal(recorded.questions.length, 1, "the confirmation used the question dialogue");
assert.ok(recorded.questions[0].agent !== undefined, "the question is routed to the calling agent");
recorded.nextAnswer = { answers: [{ id: "supabase-guard", selected: ["No, cancel"] }] };
const declinedByUser = await call("mcp__supabase__apply_migration", { name: "m", query: "drop table users" });
assert.equal(declinedByUser.kind, "deny", "a declined answer blocks the call");
assert.equal(declinedByUser.info.code, "SUPABASE_GUARD_DECLINED");
recorded.nextAnswer = { answers: [{ id: "supabase-guard", selected: [] }] };
const skippedByUser = await call("mcp__supabase__apply_migration", { name: "m", query: "drop table users" });
assert.equal(skippedByUser.kind, "deny", "a skipped answer is never permission");
recorded.questionsDisabled = true;
const noChannel = await call("mcp__supabase__apply_migration", { name: "m", query: "drop table users" });
assert.equal(noChannel.kind, "deny", "no channel means a clear block, not a phantom ask");
assert.equal(noChannel.info.code, "SUPABASE_GUARD_CONFIRMATION_UNAVAILABLE");
assert.ok(noChannel.reason.includes("/supabase guard"), "the block names the user-side remedies");
recorded.questionsDisabled = false;
recorded.approvalPolicy = undefined;
const reAsk = await call("mcp__supabase__apply_migration", { name: "m", query: "drop table users" });
assert.equal(reAsk.kind, "ask", "with prompts available the ask returns");

// Guardrail command: status, toggles persisted to this plugin's row, usage help.
const guardCmd = recorded.commands.find((c) => c.name === "supabase-guard");
const guardStatus = await guardCmd.handler({ rawInput: "" });
assert.ok(guardStatus.text.includes("destructive SQL asks"), "guard status reports current toggles");
const guardEditStart = recorded.edited.length;
const guardToggle = await guardCmd.handler({ rawInput: "project off" });
assert.equal(guardToggle.kind, "success");
assert.equal(recorded.edited.length, guardEditStart + 1, "toggle persists through the config editor");
assert.equal(recorded.edited.at(-1).entryId, "supabase", "the plugin edits its own row");
assert.equal(recorded.edited.at(-1).config.confirmProjectAffecting, false, "project confirmations switched off");
const guardBad = await guardCmd.handler({ rawInput: "project maybe" });
assert.equal(guardBad.kind, "error", "invalid usage is rejected");

// The /supabase command carries the guard subcommand for robust dispatch,
// since some clients only recognize well-known command names.
const supabaseCmd = recorded.commands.find((c) => c.name === "supabase");
const viaSub = await supabaseCmd.handler({ rawInput: "guard destructive off" });
assert.equal(viaSub.kind, "success");
assert.equal(recorded.edited.at(-1).config.confirmDestructiveSql, false, "subcommand persists the toggle");
const badSub = await supabaseCmd.handler({ rawInput: "nonsense" });
assert.equal(badSub.kind, "error", "unknown subcommand shows usage");

// Guard settings route: confirmation required, then the same persistence.
const guardRoute = recorded.routes.find((r) => r.path === "/supabase/guard");
const guardNoConfirm = await guardRoute.resource(new Request("http://127.0.0.1:63928/supabase/guard?destructive=off"));
assert.ok((await guardNoConfirm.text()).includes("Confirm guardrail change"), "guard route requires confirmation");
const guardOk = await guardRoute.resource(new Request("http://127.0.0.1:63928/supabase/guard?confirm=1&destructive=off"));
assert.ok((await guardOk.text()).includes("saved"), "guard route saves the toggle");
assert.equal(recorded.edited.at(-1).config.confirmDestructiveSql, false, "destructive confirmations switched off");
const guardAll = await guardRoute.resource(new Request("http://127.0.0.1:63928/supabase/guard?confirm=1&all=off"));
assert.equal(recorded.edited.at(-1).config.confirmProjectAffecting, false, "all=off switches every category");

// The confirmation dialog carries the switch itself: "stop asking" proceeds
// and turns that kind of confirmation off for good, no commands needed.
const questionsBefore = recorded.questions.length;
recorded.approvalPolicy = "never";
recorded.nextAnswer = { answers: [{ id: "supabase-guard", selected: ["Yes, and stop asking for this"] }] };
const stopAsking = await call("mcp__supabase__execute_sql", { query: "drop table users" });
assert.equal(stopAsking.kind, "allow", "stop-asking proceeds with the call");
await new Promise((resolve) => setTimeout(resolve, 10));
assert.ok(recorded.edited.some((e) => e.config && e.config.confirmDestructiveSql === false), "and persists the switch off");
const silentAfter = await call("mcp__supabase__execute_sql", { query: "drop table users" });
assert.equal(silentAfter.kind, "allow", "the same category no longer asks");
assert.equal(recorded.questions.length, questionsBefore + 1, "only the first call opened a dialog");
recorded.approvalPolicy = undefined;

// Disconnect is terminal: run it last, after every test that needs the grant.
const disconnectRoute = recorded.routes.find((r) => r.path === "/supabase/auth/disconnect");
const noConfirm = await disconnectRoute.resource(new Request("http://127.0.0.1:63928/supabase/auth/disconnect"));
assert.ok((await noConfirm.text()).includes("Confirm sign-out"), "disconnect requires confirmation");
assert.equal(recorded.deleted.length, 0, "no cleanup without confirmation");
const editsBeforeDisc = recorded.edited.length;
const disc = await disconnectRoute.resource(new Request("http://127.0.0.1:63928/supabase/auth/disconnect?confirm=1"));
assert.ok((await disc.text()).includes("disconnected"), "disconnect completes");
assert.deepEqual(recorded.deleted, ["dsh-supabase/oauth"], "grant record deleted");
assert.ok(recorded.unsets.includes("SUPABASE_ACCESS_TOKEN"), "access token unset");
assert.equal(process.env.SUPABASE_ACCESS_TOKEN, undefined, "env bridge cleared");
assert.equal(recorded.edited.length, editsBeforeDisc + 1, "connection reloaded after disconnect");

globalThis.fetch = realFetch;
delete process.env.SUPABASE_ACCESS_TOKEN;
console.log("host E2E: PASS (skills, prompt, guardrail, commands, tool, credential watch, OAuth flow)");

// --- Client-side E2E -------------------------------------------------------

const clientCaptures = { slotsInject: [], slotsRegister: [], localeCalls: [] };
global.window = {
	__ModuleLoader__: {
		load(spec) {
			clientCaptures.spec = spec;
		}
	},
	location: { origin: "http://127.0.0.1:63928" }
};
await import("../client.js");
assert.ok(clientCaptures.spec, "client module registers a lazy factory");
assert.equal(clientCaptures.spec.id, "dsh-supabase", "factory id equals package name");

class FakeComponent {
	constructor(props) {
		this.props = props;
	}
}
const hookState = [];
let hookIndex = 0;
const fakeReact = {
	Component: FakeComponent,
	createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
	useState: (initial) => {
		const i = hookIndex++;
		if (!(i in hookState)) hookState[i] = typeof initial === "function" ? initial() : initial;
		return [hookState[i], (value) => { hookState[i] = typeof value === "function" ? value(hookState[i]) : value; }];
	},
	useCallback: (fn) => fn,
	useEffect: () => {}
};
const factoryResult = clientCaptures.spec.factory((moduleName) => {
	if (moduleName === "react") return fakeReact;
	throw new Error(`unexpected module ${moduleName}`);
});
assert.ok(factoryResult.inject.includes("slots"), "client injects slots");

factoryResult.apply({
	locale: {
		register(ns, ...rest) {
			clientCaptures.localeCalls.push([ns, ...rest.map((x) => (typeof x === "object" ? Object.keys(x) : x))]);
		},
		bind: (ns) => (key) => `t:${key}`
	},
	slots: {
		inject(name, cb) {
			clientCaptures.slotsInject.push(name);
			return cb();
		},
		register(options, component) {
			clientCaptures.slotsRegister.push({ options, component });
			return () => {};
		}
	},
	remote: { credentials: { describe: async () => ({}), set: async () => {}, unset: async () => {} } }
});

assert.deepEqual(clientCaptures.slotsInject, ["settings.section", "settings.section.icon", "conversation.composer.dock"], "expected slots registered");
const seat = clientCaptures.slotsRegister[0];
assert.equal(seat.options.id, "supabase", "settings page id");
assert.equal(seat.options.label(), "t:nav", "localized nav label");

// Render through the seat (error boundary when available) and reach the page body.
const tree = seat.component();
let body;
if (typeof tree.type === "function" && tree.type !== FakeComponent) {
	const instance = new tree.type({ children: tree.children[0] });
	body = instance.render();
} else {
	body = tree.children ? tree.children[0] : tree;
}
const renderPage = () => {
	hookIndex = 0;
	return typeof body.type === "function" ? body.type() : body;
};
const findElem = (node, pred) => {
	if (!node || typeof node !== "object") return undefined;
	if (pred(node)) return node;
	for (const child of node.children ?? []) {
		const hit = findElem(child, pred);
		if (hit) return hit;
	}
	return undefined;
};

// Desktop-like shell: no usable page origin. The buttons are always visible.
window.location = { origin: "null" };
delete globalThis.__DSH_TRANSPORT__;
const page = renderPage();
assert.equal(page.type, "div", "settings page renders a root div");
const flat = JSON.stringify(page);
assert.ok(flat.includes("tokenPlaceholder"), "PAT form present");
assert.ok(flat.includes("t:signInButton"), "sign-in button always present");
assert.ok(flat.includes("t:copyLink"), "copy action always present");
assert.ok(!flat.includes("t:signInNoUrl"), "guidance waits for a failed attempt");

// Clicking with no URL source and a dead probe reveals the guidance, never a dead end.
const opened = [];
window.open = (url) => {
	opened.push(url);
	return null;
};
const realFetch2 = globalThis.fetch;
globalThis.fetch = async () => {
	throw new Error("bridge unavailable");
};
hookState.length = 0;
let page2 = renderPage();
const signInButton = findElem(page2, (n) => n.type === "button" && n.children?.[0] === "t:signInButton");
await signInButton.props.onClick();
page2 = renderPage();
assert.ok(JSON.stringify(page2).includes("t:signInNoUrl"), "guidance shown after a failed attempt");
assert.deepEqual(opened, [], "nothing opened without a URL");

// The shell-carried Host origin (static desktop pages) supplies the URL.
globalThis.__DSH_TRANSPORT__ = { streamBaseUrl: "http://transport.example" };
hookState.length = 0;
let page3 = renderPage();
const signInButton2 = findElem(page3, (n) => n.type === "button" && n.children?.[0] === "t:signInButton");
opened.length = 0;
await signInButton2.props.onClick();
assert.deepEqual(opened, ["http://transport.example/supabase/auth/start"], "transport base URL is used");
page3 = renderPage();
assert.ok(JSON.stringify(page3).includes("http://transport.example/supabase/auth/start"), "link row revealed");
delete globalThis.__DSH_TRANSPORT__;

// The whoami probe through the fetch bridge supplies the URL and the status.
const whoamiPayload = {
	authStartUrl: "http://probe.example/supabase/auth/start",
	origin: "http://probe.example",
	tokenConfigured: true,
	tokenSource: "file",
	authMethod: "browser sign-in (Supabase account)",
	toolsCount: 31,
	toolsReady: true,
	guardrails: { confirmDestructiveSql: true, confirmCostlyOperations: true, confirmProjectAffecting: true }
};
globalThis.fetch = async (url) => {
	const target = String(url);
	assert.ok(target.includes("whoami"), `unexpected fetch ${target}`);
	return { ok: true, json: async () => whoamiPayload };
};
hookState.length = 0;
let page4 = renderPage();
const signInButton3 = findElem(page4, (n) => n.type === "button" && n.children?.[0] === "t:signInButton");
opened.length = 0;
await signInButton3.props.onClick();
assert.deepEqual(opened, ["http://probe.example/supabase/auth/start"], "probed Host URL is used");

// The copy button reports success even without a clipboard API.
const copyButton = findElem(renderPage(), (n) => n.type === "button" && n.children?.[0] === "t:copyLink");
assert.ok(copyButton, "copy button element found");
await copyButton.props.onClick();
assert.ok(JSON.stringify(renderPage()).includes("t:copied"), "copy feedback shown");
globalThis.fetch = realFetch2;

// An injected Host URL wins over everything else (server-rendered pages).
globalThis.__DSH_SUPABASE__ = { authStartUrl: "http://injected.example/supabase/auth/start" };
window.location = { origin: "http://page.example" };
hookState.length = 0;
let page5 = renderPage();
const signInButton4 = findElem(page5, (n) => n.type === "button" && n.children?.[0] === "t:signInButton");
opened.length = 0;
await signInButton4.props.onClick();
assert.deepEqual(opened, ["http://injected.example/supabase/auth/start"], "injected Host URL is used");
delete globalThis.__DSH_SUPABASE__;

// --- Live status: three-state display driven by the Host snapshot ----------
const disconnectCalls = [];
const guardCalls = [];
globalThis.fetch = async (url) => {
	const target = String(url);
	if (target.includes("whoami")) return { ok: true, json: async () => whoamiPayload };
	if (target.includes("disconnect")) {
		disconnectCalls.push(target);
		return { ok: true };
	}
	if (target.includes("guard")) {
		guardCalls.push(target);
		return { ok: true };
	}
	throw new Error(`unexpected fetch ${target}`);
};
window.location = { origin: "null" };
hookState.length = 0;
let statusPage = renderPage();
const refreshBtn = findElem(statusPage, (n) => n.type === "button" && n.children?.[0] === "t:refreshLabel");
assert.ok(refreshBtn, "refresh button present");
await refreshBtn.props.onClick();
statusPage = renderPage();
const statusFlat = JSON.stringify(statusPage);
assert.ok(statusFlat.includes("t:tokenConfigured"), "confirmed state shown from the Host snapshot");
assert.ok(statusFlat.includes("31 t:toolsReadyCount"), "live MCP tool count shown");
assert.ok(statusFlat.includes("t:disconnectLabel"), "disconnect action present");

// Guardrail toggles are on the page and reach the Host with confirmation.
const guardBtn = findElem(statusPage, (n) => n.type === "button" && n.props && n.props["aria-pressed"] === true && JSON.stringify(n.children ?? []).includes("t:guardOn"));
assert.ok(guardBtn, "guardrail toggle present");
await guardBtn.props.onClick();
assert.ok(guardCalls.some((u) => u.includes("guard?confirm=1") && u.includes("destructive=off")), "toggle sends the confirmed change");

// The in-session composer pill switches every guardrail without commands.
const pill = clientCaptures.slotsRegister.find((r) => r.options.id === "supabase-guard");
assert.ok(pill, "composer dock pill registered");
assert.deepEqual(clientCaptures.slotsInject, ["settings.section", "settings.section.icon", "conversation.composer.dock"], "settings page, nav icon, and dock pill all register");
const navIcon = clientCaptures.slotsRegister.find((r) => r.options.name === "settings.section.icon");
assert.ok(navIcon, "settings nav icon registered");
const iconTree = navIcon.component();
assert.equal(iconTree.type, "svg", "nav icon renders a glyph");
hookIndex = 0;
const pillTree = pill.component();
assert.ok(JSON.stringify(pillTree).includes("t:guardPillLabel"), "pill renders in the session UI");
const pillButton = findElem(pillTree, (n) => n.type === "button");
assert.ok(pillButton, "pill toggle present");
assert.equal(pillButton.props["aria-pressed"], true, "pill reflects the guarded state");
await pillButton.props.onClick();
assert.ok(guardCalls.some((u) => u.includes("all=off")), "pill switches all guardrails off");

// Disconnect sends the confirmed sign-out and reports it.
const disconnectBtn = findElem(statusPage, (n) => n.type === "button" && n.children?.[0] === "t:disconnectLabel");
assert.ok(disconnectBtn, "disconnect button found");
await disconnectBtn.props.onClick();
assert.ok(disconnectCalls.some((u) => u.includes("disconnect?confirm=1")), "disconnect sends confirm=1");
statusPage = renderPage();
assert.ok(JSON.stringify(statusPage).includes("t:disconnectStarted"), "disconnect feedback shown");

// Unconfirmed state: nothing speaks, and the page says so instead of lying.
globalThis.fetch = async () => {
	throw new Error("all sources down");
};
hookState.length = 0;
let unconfirmedPage = renderPage();
const refreshBtn2 = findElem(unconfirmedPage, (n) => n.type === "button" && n.children?.[0] === "t:refreshLabel");
await refreshBtn2.props.onClick();
unconfirmedPage = renderPage();
const unflat = JSON.stringify(unconfirmedPage);
assert.ok(unflat.includes("t:statusUnconfirmed"), "unconfirmed state shown distinctly");
assert.ok(!unflat.includes("t:tokenMissing"), "unconfirmed is never reported as missing");
globalThis.fetch = realFetch2;

const { readFile } = await import("node:fs/promises");
for (const file of ["../client.js", "../index.js", "../README.md"]) {
	const source = await readFile(new URL(file, import.meta.url), "utf8");
	assert.ok(!source.includes("\u2014"), `no em dashes in ${file}`);
}

// A crashing page shows the boundary card instead of a blank panel.
if (tree.type !== FakeComponent && typeof tree.type === "function") {
	const Boundary = tree.type;
	const instance = new Boundary({ children: null });
	instance.state = Boundary.getDerivedStateFromError(new Error("boom"));
	const card = instance.render();
	const errEl = card.children.find((c) => c && typeof c.type === "function");
	const errTree = errEl.type(errEl.props);
	assert.ok(JSON.stringify(errTree).includes("boom"), "error boundary renders the fault");
}

console.log("client E2E: PASS (factory, locale, settings slot, dual auth render, error boundary)");
console.log("ALL TESTS PASS");

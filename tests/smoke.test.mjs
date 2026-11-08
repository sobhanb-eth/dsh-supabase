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
	const recorded = { providers: [], sections: [], listeners: [], commands: [], tools: [], edited: [], routes: [], sets: [], records: [] };
	const recordStore = new Map();
	const ctx = {
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
			}
		},
		get(name) {
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
					}
				};
			}
			if (name === "configEditor") {
				return {
					entries: () => [{ id: "supabase-mcp" }],
					edit: async (_entry, change) => {
						recorded.edited.push(change({ toolCallTimeoutMs: 60000 }));
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
		return Response.json({ client_id: "test-client" });
	}
	if (target === "https://auth.example/token" && (options.method ?? "GET") === "POST") {
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

// Auth routes registered on the web server.
assert.equal(recorded.routes.length, 2, "two OAuth routes");
assert.deepEqual(recorded.routes.map((r) => r.path), ["/supabase/auth/start", "/supabase/auth/callback"]);
const startRoute = recorded.routes[0];
const callbackRoute = recorded.routes[1];

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
assert.ok(recorded.edited.length >= 1, "connection reload nudged after sign-in");

// Callback errors surface as friendly pages, never as crashes.
const badState = await callbackRoute.resource(new Request("http://127.0.0.1:63928/supabase/auth/callback?code=abc&state=nope"));
assert.equal(badState.status, 200);
assert.ok((await badState.text()).includes("expired"), "unknown state gets a friendly page");
const declined = await callbackRoute.resource(new Request("http://127.0.0.1:63928/supabase/auth/callback?error=access_denied"));
assert.ok((await declined.text()).includes("cancelled"), "declined sign-in gets a friendly page");

// Commands: four registered, handlers produce real output.
assert.deepEqual(recorded.commands.map((c) => c.name), ["supabase", "supabase-auth", "supabase-connect", "supabase-review"]);
const status = await recorded.commands[0].handler({});
assert.equal(status.kind, "success");
assert.ok(status.text.includes("Supabase integration status"), "status command output");
assert.ok(status.text.includes("configured (test-store)"), "status reads the credential store");
assert.ok(status.text.includes("browser sign-in"), "status reports the sign-in method");
const auth = await recorded.commands[1].handler({});
assert.equal(auth.kind, "success");
assert.ok(auth.text.includes("/supabase/auth/start"), "auth command returns the sign-in link");
const connect = await recorded.commands[2].handler({});
assert.equal(connect.kind, "success");
assert.ok(connect.text.includes("reloaded"), "connect command reloads the MCP row");
const review = await recorded.commands[3].handler({});
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
const fakeReact = {
	Component: FakeComponent,
	createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
	useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
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

assert.deepEqual(clientCaptures.slotsInject, ["settings.section"], "client registers a settings page slot");
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
const page = typeof body.type === "function" ? body.type() : body;
assert.equal(page.type, "div", "settings page renders a root div");
const flat = JSON.stringify(page);
assert.ok(flat.includes("supabase/auth/start"), "OAuth sign-in link present");
assert.ok(flat.includes("tokenPlaceholder"), "PAT form present");
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

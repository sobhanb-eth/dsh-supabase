# dsh-supabase: Supabase for DeepSeek Harness

Connect DeepSeek Harness agents to Supabase projects with the official Supabase MCP server, the official Supabase and Postgres agent skills, and native DSH safety guardrails. One install, no manual configuration.

## What you get

| Capability | Details |
|---|---|
| MCP tools | The Supabase MCP server as `mcp__supabase__*`: query data, manage migrations, deploy Edge Functions, read logs and advisors, search docs, branching, and more. The same tool naming as Claude Code and Codex. |
| Agent skills | `supabase` and `supabase-postgres-best-practices`, vendored from [supabase/agent-skills](https://github.com/supabase/agent-skills) (MIT) and loaded on demand by the agent. |
| Sign-in, your way | Browser sign-in with your Supabase account (organization access, automatic token refresh), or a scoped personal access token for CI and headless use. Both live on the Supabase settings page. |
| Guardrails | A pre-execution gate asks for your confirmation before destructive SQL (DROP, TRUNCATE, or DELETE/UPDATE without WHERE), chargeable operations (create_project, create_branch), and project-affecting calls (deploys, branch merges, resets, deletions, pauses). |
| Commands | `/supabase` shows connection and safety status. `/supabase-auth` gives the browser sign-in link. `/supabase-connect` reloads the connection. `/supabase-review` shows the Supabase security review checklist. |
| Agent tool | `supabase_status` reports the same status to the agent. |
| Settings page | Settings, then Supabase: both sign-in paths, live connection status, guardrail documentation, and getting-started steps, in English and Chinese. |
| Auto-reconnect | Signing in or rotating a token reloads the MCP connection automatically. |

## Install

From a local checkout or any directory containing this package:

1. Ask the agent to install the bundle with `plugin_manager install_bundle`, pointing at this package directory.
2. Confirm the Plugins page shows Supabase with its icon and description.
3. Open Settings, then Supabase, and sign in with either method.
4. In any session, run `/supabase-connect`, then ask something like "What tables are in my database?"

Distributing publicly: publish this directory as a git repository and add it as a custom plugin index (Plugins, then Discover), or ship it inside your own plugin index. The package has no dependencies and no build step.

## Signing in

**Browser sign-in (recommended).** Click "Open Supabase sign-in" on the settings page, or run `/supabase-auth`. The browser flow uses OAuth with dynamic client registration and PKCE, the same mechanism Codex and Claude Code use. During sign-in you choose the organization, so the projects that organization owns are what the session can reach. Access tokens refresh on their own.

**Personal access token.** Best for CI, headless setups, or when browser sign-in is not available. Create a [scoped token](https://supabase.com/docs/guides/platform/personal-access-tokens) limited to the projects and permissions the task needs and paste it on the settings page, or export `SUPABASE_ACCESS_TOKEN` in the environment.

## Configuration

The bundle patch (`cordis.patch.yml`) inserts two rows: `supabase` (this plugin) and `supabase-mcp` (the Supabase MCP connection).

- **Endpoint.** Defaults to `https://mcp.supabase.com/mcp`. Set `SUPABASE_MCP_URL` to scope to one project or to enable read-only mode, for example `https://mcp.supabase.com/mcp?project_ref=<ref>&read_only=true&features=database,docs`.
- **Guardrail toggles.** `confirmDestructiveSql`, `confirmCostlyOperations`, and `confirmProjectAffecting` live in the `supabase` row config (Plugins, then Supabase, then configuration).
- **Local development.** With `supabase start` running, the Supabase CLI serves a local MCP endpoint at `http://localhost:54321/mcp` (a reduced tool set, no OAuth). Point `SUPABASE_MCP_URL` there for offline work.

## Security model

- Sign-in secrets live in the DSH credential store (`SUPABASE_ACCESS_TOKEN`, plus a private grant record for token refresh). They never appear in configuration files, chat, or model context. Token entry and sign-in are user-only, so no agent tool can set or read them.
- Guardrails run before every Supabase tool dispatch and pause for explicit human confirmation. They add to DSH approval prompts rather than replacing them, and DSH's file sandboxes still apply to file tools.
- Scoping the connection (`project_ref`, `read_only`, `features`) remains the strongest control. Prefer it for production projects.
- The bundled skills are instructions, not enforcement. The Supabase MCP docs carry their own [security guidance](https://supabase.com/docs/guides/ai-tools/mcp#security-risks), which applies here too.

## Tests

`npm test` runs an end-to-end suite against the real plugin artifacts: skill loading over the vendored files, the guardrail decision table, all commands, the agent tool, the credential watch, the full browser OAuth flow (discovery, dynamic client registration, PKCE, callback, token commit) against a stubbed authorization server, and the settings page render including its error boundary.

## Known limitations

- The DSH MCP bridge does not render Supabase's server-side confirmation dialogs (cost, SQL, and notebook confirmations). Supabase falls back gracefully, and this plugin's guardrails with DSH approval prompts provide the confirmation layer instead.
- Skills are a vendored snapshot and Supabase updates them frequently upstream. Refresh the `skills/` directory from new [supabase/agent-skills](https://github.com/supabase/agent-skills) releases to stay current.

## Attribution and license

MIT. The `skills/` directory is vendored from [Supabase Agent Skills](https://github.com/supabase/agent-skills), copyright Supabase, MIT (`skills/LICENSE.agent-skills`), with each skill's changelog retained. The icon is original artwork created for this bundle. Supabase and the Supabase mark are trademarks of Supabase, Inc. This community plugin is not an official Supabase product.

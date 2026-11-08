/**
 * Validate index.json against the DSH plugin market index format 1 rules
 * (mirrored from @deepseek-ai/dsh-plugin-market-index) so a published index
 * is always accepted by the Discover tab. Skips cleanly when index.json is
 * not present yet; it is published together with the release commit it pins.
 *
 * Run with: node tests/market-index.test.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const NUMERIC = "(?:0|[1-9]\\d*)";
const PRERELEASE_PART = `(?:${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
const SEMVER = new RegExp(`^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-${PRERELEASE_PART}(?:\\.${PRERELEASE_PART})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`, "u");
const COMMIT = /^[0-9a-f]{40}$/u;
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/u;

let raw;
try {
	raw = await readFile(new URL("../index.json", import.meta.url), "utf8");
} catch {
	console.log("market index: SKIP (index.json is published with the release commit it pins)");
	process.exit(0);
}
const doc = JSON.parse(raw);

function localizedText(value, where) {
	if (typeof value === "string") {
		assert.notEqual(value.trim(), "", `${where} must not be blank`);
		return;
	}
	assert.equal(typeof value, "object", `${where} must be a string or language map`);
	assert.notEqual(value, null, `${where} must not be null`);
	for (const [language, member] of Object.entries(value)) {
		assert.ok(LANGUAGE_ID.test(language), `${where}.${language} must be a lowercase language id`);
		assert.equal(typeof member, "string", `${where}.${language} must be a string`);
	}
	assert.ok("en" in value, `${where} must contain en`);
}

assert.equal(doc.format, 1, "format must be 1");
localizedText(doc.title, "$.title");
if (doc.description !== undefined) localizedText(doc.description, "$.description");
assert.ok(Array.isArray(doc.plugins), "$.plugins must be an array");

const declaredCategories = new Set(Object.keys(doc.metadata?.categories ?? {}));
const names = new Set();
for (const [i, plugin] of doc.plugins.entries()) {
	const at = `$.plugins[${i}]`;
	assert.ok(PACKAGE_NAME.test(plugin.name) && plugin.name.length <= 214, `${at}.name must be a valid npm package name`);
	assert.ok(!names.has(plugin.name), `${at}.name must be unique`);
	names.add(plugin.name);
	if (plugin.title !== undefined) localizedText(plugin.title, `${at}.title`);
	if (plugin.description !== undefined) localizedText(plugin.description, `${at}.description`);
	if (plugin.homepage !== undefined) assert.ok(URL.canParse(plugin.homepage), `${at}.homepage must be an absolute URL`);
	if (plugin.metadata?.category !== undefined) {
		assert.ok(declaredCategories.has(plugin.metadata.category), `${at}.metadata.category must be declared in metadata.categories`);
	}
	assert.ok(Array.isArray(plugin.versions) && plugin.versions.length > 0, `${at}.versions must be a non-empty array`);
	const versions = new Set();
	for (const [j, version] of plugin.versions.entries()) {
		const vat = `${at}.versions[${j}]`;
		assert.ok(SEMVER.test(version.version), `${vat}.version must be an exact SemVer version`);
		assert.ok(!versions.has(version.version), `${vat}.version must be unique`);
		versions.add(version.version);
		assert.ok(Number.isInteger(version.publishTimestamp) && version.publishTimestamp >= 0 && version.publishTimestamp < 1e11,
			`${vat}.publishTimestamp must be Unix seconds in [0, 10^11)`);
		const source = version.source;
		assert.ok(source && (source.type === "npm" || source.type === "git"), `${vat}.source.type must be npm or git`);
		if (source.type === "git") {
			assert.ok(COMMIT.test(source.commit), `${vat}.source.commit must be a lowercase 40-hex commit`);
			const url = new URL(source.url);
			assert.equal(url.href, source.url, `${vat}.source.url must be canonical`);
			assert.equal(url.protocol, "https:", `${vat}.source.url must use https`);
			assert.ok(/^(?:\/[^/]+){2,}$/u.test(url.pathname), `${vat}.source.url must name a repository`);
			assert.ok(!/\.(?:tgz|tar\.gz)$/iu.test(url.pathname), `${vat}.source.url must not be a tarball`);
			if (source.path !== undefined) {
				assert.ok(source.path.split("/").every((s) => s !== "." && s !== ".." && PATH_SEGMENT.test(s)), `${vat}.source.path must be a clean relative directory`);
			}
		}
		if (version.engines?.dsh !== undefined) {
			assert.ok(version.engines.dsh !== "workspace:" && version.engines.dsh.trim() !== "", `${vat}.engines.dsh must be a SemVer range`);
		}
	}
}

console.log(`market index: PASS (${doc.plugins.length} plugin(s), format 1 rules satisfied)`);

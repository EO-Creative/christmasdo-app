import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test as nodeTest } from "node:test";
import { fileURLToPath } from "node:url";
import {
	getCachedVenueResults, venueCacheKey, VENUE_CACHE_MAX_BYTES,
	VENUE_CACHE_MAX_ENTRIES, VENUE_CACHE_TTL_MS,
} from "./venue-cache.ts";

let DatabaseSync;
try {
	({ DatabaseSync } = await import("node:sqlite"));
} catch (error) {
	if (error.code !== "ERR_UNKNOWN_BUILTIN_MODULE" || process.execArgv.includes("--experimental-sqlite")) throw error;
}
const test = DatabaseSync ? nodeTest : () => {};
if (!DatabaseSync) {
	nodeTest("cache tests with experimental SQLite on older Node versions", () => {
		const child = spawnSync(process.execPath, ["--experimental-sqlite", "--experimental-strip-types", "--test", fileURLToPath(import.meta.url)], { encoding: "utf8" });
		assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
	});
}

const migration = readFileSync(new URL("../../migrations/0003_venue_cache.sql", import.meta.url), "utf8");

class MemoryD1 {
	sqlite = new DatabaseSync(":memory:");
	failRead = false;
	failDelete = false;
	failBatchAt = -1;
	beforeDelete;

	constructor() {
		this.sqlite.exec(migration);
	}

	prepare(query) {
		return { bind: (...values) => ({
			first: async () => {
				if (this.failRead) throw new Error("read failed");
				return this.sqlite.prepare(query).get(...values) ?? null;
			},
			run: async () => {
				if (query.startsWith("DELETE") && this.failDelete) throw new Error("delete failed");
				if (this.beforeDelete && query.includes("cache_key = ? AND expires_at <= ?")) this.beforeDelete();
				this.sqlite.prepare(query).run(...values);
				return { success: true };
			},
		}) };
	}

	async batch(statements) {
		this.sqlite.exec("BEGIN");
		try {
			for (const [index, statement] of statements.entries()) {
				if (this.failBatchAt === index) throw new Error("batch failed");
				await statement.run();
			}
			this.sqlite.exec("COMMIT");
		} catch (error) {
			this.sqlite.exec("ROLLBACK");
			throw error;
		}
	}
}

const search = {
	latitude: 53.96, longitude: -1.08, radiusKm: 5, groupSize: 10,
	types: ["food", "activities"],
	filters: { activityCategories: ["sport.ice_rink", "entertainment.bowling_alley"], cuisineCategories: ["catering.restaurant.italian"], socialGames: false },
};
const venue = {
	id: "venue-1", type: "node", lat: 53.96, lon: -1.08, distance: 125,
	address: "A street", category: "restaurant", tags: { name: "Restaurant", capacity: "30" },
};
const results = { activities: [], food: [venue], drinks: [] };

test("keys are deterministic, order independent, and contain no credentials", async () => {
	const key = await venueCacheKey({ ...search, apiKey: "secret", prompt: "secret prompt" });
	const reordered = {
		...search, types: [...search.types].reverse(),
		filters: { ...search.filters, activityCategories: [...search.filters.activityCategories].reverse() },
	};
	assert.match(key, /^v1:[0-9a-f]{64}$/);
	assert.equal(key, await venueCacheKey(reordered));
	assert.equal(key, await venueCacheKey({ ...search, filters: { ...search.filters, activityCategories: [...search.filters.activityCategories, search.filters.activityCategories[0]] } }));
	assert.ok(!key.includes("secret"));
});

test("every result-affecting field changes the key, including very close coordinates", async () => {
	const key = await venueCacheKey(search);
	for (const variant of [
		{ latitude: search.latitude + 0.000000001 }, { longitude: search.longitude + 0.000000001 },
		{ radiusKm: 10 }, { groupSize: 11 }, { types: ["food"] },
		{ filters: { ...search.filters, activityCategories: [] } },
		{ filters: { ...search.filters, cuisineCategories: [] } },
		{ filters: { ...search.filters, socialGames: true } },
	]) assert.notEqual(await venueCacheKey({ ...search, ...variant }), key);
});

test("invalid inputs bypass the cache without key collisions", async () => {
	for (const variant of [
		{ latitude: NaN }, { longitude: 181 }, { radiusKm: 3 }, { groupSize: 0 },
		{ types: [] }, { types: ["food", "food"] }, { types: ["unknown"] },
		{ filters: { ...search.filters, socialGames: "yes" } },
		{ filters: { ...search.filters, activityCategories: ["api key"] } },
		{ filters: { ...search.filters, cuisineCategories: Array(33).fill("food") } },
	]) {
		const invalid = { ...search, ...variant };
		assert.equal(await venueCacheKey(invalid), undefined);
		const db = new MemoryD1();
		assert.equal(await getCachedVenueResults(db, invalid, async () => results), results);
		assert.equal(db.sqlite.prepare("SELECT count(*) AS count FROM venue_cache").get().count, 0);
		db.sqlite.close();
	}
});

test("misses cache normalized groups, hits without loading, and expires at twelve hours", async () => {
	const db = new MemoryD1();
	const key = await venueCacheKey(search);
	let calls = 0;
	const load = async () => { calls++; return results; };
	const before = Date.now();
	assert.deepEqual(await getCachedVenueResults(db, search, load), results);
	const row = db.sqlite.prepare("SELECT * FROM venue_cache WHERE cache_key = ?").get(key);
	assert.ok(row.expires_at >= before + VENUE_CACHE_TTL_MS && row.expires_at <= Date.now() + VENUE_CACHE_TTL_MS);
	assert.deepEqual(JSON.parse(row.results_json), results);
	assert.deepEqual(await getCachedVenueResults(db, search, load), results);
	assert.equal(calls, 1);
	db.sqlite.prepare("UPDATE venue_cache SET expires_at = ? WHERE cache_key = ?").run(Date.now() - 1, key);
	assert.deepEqual(await getCachedVenueResults(db, search, async () => {
		assert.equal(db.sqlite.prepare("SELECT * FROM venue_cache WHERE cache_key = ?").get(key), undefined);
		return load();
	}), results);
	assert.equal(calls, 2);
	db.sqlite.close();
});

test("expired-row deletion cannot remove a concurrent fresh replacement", async () => {
	const db = new MemoryD1();
	const key = await venueCacheKey(search);
	db.sqlite.prepare("INSERT INTO venue_cache VALUES (?, ?, ?)").run(key, JSON.stringify(results), Date.now() - 1);
	const freshExpiry = Date.now() + VENUE_CACHE_TTL_MS;
	db.beforeDelete = () => db.sqlite.prepare("UPDATE venue_cache SET expires_at = ? WHERE cache_key = ?").run(freshExpiry, key);
	await assert.rejects(getCachedVenueResults(db, search, async () => { throw new Error("provider failed"); }), /provider failed/);
	assert.equal(db.sqlite.prepare("SELECT expires_at FROM venue_cache WHERE cache_key = ?").get(key).expires_at, freshExpiry);
	db.sqlite.close();
});

test("expiry is exclusive at the exact TTL boundary", async () => {
	const db = new MemoryD1();
	const originalNow = Date.now;
	let now = 1700000000000;
	Date.now = () => now;
	try {
		let calls = 0;
		const load = async () => { calls++; return results; };
		await getCachedVenueResults(db, search, load);
		now += VENUE_CACHE_TTL_MS - 1;
		await getCachedVenueResults(db, search, load);
		assert.equal(calls, 1);
		now++;
		await getCachedVenueResults(db, search, load);
		assert.equal(calls, 2);
	} finally {
		Date.now = originalNow;
		db.sqlite.close();
	}
});

test("invalid, malformed, and unreasonably far-future rows are misses", async () => {
	const db = new MemoryD1();
	const key = await venueCacheKey(search);
	const insert = db.sqlite.prepare("INSERT OR REPLACE INTO venue_cache VALUES (?, ?, ?)");
	for (const [json, expires] of [
		["{", Date.now() + 10000],
		[JSON.stringify({ ...results, food: [{ ...venue, lat: 999 }] }), Date.now() + 10000],
		[JSON.stringify({ ...results, drinks: null }), Date.now() + 10000],
		[JSON.stringify(results), Date.now() + VENUE_CACHE_TTL_MS + 60000],
	]) {
		insert.run(key, json, expires);
		let calls = 0;
		assert.deepEqual(await getCachedVenueResults(db, search, async () => { calls++; return results; }), results);
		assert.equal(calls, 1);
		assert.deepEqual(JSON.parse(db.sqlite.prepare("SELECT results_json FROM venue_cache WHERE cache_key = ?").get(key).results_json), results);
	}
	db.sqlite.close();
});

test("oversized or invalid live results are returned without caching", async () => {
	const db = new MemoryD1();
	for (const invalid of [
		{ ...results, food: [{ ...venue, tags: { name: "é".repeat(VENUE_CACHE_MAX_BYTES / 2) } }] },
		{ ...results, food: Array(21).fill(venue) },
		{ ...results, food: [{ ...venue, tags: { name: "" } }] },
		{ ...results, extra: [] },
	]) {
		assert.equal(await getCachedVenueResults(db, search, async () => invalid), invalid);
		assert.equal(db.sqlite.prepare("SELECT count(*) AS count FROM venue_cache").get().count, 0);
	}
	assert.throws(() => db.sqlite.prepare("INSERT INTO venue_cache VALUES (?, ?, ?)").run("large", "é".repeat(VENUE_CACHE_MAX_BYTES / 2 + 1), Date.now()), /CHECK constraint failed/);
	db.sqlite.close();
});

test("missing D1, read/delete/write failures and provider errors behave safely", async () => {
	assert.equal(await getCachedVenueResults(undefined, search, async () => results), results);
	const missingTable = new MemoryD1();
	missingTable.sqlite.exec("DROP TABLE venue_cache");
	assert.equal(await getCachedVenueResults(missingTable, search, async () => results), results);
	missingTable.sqlite.close();
	const db = new MemoryD1();
	db.failRead = true;
	assert.equal(await getCachedVenueResults(db, search, async () => results), results);
	db.failRead = false;
	const key = await venueCacheKey(search);
	db.sqlite.prepare("UPDATE venue_cache SET expires_at = ? WHERE cache_key = ?").run(Date.now() - 1, key);
	db.failDelete = true;
	assert.equal(await getCachedVenueResults(db, search, async () => results), results);
	db.failDelete = false;
	db.failBatchAt = 2;
	assert.equal(await getCachedVenueResults(db, { ...search, groupSize: 11 }, async () => results), results);
	assert.equal(db.sqlite.prepare("SELECT count(*) AS count FROM venue_cache WHERE cache_key = ?").get(await venueCacheKey({ ...search, groupSize: 11 })).count, 0);
	db.failBatchAt = -1;
	await assert.rejects(getCachedVenueResults(db, { ...search, groupSize: 12 }, async () => { throw new Error("provider failed"); }), /provider failed/);
	assert.equal(db.sqlite.prepare("SELECT count(*) AS count FROM venue_cache WHERE cache_key = ?").get(await venueCacheKey({ ...search, groupSize: 12 })).count, 0);
	db.sqlite.close();
});

test("writes clean expired entries and atomically evict oldest entries to the row cap", async () => {
	const db = new MemoryD1();
	const insert = db.sqlite.prepare("INSERT INTO venue_cache VALUES (?, ?, ?)");
	const now = Date.now();
	insert.run("expired", JSON.stringify(results), now - 1);
	for (let index = 0; index < VENUE_CACHE_MAX_ENTRIES + 3; index++) {
		insert.run(`old-${index}`, JSON.stringify(results), now + 10000 + index);
	}
	await getCachedVenueResults(db, search, async () => results);
	assert.equal(db.sqlite.prepare("SELECT count(*) AS count FROM venue_cache").get().count, VENUE_CACHE_MAX_ENTRIES);
	assert.equal(db.sqlite.prepare("SELECT * FROM venue_cache WHERE cache_key = ?").get("expired"), undefined);
	assert.equal(db.sqlite.prepare("SELECT * FROM venue_cache WHERE cache_key = ?").get("old-0"), undefined);
	assert.ok(db.sqlite.prepare("SELECT * FROM venue_cache WHERE cache_key = ?").get(`old-${VENUE_CACHE_MAX_ENTRIES + 2}`));
	assert.ok(db.sqlite.prepare("SELECT * FROM venue_cache WHERE cache_key = ?").get(await venueCacheKey(search)));
	assert.ok(db.sqlite.prepare("EXPLAIN QUERY PLAN DELETE FROM venue_cache WHERE expires_at <= ?").all(now).some((row) => row.detail.includes("venue_cache_by_expiry")));
	db.sqlite.close();
});
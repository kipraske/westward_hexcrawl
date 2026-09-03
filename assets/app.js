// app.js — Westward hexcrawl generator.
//
// Everything runs in the browser. sql.js is SQLite compiled to WebAssembly,
// so the queries below are the same SQL you'd type into the sqlite3 CLI.

// ── the knobs ───────────────────────────────────────────────────────────
// Every tunable number lives here. Nothing below hard-codes a probability.
const SAME_BIOME       = 0.50;   // chance the next hex repeats the last one
const SOURCE_BIOME     = 0.60;   // roll on the biome's own page
const SOURCE_LINKED    = 0.30;   // roll on a page the authors linked to it
//                       0.10    // ...otherwise any page at all (the remainder)

// Scope-setting pages: they live in Wilderness but describe a whole map, not
// a hex. Excluded from biome selection; they can still turn up as links.
const NOT_BIOMES = ["World", "Continent", "Nation"];

// Monsters are deliberately NOT special-cased. Measured against the corpus,
// plain 60/30/10 already yields monsters ~30% of the time, because these
// authors linked monsters to wilderness constantly (Cavern's neighbours are
// 52% Monsters, Mountains 50%, Forest 41%). Adding an explicit monster roll
// on top would push it to ~47%. The simplest rule was already the right one.

let db = null;

// ── tiny query helper ───────────────────────────────────────────────────
// sql.js's raw API returns column/value arrays; this gives back plain objects
// and always uses bound parameters rather than string-concatenated SQL.
function q(sql, params = []) {
    const st = db.prepare(sql);
    st.bind(params);
    const rows = [];
    while (st.step()) rows.push(st.getAsObject());
    st.free();
    return rows;
}

// ── biome weighting ─────────────────────────────────────────────────────
// The rule is "single-word places count double", but the page titles aren't
// the place names — they're "What's in the Forest?" and "Quick Swamp". So we
// strip the wrapper first, then count words.
//
// Note the ['’] in the pattern: page titles use a plain ASCII apostrophe, but
// 183 prompt names in this corpus use the curly U+2019 instead. Accepting
// both costs one character and avoids a class of bug that only shows up on
// whichever rows you didn't test.
function placeName(title) {
    const m = title.match(/^What['’]s in the (.+?)\?$/) || title.match(/^Quick (.+)$/);
    return m ? m[1] : title;
}

function biomeWeight(title) {
    return placeName(title).trim().split(/\s+/).length === 1 ? 2 : 1;
}

function pickWeighted(items, weightOf) {
    const total = items.reduce((sum, it) => sum + weightOf(it), 0);
    let n = Math.random() * total;
    for (const it of items) {
        n -= weightOf(it);
        if (n < 0) return it;
    }
    return items[items.length - 1];   // float rounding safety net
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ── the data the generator needs ────────────────────────────────────────
function loadBiomes() {
    const rows = q(`
        SELECT c.id, c.name
          FROM categories c
          JOIN categories parent ON parent.id = c.parent_id
         WHERE parent.name = 'Wilderness'
           AND c.name NOT IN (?, ?, ?)
         ORDER BY c.name`, NOT_BIOMES);
    return rows.map(r => ({ ...r, weight: biomeWeight(r.name) }));
}

// Every prompt on a page is rollable. Prompts hang off either the page itself
// (134 of them) or one of its subcategories (2,251), hence the two-way match
// on s.id / s.parent_id.
//
// There used to be an `AND p.name NOT LIKE '%?'` here, filtering out prompts
// phrased as questions on the theory that they were follow-ups presupposing
// an earlier roll — "Who resides in the abandoned cabin now?" needs a cabin.
// It was removed after actually reading all 84 of them: every single one
// NAMES its own subject. There is not one bare pronoun or dangling reference
// in the set. So the prompt and its result are self-contained —
//
//     "Who is in the ancient burial mound? The remains of an ancient war chief"
//
// reads as "this hex has a burial mound, and a war chief is in it", which is
// exactly the content you want. The filter was suppressing good material to
// prevent a problem the corpus doesn't have.
//
// Removing it roughly triples the eligible prompts on the "What's in the..."
// pages (Desert 9 -> 22) while leaving the "Quick" pages untouched, since
// their authors never used question phrasing. Monsters drift 29.3% -> 25.2%
// as a result; still within tolerance.
function promptsFor(pageId) {
    return q(`
        SELECT p.id, p.name
          FROM prompts p
          JOIN categories s ON s.id = p.category_id
         WHERE s.id = ? OR s.parent_id = ?`, [pageId, pageId]);
}

// The link graph, traversed in BOTH directions. category_links is directed,
// but only 34.5% of links are reciprocated — the authors recorded whichever
// direction occurred to them. Forest lists 12 pages; 33 other pages list
// Forest. Following the stored arrows alone would miss Bears, Wolves and
// Spiders, which are obviously "near a forest".
function linkedPages(pageId) {
    return q(`
        SELECT c.id, c.name FROM categories c WHERE c.id IN (
            SELECT to_category   FROM category_links WHERE from_category = ?
            UNION
            SELECT from_category FROM category_links WHERE to_category   = ?
        )`, [pageId, pageId]);
}

function randomPage() {
    return q(`
        SELECT c.id, c.name
          FROM categories c
          JOIN categories parent ON parent.id = c.parent_id
         WHERE parent.parent_id IS NULL          -- depth 2: a source page
         ORDER BY RANDOM() LIMIT 1`)[0];
}

// ── the roll ────────────────────────────────────────────────────────────
// This is what roll_min / roll_max were designed for. The die size is derived
// (MAX(roll_max)), never stored, so it can't drift from the entries — and it
// is correct even for the 9 prompts whose printed die label contradicts their
// own rows. BETWEEN handles weighted and unweighted tables identically:
// 4 BETWEEN 4 AND 4 is as true as 37 BETWEEN 26 AND 50.
function rollOn(promptId) {
    const die = q(`SELECT MAX(roll_max) AS die FROM results WHERE prompt_id = ?`,
                  [promptId])[0].die;
    const n = 1 + Math.floor(Math.random() * die);
    let hit = q(`SELECT text FROM results
                  WHERE prompt_id = ? AND ? BETWEEN roll_min AND roll_max`,
                [promptId, n]);
    // Six prompts in the corpus have uncovered faces (e.g. a d20 whose entries
    // skip 11-16) and six have overlapping ranges. Neither is worth "fixing"
    // in the data — it's how the authors wrote it — so: take the first match,
    // and if a roll falls in a hole, pick any entry instead of showing blank.
    let gap = false;
    if (!hit.length) {
        gap = true;
        hit = q(`SELECT text FROM results WHERE prompt_id = ? ORDER BY RANDOM() LIMIT 1`,
                [promptId]);
    }
    return { die, n, text: hit.length ? hit[0].text : "(no entries)", gap };
}

// ── generating one hex ──────────────────────────────────────────────────
// Rolling the same line twice running looks like a bug even though it isn't:
// the biome repeats 50% of the time by design, and on an 11-prompt page the
// odds of then drawing the same prompt AND the same result are about 1.5%.
// Rare, but you notice it immediately when it happens.
//
// The retry cap matters. A naive `while (same) retry` would spin forever on a
// page with a single one-entry prompt — and rather than assume no such page
// exists, bound the loop and accept the duplicate if we lose five times. A
// guard that can hang is worse than the cosmetic problem it fixes.
const DEDUPE_TRIES = 5;

export function makeHex(biomes, previous) {
    let hex;
    for (let i = 0; i < DEDUPE_TRIES; i++) {
        hex = buildHex(biomes, previous);
        if (!previous || hex.roll.text !== previous.roll.text) return hex;
    }
    return hex;
}

function buildHex(biomes, previous) {
    const biome = (previous && Math.random() < SAME_BIOME)
        ? previous.biome
        : pickWeighted(biomes, b => b.weight);

    // Where does this hex's content come from? 60 / 30 / 10.
    const r = Math.random();
    let page, origin;
    if (r < SOURCE_BIOME) {
        page = biome; origin = "biome";
    } else if (r < SOURCE_BIOME + SOURCE_LINKED) {
        const links = linkedPages(biome.id);
        // Every biome has links, but guard anyway rather than crash on data.
        page = links.length ? pick(links) : biome;
        origin = links.length ? "linked" : "biome";
    } else {
        page = randomPage(); origin = "elsewhere";
    }

    const prompt = pick(promptsFor(page.id));
    const roll = rollOn(prompt.id);

    return { biome, page, origin, prompt, roll };
}

// ── boot ────────────────────────────────────────────────────────────────
// The database ships gzipped and is inflated here rather than relying on the
// host to negotiate compression, which guarantees an 856 KB transfer instead
// of a possible 1.9 MB one.
//
// The catch: some servers send a .gz file with `Content-Encoding: gzip`, and
// the browser then transparently inflates it before our code sees a byte.
// Others (python -m http.server, verified) send `Content-Type: application/
// gzip` with no encoding header, leaving it compressed. Decompressing
// unconditionally breaks on the first kind; not decompressing breaks on the
// second — and which one you get depends on the host, so you'd discover it
// only after deploying.
//
// Rather than trust a header, sniff the bytes. Gzip always begins 1f 8b;
// a SQLite file always begins "SQLite format 3". They can't be confused, so
// this works on any host without configuration.
// The default is built from import.meta.url, NOT written as a bare relative
// string. fetch() resolves relative URLs against the DOCUMENT, so plain
// "hexcrawl.db.gz" would look in the site root even though this module lives
// in assets/ — and it would have kept working right up until the moment the
// file moved, then 404'd with nothing pointing at the cause. import.meta.url
// is the module's own address, so the path is relative to this file.
export async function open(url = new URL("hexcrawl.db.gz", import.meta.url)) {
    const SQL = await initSqlJs({
        locateFile: f => `https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/${f}`
    });
    db = new SQL.Database(await fetchDatabase(url));
    return loadBiomes();
}

export async function fetchDatabase(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`could not fetch ${url} (HTTP ${res.status})`);
    let bytes = new Uint8Array(await res.arrayBuffer());

    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {          // still gzipped
        const stream = new Blob([bytes]).stream()
            .pipeThrough(new DecompressionStream("gzip"));
        bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }

    const magic = new TextDecoder().decode(bytes.subarray(0, 15));
    if (magic !== "SQLite format 3") {
        throw new Error(`${url} is not a SQLite database (got "${magic}")`);
    }
    return bytes;
}

// Exposed so the test harness can drive the same code Node-side.
export function attach(database) { db = database; return loadBiomes(); }

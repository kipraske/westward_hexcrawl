-- hexcrawl schema — SQLite
-- Build the database with:   sqlite3 hexcrawl.db < schema.sql
-- (Table names are plural — prompts, results, categories, keywords — just to
--  stay consistent with each other. Pick a convention and hold to it.)

-- SQLite does NOT enforce foreign keys unless you turn them on, and the
-- setting resets on every new connection. So your app has to run this same
-- line each time it connects — not just here at build time. This is the #1
-- SQLite surprise: forget it and the REFERENCES below are silently ignored.
PRAGMA foreign_keys = ON;


-- ────────────────────────────────────────────────────────────────────────
-- categories: the "pages" of BehindTheTables (e.g. Forest).
-- parent_id is your adjacency list. It points at another row in THIS table.
-- NULL = a top-level category; a value = a subcategory. One nullable column
-- models the whole hierarchy, exactly as you reasoned.
-- ON DELETE SET NULL: if a parent is removed, its children become top-level
-- rather than vanishing.
--
-- The real data lands in THREE levels, 634 rows total:
--    depth 1:  11 top-level categories   "NPCs"
--    depth 2: 246 pages                  "Miners"
--    depth 3: 377 subcategory headings   "Random Miners"
-- Note this is a correction — an earlier estimate said 383, having forgotten
-- the page level sitting between the category and its subcategories. The
-- adjacency list absorbed the extra depth without a schema change, which is
-- exactly the flexibility you were buying when you chose it.
-- ────────────────────────────────────────────────────────────────────────
-- description and reference are NULLABLE on purpose, and the reason is the
-- three-level tree above: only the PAGE level (depth 2) has them. A top-level
-- category like "NPCs" is a heading we invented from a string; a subcategory
-- like "Random Miners" is a heading inside a page. Neither has its own blurb
-- or its own URL. So 388 of the 634 rows will have NULL in both columns, and
-- that NULL is meaningful — it says "this row isn't a source document."
--
-- reference is the attribution link: the original r/BehindTheTables thread.
-- The table text is community-authored (OrkishBlade and others), so keeping
-- the URL next to the content is what makes crediting them possible later
-- without re-deriving where anything came from.
CREATE TABLE categories (
    id          INTEGER PRIMARY KEY,    -- alias for SQLite's rowid; auto-fills
    name        TEXT    NOT NULL,
    parent_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    description TEXT,                   -- the page's blurb;  NULL off depth 2
    reference   TEXT                    -- source thread URL; NULL off depth 2
);


-- ────────────────────────────────────────────────────────────────────────
-- prompts: one rollable list ("The miner is...").
-- Still NO die column. The die size is derived — but see the note in
-- results below: it is now MAX(roll_max), not COUNT(*).
--     SELECT MAX(roll_max) FROM results WHERE prompt_id = ?;
-- Derived either way, so it still can't drift out of sync with the entries.
-- 2,385 of these in the source data.
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE prompts (
    id          INTEGER PRIMARY KEY,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL
);


-- ────────────────────────────────────────────────────────────────────────
-- results: the individual entries you can roll on a prompt. 25,561 of them.
--
-- WHY roll_min / roll_max INSTEAD OF ONE ROW = ONE FACE:
-- The original design assumed every result is equally likely, so the die
-- size was just COUNT(*). Then we counted the actual data and that
-- assumption broke:
--     1,013 entries across 107 prompts use RANGES, like "1-2" or "13-15"
--     4.9% of prompts (116 of 2,385) have COUNT(*) != their stated die size
-- A d20 table with 12 entries is not a d12 — three of those entries just
-- span multiple faces. COUNT(*) would have silently reported the wrong die.
--
-- So each result now records the span of faces it covers:
--     a normal entry "4"    ->  roll_min = 4,  roll_max = 4
--     a ranged entry "1-2"  ->  roll_min = 1,  roll_max = 2
--
-- This is the more faithful of the two fixes. The alternative was a single
-- weight column (weight = 2 for "1-2", die size = SUM(weight)), which is
-- simpler but throws away WHICH faces an entry occupies. Storing the actual
-- face numbers means the roll is a real query instead of arithmetic:
--     SELECT text FROM results
--      WHERE prompt_id = ? AND :roll BETWEEN roll_min AND roll_max;
-- That BETWEEN is the payoff, and it is why we chose this shape.
--
-- CHECK enforces that a range can't be backwards (roll_max before roll_min).
-- Constraints like this are free — the database refuses bad data instead of
-- trusting the importer to be careful.
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE results (
    id        INTEGER PRIMARY KEY,
    prompt_id INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
    roll_min  INTEGER NOT NULL,
    roll_max  INTEGER NOT NULL,
    text      TEXT    NOT NULL,
    CHECK (roll_max >= roll_min)
);


-- ────────────────────────────────────────────────────────────────────────
-- result_refs is GONE — and this is worth remembering, because it was a
-- well-designed table solving a problem this data doesn't have.
--
-- The idea was inline nesting: "A grizzled {occupation} tending a wounded
-- {animal}", with a junction row per blank and a position column to keep
-- them in order. Sound design. But that pattern came from a DIFFERENT
-- project (the Random-Tables toolkit), and when we searched the actual
-- BehindTheTables corpus:
--     0 of 25,561 entries contain a {} token. Not one.
-- The only brackets are 35 bits of human prose ("the [figure] is sprinting
-- towards you") — instructions for a GM to improvise, not references a
-- program can resolve.
--
-- The nesting in THIS data is real, but it lives one level up: pages point
-- at other pages via use_with / related_tables. That's category_links
-- below, and it gets 1,743 rows.
--
-- Lesson worth keeping: check the data before building the table. The
-- junction-table instinct was right; the place to apply it was not here.
-- ────────────────────────────────────────────────────────────────────────


-- ────────────────────────────────────────────────────────────────────────
-- category_links: the merged "use with" + "related" links. 1,743 rows.
-- Both of your linking tables were category -> category, so they collapse
-- into one table with a link_type telling them apart. The CHECK constraint
-- refuses any value that isn't one of the two allowed strings.
-- Prefer your original two separate tables? Delete this and make
--   use_with(from_category, to_category) and related_category(...) instead.
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE category_links (
    from_category INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    to_category   INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    link_type     TEXT    NOT NULL CHECK (link_type IN ('use_with', 'related')),
    PRIMARY KEY (from_category, to_category, link_type)
);


-- ────────────────────────────────────────────────────────────────────────
-- keywords + category_keywords: the shared-tags pattern we worked out.
-- The word lives in exactly ONE row (UNIQUE), and categories point at it
-- through the junction — so "forest" is stored once no matter how many
-- categories use it. No position column: a category's keywords are an
-- unordered set, order carries no meaning.
-- Real numbers: 1,432 distinct words, 2,064 links between them and pages —
-- so the sharing is real, but modest. Worth it anyway; the UNIQUE constraint
-- is what stops "Forest" and "forest" becoming two different tags.
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE keywords (
    id   INTEGER PRIMARY KEY,
    word TEXT    NOT NULL UNIQUE
);

CREATE TABLE category_keywords (
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    keyword_id  INTEGER NOT NULL REFERENCES keywords(id)   ON DELETE CASCADE,
    PRIMARY KEY (category_id, keyword_id)   -- same word can't be listed twice
);


-- ────────────────────────────────────────────────────────────────────────
-- Indexes. SQLite auto-indexes PRIMARY KEY and UNIQUE columns for you, but
-- NOT plain foreign keys. These cover the lookups the app does constantly.
--
-- idx_results_roll covers THREE columns, and the order matters. An index on
-- (prompt_id, roll_min, roll_max) can serve a query on prompt_id alone
-- (a "leftmost prefix"), so it replaces the plain foreign-key index AND
-- makes the BETWEEN roll fast. An index on (roll_min, prompt_id) could not
-- do the first job — leftmost prefix only works left to right.
-- ────────────────────────────────────────────────────────────────────────
CREATE INDEX idx_prompts_category  ON prompts(category_id);
CREATE INDEX idx_results_roll      ON results(prompt_id, roll_min, roll_max);
CREATE INDEX idx_categories_parent ON categories(parent_id);
CREATE INDEX idx_catlinks_to       ON category_links(to_category);
CREATE INDEX idx_catkw_keyword     ON category_keywords(keyword_id);

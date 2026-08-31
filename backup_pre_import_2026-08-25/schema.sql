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
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE categories (
    id        INTEGER PRIMARY KEY,      -- alias for SQLite's rowid; auto-fills
    name      TEXT    NOT NULL,
    parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL
);


-- ────────────────────────────────────────────────────────────────────────
-- prompts: one rollable list ("Interesting location: you find...").
-- Notice there is NO die column. The die size is COUNT(results for this
-- prompt) — derived, never stored, so they can't drift apart. That was your
-- call and it's the right one.
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE prompts (
    id          INTEGER PRIMARY KEY,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL
);


-- ────────────────────────────────────────────────────────────────────────
-- results: the individual entries you can roll on a prompt.
-- One row per result means every result is equally likely, and the die size
-- is just how many rows share this prompt_id.
-- If you ever hit a WEIGHTED table, you don't redesign — add one column:
--     weight INTEGER NOT NULL DEFAULT 1
-- Left out for now because weighted tables are rare in this data.
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE results (
    id        INTEGER PRIMARY KEY,
    prompt_id INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
    text      TEXT    NOT NULL
);


-- ────────────────────────────────────────────────────────────────────────
-- result_refs: the nesting mechanic. A result's text can contain blanks that
-- get filled by rolling ANOTHER prompt:
--     "A grizzled {} tending a wounded {}"   -> two rows: position 0, position 1
-- position records which blank (left to right) each reference fills, so you
-- never swap "blacksmith" and "wolf".
-- position IS included here (unlike weight above) because THIS data's NPC and
-- settlement prompts routinely stack several blanks in one result. Same
-- principle both times — let the data decide — it just lands differently.
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE result_refs (
    result_id  INTEGER NOT NULL REFERENCES results(id) ON DELETE CASCADE,
    position   INTEGER NOT NULL,
    ref_prompt INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
    PRIMARY KEY (result_id, position)     -- one reference per blank; blocks dupes
);


-- ────────────────────────────────────────────────────────────────────────
-- category_links: the merged "use with" + "related" links.
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
-- NOT plain foreign keys. These cover the lookups the app does constantly:
-- results for a prompt, prompts in a category, walking the category tree,
-- following links, and "which categories have keyword X" (hex selection).
-- ────────────────────────────────────────────────────────────────────────
CREATE INDEX idx_prompts_category   ON prompts(category_id);
CREATE INDEX idx_results_prompt     ON results(prompt_id);
CREATE INDEX idx_result_refs_prompt ON result_refs(ref_prompt);
CREATE INDEX idx_categories_parent  ON categories(parent_id);
CREATE INDEX idx_catlinks_to        ON category_links(to_category);
CREATE INDEX idx_catkw_keyword      ON category_keywords(keyword_id);

#!/usr/bin/env python3
"""
import_btt.py — load the BehindTheTables JSON corpus into hexcrawl.db

    python3 tools/import_btt.py

Reads every btt/table_*.json and writes into the tables defined by schema.sql.
Safe to run repeatedly: it clears the old rows first (see wipe() below), so
re-running after a tweak gives you a clean database, not doubled data.

WHAT MAPS TO WHAT
    a JSON file          = one BehindTheTables "page" (e.g. Miners)
    page["category"]     -> a top-level category   ("NPCs")          x11
    page["title"]        -> a child category       ("Miners")        x246
    a {"subcategory":..} -> a grandchild category  ("Random Miners") x377
    a {"name","dice","table_entries"} -> a prompt                    x2,385
    a table_entry        -> a result                                 x25,561
    page["keywords"]     -> keywords + category_keywords
    use_with/related     -> category_links
"""

import json
import glob
import os
import re
import sqlite3
import sys

# hexcrawl.db is a BUILD ARTEFACT, not something the site serves — the browser
# only ever fetches assets/hexcrawl.db.gz, which build_db.sh produces from it.
# So it lives here in tools/ alongside its source data. Both paths derive from
# __file__ rather than the working directory, so the script behaves the same
# whichever directory you run it from.
HERE      = os.path.dirname(os.path.abspath(__file__))
DB_PATH   = os.path.join(HERE, "hexcrawl.db")
JSON_GLOB = os.path.join(HERE, "btt", "table_*.json")


# ──────────────────────────────────────────────────────────────────────────
# Parsing the dice_val into roll_min / roll_max.
#
# The source writes a face as either a bare number ("4") or a range
# ("1-2", "01-25"). Everything else would be a surprise, so we raise rather
# than guess — an importer that silently swallows unexpected data is how you
# end up with a database you can't trust.
#
# Two details worth noticing:
#   * int() normalizes the zero-padding, so "01" and "1" can't become two
#     different values. This is the payoff of storing INTEGER, not TEXT.
#   * The separator class is [-–—]: ASCII hyphen, en dash, em dash. Real
#     human-typed data uses all three, and only the first is on your keyboard.
# ──────────────────────────────────────────────────────────────────────────
RANGE_RE = re.compile(r"^(\d+)\s*[-–—]\s*(\d+)$")

def parse_dice_val(raw, where):
    v = str(raw).strip()
    m = RANGE_RE.match(v)
    if m:
        return int(m.group(1)), int(m.group(2))
    if v.isdigit():
        n = int(v)
        return n, n                     # the unweighted case: min == max
    raise ValueError(f"unparseable dice_val {raw!r} in {where}")


def parse_die(raw):
    """'D10' -> 10. Used only to CHECK our work, never stored — the die size
    is derived from the entries. Returns None if the label is malformed."""
    m = re.match(r"^[dD](\d+)$", str(raw).strip())
    return int(m.group(1)) if m else None


# ──────────────────────────────────────────────────────────────────────────
def connect():
    conn = sqlite3.connect(DB_PATH)
    # The line schema.sql warned about. PRAGMA foreign_keys resets to OFF on
    # EVERY new connection, so this belongs here too — not just at build time.
    # Without it, the dangling-link check further down would pass silently
    # and write rows pointing at categories that don't exist.
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def wipe(conn):
    """Make the import idempotent.

    DELETE FROM categories cascades into prompts, results, category_links and
    category_keywords, because every one of those hangs off a category by an
    ON DELETE CASCADE foreign key. One statement empties five tables.

    keywords needs its own DELETE. Nothing cascades into it — the arrow points
    the other way (category_keywords references keywords, not vice versa), so
    deleting categories orphans the words rather than removing them."""
    conn.execute("DELETE FROM categories")
    conn.execute("DELETE FROM keywords")


# ──────────────────────────────────────────────────────────────────────────
def main():
    files = sorted(glob.glob(JSON_GLOB))     # sorted => stable ids across runs
    if not files:
        sys.exit(f"no JSON found at {JSON_GLOB}")
    print(f"reading {len(files)} pages from btt/")

    conn = connect()
    stats = {"pages": len(files), "prompts": 0, "results": 0,
             "ranged": 0, "empty_text": 0}
    die_mismatches = []
    dangling = []

    # Everything happens inside ONE transaction. Without this, sqlite3 commits
    # each INSERT separately — 28,000 individual disk syncs, which turns a
    # two-second import into a multi-minute one. `with conn:` commits on
    # success and rolls the whole thing back on any exception, so a crash
    # halfway through leaves you with an empty database rather than a
    # half-imported one. All-or-nothing is the useful behaviour here.
    with conn:
        wipe(conn)

        top_ids  = {}   # "NPCs"    -> categories.id
        page_ids = {}   # "43vqqs"  -> categories.id     (needed for links)
        kw_ids   = {}   # "mines"   -> keywords.id       (the get-or-create cache)

        for path in files:
            with open(path, encoding="utf-8") as fh:
                page = json.load(fh)

            # ── level 1: the top-level category, created once and reused ──
            top = page["category"].strip()
            if top not in top_ids:
                cur = conn.execute(
                    "INSERT INTO categories (name, parent_id) VALUES (?, NULL)",
                    (top,))
                top_ids[top] = cur.lastrowid
            # lastrowid is how you get the id the database just auto-assigned.
            # We never invent ids ourselves; we let INTEGER PRIMARY KEY do it
            # and then read back what it chose.

            # ── level 2: the page itself, a child of its category ──
            # This is the only level that carries description and reference.
            # `or None` turns an empty string into a real NULL, so "absent"
            # and "present but blank" don't become two different states you
            # have to test for later. In SQL, '' = '' is true but NULL = NULL
            # is not — mixing the two is a classic source of queries that
            # quietly miss rows.
            cur = conn.execute(
                "INSERT INTO categories (name, parent_id, description, reference)"
                " VALUES (?, ?, ?, ?)",
                (page["title"].strip(),
                 top_ids[top],
                 (page.get("description") or "").strip() or None,
                 (page.get("reference")   or "").strip() or None))
            page_cat = cur.lastrowid
            page_ids[page["id"]] = page_cat

            # ── keywords: the get-or-create pattern ──
            # keywords.word is UNIQUE, so a naive INSERT would explode the
            # second time a word appears. The kw_ids dict is a cache of what
            # we've already inserted, so each distinct word costs exactly one
            # INSERT no matter how many pages use it. That IS the sharing the
            # junction table was built for.
            for word in page.get("keywords", []):
                w = word.strip().lower()     # fold case, or "Forest"/"forest" split
                if not w:
                    continue
                if w not in kw_ids:
                    c = conn.execute("INSERT INTO keywords (word) VALUES (?)", (w,))
                    kw_ids[w] = c.lastrowid
                conn.execute(
                    # OR IGNORE: a page occasionally lists the same keyword
                    # twice. The PRIMARY KEY would reject the duplicate with an
                    # error; OR IGNORE turns that into a silent no-op, which is
                    # what we want for a harmless repeat.
                    "INSERT OR IGNORE INTO category_keywords (category_id, keyword_id)"
                    " VALUES (?, ?)", (page_cat, kw_ids[w]))

            # ── level 3 + the prompts themselves ──
            # tables[] is a FLAT list that interleaves two different kinds of
            # object: subcategory markers and actual prompts. A marker applies
            # to every prompt after it, until the next marker. So we walk in
            # order carrying "which subcategory are we in right now".
            #
            # current_parent starts as the page, which matters: 134 prompts
            # appear before any marker, and they belong to the page directly.
            # (The other 2,251 sit under a subcategory.) Defaulting to the page
            # is what stops those 134 from being dropped or mis-parented.
            current_parent = page_cat

            for block in page.get("tables", []):
                if "subcategory" in block:
                    c = conn.execute(
                        "INSERT INTO categories (name, parent_id) VALUES (?, ?)",
                        (block["subcategory"].strip(), page_cat))
                    current_parent = c.lastrowid
                    continue

                if "table_entries" not in block:
                    continue

                where = f"{page['title']} / {block.get('name','?')}"
                c = conn.execute(
                    "INSERT INTO prompts (category_id, name) VALUES (?, ?)",
                    (current_parent, block["name"].strip()))
                prompt_id = c.lastrowid
                stats["prompts"] += 1

                rows = []
                for entry in block["table_entries"]:
                    lo, hi = parse_dice_val(entry["dice_val"], where)
                    text = entry.get("entry", "").strip()
                    if not text:
                        stats["empty_text"] += 1
                    if hi > lo:
                        stats["ranged"] += 1
                    rows.append((prompt_id, lo, hi, text))

                # executemany hands the whole list to SQLite in one call rather
                # than looping in Python. Same SQL, prepared once, run N times.
                conn.executemany(
                    "INSERT INTO results (prompt_id, roll_min, roll_max, text)"
                    " VALUES (?, ?, ?, ?)", rows)
                stats["results"] += len(rows)

                # Cross-check the derived die size against the label the source
                # printed. We do NOT store the label — this is purely a report.
                # Spoiler: where they disagree, the entries are right and the
                # label is a typo. See the summary at the end.
                stated  = parse_die(block.get("dice", ""))
                derived = max(r[2] for r in rows)
                if stated is not None and stated != derived:
                    die_mismatches.append((where, block["dice"], derived, len(rows)))

        # ── links: a SECOND pass, and it has to be ──
        # A page can point at any other page, including one we hadn't read yet
        # during the first pass. Only now is page_ids complete, so only now can
        # we resolve every "43vqqs" into a real category id. This is the
        # classic reason an importer needs two passes: forward references.
        for path in files:
            with open(path, encoding="utf-8") as fh:
                page = json.load(fh)
            src = page_ids[page["id"]]
            for key, link_type in (("use_with", "use_with"),
                                   ("related_tables", "related")):
                for link in page.get(key, []):
                    dst = page_ids.get(link["link"])
                    if dst is None:
                        # 8 links point at pages that aren't in this corpus.
                        # The foreign key would reject them anyway — better to
                        # skip deliberately and report than to crash or, worse,
                        # to have foreign keys off and store a broken pointer.
                        dangling.append((page["title"], link.get("title"), link["link"]))
                        continue
                    conn.execute(
                        "INSERT OR IGNORE INTO category_links"
                        " (from_category, to_category, link_type) VALUES (?, ?, ?)",
                        (src, dst, link_type))

    report(conn, stats, die_mismatches, dangling)
    conn.close()


# ──────────────────────────────────────────────────────────────────────────
def report(conn, stats, die_mismatches, dangling):
    print("\n── row counts ──")
    for t in ("categories", "prompts", "results",
              "keywords", "category_keywords", "category_links"):
        n = conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        print(f"  {t:20} {n:>7,}")

    print("\n── parsed ──")
    print(f"  ranged results (roll_max > roll_min) : {stats['ranged']:,}")
    print(f"  single-face results                  : {stats['results'] - stats['ranged']:,}")
    print(f"  empty result text                    : {stats['empty_text']:,}")

    # Attribution coverage. Counting NOT NULL here is the check that every
    # page kept its source link — if this drifts below the page count, some
    # content in the database has no credit attached to it.
    have_ref  = conn.execute(
        "SELECT COUNT(*) FROM categories WHERE reference IS NOT NULL").fetchone()[0]
    have_desc = conn.execute(
        "SELECT COUNT(*) FROM categories WHERE description IS NOT NULL").fetchone()[0]
    print("\n── attribution ──")
    print(f"  pages with a source URL : {have_ref:,} / {stats['pages']:,}")
    print(f"  pages with a description: {have_desc:,} / {stats['pages']:,}")

    # Depth check: proves the adjacency list actually built three levels
    # rather than a flat pile. A recursive CTE walks parent_id upward.
    print("\n── category tree depth ──")
    for depth, n in conn.execute("""
        WITH RECURSIVE tree(id, depth) AS (
            SELECT id, 1 FROM categories WHERE parent_id IS NULL
            UNION ALL
            SELECT c.id, tree.depth + 1
              FROM categories c JOIN tree ON c.parent_id = tree.id
        )
        SELECT depth, COUNT(*) FROM tree GROUP BY depth ORDER BY depth
    """):
        label = {1: "top-level", 2: "pages", 3: "subcategories"}.get(depth, "deeper")
        print(f"  depth {depth} ({label:14}) {n:>5,}")

    if dangling:
        print(f"\n── skipped {len(dangling)} links to pages not in this corpus ──")
        for a, b, ref in dangling:
            print(f"  {a} -> {b} [{ref}]")

    if die_mismatches:
        print(f"\n── {len(die_mismatches)} prompts where the printed die label "
              f"disagrees with the entries ──")
        print("  (we trust the entries; the label is the typo)")
        for where, stated, derived, n in die_mismatches:
            print(f"  {where[:58]:58} says {stated:>4}, "
                  f"entries run to {derived} ({n} rows)")


if __name__ == "__main__":
    main()

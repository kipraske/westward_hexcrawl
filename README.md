# Westward — hexcrawl tables in SQLite

A relational database of the r/BehindTheTables random-table corpus, built to
generate hexcrawl content: enter a hex, roll on the tables that belong there.

The point of the project is as much SQL practice as it is the app. The
interesting work was never the scraping — it was deciding how to model
tables-that-reference-tables, then discovering where the real data disagreed
with the model.

## What's here

| path | what it is |
|---|---|
| `schema.sql` | the six-table schema, with the reasoning for each decision in comments |
| `import_btt.py` | parses `btt/*.json` into the database; re-runnable |
| `near_hex.sql` | "what did the authors say goes with this hex?" |
| `btt/` | 246 source JSON files (the BehindTheTables corpus) |
| `hexcrawl.db` | the built database, ~1.9 MB |
| `backup_pre_import_2026-08-25/` | pre-import schema and DB snapshots |

## Rebuild from scratch

```sh
rm -f hexcrawl.db
sqlite3 hexcrawl.db < schema.sql
python3 import_btt.py          # ~0.25s
```

The importer clears existing rows first, so re-running is safe. It prints a
verification report: row counts, tree depth, attribution coverage, and every
anomaly it skipped or noticed.

Query it:

```sh
sqlite3 -box hexcrawl.db < near_hex.sql
```

## Schema

```
categories ──┐ (parent_id: adjacency list, 3 levels deep)
             │   depth 1   11 top-level    "NPCs"
             │   depth 2  246 pages        "Miners"     <- description + reference live here
             │   depth 3  377 subcategories "Random Miners"
             │
             ├── prompts (2,385)     one rollable list, e.g. "The miner is..."
             │     └── results (25,561)   roll_min, roll_max, text
             │
             ├── category_links (1,732)   use_with / related, page -> page
             └── category_keywords (2,052) ── keywords (1,392)
```

No die-size column. The die is derived: `SELECT MAX(roll_max) FROM results
WHERE prompt_id = ?`. Derived values can't drift out of sync with the rows
they describe.

## Design decisions worth remembering

These are the ones that weren't obvious up front, and where the data pushed
back on the first guess.

**`roll_min` / `roll_max` instead of one row per die face.** The first design
assumed every result is equally likely, making die size just `COUNT(*)`. Then
we counted: **1,013 entries across 107 prompts use ranges** like `1-2` or
`13-15`, and 116 prompts had `COUNT(*)` disagreeing with their stated die. A
d20 table with 12 entries isn't a d12. Storing the actual span makes the roll
a single query with no special cases, since `BETWEEN` is inclusive:

```sql
SELECT text FROM results WHERE prompt_id = ? AND :roll BETWEEN roll_min AND roll_max;
```

96% of rows store the same number twice (`roll_min = roll_max`). That
redundancy buys a read query with no branching, which is the right trade for a
database that is almost entirely read.

**`result_refs` was designed, then deleted.** The plan was inline nesting —
`"A grizzled {occupation} tending a wounded {animal}"` — with a junction table
and a `position` column to keep the blanks in order. Good design, wrong
corpus: **0 of 25,561 entries contain a `{}` token.** That pattern came from a
different project. The only brackets here are 35 bits of GM prose. Check the
data before building the table.

**The link graph is directed but its meaning isn't.** `category_links` records
that page A listed page B, and only **34.5% of links are reciprocated** — the
authors linked whichever direction occurred to them. Forest lists 12 pages; 33
other pages list Forest. Traversing arrows as stored misses Bears, Wolves, and
Spiders. `near_hex.sql` unions the edge list with its own reverse. Whether a
graph is directed is a fact about your question, not about your table.

**One hop, no inference.** An earlier version walked N hops with a recursive
CTE. Depth 2 reaches 112 more pages and depth 3 reaches 226 of 246 — at which
point "near" means nothing. The rule is now one hop, both directions, no
filtering: every link is a human author's explicit judgment, nothing is
inferred, and the rule fits in a sentence. That also removed the recursion —
a fixed known depth is a JOIN; recursion is for when you don't know the depth.

## Data quirks that will bite

- **9 prompts have a printed die label that contradicts their own entries** —
  `Graverobbers` says `d6` but has 8 entries numbered 1–8. The importer lists
  them. The entries are right; the label is a typo. Deriving the die size
  gives the correct answer where storing it would have imported the lie.
- **Category names are not unique.** 25 names repeat. Worse, there are two
  genuinely different pages named `Dragons` (ids 324 and 572, different
  Reddit threads). Seeding a query on a name silently merges them — seed on
  `id` when the name is ambiguous.
- **Most prompts are attribute tables, not content tables.** `Bears` gives you
  *"Color: The bear's fur is..."*, not *"you meet a bear."* When a linked page
  is chosen as an encounter, the **page title is the headline and its prompts
  are the detail** — otherwise you generate a stray adjective with no subject.
- **Hex pages mix entry points and follow-ups.** Across the nine
  `What's in the...` pages: 55 entry prompts, 78 follow-ups.
  *"Who resides in the abandoned cabin now?"* presupposes a cabin. Filtering
  with `WHERE name NOT LIKE '%?'` separates them, with about one leak in
  eleven (*"The temple was built to honor..."*).
- **8 links point at pages not in this corpus** and are skipped by the
  importer, which lists them by name.

## Attribution

The table text is community-authored, credited to **OrkishBlade and the
contributors of [r/BehindTheTables](https://www.reddit.com/r/BehindTheTables)**.
Every one of the 246 pages carries its source thread URL in
`categories.reference`, so any result can be traced back to its thread:

```sql
-- A prompt hangs off either a page (134 of them) or a subcategory (2,251),
-- so finding its page means asking which of the two you've got. If s's parent
-- is top-level, s IS the page; otherwise s is a subcategory and its parent is.
WITH page_of(prompt_id, page_id) AS (
    SELECT p.id,
           CASE WHEN top.parent_id IS NULL THEN s.id ELSE s.parent_id END
      FROM prompts p
      JOIN categories s   ON s.id   = p.category_id
      JOIN categories top ON top.id = s.parent_id
)
SELECT r.text, page.name, page.reference
  FROM results r
  JOIN page_of po      ON po.prompt_id = r.prompt_id
  JOIN categories page ON page.id = po.page_id
 LIMIT 5;
```

Verified to resolve all 25,561 results. The tempting shortcut,
`COALESCE(s.parent_id, s.id)`, silently fails for 8.8% of them — it lands on
the top-level category for prompts attached directly to a page.

The app code that originally bundled this data
([pherbers/BehindTheTablesApp](https://github.com/pherbers/BehindTheTablesApp))
is Apache-2.0; the table text is not covered by that licence. Fine for a
personal project — credit the authors if this ever goes public. This is
etiquette, not legal advice.

## Where it's going

Hex generation, roughly:

1. Enter a hex (e.g. `What's in the Forest?`).
2. Some % chance: roll one of that page's **entry** prompts.
3. Otherwise: pick a linked page, use its title as the encounter, and roll
   2–3 of its prompts as detail.

Open questions: the home/linked percentage split, how many attributes to roll
on a linked page, and whether the entry/follow-up distinction should become a
real column instead of a `LIKE '%?'` heuristic.

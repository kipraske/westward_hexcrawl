# Westward — a hexcrawl generator in SQLite

A wilderness hexcrawl generator built on the r/BehindTheTables random-table
corpus. Walk hex to hex; each one rolls something from the tables that belong
there. The whole thing is a static page — SQLite runs in your browser via
WebAssembly, so there is no server, no API, and no build step.

The point of the project is as much SQL practice as it is the app. The
interesting work was never the scraping — it was deciding how to model
tables-that-reference-tables, then discovering where the real data disagreed
with the model.

As you can likely tell, the second point of this project was to get used to using
AI developer tools, and to build something at speed, and to find gaps in my knowledge 
— just look at this README. The agent was Anthropic's Claude Opus 5. This is just a fun 
little learning project. Take that as you will.

## What's here

| path | what it is |
|---|---|
| `index.html` | the page: markup, biome art, panel |
| `app.js` | the generator; every tunable number is at the top |
| `map.js` | hex geometry, rendering, travel |
| `make_art.py` | draws the 15 biome tiles; re-run after editing a motif |
| `art/*.svg` | the tiles, 59 KB for all fifteen |
| `hexcrawl.db.gz` | the shipped artifact, 855 KB (44% of raw) |
| `build_db.sh` | vacuum + gzip — **run after any data change** |
| `schema.sql` | the six-table schema, reasoning for each decision in comments |
| `queries/near_hex.sql` | debugging tool, not app code — "why is that page linked to a swamp?" |
| `hexcrawl.db` | the built database, 1.9 MB |
| `import/import_btt.py` | parses the corpus into the database; re-runnable |
| `import/btt/` | 246 source JSON files |

## Running it

```sh
python3 -m http.server        # then open localhost:8000
```

It must be *served*, not opened as a file — ES module imports and `fetch`
don't work over `file://`. The page tells you so if you try.

## Deploying

GitHub Pages: push, then Settings → Pages → deploy from branch. No
configuration. Everything is static; the only external request is the sql.js
WASM binary from jsDelivr (322 KB, brotli). First load is ~1.2 MB total and
cached after; every roll thereafter is local and works offline.

## Rebuilding the data

```sh
rm -f hexcrawl.db
sqlite3 hexcrawl.db < schema.sql
python3 import/import_btt.py      # ~0.25s
./build_db.sh                     # regenerate the .gz the site serves
```

The importer clears existing rows first, so re-running is safe. It prints a
verification report: row counts, tree depth, attribution coverage, and every
anomaly it skipped or noticed.

Don't skip `build_db.sh`. The site serves `hexcrawl.db.gz`, not `hexcrawl.db`
— miss it and the page keeps serving the previous data with no error anywhere.

## The generator

```
Biome        weighted pick from 15 wilderness pages (weights total 23)
             single-word places count double: Forest 2, Haunted Forest 1
Next hex     50% repeats the previous biome, else re-roll the weighted pick
Content      60% a prompt from the biome page
             30% a prompt from a page the authors linked to it
             10% a prompt from any page in the corpus
Monsters     ~30%, emergent — see below
```

All four numbers are constants at the top of `app.js`.

Measured over 20,000 generated hexes: origins 60.2 / 30.2 / 9.6, monsters
29.9%, every biome within 0.5% of its weight.

**Monsters are not special-cased, and that was the whole trick.** The
requirement was "roughly a third." Plain 60/30/10 already delivers 29.5%,
because these authors linked monsters to wilderness constantly — Cavern's
neighbours are 52% Monsters, Mountains 50%, Forest 41%. Adding an explicit
25% monster roll on top would have produced 47%. The simplest possible rule
was already correct; the work was measuring that rather than assuming it.

**Repeat-biome measures 53.7%, not 50%, and that's right.** On a re-roll the
weighted pick can land on the same biome again, adding `0.5 × 7.4%`. The
source book's d10 behaves identically. To force exactly 50%, exclude the
current biome from the re-roll.

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
Spiders. Both `queries/near_hex.sql` and the generator union the edge list with
its own reverse. Whether a graph is directed is a fact about your question, not about
your table.

**One hop, no inference.** An earlier version walked N hops with a recursive
CTE. Depth 2 reaches 112 more pages and depth 3 reaches 226 of 246 — at which
point "near" means nothing. The rule is now one hop, both directions, no
filtering: every link is a human author's explicit judgment, nothing is
inferred, and the rule fits in a sentence. That also removed the recursion —
a fixed known depth is a JOIN; recursion is for when you don't know the depth.

**The entry-point filter was built, then removed.** Biome pages mix prompts
that read as openings (*"Encounters: You come upon..."*) with prompts that
read as follow-ups (*"Who lives in the peculiar cottage?"*), and the authors
happened to phrase the latter as questions — so `WHERE name NOT LIKE '%?'`
separated them for free. It shipped, then the 84 question-prompts were
actually read: every one names its own subject, so every one stands alone.
The filter was suppressing good material to prevent a problem that doesn't
exist. Removing it roughly triples the eligible prompts on the
`What's in the...` pages (Desert 9 → 22) and leaves the `Quick` pages
untouched, since their authors never used question phrasing.

That's the third time this project built a defensible thing for data it
hadn't finished reading — after `result_refs` and the recursive CTE. The
pattern is consistent enough to be worth naming: **look at all of the data
before writing the rule, not a sample of it.**

**Pointy-top hexes, forced by the layout.** A flat-top hex has neighbours at
N/NE/SE/S/SW/NW — there is *no* due-west one. The board offers "west, above
it, below it", which is pointy-top's W / NW / SW triple, so the tile shape
follows from the interaction rather than from taste.

**Two of the three choices are usually re-offered, not new.** From any hex the
offers are NW(0,-1), W(-1,0), SW(-1,+1). Move NW and your new SW cell *is* the
W hex you just declined; move SW and the new NW cell is that same hex. Two
moves in three collide, so the first version — skip occupied cells — gave the
player only two options on 21 of 40 test steps. The fix isn't generating
elsewhere: a hex you were offered and declined is still unexplored terrain one
step away, so it's simply re-offered. Only hexes you *entered* are excluded,
and they're unreachable anyway — westward progress `-(q + r/2)` rises by 1 on
a W move and 1/2 on NW/SW, so a route can never fold back on itself. Verified
at 3 choices for 200 consecutive moves.

**Biome art is generated, not downloaded.** Fifteen raster tiles would have
added several hundred KB to a project budgeted at 855 KB, plus a second
licence and attribution chain on top of BehindTheTables. And "simple and
drawn" *is* line art, which is what SVG natively is — so `make_art.py` draws
them: pines, grass tufts, dunes, reeds, ridged peaks, ice shards, dead trees.
All fifteen come to **59 KB**. Each biome seeds its RNG from its own name, so
re-running produces byte-identical files and a regenerate doesn't churn the
diff. Motifs sit on a jittered, row-offset grid rather than at random points —
pure random placement clumps and leaves holes, which reads as noise rather
than terrain. Tiles are 200×231, the √3:2 ratio of a pointy-top hex, so
`background-size:cover` fits them exactly with no cropping.

**Culling is measured in pixels, not moves.** The trail grew unbounded — 472
tiles after 200 moves. Tiles far enough behind are now dropped, but the
threshold can't be a move count: a W move advances 107px and an NW/SW move
only 54px, so counting moves would cull at wildly different visual distances
depending on how the player wandered. Nor can it be a fixed pixel figure. With
the current hex centred, a 1280px viewport shows 6 hexes behind the player but
a 3440px ultrawide shows 16 — a flat 10-hex cull would delete tiles in plain
sight. The limit is `max(10 hexes, half the viewport + 3 hexes)`, verified at
1280/2560/3440px to keep 43–75 tiles with nothing removed on screen.

**The `.gz` is byte-sniffed, not header-driven.** Some hosts send a `.gz` with
`Content-Encoding: gzip`, so the browser inflates it before your code sees a
byte; others (verified: `python -m http.server`) don't. Decompressing
unconditionally breaks on the first, not decompressing breaks on the second,
and which you get depends on the host — so you'd find out only after
deploying. `app.js` checks for the gzip magic bytes `1f 8b` and inflates only
if needed, then asserts the result begins `SQLite format 3`.

## Data quirks that will bite

- **9 prompts have a printed die label that contradicts their own entries** —
  `Graverobbers` says `d6` but has 8 entries numbered 1–8. The importer lists
  them. The entries are right; the label is a typo. Deriving the die size
  gives the correct answer where storing it would have imported the lie.
- **6 prompts have uncovered die faces** (one d20 skips 11–16) and 6 have
  overlapping ranges. Not worth "fixing" — it's how the authors wrote it. A
  roll landing in a hole falls back to a random entry, flagged in the UI.
- **Category names are not unique.** 25 names repeat. Worse, there are two
  genuinely different pages named `Dragons` (ids 324 and 572, different
  Reddit threads). Seeding a query on a name silently merges them — seed on
  `id` when the name is ambiguous.
- **Most prompts are attribute tables, not content tables.** `Bears` gives you
  *"Color: The bear's fur is..."*, not *"you meet a bear."* The UI prints the
  source page name alongside the result for exactly this reason — otherwise a
  linked roll reads as a stray adjective with no subject.
- **Follow-up prompts are self-contained, which is why there's no filter.**
  Roughly 40% of biome prompts are phrased as questions (*"Who resides in the
  abandoned cabin now?"*) and look like they presuppose an earlier roll. All
  84 were read: **every one names its own subject.** No bare pronouns, no
  dangling references. So prompt + result stands alone — *"Who is in the
  ancient burial mound? The remains of an ancient war chief"* means this hex
  has a burial mound with a war chief in it. See the design note below.
- **8 links point at pages not in this corpus** and are skipped by the
  importer, which lists them by name.
- **183 prompt names use a curly apostrophe (U+2019)** while page titles use
  ASCII `'`. Any regex over names needs `['’]`.

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

## Open items

- Deserts total 17.4% of hexes (three desert pages). Fine for a continent,
  odd for a temperate map — one weight to change if it grates.

-- TODO - this will need to be rewritten or deleted as is, but it has documentation
-- I don't want to lose for now...

-- near_hex.sql — "what did the authors say goes with this hex?"
--
--     sqlite3 -box hexcrawl.db < queries/near_hex.sql   (from the project root)
--
-- Not used by the app. app.js does its own one-hop traversal in linkedPages().
-- This is the tool for interrogating that traversal by hand: when a generated
-- hex serves you something baffling, this answers "why is that page linked to
-- a swamp?" with content counts attached. It's also where the full reasoning
-- behind treating the link graph as undirected is written out.
--
-- Direct, human-authored links only. One hop, no inference.
-- To ask about a different hex, edit the seed CTE (marked EDIT ME).

PRAGMA foreign_keys = ON;

-- Note: plain WITH, not WITH RECURSIVE.
--
-- The earlier version of this file walked outward N hops with a recursive
-- CTE. Once the rule became "one hop only", the recursion had nothing left to
-- do — you recurse when you don't know how many steps you'll take, and here
-- we know: one. What's left is an ordinary join.
--
-- Worth keeping as a general instinct: a fixed, known depth is a JOIN. An
-- unknown or unbounded depth is a recursive CTE. Reaching for the recursive
-- form when the depth is 1 is just a slower way to write the join, and a
-- harder one to read.
WITH

-- ── 1. the hex you're standing in ───────────────────────────────────────
-- EDIT ME. The doubled '' escapes an apostrophe inside a SQL string, and
-- this data is full of them ("What's in the...").
--
-- The join to parent is a guard, not decoration. Names are NOT unique in
-- categories — 25 names appear more than once, because a subcategory heading
-- inside one page can repeat a heading in another. Matching on bare name
-- would silently pull in those subcategories too, and the query would return
-- the MERGED neighbour set without complaining. Requiring the row to be a
-- page (parent.parent_id IS NULL means its parent is top-level) removes 24 of
-- the 25 collisions.
--
-- The one it can't fix: there are genuinely TWO pages named 'Dragons', from
-- two different Reddit threads (ids 324 and 572). If you seed on a name that
-- is ambiguous, seed on the id instead — swap the last line for `c.id = 572`.
seed(id) AS (
    SELECT c.id
      FROM categories c
      JOIN categories parent ON parent.id = c.parent_id
     WHERE parent.parent_id IS NULL
       AND c.name = 'What''s in the Forest?'
),

-- ── 2. which links count as "authored" ──────────────────────────────────
-- THE DECISION THAT CHANGES THE ANSWER. category_links is directed: it
-- records that page A listed page B. Only 34.5% of links are reciprocated,
-- so direction is mostly an accident of who happened to write it down.
--
--   Forest lists 12 pages.        <- what THIS page's author chose
--   33 other pages list Forest.   <- what OTHER authors chose
--   Either direction: 34 pages.
--
-- Both readings are "trust the authors" — they just trust different ones.
-- The reverse direction is still an explicit human judgment (the Bears author
-- wrote "use with Forest"), not an inference. That is why it counts.
--
-- DECIDED: both directions, no filtering. Every authored link is honoured and
-- nothing is curated out. Three of the 34 (World, Continent, Nation) are
-- map-scale pages rather than hex contents; they are deliberately left in
-- rather than maintained on an exclusion list, and ignored at roll time. The
-- rule stays "one hop, no inference, no editorializing" — which is a rule you
-- can state in one sentence, and that is worth more than a slightly tidier
-- result set.
--
-- To use only what the Forest page itself listed (12 pages), delete the UNION
-- and the line after it.
edges(a, b, link_type) AS (
    SELECT from_category, to_category, link_type FROM category_links
    UNION
    SELECT to_category, from_category, link_type FROM category_links
),

-- ── 3. how much rollable content does each neighbour offer? ─────────────
-- Prompts hang off either a page or one of its subcategories, so join a page
-- to both itself and its children before counting.
--
-- COUNT(DISTINCT p.id), not COUNT(p.id): joining prompts to results
-- multiplies each prompt row by its number of results, so a plain COUNT
-- reports 25,561-scale numbers where you wanted 2,385-scale ones. This is the
-- most common way a JOIN quietly corrupts an aggregate.
content(cat_id, n_prompts, n_results) AS (
    SELECT anc.id,
           COUNT(DISTINCT p.id),
           COUNT(r.id)
      FROM categories anc
      JOIN categories sub ON sub.id = anc.id OR sub.parent_id = anc.id
      JOIN prompts    p   ON p.category_id = sub.id
      JOIN results    r   ON r.prompt_id = p.id
     GROUP BY anc.id
)

-- ── 4. the neighbours ───────────────────────────────────────────────────
-- GROUP BY collapses the two link types onto one row per page. The CASE
-- builds the label explicitly rather than using group_concat, which has no
-- defined ordering and would emit 'use_with,related' on some rows and
-- 'related,use_with' on others. MAX() over a boolean is the idiomatic SQL
-- "did any row satisfy this?"
SELECT c.name                            AS page,
       top.name                          AS category,
       CASE WHEN MAX(e.link_type = 'use_with') = 1
             AND MAX(e.link_type = 'related')  = 1 THEN 'use_with, related'
            WHEN MAX(e.link_type = 'use_with') = 1 THEN 'use_with'
            ELSE                                        'related'  END AS link,
       COALESCE(ct.n_prompts, 0)         AS prompts,
       COALESCE(ct.n_results, 0)         AS results
  FROM seed s
  JOIN edges e             ON e.a = s.id
  JOIN categories c        ON c.id = e.b
  LEFT JOIN categories top ON top.id = c.parent_id
  LEFT JOIN content ct     ON ct.cat_id = c.id
 GROUP BY c.id
 ORDER BY ct.n_results DESC, c.name;

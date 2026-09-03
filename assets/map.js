// map.js — hex geometry, rendering, and travel.
//
// Data generation lives in app.js; this file is only about where hexes sit on
// screen and what happens when you click one.

import { open, makeHex } from './app.js';

// ── geometry ────────────────────────────────────────────────────────────
// POINTY-TOP hexes, and that isn't cosmetic. A flat-top hex has neighbours at
// N/NE/SE/S/SW/NW — there is no due-west one. A pointy-top hex has
// W/E/NW/NE/SW/SE, so "one west, one above it, one below it" is a real
// adjacency triple rather than three shapes floated near each other.
//
// SIZE is the circumradius (centre to corner). For a pointy-top hex that makes
// width = √3·SIZE and height = 2·SIZE.
const SIZE  = 62;
const HEX_W = Math.sqrt(3) * SIZE;
const HEX_H = 2 * SIZE;

// Axial coordinates (q, r). Storing axial rather than pixel positions means
// adjacency is integer arithmetic — no floating-point "is this the same hex?"
// comparisons, and the occupancy map can key on a plain "q,r" string.
// How much of the trail to keep behind the player. This is a floor, not the
// whole rule — see cull(). Ten hexes is comfortable on a laptop; the viewport
// check is what stops an ultrawide monitor watching tiles blink out.
const CULL_BEHIND = 10;

const DIRECTIONS = [
    { key: 'NW', q:  0, r: -1 },
    { key: 'W',  q: -1, r:  0 },
    { key: 'SW', q: -1, r: +1 },
];

// How long the marker gets to move before the camera follows it. Without a
// stagger the pawn glides to the next hex while the map slides the opposite
// way to re-centre, the two cancel exactly, and the pawn appears bolted to the
// middle of the screen. Letting it arrive first is what sells the step.
const MARKER_LEAD = 240;

const axialToPixel = (q, r) => ({
    x: SIZE * Math.sqrt(3) * (q + r / 2),
    y: SIZE * 1.5 * r,
});

// ── biome art ───────────────────────────────────────────────────────────
// Page titles are "What's in the Forest?" / "Quick Swamp"; the place is
// what's inside. Same unwrapping the weighting uses.
const placeName = t =>
    (t.match(/^What['’]s in the (.+?)\?$/) || t.match(/^Quick (.+)$/) || [, t])[1];

// One CSS class per biome, e.g. "flame-scorched-desert". Each is a gradient
// placeholder today; swap any one for a background-image without touching JS.
const biomeSlug = t =>
    placeName(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// 114 prompts are sentence fragments ("...and...", "...with...") — continuation
// stems from attribute tables that are meaningless alone. The source page name
// is shown separately, so dropping the stem loses nothing.
const isFragment = name => /^[.…]/.test(name.trim());

// ── state ───────────────────────────────────────────────────────────────
let biomes  = null;
let current = null;                 // the hex the player occupies
const occupied = new Map();         // "q,r" -> tile
const key = (q, r) => `${q},${r}`;

const $map   = document.getElementById('map');
const $panel = document.getElementById('panel');

// Both markers exist at all times; CSS shows whichever the current mode calls
// for. Keeping them live means switching modes is a class flip with no
// re-render and no state to rebuild.
let $pawn = null, $ring = null;
let $arrows = [];

const PAWN_SVG = `<svg viewBox="0 0 100 132" aria-hidden="true">
  <defs>
    <g id="pawn-shape">
      <circle cx="50" cy="25" r="18"/>
      <path d="M38 36 C38 44 36 48 34 54 L66 54 C64 48 62 44 62 36 Z"/>
      <ellipse cx="50" cy="54" rx="23" ry="7.5"/>
      <path d="M38 56 C38 72 33 87 29 101 L71 101 C67 87 62 72 62 56 Z"/>
      <path d="M30 99 C26 107 18 114 13 125 L87 125 C82 114 74 107 70 99 Z"/>
    </g>
  </defs>
  <!-- Five parts, each deliberately OVERLAPPING the next: head 7-43, neck
       36-54, collar 46-61, trunk 56-101, base 99-125. The first attempt had a
       2px gap between head and collar and no neck at all — since a circle's
       width at its lowest point is zero, the ball simply floated above the
       disc. Overlap is what makes the five shapes read as one silhouette.

       Drawn twice: a heavily stroked dark copy underneath gives a uniform
       outline around the union, then a light copy on top. Stroking each shape
       separately would show the internal seams. The outline is needed because
       biome tiles run from near-black (Cavern) to pale blue (Frozen Lands) —
       no single fill colour reads on both. -->
  <use href="#pawn-shape" fill="#221b13" stroke="#221b13" stroke-width="9" stroke-linejoin="round"/>
  <use href="#pawn-shape" fill="#f4ecd8"/>
</svg>`;

function makeMarkers() {
    $pawn = document.createElement('div');
    $pawn.className = 'pawn';
    $pawn.innerHTML = PAWN_SVG;
    $ring = document.createElement('div');
    $ring.className = 'ring';
    $map.appendChild($ring);
    $map.appendChild($pawn);
}

function moveMarker(tile) {
    const { x, y } = axialToPixel(tile.q, tile.r);
    for (const el of [$pawn, $ring]) {
        el.style.left = `${x}px`;
        el.style.top  = `${y}px`;
        el.classList.add('placed');
    }
}

// One arrow per available choice, sitting just outside the current hex and
// rotated to point at its target. All three neighbours are the same distance
// away — that's a property of a hex grid, so a single offset works for each.
function renderArrows() {
    $arrows.forEach(a => a.remove());
    $arrows = [];
    const from = axialToPixel(current.q, current.r);

    for (const dir of DIRECTIONS) {
        const target = occupied.get(key(current.q + dir.q, current.r + dir.r));
        if (!target || target.role !== 'choice') continue;

        const to = axialToPixel(target.q, target.r);
        const dx = to.x - from.x, dy = to.y - from.y;
        const angle = Math.round(Math.atan2(dy, dx) * 180 / Math.PI * 100) / 100;
        const reach = 0.56;              // just past the hex edge (inradius is .5)

        const a = document.createElement('button');
        a.type = 'button';
        a.className = 'arrow';
        a.style.left = `${from.x + dx * reach}px`;
        a.style.top  = `${from.y + dy * reach}px`;
        a.style.setProperty('--angle', `${angle}deg`);
        a.innerHTML = '<svg viewBox="0 0 20 14" aria-hidden="true">' +
            '<path class="halo" d="M2 7h11M13 7l-4.5-4.5M13 7l-4.5 4.5"/>' +
            '<path class="line" d="M2 7h11M13 7l-4.5-4.5M13 7l-4.5 4.5"/></svg>';
        a.addEventListener('click', () => travelTo(target));
        // Hovering either the arrow or its hex lights both, so it reads as one
        // control rather than two things that happen to be near each other.
        a.addEventListener('mouseenter', () => target.el.classList.add('aimed'));
        a.addEventListener('mouseleave', () => target.el.classList.remove('aimed'));
        target.el.addEventListener('mouseenter', () => a.classList.add('aimed'));
        target.el.addEventListener('mouseleave', () => a.classList.remove('aimed'));

        $map.appendChild(a);
        $arrows.push(a);
        requestAnimationFrame(() => a.classList.add('in'));
    }
}

// ── one tile on screen ──────────────────────────────────────────────────
function addTile(q, r, hex, role) {
    const { x, y } = axialToPixel(q, r);
    const el = document.createElement('button');
    el.className = `hex ${biomeSlug(hex.biome.name)} ${role}`;
    el.style.left = `${x}px`;
    el.style.top  = `${y}px`;
    el.type = 'button';
    el.innerHTML = `<span class="label">${placeName(hex.biome.name)}</span>`;

    const tile = { q, r, hex, role, el, entered: role === 'current' };
    occupied.set(key(q, r), tile);
    $map.appendChild(el);

    // Grow-in. The element is created at scale(0); flipping the class on the
    // next frame is what gives the browser two distinct states to animate
    // between. Setting both in the same frame would just snap to the end.
    requestAnimationFrame(() => el.classList.add('in'));

    // Attached once and guarded inside, because a tile can go choice ->
    // skipped -> choice again as the player moves around it.
    el.addEventListener('click', () => { if (tile.role === 'choice') travelTo(tile); });
    el.disabled = role !== 'choice';
    return tile;
}

// Move a tile between the three visual states in one place, so the class list
// and the disabled flag can't drift apart.
function setRole(tile, role) {
    tile.role = role;
    tile.el.classList.remove('choice', 'current', 'visited');
    tile.el.classList.add(role);
    tile.el.disabled = role !== 'choice';
}

// ── travel ──────────────────────────────────────────────────────────────
function travelTo(tile) {
    // Everything that was a choice stops being one. The unchosen two stay on
    // the map as faded terrain rather than vanishing — they're places you
    // passed by, and leaving them draws the route you actually took.
    for (const t of occupied.values()) {
        if (t.role === 'choice' || t.role === 'current') setRole(t, 'visited');
    }

    setRole(tile, 'current');
    tile.entered = true;
    current = tile;

    describe(tile.hex);
    offerChoices();
    renderArrows();
    moveMarker(tile);
    // Camera follows once the marker has arrived — see MARKER_LEAD.
    setTimeout(() => { centreOn(tile); cull(); }, MARKER_LEAD);
}

// Always three choices — but two of them are often hexes that already exist.
//
// The collision is structural, not occasional. From any hex the offers are
// NW(0,-1), W(-1,0), SW(-1,+1). Move NW and your new SW cell IS the W hex you
// just declined; move SW and your new NW cell is that same hex. So two moves
// in three land on an already-drawn tile, and simply skipping it left the
// player with two options more than half the time.
//
// The resolution is to stop treating "occupied" as "unavailable". A hex you
// were offered and didn't take is still unexplored terrain one step away —
// there's no reason you couldn't walk to it now. So re-offer it.
//
// Only hexes you actually ENTERED are off limits, and those can never come up:
// westward progress is -(q + r/2), which W increases by 1 and NW/SW each
// increase by 1/2. Every move strictly advances it, so the route can't fold
// back onto itself and `entered` tiles are unreachable by construction.
function offerChoices() {
    for (const dir of DIRECTIONS) {
        const q = current.q + dir.q;
        const r = current.r + dir.r;
        const existing = occupied.get(key(q, r));
        if (!existing) {
            addTile(q, r, makeHex(biomes, current.hex), 'choice');
        } else if (!existing.entered) {
            setRole(existing, 'choice');
        }
    }
}

// Slide the map so the current hex sits dead centre. Half the screen then
// shows the route behind you and half the choices ahead.
function centreOn(tile) {
    const { x, y } = axialToPixel(tile.q, tile.r);
    const anchorX = $map.parentElement.clientWidth  * 0.5;
    const anchorY = $map.parentElement.clientHeight * 0.45;
    $map.style.transform = `translate(${anchorX - x}px, ${anchorY - y}px)`;
}

// Drop tiles far enough behind that nobody can see them go.
//
// Distance is measured in pixels along x rather than in moves, because a W
// move advances 107px and an NW/SW move only 54px — counting moves would cull
// at wildly different visual distances depending on how the player wandered.
//
// The threshold is the LARGER of CULL_BEHIND hexes and half the viewport plus
// three hexes of slack. A fixed count is fine at 1280px (6 hexes visible
// behind) but wrong at 3440px, where 16 are visible and a 10-hex cull would
// delete tiles in plain sight.
//
// Only tiles behind the player are considered: travel strictly increases
// westward progress, so anything with a larger x is in the past and can never
// be offered again.
function cull() {
    const here = axialToPixel(current.q, current.r).x;
    const margin = $map.parentElement.clientWidth / 2 + 3 * HEX_W;
    const limit = Math.max(CULL_BEHIND * HEX_W, margin);

    for (const [cellKey, tile] of occupied) {
        if (tile === current) continue;
        if (axialToPixel(tile.q, tile.r).x - here <= limit) continue;
        occupied.delete(cellKey);
        // Fade rather than yanking the node. They're off-screen by
        // construction, so this only matters if the maths above is ever wrong
        // — in which case a fade looks like a fade and a yank looks like a bug.
        tile.el.classList.remove('in');
        setTimeout(() => tile.el.remove(), 500);
    }
}

// ── the panel ───────────────────────────────────────────────────────────
function describe(hex) {
    const stem = isFragment(hex.prompt.name)
        ? ''
        : `<span class="stem">${hex.prompt.name}</span> `;
    const source = hex.origin === 'biome'
        ? ''
        : `<div class="src">from <strong>${hex.page.name}</strong></div>`;
    $panel.innerHTML = `
        <div class="place">${placeName(hex.biome.name)}</div>
        <div class="body">${stem}<span class="text">${hex.roll.text}</span></div>
        ${source}
        <div class="die">d${hex.roll.die} &rarr; ${hex.roll.n}</div>`;
    $panel.classList.add('shown');
}

// ── boot ────────────────────────────────────────────────────────────────
// dbUrl is a seam for testing: the browser never passes it (app.js defaults
// to the relative "hexcrawl.db.gz"), but a harness can point at an absolute
// URL to drive this file headlessly.
export async function start(dbUrl) {
    biomes = await open(dbUrl);
    reset();
}

export function reset() {
    $map.innerHTML = '';
    occupied.clear();
    $arrows = [];
    makeMarkers();
    const first = addTile(0, 0, makeHex(biomes, null), 'current');
    current = first;
    describe(first.hex);
    offerChoices();
    renderArrows();
    moveMarker(first);
    centreOn(first);
}

window.addEventListener('resize', () => current && centreOn(current));

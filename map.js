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
const DIRECTIONS = [
    { key: 'NW', q:  0, r: -1 },
    { key: 'W',  q: -1, r:  0 },
    { key: 'SW', q: -1, r: +1 },
];

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
    centreOn(tile);
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

// Slide the map so the current hex sits at a fixed spot on screen — right of
// centre, because travel runs westward and the space that matters is ahead.
function centreOn(tile) {
    const { x, y } = axialToPixel(tile.q, tile.r);
    const anchorX = $map.parentElement.clientWidth  * 0.68;
    const anchorY = $map.parentElement.clientHeight * 0.45;
    $map.style.transform = `translate(${anchorX - x}px, ${anchorY - y}px)`;
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
    const first = addTile(0, 0, makeHex(biomes, null), 'current');
    current = first;
    describe(first.hex);
    offerChoices();
    centreOn(first);
}

window.addEventListener('resize', () => current && centreOn(current));

#!/bin/sh
# build_db.sh — turn the working database into the artefact the site serves.
#
#     ./tools/build_db.sh
#
# Run after ANY change to the data (i.e. after tools/import_btt.py). The site
# fetches assets/hexcrawl.db.gz, never tools/hexcrawl.db, so skipping this
# leaves the page serving the previous data with no error anywhere.
#
# VACUUM rewrites the file compactly, reclaiming pages freed when the importer
# cleared old rows. Costs nothing, shaves ~75 KB off the gzip.
#
# Pre-compressing is deliberate rather than leaving it to the host: GitHub
# Pages gzips recognised content types (verified on .wasm), but a .db is
# served as application/octet-stream and may not be on that list. Shipping the
# .gz and inflating in the browser makes the transfer size deterministic.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SRC="$HERE/hexcrawl.db"
DEST="$HERE/../assets/hexcrawl.db.gz"

sqlite3 "$SRC" "VACUUM;"
gzip -9 -c "$SRC" > "$DEST"

# Real byte counts, not `du`, which rounds up to disk blocks and once made an
# unchanged artefact look 40 KB bigger than it was.
awk -v src="$SRC" -v dest="$DEST" 'BEGIN{
    ("stat -f%z " src)  | getline raw
    ("stat -f%z " dest) | getline gz
    printf "tools/hexcrawl.db      %9d bytes (%.0f KB)\n", raw, raw/1024
    printf "assets/hexcrawl.db.gz  %9d bytes (%.0f KB)  %.0f%% of raw\n", gz, gz/1024, 100*gz/raw
}'

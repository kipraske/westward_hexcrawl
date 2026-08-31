#!/bin/sh
# build_db.sh — produce the browser-ready database artifact.
#
#     ./build_db.sh
#
# Run this after ANY change to the data (i.e. after import_btt.py). The site
# serves hexcrawl.db.gz, not hexcrawl.db, so without this step the page keeps
# serving the previous database and nothing anywhere reports an error.
#
# VACUUM rewrites the file compactly, reclaiming pages freed when the importer
# cleared old rows. Costs nothing, shaves ~75 KB off the gzip.
#
# Pre-compressing is deliberate rather than leaving it to the host: GitHub
# Pages gzips recognised content types (verified on .wasm), but a .db is
# served as application/octet-stream and may not be on that list. Shipping the
# .gz and decompressing in the browser makes the transfer size deterministic.
set -e
cd "$(dirname "$0")"

sqlite3 hexcrawl.db "VACUUM;"
gzip -9 -c hexcrawl.db > hexcrawl.db.gz

# Report real byte counts, not `du`, which rounds up to disk blocks and once
# made an unchanged artifact look 40 KB bigger than it was.
awk 'BEGIN{
    "stat -f%z hexcrawl.db"    | getline raw
    "stat -f%z hexcrawl.db.gz" | getline gz
    printf "raw   %9d bytes (%.0f KB)\ngzip  %9d bytes (%.0f KB)  %.0f%% of raw\n",
           raw, raw/1024, gz, gz/1024, 100*gz/raw
}'

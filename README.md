# manga-archiver-keygen

Regenerates the rotating AllManga (mkissa.to) crypto values used by
[manga-archiver](https://github.com/jfang324/manga-archiver).

## Output

Commits `keygen.json` to `main`:

```json
{
  "build_id": "96",
  "epoch": 2953,
  "lanes": {
    "k7": "695af278...",
    "k9": "e81105a3...",
    "k2": "76b070b0..."
  },
  "query_hashes": {
    "search": "ae4b341a...",
    "manga": "7bd73440...",
    "chapter": "fd67da54..."
  }
}
```

The rotating values generated are the build id, the 7-day epoch, the per-lane
AES keys (`k7` episode, `k9` chapter pages, `k2` music), and the GraphQL
persisted-query hashes (sha256 of the site's current query documents for
search, manga details, and chapter pages). Base URLs and the response static
key are stable and owned by consuming apps.

Consumers fetch this file unauthenticated from
`https://raw.githubusercontent.com/jfang324/manga-archiver-keygen/main/keygen.json`.

## How it works

1. `keygen.js` fetches `https://mkissa.to/`, locates the entry script, and
   finds the chunk containing the crypto build id (`!=="string"?"96"`).
2. `ani-extract.js` statically isolates the rotated mask array from the
   bundle, evaluates the minimal slice, and returns the 4 base64 mask blocks.
3. The mask is reconstructed using the same obfuscation stream the site
   applies (`Bv`), then each lane is bootstrapped from
   `/client-crypto/v1/bootstrap` with the derived boot token.
4. The same bundle chunk's query factories are resolved (search `mangas`,
   manga details `manga`, chapter pages `chapterPages`) and hashed with
   sha256, matching the site's persisted-query hashes.
5. The per-lane keys (`mask XOR partB`), the epoch, and the query hashes are
   written to `keygen.json`.

## Schedule

`.github/workflows/keygen.yaml` runs on a cron schedule (every 6 hours), on
`workflow_dispatch`, and on push to `main`. It commits `keygen.json` only when
the values change.

## Local run

```sh
npm ci
node keygen.js
```

Requires Node 20+.

## Notes

- `api.mkissa.net` is the site's current GraphQL and crypto backend
  (`api.allanime.day` is Cloudflare-gated); base URLs are not generated here.
- The `static_key` response seed (`Xot36i3lK3:v1`) is not generated; it is a
  stable constant in manga-archiver.

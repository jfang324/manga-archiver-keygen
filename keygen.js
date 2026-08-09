"use strict";

// manga-archiver-keygen
//
// Fetches the live AllManga (mkissa.to) bundle, extracts the current crypto
// build id and mask, and derives the per-lane AES keys by bootstrapping the
// server's /client-crypto/v1/bootstrap endpoint. Writes keygen.json with:
//
//   {
//     "build_id": "96",
//     "epoch": 2953,
//     "lanes": {
//       "k7": "695af278...",  // episode
//       "k9": "e81105a3...",  // chapter pages
//       "k2": "76b070b0..."   // music
//     }
//   }
//
// Query hashes, base URLs, and the response static key are stable and owned
// by consuming apps; only the rotating crypto values are generated here.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { extractMaskBlocks } = require("./ani-extract.js");

const SITE_URL = "https://mkissa.to/";
const CDN_BASE = "https://mkissa.to/_app/immutable";
const BOOTSTRAP_URL = "https://api.mkissa.net/client-crypto/v1/bootstrap";
const LANES = ["k7", "k9", "k2"];
const EPOCH_MS = 6048e5; // 7 days
const GRACE_MS = 864e5; // 1 day rollback grace
const OUT_FILE = path.join(__dirname, "keygen.json");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function get(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "*/*" },
  });
  if (!resp.ok) throw new Error(`GET ${url} -> ${resp.status}`);
  return await resp.text();
}

// Parse the current epoch the site uses: floor(now / 7d), rolled back one
// epoch during the first day of a new epoch (client-side grace period).
function currentEpoch() {
  const now = Date.now();
  const kv = Math.floor(now / EPOCH_MS);
  return now - kv * EPOCH_MS < GRACE_MS && kv > 0 ? kv - 1 : kv;
}

// The site's mask is the embedded mask blocks XORed with a build-id derived
// obfuscation stream (mirrors `Bv()` in the bundle).
function buildMask(blocks, buildId) {
  const embedded = Buffer.concat(blocks.map((b) => Buffer.from(b, "base64")));
  return Buffer.from(
    Array.from(embedded).map((v, i) =>
      v ^
      (buildId.charCodeAt(i % buildId.length) ^ ((i * 17 + 31) & 0xff)) ^
      ((Math.floor(i / 8) * 41 + (i % 8) * 7) & 0xff)
    )
  );
}

async function bootstrapLane(buildId, mask, lane, epoch) {
  const hmac_key = crypto.createHmac("sha256", mask).update(`aa-boot:${buildId}`).digest();
  const boot = crypto
    .createHmac("sha256", hmac_key)
    .update(`${buildId}:mkissa:mkissa.to:${epoch}:${lane}`)
    .digest("hex");

  const resp = await fetch(`${BOOTSTRAP_URL}?buildId=${buildId}&k=${lane}`, {
    headers: {
      "User-Agent": UA,
      "Accept": "*/*",
      "cache-control": "no-store",
      "Origin": "https://mkissa.to",
      "Referer": "https://mkissa.to/",
      "x-build-id": buildId,
      "x-aa-boot": boot,
    },
  });
  const body = await resp.text();
  if (!resp.ok) throw new Error(`bootstrap ${lane} -> ${resp.status} ${body.slice(0, 120)}`);
  const data = JSON.parse(body);
  if (!data.partB) throw new Error(`bootstrap ${lane} missing partB: ${body.slice(0, 120)}`);

  const partB = Buffer.from(data.partB, "base64");
  if (partB.length !== mask.length) {
    throw new Error(`bootstrap ${lane} partB length ${partB.length} != mask ${mask.length}`);
  }
  return Buffer.from(Array.from(mask).map((m, i) => m ^ partB[i]));
}

async function main() {
  console.log("Fetching site...");
  const page = await get(SITE_URL);
  const entryMatch = page.match(/\/entry\/app\.[A-Za-z0-9_.-]+\.js/);
  if (!entryMatch) throw new Error("Couldn't find entry script in page");
  const entryPath = entryMatch[0];
  console.log("Entry:", entryPath);

  const entry = await get(CDN_BASE + entryPath);
  const chunks = [...entry.matchAll(/["']([^"']*chunks\/[A-Za-z0-9_.-]+\.js)["']/g)].map((m) => m[1]);
  console.log(`Found ${chunks.length} chunks`);

  // The crypto chunk contains the build id and the mask blocks.
  let chunkSrc = null;
  let buildId = null;
  for (const rel of chunks) {
    const src = await get(new URL(rel, CDN_BASE + entryPath).toString());
    const bidMatch = src.match(/!=="string"\?"([0-9]+)"/);
    if (bidMatch && /Bv\(|x-aa-boot|aa-boot/.test(src)) {
      chunkSrc = src;
      buildId = bidMatch[1];
      break;
    }
  }
  if (!chunkSrc || !buildId) throw new Error("Couldn't find crypto chunk with build id");
  console.log("Crypto chunk found, build_id:", buildId);

  console.log("Extracting mask blocks...");
  const blocks = extractMaskBlocks(chunkSrc);
  console.log("Mask blocks:", JSON.stringify(blocks));

  const mask = buildMask(blocks, buildId);
  console.log("Mask:", mask.toString("hex"));

  const epoch = currentEpoch();
  console.log("Epoch:", epoch);

  const lanes = {};
  for (const lane of LANES) {
    const key = await bootstrapLane(buildId, mask, lane, epoch);
    lanes[lane] = key.toString("hex");
    console.log(`lane ${lane}: ${lanes[lane]}`);
  }

  const output = { build_id: buildId, epoch, lanes };
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2) + "\n");
  console.log("Wrote", OUT_FILE);
}

main().catch((e) => {
  console.error("keygen failed:", e);
  process.exit(1);
});

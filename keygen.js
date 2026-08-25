"use strict";

// manga-archiver-keygen
//
// Fetches the live AllManga (mkissa.to) bundle, extracts the current crypto
// build id and mask, and derives the per-lane AES keys by bootstrapping the
// server's /client-crypto/v1/bootstrap endpoint. Also extracts the GraphQL
// persisted-query hashes from the same bundle. Writes keygen.json with:
//
//   {
//     "build_id": "96",
//     "epoch": 2953,
//     "lanes": {
//       "k7": "695af278...",  // episode
//       "k9": "e81105a3...",  // chapter pages
//       "k2": "76b070b0..."   // music
//     },
//     "query_hashes": {
//       "search": "ae4b341a...",
//       "manga": "7bd73440...",
//       "chapter": "fd67da54..."
//     }
//   }
//
// Base URLs and the response static key are stable and owned by consuming
// apps; the rotating crypto values and query hashes are generated here.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  extractBuildId,
  extractCryptoConfig,
  extractMaskBlocks,
  extractQueryHashes,
} = require("./ani-extract.js");

const SITE_URL = "https://mkissa.to/";
const SITE_ORIGIN = "https://mkissa.to";
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

// Legacy bundles apply this fixed build-id keystream to the concatenated mask
// blocks. Keep it as a fallback while preferring the live bundle's config.
function buildLegacyMask(blocks, buildId) {
  const embedded = Buffer.concat(blocks.map((b) => Buffer.from(b, "base64")));
  return Buffer.from(
    Array.from(embedded).map((v, i) =>
      v ^
      (buildId.charCodeAt(i % buildId.length) ^ ((i * 17 + 31) & 0xff)) ^
      ((Math.floor(i / 8) * 41 + (i % 8) * 7) & 0xff)
    )
  );
}

function buildConfiguredMask(blocks, buildId, config) {
  const decoded = blocks.map((block) => Buffer.from(block, "base64"));
  if (!decoded.length || !decoded.every((block) => block.length === decoded[0].length)) {
    throw new Error("Configured mask blocks are empty or have inconsistent lengths");
  }

  const mask = Buffer.alloc(decoded.reduce((size, block) => size + block.length, 0));
  const fragmentLength = decoded[0].length;
  for (let fragmentIndex = 0; fragmentIndex < decoded.length; fragmentIndex++) {
    for (let byteIndex = 0; byteIndex < fragmentLength; byteIndex++) {
      const index = fragmentIndex * fragmentLength + byteIndex;
      const idStream =
        (buildId.charCodeAt(index % buildId.length) ^
          ((index * config.saltMul + config.saltAdd) & 0xff)) &
        0xff;
      const fragmentStream =
        (fragmentIndex * config.fragMul + byteIndex * config.fragAdd) & 0xff;
      mask[index] = decoded[fragmentIndex][byteIndex] ^ idStream ^ fragmentStream;
    }
  }
  return mask;
}

function bootSigningInputs(buildId, lane, epoch, config) {
  const host = new URL(SITE_URL).hostname;
  if (!config) {
    return {
      phase1: `aa-boot:${buildId}`,
      phase2: `${buildId}:mkissa:${host}:${epoch}:${lane}`,
    };
  }

  const values = {
    group: "mkissa",
    host,
    lane: String(lane),
    buildId: String(buildId),
    epoch: String(epoch),
  };
  const parts = config.parts.filter(
    (part) => values[part] != null && (!config.omitEmptyLane || values[part] !== "")
  );
  const phase2 = parts.map((part) => values[part]).join(config.join);
  if (!phase2) throw new Error(`Crypto config for lane ${lane} produced an empty signing message`);
  return { phase1: `${config.bootPrefix}${buildId}`, phase2 };
}

async function bootstrapLane(buildId, mask, lane, epoch, config) {
  const signing = bootSigningInputs(buildId, lane, epoch, config);
  const hmac_key = crypto.createHmac("sha256", mask).update(signing.phase1).digest();
  const boot = crypto.createHmac("sha256", hmac_key).update(signing.phase2).digest("hex");

  const resp = await fetch(
    `${BOOTSTRAP_URL}?buildId=${encodeURIComponent(buildId)}&k=${encodeURIComponent(lane)}`,
    {
      headers: {
        "User-Agent": UA,
        "Accept": "*/*",
        "cache-control": "no-store",
        "Origin": SITE_ORIGIN,
        "Referer": SITE_URL,
        "x-build-id": buildId,
        "x-aa-boot": boot,
      },
    }
  );
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
  const assetsMatch = page.match(/assets\s*:\s*["']([^"']+)["']/);
  const assetsBase = (assetsMatch?.[1] ?? SITE_ORIGIN).replace(/\/$/, "");
  const immutableBase = `${assetsBase}/_app/immutable`;

  const entryMatch = page.match(/\/entry\/app\.[A-Za-z0-9_.-]+\.js/);
  if (!entryMatch) throw new Error("Couldn't find entry script in page");
  const entryPath = entryMatch[0];
  const entryUrl = `${immutableBase}${entryPath}`;
  console.log("Entry:", entryUrl);

  const entry = await get(entryUrl);
  const chunks = [
    ...new Set(
      [...entry.matchAll(/["']([^"']*chunks\/[A-Za-z0-9_.-]+\.js)["']/g)].map((m) => m[1])
    ),
  ];
  console.log(`Found ${chunks.length} chunks`);

  // Identify the crypto module by the request headers/bootstrap path it emits,
  // then resolve its build-id scope through the bundle's own decoders.
  const candidates = [];
  const chunkFailures = [];
  for (const rel of chunks) {
    const src = await get(new URL(rel, entryUrl).toString());
    const hasBuildMarker =
      src.includes("x-build-id") || /!=="string"\?"[0-9]+"/.test(src);
    const hasCryptoMarker =
      src.includes("x-aa-boot") ||
      src.includes("aa-boot") ||
      src.includes("/client-crypto/v1/bootstrap");
    if (!hasBuildMarker || !hasCryptoMarker) continue;

    try {
      const candidateBuildId = extractBuildId(src);
      candidates.push({ rel, src, buildId: candidateBuildId });
    } catch (error) {
      chunkFailures.push(`${rel}: ${error.message}`);
    }
  }

  if (!candidates.length) {
    const detail = chunkFailures.length ? ` (${chunkFailures.join("; ")})` : "";
    throw new Error(`Couldn't find crypto chunk with a build id${detail}`);
  }
  const buildIds = [...new Set(candidates.map((candidate) => candidate.buildId))];
  if (buildIds.length !== 1) {
    throw new Error(`Crypto chunks agreed on no build id: ${buildIds.join(", ")}`);
  }
  const { src: chunkSrc, buildId } = candidates[0];
  console.log("Crypto chunk found, build_id:", buildId);

  console.log("Extracting mask blocks...");
  const blocks = extractMaskBlocks(chunkSrc);
  console.log("Mask blocks:", JSON.stringify(blocks));

  const cryptoConfig = extractCryptoConfig(chunkSrc);
  console.log("Crypto config:", cryptoConfig ? JSON.stringify(cryptoConfig) : "legacy");
  const mask = cryptoConfig
    ? buildConfiguredMask(blocks, buildId, cryptoConfig)
    : buildLegacyMask(blocks, buildId);
  console.log("Mask:", mask.toString("hex"));

  const epoch = currentEpoch();
  console.log("Epoch:", epoch);

  const lanes = {};
  for (const lane of LANES) {
    const key = await bootstrapLane(buildId, mask, lane, epoch, cryptoConfig);
    lanes[lane] = key.toString("hex");
    console.log(`lane ${lane}: ${lanes[lane]}`);
  }

  console.log("Extracting query hashes...");
  const query_hashes = extractQueryHashes(chunkSrc);
  console.log("Query hashes:", JSON.stringify(query_hashes));

  const output = { build_id: buildId, epoch, lanes, query_hashes };
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2) + "\n");
  console.log("Wrote", OUT_FILE);
}

main().catch((e) => {
  console.error("keygen failed:", e);
  process.exit(1);
});

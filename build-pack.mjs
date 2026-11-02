// Builds a map pack from OPL on stdin, as written by:
//   osmium add-locations-to-ways highways.osm.pbf -f opl,add_metadata=false -o -
// Usage: node build-pack.mjs out.sgmap "source description"
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { encodeTile, encodePackHeader, tileRow, tileColumn, tileKey, tileKeyRow } from "./map-pack.mjs";

// Must match the tags the Stride Guide server keeps (retainedWayTagKeys).
const retainedTags = new Set([
  "highway", "foot", "access", "sidewalk", "sidewalk:both", "sidewalk:left", "sidewalk:right",
  "footway", "designation", "surface", "trail_visibility", "sac_scale", "maxspeed",
  "source:maxspeed", "maxspeed:type", "lit", "barrier", "locked"
]);
const gateBarriers = new Set(["gate", "lift_gate", "swing_gate", "chain"]);
const ROWS_PER_BAND = 25;
const FLUSH_BYTES = 8 * 1024 * 1024;

const unescape = (value) => value.replace(/%([0-9a-fA-F]+)%/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));

function parseTags(token) {
  const tags = {};
  if (!token || token.length < 2) return tags;
  for (const pair of token.slice(1).split(",")) {
    const split = pair.indexOf("=");
    if (split < 0) continue;
    const key = unescape(pair.slice(0, split));
    if (retainedTags.has(key)) tags[key] = unescape(pair.slice(split + 1));
  }
  return tags;
}

const toE7 = (value) => Math.round(Number(value) * 1e7);

// Returns { kind: "way", id, tags, nodes, coords } | { kind: "barrier", id, tags, lonE7, latE7 } | null.
export function parseOplLine(line) {
  const tokens = line.trim().split(" ");
  const kind = tokens[0]?.[0];
  const id = Number(tokens[0]?.slice(1));
  if (!Number.isSafeInteger(id)) return null;
  const field = (letter) => tokens.find((token) => token[0] === letter);
  if (kind === "w") {
    const tags = parseTags(field("T"));
    if (!tags.highway) return null;
    const nodes = [];
    const coords = [];
    for (const ref of (field("N") || "N").slice(1).split(",")) {
      // Nodes outside the extract have no location; drop them with their id
      // so ids and geometry stay aligned.
      const match = ref.match(/^n(\d+)(?:x(-?[\d.]*)y(-?[\d.]*))?$/);
      if (!match?.[2] || !match[3]) continue;
      nodes.push(Number(match[1]));
      coords.push([toE7(match[2]), toE7(match[3])]);
    }
    return nodes.length >= 2 ? { kind: "way", id, tags, nodes, coords } : null;
  }
  if (kind === "n") {
    const tags = parseTags(field("T"));
    const x = field("x")?.slice(1);
    const y = field("y")?.slice(1);
    if (!gateBarriers.has(tags.barrier) || !x || !y) return null;
    return { kind: "barrier", id, tags, lonE7: toE7(x), latE7: toE7(y) };
  }
  return null;
}

// Every tile any segment's bounding box touches, so a long straight segment
// crossing a tile without a vertex in it is still found there.
export function wayTileKeys(coords) {
  const keys = new Set();
  for (let index = 1; index < coords.length; index += 1) {
    const [lonA, latA] = coords[index - 1];
    const [lonB, latB] = coords[index];
    const rowA = tileRow(Math.min(latA, latB) / 1e7);
    const rowB = tileRow(Math.max(latA, latB) / 1e7);
    const columnA = tileColumn(Math.min(lonA, lonB) / 1e7);
    const columnB = tileColumn(Math.max(lonA, lonB) / 1e7);
    for (let row = rowA; row <= rowB; row += 1) for (let column = columnA; column <= columnB; column += 1) keys.add(tileKey(row, column));
  }
  return [...keys];
}

const bandOf = (key) => Math.floor(tileKeyRow(key) / ROWS_PER_BAND);

export async function buildPack(input, output, meta = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "sgmap-"));
  try {
    // Pass 1: spill each feature to the latitude band(s) its tiles are in, so
    // pass 2 can build tiles band by band without holding the UK in memory.
    const pending = new Map();
    const flush = (band) => {
      const lines = pending.get(band);
      if (!lines?.length) return;
      fs.appendFileSync(path.join(work, `${band}.jsonl`), lines.join(""));
      pending.set(band, []);
      pending.get(band).bytes = 0;
    };
    const spill = (band, record) => {
      if (!pending.has(band)) pending.set(band, Object.assign([], { bytes: 0 }));
      const lines = pending.get(band);
      const line = JSON.stringify(record) + "\n";
      lines.push(line);
      lines.bytes += line.length;
      if (lines.bytes > FLUSH_BYTES) flush(band);
    };
    let ways = 0;
    let barriers = 0;
    for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
      const feature = parseOplLine(line);
      if (!feature) continue;
      if (feature.kind === "way") {
        ways += 1;
        const byBand = new Map();
        for (const key of wayTileKeys(feature.coords)) {
          if (!byBand.has(bandOf(key))) byBand.set(bandOf(key), []);
          byBand.get(bandOf(key)).push(key);
        }
        const { kind: _kind, ...way } = feature;
        for (const [band, keys] of byBand) spill(band, { keys, way });
      } else {
        barriers += 1;
        const key = tileKey(tileRow(feature.latE7 / 1e7), tileColumn(feature.lonE7 / 1e7));
        const { kind: _kind, ...barrier } = feature;
        spill(bandOf(key), { keys: [key], barrier });
      }
    }
    for (const band of pending.keys()) flush(band);

    // Pass 2: bands in ascending order, tiles in ascending key order, so the
    // data is row-major and one row of tiles is one contiguous byte range.
    const dataFile = path.join(work, "tiles.bin");
    const data = fs.openSync(dataFile, "w");
    const entries = [];
    let offset = 0;
    const bands = fs.readdirSync(work).filter((name) => name.endsWith(".jsonl")).map((name) => Number(name.slice(0, -6))).sort((a, b) => a - b);
    for (const band of bands) {
      const tiles = new Map();
      const lines = readline.createInterface({ input: fs.createReadStream(path.join(work, `${band}.jsonl`)), crlfDelay: Infinity });
      for await (const line of lines) {
        const record = JSON.parse(line);
        for (const key of record.keys) {
          if (bandOf(key) !== band) continue;
          if (!tiles.has(key)) tiles.set(key, { ways: [], barriers: [] });
          if (record.way) tiles.get(key).ways.push(record.way);
          else tiles.get(key).barriers.push(record.barrier);
        }
      }
      for (const key of [...tiles.keys()].sort((a, b) => a - b)) {
        const bytes = encodeTile(tiles.get(key));
        fs.writeSync(data, bytes);
        entries.push({ key, offset, length: bytes.length });
        offset += bytes.length;
      }
      fs.rmSync(path.join(work, `${band}.jsonl`));
    }
    fs.closeSync(data);

    const header = encodePackHeader({ ...meta, builtAt: meta.builtAt || new Date().toISOString(), ways, barriers, tiles: entries.length }, entries);
    fs.writeFileSync(output, header);
    await new Promise((resolve, reject) => fs.createReadStream(dataFile)
      .pipe(fs.createWriteStream(output, { flags: "a" })).on("finish", resolve).on("error", reject));
    return { ways, barriers, tiles: entries.length, bytes: header.length + offset };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [output, source = ""] = process.argv.slice(2);
  if (!output) {
    console.error("Usage: node build-pack.mjs out.sgmap \"source description\" < highways.opl");
    process.exit(2);
  }
  const result = await buildPack(process.stdin, output, { source });
  console.log(JSON.stringify(result));
}

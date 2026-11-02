import { gzipSync, gunzipSync } from "node:zlib";

// A map pack is one file of gzip tiles holding OpenStreetMap highway ways and
// gate nodes, built monthly from the free UK extract (see the public
// stride-guide-map-data repository, which keeps a copy of this module). A row-
// major index lets the server fetch only the tiles around a start with HTTP
// Range requests, so routing no longer depends on overloaded public Overpass
// servers.
//
// Layout: "SGMP" | uint32 version | uint32 metaLength | uint32 tileCount |
// meta JSON | tileCount x (uint32 key, uint32 length, float64 offset) | tiles.
// Offsets are relative to the first tile byte. All integers are little-endian.
export const PACK_VERSION = 1;
export const TILE_DEGREES = 0.02;
const COLUMNS = Math.round(360 / TILE_DEGREES);
const ENTRY_BYTES = 16;
const FIXED_HEADER_BYTES = 16;
const E7 = 1e7;
const MAX_TILE_BYTES = 16 * 1024 * 1024;

export const tileRow = (lat) => Math.floor((lat + 90) / TILE_DEGREES);
export const tileColumn = (lon) => Math.floor((lon + 180) / TILE_DEGREES);
export const tileKey = (row, column) => row * COLUMNS + column;
export const tileKeyRow = (key) => Math.floor(key / COLUMNS);

const deltas = (values) => values.map((value, index) => index ? value - values[index - 1] : value);
const undeltas = (values) => {
  const result = new Array(values.length);
  for (let index = 0; index < values.length; index += 1) result[index] = index ? result[index - 1] + values[index] : values[index];
  return result;
};

// ways: { id, nodes, tags, coords: [[lonE7, latE7], ...] }; barriers: { id, lonE7, latE7, tags }.
export function encodeTile({ ways = [], barriers = [] }) {
  return gzipSync(JSON.stringify({
    w: ways.map((way) => [way.id, way.tags, deltas(way.nodes), deltas(way.coords.flat())]),
    b: barriers.map((node) => [node.id, node.lonE7, node.latE7, node.tags])
  }));
}

// Returns Overpass-shaped elements so the existing compaction code applies.
export function decodeTile(buffer) {
  const data = JSON.parse(gunzipSync(buffer, { maxOutputLength: MAX_TILE_BYTES * 8 }).toString());
  if (!Array.isArray(data.w) || !Array.isArray(data.b)) throw new Error("Invalid map tile");
  const elements = [];
  for (const [id, tags, nodeDeltas, coordDeltas] of data.w) {
    const nodes = undeltas(nodeDeltas);
    const flat = undeltas(coordDeltas);
    if (nodes.length < 2 || flat.length !== nodes.length * 2) throw new Error("Invalid map tile way");
    const geometry = [];
    for (let index = 0; index < flat.length; index += 2) geometry.push({ lon: flat[index] / E7, lat: flat[index + 1] / E7 });
    elements.push({ type: "way", id, nodes, tags, geometry });
  }
  for (const [id, lonE7, latE7, tags] of data.b) elements.push({ type: "node", id, lon: lonE7 / E7, lat: latE7 / E7, tags });
  return elements;
}

// entries must be sorted by key and laid out in that order after the header.
export function encodePackHeader(meta, entries) {
  const metaBytes = Buffer.from(JSON.stringify({ ...meta, tileDegrees: TILE_DEGREES }));
  const header = Buffer.alloc(FIXED_HEADER_BYTES + metaBytes.length + entries.length * ENTRY_BYTES);
  header.write("SGMP", 0, "latin1");
  header.writeUInt32LE(PACK_VERSION, 4);
  header.writeUInt32LE(metaBytes.length, 8);
  header.writeUInt32LE(entries.length, 12);
  metaBytes.copy(header, FIXED_HEADER_BYTES);
  let position = FIXED_HEADER_BYTES + metaBytes.length;
  let previous = -1;
  for (const entry of entries) {
    if (entry.key <= previous) throw new Error("Pack entries must be sorted by key");
    previous = entry.key;
    header.writeUInt32LE(entry.key, position);
    header.writeUInt32LE(entry.length, position + 4);
    header.writeDoubleLE(entry.offset, position + 8);
    position += ENTRY_BYTES;
  }
  return header;
}

const intersects = (a, b) => a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;

export function createMapPack({ url, fetchImpl = fetch, now = Date.now, refreshMs = 6 * 60 * 60 * 1000,
  retryMs = 10 * 60 * 1000, timeoutMs = 15000, maxBytesPerRequest = 32 * 1024 * 1024 } = {}) {
  let loaded = null;
  let loading = null;
  let unavailableUntil = 0;
  let hits = 0;
  let misses = 0;
  let errors = 0;
  let lastError = null;

  async function range(target, start, end) {
    const response = await fetchImpl(target, { headers: { range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(timeoutMs) });
    // A 200 would be the whole multi-hundred-megabyte file; never read it.
    if (response.status !== 206) {
      await response.body?.cancel?.().catch(() => {});
      const error = new Error(`Map pack returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length !== end - start + 1) throw new Error("Map pack returned a short range");
    return buffer;
  }

  // "releases/latest/download" moves when a new pack is published. Pin the
  // release so a cached index never addresses tiles in a different file.
  async function resolve() {
    if (!url.includes("/releases/latest/download/")) return url;
    const response = await fetchImpl(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) throw new Error(`Map pack release lookup returned ${response.status}`);
    return new URL(location, url).href;
  }

  async function load() {
    const target = await resolve();
    const head = await range(target, 0, FIXED_HEADER_BYTES - 1);
    if (head.toString("latin1", 0, 4) !== "SGMP" || head.readUInt32LE(4) !== PACK_VERSION) throw new Error("Unsupported map pack");
    const metaLength = head.readUInt32LE(8);
    const tileCount = head.readUInt32LE(12);
    const headerEnd = FIXED_HEADER_BYTES + metaLength + tileCount * ENTRY_BYTES;
    if (metaLength > 65536 || headerEnd > 64 * 1024 * 1024) throw new Error("Map pack header is too large");
    const header = await range(target, FIXED_HEADER_BYTES, headerEnd - 1);
    const meta = JSON.parse(header.toString("utf8", 0, metaLength));
    if (meta.tileDegrees !== TILE_DEGREES) throw new Error("Unsupported map pack tile size");
    const index = header.subarray(metaLength);
    const keys = new Uint32Array(tileCount);
    for (let entry = 0; entry < tileCount; entry += 1) keys[entry] = index.readUInt32LE(entry * ENTRY_BYTES);
    return { target, meta, index, keys, dataStart: headerEnd, loadedAt: now() };
  }

  async function current() {
    if (loaded && now() - loaded.loadedAt < refreshMs) return loaded;
    // With no pack at all (none published yet, or GitHub unreachable), do not
    // add a doomed lookup to every search.
    if (!loaded && now() < unavailableUntil) throw new Error(lastError || "Map pack unavailable");
    loading ||= load().then((value) => { loaded = value; return value; }).finally(() => { loading = null; });
    try {
      return await loading;
    } catch (error) {
      // Keep serving a still-readable older index if a refresh fails, and do
      // not retry the refresh on every search.
      if (loaded) {
        loaded.loadedAt = now();
        return loaded;
      }
      unavailableUntil = now() + retryMs;
      throw error;
    }
  }

  const firstAtLeast = (keys, key) => {
    let low = 0;
    let high = keys.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (keys[middle] < key) low = middle + 1; else high = middle;
    }
    return low;
  };

  async function read(pack, bounds) {
    const ways = new Map();
    const barriers = new Map();
    let tiles = 0;
    for (let row = tileRow(bounds.south); row <= tileRow(bounds.north); row += 1) {
      const first = firstAtLeast(pack.keys, tileKey(row, tileColumn(bounds.west)));
      const last = firstAtLeast(pack.keys, tileKey(row, tileColumn(bounds.east)) + 1) - 1;
      if (last < first) continue;
      // Tiles in one row are stored next to each other: one request per row.
      const entry = (position) => ({
        length: pack.index.readUInt32LE(position * ENTRY_BYTES + 4),
        offset: pack.index.readDoubleLE(position * ENTRY_BYTES + 8)
      });
      const start = entry(first).offset;
      const end = entry(last).offset + entry(last).length;
      if (end - start > maxBytesPerRequest) throw new Error("Map pack area is too large");
      const bytes = await range(pack.target, pack.dataStart + start, pack.dataStart + end - 1);
      for (let position = first; position <= last; position += 1) {
        const { offset, length } = entry(position);
        tiles += 1;
        for (const element of decodeTile(bytes.subarray(offset - start, offset - start + length))) {
          if (element.type === "node") {
            if (element.lat >= bounds.south && element.lat <= bounds.north && element.lon >= bounds.west && element.lon <= bounds.east) {
              barriers.set(element.id, element);
            }
            continue;
          }
          if (ways.has(element.id)) continue;
          const lats = element.geometry.map((point) => point.lat);
          const lons = element.geometry.map((point) => point.lon);
          const box = { south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lons), east: Math.max(...lons) };
          if (intersects(box, bounds)) ways.set(element.id, element);
        }
      }
    }
    return { tiles, elements: [...ways.values(), ...barriers.values()] };
  }

  return {
    snapshot: () => ({
      enabled: Boolean(url), hits, misses, errors, lastError,
      builtAt: loaded?.meta.builtAt || null, source: loaded?.meta.source || null, tiles: loaded?.keys.length || 0
    }),
    // Resolves to { elements, builtAt } or null. Never throws: any failure is a
    // miss so the caller can fall back to Overpass.
    async get(bounds) {
      if (!url) return null;
      try {
        let pack = await current();
        let result;
        try {
          result = await read(pack, bounds);
        } catch (error) {
          // A replaced release answers 404/416 for old offsets; reload once.
          if (![404, 416].includes(error.status)) throw error;
          loaded = null;
          pack = await current();
          result = await read(pack, bounds);
        }
        if (!result.elements.some((element) => element.type === "way")) {
          misses += 1;
          return null;
        }
        hits += 1;
        return { elements: result.elements, builtAt: pack.meta.builtAt, tiles: result.tiles };
      } catch (error) {
        errors += 1;
        lastError = error.message;
        return null;
      }
    }
  };
}

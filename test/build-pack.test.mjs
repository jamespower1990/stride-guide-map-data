import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { buildPack, parseOplLine, wayTileKeys } from "../build-pack.mjs";
import { createMapPack } from "../map-pack.mjs";

// Tiny extract around a tile corner (tiles are 0.02 degrees), as osmium writes it.
const opl = [
  "n1 Tbarrier=gate,locked=yes,access=private x-1.0010000 y51.0010000",
  "n2 Tbarrier=bollard x-1.0020000 y51.0020000",
  "n3 Thighway=crossing x-1.0030000 y51.0030000",
  "w10 Thighway=residential,name=High%20%Street,sidewalk=both Nn1x-1.0010000y51.0010000,n4x-1.0050000y51.0010000",
  // Crosses from one tile row into the next.
  "w11 Thighway=footway,footway=sidewalk Nn4x-1.0050000y51.0010000,n5x-1.0050000y50.9990000,n6x-1.0060000y50.9980000",
  // A node missing its location is dropped together with its id.
  "w12 Thighway=path,foot=designated Nn7x-1.0100000y51.0100000,n8xy,n9x-1.0110000y51.0110000",
  "w13 Tbuilding=yes Nn20x-1.0010000y51.0010000,n21x-1.0020000y51.0020000",
  ""
].join("\n");

function rangeServer(buffer) {
  const requests = [];
  const fetchImpl = async (_url, init = {}) => {
    const [, start, end] = init.headers.range.match(/bytes=(\d+)-(\d+)/).map(Number);
    requests.push([start, end]);
    return new Response(buffer.subarray(start, end + 1), { status: 206 });
  };
  return { fetchImpl, requests };
}

test("parses osmium OPL ways, gate barriers and escaped tags", () => {
  const way = parseOplLine("w10 Thighway=residential,name=High%20%Street,sidewalk=both Nn1x-1.0010000y51.0010000,n4x-1.0050000y51.0010000");
  assert.deepEqual(way, { kind: "way", id: 10, tags: { highway: "residential", sidewalk: "both" }, nodes: [1, 4], coords: [[-10010000, 510010000], [-10050000, 510010000]] });
  assert.equal(parseOplLine("n2 Tbarrier=bollard x-1 y51"), null);
  assert.equal(parseOplLine("w13 Tbuilding=yes Nn20x-1y51,n21x-1.1y51.1"), null);
  assert.deepEqual(parseOplLine("w12 Thighway=path Nn7x-1y51,n8xy,n9x-1.1y51.1").nodes, [7, 9]);
});

test("a segment is filed in every tile its bounding box touches", () => {
  assert.equal(wayTileKeys([[-10050000, 510010000], [-10050000, 509990000]]).length, 2);
  assert.equal(wayTileKeys([[-10010000, 510010000], [-10050000, 510010000]]).length, 1);
});

test("built pack reads back ways, gates and cross-tile ways once each", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "sgmap-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, "uk.sgmap");
  const result = await buildPack(Readable.from([opl]), output, { source: "fixture", builtAt: "2026-11-01T00:00:00Z" });
  assert.deepEqual({ ways: result.ways, barriers: result.barriers }, { ways: 3, barriers: 1 });

  const { fetchImpl, requests } = rangeServer(readFileSync(output));
  const pack = createMapPack({ url: "https://example.test/uk.sgmap", fetchImpl });
  const loaded = await pack.get({ south: 50.995, west: -1.008, north: 51.004, east: -1.0 });
  const ways = loaded.elements.filter((element) => element.type === "way");
  assert.deepEqual(ways.map((way) => way.id).sort(), [10, 11]);
  assert.deepEqual(ways.find((way) => way.id === 11).geometry.at(-1), { lon: -1.006, lat: 50.998 });
  assert.deepEqual(loaded.elements.filter((element) => element.type === "node").map((node) => node.tags), [{ barrier: "gate", locked: "yes", access: "private" }]);
  assert.equal(loaded.builtAt, "2026-11-01T00:00:00Z");
  // Header, index, then one request per tile row (two rows here).
  assert.equal(requests.length, 4);

  const far = await pack.get({ south: 51.009, west: -1.012, north: 51.012, east: -1.009 });
  assert.deepEqual(far.elements.map((element) => element.id), [12]);
  assert.deepEqual(far.elements[0].nodes, [7, 9]);
});

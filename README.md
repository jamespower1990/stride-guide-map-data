# Stride Guide map data

A monthly pack of UK roads, paths and gates from OpenStreetMap, used by the
Stride Guide running-route planner so it does not depend on busy public
Overpass servers.

A GitHub Actions job downloads the free Geofabrik UK extract, keeps only
highways and gates with the tags the planner needs, and publishes one file,
`uk-highways.sgmap`, as the latest release. The planner reads only the few
tiles around a start using HTTP Range requests.

## Format

`map-pack.mjs` defines the format and is shared with the planner; keep both
copies identical. In short: a small header, a sorted index of 0.02° tiles, then
gzip JSON tiles in row-major order, so one row of tiles is one byte range.

## Building locally

```bash
osmium tags-filter extract.osm.pbf w/highway n/barrier=gate,lift_gate,swing_gate,chain -o highways.osm.pbf
osmium add-locations-to-ways highways.osm.pbf -f opl,add_metadata=false -o - | node build-pack.mjs uk-highways.sgmap "description"
node --test
```

## Licence

The data is © OpenStreetMap contributors and available under the
[Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
Each pack is a derived database and is published under the same licence.

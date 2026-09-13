# geofs-real-tree-positions
geofs-real-tree-positions  A Tampermonkey userscript that extracts the **real world lat/lon/height of every tree** rendered in [GeoFS](https://www.geo-fs.com/),
# geofs-real-tree-positions

A Tampermonkey userscript that extracts the **real world lat/lon/height of every tree** rendered in [GeoFS](https://www.geo-fs.com/), a free browser-based flight simulator built on CesiumJS.

## Why this exists

GeoFS renders its trees through a custom pipeline that sits completely outside Cesium's standard rendering path. That means none of Cesium's normal picking APIs can "see" them — confirmed by testing all three approaches:

- `scene.pick()` / `scene.drillPick()` — trees have no pickable ID, nothing returned.
- `scene.sampleHeight()` — documented to only consider terrain + real `Cesium3DTileset`s, never even attempts to see other primitives.
- `scene.pickPosition()` (with and without `pickTranslucentDepth`) — rays pass straight through tree canopies and land on the terrain underneath, meaning trees never write to the depth buffer Cesium can read.

So if you need to know "is there a real tree at this exact location" (for a crash-detection mod, a forestry visualization, anything), there's no supported way to ask Cesium. This script solves that by going straight to the source: it downloads GeoFS's own tree tiles and decodes them by hand.

## How it works

1. Hooks into `geofs.trees.simple3DTileProvider` to find which tree tiles are currently loaded.
2. Downloads each tile's raw `.glb` file directly (same file GeoFS itself loads).
3. Parses the glTF binary container by hand (JSON + BIN chunks) — no external glTF loader library.
4. Decodes the Draco-compressed position buffer using Google's `draco3d` decoder, loaded on demand.
5. Applies a Y-up → Z-up axis correction (glTF's convention vs. Cesium's) before transforming each vertex by the tile's model matrix — this was the trickiest bug to track down, since skipping it silently produces coordinates that are wrong by tens of kilometers.
6. Indexes every extracted tree position into a spatial grid (in ECEF coordinates) so proximity queries stay fast regardless of how many trees are loaded.

## Usage

Once installed, the script exposes a global API:

```js
// Get every currently-indexed tree as a flat [lat, lon, height, lat, lon, height, ...] array
window.geofsRealTrees.getAllTrees();

// Check if there's a real tree within `radiusMeters` of a given lat/lon
window.geofsRealTrees.isTreeNear(lat, lon, radiusMeters); // -> boolean
```

Press `[` in-game to open a live stats dashboard (trees indexed, tiles processed, active grid cells, decoder status).

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or a similar userscript manager).
2. Create a new script in Tampermonkey and paste in the contents of the `.user.js` file from this repo.
3. Reload GeoFS, fly near a forest, and give it a few seconds to start extracting.

## Known limitations

- **Tree grouping is a heuristic, not a guarantee.** The script assumes each tree corresponds to a fixed group of 6 consecutive vertices in the decoded buffer, using the first vertex of each group as that tree's position. This held up in real-world testing (heights came out physically plausible, matched against real terrain data), but Draco compression can reorder vertices internally — so this is a reasonable proxy for "there's a tree around here," not a pixel-perfect guarantee of one point per physical tree trunk.
- **Bandwidth**: tiles are re-downloaded independently of GeoFS's own fetch/cache, so this roughly doubles network usage for tree tiles while active.
- **Performance**: designed for occasional proximity checks (e.g. a few times per second), not for calling `isTreeNear` in a tight 60fps loop.
- Tied to GeoFS's current internal structure (`geofs.trees.simple3DTileProvider`, tile URL scheme, glTF/Draco format). If GeoFS changes any of this internally, the script will likely need updates.

## License

CC BY 4.0 — see [LICENSE](./LICENSE). Use it, fork it, build on it — just credit the source.

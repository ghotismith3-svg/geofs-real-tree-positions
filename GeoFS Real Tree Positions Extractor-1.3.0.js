// ==UserScript==
// @name         GeoFS Real Tree Positions Extractor
// @namespace    https://www.geo-fs.com/geofs.php?v=4
// @version      1.9.2
// @description  Extracts real tree positions (lat/lon/height) from geofs.trees .glb tiles, decoding Draco by hand. Exposes window.geofsRealTrees for other scripts to use. v1.9.0 CYLINDER COLLISION FIX: replaced point-sphere distance check with a true 3D vertical cylinder. v1.9.1: Exit button in dashboard. v1.9.2: Clean console logging (silent tile loader by default) and scratch vector memory optimization.
// @author       yasseristaken
// @match        https://www.geo-fs.com/geofs.php*
// @match        https://geo-fs.com/geofs.php*
// @match        https://*.geo-fs.com/geofs.php*
// @grant        none
// @run-at       document-idle
// @license      CC-BY-4.0
// ==/UserScript==

(function () {
  "use strict";

  // ============================================================
  // CONFIG
  // ============================================================
  const CONFIG = {
    DRACO_DECODER_URL: "https://www.gstatic.com/draco/versioned/decoders/1.5.6/draco_decoder.js",
    VERTS_PER_TREE: 6,   // heuristic: cone/cross made of 2 triangles, 6 non-shared vertices
    APEX_INDEX_IN_GROUP: 0, // first vertex of each group of 6, used as a position proxy
    RESCAN_INTERVAL_MS: 3000,
    MAX_TREES_KEPT: 200000,
    GRID_CELL_DEG: 0.0005,
    MAX_TREE_HEIGHT_ABOVE_TERRAIN_M: 60,
    // FIX v1.9.0: Default vertical canopy height (meters) in GeoFS.
    // Trees in GeoFS typically render up to ~30-35m above ground level.
    DEFAULT_CANOPY_HEIGHT_M: 32,
    // Vertical margin below the tree base to handle slope / gear penetration
    BASE_VERTICAL_MARGIN_M: 3,
    // Console output control: false keeps browser console quiet and clean during flight
    DEBUG_LOGS: false
  };

  // Scratch Cesium objects for zero-allocation geometry math in high-frequency checks
  let _scratchTarget = null;
  let _scratchUpNormal = null;

  // ============================================================
  // State
  // ============================================================
  const state = {
    decoderModule: null,
    decoderLoading: null,
    processedTileIds: new Set(),
    treesByTile: new Map(),
    flatCache: null,
    flatCacheDirty: true,
    grid: new Map(),
    tileCellKeys: new Map()
  };

  function getCesium() { return window.Cesium || window.geofs?.api?.Cesium || null; }
  function getViewer() { return window.geofs?.api?.viewer || null; }

  function cellKeyFor(lat, lon) {
    const gx = Math.floor(lat / CONFIG.GRID_CELL_DEG);
    const gy = Math.floor(lon / CONFIG.GRID_CELL_DEG);
    return gx + "_" + gy;
  }

  // ============================================================
  // Load the Draco decoder (once, cached)
  // ============================================================
  async function getDracoDecoder() {
    if (state.decoderModule) return state.decoderModule;
    if (state.decoderLoading) return state.decoderLoading;

    state.decoderLoading = (async () => {
      if (typeof DracoDecoderModule === "undefined") {
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = CONFIG.DRACO_DECODER_URL;
          script.onload = resolve;
          script.onerror = reject;
          document.head.appendChild(script);
        });
      }
      const module = await new Promise((resolve) => DracoDecoderModule({}).then(resolve));
      state.decoderModule = module;
      console.log("[RealTrees] ✅ Draco decoder ready");
      return module;
    })();

    return state.decoderLoading;
  }

  // ============================================================
  // Parse a .glb (magic + JSON/BIN chunks) -- no libraries, by hand
  // ============================================================
  function parseGlb(buf) {
    const dv = new DataView(buf);
    const magic = dv.getUint32(0, true);
    if (magic !== 0x46546c67) throw new Error("Not a valid glb (magic mismatch)");
    const totalLength = dv.getUint32(8, true);

    let offset = 12, jsonChunk = null, binChunk = null;
    while (offset < totalLength) {
      const chunkLength = dv.getUint32(offset, true);
      const chunkType = dv.getUint32(offset + 4, true);
      const chunkStart = offset + 8;
      if (chunkType === 0x4e4f534a) jsonChunk = buf.slice(chunkStart, chunkStart + chunkLength);
      else if (chunkType === 0x004e4942) binChunk = buf.slice(chunkStart, chunkStart + chunkLength);
      offset = chunkStart + chunkLength;
    }
    if (!jsonChunk || !binChunk) throw new Error("Missing JSON/BIN chunks in the glb");
    const json = JSON.parse(new TextDecoder().decode(jsonChunk));
    return { json, binChunk };
  }

  // ============================================================
  // Decode the Draco-compressed bufferView -> Float32Array of POSITION
  // ============================================================
  async function decodeDracoPositions(json, binChunk) {
    const decoderModule = await getDracoDecoder();
    const bv = json.bufferViews[0];
    const dracoBytes = new Int8Array(binChunk, bv.byteOffset || 0, bv.byteLength);

    const decoder = new decoderModule.Decoder();
    const dbuf = new decoderModule.DecoderBuffer();
    dbuf.Init(dracoBytes, dracoBytes.length);

    const dracoMesh = new decoderModule.Mesh();
    const status = decoder.DecodeBufferToMesh(dbuf, dracoMesh);
    if (!status.ok()) throw new Error("Draco decode failed: " + status.error_msg());

    const numPoints = dracoMesh.num_points();
    const posAttrId = decoder.GetAttributeId(dracoMesh, decoderModule.POSITION);
    const posAttribute = decoder.GetAttribute(dracoMesh, posAttrId);
    const dracoArray = new decoderModule.DracoFloat32Array();
    decoder.GetAttributeFloatForAllPoints(dracoMesh, posAttribute, dracoArray);

    const positions = new Float32Array(numPoints * 3);
    for (let i = 0; i < numPoints * 3; i++) positions[i] = dracoArray.GetValue(i);

    decoderModule.destroy(dracoArray);
    decoderModule.destroy(dracoMesh);
    decoderModule.destroy(dbuf);
    decoderModule.destroy(decoder);

    return positions;
  }

  // ============================================================
  // Process a full tile: download, decode, transform to lat/lon/height,
  // filter out corrupted vertices, and index into the spatial grid
  // ============================================================
  async function processTile(tileEntry, providerOptions) {
    const Cesium = getCesium();
    const viewer = getViewer();
    if (!Cesium || tileEntry.__realTreesProcessing) return;
    if (state.processedTileIds.has(tileEntry.id)) return;
    tileEntry.__realTreesProcessing = true;

    try {
      if (!tileEntry.model) return;
      await tileEntry.model.readyPromise;
      const model = tileEntry.model._model;
      const modelMatrix = model?.modelMatrix;
      if (!modelMatrix) return;

      const matrixSnapshot = Cesium.Matrix4.clone(modelMatrix);

      let tileRect = null;
      const scheme = window.geofs?.trees?.simple3DTileProvider?.tilingScheme;
      if (scheme && typeof scheme.tileXYToRectangle === "function" && tileEntry.x != null && tileEntry.y != null && tileEntry.z != null) {
        try {
          const z = parseInt(tileEntry.z, 10);
          // Row index mismatch fix (y+1)
          let correctedY = tileEntry.y + 1;
          if (typeof scheme.getNumberOfYTilesAtLevel === "function") {
            const maxY = scheme.getNumberOfYTilesAtLevel(z) - 1;
            if (correctedY > maxY) correctedY = maxY;
          }
          tileRect = scheme.tileXYToRectangle(tileEntry.x, correctedY, z);
        } catch (e) {
          tileRect = null;
        }
      }

      const url = providerOptions.url + tileEntry.id + (providerOptions.extension || ".glb");
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const buf = await res.arrayBuffer();
      const { json, binChunk } = parseGlb(buf);

      let positions;
      const usesDraco = !!json.meshes?.[0]?.primitives?.[0]?.extensions?.KHR_draco_mesh_compression;
      if (usesDraco) {
        positions = await decodeDracoPositions(json, binChunk);
      } else {
        const prim = json.meshes[0].primitives[0];
        const accessor = json.accessors[prim.attributes.POSITION];
        const bufferView = json.bufferViews[accessor.bufferView];
        const byteOffset = (accessor.byteOffset || 0) + (bufferView.byteOffset || 0);
        positions = new Float32Array(binChunk, byteOffset, accessor.count * 3);
      }

      const vertCount = positions.length / 3;
      const numTrees = Math.floor(vertCount / CONFIG.VERTS_PER_TREE);

      const localPoint = new Cesium.Cartesian3();
      const worldPoint = new Cesium.Cartesian3();

      const terrainHeightCache = new Map();
      const tempCarto = viewer ? new Cesium.Cartographic() : null;

      function terrainHeightForCell(lat, lon, key) {
        if (terrainHeightCache.has(key)) return terrainHeightCache.get(key);
        let h = null;
        if (viewer) {
          try {
            tempCarto.latitude = Cesium.Math.toRadians(lat);
            tempCarto.longitude = Cesium.Math.toRadians(lon);
            h = viewer.scene.globe.getHeight(tempCarto);
          } catch (e) {
            h = null;
          }
        }
        terrainHeightCache.set(key, h);
        return h;
      }

      const out = new Float64Array(numTrees * 3);
      const byCell = new Map();
      let kept = 0;
      let droppedHeight = 0;
      let droppedBounds = 0;

      let minLat = Infinity, maxLat = -Infinity;
      let minLon = Infinity, maxLon = -Infinity;

      for (let t = 0; t < numTrees; t++) {
        const vIdx = (t * CONFIG.VERTS_PER_TREE + CONFIG.APEX_INDEX_IN_GROUP) * 3;

        const xLocal = positions[vIdx];
        const yLocal = positions[vIdx + 1];
        const zLocal = positions[vIdx + 2];

        localPoint.x = xLocal;
        localPoint.y = -zLocal;
        localPoint.z = yLocal;

        Cesium.Matrix4.multiplyByPoint(matrixSnapshot, localPoint, worldPoint);
        const carto = Cesium.Cartographic.fromCartesian(worldPoint);

        let dropBounds = false;
        if (tileRect) {
          dropBounds =
            carto.latitude < tileRect.south ||
            carto.latitude > tileRect.north ||
            carto.longitude < tileRect.west ||
            carto.longitude > tileRect.east;
          if (dropBounds) droppedBounds++;
        }

        const lat = Cesium.Math.toDegrees(carto.latitude);
        const lon = Cesium.Math.toDegrees(carto.longitude);
        const key = cellKeyFor(lat, lon);

        const terrainH = terrainHeightForCell(lat, lon, key);
        let aboveTerrain = null;
        let dropHeight = false;
        if (terrainH != null) {
          aboveTerrain = carto.height - terrainH;
          dropHeight = aboveTerrain > CONFIG.MAX_TREE_HEIGHT_ABOVE_TERRAIN_M;
          if (dropHeight) droppedHeight++;
        }

        if (t === 0 && CONFIG.DEBUG_LOGS) {
          console.log(
            `[RealTrees][DEBUG] Tile ${tileEntry.id} first tree -- ` +
            `lat=${lat.toFixed(6)} lon=${lon.toFixed(6)} height=${carto.height.toFixed(2)}m | ` +
            `tileRect(deg)=[south=${tileRect ? Cesium.Math.toDegrees(tileRect.south).toFixed(6) : "n/a"}, ` +
            `north=${tileRect ? Cesium.Math.toDegrees(tileRect.north).toFixed(6) : "n/a"}, ` +
            `west=${tileRect ? Cesium.Math.toDegrees(tileRect.west).toFixed(6) : "n/a"}, ` +
            `east=${tileRect ? Cesium.Math.toDegrees(tileRect.east).toFixed(6) : "n/a"}] | ` +
            `dropBounds=${dropBounds} | ` +
            `terrainH=${terrainH != null ? terrainH.toFixed(2) + "m" : "n/a"} aboveTerrain=${aboveTerrain != null ? aboveTerrain.toFixed(2) + "m" : "n/a"} ` +
            `dropHeight=${dropHeight}`
          );
        }

        if (dropBounds || dropHeight) continue;

        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;

        out[kept * 3] = lat;
        out[kept * 3 + 1] = lon;
        out[kept * 3 + 2] = carto.height;
        kept++;

        if (!byCell.has(key)) byCell.set(key, []);
        byCell.get(key).push(worldPoint.x, worldPoint.y, worldPoint.z);
      }

      if (tileRect && kept > 0 && CONFIG.DEBUG_LOGS) {
        const rectSouth = Cesium.Math.toDegrees(tileRect.south);
        const rectNorth = Cesium.Math.toDegrees(tileRect.north);
        const rectWest = Cesium.Math.toDegrees(tileRect.west);
        const rectEast = Cesium.Math.toDegrees(tileRect.east);

        const southOverflow = minLat < rectSouth ? (rectSouth - minLat) : 0;
        const northOverflow = maxLat > rectNorth ? (maxLat - rectNorth) : 0;
        const westOverflow = minLon < rectWest ? (rectWest - minLon) : 0;
        const eastOverflow = maxLon > rectEast ? (maxLon - rectEast) : 0;

        console.log(
          `[RealTrees][DEBUG] Tile ${tileEntry.id} extent (${kept} surviving trees) -- ` +
          `lat=[${minLat.toFixed(6)}, ${maxLat.toFixed(6)}] lon=[${minLon.toFixed(6)}, ${maxLon.toFixed(6)}] | ` +
          `overflow(deg): S=${southOverflow.toFixed(6)} N=${northOverflow.toFixed(6)} W=${westOverflow.toFixed(6)} E=${eastOverflow.toFixed(6)}`
        );
      }

      const trimmed = out.subarray(0, kept * 3);
      state.treesByTile.set(tileEntry.id, trimmed);
      state.processedTileIds.add(tileEntry.id);
      state.flatCacheDirty = true;

      const usedCells = new Set();
      for (const [key, arr] of byCell) {
        if (!state.grid.has(key)) state.grid.set(key, new Map());
        state.grid.get(key).set(tileEntry.id, new Float64Array(arr));
        usedCells.add(key);
      }
      state.tileCellKeys.set(tileEntry.id, usedCells);

      const droppedTotal = droppedHeight + droppedBounds;
      if (droppedTotal > 0 && CONFIG.DEBUG_LOGS) {
        console.warn(
          `[RealTrees] ⚠️ Tile ${tileEntry.id}: dropped ${droppedTotal} corrupted tree(s) ` +
          `(${droppedHeight} height, ${droppedBounds} out-of-bounds) out of ${numTrees} extracted.`
        );
      }
      if (CONFIG.DEBUG_LOGS) {
        console.log(
          `[RealTrees] ✅ Tile ${tileEntry.id}: ${kept} trees kept (${usedCells.size} grid cells, ` +
          `${terrainHeightCache.size} terrain queries)`
        );
      }
    } catch (e) {
      console.error(`[RealTrees] ❌ Error processing tile ${tileEntry.id}:`, e);
      state.processedTileIds.add(tileEntry.id);
    } finally {
      tileEntry.__realTreesProcessing = false;
    }
  }

  // ============================================================
  // Periodic scan: process new tiles, clean up unloaded ones
  // ============================================================
  function scanTiles() {
    const provider = window.geofs?.trees?.simple3DTileProvider;
    if (!provider) return;

    const currentIds = new Set(Object.keys(provider.tiles));

    for (const id of currentIds) {
      const entry = provider.tiles[id];
      if (entry.model && !state.processedTileIds.has(id)) {
        processTile(entry, provider.options);
      }
    }

    for (const id of Array.from(state.treesByTile.keys())) {
      if (!currentIds.has(id)) {
        state.treesByTile.delete(id);
        state.processedTileIds.delete(id);
        state.flatCacheDirty = true;

        const cells = state.tileCellKeys.get(id);
        if (cells) {
          for (const key of cells) {
            const tileMap = state.grid.get(key);
            if (tileMap) {
              tileMap.delete(id);
              if (tileMap.size === 0) state.grid.delete(key);
            }
          }
          state.tileCellKeys.delete(id);
        }
      }
    }
  }

  // ============================================================
  // Public API
  // ============================================================
  function getAllTrees() {
    if (!state.flatCacheDirty && state.flatCache) return state.flatCache;
    let total = 0;
    for (const arr of state.treesByTile.values()) total += arr.length / 3;
    const combined = new Float64Array(Math.min(total, CONFIG.MAX_TREES_KEPT) * 3);
    let i = 0;
    outer:
    for (const arr of state.treesByTile.values()) {
      for (let j = 0; j < arr.length; j += 3) {
        if (i >= combined.length) break outer;
        combined[i] = arr[j];
        combined[i + 1] = arr[j + 1];
        combined[i + 2] = arr[j + 2];
        i += 3;
      }
    }
    state.flatCache = combined;
    state.flatCacheDirty = false;
    return combined;
  }

  // FIX v1.9.0: 3D CYLINDER COLLISION MODEL
  // Replaces the point-sphere distance test. A tree is a vertical cylinder
  // extending from base (ground level - margin) to canopy height.
  // We project the delta vector between the tree base and the aircraft along
  // the local geodetic up-vector (ellipsoid surface normal).
  function isTreeNear(lat, lon, radiusMeters, heightMeters, canopyHeightMeters) {
    const Cesium = getCesium();
    if (!Cesium) return false;
    if (state.grid.size === 0) return false;

    const targetHeight = (typeof heightMeters === "number" && Number.isFinite(heightMeters)) ? heightMeters : 0;
    const canopyH = (typeof canopyHeightMeters === "number" && Number.isFinite(canopyHeightMeters) && canopyHeightMeters > 0)
      ? canopyHeightMeters
      : CONFIG.DEFAULT_CANOPY_HEIGHT_M;
    const baseMargin = CONFIG.BASE_VERTICAL_MARGIN_M;

    const metersPerDegLat = 111320;
    const dLatDeg = radiusMeters / metersPerDegLat;
    const cosLat = Math.max(0.1, Math.cos(Cesium.Math.toRadians(lat)));
    const dLonDeg = radiusMeters / (metersPerDegLat * cosLat);

    const cellDeg = CONFIG.GRID_CELL_DEG;
    const minGx = Math.floor((lat - dLatDeg) / cellDeg);
    const maxGx = Math.floor((lat + dLatDeg) / cellDeg);
    const minGy = Math.floor((lon - dLonDeg) / cellDeg);
    const maxGy = Math.floor((lon + dLonDeg) / cellDeg);

    if (!_scratchTarget && Cesium.Cartesian3) {
      _scratchTarget = new Cesium.Cartesian3();
      _scratchUpNormal = new Cesium.Cartesian3();
    }
    const target = _scratchTarget
      ? Cesium.Cartesian3.fromDegrees(lon, lat, targetHeight, Cesium.Ellipsoid.WGS84, _scratchTarget)
      : Cesium.Cartesian3.fromDegrees(lon, lat, targetHeight);
    // Local vertical unit vector at aircraft location (pointing towards zenith)
    const upNormal = _scratchUpNormal
      ? Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(target, _scratchUpNormal)
      : Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(target, new Cesium.Cartesian3());
    const radiusSq = radiusMeters * radiusMeters;

    for (let gx = minGx; gx <= maxGx; gx++) {
      for (let gy = minGy; gy <= maxGy; gy++) {
        const tileMap = state.grid.get(gx + "_" + gy);
        if (!tileMap) continue;
        for (const arr of tileMap.values()) {
          for (let i = 0; i < arr.length; i += 3) {
            const px = arr[i];
            const py = arr[i + 1];
            const pz = arr[i + 2];

            const dx = target.x - px;
            const dy = target.y - py;
            const dz = target.z - pz;

            // Full 3D distance squared
            const distSq3D = dx * dx + dy * dy + dz * dz;

            // Dot product with local up normal: relative altitude above tree base in meters
            const hRel = dx * upNormal.x + dy * upNormal.y + dz * upNormal.z;

            // Horizontal distance squared (Pythagorean deduction)
            const distSqHoriz = Math.max(0, distSq3D - (hRel * hRel));

            // Collision condition: horizontal radius hit AND within tree vertical span
            if (distSqHoriz <= radiusSq && hRel >= -baseMargin && hRel <= canopyH) {
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  // FIX v1.9.0: Diagnostics support cylinder breakdown (horizontal distance vs relative height)
  function findNearestTree(lat, lon, radiusMeters, heightMeters, canopyHeightMeters) {
    const Cesium = getCesium();
    if (!Cesium) return null;
    if (state.grid.size === 0) return null;

    const targetHeight = (typeof heightMeters === "number" && Number.isFinite(heightMeters)) ? heightMeters : 0;
    const canopyH = (typeof canopyHeightMeters === "number" && Number.isFinite(canopyHeightMeters) && canopyHeightMeters > 0)
      ? canopyHeightMeters
      : CONFIG.DEFAULT_CANOPY_HEIGHT_M;
    const baseMargin = CONFIG.BASE_VERTICAL_MARGIN_M;

    const metersPerDegLat = 111320;
    const dLatDeg = radiusMeters / metersPerDegLat;
    const cosLat = Math.max(0.1, Math.cos(Cesium.Math.toRadians(lat)));
    const dLonDeg = radiusMeters / (metersPerDegLat * cosLat);

    const cellDeg = CONFIG.GRID_CELL_DEG;
    const minGx = Math.floor((lat - dLatDeg) / cellDeg);
    const maxGx = Math.floor((lat + dLatDeg) / cellDeg);
    const minGy = Math.floor((lon - dLonDeg) / cellDeg);
    const maxGy = Math.floor((lon + dLonDeg) / cellDeg);

    const target = Cesium.Cartesian3.fromDegrees(lon, lat, targetHeight);
    const upNormal = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(target, new Cesium.Cartesian3());
    const radiusSq = radiusMeters * radiusMeters;

    let best = null;
    let bestDistHoriz = Infinity;

    for (let gx = minGx; gx <= maxGx; gx++) {
      for (let gy = minGy; gy <= maxGy; gy++) {
        const tileMap = state.grid.get(gx + "_" + gy);
        if (!tileMap) continue;
        for (const [tileId, arr] of tileMap) {
          for (let i = 0; i < arr.length; i += 3) {
            const px = arr[i];
            const py = arr[i + 1];
            const pz = arr[i + 2];

            const dx = target.x - px;
            const dy = target.y - py;
            const dz = target.z - pz;

            const distSq3D = dx * dx + dy * dy + dz * dz;
            const hRel = dx * upNormal.x + dy * upNormal.y + dz * upNormal.z;
            const distSqHoriz = Math.max(0, distSq3D - (hRel * hRel));

            if (distSqHoriz <= radiusSq && hRel >= -baseMargin && hRel <= canopyH) {
              const horizDist = Math.sqrt(distSqHoriz);
              if (horizDist < bestDistHoriz) {
                bestDistHoriz = horizDist;
                const p = new Cesium.Cartesian3(px, py, pz);
                const carto = Cesium.Cartographic.fromCartesian(p);
                best = {
                  tileId,
                  distance: Math.sqrt(distSq3D),
                  horizDistance: horizDist,
                  relHeight: hRel,
                  lat: Cesium.Math.toDegrees(carto.latitude),
                  lon: Cesium.Math.toDegrees(carto.longitude),
                  height: carto.height,
                  canopyHeight: canopyH
                };
              }
            }
          }
        }
      }
    }
    return best;
  }

  window.geofsRealTrees = {
    getAllTrees,
    isTreeNear,
    findNearestTree,
    setDebug: (enabled) => {
      CONFIG.DEBUG_LOGS = !!enabled;
      console.log(`[RealTrees] Debug logs: ${CONFIG.DEBUG_LOGS ? "ON (verbose)" : "OFF (quiet)"}`);
    },
    _state: state
  };

  // ============================================================
  // Init
  // ============================================================
  let attempts = 0;
  const poller = setInterval(() => {
    if (window.geofs?.trees?.simple3DTileProvider) {
      clearInterval(poller);
      setInterval(scanTiles, CONFIG.RESCAN_INTERVAL_MS);
      scanTiles();
      console.log(
        "%c[RealTrees]%c 🌳 Extractor v1.9.2 ready · Cylinder 3D active · Press [ for Dashboard",
        "color:#10b981;font-weight:bold;",
        "color:#94a3b8;"
      );
    } else if (++attempts > 200) {
      clearInterval(poller);
      console.error("[RealTrees] ❌ geofs.trees.simple3DTileProvider never appeared");
    }
  }, 300);

  // ============================================================
  // DASHBOARD ([ key)
  // ============================================================
  let dashPanel = null;
  let dashUpdateInterval = null;

  function buildDashStyles() {
    if (document.getElementById("rt-dash-style")) return;
    const style = document.createElement("style");
    style.id = "rt-dash-style";
    style.textContent = `
      #rt-dash {
        position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
        background: rgba(8,18,10,0.94); backdrop-filter: blur(12px);
        padding: 18px 20px; border-radius: 14px; z-index: 100000;
        min-width: 300px; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
        border: 1px solid rgba(120,255,150,0.25);
        font-family: 'Segoe UI', sans-serif; color: #fff;
      }
      #rt-dash .rt-title { font-weight: bold; font-size: 15px; margin-bottom: 0; text-align: left; }
      #rt-dash .rt-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 8px; }
      #rt-dash .rt-close-x {
        width: 24px; height: 24px; line-height: 22px; text-align: center;
        background: rgba(255,255,255,0.12); border: 1px solid rgba(120,255,150,0.3);
        border-radius: 6px; color: #fff; font-size: 14px; cursor: pointer; font-weight: bold;
      }
      #rt-dash .rt-close-x:hover { background: rgba(120,255,150,0.25); }
      #rt-dash .rt-row {
        display: flex; justify-content: space-between; padding: 5px 0;
        border-bottom: 1px solid rgba(255,255,255,0.06); font-size: 12.5px;
      }
      #rt-dash .rt-row:last-child { border-bottom: none; }
      #rt-dash .rt-label { color: #9fdcaa; }
      #rt-dash .rt-val { color: #e8ffe8; font-family: monospace; font-weight: 600; }
      #rt-dash .rt-close-btn {
        width: 100%; margin-top: 12px; padding: 6px 0;
        background: rgba(20,50,25,0.85); border: 1px solid rgba(120,255,150,0.35);
        border-radius: 6px; color: #a5f3b6; font-size: 11.5px; cursor: pointer; font-weight: 600;
      }
      #rt-dash .rt-close-btn:hover { background: rgba(30,70,35,0.95); }
      #rt-dash .rt-hint { text-align: center; font-size: 10px; color: #6a8a70; margin-top: 8px; }
    `;
    document.head.appendChild(style);
  }

  function formatNumber(n) {
    return n.toLocaleString("en-US");
  }

  function renderDashStats() {
    if (!dashPanel) return;

    let totalTrees = 0;
    for (const arr of state.treesByTile.values()) totalTrees += arr.length / 3;

    const tilesLoaded = state.processedTileIds.size;
    const gridCells = state.grid.size;
    const decoderStatus = state.decoderModule ? "ready ✅" : (state.decoderLoading ? "loading…" : "not started");

    dashPanel.querySelector("#rt-trees").textContent = formatNumber(totalTrees);
    dashPanel.querySelector("#rt-tiles").textContent = formatNumber(tilesLoaded);
    dashPanel.querySelector("#rt-cells").textContent = formatNumber(gridCells);
    dashPanel.querySelector("#rt-decoder").textContent = decoderStatus;
  }

  function closeDashboard() {
    if (dashPanel) {
      dashPanel.remove();
      dashPanel = null;
    }
    if (dashUpdateInterval) {
      clearInterval(dashUpdateInterval);
      dashUpdateInterval = null;
    }
  }

  function showDashboard() {
    if (dashPanel) {
      closeDashboard();
      return;
    }

    buildDashStyles();

    dashPanel = document.createElement("div");
    dashPanel.id = "rt-dash";
    dashPanel.innerHTML = `
      <div class="rt-header">
        <div class="rt-title">🌳 Real Tree Positions -- Dashboard v1.9.2</div>
        <button class="rt-close-x" id="rt-close-x" title="Cerrar dashboard ([ o clic)">✕</button>
      </div>
      <div class="rt-row"><span class="rt-label">Indexed trees</span><span class="rt-val" id="rt-trees">-</span></div>
      <div class="rt-row"><span class="rt-label">Processed tiles</span><span class="rt-val" id="rt-tiles">-</span></div>
      <div class="rt-row"><span class="rt-label">Active grid cells</span><span class="rt-val" id="rt-cells">-</span></div>
      <div class="rt-row"><span class="rt-label">Draco decoder</span><span class="rt-val" id="rt-decoder">-</span></div>
      <button class="rt-close-btn" id="rt-close-bottom">✕ Cerrar Dashboard (o tecla [)</button>
      <div class="rt-hint">Tip: Haz clic en ✕ o presiona [</div>
    `;
    document.body.appendChild(dashPanel);

    dashPanel.querySelector("#rt-close-x").onclick = closeDashboard;
    dashPanel.querySelector("#rt-close-bottom").onclick = closeDashboard;

    renderDashStats();
    dashUpdateInterval = setInterval(renderDashStats, 1000);
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "[" && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
      e.preventDefault();
      showDashboard();
    }
  });
})();

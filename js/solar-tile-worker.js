const TILE_SIZE = 256;
const MAX_CACHE_ENTRIES = 800;

let polygonIndex = null;
let minGeneration = 0;
const tileCache = new Map();

function sampleForZoom(z) {
    if (z >= 8) return 64;
    if (z >= 6) return 48;
    if (z >= 4) return 36;
    if (z >= 2) return 28;
    return 20;
}

function dayOfYear(d) {
    return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
}

function equationOfTime(d) {
    const B = (2 * Math.PI / 365) * (dayOfYear(d) - 81);
    return 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
}

function solarOffset(lon, d) {
    return lon / 15 + equationOfTime(d) / 60;
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function normalizeLon(lon) {
    let x = lon;
    while (x < -180) x += 360;
    while (x > 180) x -= 360;
    return x;
}

function inBBox(lon, lat, bbox) {
    return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

function pointInRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        const intersects = ((yi > lat) !== (yj > lat))
            && (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi);
        if (intersects) inside = !inside;
    }
    return inside;
}

function toBin(lon, lat) {
    const s = polygonIndex.binSize;
    return `${Math.floor((lon + 180) / s)}:${Math.floor((lat + 90) / s)}`;
}

function lookupTimezoneAt(lon, lat) {
    const normalizedLon = normalizeLon(lon);
    const candidateIds = polygonIndex.bins.get(toBin(normalizedLon, lat));
    if (!candidateIds || candidateIds.length === 0) return null;

    for (const id of candidateIds) {
        const poly = polygonIndex.polygons[id];
        if (!inBBox(normalizedLon, lat, poly.bbox)) continue;
        if (!pointInRing(normalizedLon, lat, poly.outer)) continue;

        let inHole = false;
        for (const hole of poly.holes) {
            if (pointInRing(normalizedLon, lat, hole)) {
                inHole = true;
                break;
            }
        }
        if (!inHole) return poly;
    }

    return null;
}

function mismatchToColor(diffHours) {
    const d = clamp(diffHours, -2, 2);
    const lerp = (a, b, t) => Math.round(a + (b - a) * t);
    const vividRed = [255, 20, 20];
    const white = [255, 255, 255];
    const vividGreen = [0, 220, 80];

    if (d <= 0) {
        const t = (d + 2) / 2;
        return [
            lerp(vividGreen[0], white[0], t),
            lerp(vividGreen[1], white[1], t),
            lerp(vividGreen[2], white[2], t),
        ];
    }

    const t = d / 2;
    return [
        lerp(white[0], vividRed[0], t),
        lerp(white[1], vividRed[1], t),
        lerp(white[2], vividRed[2], t),
    ];
}

function tilePixelToLonLat(z, x, y, px, py, tileSize) {
    const n = 2 ** z;
    const worldX = x + (px + 0.5) / tileSize;
    const worldY = y + (py + 0.5) / tileSize;
    const lon = (worldX / n) * 360 - 180;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * worldY) / n)));
    return [normalizeLon(lon), latRad * (180 / Math.PI)];
}

function getCachedTile(key) {
    const value = tileCache.get(key);
    if (!value) return null;
    tileCache.delete(key);
    tileCache.set(key, value);
    return value;
}

function setCachedTile(key, value) {
    if (tileCache.has(key)) tileCache.delete(key);
    tileCache.set(key, value);
    if (tileCache.size > MAX_CACHE_ENTRIES) {
        const oldestKey = tileCache.keys().next().value;
        tileCache.delete(oldestKey);
    }
}

async function renderTile(z, x, y, dayKey, generation) {
    const sample = sampleForZoom(z);
    const cacheKey = `${dayKey}:${sample}:${z}/${x}/${y}`;
    const cached = getCachedTile(cacheKey);
    if (cached) return cached;

    if (typeof OffscreenCanvas === 'undefined') {
        throw new Error('OffscreenCanvas is not available in this browser worker');
    }

    const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
    const ctx = canvas.getContext('2d');
    const lowCanvas = new OffscreenCanvas(sample, sample);
    const lowCtx = lowCanvas.getContext('2d');
    const image = lowCtx.createImageData(sample, sample);
    const now = new Date(`${dayKey}T12:00:00Z`);

    for (let py = 0; py < sample; py++) {
        if (generation < minGeneration) return null;
        for (let px = 0; px < sample; px++) {
            const [lon, lat] = tilePixelToLonLat(z, x, y, px, py, sample);
            const tz = lookupTimezoneAt(lon, lat);
            const civil = tz ? tz.civil : Math.round(lon / 15);
            const diff = civil - solarOffset(lon, now);
            const [r, g, b] = mismatchToColor(diff);

            const i = (py * sample + px) * 4;
            image.data[i] = r;
            image.data[i + 1] = g;
            image.data[i + 2] = b;
            image.data[i + 3] = 220;
        }
    }

    lowCtx.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(lowCanvas, 0, 0, TILE_SIZE, TILE_SIZE);

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const buffer = await blob.arrayBuffer();
    setCachedTile(cacheKey, buffer);
    return buffer;
}

self.onmessage = async event => {
    const msg = event.data;

    if (msg?.type === 'cancel-before-generation') {
        minGeneration = Math.max(minGeneration, msg.generation || 0);
        return;
    }

    if (msg?.type === 'init') {
        const payload = msg.payload;
        polygonIndex = {
            binSize: payload.binSize || 5,
            polygons: payload.polygons || [],
            bins: new Map(payload.binsEntries || []),
        };
        return;
    }

    if (msg?.type === 'render-tile') {
        if (!polygonIndex) {
            self.postMessage({
                type: 'error',
                requestId: msg.requestId,
                error: 'Worker not initialized',
            });
            return;
        }

        if ((msg.generation || 0) < minGeneration) {
            self.postMessage({
                type: 'canceled',
                requestId: msg.requestId,
            });
            return;
        }

        try {
            const buffer = await renderTile(msg.z, msg.x, msg.y, msg.dayKey, msg.generation || 0);
            if (!buffer) {
                self.postMessage({
                    type: 'canceled',
                    requestId: msg.requestId,
                });
                return;
            }
            self.postMessage({
                type: 'tile',
                requestId: msg.requestId,
                buffer,
            });
        } catch (error) {
            self.postMessage({
                type: 'error',
                requestId: msg.requestId,
                error: error?.message || 'Unknown worker error',
            });
        }
    }
};



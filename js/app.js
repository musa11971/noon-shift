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

function civilOffset(tzid) {
    try {
        const parts = Intl.DateTimeFormat('en', {
            timeZone: tzid,
            timeZoneName: 'shortOffset',
        }).formatToParts(new Date());
        const tz = parts.find(p => p.type === 'timeZoneName')?.value ?? '';
        if (tz === 'GMT') return 0;
        const m = tz.match(/GMT([+-])(\d+)(?::(\d+))?/);
        if (!m) return null;
        const sign = m[1] === '+' ? 1 : -1;
        return sign * (parseInt(m[2], 10) + parseInt(m[3] ?? '0', 10) / 60);
    } catch {
        return null;
    }
}

function formatHmFromOffset(now, offsetHours) {
    const shifted = new Date(now.getTime() + offsetHours * 3600000);
    const hh = String(shifted.getUTCHours()).padStart(2, '0');
    const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

function formatDiff(diffHours) {
    const abs = Math.abs(diffHours);
    if (abs < 5 / 60) return 'clock matches solar time';
    const h = Math.floor(abs);
    const m = Math.round((abs - h) * 60);
    const hm = [h ? `${h}h` : '', m ? `${m}m` : ''].filter(Boolean).join(' ');
    return `clock is ${hm} ${diffHours > 0 ? 'ahead of' : 'behind'} solar time`;
}

function ringBBox(ring) {
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const p of ring) {
        const lon = p[0], lat = p[1];
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
    }
    return [minLon, minLat, maxLon, maxLat];
}

function inBBox(lon, lat, bbox) {
    return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

function pointInRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        const intersects = ((yi > lat) !== (yj > lat)) &&
            (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi);
        if (intersects) inside = !inside;
    }
    return inside;
}

function buildPolygonIndex(tzData) {
    const BIN = 5;
    const toBin = (lon, lat) => `${Math.floor((lon + 180) / BIN)}:${Math.floor((lat + 90) / BIN)}`;
    const offsetCache = new Map();
    const polygons = [];
    const bins = new Map();

    for (const f of tzData.features) {
        const p = f.properties || {};
        const tzid = p.tz_name1st || null;

        let civil = null;
        if (tzid) {
            if (!offsetCache.has(tzid)) offsetCache.set(tzid, civilOffset(tzid));
            civil = offsetCache.get(tzid);
        }
        if (civil === null && p.zone != null) civil = parseFloat(p.zone);
        if (civil === null || !f.geometry) continue;

        const pushPolygon = (coords) => {
            if (!coords?.length || !coords[0]?.length) return;
            const bbox = ringBBox(coords[0]);
            const poly = {
                id: polygons.length,
                bbox,
                outer: coords[0],
                holes: coords.slice(1),
                tzid,
                civil,
                utcFormat: p.utc_format || '',
            };
            polygons.push(poly);

            const x0 = Math.floor((bbox[0] + 180) / BIN);
            const x1 = Math.floor((bbox[2] + 180) / BIN);
            const y0 = Math.floor((bbox[1] + 90) / BIN);
            const y1 = Math.floor((bbox[3] + 90) / BIN);
            for (let x = x0; x <= x1; x++) {
                for (let y = y0; y <= y1; y++) {
                    const key = `${x}:${y}`;
                    if (!bins.has(key)) bins.set(key, []);
                    bins.get(key).push(poly.id);
                }
            }
        };

        if (f.geometry.type === 'Polygon') {
            pushPolygon(f.geometry.coordinates);
        } else if (f.geometry.type === 'MultiPolygon') {
            for (const polygon of f.geometry.coordinates) pushPolygon(polygon);
        }
    }

    return { polygons, bins, toBin };
}

function lookupTimezoneAt(lon, lat, polygonIndex) {
    const normalizedLon = normalizeLon(lon);
    const candidateIds = polygonIndex.bins.get(polygonIndex.toBin(normalizedLon, lat));
    if (!candidateIds?.length) return null;

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

const map = new maplibregl.Map({
    style: 'https://tiles.openfreemap.org/styles/positron',
    center: [13, 25],
    zoom: 2,
    maxZoom: 10,
    container: 'map',
    attributionControl: false,
});
map.dragRotate.disable();
map.keyboard.disable();
map.touchZoomRotate.disableRotation();

const infoBar = document.getElementById('info-bar');
const loading = document.getElementById('loading');

function normalizeLon(lon) {
    let x = lon;
    while (x < -180) x += 360;
    while (x > 180) x -= 360;
    return x;
}

function serializePolygonIndex(polygonIndex) {
    return {
        binSize: 5,
        polygons: polygonIndex.polygons,
        binsEntries: Array.from(polygonIndex.bins.entries()),
    };
}

function createSolarTileWorkerClient(polygonIndex) {
    const cpuCount = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    const workerCount = Math.max(2, Math.min(4, cpuCount - 1));
    const workers = [];
    let requestSeq = 0;

    const indexPayload = serializePolygonIndex(polygonIndex);
    for (let i = 0; i < workerCount; i++) {
        const w = new Worker('/js/solar-tile-worker.js');
        const state = { worker: w, pending: new Map(), active: 0 };

        w.onmessage = event => {
            const msg = event.data;
            const req = state.pending.get(msg?.requestId);
            if (!req) return;

            state.pending.delete(msg.requestId);
            state.active = Math.max(0, state.active - 1);

            if (msg?.type === 'tile') {
                req.resolve({ data: msg.buffer });
                return;
            }
            if (msg?.type === 'canceled') {
                req.reject(new Error('Tile request canceled'));
                return;
            }
            req.reject(new Error(msg?.error || 'Worker tile render failed'));
        };

        w.onerror = event => {
            const err = new Error(event.message || 'Worker failed');
            for (const req of state.pending.values()) req.reject(err);
            state.pending.clear();
            state.active = 0;
        };

        w.postMessage({ type: 'init', payload: indexPayload });
        workers.push(state);
    }

    const pickWorker = () => {
        let best = workers[0];
        for (let i = 1; i < workers.length; i++) {
            if (workers[i].active < best.active) best = workers[i];
        }
        return best;
    };

    const requestTile = (z, x, y, dayKey, generation) => new Promise((resolve, reject) => {
        requestSeq += 1;
        const requestId = requestSeq;
        const target = pickWorker();
        target.pending.set(requestId, { resolve, reject });
        target.active += 1;
        target.worker.postMessage({
            type: 'render-tile',
            requestId,
            z,
            x,
            y,
            dayKey,
            generation,
        });
    });

    const cancelBeforeGeneration = generation => {
        for (const s of workers) {
            s.worker.postMessage({ type: 'cancel-before-generation', generation });
        }
    };

    return { requestTile, cancelBeforeGeneration };
}

function installSolarTileProtocol(polygonIndex) {
    const workerClient = createSolarTileWorkerClient(polygonIndex);
    const inFlight = new Map();
    let generation = 0;

    const advanceGeneration = () => {
        generation += 1;
        inFlight.clear();
        workerClient.cancelBeforeGeneration(generation);
    };

    map.on('movestart', advanceGeneration);
    map.on('zoomstart', advanceGeneration);

    maplibregl.addProtocol('solar', async params => {
        const match = params.url.match(/^solar:\/\/(\d+)\/(\d+)\/(\d+)\.png$/);
        if (!match) throw new Error(`Invalid solar tile URL: ${params.url}`);

        const z = parseInt(match[1], 10);
        const x = parseInt(match[2], 10);
        const y = parseInt(match[3], 10);
        const dayKey = new Date().toISOString().slice(0, 10);
        const key = `${generation}:${dayKey}:${z}/${x}/${y}`;

        if (inFlight.has(key)) return inFlight.get(key);

        const promise = workerClient
            .requestTile(z, x, y, dayKey, generation)
            .finally(() => inFlight.delete(key));
        inFlight.set(key, promise);
        return promise;
    });
}

map.on('load', async () => {
    const res = await fetch(
        '/js/ne_10m_time_zones.geojson'
    );
    const tzData = await res.json();
    const polygonIndex = buildPolygonIndex(tzData);
    installSolarTileProtocol(polygonIndex);

    const insertBefore = map.getStyle().layers.find(l => l.type === 'symbol')?.id;

    map.addSource('solar-heat', {
        type: 'raster',
        tiles: ['solar://{z}/{x}/{y}.png'],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 10,
    });

    map.addSource('timezone-borders', {
        type: 'geojson',
        data: tzData,
    });

    map.addLayer({
        id: 'solar-heat-layer',
        type: 'raster',
        source: 'solar-heat',
        paint: {
            'raster-opacity': 0.86,
            'raster-resampling': 'linear',
        },
    }, insertBefore);

    map.addLayer({
        id: 'timezone-border-casing',
        type: 'line',
        source: 'timezone-borders',
        layout: {
            'line-cap': 'round',
            'line-join': 'round',
        },
        paint: {
            'line-color': 'rgba(255, 255, 255, 0.45)',
            'line-width': [
                'interpolate', ['linear'], ['zoom'],
                0, 0.5,
                3, 0.8,
                6, 1.2,
                10, 1.8,
            ],
            'line-blur': 0.3,
        },
    }, insertBefore);

    map.addLayer({
        id: 'timezone-border-line',
        type: 'line',
        source: 'timezone-borders',
        layout: {
            'line-cap': 'round',
            'line-join': 'round',
        },
        paint: {
            'line-color': 'rgba(20, 24, 32, 0.55)',
            'line-width': [
                'interpolate', ['linear'], ['zoom'],
                0, 0.2,
                3, 0.35,
                6, 0.65,
                10, 1.0,
            ],
        },
    }, insertBefore);

    loading.remove();

    let rafPending = false;
    let lastEvent = null;

    const refreshInfo = () => {
        rafPending = false;
        if (!lastEvent) return;

        const lon = lastEvent.lngLat.lng;
        const lat = lastEvent.lngLat.lat;
        const nowLocal = new Date();

        const match = lookupTimezoneAt(lon, lat, polygonIndex);
        const civil = match?.civil ?? Math.round(lon / 15);
        const solar = solarOffset(lon, nowLocal);
        const diff = civil - solar;

        const clockTime = formatHmFromOffset(nowLocal, civil);
        const solarTime = formatHmFromOffset(nowLocal, solar);
        const zone = match?.tzid || match?.utcFormat || 'UTC offset by longitude';

        infoBar.textContent =
            `${zone} · clock ${clockTime} · solar ${solarTime} · ${formatDiff(diff)}`;
        infoBar.classList.add('visible');
        map.getCanvas().style.cursor = 'crosshair';
    };

    map.on('mousemove', e => {
        lastEvent = e;
        if (!rafPending) {
            rafPending = true;
            requestAnimationFrame(refreshInfo);
        }
    });

    map.on('mouseleave', () => {
        map.getCanvas().style.cursor = '';
        infoBar.classList.remove('visible');
    });
});
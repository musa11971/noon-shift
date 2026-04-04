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

function civilOffset(tzid, date = new Date()) {
    try {
        const parts = Intl.DateTimeFormat('en', {
            timeZone: tzid,
            timeZoneName: 'shortOffset',
        }).formatToParts(date);
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

function formatHmFromMinutes(totalMinutes) {
    const minutesInDay = 24 * 60;
    let minutes = Math.round(totalMinutes) % minutesInDay;
    if (minutes < 0) minutes += minutesInDay;
    const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
    const mm = String(minutes % 60).padStart(2, '0');
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

function formatUtcOffset(offsetHours) {
    const sign = offsetHours >= 0 ? '+' : '-';
    const abs = Math.abs(offsetHours);
    const h = Math.floor(abs);
    const m = Math.round((abs - h) * 60);
    return `UTC${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function timePartsFromOffset(now, offsetHours) {
    const shifted = new Date(now.getTime() + offsetHours * 3600000);
    return {
        hours: shifted.getUTCHours(),
        minutes: shifted.getUTCMinutes(),
    };
}

function handAnglesFromParts(parts) {
    const hourAngle = (parts.hours % 12 + parts.minutes / 60) * 30;
    const minuteAngle = parts.minutes * 6;
    return { hourAngle, minuteAngle };
}

function handTransform(angle) {
    // Offset by -90deg because 0deg points to the right; 12 o'clock should point up.
    return `translate(0, -50%) rotate(${angle - 90}deg)`;
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
const sidebar = document.getElementById('sidebar');
const sidebarClose = document.getElementById('sidebar-close');
const sidebarTitle = document.getElementById('sidebar-title');
const sidebarBody = document.getElementById('sidebar-body');
const drawerHandle = document.getElementById('drawer-handle');
const legendAboutButton = document.getElementById('legend-about');
let activeMarker = null;
let drawerStartY = null;
let drawerLastY = null;
let drawerDragActive = false;
let drawerStartScrollTop = 0;
let lastSharedCoords = null;

const shareMessageForUrl = url =>
    `Check out this location on Noon Shift: clock time vs. solar time ${url}`;

const buildLocationUrl = (lat, lon) => {
    const url = new URL(window.location.href);
    url.searchParams.set('lat', lat.toFixed(5));
    url.searchParams.set('lon', lon.toFixed(5));
    return url.toString();
};

const updateUrlFromCoords = (lat, lon) => {
    const url = new URL(window.location.href);
    url.searchParams.set('lat', lat.toFixed(5));
    url.searchParams.set('lon', lon.toFixed(5));
    history.replaceState(null, '', url.toString());
};

const clearUrlCoords = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('lat');
    url.searchParams.delete('lon');
    history.replaceState(null, '', url.toString());
};

const parseCoordsFromUrl = () => {
    const params = new URLSearchParams(window.location.search);
    const lat = parseFloat(params.get('lat'));
    const lon = parseFloat(params.get('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon };
};

const getShareElements = () => ({
    buttons: Array.from(sidebarBody.querySelectorAll('[data-share]')),
    copyButton: sidebarBody.querySelector('#share-copy'),
});

const setShareEnabled = (enabled, elements = getShareElements()) => {
    const { buttons, copyButton } = elements;
    if (!buttons.length && !copyButton) return;
    const toggle = (el, isEnabled) => {
        if (isEnabled) {
            el.classList.remove('disabled');
            el.removeAttribute('aria-disabled');
        } else {
            el.classList.add('disabled');
            el.setAttribute('aria-disabled', 'true');
            if (el.tagName === 'A') el.removeAttribute('href');
        }
    };
    buttons.forEach(btn => toggle(btn, enabled));
    if (copyButton) toggle(copyButton, enabled);
};

const updateShareLinks = (lat, lon, elements = getShareElements()) => {
    const { buttons, copyButton } = elements;
    if (!buttons.length && !copyButton) return;
    const locationUrl = buildLocationUrl(lat, lon);
    const message = shareMessageForUrl(locationUrl);

    buttons.forEach(button => {
        const network = button.dataset.share;
        let href = locationUrl;
        if (network === 'x') {
            href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(message)}`;
        } else if (network === 'whatsapp') {
            href = `whatsapp://send?text=${encodeURIComponent(message)}`;
        }
        button.setAttribute('href', href);
    });

    if (copyButton) {
        copyButton.dataset.shareMessage = message;
        if (!copyButton.dataset.bound) {
            copyButton.dataset.bound = 'true';
            copyButton.addEventListener('click', async () => {
                const text = copyButton.dataset.shareMessage || locationUrl;
                await navigator.clipboard.writeText(text);
            });
        }
    }
    setShareEnabled(true, elements);
    lastSharedCoords = { lat, lon };
};

setShareEnabled(false);

const isMobileDrawer = () => window.matchMedia('(max-width: 720px)').matches;

const enableMapInteractions = () => {
    map.dragPan.enable();
    map.scrollZoom.enable();
    map.doubleClickZoom.enable();
    map.boxZoom.enable();
    map.touchZoomRotate.enable();
    map.touchZoomRotate.disableRotation();
};

const disableMapInteractions = () => {
    map.dragPan.disable();
    map.scrollZoom.disable();
    map.doubleClickZoom.disable();
    map.boxZoom.disable();
    map.touchZoomRotate.disable();
};

const syncDrawerInteractivity = () => {
    if (!isMobileDrawer()) {
        enableMapInteractions();
        return;
    }
    if (sidebar.classList.contains('open') && sidebar.classList.contains('drawer-expanded')) {
        disableMapInteractions();
    } else {
        enableMapInteractions();
    }
};

const setDrawerState = state => {
    sidebar.classList.remove('drawer-expanded', 'drawer-collapsed');
    if (state) sidebar.classList.add(state);
    syncDrawerInteractivity();
};

const toggleDrawer = () => {
    if (!isMobileDrawer()) return;
    if (!sidebar.classList.contains('open')) return;
    if (sidebar.classList.contains('drawer-expanded')) {
        setDrawerState('drawer-collapsed');
    } else {
        setDrawerState('drawer-expanded');
    }
};

const updateSidebarBody = html => {
    const shouldAnimate = sidebar.classList.contains('open') && sidebarBody.innerHTML.trim() !== '';
    if (!shouldAnimate) {
        sidebarBody.innerHTML = html;
        return;
    }

    sidebarBody.classList.add('is-updating');
    window.setTimeout(() => {
        sidebarBody.innerHTML = html;
        requestAnimationFrame(() => sidebarBody.classList.remove('is-updating'));
    }, 120);
};

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
        const w = new Worker('js/solar-tile-worker.js');
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
        'js/ne_10m_time_zones.geojson'
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

    const openAboutSidebar = () => {
        sidebarTitle.textContent = '☀️ About Noon Shift';

        const aboutHtml = `
            <div class="about">
                <p>Noon Shift compares clock time to local solar time and visualises it on a map.</p>
                
                <h4>How it works</h4>
                <p>The map colors reflect how far local clock time is ahead or behind solar time. Click anywhere to see more details on that specific region.</p>
                
                <h4>Why it changes</h4>
                <p>Time zones are defined by borders, politics, and daylight-saving rules, not just longitude. That is why two places at the same longitude can still show different offsets.</p>
                
                <h4>Support the project</h4>
                <p>If you enjoy Noon Shift, you can check out and star the project on <a href="https://github.com/musa11971/noon-shift" target="_blank">GitHub</a>, or support me with a small donation.</p>
                <a href="https://paypal.me/musa11971" target="_blank">
                    <img src="img/donate.png" alt="Donate through PayPal" style="max-width: 50%" />
                </a>
            </div>
        `;

        updateSidebarBody(aboutHtml);
        sidebar.classList.add('open');
        if (isMobileDrawer()) setDrawerState('drawer-collapsed');

        if (activeMarker) {
            activeMarker.remove();
            activeMarker = null;
        }
        clearUrlCoords();
        lastSharedCoords = null;
        setShareEnabled(false);
        return true;
    };

    const openSidebarAt = (lon, lat, options = {}) => {
        const nowLocal = new Date();
        const match = lookupTimezoneAt(lon, lat, polygonIndex);
        if (!match) return false;

        const civil = match.civil;
        const solar = solarOffset(lon, nowLocal);
        const diff = civil - solar;
        const diffMinutes = Math.round(diff * 60);
        const trueNoonTime = formatHmFromMinutes(12 * 60 + diffMinutes);
        const clockParts = timePartsFromOffset(nowLocal, civil);
        const solarParts = timePartsFromOffset(nowLocal, solar);
        const clockAngles = handAnglesFromParts(clockParts);
        const solarAngles = handAnglesFromParts(solarParts);

        const isDst = (() => {
            try {
                const year = nowLocal.getFullYear();
                const jan = new Date(year, 0, 1);
                const jul = new Date(year, 6, 1);
                const janOffset = civilOffset(match.tzid, jan);
                const julOffset = civilOffset(match.tzid, jul);
                return janOffset !== julOffset;
            } catch {
                return false;
            }
        })();

        const zoneLabel = match.tzid || match.utcFormat || 'Local solar region';
        sidebarTitle.textContent = 'Marker location';

        const gaugeRangeMinutes = 120;
        const clampedMinutes = Math.max(-gaugeRangeMinutes, Math.min(gaugeRangeMinutes, diffMinutes));
        const gaugePercent = ((clampedMinutes + gaugeRangeMinutes) / (2 * gaugeRangeMinutes)) * 100;

        let bodyHtml = `
            <div class="time-visual">
                <div class="clock-block">
                    <div class="clock-face">
                        <div class="clock-hand hour" style="transform: ${handTransform(clockAngles.hourAngle)};"></div>
                        <div class="clock-hand minute" style="transform: ${handTransform(clockAngles.minuteAngle)};"></div>
                        <div class="clock-center"></div>
                    </div>
                    <div class="clock-caption">Clock time</div>
                    <div class="clock-time">${formatHmFromOffset(nowLocal, civil)}</div>
                    <div class="clock-sub">${formatUtcOffset(civil)}</div>
                </div>
                <div class="clock-block">
                    <div class="clock-face solar">
                        <div class="clock-hand hour" style="transform: ${handTransform(solarAngles.hourAngle)};"></div>
                        <div class="clock-hand minute" style="transform: ${handTransform(solarAngles.minuteAngle)};"></div>
                        <div class="clock-center"></div>
                    </div>
                    <div class="clock-caption">Solar time</div>
                    <div class="clock-time">${formatHmFromOffset(nowLocal, solar)}</div>
                    <div class="clock-sub">sun-based</div>
                </div>
            </div>
            <div class="delta-gauge">
                <div class="delta-track"></div>
                <div class="delta-center"></div>
                <div class="delta-marker" style="left: ${gaugePercent}%;"></div>
                <div class="delta-labels"><span>-2h</span><span>0</span><span>+2h</span></div>
                <div class="delta-caption">${formatDiff(diff)}</div>
            </div>
        `;

        const addRow = (label, value) => {
            bodyHtml += `<div class="data-row"><span class="data-label">${label}</span><span class="data-value">${value}</span></div>`;
        };

        addRow('Timezone', zoneLabel);
        addRow('Latitude', `${lat.toFixed(2)}°`);
        addRow('Longitude', `${lon.toFixed(2)}°`);
        addRow('True Noon Time', trueNoonTime);
        addRow('Clock Offset', formatUtcOffset(civil));
        addRow('DST Observed', isDst ? 'Yes' : 'No');

        let explanation = '';
        if (Math.abs(diff) > 0.5) {
            if (diff > 0) {
                explanation = 'Clock time runs ahead of the sun here. That pushes daylight later into the evening, so sunsets tend to feel late.';
            } else {
                explanation = 'The sun leads the clock here. That pulls daylight earlier into the morning, so sunrises arrive sooner.';
            }
        } else {
            explanation = 'Clock time and solar time are closely aligned here. Local noon happens near 12:00 on the clock.';
        }
        if (isDst) {
            explanation += ' This region also shifts its clocks seasonally, which can add another hour of offset part of the year.';
        }
        bodyHtml += `<div class="explanation">${explanation}</div>`;
        bodyHtml += `
            <div class="share-section no-select">
                <div class="share-title">Share</div>
                <div class="share-buttons">
                    <a class="share-btn" data-share="x" target="_blank" rel="noopener">X</a>
                    <a class="share-btn" data-share="whatsapp" target="_blank" rel="noopener">WhatsApp</a>
                    <button class="share-btn" id="share-copy" type="button">Copy link</button>
                </div>
            </div>
        `;

        updateSidebarBody(bodyHtml);
        sidebar.classList.add('open');
        if (isMobileDrawer()) setDrawerState('drawer-collapsed');

        if (!activeMarker) {
            activeMarker = new maplibregl.Marker({ color: '#1c2430' })
                .setLngLat([lon, lat])
                .addTo(map);
        } else {
            activeMarker.setLngLat([lon, lat]);
        }

        updateShareLinks(lat, lon);
        if (options.updateUrl !== false) {
            updateUrlFromCoords(lat, lon);
        }
        return true;
    };

    map.on('click', e => {
        openSidebarAt(e.lngLat.lng, e.lngLat.lat);
    });

    const closeSidebar = () => {
        sidebar.classList.remove('open');
        setDrawerState(null);
        if (activeMarker) {
            activeMarker.remove();
            activeMarker = null;
        }
        clearUrlCoords();
        lastSharedCoords = null;
        setShareEnabled(false);
        syncDrawerInteractivity();
    };

    sidebarClose.onclick = closeSidebar;

    if (drawerHandle) {
        drawerHandle.addEventListener('click', toggleDrawer);
    }

    if (legendAboutButton) {
        legendAboutButton.addEventListener('click', () => {
            openAboutSidebar();
        });
    }

    sidebar.addEventListener('touchstart', event => {
        if (!isMobileDrawer()) return;
        if (!event.touches?.length) return;
        drawerStartY = event.touches[0].clientY;
        drawerLastY = drawerStartY;
        drawerStartScrollTop = sidebar.scrollTop;
        drawerDragActive = sidebar.classList.contains('drawer-collapsed') ||
            !!event.target.closest('#drawer-handle, .sidebar-header');
        if (sidebar.classList.contains('open')) event.stopPropagation();
    }, { passive: false });

    sidebar.addEventListener('touchmove', event => {
        if (!isMobileDrawer()) return;
        if (!event.touches?.length) return;
        if (sidebar.classList.contains('open')) event.stopPropagation();
        drawerLastY = event.touches[0].clientY;
        if (!drawerDragActive && sidebar.classList.contains('drawer-expanded') && drawerStartScrollTop <= 0) {
            if (drawerLastY - drawerStartY > 6) {
                drawerDragActive = true;
            }
        }
        if (drawerDragActive) {
            event.preventDefault();
        }
    }, { passive: false });

    sidebar.addEventListener('touchend', () => {
        if (!isMobileDrawer()) return;
        if (drawerStartY === null || drawerLastY === null) return;
        const delta = drawerLastY - drawerStartY;
        const threshold = 50;

        if (drawerDragActive) {
            if (delta < -threshold) {
                setDrawerState('drawer-expanded');
            } else if (delta > threshold) {
                if (sidebar.classList.contains('drawer-expanded')) {
                    setDrawerState('drawer-collapsed');
                } else {
                    closeSidebar();
                }
            }
        }
        drawerStartY = null;
        drawerLastY = null;
        drawerDragActive = false;
        drawerStartScrollTop = 0;
    });

    const urlCoords = parseCoordsFromUrl();
    if (urlCoords) {
        const { lat, lon } = urlCoords;
        map.setCenter([lon, lat]);
        map.setZoom(6);
        openSidebarAt(lon, lat, { updateUrl: false });
    }
    else {
        openAboutSidebar();
    }
});


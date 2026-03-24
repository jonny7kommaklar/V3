const state = {
  data: null,
  map: null,
  markerLayer: null,
  drawItems: null,
  activeSpotId: null,
  filters: { search: '', layer: 'all', plannedDay: 'all', hasImage: false },
  addPinMode: false,
  areaVisibility: {},
  areaFilter: {},
  saveTimer: null,
  syncTimer: null,
  realtimeChannel: null,
  supabase: null,
  user: null,
  authReady: false,
  backendEnabled: false,
  authError: '',
  storageBucket: 'spot-images',
  saving: false,
  dragging: {},
  localMode: false,
  mobile: false,
  editorOpen: false,
  editorDirty: false,
  showLabels: true,
  hoveredSpotId: null,
  routeLayer: null,
  legendOpen: false,
  routeSettings: { selectedDay: 'all', colors: {}, visible: {} },
  userLocationMarker: null,
  userAccuracyCircle: null,
  userWatchId: null,
  firstLocationFix: true,
};

const LOCAL_STORAGE_KEY = 'pragmap-local-data-v1';
const UI_SETTINGS_KEY = 'pragmap-ui-settings-v2';


function loadUiSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(UI_SETTINGS_KEY) || '{}');
    state.showLabels = raw.showLabels !== false;
    state.legendOpen = !!raw.legendOpen;
    state.routeSettings = {
      selectedDay: raw.routeSettings?.selectedDay || 'all',
      colors: raw.routeSettings?.colors || {},
      visible: raw.routeSettings?.visible || {},
    };
  } catch {}
}
function saveUiSettings() {
  localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify({
    showLabels: state.showLabels,
    legendOpen: state.legendOpen,
    routeSettings: state.routeSettings,
  }));
}
function getDayRouteOrder(day) {
  const key = `routeOrder:${day}`;
  try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
}
function setDayRouteOrder(day, order) {
  localStorage.setItem(`routeOrder:${day}`, JSON.stringify(order.map(Number)));
}
function orderedDaySpots(day) {
  const spots = (state.data?.spots || []).filter(s => (s.plannedDay || '').trim() === day);
  const order = getDayRouteOrder(day);
  const rank = new Map(order.map((id, i) => [Number(id), i]));
  return [...spots].sort((a,b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : 999999 + a.id;
    const rb = rank.has(b.id) ? rank.get(b.id) : 999999 + b.id;
    return ra - rb;
  });
}
function syncDayRouteOrders() {
  for (const day of (state.data?.meta?.days || [])) {
    const ids = orderedDaySpots(day).map(s => s.id);
    setDayRouteOrder(day, ids);
    if (!(day in state.routeSettings.visible)) state.routeSettings.visible[day] = false;
    if (!(day in state.routeSettings.colors)) state.routeSettings.colors[day] = '#ef4444';
  }
  saveUiSettings();
}
function routeDaysToRender() {
  const days = new Set();
  for (const [day, visible] of Object.entries(state.routeSettings.visible || {})) if (visible) days.add(day);
  if (state.routeSettings.selectedDay && state.routeSettings.selectedDay !== 'all') days.add(state.routeSettings.selectedDay);
  return [...days];
}
function renderLegend() {
  document.querySelectorAll('[data-role="legend-box"]').forEach(box => {
    if (!state.legendOpen) { box.innerHTML=''; box.style.display='none'; return; }
    const rows = (state.data?.layers || []).filter(l => l.showInLegend).map(l => `<div class="legend-row"><span class="legend-swatch" style="background:${escapeHtml(l.color)}"></span>${escapeHtml(l.name)}</div>`).join('');
    box.style.display='block';
    box.innerHTML = rows || '<div class="small-note">Keine Layer markiert.</div>';
  });
}

function escapeHtml(s) {
  return (s ?? '').toString().replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function slugify(str) {
  return (str || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase();
}
function randomId(prefix = 'id') {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}
function getConfig() {
  return window.PRAGMAP_CONFIG || {};
}
function isBackendConfigured() {
  const cfg = getConfig();
  return !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase);
}
function canEdit() {
  if (!state.backendEnabled) return true;
  return !!state.user;
}
function setStatus(msg, isError = false) {
  document.querySelectorAll('[data-role="status"]').forEach(el => {
    el.textContent = msg;
    el.style.color = isError ? '#b91c1c' : '';
  });
}
function normalizeData(data) {
  const out = data || {};
  out.meta = out.meta || { title: 'PragMap' };
  out.meta.days = Array.isArray(out.meta.days) ? out.meta.days : [];
  out.layers = Array.isArray(out.layers) && out.layers.length ? out.layers : [{ id: 'default', name: 'Standard', color: '#0f766e', size: 10, opacity: 0.88, visible: true, sortOrder: 0 }];
  out.areas = Array.isArray(out.areas) ? out.areas : [];
  out.spots = Array.isArray(out.spots) ? out.spots : [];

  out.layers = out.layers.map((l, i) => ({
    id: l.id || randomId('layer'),
    name: l.name || `Layer ${i + 1}`,
    color: l.color || '#0f766e',
    size: Number(l.size ?? 10),
    opacity: Number(l.opacity ?? 0.88),
    visible: l.visible !== false,
    sortOrder: Number(l.sortOrder ?? l.sort_order ?? i),
    showInLegend: !!(l.showInLegend ?? l.show_in_legend),
  })).sort((a, b) => a.sortOrder - b.sortOrder);

  out.areas = out.areas.map((a, i) => ({
    id: a.id || randomId('area'),
    name: a.name || `Bereich ${i + 1}`,
    color: a.color || '#2563eb',
    weight: Number(a.weight ?? 2),
    visible: a.visible !== false,
    useForFilter: !!(a.useForFilter ?? a.use_for_filter),
    geojson: a.geojson || null,
  }));

  out.spots = out.spots.map((s, i) => ({
    id: Number(s.id ?? i + 1),
    name: s.name || 'Neuer Spot',
    lat: Number(s.lat),
    lon: Number(s.lon),
    image: s.image || '',
    imageFile: s.imageFile || s.image_file || '',
    manualImageFile: s.manualImageFile || s.manual_image_file || '',
    plannedDay: s.plannedDay || s.planned_day || '',
    location: s.location || '',
    comment: s.comment || '',
    area: s.area || '',
    googleMaps: s.googleMaps || s.google_maps || '',
    layerId: s.layerId || s.layer_id || out.layers[0]?.id || 'default',
    secondaryLayerIds: Array.isArray(s.secondaryLayerIds) ? s.secondaryLayerIds : (Array.isArray(s.secondary_layer_ids) ? s.secondary_layer_ids : []),
  }));

  for (const area of out.areas) {
    if (!(area.id in state.areaVisibility)) state.areaVisibility[area.id] = area.visible !== false;
    if (!(area.id in state.areaFilter)) state.areaFilter[area.id] = !!area.useForFilter;
  }
  const daysFromSpots = [...new Set(out.spots.map(s => (s.plannedDay || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  out.meta.days = [...new Set([...(out.meta.days || []), ...daysFromSpots])].sort((a, b) => a.localeCompare(b, 'de'));
  return out;
}

async function initBackend() {
  if (!isBackendConfigured()) {
    state.backendEnabled = false;
    state.localMode = true;
    state.authReady = true;
    return;
  }
  const cfg = getConfig();
  state.supabase = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  state.storageBucket = cfg.STORAGE_BUCKET || 'spot-images';
  state.backendEnabled = true;

  try {
    const { data: { session }, error } = await state.supabase.auth.getSession();
    if (error) throw error;
    state.user = session?.user || null;
  } catch (err) {
    console.error(err);
    state.authError = err?.message || 'Auth-Session konnte nicht geladen werden';
  }
  state.authReady = true;
  state.supabase.auth.onAuthStateChange((event, sessionNow) => {
    state.user = sessionNow?.user || null;
    if (event === 'SIGNED_OUT') state.authError = '';
    updateAuthUi();
    renderAll();
  });
}

async function loadData() {
  if (state.backendEnabled) {
    try {
      const [layersRes, areasRes, spotsRes, daysRes] = await Promise.all([
        state.supabase.from('layers').select('*').order('sort_order', { ascending: true }),
        state.supabase.from('areas').select('*').order('created_at', { ascending: true }),
        state.supabase.from('spots').select('*').order('id', { ascending: true }),
        state.supabase.from('days').select('*').order('sort_order', { ascending: true }),
      ]);
      if (layersRes.error) throw layersRes.error;
      if (areasRes.error) throw areasRes.error;
      if (spotsRes.error) throw spotsRes.error;
      if (daysRes.error) throw daysRes.error;

      const remote = {
        meta: { title: 'PragMap', days: (daysRes.data || []).map(d => d.name).filter(Boolean) },
        layers: (layersRes.data || []).map(l => ({
          id: l.id, name: l.name, color: l.color, size: l.size, opacity: Number(l.opacity), visible: l.visible, sortOrder: l.sort_order,
        })),
        areas: (areasRes.data || []).map(a => ({
          id: a.id, name: a.name, color: a.color, weight: a.weight, visible: a.visible, useForFilter: a.use_for_filter, geojson: a.geojson,
        })),
        spots: (spotsRes.data || []).map(s => ({
          id: s.id, name: s.name, lat: s.lat, lon: s.lon, image: s.image, imageFile: s.image_file, manualImageFile: s.manual_image_file,
          plannedDay: s.planned_day, location: s.location, comment: s.comment, area: s.area, googleMaps: s.google_maps,
          layerId: s.layer_id, secondaryLayerIds: s.secondary_layer_ids || [],
        })),
      };

      const hasRemoteData = (remote.layers?.length || 0) + (remote.spots?.length || 0) + (remote.areas?.length || 0) > 0;
      if (hasRemoteData) {
        state.data = normalizeData(remote);
        setStatus('Supabase verbunden');
        return;
      }
    } catch (err) {
      console.error(err);
      setStatus('Supabase-Fehler – lokaler Fallback aktiv', true);
    }
  }

  const localCache = localStorage.getItem(LOCAL_STORAGE_KEY);
  if (localCache) {
    state.data = normalizeData(JSON.parse(localCache));
    state.localMode = true;
    setStatus('Lokaler Modus (Browser-Speicher)');
    return;
  }

  const res = await fetch('./data/data.json');
  state.data = normalizeData(await res.json());
  state.localMode = true;
  setStatus(state.backendEnabled ? 'Supabase leer – lokale Startdaten geladen' : 'Lokaler Modus');
}

function persistLocalData() {
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(state.data));
}

async function debounceSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveData, 450);
}

async function saveData() {
  if (!state.data) return;
  if (!state.backendEnabled) {
    persistLocalData();
    renderAll();
    setStatus('Lokal gespeichert');
    return;
  }
  if (!canEdit()) {
    setStatus('Nur mit Login bearbeitbar', true);
    return;
  }
  if (state.saving) return;

  state.saving = true;
  setStatus('Speichert …');

  try {
    const layers = state.data.layers.map((l, i) => ({
      id: l.id, name: l.name, color: l.color, size: Number(l.size), opacity: Number(l.opacity), visible: l.visible !== false, sort_order: i,
    }));
    const areas = state.data.areas.map(a => ({
      id: a.id, name: a.name, color: a.color, weight: Number(a.weight || 2), visible: a.visible !== false, use_for_filter: !!state.areaFilter[a.id], geojson: a.geojson,
    }));
    const spots = state.data.spots.map(s => ({
      id: Number(s.id), name: s.name || 'Neuer Spot', lat: Number(s.lat), lon: Number(s.lon), image: s.image || '', image_file: s.imageFile || '',
      manual_image_file: s.manualImageFile || '', planned_day: s.plannedDay || '', location: s.location || '', comment: s.comment || '', area: s.area || '',
      google_maps: s.googleMaps || '', layer_id: s.layerId || null, secondary_layer_ids: Array.isArray(s.secondaryLayerIds) ? s.secondaryLayerIds : [],
    }));
    const days = (state.data.meta?.days || []).map((name, i) => ({ id: slugify(name || `day-${i+1}`), name, sort_order: i }));

    const [remoteLayerIdsRes, remoteAreaIdsRes, remoteSpotIdsRes, remoteDayIdsRes] = await Promise.all([
      state.supabase.from('layers').select('id'),
      state.supabase.from('areas').select('id'),
      state.supabase.from('spots').select('id'),
      state.supabase.from('days').select('id'),
    ]);
    if (remoteLayerIdsRes.error) throw remoteLayerIdsRes.error;
    if (remoteAreaIdsRes.error) throw remoteAreaIdsRes.error;
    if (remoteSpotIdsRes.error) throw remoteSpotIdsRes.error;
    if (remoteDayIdsRes.error) throw remoteDayIdsRes.error;

    if (layers.length) {
      const { error } = await state.supabase.from('layers').upsert(layers);
      if (error) throw error;
    }
    if (areas.length) {
      const { error } = await state.supabase.from('areas').upsert(areas);
      if (error) throw error;
    }
    if (spots.length) {
      const { error } = await state.supabase.from('spots').upsert(spots);
      if (error) throw error;
    }
    if (days.length) {
      const { error } = await state.supabase.from('days').upsert(days);
      if (error) throw error;
    }

    const currentLayerIds = new Set(layers.map(x => x.id));
    const currentAreaIds = new Set(areas.map(x => x.id));
    const currentSpotIds = new Set(spots.map(x => Number(x.id)));
    const currentDayIds = new Set(days.map(x => x.id));

    const deleteLayerIds = (remoteLayerIdsRes.data || []).map(x => x.id).filter(id => !currentLayerIds.has(id));
    const deleteAreaIds = (remoteAreaIdsRes.data || []).map(x => x.id).filter(id => !currentAreaIds.has(id));
    const deleteSpotIds = (remoteSpotIdsRes.data || []).map(x => Number(x.id)).filter(id => !currentSpotIds.has(id));
    const deleteDayIds = (remoteDayIdsRes.data || []).map(x => x.id).filter(id => !currentDayIds.has(id));

    if (deleteSpotIds.length) {
      const { error } = await state.supabase.from('spots').delete().in('id', deleteSpotIds);
      if (error) throw error;
    }
    if (deleteAreaIds.length) {
      const { error } = await state.supabase.from('areas').delete().in('id', deleteAreaIds);
      if (error) throw error;
    }
    if (deleteDayIds.length) {
      const { error } = await state.supabase.from('days').delete().in('id', deleteDayIds);
      if (error) throw error;
    }
    if (deleteLayerIds.length) {
      const { error } = await state.supabase.from('layers').delete().in('id', deleteLayerIds);
      if (error) throw error;
    }

    renderAll();
    setStatus('In Supabase gespeichert');
  } catch (err) {
    console.error(err);
    setStatus(`Speichern fehlgeschlagen: ${err.message || err}`, true);
  } finally {
    state.saving = false;
  }
}

function getLayerById(id) {
  return (state.data.layers || []).find(l => l.id === id) || state.data.layers[0] || { id: 'default', name: 'Standard', color: '#0f766e', size: 10, opacity: 0.85, visible: true };
}
function allSpotLayerIds(spot) {
  return [...new Set([spot.layerId, ...(spot.secondaryLayerIds || [])].filter(Boolean))];
}
function spotAssignedLayers(spot) {
  return allSpotLayerIds(spot).map(getLayerById).filter(Boolean);
}
function isSpotVisibleByLayer(spot) {
  const layers = spotAssignedLayers(spot);
  if (!layers.length) return true;
  return layers.some(layer => layer.visible !== false);
}
function getDisplayLayerForSpot(spot) {
  const layers = spotAssignedLayers(spot);
  return layers.find(layer => layer.visible !== false) || getLayerById(spot.layerId);
}
function ensureGoogleMapsUrl(spot) {
  const raw = (spot.googleMaps || '').trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(raw)}`;
  if (Number.isFinite(Number(spot.lat)) && Number.isFinite(Number(spot.lon))) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${spot.lat},${spot.lon}`)}`;
  return '';
}
function syncKnownDays() {
  if (!state.data?.meta) return;
  const fromSpots = state.data.spots.map(s => (s.plannedDay || '').trim()).filter(Boolean);
  state.data.meta.days = [...new Set([...(state.data.meta.days || []), ...fromSpots])].sort((a, b) => a.localeCompare(b, 'de'));
  syncDayRouteOrders();
}
function setSpotDaysToReplacement(oldName, replacement) {
  state.data.spots.forEach(s => {
    if ((s.plannedDay || '').trim() === oldName) s.plannedDay = replacement || '';
  });
}
function distanceMeters(a, b) {
  const R = 6371000, toRad = x => x * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat), la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function localImageCandidates(spot) {
  const safe = (spot.name || 'Spot').toString().replace(/[\\/:*?"<>|]/g, '').trim();
  const base = `${spot.id}_${safe}`;
  const exts = ['jpg', 'jpeg', 'png', 'webp', 'JPG', 'JPEG', 'PNG', 'WEBP'];
  return exts.map(ext => `./images/${base}.${ext}`);
}
function imageCandidates(spot) {
  const set = [];
  if (spot.image && /^https?:/i.test(spot.image)) set.push(spot.image);
  else if (spot.image) set.push(spot.image.startsWith('./') ? spot.image : `./images/${encodeURIComponent(spot.image)}`);
  if (spot.imageFile) set.push(`./images/${encodeURIComponent(spot.imageFile)}`);
  if (spot.manualImageFile) set.push(`./images/${encodeURIComponent(spot.manualImageFile)}`);
  set.push(...localImageCandidates(spot));
  return [...new Set(set)];
}
function spotHasImage(spot) {
  return !!(spot.image || spot.imageFile || spot.manualImageFile);
}
function buildProgressiveImage(candidates, cls = '', empty = '') {
  if (!candidates.length) return empty;
  const esc = candidates.map(c => escapeHtml(c));
  return `<img class="${cls}" src="${esc[0]}" data-candidates='${JSON.stringify(esc)}' onerror="advanceImageCandidate(this)">`;
}
function advanceImageCandidate(img) {
  try {
    const arr = JSON.parse(img.dataset.candidates || '[]');
    let idx = Number(img.dataset.idx || 0) + 1;
    if (idx < arr.length) {
      img.dataset.idx = idx;
      img.src = arr[idx];
    } else img.style.display = 'none';
  } catch {
    img.style.display = 'none';
  }
}
window.advanceImageCandidate = advanceImageCandidate;

function matchesFilters(spot) {
  const q = state.filters.search.trim().toLowerCase();
  if (q) {
    const hay = `${spot.id} ${spot.name} ${spot.comment} ${spot.plannedDay} ${spot.area} ${spot.location}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (state.filters.layer !== 'all' && !allSpotLayerIds(spot).includes(state.filters.layer)) return false;
  if (state.filters.plannedDay !== 'all' && (spot.plannedDay || '').trim() !== state.filters.plannedDay) return false;
  if (state.filters.hasImage && !spotHasImage(spot)) return false;
  const activeAreaIds = Object.entries(state.areaFilter).filter(([, v]) => v).map(([k]) => k);
  if (activeAreaIds.length) {
    const hit = activeAreaIds.some(id => pointInArea(spot, (state.data.areas || []).find(a => a.id === id)));
    if (!hit) return false;
  }
  return true;
}
function pointInArea(spot, area) {
  if (!area || !area.geojson) return false;
  const p = turf.point([spot.lon, spot.lat]);
  try { return turf.booleanPointInPolygon(p, area.geojson); } catch { return false; }
}
function nearestSpots(spot, count = 2) {
  return [...state.data.spots].filter(s => s.id !== spot.id).map(s => ({ spot: s, d: distanceMeters(spot, s) })).sort((a, b) => a.d - b.d).slice(0, count);
}

function markerHtml(spot, layer, matched) {
  const hovered = state.hoveredSpotId === spot.id;
  const size = Math.max(7, Math.round((layer.size || 10) + (hovered ? 3 : 0)));
  const opacity = hovered ? 1 : (matched ? (layer.opacity ?? 0.88) : 0.16);
  const fill = matched || hovered ? layer.color : 'transparent';
  const stroke = hovered ? '#111827' : layer.color;
  const label = state.showLabels && matched ? `<div class="spot-label" style="font-size:11px">${escapeHtml(spot.name || '')}</div>` : '';
  const extra = hovered ? 'box-shadow:0 0 0 5px rgba(255,255,255,.35),0 0 18px rgba(0,0,0,.18);' : '';
  return `<div class="spot-wrap">${label}<div class="spot-dot" style="width:${size}px;height:${size}px;border-color:${stroke};background:${fill};opacity:${opacity};${extra}"></div></div>`;
}

function renderAll() {
  if (!state.data) return;
  renderFilters();
  renderMap();
  renderResults();
  renderLayers();
  renderDays();
  renderAreas();
  renderDatabase();
  renderLegend();
  updateStats();
  updateAuthUi();
}

function updateStats() {
  const spots = (state.data.spots || []).filter(matchesFilters).length;
  const areas = Object.values(state.areaFilter).filter(Boolean).length;
  document.querySelectorAll('[data-stat="spots"]').forEach(el => el.textContent = String(spots));
  document.querySelectorAll('[data-stat="areas"]').forEach(el => el.textContent = String(areas));
}

function renderFilters() {
  const layers = state.data.layers || [];
  document.querySelectorAll('[data-role="layer-filter"]').forEach(sel => {
    const current = state.filters.layer;
    sel.innerHTML = `<option value="all">Alle Layer</option>` + layers.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('');
    sel.value = current;
  });
  const days = [...new Set((state.data.meta?.days || []).map(x => (x || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  document.querySelectorAll('[data-role="day-filter"]').forEach(sel => {
    const current = state.filters.plannedDay;
    sel.innerHTML = `<option value="all">Alle Tage</option>` + days.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
    sel.value = current;
  });
  document.querySelectorAll('[data-role="route-day"]').forEach(sel => {
    sel.innerHTML = `<option value="all">Tag wählen</option>` + days.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
    sel.value = state.routeSettings.selectedDay || 'all';
  });
  document.querySelectorAll('[data-role="labels-toggle"]').forEach(el => el.checked = !!state.showLabels);
}

function renderMap() {
  if (!state.map) return;
  state.markerLayer.clearLayers();
  state.drawItems.clearLayers();
  if (state.routeLayer) state.routeLayer.clearLayers();

  for (const area of state.data.areas || []) {
    if (state.areaVisibility[area.id] === false || !area.geojson) continue;
    const areaLayer = L.geoJSON(area.geojson, {
      style: {
        color: area.color || '#2563eb',
        weight: area.weight || 2,
        fillColor: area.color || '#2563eb',
        fillOpacity: 0.06,
      },
      pointToLayer: (_, latlng) => L.circle(latlng),
    });
    areaLayer.eachLayer(l => {
      l._areaId = area.id;
      l.on('click', () => openAreaEditor(area.id));
      state.drawItems.addLayer(l);
    });
  }

  for (const spot of state.data.spots || []) {
    const layer = getDisplayLayerForSpot(spot);
    if (!layer || !isSpotVisibleByLayer(spot)) continue;
    const matched = matchesFilters(spot);
    const icon = L.divIcon({ className: 'spot-icon-host', html: markerHtml(spot, layer, matched), iconSize: [140, 32], iconAnchor: [10, 14] });
    const marker = L.marker([spot.lat, spot.lon], { icon, keyboard: false, riseOnHover: true }).addTo(state.markerLayer);
    marker.on('click', () => {
      if (state.mobile) openSpotModal(spot.id);
      else openSpotPopup(spot.id, marker);
    });
  }

  for (const day of routeDaysToRender()) {
    const pts = orderedDaySpots(day).filter(isSpotVisibleByLayer).map(s => [s.lat, s.lon]);
    if (pts.length < 2) continue;
    L.polyline(pts, {
      color: state.routeSettings.colors[day] || '#ef4444',
      weight: 3,
      opacity: .9,
      dashArray: state.mobile ? '8 6' : '',
    }).addTo(state.routeLayer).bindTooltip(day, {sticky:true});
  }
}

function renderResults() {
  const wrap = document.getElementById('resultsList');
  if (!wrap) return;
  const matched = (state.data.spots || []).filter(matchesFilters);
  wrap.innerHTML = matched.map(spot => `
    <div class="result-card" data-spot="${spot.id}">
      <div class="result-thumb">${buildProgressiveImage(imageCandidates(spot), '', '')}</div>
      <div class="result-body">
        <div class="result-name">${escapeHtml(spot.name || 'Ohne Name')}</div>
        <div class="result-meta">${escapeHtml(spot.plannedDay || '–')} · ${escapeHtml(getDisplayLayerForSpot(spot).name || '')}</div>
      </div>
    </div>`).join('');
  wrap.querySelectorAll('[data-spot]').forEach(el => {
    el.onclick = () => {
      const spot = state.data.spots.find(s => s.id == el.dataset.spot);
      if (spot) {
        state.map.setView([spot.lat, spot.lon], Math.max(15, state.map.getZoom()));
        openSpotModal(spot.id);
      }
    };
  });
}

function renderDatabase() {
  const body = document.getElementById('dbBody');
  if (!body) return;
  const matched = (state.data.spots || []).filter(matchesFilters);
  if (state.mobile) {
    body.innerHTML = matched.map(spot => `
      <div class="db-row" data-spot-row="${spot.id}">
        <div class="db-row-main">
          <div class="db-id">#${spot.id}</div>
          <div>
            <div class="db-name">${escapeHtml(spot.name || '')}</div>
            <div class="db-meta">${escapeHtml(spot.plannedDay || '–')} · ${escapeHtml(getDisplayLayerForSpot(spot).name || '')}</div>
          </div>
          <button class="tiny-btn" data-db-toggle="${spot.id}">Details</button>
        </div>
        <div class="db-expand">
          <div class="db-thumb">${buildProgressiveImage(imageCandidates(spot), '', '<div class="img-missing">Kein Bild</div>')}</div>
          <div class="db-actions">
            <div class="small-note">${escapeHtml(spot.comment || 'Kein Kommentar')}</div>
            <button class="btn" data-spot-open="${spot.id}">Bearbeiten</button>
          </div>
        </div>
      </div>`).join('');
    body.querySelectorAll('[data-db-toggle]').forEach(btn => btn.onclick = ev => {
      ev.stopPropagation();
      body.querySelector(`[data-spot-row="${btn.dataset.dbToggle}"]`)?.classList.toggle('open');
    });
    body.querySelectorAll('[data-spot-open]').forEach(btn => btn.onclick = ev => {
      ev.stopPropagation();
      openSpotModal(Number(btn.dataset.spotOpen));
    });
    body.querySelectorAll('[data-spot-row]').forEach(row => row.onclick = () => row.classList.toggle('open'));
    return;
  }
  body.innerHTML = matched.map(spot => `
    <tr class="db-row" data-spot="${spot.id}">
      <td>${spot.id}</td>
      <td>${escapeHtml(spot.name || '')}<div class="db-expand"><button class="tiny-btn" data-db-edit="${spot.id}">Bearbeiten</button><div class="db-photo">${buildProgressiveImage(imageCandidates(spot), '', `<div class="img-missing">Kein Bild</div>`)}</div></div></td>
      <td>${escapeHtml(spot.plannedDay || '')}</td>
      <td>${escapeHtml(getDisplayLayerForSpot(spot).name || '')}</td>
      <td>${escapeHtml(spot.comment || '')}</td>
    </tr>`).join('');
  body.querySelectorAll('tr[data-spot]').forEach(tr => tr.onclick = ev => {
    if (ev.target.closest('[data-db-edit]')) return;
    tr.classList.toggle('open');
  });
  body.querySelectorAll('[data-db-edit]').forEach(btn => btn.onclick = ev => { ev.stopPropagation(); openSpotModal(Number(btn.dataset.dbEdit)); });
}

function renderLayers() {
  const wrap = document.getElementById('layerList');
  if (!wrap) return;
  wrap.innerHTML = (state.data.layers || []).map(layer => `
    <div class="cad-layer-row">
      <label class="tiny-check"><input type="checkbox" ${layer.visible !== false ? 'checked' : ''} data-layer-visible="${layer.id}" ${!canEdit() ? 'disabled' : ''}></label>
      <input class="small-input cad-name" value="${escapeHtml(layer.name)}" data-layer-name="${layer.id}" ${!canEdit() ? 'disabled' : ''}>
      <input type="color" value="${layer.color || '#0f766e'}" data-layer-color="${layer.id}" ${!canEdit() ? 'disabled' : ''}>
      <input class="small-input cad-num" type="number" min="1" max="10" step="1" value="${Math.max(1, Math.min(10, Math.round(layer.size || 9)))}" data-layer-size="${layer.id}" ${!canEdit() ? 'disabled' : ''}>
      <input class="small-input cad-num" type="number" min="1" max="10" step="1" value="${Math.max(1, Math.min(10, Math.round((layer.opacity ?? 0.88) * 10)))}" data-layer-opacity="${layer.id}" ${!canEdit() ? 'disabled' : ''}>
      <label class="tiny-check cad-legend"><input type="checkbox" ${layer.showInLegend ? 'checked' : ''} data-layer-legend="${layer.id}" ${!canEdit() ? 'disabled' : ''}> Legende</label>
      <button class="tiny-btn danger" data-layer-del="${layer.id}" ${!canEdit() ? 'disabled' : ''}>×</button>
    </div>`).join('');

  wrap.querySelectorAll('[data-layer-name]').forEach(el => el.onchange = () => { getLayerById(el.dataset.layerName).name = el.value; debounceSave(); renderLegend(); });
  wrap.querySelectorAll('[data-layer-visible]').forEach(el => el.onchange = () => { getLayerById(el.dataset.layerVisible).visible = el.checked; debounceSave(); renderAll(); });
  wrap.querySelectorAll('[data-layer-color]').forEach(el => el.oninput = () => { getLayerById(el.dataset.layerColor).color = el.value; renderAll(); debounceSave(); });
  wrap.querySelectorAll('[data-layer-size]').forEach(el => el.oninput = () => { getLayerById(el.dataset.layerSize).size = Number(el.value); renderAll(); debounceSave(); });
  wrap.querySelectorAll('[data-layer-opacity]').forEach(el => el.oninput = () => { getLayerById(el.dataset.layerOpacity).opacity = Math.max(.1, Math.min(1, Number(el.value) / 10)); renderAll(); debounceSave(); });
  wrap.querySelectorAll('[data-layer-legend]').forEach(el => el.onchange = () => { getLayerById(el.dataset.layerLegend).showInLegend = el.checked; renderLegend(); debounceSave(); });
  wrap.querySelectorAll('[data-layer-del]').forEach(el => el.onclick = () => {
    if ((state.data.layers || []).length <= 1) return alert('Mindestens ein Layer muss bleiben.');
    const id = el.dataset.layerDel;
    const fallback = state.data.layers.find(l => l.id !== id)?.id || 'default';
    state.data.spots.forEach(s => {
      if (s.layerId === id) s.layerId = fallback;
      s.secondaryLayerIds = (s.secondaryLayerIds || []).filter(x => x !== id);
    });
    state.data.layers = state.data.layers.filter(l => l.id !== id);
    debounceSave();
    renderAll();
  });
}

function renderDays() {
  const wrap = document.getElementById('dayList');
  if (!wrap) return;
  syncKnownDays();
  const days = state.data.meta?.days || [];
  const selected = state.routeSettings.selectedDay;
  wrap.innerHTML = `
    ${!state.mobile ? `<div class="stack" style="margin-bottom:8px"><label>Routen-Tag<select data-role="route-day"><option value="all">Tag wählen</option>${days.map(d => `<option value="${escapeHtml(d)}" ${selected===d?'selected':''}>${escapeHtml(d)}</option>`).join('')}</select></label></div>` : ''}
    ${days.map((day, idx) => {
      const spots = orderedDaySpots(day);
      const selectedDay = selected === day;
      return `<div class="layer-row">
        <div class="day-topline">
          <div style="display:flex;align-items:center;gap:8px;flex:1">
            <label class="tiny-check"><input type="checkbox" ${state.routeSettings.visible[day] ? 'checked' : ''} data-day-route-visible="${escapeHtml(day)}"> Route</label>
            ${!state.mobile ? `<input class="small-input" value="${escapeHtml(day)}" data-day-name="${idx}" ${!canEdit() ? 'disabled' : ''}>` : `<strong>${escapeHtml(day)}</strong>`}
          </div>
          <input type="color" value="${escapeHtml(state.routeSettings.colors[day] || '#ef4444')}" data-day-color="${escapeHtml(day)}">
          ${!state.mobile ? `<button class="tiny-btn ${selectedDay ? 'primary' : ''}" data-day-select="${escapeHtml(day)}">Planung</button>
          <button class="tiny-btn danger" data-day-del="${idx}" ${!canEdit() ? 'disabled' : ''}>×</button>` : ''}
        </div>
        ${!state.mobile && selectedDay ? `<div class="route-plan-list" data-route-list="${escapeHtml(day)}">${spots.map((spot, i) => `<div class="route-item" draggable="true" data-route-item="${spot.id}" data-day="${escapeHtml(day)}"><span class="route-no">${i+1}</span><span>${escapeHtml(spot.name)}</span></div>`).join('') || '<div class="small-note">Noch keine Spots auf diesem Tag.</div>'}</div>` : ''}
      </div>`;
    }).join('')}`;

  wrap.querySelectorAll('[data-role="route-day"]').forEach(el => el.onchange = () => { state.routeSettings.selectedDay = el.value; if (el.value !== 'all') state.routeSettings.visible[el.value] = true; saveUiSettings(); renderAll(); });
  wrap.querySelectorAll('[data-day-select]').forEach(el => el.onclick = () => { state.routeSettings.selectedDay = el.dataset.daySelect; state.routeSettings.visible[el.dataset.daySelect] = true; saveUiSettings(); renderAll(); });
  wrap.querySelectorAll('[data-day-color]').forEach(el => el.oninput = () => { state.routeSettings.colors[el.dataset.dayColor] = el.value; saveUiSettings(); renderMap(); });
  wrap.querySelectorAll('[data-day-route-visible]').forEach(el => el.onchange = () => { state.routeSettings.visible[el.dataset.dayRouteVisible] = el.checked; saveUiSettings(); renderMap(); });
  wrap.querySelectorAll('[data-day-name]').forEach(el => el.onchange = () => {
    const idx = Number(el.dataset.dayName); const oldName = state.data.meta.days[idx]; const newName = el.value.trim();
    if (!newName) { el.value = oldName || ''; return; }
    state.data.meta.days[idx] = newName; setSpotDaysToReplacement(oldName, newName);
    state.routeSettings.colors[newName] = state.routeSettings.colors[oldName] || '#ef4444';
    state.routeSettings.visible[newName] = state.routeSettings.visible[oldName] || false;
    if (state.routeSettings.selectedDay === oldName) state.routeSettings.selectedDay = newName;
    localStorage.setItem(`routeOrder:${newName}`, localStorage.getItem(`routeOrder:${oldName}`) || '[]');
    localStorage.removeItem(`routeOrder:${oldName}`); delete state.routeSettings.colors[oldName]; delete state.routeSettings.visible[oldName];
    syncKnownDays(); saveUiSettings(); renderAll(); debounceSave();
  });
  wrap.querySelectorAll('[data-day-del]').forEach(el => el.onclick = () => {
    const idx = Number(el.dataset.dayDel); const oldName = state.data.meta.days[idx]; setSpotDaysToReplacement(oldName, ''); state.data.meta.days.splice(idx, 1);
    delete state.routeSettings.colors[oldName]; delete state.routeSettings.visible[oldName]; if (state.routeSettings.selectedDay === oldName) state.routeSettings.selectedDay = 'all';
    localStorage.removeItem(`routeOrder:${oldName}`); saveUiSettings(); renderAll(); debounceSave();
  });

  wrap.querySelectorAll('.route-item').forEach(item => {
    item.addEventListener('dragstart', ev => { ev.dataTransfer.setData('text/plain', item.dataset.routeItem); item.classList.add('dragging'); });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));
  });
  wrap.querySelectorAll('[data-route-list]').forEach(list => {
    list.addEventListener('dragover', ev => {
      ev.preventDefault();
      const after = [...list.querySelectorAll('.route-item:not(.dragging)')].find(el => ev.clientY <= el.getBoundingClientRect().top + el.offsetHeight/2);
      const dragging = list.querySelector('.route-item.dragging'); if (!dragging) return;
      if (after) list.insertBefore(dragging, after); else list.appendChild(dragging);
    });
    list.addEventListener('drop', () => {
      const day = list.dataset.routeList; const order = [...list.querySelectorAll('.route-item')].map(el => Number(el.dataset.routeItem));
      setDayRouteOrder(day, order); saveUiSettings(); renderMap(); renderDays();
    });
  });
}

function renderAreas() {
  const wrap = document.getElementById('areaList');
  if (!wrap) return;
  wrap.innerHTML = (state.data.areas || []).map(area => `
    <div class="area-row">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
        <div><strong>${escapeHtml(area.name)}</strong></div>
        <button class="tiny-btn" data-area-edit="${area.id}" ${!canEdit() ? 'disabled' : ''}>Bearbeiten</button>
      </div>
      <div class="area-actions">
        <label class="tiny-check"><input type="checkbox" ${state.areaVisibility[area.id] !== false ? 'checked' : ''} data-area-visible="${area.id}"> sichtbar</label>
        <label class="tiny-check"><input type="checkbox" ${state.areaFilter[area.id] ? 'checked' : ''} data-area-filter="${area.id}"> Filter</label>
      </div>
    </div>`).join('');
  wrap.querySelectorAll('[data-area-visible]').forEach(el => el.onchange = () => { state.areaVisibility[el.dataset.areaVisible] = el.checked; renderAll(); debounceSave(); });
  wrap.querySelectorAll('[data-area-filter]').forEach(el => el.onchange = () => { state.areaFilter[el.dataset.areaFilter] = el.checked; const area = state.data.areas.find(a => a.id === el.dataset.areaFilter); if (area) area.useForFilter = el.checked; renderAll(); debounceSave(); });
  wrap.querySelectorAll('[data-area-edit]').forEach(el => el.onclick = () => openAreaEditor(el.dataset.areaEdit));
}

function layerBadgeDots(spot) {
  const ids = allSpotLayerIds(spot).slice(0, 9);
  return ids.map(id => {
    const layer = getLayerById(id);
    return `<span class="layer-chip" title="${escapeHtml(layer.name || '')}" style="background:${escapeHtml(layer.color || '#2563eb')}"></span>`;
  }).join('');
}
function openSpotPopup(id, marker) {
  const spot = state.data.spots.find(s => s.id === Number(id));
  if (!spot || !marker) return;
  const gmaps = ensureGoogleMapsUrl(spot);
  const html = `
    <div class="map-popup">
      <div class="map-popup-photo">${buildProgressiveImage(imageCandidates(spot), '', `<div class="img-missing">Kein Bild</div>`)}</div>
      <div class="map-popup-name">${escapeHtml(spot.name || 'Spot')}</div>
      <div class="map-popup-layers">${layerBadgeDots(spot)}</div>
      <div class="map-popup-actions">${gmaps ? `<a class="tiny-link" href="${escapeHtml(gmaps)}" target="_blank" rel="noopener">GMaps</a>` : ''}<button class="tiny-btn" onclick="openSpotModal(${spot.id})">Bearbeiten</button></div>
    </div>`;
  marker.bindPopup(html, { offset: [0, -8], closeButton: false, minWidth: 200, className: 'spot-popup-host' }).openPopup();
}
function makeLayerOptions(current) {
  return (state.data.layers || []).map(l => `<option value="${l.id}" ${l.id === current ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('');
}
function makeNullableLayerOptions(current) {
  return `<option value="">–</option>` + (state.data.layers || []).map(l => `<option value="${l.id}" ${l.id === current ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('');
}

function switchView(view) {
  document.body.dataset.view = view;
  document.querySelectorAll('[data-switch]').forEach(btn => btn.classList.toggle('active', btn.dataset.switch === view));
}

function openSpotModal(id) {
  const spot = state.data.spots.find(s => s.id === Number(id));
  if (!spot) return;
  state.activeSpotId = spot.id;
  state.editorOpen = true;
  state.editorDirty = false;
  const near = nearestSpots(spot, 2).map(({ spot: s, d }) => `
    <div class="near-card" data-near="${s.id}">
      <div class="near-thumb">${buildProgressiveImage(imageCandidates(s), '', '')}</div>
      <div><strong>${escapeHtml(s.name)}</strong><div>${Math.round(d)} m</div></div>
    </div>`).join('');

  const editorDisabled = !canEdit() ? 'disabled' : '';
  const extraSelections = Array.from({ length: 8 }, (_, i) => spot.secondaryLayerIds?.[i] || '');
  const gmaps = ensureGoogleMapsUrl(spot);
  document.getElementById('modalInner').innerHTML = `
    <div class="modal-head">
      <h3>${escapeHtml(spot.name || 'Spot')}</h3>
      <button class="tiny-btn" onclick="closeModal()">✕</button>
    </div>
    <div class="small-note" style="margin-bottom:10px">Spot-ID: <b>${spot.id}</b></div>
    <div class="modal-grid">
      <div>
        <label>Name<input id="spotName" value="${escapeHtml(spot.name || '')}" ${editorDisabled}></label>
        <label>Geplanter Tag<select id="spotDay" ${editorDisabled}><option value="">–</option>${(state.data.meta?.days || []).map(d => `<option value="${escapeHtml(d)}" ${(spot.plannedDay || '') === d ? 'selected' : ''}>${escapeHtml(d)}</option>`).join('')}</select></label>
        <label>Kommentar<textarea id="spotComment" ${editorDisabled}>${escapeHtml(spot.comment || '')}</textarea></label>
        <label>Primärlayer<select id="spotLayer" ${editorDisabled}>${makeLayerOptions(spot.layerId)}</select></label>
        <div class="layer-stack">${extraSelections.map((val, idx) => `<label>Layer ${idx + 2}<select id="spotLayer${idx + 2}" ${editorDisabled}>${makeNullableLayerOptions(val)}</select></label>`).join('')}</div>
        <div class="coord-row">
          <label>Lat<input id="spotLat" value="${spot.lat}" ${editorDisabled}></label>
          <label>Lon<input id="spotLon" value="${spot.lon}" ${editorDisabled}></label>
        </div>
        <div class="coord-row">
          <label>Google Maps / URL<input id="spotGoogleMaps" value="${escapeHtml(spot.googleMaps || '')}" ${editorDisabled}></label>
          <label>Ort / Notiz<input id="spotLocation" value="${escapeHtml(spot.location || '')}" ${editorDisabled}></label>
        </div>
        <div class="coord-row">
          <label>Dateiname lokal<input id="spotImageFile" value="${escapeHtml(spot.imageFile || '')}" ${editorDisabled}></label>
          <label style="display:flex;align-items:flex-end">${gmaps ? `<a class="btn" href="${escapeHtml(gmaps)}" target="_blank" rel="noopener">In Google Maps öffnen</a>` : ''}</label>
        </div>
        ${canEdit() ? `
          <div class="coord-row">
            <label>Bild wählen<input id="spotUpload" type="file" accept="image/*"></label>
            <label style="display:flex;align-items:flex-end"><button type="button" class="btn" onclick="uploadSpotImage()">Bild hochladen</button></label>
          </div>` : `<div class="small-note">Zum Bearbeiten bitte oben einloggen.</div>`}
      </div>
      <div>
        <div class="modal-photo"><div class="modal-photo-stack">${buildProgressiveImage(imageCandidates(spot), '', `<div class="img-missing">Kein Bild</div>`)}<div class="modal-layer-dots">${layerBadgeDots(spot)}</div></div></div>
      </div>
    </div>
    <div class="near-wrap"><h4>Nächste Spots</h4>${near || '<div class="small-note">Keine</div>'}</div>
    <div class="modal-actions">
      ${canEdit() ? '<button class="btn" onclick="deleteSpot()">Löschen</button><button class="btn primary" onclick="saveSpotModal()">Speichern</button>' : ''}
    </div>`;
  document.getElementById('modal').classList.add('open');
  document.querySelectorAll('[data-near]').forEach(el => el.onclick = () => openSpotModal(Number(el.dataset.near)));
  document.querySelectorAll('#modal input, #modal textarea, #modal select').forEach(el => {
  el.addEventListener('input', () => { state.editorDirty = true; });
  el.addEventListener('change', () => { state.editorDirty = true; });
});
} 
window.openSpotModal = openSpotModal;
function closeModal() {
  state.editorOpen = false;
  state.editorDirty = false;
  document.getElementById('modal').classList.remove('open');
}
window.closeModal = closeModal;

async function uploadSpotImage() {
  if (!canEdit()) return;
  const spot = state.data.spots.find(s => s.id === state.activeSpotId);
  const input = document.getElementById('spotUpload');
  const file = input?.files?.[0];
  if (!spot || !file) return alert('Bitte eine Bilddatei wählen.');

  if (!state.backendEnabled) {
    alert('Bild-Upload ist nur mit Supabase-Backend verfügbar.');
    return;
  }

  const ext = file.name.split('.').pop() || 'jpg';
  const path = `spots/${spot.id}-${slugify(spot.name || 'spot')}-${Date.now()}.${ext}`;
  setStatus('Lädt Bild hoch …');
  const { error } = await state.supabase.storage.from(state.storageBucket).upload(path, file, { upsert: true });
  if (error) {
    console.error(error);
    setStatus('Upload fehlgeschlagen', true);
    return alert(error.message || 'Upload fehlgeschlagen');
  }
  const { data } = state.supabase.storage.from(state.storageBucket).getPublicUrl(path);
  spot.image = data.publicUrl;
  spot.imageFile = '';
  debounceSave();
  openSpotModal(spot.id);
}
window.uploadSpotImage = uploadSpotImage;

function saveSpotModal() {
  const spot = state.data.spots.find(s => s.id === state.activeSpotId);
  if (!spot || !canEdit()) return;
  spot.name = document.getElementById('spotName').value.trim();
  spot.plannedDay = document.getElementById('spotDay').value.trim();
  spot.comment = document.getElementById('spotComment').value.trim();
  spot.layerId = document.getElementById('spotLayer').value;
  spot.location = document.getElementById('spotLocation').value.trim();
  spot.googleMaps = document.getElementById('spotGoogleMaps').value.trim();
  spot.imageFile = document.getElementById('spotImageFile').value.trim();
  const extra = Array.from({ length: 8 }, (_, i) => document.getElementById(`spotLayer${i + 2}`)?.value || '').filter(Boolean).filter((v, i, a) => a.indexOf(v) === i && v !== spot.layerId);
  spot.secondaryLayerIds = extra;
  syncKnownDays();
  spot.lat = Number(document.getElementById('spotLat').value);
  spot.lon = Number(document.getElementById('spotLon').value);
  closeModal();
  renderAll();
  debounceSave();
  state.editorDirty = false;
  state.editorOpen = false;
}
window.saveSpotModal = saveSpotModal;

function deleteSpot() {
  if (!canEdit()) return;
  if (!confirm('Spot löschen?')) return;
  state.data.spots = state.data.spots.filter(s => s.id !== state.activeSpotId);
  closeModal();
  renderAll();
  debounceSave();
}
window.deleteSpot = deleteSpot;

function addNewDay() {
  if (!canEdit()) return;
  syncKnownDays();
  let base = 'Neuer Tag';
  let i = 1;
  let name = base;
  while ((state.data.meta.days || []).includes(name)) { i += 1; name = `${base} ${i}`; }
  state.data.meta.days.push(name);
  renderAll();
  debounceSave();
}

function addNewLayer() {
  if (!canEdit()) return;
  const id = randomId('layer');
  state.data.layers.push({ id, name: 'Neuer Layer', color: '#2563eb', size: 9, opacity: 0.85, visible: true, sortOrder: state.data.layers.length });
  renderAll();
  debounceSave();
}

function beginAddPin() {
  if (!canEdit()) return alert('Zum Hinzufügen bitte einloggen.');
  state.addPinMode = true;
  document.body.classList.add('add-pin-mode');
  setStatus('Klick auf die Karte, um einen Spot zu setzen');
}
function addSpotAt(latlng) {
  const nextId = Math.max(0, ...state.data.spots.map(s => Number(s.id) || 0)) + 1;
  state.data.spots.push({
    id: nextId,
    name: 'Neuer Spot',
    lat: latlng.lat,
    lon: latlng.lng,
    image: '',
    imageFile: '',
    manualImageFile: '',
    plannedDay: '',
    location: '',
    comment: '',
    area: '',
    googleMaps: '',
    layerId: state.data.layers[0]?.id || 'default',
    secondaryLayerIds: [],
  });
  state.addPinMode = false;
  document.body.classList.remove('add-pin-mode');
  renderAll();
  debounceSave();
  setTimeout(() => openSpotModal(nextId), 120);
}

function openAreaEditor(id) {
  const area = (state.data.areas || []).find(a => a.id === id);
  if (!area) return;
  if (!canEdit()) return;
  const name = prompt('Bereichsname', area.name || 'Bereich');
  if (name != null) {
    area.name = name.trim() || 'Bereich';
    renderAll();
    debounceSave();
  }
}

function exportJson() {
  const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'pragmap-export.json';
  a.click();
  URL.revokeObjectURL(url);
}
window.exportJson = exportJson;

async function importJsonFile(file) {
  const text = await file.text();
  state.data = normalizeData(JSON.parse(text));
  renderAll();
  debounceSave();
}

async function importLocalSeedToBackend() {
  if (!state.backendEnabled || !canEdit()) return;
  const res = await fetch('./data/data.json');
  const data = normalizeData(await res.json());
  state.data = data;
  renderAll();
  await saveData();
}
window.importLocalSeedToBackend = importLocalSeedToBackend;

function getRedirectUrl() {
  const cfg = getConfig();
  const base = (cfg.GITHUB_PAGES_BASE || '').trim();
  if (base) {
    try {
      return new URL(base, window.location.origin).toString();
    } catch {}
  }
  return window.location.href.split('#')[0];
}

function readAuthFormValues() {
  const email = (document.querySelector('[data-role=login-email]')?.value || getConfig().DEFAULT_LOGIN_EMAIL || '').trim();
  const password = document.querySelector('[data-role=login-password]')?.value || '';
  return { email, password };
}

async function loginWithPassword() {
  if (!state.backendEnabled) return alert('Kein Supabase-Backend konfiguriert.');
  const { email, password } = readAuthFormValues();
  if (!email || !password) return alert('Bitte E-Mail und Passwort eingeben.');
  setStatus('Login läuft …');
  const { error } = await state.supabase.auth.signInWithPassword({ email, password });
  if (error) {
    state.authError = error.message || 'Login fehlgeschlagen';
    updateAuthUi();
    alert(state.authError);
    return;
  }
  state.authError = '';
  setStatus('Login erfolgreich');
}
window.loginWithPassword = loginWithPassword;

async function loginWithMagicLink() {
  if (!state.backendEnabled) return alert('Kein Supabase-Backend konfiguriert.');
  const { email } = readAuthFormValues();
  if (!email) return alert('Bitte E-Mail eingeben.');
  const redirectTo = getRedirectUrl();
  setStatus('Magic Link wird versendet …');
  const { error } = await state.supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });
  if (error) {
    state.authError = error.message || 'Magic Link fehlgeschlagen';
    updateAuthUi();
    alert(state.authError);
    return;
  }
  state.authError = '';
  setStatus('Magic Link versendet');
  alert('Login-Link wurde versendet. Falls nichts ankommt: in Supabase Redirect-URL und E-Mail-Provider prüfen.');
}
window.loginWithMagicLink = loginWithMagicLink;

async function logout() {
  if (!state.supabase) return;
  await state.supabase.auth.signOut();
}
window.logout = logout;

function updateAuthUi() {
  const cfg = getConfig();
  const pwEnabled = cfg.ENABLE_PASSWORD_LOGIN !== false;
  const magicEnabled = !!cfg.ENABLE_MAGIC_LINK;
  document.querySelectorAll('[data-role="auth-state"]').forEach(el => {
    if (!state.backendEnabled) {
      el.textContent = 'Lokaler Modus';
    } else if (!state.authReady) {
      el.textContent = 'Auth lädt …';
    } else if (state.user) {
      el.textContent = `Editor: ${state.user.email || 'eingeloggt'}`;
    } else {
      el.textContent = 'Öffentlich / Read only';
    }
  });
  document.querySelectorAll('[data-role="auth-hint"]').forEach(el => {
    if (!state.backendEnabled) {
      el.textContent = 'Supabase nicht konfiguriert – Änderungen werden nur lokal im Browser gespeichert.';
    } else if (state.user) {
      el.textContent = 'Bearbeiten aktiv.';
    } else if (state.authError) {
      el.textContent = `Login-Problem: ${state.authError}`;
    } else if (pwEnabled && magicEnabled) {
      el.textContent = 'Passwort-Login aktiv. Magic Link optional.';
    } else if (pwEnabled) {
      el.textContent = 'Passwort-Login aktiv.';
    } else if (magicEnabled) {
      el.textContent = 'Magic Link aktiv.';
    } else {
      el.textContent = 'Kein Login-Verfahren aktiviert.';
    }
  });
  document.querySelectorAll('[data-role="auth-fields"]').forEach(el => el.style.display = state.backendEnabled && !state.user ? '' : 'none');

  document.querySelectorAll('[data-role="login-email"]').forEach(el => {
    if (!el.value && getConfig().DEFAULT_LOGIN_EMAIL) el.value = getConfig().DEFAULT_LOGIN_EMAIL;
  });
  document.querySelectorAll('[data-role="login-btn-password"]').forEach(el => el.style.display = state.backendEnabled && !state.user && pwEnabled ? '' : 'none');
  document.querySelectorAll('[data-role="login-btn-magic"]').forEach(el => el.style.display = state.backendEnabled && !state.user && magicEnabled ? '' : 'none');
  document.querySelectorAll('[data-role="logout-btn"]').forEach(el => el.style.display = state.user ? '' : 'none');
  document.querySelectorAll('[data-role="seed-btn"]').forEach(el => el.style.display = state.backendEnabled && state.user ? '' : 'none');
}

function makeDraggable(panelId) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const handle = panel.querySelector('.drawer-head');
  if (!handle) return;
  let startX = 0, startY = 0, startL = 0, startT = 0, dragging = false;
  const key = `dragpos:${panelId}`;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (saved) {
      panel.style.left = saved.left + 'px';
      panel.style.top = saved.top + 'px';
      panel.style.right = 'auto';
    }
  } catch {}
  handle.style.cursor = 'move';
  handle.addEventListener('mousedown', e => {
    if (e.target.closest('button,input,select,label')) return;
    dragging = true;
    const rect = panel.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY; startL = rect.left; startT = rect.top;
    panel.style.left = startL + 'px'; panel.style.top = startT + 'px'; panel.style.right = 'auto';
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const left = Math.max(4, Math.min(window.innerWidth - panel.offsetWidth - 4, startL + (e.clientX - startX)));
    const top = Math.max(4, Math.min(window.innerHeight - 60, startT + (e.clientY - startY)));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
    localStorage.setItem(key, JSON.stringify({ left: parseInt(panel.style.left) || 0, top: parseInt(panel.style.top) || 0 }));
  });
}

function startUserLocation() {
  if (!state.mobile) return;
  if (!navigator.geolocation) {
    console.log('Geolocation wird vom Browser nicht unterstützt.');
    return;
  }
  if (state.userWatchId != null) return;

  state.userWatchId = navigator.geolocation.watchPosition(
    pos => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      const acc = Number(pos.coords.accuracy || 0);

      const markerLatLng = [lat, lon];

      if (!state.userLocationMarker) {
        state.userAccuracyCircle = L.circle(markerLatLng, {
          radius: acc,
          color: '#2563eb',
          weight: 1,
          opacity: 0.7,
          fillColor: '#60a5fa',
          fillOpacity: 0.14,
          interactive: false,
        }).addTo(state.map);

        state.userLocationMarker = L.circleMarker(markerLatLng, {
          radius: 8,
          color: '#ffffff',
          weight: 2,
          fillColor: '#2563eb',
          fillOpacity: 1,
        }).addTo(state.map);
      } else {
        state.userLocationMarker.setLatLng(markerLatLng);
        if (state.userAccuracyCircle) {
          state.userAccuracyCircle.setLatLng(markerLatLng);
          state.userAccuracyCircle.setRadius(acc);
        }
      }
    },
    err => {
      console.log('Standortfehler:', err);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 10000,
    }
  );
}

function centerToUserLocation() {
  if (!state.map) return;

  if (state.userLocationMarker) {
    state.map.setView(state.userLocationMarker.getLatLng(), Math.max(state.map.getZoom(), 16));
    return;
  }

  if (!navigator.geolocation) return;

  navigator.geolocation.getCurrentPosition(
    pos => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      state.map.setView([lat, lon], 16);
      startUserLocation();
    },
    err => {
      console.log('Standort konnte nicht abgerufen werden:', err);
      alert('Standort konnte nicht abgerufen werden. Bitte Browser-Standort freigeben.');
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10000,
    }
  );
}

function bindLocationButton() {
  const btn = document.getElementById('locateMeBtn');
  if (!btn) return;
  btn.onclick = () => centerToUserLocation();
}

function setupUiEvents() {
  document.querySelectorAll('[data-switch]').forEach(btn => btn.onclick = () => switchView(btn.dataset.switch));
  document.querySelectorAll('[data-role="search"]').forEach(el => el.oninput = () => { state.filters.search = el.value; renderAll(); });
  document.querySelectorAll('[data-role="layer-filter"]').forEach(el => el.onchange = () => { state.filters.layer = el.value; renderAll(); });
  document.querySelectorAll('[data-role="day-filter"]').forEach(el => el.onchange = () => { state.filters.plannedDay = el.value; renderAll(); });
  document.querySelectorAll('[data-role="has-image"]').forEach(el => el.onchange = () => { state.filters.hasImage = el.checked; renderAll(); });
  document.querySelectorAll('[data-role="labels-toggle"]').forEach(el => el.onchange = () => { state.showLabels = el.checked; saveUiSettings(); renderMap(); });
  document.querySelectorAll('[data-action="toggle-legend"]').forEach(el => el.onclick = () => { state.legendOpen = !state.legendOpen; saveUiSettings(); renderLegend(); });
  document.querySelectorAll('[data-action="add-pin"]').forEach(el => el.onclick = beginAddPin);
  document.querySelectorAll('[data-action="new-layer"]').forEach(el => el.onclick = addNewLayer);
  document.querySelectorAll('[data-action="new-day"]').forEach(el => el.onclick = addNewDay);
  document.querySelectorAll('[data-action="toggle-results"]').forEach(el => el.onclick = () => document.getElementById('resultsDrawer')?.classList.toggle('collapsed'));
  document.querySelectorAll('[data-action="toggle-layers"]').forEach(el => el.onclick = () => document.getElementById('layersDrawer')?.classList.toggle('collapsed'));
  document.querySelectorAll('[data-action="toggle-days"]').forEach(el => el.onclick = () => document.getElementById('daysDrawer')?.classList.toggle('collapsed'));
  document.querySelectorAll('[data-action="export-json"]').forEach(el => el.onclick = exportJson);
  document.querySelectorAll('[data-action="login-password"]').forEach(el => el.onclick = loginWithPassword);
  document.querySelectorAll('[data-action="login-magic"]').forEach(el => el.onclick = loginWithMagicLink);
  document.querySelectorAll('[data-action="logout"]').forEach(el => el.onclick = logout);
  document.querySelectorAll('[data-action="seed-import"]').forEach(el => el.onclick = importLocalSeedToBackend);
  document.querySelectorAll('[data-role="login-password"]').forEach(el => el.addEventListener('keydown', ev => { if (ev.key === 'Enter') loginWithPassword(); }));
  document.querySelectorAll('[data-action="import-json"]').forEach(el => el.onchange = async ev => {
    const file = ev.target.files?.[0];
    if (!file) return;
    await importJsonFile(file);
    ev.target.value = '';
  });
}

async function refreshRemoteDataSilently() {
  if (!state.backendEnabled || state.saving) return;

  // Während Bearbeitung keine Remote-Updates einspielen
  if (state.editorOpen || state.editorDirty) return;

  try {
    const previousSpotId = state.activeSpotId;
    await loadData();
    renderAll();
    if (previousSpotId && document.getElementById('modal')?.classList.contains('open')) {
      openSpotModal(previousSpotId);
    }
  } catch (err) {
    console.error(err);
  }
}

function setupRealtimeSync() {
  if (!state.backendEnabled || !state.supabase) return;
  if (state.realtimeChannel) { try { state.supabase.removeChannel(state.realtimeChannel); } catch {} }
  state.realtimeChannel = state.supabase.channel('pragmap-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'spots' }, refreshRemoteDataSilently)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'layers' }, refreshRemoteDataSilently)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'areas' }, refreshRemoteDataSilently)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'days' }, refreshRemoteDataSilently)
    .subscribe();
  clearInterval(state.syncTimer);
  state.syncTimer = setInterval(refreshRemoteDataSilently, 50000);
}

function initMap(mobile = false) {
  state.map = L.map('map', { zoomControl: !mobile }).setView([50.078, 14.43], mobile ? 11.5 : 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap' }).addTo(state.map);
  state.markerLayer = L.layerGroup().addTo(state.map);
  state.routeLayer = L.layerGroup().addTo(state.map);
  state.drawItems = new L.FeatureGroup().addTo(state.map);

  const drawControl = new L.Control.Draw({
    position: 'topleft',
    edit: { featureGroup: state.drawItems },
    draw: {
      marker: false, polyline: false, rectangle: false,
      circlemarker: false,
      polygon: { allowIntersection: false, showArea: true },
      circle: true,
    }
  });
  state.map.addControl(drawControl);

  state.map.on(L.Draw.Event.CREATED, function (e) {
    if (!canEdit()) return alert('Zum Bearbeiten bitte einloggen.');
    const layer = e.layer;
    const id = randomId('area');
    layer._areaId = id;
    state.data.areas.push({ id, name: 'Neuer Bereich', color: '#2563eb', weight: 2, visible: true, useForFilter: false, geojson: layer.toGeoJSON() });
    state.areaVisibility[id] = true;
    state.areaFilter[id] = false;
    renderAll();
    debounceSave();
  });

  state.map.on(L.Draw.Event.EDITED, function (e) {
    if (!canEdit()) return;
    e.layers.eachLayer(layer => {
      const id = layer._areaId;
      if (!id) return;
      const area = state.data.areas.find(a => a.id === id);
      if (area) area.geojson = layer.toGeoJSON();
    });
    renderAll();
    debounceSave();
  });

  state.map.on(L.Draw.Event.DELETED, function (e) {
    if (!canEdit()) return;
    const ids = [];
    e.layers.eachLayer(layer => { if (layer._areaId) ids.push(layer._areaId); });
    if (!ids.length) return;
    state.data.areas = state.data.areas.filter(a => !ids.includes(a.id));
    ids.forEach(id => { delete state.areaVisibility[id]; delete state.areaFilter[id]; });
    renderAll();
    debounceSave();
  });

  state.map.on('click', e => { if (state.addPinMode) addSpotAt(e.latlng); });
  state.map.on('zoomend', renderMap);
}

async function initApp({ mobile = false } = {}) {
  state.mobile = mobile;
  loadUiSettings();
  await initBackend();
  await loadData();
  setupUiEvents();
  initMap(mobile);
  renderAll();
  setupRealtimeSync();
  switchView('map');

  if (mobile) {
    bindLocationButton();
    startUserLocation();
  }
  if (!mobile) {
    makeDraggable('filterDrawer');
    makeDraggable('resultsDrawer');
    makeDraggable('layersDrawer');
    makeDraggable('daysDrawer');
  }
}
window.initApp = initApp;

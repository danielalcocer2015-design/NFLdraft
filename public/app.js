import { PLAYERS } from './players.js';
import { firebaseConfig, firebaseEnabled } from './firebase-config.js';

const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
const TIERS = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];
const DEFAULT_TARGETS = { QB: 2, RB: 5, WR: 6, TE: 2, K: 1, DEF: 1 };
const PLAYERS_BY_ID = new Map(PLAYERS.map(p => [p.id, p]));

const LOCAL_KEY = 'draftnight-local-v2';
const SOLO_DRAFT_KEY = 'draftnight-solo-drafted';

let local = {
  myName: '',
  targets: { ...DEFAULT_TARGETS },
  theme: 'dark',
  roomId: null,
  rankingProfiles: {},   // id -> { name, order: [ids], tiers: {id: tier} }
  activeProfileId: null,
  sort: 'custom'          // board order: defaults to your personal ranking
};

let drafted = {};           // id -> { owner, pick, ts }
let filters = { pos: 'ALL', tier: 'ALL', hideDrafted: true, search: '', sort: 'custom' };
let historyStack = [];      // { id, prevEntry } — session-only undo stack
let dragId = null;

let fb = null;              // { firestore module, app, dbInst }
let roomUnsub = null;

// ---------- Local persistence ----------
function loadLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      local = {
        ...local,
        ...parsed,
        targets: { ...DEFAULT_TARGETS, ...(parsed.targets || {}) },
        rankingProfiles: parsed.rankingProfiles || {}
      };
      // Migrate the old single-profile shape (pre-multi-profile) into a real profile.
      if (Object.keys(local.rankingProfiles).length === 0 && (parsed.customOrder || parsed.customTiers)) {
        const id = genId();
        local.rankingProfiles[id] = {
          name: 'Mi ranking',
          order: Array.isArray(parsed.customOrder) ? parsed.customOrder : [],
          tiers: parsed.customTiers || {}
        };
        local.activeProfileId = id;
      }
    }
  } catch (e) { /* no existing state */ }
  ensureProfiles();
}

let saveLocalTimeout;
function saveLocal() {
  clearTimeout(saveLocalTimeout);
  saveLocalTimeout = setTimeout(() => {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(local)); } catch (e) { /* storage unavailable */ }
  }, 200);
}

function genId() {
  return 'rp_' + Math.random().toString(36).slice(2, 10);
}

function defaultOrder() {
  return [...PLAYERS].sort((a, b) => (a.adp ?? 999) - (b.adp ?? 999)).map(p => p.id);
}

function ensureProfileOrder(profile) {
  const known = new Set(profile.order);
  const missing = PLAYERS
    .filter(p => !known.has(p.id))
    .sort((a, b) => (a.adp ?? 999) - (b.adp ?? 999))
    .map(p => p.id);
  const valid = profile.order.filter(id => PLAYERS_BY_ID.has(id));
  profile.order = [...valid, ...missing];
}

function ensureProfiles() {
  if (Object.keys(local.rankingProfiles).length === 0) {
    const id = genId();
    local.rankingProfiles[id] = { name: 'Mi ranking', order: defaultOrder(), tiers: {} };
    local.activeProfileId = id;
  }
  if (!local.rankingProfiles[local.activeProfileId]) {
    local.activeProfileId = Object.keys(local.rankingProfiles)[0];
  }
  Object.values(local.rankingProfiles).forEach(ensureProfileOrder);
}

function activeProfile() {
  return local.rankingProfiles[local.activeProfileId];
}

function effectiveTier(player) {
  return activeProfile().tiers[player.id] || player.tier;
}

// ---------- Solo (single-device) draft persistence ----------
function loadSoloDrafted() {
  try {
    const raw = localStorage.getItem(SOLO_DRAFT_KEY);
    drafted = raw ? JSON.parse(raw) : {};
  } catch (e) { drafted = {}; }
}
function saveSoloDrafted() {
  try { localStorage.setItem(SOLO_DRAFT_KEY, JSON.stringify(drafted)); } catch (e) { /* ignore */ }
}

// ---------- Save indicator ----------
function flashSaved(ok = true, label) {
  const el = document.getElementById('saveIndicator');
  el.classList.toggle('error', !ok);
  document.getElementById('saveLabel').textContent = label || (ok ? 'Guardado' : 'Error al guardar');
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1200);
}

// ---------- Firebase (multiplayer) ----------
async function ensureFirebase() {
  if (!firebaseEnabled) return null;
  if (fb) return fb;
  const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js');
  const firestore = await import('https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js');
  const app = initializeApp(firebaseConfig);
  const dbInst = firestore.getFirestore(app);
  fb = { app, firestore, dbInst };
  return fb;
}

function roomRef() {
  return fb.firestore.doc(fb.dbInst, 'rooms', local.roomId);
}

async function joinRoom(roomId) {
  await ensureFirebase();
  if (!fb) return;
  local.roomId = roomId;
  saveLocal();
  if (roomUnsub) roomUnsub();
  const ref = roomRef();
  roomUnsub = fb.firestore.onSnapshot(ref, snap => {
    if (snap.exists()) {
      drafted = snap.data().drafted || {};
    } else {
      drafted = {};
      fb.firestore.setDoc(ref, { drafted: {}, createdAt: fb.firestore.serverTimestamp() }).catch(() => {});
    }
    render();
    updateRoomUI();
  }, err => {
    console.error(err);
    flashSaved(false, 'Sin conexión a la sala');
  });
  updateRoomUI();
}

function leaveRoom() {
  if (roomUnsub) { roomUnsub(); roomUnsub = null; }
  local.roomId = null;
  saveLocal();
  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.replaceState(null, '', url.toString());
  loadSoloDrafted();
  render();
  updateRoomUI();
}

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function createRoom() {
  await ensureFirebase();
  if (!fb) return;
  const code = genRoomCode();
  const url = new URL(location.href);
  url.searchParams.set('room', code);
  history.replaceState(null, '', url.toString());
  await joinRoom(code);
}

// ---------- Draft state mutations (unified local/room) ----------
function recordHistory(id) {
  historyStack.push({ id, prevEntry: drafted[id] ? { ...drafted[id] } : null });
  if (historyStack.length > 50) historyStack.shift();
  updateUndoButtonState();
}

function writePlayer(id, owner, pick) {
  const entry = { owner, pick: pick ?? null, ts: Date.now() };
  drafted[id] = entry;
  if (local.roomId && fb) {
    fb.firestore.updateDoc(roomRef(), { [`drafted.${id}`]: entry }).catch(e => { console.error(e); flashSaved(false); });
  } else {
    saveSoloDrafted();
  }
  flashSaved(true);
  render();
}

function removePlayer(id) {
  delete drafted[id];
  if (local.roomId && fb) {
    fb.firestore.updateDoc(roomRef(), { [`drafted.${id}`]: fb.firestore.deleteField() }).catch(e => console.error(e));
  } else {
    saveSoloDrafted();
  }
  flashSaved(true);
  render();
}

function nextPickNumber() {
  return Object.keys(drafted).length + 1;
}

function draftPlayer(id, owner, pick) {
  recordHistory(id);
  writePlayer(id, (owner || 'Jugador').trim() || 'Jugador', pick);
}

function undoPlayer(id) {
  recordHistory(id);
  removePlayer(id);
}

function globalUndo() {
  const last = historyStack.pop();
  updateUndoButtonState();
  if (!last) return;
  if (last.prevEntry) {
    drafted[last.id] = last.prevEntry;
    if (local.roomId && fb) {
      fb.firestore.updateDoc(roomRef(), { [`drafted.${last.id}`]: last.prevEntry }).catch(e => console.error(e));
    } else {
      saveSoloDrafted();
    }
  } else {
    removePlayer(last.id);
    return; // removePlayer already re-renders
  }
  flashSaved(true, 'Deshecho');
  render();
}

function updateUndoButtonState() {
  document.getElementById('undoBtn').disabled = historyStack.length === 0;
}

// ---------- Filter pills ----------
function buildFilterPills() {
  const posWrap = document.getElementById('posFilters');
  const allPos = document.createElement('button');
  allPos.className = 'pill active'; allPos.textContent = 'Todas'; allPos.dataset.pos = 'ALL';
  posWrap.appendChild(allPos);
  POSITIONS.forEach(p => {
    const b = document.createElement('button');
    b.className = 'pill'; b.textContent = p; b.dataset.pos = p;
    posWrap.appendChild(b);
  });
  posWrap.addEventListener('click', e => {
    const btn = e.target.closest('.pill'); if (!btn) return;
    filters.pos = btn.dataset.pos;
    [...posWrap.querySelectorAll('.pill')].forEach(p => p.classList.toggle('active', p === btn));
    render();
  });

  const tierWrap = document.getElementById('tierFilters');
  const allTier = document.createElement('button');
  allTier.className = 'pill active'; allTier.textContent = 'Todos'; allTier.dataset.tier = 'ALL';
  tierWrap.appendChild(allTier);
  TIERS.forEach(t => {
    const b = document.createElement('button');
    b.className = 'pill tier-pill'; b.textContent = t; b.dataset.tier = t;
    tierWrap.appendChild(b);
  });
  tierWrap.addEventListener('click', e => {
    const btn = e.target.closest('.pill'); if (!btn) return;
    filters.tier = btn.dataset.tier;
    [...tierWrap.querySelectorAll('.pill')].forEach(p => p.classList.toggle('active', p === btn));
    render();
  });

  document.getElementById('hideDrafted').addEventListener('click', e => {
    filters.hideDrafted = !filters.hideDrafted;
    e.target.classList.toggle('active', filters.hideDrafted);
    render();
  });

  document.getElementById('searchInput').addEventListener('input', e => {
    filters.search = e.target.value.trim().toLowerCase();
    render();
  });

  document.getElementById('sortSelect').addEventListener('change', e => {
    filters.sort = e.target.value;
    local.sort = e.target.value;
    saveLocal();
    renderBoard();
  });
}

// ---------- Helpers ----------
function fmtAdp(a) {
  if (a === null || a === undefined) return '—';
  return Number.isInteger(a) ? a.toString() : a.toFixed(1);
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function isMine(entry) {
  return !!entry && entry.owner.trim().toLowerCase() === local.myName.trim().toLowerCase();
}

// ---------- Filtering (shared by the board and the rankings list) ----------
function matchesFilters(p) {
  if (filters.pos !== 'ALL' && p.pos !== filters.pos) return false;
  if (filters.tier !== 'ALL' && effectiveTier(p) !== filters.tier) return false;
  if (filters.search) {
    const hay = (p.name + ' ' + p.team).toLowerCase();
    if (!hay.includes(filters.search)) return false;
  }
  if (filters.hideDrafted && drafted[p.id]) return false;
  return true;
}

// ---------- Board ----------
function filteredPlayers() {
  return PLAYERS.filter(matchesFilters);
}

function sortPlayers(list) {
  if (filters.sort === 'name') {
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }
  if (filters.sort === 'custom') {
    const order = activeProfile().order;
    return [...list].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  }
  return [...list].sort((a, b) => (a.adp ?? 999) - (b.adp ?? 999));
}

function renderBoard() {
  const board = document.getElementById('board');
  const list = sortPlayers(filteredPlayers());

  document.getElementById('boardCount').textContent = list.length + ' jugador' + (list.length === 1 ? '' : 'es');

  if (list.length === 0) {
    board.innerHTML = '<div class="empty-state">Ningún jugador coincide con estos filtros.</div>';
    return;
  }

  board.innerHTML = list.map(p => {
    const d = drafted[p.id];
    const takenClass = d ? 'taken' : '';
    const tier = effectiveTier(p);
    let actions = '';
    if (!d) {
      actions = `<button class="btn btn-mine" data-action="mine" data-id="${p.id}">Es mío</button>
                 <button class="btn" data-action="other" data-id="${p.id}">Tomado</button>`;
    } else {
      actions = `<span class="owner-tag">${escapeHtml(d.owner)}</span>
                 <button class="btn btn-undo" data-action="undo" data-id="${p.id}">Deshacer</button>`;
    }
    return `<div class="row ${takenClass}">
      <div class="rank">${p.rank ?? '—'}</div>
      <div class="pinfo">
        <span class="pname">${escapeHtml(p.name)}</span>
        <span class="pteam">${p.team || ''}</span>
      </div>
      <div class="pos-badge pos-${p.pos}">${p.pos}</div>
      <div class="adp">${fmtAdp(p.adp)}</div>
      <div class="tier-chip tier-${tier}">${tier}</div>
      <div class="actions">${actions}</div>
    </div>`;
  }).join('');
}

// ---------- Scoreboard ----------
function renderScoreboard() {
  const slotsEl = document.getElementById('slots');
  const draftedByPos = {};
  POSITIONS.forEach(p => draftedByPos[p] = 0);
  Object.entries(drafted).forEach(([id, d]) => {
    if (!isMine(d)) return;
    const player = PLAYERS_BY_ID.get(Number(id));
    if (player && draftedByPos[player.pos] !== undefined) draftedByPos[player.pos]++;
  });

  let totalTarget = 0, totalDrafted = 0;
  slotsEl.innerHTML = POSITIONS.map(pos => {
    const target = local.targets[pos] ?? 0;
    const count = draftedByPos[pos];
    totalTarget += target; totalDrafted += count;
    const pct = target > 0 ? Math.min(100, (count / target) * 100) : 0;
    const full = count >= target && target > 0;
    return `<div class="slot">
      <div class="slot-top">
        <span class="slot-pos">${pos}</span>
        <span class="slot-count ${full ? 'full' : ''}">${count} / <input type="number" class="target-edit" data-pos="${pos}" value="${target}" min="0"></span>
      </div>
      <div class="bar-track"><div class="bar-fill ${full ? 'full' : ''}" style="width:${pct}%"></div></div>
    </div>`;
  }).join('');

  document.getElementById('rosterTag').textContent = `${totalDrafted} / ${totalTarget} SLOTS`;

  slotsEl.querySelectorAll('.target-edit').forEach(inp => {
    inp.addEventListener('change', e => {
      const pos = e.target.dataset.pos;
      const val = Math.max(0, parseInt(e.target.value) || 0);
      local.targets[pos] = val;
      saveLocal();
      renderScoreboard();
    });
  });
}

function renderRosterList() {
  const el = document.getElementById('rosterList');
  const mine = Object.entries(drafted)
    .filter(([id, d]) => isMine(d))
    .map(([id, d]) => ({ player: PLAYERS_BY_ID.get(Number(id)), pick: d.pick }))
    .filter(x => x.player)
    .sort((a, b) => (a.player.adp ?? 999) - (b.player.adp ?? 999));

  if (mine.length === 0) {
    el.innerHTML = '<div class="roster-empty">Aún no has draftado a nadie.<br>Usa "Es mío" en el board.</div>';
    return;
  }

  el.innerHTML = mine.map(({ player, pick }) => {
    let valueBadge = '';
    if (pick !== null && pick !== undefined && player.adp !== null) {
      const diff = Math.round((player.adp - pick) * 10) / 10;
      if (diff > 0.4) valueBadge = `<span class="value-badge value-good">+${diff}</span>`;
      else if (diff < -0.4) valueBadge = `<span class="value-badge value-bad">${diff}</span>`;
      else valueBadge = `<span class="value-badge value-neutral">±0</span>`;
    }
    const tier = effectiveTier(player);
    return `<div class="roster-item">
      <div class="ri-left">
        <span class="tier-chip tier-${tier}" style="width:20px;height:18px;font-size:10px;flex-shrink:0;">${tier}</span>
        <div>
          <div class="ri-name">${escapeHtml(player.name)}</div>
          <div class="ri-meta">${player.pos} · ${player.team || ''} · ADP ${fmtAdp(player.adp)}${pick ? ' · Pick ' + pick : ''}</div>
        </div>
      </div>
      ${valueBadge}
    </div>`;
  }).join('');
}

// ---------- Rankings (drag & drop custom order + tier editor) ----------
function renderProfileSelect() {
  const sel = document.getElementById('profileSelect');
  const profiles = local.rankingProfiles;
  sel.innerHTML = Object.keys(profiles).map(id =>
    `<option value="${id}" ${id === local.activeProfileId ? 'selected' : ''}>${escapeHtml(profiles[id].name)}</option>`
  ).join('');
  const sortOption = document.querySelector('#sortSelect option[value="custom"]');
  if (sortOption) sortOption.textContent = `Mis rankings (${activeProfile().name})`;
}

function visibleCustomOrder() {
  return activeProfile().order.filter(id => {
    const p = PLAYERS_BY_ID.get(id);
    return p && matchesFilters(p);
  });
}

function renderRankings() {
  renderProfileSelect();
  const el = document.getElementById('rankingsList');
  const order = activeProfile().order;
  const visible = visibleCustomOrder();
  if (visible.length === 0) {
    el.innerHTML = '<div class="empty-state">Ningún jugador coincide con estos filtros.</div>';
    return;
  }
  el.innerHTML = visible.map(id => {
    const p = PLAYERS_BY_ID.get(id);
    const tier = effectiveTier(p);
    const tierOptions = TIERS.map(t => `<option value="${t}" ${t === tier ? 'selected' : ''}>${t}</option>`).join('');
    return `<div class="rank-row" draggable="true" data-id="${id}">
      <div class="drag-handle">⋮⋮</div>
      <div class="rank-num">${order.indexOf(id) + 1}</div>
      <div class="pinfo"><span class="pname">${escapeHtml(p.name)}</span><span class="pteam">${p.team || ''}</span></div>
      <div class="pos-badge pos-${p.pos}">${p.pos}</div>
      <div class="rank-adp" title="ADP de referencia">${fmtAdp(p.adp)}</div>
      <select class="tier-select tier-${tier}" data-id="${id}">${tierOptions}</select>
      <div class="rank-move">
        <button data-move="up" data-id="${id}" title="Subir">▲</button>
        <button data-move="down" data-id="${id}" title="Bajar">▼</button>
      </div>
    </div>`;
  }).join('');
}

function moveCustom(id, delta) {
  const visible = visibleCustomOrder();
  const visIdx = visible.indexOf(id);
  const neighborId = visible[visIdx + delta];
  if (visIdx === -1 || neighborId === undefined) return;
  const order = activeProfile().order;
  const from = order.indexOf(id);
  order.splice(from, 1);
  const neighborIdx = order.indexOf(neighborId);
  order.splice(delta < 0 ? neighborIdx : neighborIdx + 1, 0, id);
  saveLocal();
  render();
}

function reorderCustom(dragId, targetId) {
  const order = activeProfile().order;
  const from = order.indexOf(dragId);
  let to = order.indexOf(targetId);
  if (from === -1 || to === -1) return;
  order.splice(from, 1);
  if (from < to) to -= 1;
  order.splice(to, 0, dragId);
  saveLocal();
  render();
}

// ---------- Ranking profiles (e.g. "Draft 12 equipos" vs "Draft 10 equipos") ----------
function createProfile(name, sourceProfile) {
  const id = genId();
  local.rankingProfiles[id] = sourceProfile
    ? { name, order: [...sourceProfile.order], tiers: { ...sourceProfile.tiers } }
    : { name, order: defaultOrder(), tiers: {} };
  local.activeProfileId = id;
  saveLocal();
  render();
}

function renameActiveProfile(name) {
  activeProfile().name = name;
  saveLocal();
  render();
}

function deleteActiveProfile() {
  const ids = Object.keys(local.rankingProfiles);
  if (ids.length <= 1) {
    alert('Necesitas al menos un perfil de ranking.');
    return;
  }
  delete local.rankingProfiles[local.activeProfileId];
  local.activeProfileId = Object.keys(local.rankingProfiles)[0];
  saveLocal();
  render();
}

// ---------- Render all ----------
function render() {
  renderBoard();
  renderScoreboard();
  renderRosterList();
  renderRankings();
}

// ---------- Modals ----------
function openProfileModal() {
  document.getElementById('profileInput').value = local.myName;
  document.getElementById('profileModalOverlay').classList.add('open');
  setTimeout(() => document.getElementById('profileInput').focus(), 50);
}
function closeProfileModal() {
  document.getElementById('profileModalOverlay').classList.remove('open');
}

function openLoginGate() {
  document.getElementById('loginNameInput').value = '';
  document.getElementById('loginModalOverlay').classList.add('open');
  setTimeout(() => document.getElementById('loginNameInput').focus(), 50);
}
function closeLoginGate() {
  document.getElementById('loginModalOverlay').classList.remove('open');
}

function updateRoomUI() {
  const label = document.getElementById('roomLabel');
  const chip = document.getElementById('roomBtn');
  if (local.roomId) {
    label.textContent = local.roomId;
    chip.classList.add('live');
  } else {
    label.textContent = 'Local';
    chip.classList.remove('live');
  }
  document.getElementById('profileLabel').textContent = local.myName;
}

async function openRoomModal() {
  const disabledEl = document.getElementById('roomModalDisabled');
  const enabledEl = document.getElementById('roomModalEnabled');
  const noRoomEl = document.getElementById('roomModalNoRoom');
  const inRoomEl = document.getElementById('roomModalInRoom');
  document.getElementById('roomModalOverlay').classList.add('open');

  if (!firebaseEnabled) {
    disabledEl.style.display = 'block';
    enabledEl.style.display = 'none';
    return;
  }
  disabledEl.style.display = 'none';
  enabledEl.style.display = 'block';
  if (local.roomId) {
    noRoomEl.style.display = 'none';
    inRoomEl.style.display = 'block';
    document.getElementById('currentRoomCode').textContent = local.roomId;
  } else {
    noRoomEl.style.display = 'block';
    inRoomEl.style.display = 'none';
  }
}
function closeRoomModal() {
  document.getElementById('roomModalOverlay').classList.remove('open');
}

function updateFiltersVisibility(view) {
  document.getElementById('filtersBar').style.display = view === 'team' ? 'none' : '';
  document.getElementById('sortFilterGroup').style.display = view === 'board' ? '' : 'none';
}

// ---------- Theme ----------
function applyTheme() {
  document.documentElement.setAttribute('data-theme', local.theme);
  const icon = document.getElementById('themeIcon');
  icon.innerHTML = local.theme === 'light'
    ? '<path d="M21 12.5A9 9 0 1 1 11.5 3a7 7 0 0 0 9.5 9.5Z"/>'
    : '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
}

// ---------- Wire up events ----------
function wireEvents() {
  document.getElementById('board').addEventListener('click', e => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = parseInt(btn.dataset.id);
    const action = btn.dataset.action;
    if (action === 'mine') {
      draftPlayer(id, local.myName, nextPickNumber());
    } else if (action === 'other') {
      draftPlayer(id, 'Rival', nextPickNumber());
    } else if (action === 'undo') {
      undoPlayer(id);
    }
  });

  document.getElementById('resetBtn').addEventListener('click', () => {
    if (confirm('¿Reiniciar todo el draft? Esto borrará todos los jugadores marcados.')) {
      if (local.roomId && fb) {
        fb.firestore.setDoc(roomRef(), { drafted: {}, createdAt: fb.firestore.serverTimestamp() }).catch(e => console.error(e));
      } else {
        drafted = {};
        saveSoloDrafted();
      }
      historyStack = [];
      updateUndoButtonState();
      render();
    }
  });

  // Nav tabs
  document.getElementById('navTabs').addEventListener('click', e => {
    const btn = e.target.closest('button[data-view]'); if (!btn) return;
    const view = btn.dataset.view;
    document.getElementById('viewRoot').className = 'view-root view-' + view;
    [...document.getElementById('navTabs').querySelectorAll('button')].forEach(b => b.classList.toggle('active', b === btn));
    updateFiltersVisibility(view);
    render();
  });

  // Rankings interactions
  const rankingsList = document.getElementById('rankingsList');
  rankingsList.addEventListener('click', e => {
    const moveBtn = e.target.closest('button[data-move]');
    if (moveBtn) {
      const id = parseInt(moveBtn.dataset.id);
      moveCustom(id, moveBtn.dataset.move === 'up' ? -1 : 1);
    }
  });
  rankingsList.addEventListener('change', e => {
    const sel = e.target.closest('.tier-select');
    if (!sel) return;
    const id = parseInt(sel.dataset.id);
    const player = PLAYERS_BY_ID.get(id);
    const tiers = activeProfile().tiers;
    if (sel.value === player.tier) delete tiers[id];
    else tiers[id] = sel.value;
    saveLocal();
    render();
  });
  rankingsList.addEventListener('dragstart', e => {
    const row = e.target.closest('.rank-row'); if (!row) return;
    dragId = parseInt(row.dataset.id);
    row.classList.add('dragging');
  });
  rankingsList.addEventListener('dragend', e => {
    const row = e.target.closest('.rank-row'); if (row) row.classList.remove('dragging');
    rankingsList.querySelectorAll('.drag-over').forEach(r => r.classList.remove('drag-over'));
  });
  rankingsList.addEventListener('dragover', e => {
    e.preventDefault();
    const row = e.target.closest('.rank-row'); if (!row) return;
    row.classList.add('drag-over');
  });
  rankingsList.addEventListener('dragleave', e => {
    const row = e.target.closest('.rank-row'); if (row) row.classList.remove('drag-over');
  });
  rankingsList.addEventListener('drop', e => {
    e.preventDefault();
    const row = e.target.closest('.rank-row');
    if (row) row.classList.remove('drag-over');
    if (!row || dragId === null) return;
    const targetId = parseInt(row.dataset.id);
    if (targetId !== dragId) reorderCustom(dragId, targetId);
    dragId = null;
  });

  document.getElementById('resetRankingsBtn').addEventListener('click', () => {
    if (confirm('¿Restablecer el orden y los tiers de este perfil?')) {
      const profile = activeProfile();
      profile.order = defaultOrder();
      profile.tiers = {};
      saveLocal();
      render();
    }
  });

  // Ranking profiles
  document.getElementById('profileSelect').addEventListener('change', e => {
    local.activeProfileId = e.target.value;
    saveLocal();
    render();
  });
  document.getElementById('newProfileBtn').addEventListener('click', () => {
    const name = prompt('Nombre del nuevo perfil (ej. "Draft 12 equipos"):');
    if (name && name.trim()) createProfile(name.trim());
  });
  document.getElementById('duplicateProfileBtn').addEventListener('click', () => {
    const base = activeProfile();
    const name = prompt('Nombre para la copia:', base.name + ' (copia)');
    if (name && name.trim()) createProfile(name.trim(), base);
  });
  document.getElementById('renameProfileBtn').addEventListener('click', () => {
    const name = prompt('Nuevo nombre del perfil:', activeProfile().name);
    if (name && name.trim()) renameActiveProfile(name.trim());
  });
  document.getElementById('deleteProfileBtn').addEventListener('click', () => {
    if (confirm(`¿Eliminar el perfil "${activeProfile().name}"?`)) deleteActiveProfile();
  });

  // Undo
  document.getElementById('undoBtn').addEventListener('click', globalUndo);

  // Theme
  document.getElementById('themeToggle').addEventListener('click', () => {
    local.theme = local.theme === 'dark' ? 'light' : 'dark';
    saveLocal();
    applyTheme();
  });

  // Profile
  document.getElementById('profileBtn').addEventListener('click', openProfileModal);
  document.getElementById('profileConfirm').addEventListener('click', () => {
    const val = document.getElementById('profileInput').value.trim();
    if (val) local.myName = val;
    saveLocal();
    updateRoomUI();
    render();
    closeProfileModal();
  });
  document.getElementById('profileCancel').addEventListener('click', closeProfileModal);
  document.getElementById('profileModalOverlay').addEventListener('click', e => {
    if (e.target.id === 'profileModalOverlay') closeProfileModal();
  });
  document.getElementById('logoutBtn').addEventListener('click', () => {
    local.myName = '';
    saveLocal();
    updateRoomUI();
    render();
    closeProfileModal();
    openLoginGate();
  });

  // Login gate (no password for now — just a name to identify your picks)
  document.getElementById('loginConfirm').addEventListener('click', () => {
    const val = document.getElementById('loginNameInput').value.trim();
    if (!val) { document.getElementById('loginNameInput').focus(); return; }
    local.myName = val;
    saveLocal();
    updateRoomUI();
    render();
    closeLoginGate();
  });
  document.getElementById('loginNameInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('loginConfirm').click();
  });

  // Room / multiplayer
  document.getElementById('roomBtn').addEventListener('click', openRoomModal);
  document.getElementById('roomModalOverlay').addEventListener('click', e => {
    if (e.target.id === 'roomModalOverlay') closeRoomModal();
  });
  document.getElementById('roomModalCloseOnly').addEventListener('click', closeRoomModal);
  document.getElementById('roomModalCloseOnly2').addEventListener('click', closeRoomModal);
  document.getElementById('roomModalCancel').addEventListener('click', closeRoomModal);
  document.getElementById('createRoomBtn').addEventListener('click', async () => {
    await createRoom();
    openRoomModal();
  });
  document.getElementById('joinRoomBtn').addEventListener('click', async () => {
    const code = document.getElementById('joinRoomInput').value.trim().toUpperCase();
    if (!code) return;
    const url = new URL(location.href);
    url.searchParams.set('room', code);
    history.replaceState(null, '', url.toString());
    await joinRoom(code);
    openRoomModal();
  });
  document.getElementById('leaveRoomBtn').addEventListener('click', () => {
    leaveRoom();
    openRoomModal();
  });
  document.getElementById('copyLinkBtn').addEventListener('click', () => {
    navigator.clipboard?.writeText(location.href).then(() => flashSaved(true, 'Enlace copiado'))
      .catch(() => flashSaved(false, 'No se pudo copiar'));
  });
}

// ---------- Init ----------
async function init() {
  loadLocal();
  applyTheme();
  buildFilterPills();
  wireEvents();
  updateUndoButtonState();
  updateRoomUI();
  updateFiltersVisibility('board');
  filters.sort = local.sort;
  document.getElementById('sortSelect').value = local.sort;

  const urlRoom = new URL(location.href).searchParams.get('room');
  if (urlRoom && firebaseEnabled) {
    await joinRoom(urlRoom.toUpperCase());
  } else {
    loadSoloDrafted();
    render();
  }

  if (!local.myName) openLoginGate();
}
init();

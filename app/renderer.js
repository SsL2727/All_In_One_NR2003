// Capture renderer failures before feature cards and their polling start. A
// synchronous error in one of those optional sections used to stop this file
// before the installation picker and saved configuration were initialized.
window.addEventListener('error', (event) => {
  const message = event?.error?.stack || event?.message || 'Unknown renderer error';
  console.error('[renderer] uncaught error:', message);
  const box = document.getElementById('error-msg');
  if (box) {
    box.textContent = `App startup error: ${event?.message || message}`;
    box.style.display = 'block';
  }
});
window.addEventListener('unhandledrejection', (event) => {
  const message = event?.reason?.stack || event?.reason?.message || String(event?.reason || 'Unknown rejection');
  console.error('[renderer] unhandled rejection:', message);
  const box = document.getElementById('error-msg');
  if (box) {
    box.textContent = `App startup error: ${event?.reason?.message || message}`;
    box.style.display = 'block';
  }
});

// ── Elements ───────────────────────────────────────────────────────────────
const bridgeDot      = document.getElementById('bridge-dot');
const shimDot        = document.getElementById('shim-dot');
const nr2003Path     = document.getElementById('nr2003-path');
const browseBtn      = document.getElementById('browse-btn');
const playerSelect   = document.getElementById('player-select');
const seriesSelect   = document.getElementById('series-select');
const refreshBtn     = document.getElementById('refresh-btn');
const profileSelect  = document.getElementById('profile-select');
const newProfileBtn  = document.getElementById('new-profile-btn');
const renProfileBtn  = document.getElementById('ren-profile-btn');
const delProfileBtn  = document.getElementById('del-profile-btn');
const layoutBtn      = document.getElementById('layout-card');  // now a card not a button
const seriesEditorBtn = document.getElementById('series-editor-card');
const driverInfoBtn = document.getElementById('driver-info-card');
const championshipBtn  = document.getElementById('championship-card');
const launchBtn      = document.getElementById('launch-btn');
const errorMsg       = document.getElementById('error-msg');

// New design status labels
const bridgeStatusLabel = document.getElementById('bridge-status-label');
const shimStatusLabel   = document.getElementById('shim-status-label');
const playerStatusLabel = document.getElementById('player-status-label');
const nr2003StatusLabel = document.getElementById('nr2003-status-label');
const stageCard         = document.getElementById('stage-card');
const stageBadge        = document.getElementById('stage-badge');
const stageDesc         = document.getElementById('stage-desc');
const stageCta          = document.getElementById('stage-cta');

// ── State ──────────────────────────────────────────────────────────────────
let config = {};

// ── Helpers ────────────────────────────────────────────────────────────────
function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.style.display = 'block';
  setTimeout(() => { errorMsg.style.display = 'none'; }, 4000);
}

function updateLaunchBtn() {
  const hasNr2003  = !!config.nr2003_exe;
  const hasPlayer  = !!config.playerFolder;
  launchBtn.disabled = !hasNr2003 || !hasPlayer;

  if (nr2003StatusLabel) {
    nr2003StatusLabel.className = hasNr2003 ? 'status-ready' : 'status-missing';
  }
  if (playerStatusLabel) {
    playerStatusLabel.className = hasPlayer ? 'status-ready' : 'status-missing';
  }
}

// Keep the install selection usable even if an unrelated feature card fails
// during startup. These declarations are function-scoped and safe to call here.
if (browseBtn) {
  browseBtn.addEventListener('click', async () => {
    browseBtn.disabled = true;
    try {
      const p = await window.shl.browseNR2003();
      if (p && typeof p === 'object' && p.error) throw new Error(p.error);
      if (p) {
        config.nr2003_exe = p;
        nr2003Path.textContent = p;
        nr2003Path.classList.add('set');
        updateLaunchBtn();
        await loadPlayers();
      }
    } catch (e) {
      showError(`Could not open the NR2003 picker: ${e?.message || e}`);
      console.error('[renderer] NR2003 picker failed:', e);
    } finally {
      browseBtn.disabled = false;
    }
  });
}

// Start loading persisted settings before optional feature-card code runs.
// init() is a declaration, so it is available here despite appearing below.
init().catch((err) => {
  console.error('[renderer] init() failed:', err);
  showError('Startup failed: ' + (err?.message || String(err)));
});

// Layout card click
if (layoutBtn) {
  layoutBtn.addEventListener('click', () => window.shl.openLayout());
  seriesEditorBtn?.addEventListener('click', () => window.shl.openSeriesEditor());
  document.getElementById('tv-director-card')?.addEventListener('click', () => window.shl.openMobileTab(''));   // the web app, on the tab it was last left on
  championshipBtn?.addEventListener('click',  () => window.shl.openChampionshipWindow());
}

// Stage card click — opens stage racing window
if (stageCard) {
  stageCard.addEventListener('click', () => window.shl.openStageRaceWindow());
}

// AIMOD & AI tweaks card — opens the AI window; status polled from the main process
const aiCard = document.getElementById('ai-card');
if (aiCard) {
  aiCard.addEventListener('click', () => window.shl.openAiWindow());
  const aiBadge = document.getElementById('ai-badge');
  const aiDesc  = document.getElementById('ai-desc');
  const paintAi = (s, am) => {
    let label = 'OFF', cls = 'feat-badge stage-off', text = 'AIMOD pit strategy (built in) + AI Editing tweaks';
    const live = !!(am && am.enabled && !am.note);
    if (live) { label = am.dryRun ? 'AIMOD TEST' : 'AIMOD ON'; cls = 'feat-badge stage-on'; text = am.dryRun ? 'AIMOD pit strategy is running in read-only test mode' : 'AIMOD is running the AI pit strategy'; }
    else if (am && am.note) { label = 'PAUSED'; text = am.note; }
    if (s && s.config && s.config.enabled && s.attached && s.build && s.build.ok) text += ' \u00b7 tweaks ' + (s.dryRun ? 'in test mode' : 'active');
    aiBadge.textContent = label; aiBadge.className = cls; aiDesc.textContent = text;
    aiCard.classList.toggle('active', live);
  };
  const pollAi = () => Promise.all([
    window.shl.ai.getState().catch(() => null),
    window.shl.aimod.getState().catch(() => null),
  ]).then(([s, am]) => paintAi(s, am));
  pollAi(); setInterval(pollAi, 2000);
}

// AI Enhanced card
const rlCard = document.getElementById('racelab-card');
if (rlCard && window.shl.racelab) {
  rlCard.addEventListener('click', () => window.shl.openRaceLabWindow());
  const rlBadge = document.getElementById('racelab-badge'), rlDesc = document.getElementById('racelab-desc');
  const paintRl = (s) => {
    const on = !!(s && s.enabled && s.found);
    rlBadge.textContent = !s || !s.found ? 'NOT FOUND' : s.active ? 'RUNNING' : on ? 'ON' : 'OFF';
    rlBadge.className = 'feat-badge ' + (on || (s && s.active) ? 'stage-on' : 'stage-off');
    rlDesc.textContent = !s || !s.found ? "Choose RaceLab's folder: tire failures, crash panels & soft body, traffic, drafting rows, allies / rivals, Career"
      : s.active ? 'Running in the game (' + (s.bodyMode || '') + ')' : on ? 'Starts with NR2003 (' + (s.bodyMode || '') + ')' : 'Not launched with NR2003';
    rlCard.classList.toggle('active', on);
  };
  const pollRl = () => window.shl.racelab.state().then(paintRl).catch(() => {});
  pollRl(); setInterval(pollRl, 4000);
}
// Dynamic Rubber card
const rbCard = document.getElementById('rubber-card');
if (rbCard && window.shl.rubber) {
  rbCard.addEventListener('click', () => window.shl.rubber.openWindow());
  const rbBadge = document.getElementById('rubber-badge'), rbDesc = document.getElementById('rubber-desc');
  const paintRb = (s) => {
    const on = !!(s && s.ok && s.installed && s.enabled);
    rbBadge.textContent = !s || !s.ok ? 'NOT SET UP' : !s.installed ? 'NOT INSTALLED' : on ? 'ON' : 'OFF';
    rbBadge.className = 'feat-badge ' + (on ? 'stage-on' : 'stage-off');
    rbDesc.textContent = !s || !s.ok ? 'Tire rubber builds up on every car\'s paint as the race goes on' : !s.installed ? 'Not installed: open to install it (ReShade add-on)' : on ? 'On: rubber builds up on the cars during a race' : 'Installed, switched off';
    rbCard.classList.toggle('active', on);
  };
  const pollRb = () => window.shl.rubber.state().then(paintRb).catch(() => {});
  pollRb(); setInterval(pollRb, 6000);
}
const aieCard = document.getElementById('aie-card');
if (aieCard && window.shl.aie) {
  aieCard.addEventListener('click', () => window.shl.aie.openWindow());
  const aieBadge = document.getElementById('aie-badge'), aieDesc = document.getElementById('aie-desc');
  const paintAie = (s) => {
    const on = !!(s && s.onStart);
    aieBadge.textContent = s && s.running ? 'RUNNING' : (on ? 'ON START' : 'OFF'); aieBadge.className = 'feat-badge ' + (on || (s && s.running) ? 'stage-on' : 'stage-off');
    aieDesc.textContent = on ? 'Starts with All In One NR2003' : 'Launch AI Enhanced with All In One NR2003';
    aieCard.classList.toggle('active', on);
  };
  const pollAie = () => window.shl.aie.launchGet().then(paintAie).catch(() => {});
  pollAie(); setInterval(pollAie, 2500);
}

// Superspeedway Lines card
const sslCard = document.getElementById('ssl-card');
if (sslCard && window.shl.ssline) {
  sslCard.addEventListener('click', () => window.shl.ssline.openWindow());
  const sslBadge = document.getElementById('ssl-badge'), sslDesc = document.getElementById('ssl-desc');
  const paintSsl = (s) => {
    let label = 'OFF', cls = 'feat-badge stage-off', text = 'AI hold drafting grooves at Daytona & Talladega';
    if (s && s.enabled) {
      cls = 'feat-badge stage-on';
      if (s.note) { label = 'PAUSED'; text = s.note; }
      else if (s.foreign && !s.sharing) { label = 'PAUSED'; text = 'Another program is moving the race line (AI Enhanced MultiGroove?)'; }
      else if (!s.attached) { label = 'WAITING'; text = 'Waiting for NR2003'; }
      else if (!s.eligible) { label = 'IDLE'; text = s.track ? s.track + ': not a superspeedway' : 'No track loaded'; }
      else if (s.lines.state !== 'found') { label = 'SCANNING'; text = s.track + ': finding the lap lines'; }
      else if (!s.green) { label = s.dryRun ? 'TEST' : 'READY'; text = s.track + ': waiting for green'; }
      else { label = s.dryRun ? 'TEST' : (s.sharing ? 'SHARING' : 'LIVE'); const c = (s.stats && s.stats.cars) || [0, 0, 0]; text = (s.sharing ? 'With ' + (s.foreignWho || 'AI Enhanced') + ' - grooves: ' : 'Grooves: ') + c.slice(0, s.lanes).join(' / ') + ' cars, ' + ((s.stats && s.stats.passes) || 0) + ' passes'; }
    }
    sslBadge.textContent = label; sslBadge.className = cls; sslDesc.textContent = text;
    sslCard.classList.toggle('active', !!(s && s.enabled));
  };
  const pollSsl = () => window.shl.ssline.getState().then(paintSsl).catch(() => {});
  pollSsl(); setInterval(pollSsl, 2000);
}

// RaceVision card — opens the RaceVision window (All In One NR2003 starts it, shows its remote page and adds extra options)
const rvCard = document.getElementById('rv-card');
if (rvCard && window.shl.tv) {
  rvCard.addEventListener('click', () => window.shl.tv.openWindow());
  const rvBadge = document.getElementById('rv-badge');
  const rvDesc  = document.getElementById('rv-desc');
  const paintTv = (s) => {
    let label = 'OFF', cls = 'feat-badge stage-off', text = 'TV director: cameras, broadcast graphics, phone remote';
    if (s && s.enabled) {
      label = s.note ? 'PAUSED' : (s.attached ? (s.dryRun ? 'TEST' : 'LIVE') : 'WAITING'); cls = 'feat-badge stage-on';
      const c = s.director && s.director.cur;
      text = s.note || (c ? 'On TV: #' + ((s.field.find(x => x.slot === c.slot) || {}).num || c.slot) + ' (' + c.kind + ')' : (s.attached ? 'Director is watching the race' : 'Waiting for NR2003'));
    }
    rvBadge.textContent = label; rvBadge.className = cls; rvDesc.textContent = text;
    rvCard.classList.toggle('active', !!(s && s.enabled));
  };
  const pollTv = () => window.shl.tv.getState().then(paintTv).catch(() => {});
  pollTv(); setInterval(pollTv, 2500);
} else if (rvCard && window.shl.racevision) {
  rvCard.addEventListener('click', () => window.shl.racevision.openWindow());
  const rvBadge = document.getElementById('rv-badge');
  const rvDesc  = document.getElementById('rv-desc');
  const paintRv = (s) => {
    let label = 'OFF', cls = 'feat-badge stage-off', text = 'TV director: cameras, broadcast graphics, phone remote';
    if (s && !s.installed) { label = 'NOT FOUND'; text = 'Point All In One NR2003 at RaceVision.exe'; }
    else if (s && s.reachable) { label = s.live && s.live.attached ? 'LIVE' : 'READY'; cls = 'feat-badge stage-on'; text = s.live && s.live.on ? ('On TV: #' + s.live.on.num + ' ' + s.live.on.name) : 'RaceVision is running'; }
    else if (s && s.running) { label = 'RUNNING'; cls = 'feat-badge stage-on'; text = 'RaceVision is running'; }
    if (s && s.fix && s.fix.state === 'applied' && s.running) text += ' \u00b7 MPH fixed';
    rvBadge.textContent = label; rvBadge.className = cls; rvDesc.textContent = text;
    rvCard.classList.toggle('active', !!(s && s.running));
  };
  const pollRv = () => window.shl.racevision.getState().then(paintRv).catch(() => {});
  pollRv(); setInterval(pollRv, 2500);
}

const companionsCard = document.getElementById('companions-card');
if (companionsCard) companionsCard.addEventListener('click', () => window.shl.openCompanionsWindow());

// Season tracker card — opens the season manager; status comes from the
// season server's event stream (same feed the season overlay uses)
const seasonCard = document.getElementById('season-card');
if (seasonCard) {
  seasonCard.addEventListener('click', () => window.shl.openSeasonWindow());
  const badge = document.getElementById('season-badge');
  const desc  = document.getElementById('season-desc');
  const paint = (st) => {
    if (!st || !st.season) {
      badge.textContent = 'NO SEASON'; badge.className = 'feat-badge stage-off';
      desc.textContent  = 'Create a season to track points, stage points & The Chase';
      seasonCard.classList.remove('active');
      return;
    }
    const s = st.standings || {};
    const lead = s.leader ? `${s.leader.name} leads (${s.leader.points})` : 'No races yet';
    const racing = st.tracker && st.tracker.phase === 'racing';
    badge.textContent = st.requireArm && st.enabled ? (st.armed ? (racing ? 'COUNTING' : 'NEXT RACE COUNTS') : 'NOT COUNTING') : (racing ? 'LIVE' : (st.enabled ? 'TRACKING' : 'PAUSED'));
    badge.className = 'feat-badge ' + (st.enabled && (!st.requireArm || st.armed) ? 'stage-on' : 'stage-off');
    desc.innerHTML = `<b>${st.season.name}</b><br>Race ${s.racesRun || 0}/${s.totalRaces || '?'} — ${lead}`;
    seasonCard.classList.toggle('active', !!st.enabled);
    if (armBtn) {
      armBtn.style.display = st.requireArm && st.enabled ? '' : 'none';
      armBtn.textContent = st.armed ? '✔ This race counts — cancel' : (racing ? 'Count this race' : 'Count the next race');
      armBtn.dataset.armed = st.armed ? '1' : '';
    }
  };
  // a race counts for the season only when the user activates it (Season Manager option, on by default)
  const armBtn = document.getElementById('season-arm');
  if (armBtn) armBtn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const r = await window.shl.season.arm(!armBtn.dataset.armed);
    if (r && r.ok === false) alert(r.error || 'Could not change it');
  });
  try {
    const port = (config && config.season && config.season.port) || 8769;
    const es = new EventSource(`http://127.0.0.1:${port}/season/events`);
    es.addEventListener('state', (e) => { try { paint(JSON.parse(e.data)); } catch (_) {} });
  } catch (_) {}
}

// ── Series ─────────────────────────────────────────────────────────────────
async function loadSeries() {
  const series = await window.shl.getSeries();
  seriesSelect.innerHTML = '';
  if (!series.length) {
    seriesSelect.innerHTML = '<option value="">— No series folders found —</option>';
    return;
  }
  for (const s of series) {
    const opt       = document.createElement('option');
    opt.value       = s.id;
    opt.textContent = s.id === 'default' ? s.name : s.id;
    if (s.id === config.series) opt.selected = true;
    seriesSelect.appendChild(opt);
  }
  if (!config.series && series.length > 0) {
    seriesSelect.value = series[0].id;
    await window.shl.setSeries(series[0].id);
    config.series = series[0].id;
  }
}

// ── Profiles ───────────────────────────────────────────────────────────────
async function loadProfiles() {
  const { profiles, active } = await window.shl.getProfiles();
  profileSelect.innerHTML = '';
  for (const name of profiles) {
    const opt       = document.createElement('option');
    opt.value       = name;
    opt.textContent = name;
    if (name === active) opt.selected = true;
    profileSelect.appendChild(opt);
  }
  // Can't rename or delete Default profile
  delProfileBtn.disabled = active === 'Default';
  renProfileBtn.disabled = active === 'Default';
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  config = await window.shl.getConfig();
  if (config.nr2003_exe) {
    nr2003Path.textContent = config.nr2003_exe;
    nr2003Path.classList.add('set');
  }
  await loadPlayers();
  updateLaunchBtn();
  await loadSeries();
  await loadProfiles();

  // NR2003 Background (built in): video and sound go on when the game's window loses focus
  const bgOn = document.getElementById('bg-on'), bgAudio = document.getElementById('bg-audio-only'), bgNote = document.getElementById('bg-note');
  if (bgOn && bgAudio && window.shl.backgroundGet) {
    const paintBg = (st) => { if (!st) return; bgOn.checked = !!st.on; bgAudio.checked = !!st.audioOnly; bgAudio.disabled = !st.on; };
    paintBg(await window.shl.backgroundGet());
    bgOn.addEventListener('change', async () => paintBg(await window.shl.backgroundSet({ on: bgOn.checked })));
    bgAudio.addEventListener('change', async () => paintBg(await window.shl.backgroundSet({ audioOnly: bgAudio.checked })));
  }

  // Hardware acceleration toggle
  const hwAccelChk = document.getElementById('disable-hw-accel');
  if (hwAccelChk) {
    hwAccelChk.checked = !!config.disableHardwareAcceleration;
    hwAccelChk.addEventListener('change', () => {
      config.disableHardwareAcceleration = hwAccelChk.checked;
      window.shl.saveConfig(config);
      if (hwAccelChk.checked) {
        alert('Hardware acceleration disabled. Restart PSF for this to take effect.');
      } else {
        alert('Hardware acceleration enabled. Restart PSF for this to take effect.');
      }
    });
  }

  // Hotkey — default to Ctrl+Shift+E on first run
  if (config.editHotkey) {
    hotkeyDisplay.textContent = config.editHotkey;
  } else {
    hotkeyDisplay.textContent = 'Ctrl+Shift+E';
    window.shl.setEditHotkey('Ctrl+Shift+E');
  }

  // Reopen overlays hotkey — default to Ctrl+Shift+R on first run
  if (config.reopenHotkey) {
    reopenHotkeyDisplay.textContent = config.reopenHotkey;
  } else {
    reopenHotkeyDisplay.textContent = 'Ctrl+Shift+R';
    window.shl.setReopenHotkey('Ctrl+Shift+R');
  }

  // Resync standings hotkey
  if (config.resyncHotkey) {
    resyncHotkeyDisplay.textContent = config.resyncHotkey;
  }
  if (config.pointsHotkey) {
    pointsHotkeyDisplay.textContent = config.pointsHotkey;
  }
  if (config.top3Hotkey) {
    top3HotkeyDisplay.textContent = config.top3Hotkey;
  }
  if (config.driverInfoHotkey) {
    driverInfoHotkeyDisplay.textContent = config.driverInfoHotkey;
  }

  // Streaming IP
  streamIpInput.value = config.streamIp || '';
  // Snap saved config to nearest refresh rate mode
  if (perfModeSelect) {
    const divisor = config.telemetryDivisor || 1;
    const physics = config.physicsRate || false;
    if (physics)         perfModeSelect.value = 'ultra';
    else if (divisor <= 1) perfModeSelect.value = 'high';
    else if (divisor <= 4) perfModeSelect.value = 'medium';
    else if (divisor <= 12) perfModeSelect.value = 'low';
    else                   perfModeSelect.value = 'verylow';
  }
  const lsEnabled = config.liveStandingsEnabled !== false;
  if (scoringModeSelect) scoringModeSelect.value = lsEnabled ? 'live' : 'official';

}

// ── Event listeners ────────────────────────────────────────────────────────
async function loadPlayers() {
  const players = await window.shl.scanPlayers();
  playerSelect.innerHTML = '';
  if (!players || players.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = config.nr2003_exe ? '— No player folders found —' : '— Select NR2003 first —';
    playerSelect.appendChild(opt);
    return;
  }

  // If only one player folder, auto-select it (skip blank option)
  if (players.length === 1 && !config.playerFolder) {
    config.playerFolder = players[0].folder;
    window.shl.setPlayerFolder(config.playerFolder);
  }

  // Blank option — only add if more than one player
  if (players.length > 1) {
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '— Select your profile —';
    playerSelect.appendChild(blank);
  }

  players.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.folder;
    opt.textContent = p.label;
    if (p.folder === config.playerFolder) opt.selected = true;
    playerSelect.appendChild(opt);
  });
}

playerSelect.addEventListener('change', () => {
  config.playerFolder = playerSelect.value || '';
  window.shl.setPlayerFolder(config.playerFolder);
  updateLaunchBtn();
});

refreshBtn.addEventListener('click', () => loadSeries());

seriesSelect.addEventListener('change', async () => {
  const id = seriesSelect.value;
  if (id) {
    config.series = id;
    await window.shl.setSeries(id);
  }
});

profileSelect.addEventListener('change', async () => {
  const name = profileSelect.value;
  await window.shl.setActiveProfile(name);
  delProfileBtn.disabled = name === 'Default';
  renProfileBtn.disabled = name === 'Default';
});

newProfileBtn.addEventListener('click', async () => {
  const name = await window.shl.showInputDialog({ title: 'New Profile', label: 'Profile name:' });
  if (!name) return;
  const ok = await window.shl.newProfile(name);
  if (ok) {
    await loadProfiles();
  } else {
    showError('Profile name already exists or is invalid.');
  }
});

renProfileBtn.addEventListener('click', async () => {
  const oldName = profileSelect.value;
  if (oldName === 'Default') { showError('Cannot rename the Default profile.'); return; }
  const newName = await window.shl.showInputDialog({ title: 'Rename Profile', label: `Rename "${oldName}" to:` });
  if (!newName) return;
  const ok = await window.shl.renameProfile(oldName, newName.trim());
  if (ok) {
    await loadProfiles();
  } else {
    showError('That name is already taken or invalid.');
  }
});
delProfileBtn.addEventListener('click', async () => {
  const name = profileSelect.value;
  if (name === 'Default') return;
  if (!confirm(`Delete profile "${name}"?`)) return;
  await window.shl.deleteProfile(name);
  await loadProfiles();
});

let _shimRunning = false;

launchBtn.addEventListener('click', async () => {
  launchBtn.disabled = true;
  launchBtn.textContent = 'STARTING...';
  await window.shl.launchNR2003();
});

window.shl.onCountdown(count => {
  if (_shimRunning) return;
  if (count === null) {
    launchBtn.textContent = '▶  LAUNCHING NR2003...';
  } else if (typeof count === 'string') {
    launchBtn.textContent = count;
  } else {
    launchBtn.textContent = `▶  LAUNCHING IN ${count}...`;
  }
});

// ── IPC events ─────────────────────────────────────────────────────────────
window.shl.onBridgeStatus(on => {
  bridgeDot.className = `dot ${on ? 'on' : 'off'}`;
  if (bridgeStatusLabel) {
    bridgeStatusLabel.className = on ? 'status-ready' : 'status-missing';
    bridgeStatusLabel.textContent = '● Bridge';
  }
  // Gate stage card on bridge status
  if (stageCard) {
    stageCard.style.pointerEvents = on ? '' : 'none';
    stageCard.style.opacity = on ? '' : '0.4';
  }
});

window.shl.onShimStatus(on => {
  shimDot.className = `dot ${on ? 'on' : 'off'}`;
  if (shimStatusLabel) {
    shimStatusLabel.className = on ? 'status-ready' : 'status-missing';
    shimStatusLabel.textContent = '● Shim';
  }
  const reopenBtn = document.getElementById('reopen-btn');
  if (reopenBtn) reopenBtn.style.display = on ? '' : 'none';
});

window.shl.onNR2003Status(on => {
  _shimRunning = on;
  if (on) {
    launchBtn.disabled = true;
    launchBtn.textContent = '■  NR2003 RUNNING';
    launchBtn.style.background = 'linear-gradient(135deg, #1a3d27 0%, #27ae60 50%, #1a3d27 100%)';
    launchBtn.style.borderColor = '#2ecc71';
    launchBtn.style.opacity = '';
  } else {
    launchBtn.disabled = !config.nr2003_exe || !config.playerFolder;
    launchBtn.textContent = '▶  Launch NR2003';
    launchBtn.style.background = '';
    launchBtn.style.borderColor = '';
    launchBtn.style.opacity = '';
  }
});

document.getElementById('reopen-btn').addEventListener('click', () => {
  window.shl.reopenOverlays();
});
window.shl.onStageRaceStatus(active => {
  if (!stageCard) return;
  stageCard.classList.toggle('active', active);
  if (stageBadge) {
    stageBadge.className = active ? 'feat-badge stage-on' : 'feat-badge stage-off';
    stageBadge.textContent = active ? 'ACTIVE' : 'INACTIVE';
  }
  if (stageDesc) {
    stageDesc.className = active ? 'feat-desc active' : 'feat-desc';
    stageDesc.textContent = active
      ? 'Stages run by RaceControl, at these stages'
      : 'Open to set the stages and how they end';
  }
  if (stageCta) {
    stageCta.textContent = active ? 'Close window to disable →' : 'Open stage racing →';
  }
});

window.shl.onError(msg => showError(msg));

document.getElementById('data-folder-btn').addEventListener('click', () => {
  window.shl.openDataFolder();
});

document.getElementById('racestats-open-btn')?.addEventListener('click', () => {
  window.shl.openRacestats();
});

// Mobile web (QR): link of the phone page (Driver Info editor + Race Stats)
(function () {
  const modal = document.getElementById('mobile-modal'), cv = document.getElementById('mobile-qr');
  const ipSel = document.getElementById('mobile-ip'), urlEl = document.getElementById('mobile-url'), hint = document.getElementById('mobile-hint');
  let urls = [];
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function drawQR(text) {
    const g = cv.getContext('2d'), size = 220;
    try {
      const m = qrMatrix(text), n = m.length, q = 4, px = Math.floor(size / (n + q * 2));
      cv.width = cv.height = (n + q * 2) * px; cv.style.width = cv.style.height = size + 'px';
      g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); g.fillStyle = '#000';
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) g.fillRect((x + q) * px, (y + q) * px, px, px);
    } catch (e) { g.clearRect(0, 0, cv.width, cv.height); }
  }
  function show(i) { const u = urls[i]; if (!u) return; drawQR(u.url); urlEl.textContent = u.url; }
  async function open() {
    modal.classList.add('open');
    let r = null;
    try { r = await window.shl.getMobileInfo(); } catch (e) {}
    if (!r || !r.ok) { hint.textContent = 'The mobile web could not start (' + ((r && r.error) || 'unavailable') + ').'; return; }
    urls = r.urls || [];
    if (!urls.length) { hint.textContent = 'No network connection found. Connect this PC to the same Wi-Fi / network as your phone and try again.'; return; }
    if (urls.length > 1) {
      ipSel.innerHTML = urls.map((u, i) => `<option value="${i}">${esc(u.ip)} (${esc(u.name)})</option>`).join('');
      ipSel.style.display = 'block';
      hint.textContent = 'Scan the QR code with your phone. If it does not connect, pick the network address your phone is on.';
    } else { ipSel.style.display = 'none'; }
    show(0);
  }
  ipSel.addEventListener('change', () => show(parseInt(ipSel.value, 10) || 0));
  document.getElementById('mobile-open-btn').addEventListener('click', open);
  document.getElementById('mobile-close').addEventListener('click', () => modal.classList.remove('open'));
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
})();

// Streaming IP
const streamIpInput = document.getElementById('stream-ip-input');
streamIpInput.addEventListener('change', () => {
  window.shl.setStreamIp(streamIpInput.value.trim());
});

const perfModeSelect = document.getElementById('perf-mode-select');
perfModeSelect.addEventListener('change', () => {
  const mode = perfModeSelect.value;
  // divisor and physics_rate per mode
  const modeMap = {
    'ultra':   { divisor: 1,  physicsRate: true  },
    'high':    { divisor: 1,  physicsRate: false },
    'medium':  { divisor: 2,  physicsRate: false },
    'low':     { divisor: 8,  physicsRate: false },
    'verylow': { divisor: 16, physicsRate: false },
  };
  const cfg = modeMap[mode] || modeMap['high'];
  window.shl.setTelemetryDivisor(cfg.divisor);
  window.shl.setPhysicsRate(cfg.physicsRate);
});

const scoringModeSelect = document.getElementById('scoring-mode-select');
scoringModeSelect.addEventListener('change', () => {
  const isLive = scoringModeSelect.value === 'live';
  window.shl.setLiveStandings(isLive);
});

// ── Hotkey capture (shared modal for edit + reopen hotkeys) ─────────────────
const hotkeyDisplay  = document.getElementById('hotkey-display');
const hotkeyClearBtn = document.getElementById('hotkey-clear-btn');
const hotkeyModal    = document.getElementById('hotkey-modal');
const hotkeyCaptureDisplay = document.getElementById('hotkey-capture-display');
const hotkeySaveBtn  = document.getElementById('hotkey-save-btn');
const hotkeyCancelBtn = document.getElementById('hotkey-cancel-btn');

const reopenHotkeyDisplay  = document.getElementById('reopen-hotkey-display');
const reopenHotkeyClearBtn = document.getElementById('reopen-hotkey-clear-btn');
const resyncHotkeyDisplay  = document.getElementById('resync-hotkey-display');
const resyncHotkeyClearBtn = document.getElementById('resync-hotkey-clear-btn');
const pointsHotkeyDisplay  = document.getElementById('points-hotkey-display');
const pointsHotkeyClearBtn = document.getElementById('points-hotkey-clear-btn');
const top3HotkeyDisplay  = document.getElementById('top3-hotkey-display');
const top3HotkeyClearBtn = document.getElementById('top3-hotkey-clear-btn');
const driverInfoHotkeyDisplay  = document.getElementById('driverinfo-hotkey-display');
const driverInfoHotkeyClearBtn = document.getElementById('driverinfo-hotkey-clear-btn');

let _capturedCombo = '';
let _hotkeyTarget  = 'edit'; // 'edit' | 'reopen' | 'resync'

function openHotkeyModal(target) {
  _hotkeyTarget = target;
  _capturedCombo = '';
  hotkeyCaptureDisplay.textContent = 'Waiting...';
  hotkeyModal.style.display = 'flex';
  document.addEventListener('keydown', onHotkeyCapture);
}

hotkeyDisplay.addEventListener('click', () => openHotkeyModal('edit'));
reopenHotkeyDisplay.addEventListener('click', () => openHotkeyModal('reopen'));
resyncHotkeyDisplay.addEventListener('click', () => openHotkeyModal('resync'));
pointsHotkeyDisplay.addEventListener('click', () => openHotkeyModal('points'));
top3HotkeyDisplay.addEventListener('click', () => openHotkeyModal('top3'));
driverInfoHotkeyDisplay.addEventListener('click', () => openHotkeyModal('driverinfo'));

function onHotkeyCapture(e) {
  e.preventDefault();
  const parts = [];
  if (e.ctrlKey)  parts.push('Ctrl');
  if (e.altKey)   parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const key = e.key;
  if (!['Control','Alt','Shift','Meta'].includes(key)) {
    parts.push(key.length === 1 ? key.toUpperCase() : key);
  }
  if (parts.length > 0) {
    _capturedCombo = parts.join('+');
    hotkeyCaptureDisplay.textContent = _capturedCombo;
  }
}

hotkeySaveBtn.addEventListener('click', () => {
  document.removeEventListener('keydown', onHotkeyCapture);
  hotkeyModal.style.display = 'none';
  if (_capturedCombo) {
    if (_hotkeyTarget === 'reopen') {
      reopenHotkeyDisplay.textContent = _capturedCombo;
      window.shl.setReopenHotkey(_capturedCombo);
    } else if (_hotkeyTarget === 'driverinfo') {
      driverInfoHotkeyDisplay.textContent = _capturedCombo;
      window.shl.setDriverInfoHotkey(_capturedCombo);
    } else if (_hotkeyTarget === 'top3') {
      top3HotkeyDisplay.textContent = _capturedCombo;
      window.shl.setTop3Hotkey(_capturedCombo);
    } else if (_hotkeyTarget === 'points') {
      pointsHotkeyDisplay.textContent = _capturedCombo;
      window.shl.setPointsHotkey(_capturedCombo);
    } else if (_hotkeyTarget === 'resync') {
      resyncHotkeyDisplay.textContent = _capturedCombo;
      window.shl.setResyncHotkey(_capturedCombo);
    } else {
      hotkeyDisplay.textContent = _capturedCombo;
      window.shl.setEditHotkey(_capturedCombo);
    }
  }
});

hotkeyCancelBtn.addEventListener('click', () => {
  document.removeEventListener('keydown', onHotkeyCapture);
  hotkeyModal.style.display = 'none';
});

hotkeyClearBtn.addEventListener('click', () => {
  hotkeyDisplay.textContent = '— None —';
  window.shl.clearEditHotkey();
});

reopenHotkeyClearBtn.addEventListener('click', () => {
  reopenHotkeyDisplay.textContent = '— None —';
  window.shl.clearReopenHotkey();
});

driverInfoHotkeyClearBtn.addEventListener('click', () => {
  driverInfoHotkeyDisplay.textContent = 'Not Set';
  window.shl.clearDriverInfoHotkey();
});

top3HotkeyClearBtn.addEventListener('click', () => {
  top3HotkeyDisplay.textContent = 'Not Set';
  window.shl.clearTop3Hotkey();
});

pointsHotkeyClearBtn.addEventListener('click', () => {
  pointsHotkeyDisplay.textContent = 'Not Set';
  window.shl.clearPointsHotkey();
});

resyncHotkeyClearBtn.addEventListener('click', () => {
  resyncHotkeyDisplay.textContent = 'Not Set';
  window.shl.clearResyncHotkey();
});

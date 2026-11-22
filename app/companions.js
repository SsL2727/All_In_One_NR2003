'use strict';

const api = window.shl.extmods;
const root = document.getElementById('mods');
const toastNode = document.getElementById('toast');
const entries = [
  { key: 'raceControl', title: 'RaceControl 1.2 beta 2', text: 'Standalone cautions, stage cautions, wave-arounds and qualifying. All In One NR2003 pauses its built-in RaceControl while this companion runs.' },
  { key: 'aimod', title: 'AIMOD 2.2 beta 1', text: 'Standalone strategy, the era-aware crew chief brain and driver behavior. All In One NR2003’s integrated AIMOD controls remain on the main screen.' },
  { key: 'raceVision', title: 'RaceVision 1.2 beta 1', text: 'The RaceBrain companion release: TV direction, crash replays, director view, cameras and overlays.' },
  { key: 'aiEnhanced', title: 'AI Enhanced 0.2.2b', text: 'The supplied 0.2.2b executable is bundled with its writable presets. All In One NR2003 now includes race triggers and a live lap-line editor; the original app remains available for its other tools.' },
  { key: 'windTunnel', title: 'Wind Tunnel Deluxe beta', text: 'The complete supplied app and runtime DLL are bundled together. All In One NR2003 Studio edits Director .wtdc sequences and PRO files, and controls verified Figgy / Player Physics / PRO settings through the connected runtime.', warn: 'Wind Tunnel injects into NR2003. Better Damage shares game damage state with All In One NR2003, and its replay/caution controls can overlap RaceVision or RaceControl.' },
  { key: 'seasonGenerator', title: 'NR Season Generator 1.0', text: 'Generate a historical or custom NR2003 schedule from the tracks already installed on this computer.' },
];

let last = {};
let toastTimer = null;
function toast(message) {
  toastNode.textContent = message;
  toastNode.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastNode.style.display = 'none'; }, 5200);
}
function make(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function render() {
  root.replaceChildren();
  for (const item of entries) {
    const s = last[item.key] || {};
    const card = make('article', 'mod');
    const head = make('div', 'mod-head');
    head.appendChild(make('h3', '', item.title));
    head.appendChild(make('span', 'spacer'));
    let label = s.running ? 'RUNNING' : (s.bundled && !s.exe?.includes('external-mods') ? 'BUNDLED' : (s.ready ? 'READY' : (s.installed ? 'NEEDS FILE' : 'NOT FOUND')));
    let chipClass = 'chip' + (s.running || s.ready ? ' ready' : ' warn');
    if (item.key === 'windTunnel' && s.installed && !s.companionReady) { label = 'DLL MISSING'; chipClass = 'chip warn'; }
    head.appendChild(make('span', chipClass, label));
    card.appendChild(head);
    card.appendChild(make('p', '', item.text));
    card.appendChild(make('code', 'path', s.exe || 'Use Locate… to select the executable.'));
    if (item.warn) card.appendChild(make('div', 'note warn', item.warn));
    if (item.key === 'windTunnel' && s.installed && !s.companionReady) card.appendChild(make('div', 'note warn', `Required beside the executable: ${s.companion || 'WindTunnelForNRRuntime.dll'}`));

    const actions = make('div', 'actions');
    const launch = make('button', 'btn primary', s.running ? 'Already running' : 'Launch');
    launch.disabled = !s.ready || s.running;
    launch.addEventListener('click', async () => {
      launch.disabled = true;
      const result = await api.launch(item.key);
      toast(result && result.ok ? `${item.title} launch requested.` : (result && result.error) || 'Launch failed.');
      await refresh();
    });
    actions.appendChild(launch);

    if (item.key === 'windTunnel') {
      const studio = make('button', 'btn', 'Open Director / PRO Studio');
      studio.title = 'Edit Wind Tunnel Director .wtdc sequences and PRO tuning JSON.';
      studio.addEventListener('click', () => api.openWindTunnelStudio());
      actions.appendChild(studio);
    }

    const locate = make('button', 'btn', 'Locate…');
    locate.addEventListener('click', async () => {
      const result = await api.browse(item.key);
      if (result && result.error) toast(result.error);
      else if (result) toast(`${item.title} location saved.`);
      await refresh();
    });
    actions.appendChild(locate);

    const folder = make('button', 'btn', 'Open folder');
    folder.disabled = !s.installed;
    folder.addEventListener('click', () => api.openFolder(item.key).then((ok) => { if (!ok) toast('The folder could not be opened.'); }));
    actions.appendChild(folder);

    if (item.key === 'raceVision') {
      const wrap = make('label', 'small muted');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!s.autoStart; cb.style.marginRight = '5px';
      cb.addEventListener('change', () => api.setAutoStart(item.key, cb.checked).then(refresh));
      wrap.append(cb, document.createTextNode('Launch with NR2003'));
      actions.appendChild(wrap);
    }
    card.appendChild(actions);
    root.appendChild(card);
  }
}

async function refresh() {
  try { last = await api.get() || {}; render(); }
  catch (e) { toast(`Could not read companion status: ${e.message || e}`); }
}

document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('racebrain').addEventListener('click', async (e) => {
  const button = e.currentTarget; button.disabled = true;
  const result = await api.launchRaceBrain();
  if (!result || !result.ok) {
    const failures = (result && result.results || []).filter((r) => !r.ok).map((r) => r.error).filter(Boolean);
    toast((result && result.error) || failures.join(' ') || 'Could not launch the RaceBrain pair.');
  } else toast('RaceBrain launch requested: AIMOD 2.2 and RaceVision 1.2.');
  await refresh(); button.disabled = false;
});

refresh();
setInterval(refresh, 3000);

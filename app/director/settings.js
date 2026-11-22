// TV director settings: the same keys and meanings as RaceVision's racevision.ini, plus the camera selection.
'use strict';

const CAMERAS = {
  1: 'Cockpit 1', 2: 'Cockpit 2', 3: 'Cockpit 3', 4: 'Chase', 5: 'Far chase', 6: 'Chase 2', 7: 'Far chase 2', 8: 'Rear chase',
  9: 'Dark / unused', 10: 'Front', 11: 'Rear', 12: 'Roof forward', 13: 'Roof', 14: 'Right side', 15: 'Left side', 16: 'Helicopter',
  17: 'Pit lane 1', 18: 'Pit lane 2', 19: 'TV 1', 20: 'TV 2', 21: 'Spectator',
};
const ALL_CAMS = Object.keys(CAMERAS).map(Number);

// camera lists per shot: [open on, then follow with]
const SHOTS = ['incident', 'pass', 'battle', 'pit', 'pit_stall', 'pit_exit', 'leader', 'tour', 'restart', 'qual_exit', 'qual'];
const CAM_DEFAULTS = {
  cam_incident: '16, 19', cam_incident_follow: '20, 4',
  cam_pass: '19, 20', cam_pass_follow: '8, 13',
  cam_battle: '19, 20', cam_battle_follow: '8, 1, 13, 4',
  cam_pit: '19, 16', cam_pit_stall: '17, 18', cam_pit_exit: '19, 20', cam_pit_follow: '',
  cam_leader: '20, 16', cam_leader_follow: '13, 5, 1, 4',
  cam_tour: '20, 19', cam_tour_follow: '13, 1, 4',
  cam_restart: '16', cam_restart_follow: '19',
  cam_qual_exit: '17, 18', cam_qual: '19, 20', cam_qual_follow: '4, 13, 1',
  // crash replays (RaceVision 1.1.0): the first angle's cameras, then the later angles'
  cam_replay: '19, 20', cam_replay_angles: '16, 5, 21',
};

const NUM_DEFAULTS = {
  camera_call: 1, follow_after: 5, camera_every: 12, onboard_cams: '1, 2, 3, 12, 13',
  min_hold: 10, max_hold: 40, incident_hold: 8, switch_margin: 1.5, revisit_after: 45, manual_hold: 20,
  battle_gap: 0.8, battle_min_age: 4, short_track_m: 1700, battle_short_m: 8, onboard_hold: 25,
  rival_boost: 1,                   // rivals' battles: 0 = no extra weight, 1 = normal, 2 = double
  lead_battle_depth: 3, lead_battle_hold: 120, lead_battle_pack: 6, tv_cut_gap: 1.5, tv_cut_wait: 4,
  settle_laps: 3, settle_positions: 6, settle_hold: 15, tour_depth: 8, crash_drop: 31, crash_window: 1.5,
  overlays: 1, overlay_style: 'classic', dash_accent: '#e8c84a', dash_accent2: '#145A60', dash_art_colors: 0, dash_speed_max: 220, overlay_min_run_laps: 5, overlay_gap: 150,
  tag_on: 1, battle_on: 1, dash_on: 1,      // each TV graphic on its own (overlays is the master switch)
  tag_story: 1, tag_rotate: 6, stage_laps: '', art_folders: '', art_series: 'auto',
  crowd: 0, crowd_volume: 0.8, crowd_folder: 'sounds\\crowd', crowd_favourites: '', crowd_pass_depth: 10, crowd_cooldown: 6,
  crowd_events: 'start, restart, lead, pass, crash, white, win',
  gain: 1, gain_min: 3, gain_min_laps: 2, gain_show: 8, gain_every: 60, gain_lost: 1,
  overlay_battle: '', overlay_tag: '', overlay_onboard: '', overlay_gain: '', overlay_replay: '',
  // RaceVision 2.0 overlay layouts: which layout each panel uses ('' = All In One NR2003's own look / the style preset's, 'off'), where the new panels
  // sit ("x, y, scale" on a 1920 x 1080 screen; the dash shares overlay_onboard). overlay_style is classic, dash or preset:<name>
  layout_tag: '', layout_battle: '', layout_onboard: '', layout_dash: '', layout_custom1: '', layout_custom2: '', layout_custom3: '', layout_custom4: '',
  layout_rc_qual: '', layout_rc_tele: '', layout_rc_cone: '', layout_rc_order: '',
  overlay_custom1: '', overlay_custom2: '', overlay_custom3: '', overlay_custom4: '', overlay_rc_qual: '', overlay_rc_tele: '', overlay_rc_cone: '', overlay_rc_order: '',
  remote: 0, remote_port: 8090, remote_key: '',
  // crash replays and the camera library (RaceVision 1.1.0 beta 2)
  qual_player_cam: 1, live_after_climb_out: 1,
  qual_handoff_m: 300, replay_banner: 1,
  replay_auto: 1, replay_caution_only: 1, replay_preroll: 4, replay_after: 8, replay_max: 20, replay_within: 120, replay_worthy: 6, replay_angles: 3,
  replay_take: 8, replay_countdown: 5, reel_angles: 1, replay_drive: 1, replay_overlays: 1, crash_damage: 4, contact_join: 0.5, crash_span: 20, tape_margin: 1,
  // RaceVision 1.2.0: smart slow motion (the game's own 1/2 - 1/17) into and out of the hit, the full-screen TV wipe into a replay,
  // between its angles and back to live, and other overlays out of the way while a replay is on
  replay_smart: 1, replay_slow_max: 5, replay_transition: 1, replay_transition_ms: 1500, replay_wipe_color: '',
  hide_companion_overlays: 0, companion_apps: '', companion_keep: '',
  // RaceVision 2.0: highlights besides crashes (multi-passes, last-lap podium passes, bump and runs, the finish): on the Replays list, the
  // phone and the reel; only the finish replays by itself. Crash replays get one slow-motion look (the hardest hit) only for a hit of
  // replay_slow_impact or more (RaceVision's damage units: 0.5 = a crash, 1+ = a big one; All In One NR2003's crash_damage is 10x those)
  highlights: 1, multi_pass_cars: 2, highlight_gap: 180, highlight_bump: 1, bump_run_window: 3, bump_run_depth: 10, highlight_preroll: 6,
  replay_finish: 1, replay_finish_after: 6, reel_highlights: 1, replay_slow_impact: 1.0, superspeedways: 'daytona; talladega',
  // blowovers (a mod lets AI cars flip and fly): a car blowover_m above its own height at that spot last lap, moving up or down at blowover_vz m/s
  // or more in the last 3 s, has flipped (0 = off); that crash is worth blowover_bonus more (All In One NR2003's crash score units)
  blowover_m: 4, blowover_vz: 5, blowover_bonus: 30,
  custom_cams: 1, chase2_view: '4.5, -2.2, 1.0, 26, 4', far_chase2_view: '15, 0, 7.5, 0, 20', incar3_eye: '-0.25, -0.5, 0.05', drone_height: 30, drone_quiet: 1,
  drone_distance: 100, drone_top_mph: 175, drone_hover_m: 25,
  remote_scanner: 1, aimod_port: 8767,
  cam_order: '', cam_hidden: '',
  // the rear camera riding the car ahead (settings kept; the director does not drive these yet)
  rear_pan: 1, rear_pan_span: 110, rear_pan_fov: 105, rear_mount: 1, rear_mount_m: 45, rear_hold_m: 70, rear_pass_m: 5, rear_block_s: 1.5, rear_pan_smooth: 0.45, rear_alone: 11,
  // dynamic cameras (RaceVision, Nov 2026): its own static cameras on pit road, crashes, restarts, battles and the finish
  dyn_cams: 0, dyn_chance: 60, dyn_pit: 1, dyn_crash: 1, dyn_restart: 1, dyn_battle: 1, dyn_finish: 1, dyn_learn: 1,
  dyn_half_width: 0, dyn_yaw_fix: 0, dyn_pitch_sign: 1, dyn_rig: 1, dyn_autozoom: 1, dyn_smooth: 1,
  // camera sets: the folder with RaceVision's camsets (empty = All In One NR2003's own under ProgramData), the NR2003 folder (empty = the game All In One NR2003 starts)
  camsets_dir: '', game_dir: '',
};
// per-camera keys of the camera library: cam_new_29 = "4, Custom 29" (base camera, name), cam_tune_N = "x, y, z, turn, tilt, roll, lens", cam_label_N = name
const DYNAMIC_KEY = /^cam_(new|tune|label)_\d{1,2}$/;

const DEFAULTS = Object.assign({}, CAM_DEFAULTS, NUM_DEFAULTS);

const list = (v) => String(v === undefined || v === null ? '' : v).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
const MAX_CAM = 40;
const camList = (v) => list(v).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= MAX_CAM);
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// the settings with every value coerced to its type; `enabledCams` (array of camera numbers) filters every camera list
function resolve(raw, enabledCams) {
  const S = Object.assign({}, DEFAULTS, raw || {});
  const hidden = new Set(camList(S.cam_hidden));
  const on = new Set((Array.isArray(enabledCams) && enabledCams.length ? enabledCams.map(Number) : ALL_CAMS).filter(n => n <= 21));
  if (String(S.custom_cams) !== '0') for (let n = 22; n <= MAX_CAM; n++) if (!hidden.has(n) && (n <= 28 || S['cam_new_' + n])) on.add(n);       // the library's cameras are always allowed unless hidden
  const out = { enabledCams: [...on].sort((a, b) => a - b), raw: S };
  for (const k of Object.keys(CAM_DEFAULTS)) out[k] = camList(S[k]).filter(c => on.has(c));
  out.onboard_cams = new Set(camList(S.onboard_cams));
  for (const k of Object.keys(NUM_DEFAULTS)) {
    if (k in out) continue;
    let value = S[k] === undefined ? NUM_DEFAULTS[k] : S[k];
    if (k === 'dash_accent' && String(value).toLowerCase() === '#3cc8c8') value = NUM_DEFAULTS.dash_accent;
    out[k] = typeof NUM_DEFAULTS[k] === 'number' ? num(value, NUM_DEFAULTS[k]) : String(value);
  }
  out.replay_slow_max = Math.max(1, Math.min(16, Math.round(out.replay_slow_max)));
  out.replay_transition_ms = Math.max(400, Math.min(5000, out.replay_transition_ms));
  out.multi_pass_cars = Math.max(2, Math.min(20, Math.round(out.multi_pass_cars)));
  out.highlight_gap = Math.max(0, Math.min(3600, out.highlight_gap));
  out.bump_run_window = Math.max(0.5, Math.min(10, out.bump_run_window));
  out.bump_run_depth = Math.max(1, Math.min(43, Math.round(out.bump_run_depth)));
  out.highlight_preroll = Math.max(1, Math.min(20, out.highlight_preroll));
  out.replay_finish_after = Math.max(0, Math.min(60, out.replay_finish_after));
  out.replay_slow_impact = Math.max(0, out.replay_slow_impact);
  out.cam_hidden = hidden;
  out.stage_laps = list(S.stage_laps).map(Number).filter(n => n > 0);
  out.crowd_events = new Set(list(S.crowd_events));
  out.crowd_favourites = list(S.crowd_favourites);
  return out;
}

module.exports = { CAMERAS, ALL_CAMS, SHOTS, DEFAULTS, CAM_DEFAULTS, DYNAMIC_KEY, MAX_CAM, resolve, camList, list };

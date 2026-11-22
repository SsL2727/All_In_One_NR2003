"""All In One NR2003 <-> AIMOD glue (compiled to aimod.headless in the bundle, run by All In One NR2003's Python VM).

AIMOD v2.2's own modules (game memory layer, strategy and behavior engines, crew chief brain, tire model, pit log, presets, wave log,
pit crew) do all the work; this module only replaces AIMOD's tkinter window: it is the same per-tick orchestration as AIMOD's App._tick,
without the widgets, with settings kept in a plain dict so All In One NR2003's UI can edit them.
"""
import json
import logging
import os
import struct
import time

from . import carfiles
from . import crewchief as _cc
from . import memory_map as mm
from .adjust import CrewChief
from .behavior import BehaviorConfig, BehaviorEngine, SAVE_FUEL, gather as behavior_inputs, set_temperaments
from .behavior_mem import AggressionWriter, BehaviorWriter
from . import aggression as agg
from . import showdown_lock
from .aggtrace import AggTrace
from .aisetup import ai_setup
from .carno import CarNo
from .companion_art import ArtData
from .crewchief import CrewChiefProfile
from .crewview import CrewView
from .game import Game
from .humancalls import Desk
from .pitcrew import PitCrew, default_modern
from .pitboard import payload as board_payload
from .pitgate import PitGate
from .pitlog import PitLog
from .presets import Preset, PresetStore, parse_stage_ends
from .strategy import (DRAFT_RULES, INTERMEDIATE, OTHER_RULES, ROAD_COURSE, SHORT_TRACK, SUPERSPEEDWAY, StrategyEngine,
                       StrategyParams, TeamRules, Write)
from .teams import normalize as normalize_teams
from .tiremodel import TireModel
from .wavelog import WaveLog
from . import radio as _radio
from .results import ResultsRecorder
from .subtitles import SubtitleGate, title_for
from .gearbox import AI_RECORDS as GEAR_AI_RECORDS, PACE_SLOT as GEAR_PACE_SLOT, PLAYER_SLOT as GEAR_PLAYER_SLOT, SLOTS as GEAR_SLOTS, Gearbox, spread as gear_spread

log = logging.getLogger('aimod')

ATTACH_RETRY_S = 2.0
TRACK_CHECK_S = 1.0
DRAFTING_TRACKS = ('talladega', 'daytona')
ROAD_COURSE_NAMES = ('watkins', 'sonoma', 'infineon', 'road america', 'roadamerica', 'road_america', 'cota',
                     'circuit of the americas', 'americas', 'mid-ohio', 'midohio', 'mid_ohio', 'portland', 'roval',
                     'chicago street', 'chicago_street', 'indianapolis_gp', 'indygp', 'indy_gp', 'mosport',
                     'canadian tire', 'canadiantire', 'montreal', 'gilles', 'laguna', 'road atlanta', 'barber',
                     'daytona_rc', 'daytona_road', 'roadcourse', 'road_course', 'road course', '_rc_', 'glen')
SHORT_TRACK_M = 1530.0
CHASSIS_VALUE = 5998                 # the car block's chassis balance float (the crew chief's adjustments are added to it)
# AIMOD 2.2 dropped pit_takeover / pit_takeover_extra / no_game_repair_stops from memory_map.PATCHES (Game.apply_patches would raise
# KeyError on them). All In One NR2003 keeps 2.1's AI pit takeover as its own patch (its pit holds were built with it on; it was All In One NR2003's default).
LEGACY_PATCHES = {'legacy_pit_takeover': {'addr': 0x5201CA, 'original': b'\x74\x0c',
                                          'label': 'AI pit takeover (0x5201CA) - AIMOD 2.1, dropped in 2.2, kept by All In One NR2003'}}
for _k, _v in LEGACY_PATCHES.items():
    mm.PATCHES.setdefault(_k, _v)
REMOVED_PATCHES = ('pit_takeover', 'pit_takeover_extra', 'no_game_repair_stops')
RENAMED_PATCHES = {'pit_takeover': 'legacy_pit_takeover'}
DEFAULT_PATCHES = ['legacy_pit_takeover', 'no_game_plan_stops', 'no_game_condition_stops', 'caution_repairs']
FORCED_22 = ('sets_include_start', 'plan_multi_stop', 'guard_game_stops', 'tire_only_stops', 'free_fuel', 'position_strategy',
             'pace_strategy', 'value_tires')           # AIMOD 2.2's App._strategy_params passes True for these whatever the preset says
STYLE_SHORT_PIT = 'short-pit'


def migrate_patches(s):
    """Settings from AIMOD 2.1 / older All In One NR2003: 2.2's own rule (drop the removed patches, add no_game_plan_stops once, flag
    patches_v37), except that pit_takeover becomes All In One NR2003's legacy_pit_takeover. Returns the dict."""
    pats = s.get('patches')
    if isinstance(pats, dict):
        pats = [k for k, on in pats.items() if on]
    out = []
    for k in list(pats or []):
        k = RENAMED_PATCHES.get(str(k), str(k))
        if k not in REMOVED_PATCHES and k not in out:
            out.append(k)
    if not s.get('patches_v37'):
        s['patches_v37'] = True
        if 'no_game_plan_stops' not in out:
            out.append('no_game_plan_stops')
    # AIMOD (Nov 2026): 'car condition' stops off and the pit gate on once (v38), repairs on caution stops once (v39)
    if not s.get('patches_v38'):
        s['patches_v38'] = True
        if 'no_game_condition_stops' not in out:
            out.append('no_game_condition_stops')
        s.setdefault('pit_gate', True)
    if not s.get('patches_v39'):
        s['patches_v39'] = True
        if 'caution_repairs' not in out:
            out.append('caution_repairs')
    s['patches'] = out
    return s


def real_driver(name):
    n = str(name or '').strip()
    return bool(n) and n != 'AI' and n.lower() != 'pace car'


class CarZero(CarNo):
    """A real, named car #0. AIMOD 2.2's ghost-car fix (Game.snapshot: number <= 0 is invalid) would drop it with the blank slots,
    so its <= 0 test says no; everything else (==, hash, label "0", JSON 0) is still car 0."""

    def __le__(self, other):
        return False if other == 0 else int(self) <= other


class SFGame(Game):
    """AIMOD's Game with All In One NR2003's two guards: unknown patch keys (stale settings) are skipped, not a KeyError that leaves the game
    unpatched; and a named #0 car stays a car (only the blank slot is the 2.2 ghost)."""
    keep_car_zero = True

    def _driver(self, i):
        number, name = Game._driver(self, i)
        if self.keep_car_zero and number == 0 and real_driver(name):
            return CarZero(0), name
        return number, name

    def apply_patches(self, wanted):
        keys = [k for k in (wanted or []) if k in mm.PATCHES]
        bad = [k for k in (wanted or []) if k not in mm.PATCHES]
        if bad:
            log.warning('Game patches not in AIMOD 2.2 skipped: %s', ', '.join(str(k) for k in bad))
        return Game.apply_patches(self, keys)


_BRAIN_CALL = _cc.caution_call
_ACTIVE = [None]


def _caution_call(*args, **kwargs):
    """crewchief.caution_call as StrategyEngine._brain_caution_call imports it (at call time): All In One NR2003's wave-around era (RaceControl's
    own WaveAround, or the user's choice) replaces 2.2's 'p.stages > 0' when set."""
    h = _ACTIVE[0]
    era = getattr(h, 'wave_era', None) if h is not None else None
    if era is not None:
        kwargs['has_wave_around'] = bool(era)
    return _BRAIN_CALL(*args, **kwargs)


_cc.caution_call = _caution_call


class SpeechOutbox:
    """Stands in for aimod.radio.Voice: the radio's own logic decides what is said, to whom and how urgently; instead of synthesising
    audio here (the standalone app uses Piper or SAPI threads) every line is queued for All In One NR2003, which speaks it with the system's voices."""

    def __init__(self, cfg=None, voices_dir=None, *args, **kwargs):
        self.cfg = cfg if cfg is not None else {}
        self.out = []
        self.playing_prio = 9
        self.gate = SubtitleGate(self.cfg.setdefault('subtitles', {}))   # AIMOD 2.2: which transmissions get the subtitle box
        self.current = None

    def start(self):
        return None

    def stop(self):
        self.out.append({'cmd': 'stop'})

    def _record(self, text, role, prio, ttl, key, number, tweak, speaker, sub, chain):
        box = None
        if sub and self.gate.allow(sub, time.monotonic()):
            box = {'title': title_for(role, (sub or {}).get('name', '')), 'why': sub.get('why')}
        self.out.append({'cmd': 'say', 'text': str(text), 'role': str(role), 'prio': int(prio), 'ttl': float(ttl or 8.0),
                         'key': key, 'number': number, 'tweak': [int(tweak[0]), int(tweak[1])] if tweak else [0, 0],
                         'speaker': speaker if isinstance(speaker, (int, float, str)) else None, 'sub': box, 'chain': bool(chain)})

    def say(self, text, role='crew', prio=2, ttl=8.0, key=None, number=None, tweak=(0, 0), speaker=None, sub=None, then=None):
        self._record(text, role, prio, ttl, key, number, tweak, speaker, sub, False)
        for m in then or []:                    # a conversation: its next lines right after, one after another
            self._record(getattr(m, 'text', ''), getattr(m, 'role', role), prio, max(30.0, float(ttl or 8.0)), None, getattr(m, 'number', number),
                         getattr(m, 'tweak', (0, 0)), getattr(m, 'speaker', None), getattr(m, 'sub', None), True)
        if len(self.out) > 60:
            del self.out[:len(self.out) - 60]

    def phone_listening(self):
        return False

    def clips_info(self, *args, **kwargs):
        return {}

    def clip_wav(self, *args, **kwargs):
        return None

    def piper_files(self, *args, **kwargs):
        return []

    def drain(self):
        out, self.out = self.out, []
        return out


class Headless:
    def __init__(self, base, wave_log=None, settings=None):
        self.base = base
        os.makedirs(base, exist_ok=True)
        self.settings_path = os.path.join(base, 'settings.json')
        self.settings = self._load_settings(settings)
        self.modern_superspeedway = bool(self.settings.get('modern_superspeedway', True))
        self._automatic_teams = []
        self.store = PresetStore(os.path.join(base, 'presets'))
        self.pitlog = PitLog(os.path.join(base, 'logs'))
        self.game = SFGame()
        self.game.keep_car_zero = bool(self.settings.get('keep_car_zero', True))
        names = self.settings.get('make_names')
        if isinstance(names, list) and names:
            self.game.make_names = [str(x) for x in names]
        self.tire_model = TireModel(os.path.join(base, 'tire_models.json'))
        self.engine = StrategyEngine(tire_model=self.tire_model)
        self.engine.crew_chief = CrewChief()
        self.behavior = BehaviorEngine(BehaviorConfig())
        self.behavior_writer = BehaviorWriter()
        # AIMOD (Nov 2026) racing intensity & rivals: each AI car's aggression (aggression.py), as AIMOD's App runs it
        self.intensity = agg.IntensityEngine()
        self.agg_writer = AggressionWriter(os.path.join(base, 'aggression_restore.json'))
        self._agg_mode = agg.OFF
        self.contacts = agg.ContactWatcher()
        self.rivals = agg.RivalBook()
        self.agg_trace = AggTrace(os.path.join(base, 'logs'))
        self._rival_onscreen = None          # (car, rival, kind, level) for the rivals card over the game
        self.rival_ind_cfg = self.settings.setdefault('rival_indicator', {})
        for k, v in (('on', True), ('x', 40), ('y', 160), ('size', 1.0), ('opacity', 0.85)):
            self.rival_ind_cfg.setdefault(k, v)
        self.results = ResultsRecorder(os.path.join(base, 'results'),
                                       history=lambda idx, laps: self.game.crossing_history(idx, laps))
        self._was_attached = False
        self._results_error = 0.0
        self._intensity_error = 0.0
        self._agg_external_off = False       # RaceLab's allies / rivals run in the game: racing intensity & rivals stand aside
        self._season_rivals = None           # All In One NR2003's season mode: rivalries carried from earlier counted races
        self._race_pairs = {}                # this race: pair -> {'runins', 'settled', 'retaliate'} (kept through the cool-down)
        self._agg_reset_race()
        self._chassis_base = {}
        self._orig_topoff = self.engine.second_topoff
        self.pitcrew = PitCrew()
        self.pitgate = PitGate()            # AIMOD (Nov 2026): only AIMOD sends AI cars to pit road in a race
        self._gate_armed = False
        self._gate_logged = {}
        self._gate_held_total = 0
        self._gate_error = 0.0
        self._gate_hold = set()             # All In One NR2003's own holds this tick (pit lane staging, superspeedway fuel): kept out of the gate
        self.params = Preset()
        self.loaded_name = None
        self.track = ''
        self.mod = ''
        self._wave_log_path = wave_log
        self.wavelog = WaveLog(wave_log)
        self.pit_events = []
        self._last_attach_try = 0.0
        self._last_track_check = 0.0
        self._last_session = None
        self._last_laps = 0.0
        self._last_clock = 0.0
        self._last_leader = 0
        self._drop_ticks = 0
        self._flagged = set()
        self._mem_flags = set()
        self._flag_check = 0.0
        self._crew_applied = None
        self._crew_check = 0.0
        self._crew_try = -100.0
        self._model_saved = time.monotonic()
        self._tank_logged = None
        self._fuel_first_logged = None
        self._ss_green_held = {}
        self._last_snap = None
        self._last_sp = None
        self.radio = None
        self.gearbox = Gearbox()
        self._gear_check = 0.0
        self._gear_want = None
        self._radio_lines = []
        self._radio_error = 0.0
        self._last_rows = []
        self._last_res = None
        self._learned = None
        self._status = {}
        self.stage_ends = None          # lap numbers from All In One NR2003's Stage Racing settings (None = use the preset's, () = Stages off)
        self.wave_era = None            # True / False = wave-around era for the crew chief brain, None = AIMOD 2.2's own (stages > 0)
        self.desk = Desk(log=log.info)  # AIMOD 2.2 beta: crew chief on phones (humancalls), served by All In One NR2003's crew server
        self.crew_view = CrewView()
        self._crew_at = 0.0
        self._crew_json = None
        self._art = None
        self._art_roots = []
        _ACTIVE[0] = self
        self._pit_lane_state = None
        self._pit_lane_waiting = set()
        self.enabled = bool(self.settings.get('enabled', True))
        last = self.settings.get('last_preset')
        if last and last in self.store.names():
            self.load_preset(last)

    # ── gearbox: the game's own 5 / 6 speed (aimod.gearbox raises the Cup cars' gear count inside NR2003) ──────
    def _gear_setting(self):
        saved = self.settings.get('gearbox_by_mod') or {}
        cfg = saved.get(self.mod or '')
        if cfg:
            return {'on': bool(cfg.get('on')), 'gears': int(cfg.get('gears') or 5)}
        return {'on': True, 'gears': 5}

    def _sync_gearbox(self):
        pm = self.game.pm
        if pm is None:
            return
        cfg = self._gear_setting()
        gears = cfg['gears'] if cfg['on'] else 4
        want = (pm.process_id, gears)
        if gears == 4 and self._gear_want is None and self.gearbox.applied is None:
            self._gear_want = want
            return
        # the game reloads its engine table (4 gears) when it loads the cars, so this is checked again every 2 s, not set once
        now = time.monotonic()
        if want != self._gear_want or now - self._gear_check >= 2.0:
            self._gear_check = now
            if want != self._gear_want:
                self.gearbox.forget_ai()
                self._ai_spread_at = 0.0
            self.gearbox.apply(pm, gears)
            self._gear_want = want
        self._spread_ai(pm, gears)

    def _spread_ai(self, pm, gears):
        """The AI cars run the track's 4-gear fast setup: spread each AI car's gear ratios to the new count in memory (top gear = the old
        4th). Repeated about once a second because the records are rebuilt when a session loads."""
        if gears <= 4:
            return
        now = time.monotonic()
        if now - getattr(self, '_ai_spread_at', 0.0) < 1.0:
            return
        self._ai_spread_at = now
        self.gearbox.spread_ai(pm, gears)
        self._spread_built4(pm, gears)

    def _spread_built4(self, pm, gears):
        """AI cars the game built while its engine table still said 4 gears (n = 4) get the extra gears too; spread_ai only
        re-spaces records that already have them. Same spacing: first gear kept, top gear = the old 4th."""
        changed = 0
        for s in range(GEAR_SLOTS):
            if s in (GEAR_PLAYER_SLOT, GEAR_PACE_SLOT):
                continue
            for base, stride in GEAR_AI_RECORDS:
                addr = base + s * stride
                try:
                    raw = pm.read_bytes(addr, 36)
                except Exception:  # noqa: BLE001
                    continue
                n, rev, neu = struct.unpack_from('<iff', raw, 0)
                g = list(struct.unpack_from('<6f', raw, 12))
                if n != 4 or not (-5.0 < rev < -1.0) or neu != 0.0 or not (g[0] > g[1] > g[2] > g[3] > 0.3):
                    continue
                new = gear_spread(g[0], g[3], gears) + g[gears:]
                data = struct.pack('<i', gears) + raw[4:12] + struct.pack('<6f', *new)
                try:
                    pm.write_bytes(addr, data, len(data))
                except Exception:  # noqa: BLE001
                    continue
                changed += 1
        if changed:
            log.info('Gearbox: %d AI gear records were built with 4 gears - now %d speeds (top gear = the old 4th)', changed, gears)

    def set_gearbox(self, on, gears):
        saved = self.settings.setdefault('gearbox_by_mod', {})
        saved[self.mod or ''] = {'on': bool(on), 'gears': max(4, min(6, int(gears or 5)))}
        self._gear_want = None
        self.save_settings()
        try:
            self._sync_gearbox()
        except Exception as e:  # noqa: BLE001
            log.warning('Gearbox: %s', e)
        return self.gearbox_state()

    def gearbox_restore(self):
        saved = self.settings.setdefault('gearbox_by_mod', {})
        cur = self._gear_setting()
        saved[self.mod or ''] = {'on': False, 'gears': cur['gears']}
        self._gear_want = None
        self.save_settings()
        if self.game.pm is not None:
            self.gearbox.restore(self.game.pm)
        return self.gearbox_state()

    def gearbox_state(self):
        cfg = self._gear_setting()
        return {'on': cfg['on'], 'gears': cfg['gears'], 'mod': self.mod, 'status': self.gearbox.status, 'applied': self.gearbox.applied}

    # ── scanner radio / crew chief calls (aimod.radio) ──────────────────────────────────────────────────────
    def _radio_line(self, line):
        self._radio_lines.append(str(line))
        if len(self._radio_lines) > 200:
            del self._radio_lines[:50]

    def _ensure_radio(self):
        if self.radio is None:
            _radio.Voice = SpeechOutbox
            cfg = self.settings.setdefault('radio', {})
            self.radio = _radio.Radio(cfg, voices_dir=os.path.join(self.base, 'voices'), on_line=self._radio_line)
            self.radio.teams = self._radio_teams
        return self.radio

    def _radio_teams(self):
        saved = self.settings.get('teams_by_mod') or {}
        teams = normalize_teams(saved.get(self._series_key()) or [])
        if not teams:
            seen = set()
            for v in saved.values():
                for t in normalize_teams(v):
                    if t['name'] and t['name'] not in seen:
                        seen.add(t['name'])
                        teams.append(t)
        return teams

    def radio_options(self):
        from . import subtitles as _subs
        return {'defaults': dict(_radio.DEFAULTS), 'categories': [list(c) for c in _radio.CATEGORIES],
                'voices': [list(v) for v in _radio.VOICE_CHOICES], 'drivers': [list(v) for v in _radio.DRIVER_CHOICES],
                'triggers': [list(t) for t in _radio.TRIGGERS], 'subtitle_defaults': dict(_subs.DEFAULTS)}

    def radio_config(self):
        return dict(self._ensure_radio().cfg)

    def set_radio(self, patch):
        r = self._ensure_radio()
        for k, v in dict(patch).items():
            if k in ('cats', 'subtitles') and isinstance(v, dict):
                r.cfg.setdefault(k, {}).update(v)
            else:
                r.cfg[k] = v
        self.save_settings()
        return dict(r.cfg)

    def radio_test(self):
        self._ensure_radio().test()

    def radio_hear(self, lines):
        """AIMOD 2.2's "Hear it": one conversation now, its lines one after another in their speakers' voices"""
        r = self._ensure_radio()
        who = {'driver': _radio.DRIVER, 'crew': _radio.CREW, 'spotter': _radio.SPOTTER}
        rows = [(who.get(str(a).strip().lower(), _radio.CREW), str(b).replace('{car}', '24').replace('{pos}', '5')) for a, b in (lines or []) if str(b).strip()]
        if not rows:
            return False
        rest = [_radio._Msg(t, role, _radio.HIGH, 30.0, None) for role, t in rows[1:]]
        sub = {'why': 'convo', 'group': r.next_group()} if hasattr(r, 'next_group') else None
        r.say(None, rows[0][0], rows[0][1], _radio.HIGH, 30.0, None, None, sub=sub, then=rest)
        return True

    def radio_drain(self):
        r = self.radio
        return r.voice.drain() if r is not None else []

    def radio_lines(self, n=60):
        return self._radio_lines[-n:]

    def _radio_tick(self, snap, res, sp):
        r = self.radio
        if r is None or not r.cfg.get('on'):
            return
        try:
            tv = None
            if r.scanner and r.cfg.get('follow_tv') and self.game.pm is not None:
                tv = _radio.tv_slot(self.game.pm)
            r.update(snap, res, self.engine, sp, tv)
        except Exception as e:  # noqa: BLE001 - the radio must never stop the strategy
            if time.monotonic() - self._radio_error > 60:
                self._radio_error = time.monotonic()
                log.warning('Radio update failed: %s', e)

    # ── settings ──────────────────────────────────────────────────────────────────────────────────────────
    def _load_settings(self, override):
        s = {'patches': list(DEFAULT_PATCHES), 'restore_on_exit': True, 'auto_load': True, 'enabled': True,
             'make_names': [], 'tank_by_track': {}, 'pit_crew_by_mod': {}, 'team_rules_by_mod': {}, 'teams_by_mod': {}}
        try:
            with open(self.settings_path, 'r', encoding='utf-8') as f:
                s.update(json.load(f))
        except (OSError, ValueError):
            pass
        if override:
            s.update(override)
        return migrate_patches(s)

    def save_settings(self):
        try:
            with open(self.settings_path, 'w', encoding='utf-8') as f:
                json.dump(self.settings, f, indent=4)
        except OSError as e:
            log.warning('Could not save settings: %s', e)

    def set_setting(self, key, value):
        self.settings[key] = value
        if key == 'enabled':
            self.enabled = bool(value)
        if key == 'patches':
            self.settings['patches_v37'] = True
            migrate_patches(self.settings)
            if self.game.pm is not None:
                self._sync_patches()
        if key == 'keep_car_zero':
            self.game.keep_car_zero = bool(value)
            self.game._names = {}
        if key == 'make_names' and isinstance(value, list) and value:
            self.game.make_names = [str(x) for x in value]
        self.save_settings()

    def _sync_patches(self):
        """Apply the wanted patches; patches switched off are put back (AIMOD's Game only ever adds)."""
        want = [k for k in self.settings.get('patches', []) if k in mm.PATCHES]
        for key in list(self.game.applied_patches):
            if key not in want:
                self._restore_patch(key)
        self.game.apply_patches(want)

    def _restore_patch(self, key):
        p = mm.PATCHES.get(key)
        if p is None or self.game.pm is None:
            return
        try:
            for a in p.get('sites', (p['addr'],)):
                self.game.pm.write_bytes(a, p['original'], len(p['original']))
            self.game.applied_patches.discard(key)
            log.info('Game patch removed: %s', p.get('label', key))
        except Exception as e:  # noqa: BLE001
            log.warning('Could not restore patch %s: %s', key, e)

    # ── presets / parameters ──────────────────────────────────────────────────────────────────────────────
    def load_preset(self, name):
        try:
            self.params = self.store.load(name)
        except (OSError, ValueError) as e:
            log.warning('Could not load preset %s: %s', name, e)
            return False
        self.loaded_name = name
        self.settings['last_preset'] = name
        self.save_settings()
        log.info("Preset '%s' loaded", name)
        return True

    def save_preset(self, name):
        self.store.save(name, self.params)
        self.loaded_name = name
        self.settings['last_preset'] = name
        self.save_settings()
        log.info("Preset '%s' saved", name)

    def assign_track(self, name):
        if self.track and name:
            self.store.assign_track(name, self.track)
            log.info("Preset '%s' now used for %s", name, self.track)

    def params_dict(self):
        return self.params.to_dict()

    def set_params(self, values):
        d = self.params.to_dict()
        d.update(values)
        self.params = Preset.from_dict(d)

    def preset_names(self):
        return list(self.store.names())

    def loaded_preset(self):
        return self.loaded_name

    def _no_topoff(self, *args, **kwargs):
        return None

    def public_settings(self):
        return {'patches': list(self.settings.get('patches', [])), 'auto_load': bool(self.settings.get('auto_load', True)),
                'restore_on_exit': bool(self.settings.get('restore_on_exit', True)), 'second_stops': bool(self.settings.get('second_stops', False)), 'crew_modern': self._crew_modern(), 'adjust_handling': bool(self.settings.get('adjust_handling', True)),
                'modern_superspeedway': self.modern_superspeedway, 'mod': self.mod, 'track': self.track, 'gearbox': self.gearbox_state(),
                'tank_laps_learned': self.learned_tank(), 'track_type': self.track_type(),
                'crew_brain': bool(self.settings.get('crew_brain', True)), 'force_22_options': bool(self.settings.get('force_22_options', True)),
                'auto_teams_all_tracks': bool(self.settings.get('auto_teams_all_tracks', False)),
                'ss_short_pit_relax': bool(self.settings.get('ss_short_pit_relax', False)), 'keep_car_zero': bool(self.game.keep_car_zero),
                'crew_beta': bool(self.settings.get('crew_beta', False)), 'wave_era': self.wave_era, 'stages_era': self._era_stages(),
                'patch_list': [[k, str(v.get('label', k))] for k, v in mm.PATCHES.items()], 'forced_22': list(FORCED_22),
                'save_results': bool(self.settings.get('save_results', True)), 'clear_black_flags': bool(self.settings.get('clear_black_flags', False)),
                'results_dir': self.results.dir}

    # ── manufacturers & teams (AIMOD's Teams / Strategy rules / Name manufacturers dialogs, edited in All In One NR2003's page) ────────────
    def teams_state(self):
        from .teams import PRIORITY_LABELS, RULE_FIELDS, TEAM_PITS_LABELS
        key = self._series_key()
        rules = self._team_rules()
        return {'series': key, 'teams': normalize_teams(((self.settings.get('teams_by_mod') or {}).get(key)) or []),
                'automatic': normalize_teams(self._automatic_teams), 'make_names': list(self.game.make_names),
                'rules': {k: dict(vars(v)) for k, v in rules.items()},
                'rule_fields': [list(f) for f in RULE_FIELDS], 'priority_labels': dict(PRIORITY_LABELS), 'team_pits_labels': dict(TEAM_PITS_LABELS)}

    def set_teams(self, teams):
        book = self.settings.setdefault('teams_by_mod', {})
        rows = []
        for t in teams or []:
            cars = [str(c).strip().lstrip('#') for c in (t.get('cars') or [])]
            rows.append({'name': str(t.get('name') or '').strip(), 'cars': [c for c in cars if c.isdigit()]})
        clean = normalize_teams(rows)
        if clean:
            book[self._series_key()] = clean
        else:
            book.pop(self._series_key(), None)
        self.save_settings()
        return self.teams_state()

    def set_team_rules(self, which, values):
        if which not in ('draft', 'other'):
            return self.teams_state()
        book = self.settings.setdefault('team_rules_by_mod', {}).setdefault(self._series_key(), {})
        cur = dict(vars(self._team_rules()[which]))
        cur.update(dict(values or {}))
        book[which] = dict(vars(TeamRules.from_dict(cur, DRAFT_RULES if which == 'draft' else OTHER_RULES)))
        self.save_settings()
        return self.teams_state()

    def set_stage_ends(self, ends):
        """Stages are set once, in All In One NR2003's Stage Racing window; they override the preset's stage settings. [] = Stage Racing's
        "Stages off" (no stage breaks, and the pre-stage era for the crew chief brain), None = Stage Racing off (the preset decides)."""
        new = None if ends is None else tuple(int(x) for x in ends)
        if new != self.stage_ends:
            self.stage_ends = new
            log.info('Stage ends from All In One NR2003: %s', ', '.join(str(x) for x in new) if new else ('stages off' if new == () else 'none'))

    def _era_stages(self):
        """StrategyParams.stages: 2.2's era test (has_wave_around = stages > 0) follows Stage Racing when it is on."""
        if self.stage_ends == ():
            return 0
        if self.stage_ends:
            return len(self.stage_ends) + 1
        return self.params.stages

    def set_wave_era(self, era):
        """Wave-around era for the crew chief brain's lapped-car calls: True (modern), False (pre-2009), None (2.2's stage test)."""
        era = None if era is None else bool(era)
        if era != self.wave_era:
            self.wave_era = era
            log.info('Crew chief wave-around era: %s', {True: 'wave-around (modern)', False: 'no wave-around (pre-2009)'}.get(era, 'from stages'))

    def set_art_roots(self, roots):
        """Art folders for the pit board (AIMOD's art/series layout: numbers, headshots, colors.json, logos)."""
        roots = [str(r) for r in (roots or []) if r]
        if roots != self._art_roots:
            self._art_roots = roots
            self._art = None

    def set_pit_lane_state(self, state):
        """Current AI Enhanced lane staging: staged / ready car indices, or None when the feature is inactive."""
        self._pit_lane_state = state

    def set_automatic_teams(self, teams):
        """Live team groups read from the current series' .car files by All In One NR2003."""
        self._automatic_teams = teams if isinstance(teams, list) else []

    def set_modern_superspeedway(self, enabled):
        """Enable live team/OEM coordination for Daytona and Talladega races."""
        self.modern_superspeedway = bool(enabled)

    def apply_learned(self):
        if self._learned:
            self.params.wear_l = round(self._learned[0], 3)
            self.params.wear_r = round(self._learned[1], 3)
            log.info('Applied learned wear thresholds: right %.3f, left %.3f', self._learned[1], self._learned[0])

    # ── context ───────────────────────────────────────────────────────────────────────────────────────────
    def _series_key(self):
        return self.mod or 'default'

    def _crew_modern(self):
        mod = self.mod or ''
        return bool((self.settings.get('pit_crew_by_mod') or {}).get(mod, default_modern(mod)))

    def set_crew_modern(self, on):
        self.settings.setdefault('pit_crew_by_mod', {})[self.mod or ''] = bool(on)
        self._crew_applied = None
        self.save_settings()

    def _team_rules(self):
        saved = (self.settings.get('team_rules_by_mod') or {}).get(self._series_key()) or {}
        return {'draft': TeamRules.from_dict(saved.get('draft'), DRAFT_RULES),
                'other': TeamRules.from_dict(saved.get('other'), OTHER_RULES)}

    def _team_of(self):
        configured = (self.settings.get('teams_by_mod') or {}).get(self._series_key()) or []
        if configured:
            teams = normalize_teams(configured)
        elif self.settings.get('auto_teams_all_tracks', False) or (self.modern_superspeedway and self._is_superspeedway_track()):
            teams = normalize_teams(self._automatic_teams)
        else:
            teams = []
        out = {}
        for k, t in enumerate(teams):
            for n in t['cars']:
                out[n] = k
        return out

    def _is_superspeedway_track(self):
        track = self.track.lower()
        if any(n in track for n in ROAD_COURSE_NAMES) or 'road' in track or 'roval' in track:
            return False
        return any(t in track for t in DRAFTING_TRACKS)

    def _is_drafting(self):
        mode = self.params.drafting
        auto = self._is_superspeedway_track()
        if mode == 'auto':
            return auto
        return mode == 'yes'

    def track_type(self):
        choice = self.params.track_type
        if choice in (SUPERSPEEDWAY, INTERMEDIATE, SHORT_TRACK, ROAD_COURSE):
            return choice
        if self._is_drafting():
            return SUPERSPEEDWAY
        if any(n in self.track.lower() for n in ROAD_COURSE_NAMES):
            return ROAD_COURSE
        if 100 < self.engine.track_len < SHORT_TRACK_M:
            return SHORT_TRACK
        return INTERMEDIATE

    def _tank_key(self):
        return (self.mod or 'unknown mod') + '|' + self.track

    def learned_tank(self):
        live = self.engine.field_tank
        if live:
            return live
        return (self.settings.get('tank_by_track') or {}).get(self._tank_key())

    def _save_learned_tank(self):
        live = self.engine.field_tank
        if live and self.track:
            book = self.settings.setdefault('tank_by_track', {})
            old = book.get(self._tank_key())
            book[self._tank_key()] = round(live, 1)
            if old is None or abs(old - live) >= 1.5:
                log.info('Fuel: %.1f laps a tank at %s (learned from real fuel)', live, self._tank_key())
                self.save_settings()

    def _strategy_params(self, mem_tank):
        p = self.params
        track_type = self.track_type()
        tank = p.tank_laps
        learned = self.learned_tank() if p.tank_source == 'memory' else None
        src = 'preset'
        if learned and learned >= 5:
            src = 'learned'
            tank = learned
        elif p.tank_source == 'memory' and 5 <= mem_tank <= 1000:
            src = 'game'
            tank = mem_tank
        if track_type == SUPERSPEEDWAY and p.tank_laps and tank < p.tank_laps:
            old_tank = tank
            tank = p.tank_laps
            log.info('Superspeedway fuel range: using the %.1f-lap preset over the %.1f-lap %s estimate',
                     tank, old_tank, src)
            src = 'preset floor'
        if self._tank_logged != (src, round(tank, 1)):
            self._tank_logged = (src, round(tank, 1))
            log.info('Fuel: planning on %.1f laps a tank (%s; game value %.2f)', tank, src, mem_tank)
        fuel_margin = p.fuel_margin
        worn_pct = p.worn_pct
        track_position_bias = p.track_position_bias
        modern_pack = self.modern_superspeedway and self._is_superspeedway_track() and track_type == SUPERSPEEDWAY
        if track_type == SUPERSPEEDWAY:
            # Use the real tank range more fully and reduce tire-driven stop pressure on drafting tracks.
            fuel_margin = min(fuel_margin, 0.25)
            worn_pct = max(worn_pct, 2.0)
            track_position_bias = max(track_position_bias, 80.0)
            key = (self.track, round(tank, 1))
            if self._fuel_first_logged != key:
                self._fuel_first_logged = key
                log.info('Superspeedway fuel-first strategy: %.1f laps a tank, %.2f-lap reserve, green pit calls held until fuel is at or below 15%%, higher stay-out bias and 2%% tire-wear tolerance',
                         tank, fuel_margin)
        else:
            self._fuel_first_logged = None
        # AIMOD 2.2 always plans with these on (its UI no longer has them); "force_22_options" off = the preset's own values (All In One NR2003 <= 2.1)
        f = {k: (True if self.settings.get('force_22_options', True) else bool(getattr(p, k))) for k in FORCED_22}
        return StrategyParams(**{
            'wear_r': p.wear_r, 'wear_l': p.wear_l, 'urgency_factor': p.urgency_factor,
            'damage_threshold': p.damage_threshold, 'tank_laps': tank, 'fuel_margin': fuel_margin,
            'plan_margin': p.plan_margin, 'dispersion_divisor': p.dispersion_divisor, 'max_tire_sets': p.max_tire_sets,
            'sets_include_start': f['sets_include_start'], 'plan_multi_stop': f['plan_multi_stop'] or track_type == SUPERSPEEDWAY,
            'guard_game_stops': f['guard_game_stops'], 'min_stop_gap': p.min_stop_gap, 'tire_only_stops': f['tire_only_stops'],
            'free_fuel': f['free_fuel'], 'free_fuel_four': 5 if self._crew_modern() else 4,
            'position_strategy': f['position_strategy'], 'lead_pack_gap': p.lead_pack_gap,
            'threat_positions': p.threat_positions, 'stint_strategy': p.stint_strategy or modern_pack,
            'track_position_bias': track_position_bias, 'oem_strategy': p.oem_strategy or modern_pack, 'oem_gap': p.oem_gap,
            'stint_spread': p.stint_spread, 'ss_stint_spread': p.ss_stint_spread, 'fuel_reach': p.fuel_reach,
            'ss_topoff_pct': p.ss_topoff_pct, 'lapped_wave': p.lapped_wave, 'pace_strategy': f['pace_strategy'],
            'worn_pct': worn_pct, 'team_strategy': p.team_strategy or modern_pack, 'follow_player': p.follow_player,
            'value_tires': f['value_tires'], 'finish_fuel': p.finish_fuel, 'track_type': track_type,
            'game_plan_off': 'no_game_plan_stops' in self.game.applied_patches,
            'rules_draft': self._team_rules()['draft'], 'rules_other': self._team_rules()['other'],
            'stages': self._era_stages(), 'stage_by': p.stage_by, 'stage_ends': tuple(parse_stage_ends(p.stage_ends) or ()),
            'stage_early': p.stage_early, 'flip_pct': p.flip_pct, 'crew_brain': bool(self.settings.get('crew_brain', True)),
            # AIMOD (Nov 2026): fuel and stage-break options
            'tank_extend_pct': p.tank_extend_pct, 'fuel_threshold_default': p.fuel_threshold_default,
            'green_fuel_aggressive': p.green_fuel_aggressive, 'green_fuel_threshold_min': p.green_fuel_threshold_min,
            'green_fuel_threshold_max': p.green_fuel_threshold_max, 'stage_call_lead': p.stage_call_lead,
            'stage_double_back_pct': p.stage_double_back_pct})

    @staticmethod
    def _fuel_fraction(car):
        try:
            fuel = float(car.fuel)
            capacity = float(car.fuel_cap)
            if capacity > 0 and fuel >= 0:
                return min(1.0, fuel / capacity)
        except (TypeError, ValueError):
            pass
        return None

    def _short_pit_free(self, state, p):
        """Option (off = All In One NR2003's hold for every car): with the crew chief brain on, a car whose stint plan is short-pit is not held to
        15% fuel, so the brain's short-pit / ATTACK plans at Daytona and Talladega pit when planned."""
        return bool(self.settings.get('ss_short_pit_relax', False) and getattr(p, 'crew_brain', False) and state.style == STYLE_SHORT_PIT)

    def _hold_early_superspeedway_calls(self, snap, p):
        """Hold ordinary drafting-track green stops until the car has 15% fuel or less."""
        drafting_track = p.track_type == SUPERSPEEDWAY or self._is_drafting()
        if not (drafting_track and snap.flag == mm.FLAG_GREEN and snap.session == mm.SESSION_RACE):
            self._ss_green_held = {}
            return {}
        lap_now = int(snap.laps_done)
        held = {}
        for car in snap.cars:
            if not (car.valid and not car.on_pit_road and not car.controlled):
                continue
            if car.black_flag or car.game_penalty or self.engine.condition_call(car):
                continue
            state = self.engine.cars.get(car.idx)
            if state is not None and (state.forced_damage or self._short_pit_free(state, p)):
                continue
            target = state.planned_lap if state is not None else None
            target_due = isinstance(target, int) and target <= int(car.laps_done) + 1
            strategy_call = state is not None and state.decision is True
            was_held = car.idx in self._ss_green_held
            request_active = car.pitting or target_due or strategy_call or was_held
            car_lap = int(car.laps_done) + 1 if car.laps_done > 0 else lap_now
            fuel_fraction = self._fuel_fraction(car)
            planned_too_early = isinstance(target, int) and target > car_lap + 1
            fuel_too_early = fuel_fraction is not None and fuel_fraction > 0.15
            if fuel_too_early or (request_active and planned_too_early):
                # Keep the request bit clear every AIMOD tick while fuel is above
                # the threshold, including before the strategy creates a plan.
                car.pitting = False
                held[car.idx] = fuel_fraction
                if request_active and not was_held:
                    fuel_pct = 'unknown' if fuel_fraction is None else '%.1f%%' % (fuel_fraction * 100)
                    log.info('Superspeedway green pit hold: #%s at %s fuel; waiting for 15%% or less',
                             car.number, fuel_pct)
                continue
            if not request_active:
                continue
        self._ss_green_held = held
        return held

    # ── crew chief adjustments (AIMOD's own CrewChief, adjust.py): at an AI stop the crew chief may change the car's chassis balance ─────────
    def _setup_crew_chief(self):
        base_dir = ''
        try:
            if self.game.pm is not None:
                base_dir = self.game.nr2003_dir() or ''
        except Exception:  # noqa: BLE001
            base_dir = ''
        if not base_dir:
            base_dir = self.settings.get('nr2003_dir', '')
        elif self.settings.get('nr2003_dir') != base_dir:
            self.settings['nr2003_dir'] = base_dir
        setup = None
        if self.track and base_dir:
            setup = ai_setup(base_dir, self.track, self.mod) if self.mod else None
            if not setup:
                setup = ai_setup(base_dir, self.track)
        self.engine.crew_chief.reset(setup)
        self._restore_chassis()
        ratings = {}
        profiles = {}
        agg_vals, agg_names = {}, {}
        if self.game.pm is not None and self.mod:
            for path in self.game.session_car_files(self.mod):
                info = carfiles.car_info(path)
                if not info:
                    continue
                num = info['number']
                agg_vals[int(num)] = info.get('driver_aggression')
                agg_names[int(num)] = info.get('name', '')
                if info.get('pitcrew_speed') is not None:
                    cons = info.get('pitcrew_consistency') or info['pitcrew_speed']
                    ratings[num] = (info['pitcrew_speed'] + cons) / 2
                # AIMOD 2.2: every car gets a crew chief profile (the brain's caution calls / stint style), rated or not
                profiles[num] = CrewChiefProfile.from_car_info(info, driver_name=info.get('name', ''))
        self.engine.crew_rating = ratings
        self.engine.cc_profiles = profiles
        # each driver's temperament (who manages his tires, who short-pits, who holds a grudge): his .car aggression's place in this
        # field; the name hash for cars without one
        set_temperaments(agg.temperaments(agg_vals, agg_names) if agg_vals else {})
        if agg_vals:
            log.info('Temperaments from the .car aggression for %d cars (%d without one use the name)',
                     sum(v is not None for v in agg_vals.values()), sum(v is None for v in agg_vals.values()))
        if setup:
            log.info('AI setup for %s: wedge %+d lb, track bar %.2f/%.2f in, tape %d%%, RR %.1f psi, %d crew ratings',
                     self.track, *(list([setup['wedge']]) + list(setup['track_bar']) + [setup['tape'], setup['pressure'][3], len(ratings)]))

    def _crew_setup_change(self, ev, adj):
        """Describe the crew chief's modeled setup value before and after this call."""
        kind = getattr(adj, 'kind', '')
        amount = float(getattr(adj, 'amount', 0.0) or 0.0)
        labels = {
            'wedge': ('wedge', 'lb', 0, 'wedge'),
            'track_bar': ('rear track bar', 'in', 1, 'track_bar'),
            'pressure': ('right-rear air', 'psi', 1, 'rr_pressure'),
            'tape': ('grille tape', '%', 0, 'tape'),
        }
        if kind not in labels:
            return getattr(adj, 'short', 'setup adjustment')
        label, unit, precision, state_field = labels[kind]
        try:
            setup = self.engine.crew_chief.base or {}
            state = self.engine.crew_chief.state(ev.idx)
            if kind == 'track_bar':
                base_value = setup.get('track_bar', (0.0, 0.0))[1]
            elif kind == 'pressure':
                base_value = setup.get('pressure', (0.0, 0.0, 0.0, 0.0))[3]
            else:
                base_value = setup.get(kind, 0.0)
            after = float(base_value) + float(getattr(state, state_field))
            before = after - amount
            fmt = '.%df' % precision
            change = format(amount, '+' + fmt)
            return 'modeled %s %s -> %s %s (%s %s)' % (
                label, format(before, fmt), format(after, fmt), unit,
                change, unit)
        except Exception:  # noqa: BLE001 - keep the crew chief log useful if setup data is incomplete
            return getattr(adj, 'short', 'setup adjustment')

    def _apply_adjust_effect(self, ev):
        adj = getattr(ev, 'adjust', None)
        if adj is None:
            return

        details = [getattr(adj, 'short', 'crew chief adjustment'), self._crew_setup_change(ev, adj)]
        diagnosis = getattr(adj, 'diagnosis', '')
        if diagnosis:
            details.append('diagnosed %s' % diagnosis)
        details.append('good call' if getattr(adj, 'good_call', False) else 'misread')

        effect = float(getattr(adj, 'effect', 0.0) or 0.0)
        if not self.settings.get('adjust_handling', True):
            details.append('chassis balance unchanged; handling adjustments are disabled (modeled effect %+.3f)' % effect)
        elif self.game.pm is None or not self.game.write_enabled:
            details.append('chassis balance unchanged; game memory is not writable (modeled effect %+.3f)' % effect)
        elif not effect:
            details.append('chassis balance unchanged (no handling effect)')
        else:
            try:
                addr = mm.CAR_BLOCK_0 + ev.idx * mm.CAR_STRIDE + CHASSIS_VALUE
                previous = struct.unpack('<f', self.game.pm.read_bytes(addr, 4))[0]
                base = self._chassis_base.get(ev.idx)
                if base is None:
                    base = previous
                    if not (0.05 < base < 3.0):
                        details.append('chassis balance not changed; invalid starting value %.3f' % base)
                        log.info('Crew chief #%s %s lap %d: %s', ev.number, ev.name, ev.lap, '; '.join(details))
                        return
                    self._chassis_base[ev.idx] = base
                total = self.engine.crew_chief.state(ev.idx).chassis
                applied = max(0.05, base + total)
                self.game.pm.write_bytes(addr, struct.pack('<f', applied), 4)
                details.append('chassis balance %.3f -> %.3f (%+.3f applied)' % (previous, applied, applied - previous))
            except Exception as e:  # noqa: BLE001
                details.append('chassis balance not changed (%s)' % e)
                log.debug('adjust effect failed: %s', e)

        log.info('Crew chief #%s %s lap %d: %s', ev.number, ev.name, ev.lap, '; '.join(details))

    def _restore_chassis(self):
        if self.game.pm is not None:
            for idx, base in list(self._chassis_base.items()):
                try:
                    self.game.pm.write_bytes(mm.CAR_BLOCK_0 + idx * mm.CAR_STRIDE + CHASSIS_VALUE, struct.pack('<f', base), 4)
                except Exception:  # noqa: BLE001
                    pass
        self._chassis_base = {}

    # ── track / session ───────────────────────────────────────────────────────────────────────────────────────
    def _use_tire_model(self):
        if self.track and self.mod:
            label = ' [modern pit crew]' if self._crew_modern() else ''
            self.tire_model.use(self.mod + label, self.track, seed_mod=self.mod, seed_tire_scale=0.6875)

    def _check_track(self):
        track = ''
        mod = ''
        if self.game.attached:
            names = self.game.session_names()
            track = names[0]
            mod = names[1]
        if mod and mod != self.mod:
            self.mod = mod
            self._crew_applied = None
            log.info('NR2003 series (mod): %s', mod)
            self.engine.hand_off_runs()
            self._use_tire_model()
            if self.track:
                self._setup_crew_chief()
        if not track:
            return
        if track != self.track:
            self.track = track
            self.engine.hand_off_runs()
            self._use_tire_model()
            log.info('Track detected (game): %s', track)
            self._setup_crew_chief()
            if self._last_session is not None:
                self.clear_session('track changed')
            if self.settings.get('auto_load', True):
                name = self.store.find_for_track(track)
                if name and name != self.loaded_name:
                    self.load_preset(name)
                elif not name:
                    log.info("No preset linked to '%s' - load one and press 'Use this preset for the current track'", track)

    def _new_session_reason(self, snap):
        valid = [c.laps_done for c in snap.cars if c.valid]
        leader = max(valid, default=0)
        last_clock = self._last_clock
        last_leader = self._last_leader
        dropped = len(valid) >= 5 and last_leader >= 3 and (leader + 2) < last_leader
        self._drop_ticks = self._drop_ticks + 1 if dropped else 0
        if not dropped and len(valid) >= 5:
            self._last_leader = leader
        if snap.session_time > 0:
            self._last_clock = snap.session_time
        if self._last_session is None:
            return ''
        if snap.session != self._last_session:
            self._last_leader = leader
            return 'session type changed'
        if self._drop_ticks >= 8:
            self._drop_ticks = 0
            self._last_leader = leader
            return "leader's lap count went from %s to %s" % (last_leader, leader)
        if last_clock and 0 < snap.session_time < last_clock - 30:
            return 'race clock restarted'
        return ''

    def clear_session(self, why='cleared'):
        log.info('New session (%s) - AIMOD data cleared', why)
        try:
            self.results.finish(why)          # the race that just ended (before its data is cleared)
        except Exception:  # noqa: BLE001
            log.exception('Race results failed')
        self._behavior_restore()
        self._restore_chassis()
        try:
            if self.game.pm is not None and self.settings.get('restore_on_exit', True) and self.gearbox.applied not in (None, 4):
                self.gearbox.restore(self.game.pm)
        except Exception as e:  # noqa: BLE001 - best effort, never block exit
            log.warning('gearbox restore failed: %s', e)
        self.engine.reset()
        self.tire_model.save()
        self.wavelog.reset()
        self.pitlog.new_session()
        self.pit_events = []
        self._last_rows = []
        self._flagged = set()

    def set_wave_log(self, path):
        path = str(path or '')
        if path == self._wave_log_path:
            return False
        self._wave_log_path = path
        self.wavelog = WaveLog(path or None)
        log.info('RaceControl log source: %s', path or '(none)')
        return True

    def _behavior_restore(self):
        pm = self.game.pm
        if pm is not None and self.game.write_enabled:
            try:
                n = self.behavior_writer.restore(pm)
                if n:
                    log.info('Driver behavior: game pace values restored on %d cars', n)
            except Exception as e:
                log.warning('Driver behavior restore failed: %s', e)
        else:
            self.behavior_writer.reset()
        pm = self.game.pm
        if pm is not None and self.game.write_enabled:
            try:
                n = self.agg_writer.restore(pm)
                if n:
                    log.info('Racing intensity: own aggression values back on %d cars', n)
            except Exception as e:
                log.warning('Racing intensity restore failed: %s', e)
        else:
            self.agg_writer.restore(None)            # nothing can be written: the restore file stays
        if self._agg_stage is not None:
            self._agg_summary('stage %s (end)' % self._agg_stage)
        self.agg_trace.close()
        self._agg_reset_race()
        self.contacts.reset()
        self.intensity.reset()
        self._rival_onscreen = None
        self.behavior.reset()
        self.engine.fuel_save_gain = 0.0
        self.engine.behavior_cars = set()
        self.engine.behavior_switches = []

    def _behavior_tick(self, snap, res, sp):
        p = self.params
        cfg = self.behavior.cfg
        cfg.enabled = bool(p.behavior_on)
        cfg.strength = int(p.behavior_strength)
        cfg.late_push_pct = int(p.behavior_late_pct)
        cfg.reactions = bool(p.behavior_reactions)
        cfg.teams = bool(p.behavior_teams)
        pm = self.game.pm
        can_write = bool(self.game.write_enabled and pm is not None and self.behavior_writer.available(pm))
        if cfg.enabled and not can_write:
            cfg.enabled = False
        self.engine.behavior_on = bool(cfg.enabled)   # 2.2: temperament stint style + "tires still good" calls follow driver behavior
        ctx, cars = behavior_inputs(self.engine, res, snap, sp)
        keep = self.behavior.effect(SAVE_FUEL, True).fuel
        if cfg.enabled and ctx.drafting and 0 < keep < 1:
            self.engine.fuel_save_gain = 1.0 / keep - 1.0
        else:
            self.engine.fuel_save_gain = 0.0
        out = self.behavior.tick(ctx, cars)
        for sw in out.switches:
            if sw.new:
                log.info('BEHAVIOR lap %d: #%s %s -> %s (%s)', self.engine.lap_now, sw.number, sw.name, sw.new, sw.reason)
            elif sw.old and ctx.green and ctx.race:
                log.info('BEHAVIOR lap %d: #%s %s back to normal', self.engine.lap_now, sw.number, sw.name)
        on_track = {c.idx: c.on_track for c in cars}
        if can_write and (out.effects or self.behavior_writer.scale or self.behavior_writer.wear_last or self.behavior_writer.fuel_last):
            self.behavior_writer.apply(pm, out.effects, on_track)
        self.engine.behavior_cars = set(out.effects)
        self.engine.behavior_switches = out.switches
        for row in res.rows:
            mode = out.modes.get(row.idx)
            row.behavior = mode[0] if mode else ''
        try:
            self._intensity_tick(snap, ctx, cars)
        except Exception:                        # racing intensity must never stop the strategy tick
            now = time.monotonic()
            if now - self._intensity_error > 60:
                self._intensity_error = now
                log.exception('Racing intensity failed (repeats are logged once a minute)')

    # ── racing intensity & rivals (AIMOD Nov 2026, App._intensity_tick and its helpers) ─────────────────────────
    def _intensity_tick(self, snap, ctx, cars):
        """Racing intensity & rivals: each AI car's working aggression, from the race phase, who he is racing, his
        damage and his teammates (aggression.py). SHADOW decides and logs, writes nothing."""
        p = self.params
        pm = self.game.pm
        mode = p.agg_mode if p.agg_mode in agg.MODES else agg.OFF
        if self._agg_external_off:
            mode = agg.OFF
        if mode != agg.OFF and not (self.game.write_enabled and self.agg_writer.available(pm)):
            mode = agg.OFF
        if mode != self._agg_mode:
            n = self.agg_writer.restore(pm)          # every car back to his own value before the new mode
            self.intensity.reset()
            log.info('Racing intensity: %s%s', mode.upper(), (' (own values back on %d cars)' % n) if n else '')
            self._agg_mode = mode
        cfg = self.intensity.cfg
        cfg.mode, cfg.strength, cfg.teams = mode, p.agg_strength, p.behavior_teams
        self.engine.rival_events = []
        self._rival_onscreen = None
        if mode == agg.OFF:
            return
        w = self.agg_writer
        held_nums = showdown_lock.read()                      # tools\aggression_probe.py --showdown owns these cars
        if held_nums:
            slots = [c.idx for c in cars if int(c.number) in held_nums]
            if set(slots) - w.held:
                n = w.hold(pm, slots)
                log.info('Racing intensity: showdown probe has cars %s - their own values back (%d written), '
                         'left alone until it is done', sorted(held_nums), n)
            else:
                w.hold(pm, slots)
        elif w.held:
            w.unhold()
            log.info('Racing intensity: showdown probe is done - the cars are mine again')
        now = time.monotonic()
        t = snap.session_time if getattr(snap, 'session_time', 0) > 0 else now
        lap = self.engine.lap_now
        tag = ' [shadow]' if mode == agg.SHADOW else ''
        if ctx.race and ctx.green and snap.laps_done >= 1:     # after the game's start roll
            n = w.capture(pm, [c.idx for c in cars], self.game.session_names())
            if n:
                if self._agg_seed is None:                   # a new race: new rivals, a new seed for their dice
                    import random
                    self._agg_seed = random.SystemRandom().randrange(1 << 30)
                    self.rivals.reset(self._agg_seed)
                    self.contacts.reset()
                    self._race_pairs = {}
                    self._apply_season_rivals()
                self.agg_trace.open(self.track)              # (at once: nothing of the race is missed)
                self._agg_new, self._agg_new_t = self._agg_new + n, now
        if self._agg_new and now - self._agg_new_t > 2.0:      # (cars come in over a second or two: one line)
            vals = sorted(w.orig.values())
            log.info('Racing intensity: own aggression of %d cars taken (%.2f-%.2f), rivals seed %s%s', len(vals),
                     vals[0], vals[-1], self._agg_seed, tag)
            self.agg_trace.row(time=AggTrace.stamp(), game_s=t, lap=lap, event='capture', mode=mode,
                               detail='%d cars %.3f-%.3f seed %s' % (len(vals), vals[0], vals[-1], self._agg_seed))
            self._agg_new = 0
        if not w.captured:
            return
        names = {c.idx: (c.number, c.name) for c in cars}
        for s, old, new in w.rerolls(pm):
            num, name = names.get(s, ('?', 'slot %s' % s))
            log.info('AGGRESSION: #%s %s rolled again by the game %.3f -> %.3f (his own value now)', num, name, old, new)
            self.agg_trace.row(time=AggTrace.stamp(), game_s=t, lap=lap, event='reroll', car=num, driver=name,
                               old=old, new=new, mode=mode)

        # rivals: who has it in for whom (run-ins, the list, cautions that settle a pair)
        book = self.rivals
        book.teammates, book.retaliation = p.rivals_teammates, p.rivals_retaliate
        book.teams = {int(c.number): c.team for c in cars}
        pairs = self._rival_pairs() if p.rivals_list else set()
        if pairs != book.pairs:
            book.set_pairs(pairs)
        player = self._player_car(snap) if p.rivals_player else None
        book.player = int(player.number) if player is not None else None
        temper = {int(c.number): c.temper for c in cars}
        green = snap.flag == mm.FLAG_GREEN
        ev = []
        if ctx.race:
            if green and self._agg_prev_flag == mm.FLAG_GREEN:
                self._agg_stats['green_s'] += max(0.0, min(5.0, t - self._agg_prev_t))
            for con in self.contacts.update(t, snap.cars, green):
                if held_nums and (int(con.na) in held_nums or int(con.nb) in held_nums):
                    continue                                  # the showdown's own contacts are no race run-ins
                boosted = False
                for i in (con.a, con.b):
                    st = self.intensity.state.get(i)
                    if st is not None and st.target is not None and st.target > w.orig.get(i, 99.0) + 0.05:
                        boosted = True
                self._agg_stats['contacts'] += 1
                self._agg_stats['boosted_contacts'] += boosted
                agg_num = con.na if con.aggressor == con.a else con.nb if con.aggressor == con.b else ''
                self.agg_trace.row(time=AggTrace.stamp(), game_s=t, lap=lap, event='contact', car=con.na,
                                   other=con.nb, old=con.da, new=con.db, mode=mode,
                                   detail=(('aggressor #%s' % agg_num) if agg_num != '' else 'side by side')
                                   + (', boosted' if boosted else ''))
                if p.rivals_on:
                    ev += book.runin(con, lap, temper, boosted)
            if p.rivals_on:
                if self._agg_prev_flag == mm.FLAG_GREEN and not green:
                    ev += book.caution(t, lap)
                ev += book.update(lap, {int(c.number): (c.damage, c.on_track) for c in cars})
        self._agg_prev_flag, self._agg_prev_t = snap.flag, t
        out = self.intensity.tick(ctx, cars, w.orig, book if p.rivals_on else None,
                                  [player] if player is not None else [], temper)

        by_num = {int(c.number): c for c in cars}
        for e in ev:
            self._agg_stats[e.kind] = self._agg_stats.get(e.kind, 0) + 1
            h, o = by_num.get(e.holder), by_num.get(e.other)
            hn = ('#%s %s' % (e.holder, h.name)) if h else ('#%s' % e.holder)
            on = ('#%s %s' % (e.other, o.name)) if o else ('#%s' % e.other)
            text = {'runin': 'run-in %s / %s (%s)' % (hn, on, e.detail),
                    'grudge': '%s holds a grudge against %s' % (hn, on),
                    'feud': '%s and %s: feud level %s (%s)' % (hn, on, e.level, e.detail),
                    'wrecked': "%s wrecked by %s (%s) - retaliation if his stop can't fix it" % (hn, on, e.detail),
                    'retaliate': '%s is going after %s (%s)' % (hn, on, e.detail),
                    'settled': '%s and %s: settled (%s)' % (hn, on, e.detail),
                    'governor': 'governor: %s' % e.detail}.get(e.kind, e.kind)
            if e.kind != 'runin':
                log.info('RIVALS lap %d: %s%s', e.lap or lap, text, tag)
                self._rival_log.append({'lap': e.lap or lap, 'kind': e.kind, 'text': text, 'shadow': mode == agg.SHADOW})
                del self._rival_log[:-40]
            self.agg_trace.row(time=AggTrace.stamp(), game_s=t, lap=e.lap or lap, event=e.kind, car=e.holder,
                               driver=h.name if h else '', other=e.other, mode=mode, detail=e.detail,
                               reasons='level %s' % e.level)
            for num in (e.holder, e.other):
                c = by_num.get(num)
                if c is not None:
                    self.engine.rival_events.append((c.idx, e))
            if e.kind in ('runin', 'settled', 'retaliate'):
                ps = self._race_pairs.setdefault(agg.pair_key(e.holder, e.other), {'runins': 0, 'settled': 0, 'retaliate': False})
                if e.kind == 'runin':
                    ps['runins'] += 1
                elif e.kind == 'settled':
                    ps['settled'] += 1
                else:
                    ps['retaliate'] = True
        for ch in out.changes:
            self._agg_stats['changes'] += 1
            self.agg_trace.row(time=AggTrace.stamp(), game_s=t, lap=lap, event='change', car=ch.number,
                               driver=ch.name, own=ch.base, old=ch.old, new=ch.new, reasons=ch.reasons, mode=mode,
                               gap=ch.gap if ch.gap is not None else '')
            if any(k in ch.reasons for k in ('grudge:', 'feud:', 'rival:', 'retaliate:')):
                gap = (', %.2f s' % ch.gap) if ch.gap is not None else ''
                log.info('AGGRESSION lap %d: #%s %s %.2f -> %.2f (%s%s; own %.2f)%s', lap, ch.number, ch.name,
                         ch.old, ch.new, ch.reasons, gap, ch.base, tag)
        for v in out.targets.values():
            self._agg_stats['peak'] = max(self._agg_stats['peak'], v)
        stage = agg.phase(ctx.lap_now, ctx.total, ctx.stage_ends).stage if ctx.race else self._agg_stage
        if self._agg_stage is not None and stage != self._agg_stage:
            self._agg_summary('stage %s' % self._agg_stage)
        self._agg_stage = stage
        w.apply(pm, out.targets, shadow=(mode == agg.SHADOW))
        scales = {}
        if mode == agg.ON and p.agg_side_pad < 100:
            k = p.agg_side_pad / 100.0
            for idx, st in self.intensity.state.items():
                own = w.orig.get(idx)
                if st.target is not None and own is not None and st.target > own + 0.05:
                    scales[idx] = k
        w.apply_side(pm, scales, shadow=(mode == agg.SHADOW))
        if p.rivals_on:
            self._update_rival_onscreen(pm, snap.cars)

    def _agg_reset_race(self):
        self._agg_seed = None
        self._agg_new, self._agg_new_t = 0, 0.0
        self._agg_prev_flag, self._agg_prev_t = None, 0.0
        self._agg_stage = None
        self._agg_stats = {'changes': 0, 'contacts': 0, 'boosted_contacts': 0, 'green_s': 0.0, 'peak': 0.0}
        self._rival_log = []

    def _agg_summary(self, what):
        """One aimod.log line per stage: how hard they raced, contact rate, rivals."""
        s = self._agg_stats
        if not s['changes'] and not s['contacts']:
            return
        mins = s['green_s'] / 60.0
        rate = ('%.1f per 10 green min' % (10 * s['contacts'] / mins)) if mins > 0.5 else '-'
        riv = ', '.join('%s %s' % (k, s[k]) for k in ('grudge', 'feud', 'wrecked', 'retaliate', 'settled', 'governor') if s.get(k))
        log.info('Racing intensity %s: %d changes, peak %.2f; contacts %d (%s, %d with a boosted car)%s', what,
                 s['changes'], s['peak'], s['contacts'], rate, s['boosted_contacts'], ('; rivals: ' + riv) if riv else '')
        self.agg_trace.row(time=AggTrace.stamp(), event='summary', detail='%s: %s' % (what, s))
        for k in list(s):
            s[k] = 0.0 if k in ('green_s', 'peak') else 0

    def _rival_pairs(self):
        """The loaded mod's rivalries (the Rivals list), as car-number pairs."""
        from .rivals_ui import normalize as normalize_rivals
        saved = (self.settings.get('rivals_by_mod') or {}).get(self._series_key()) or []
        return {agg.pair_key(a, b) for a, b in normalize_rivals(saved)}

    def _update_rival_onscreen(self, pm, cars):
        self._rival_onscreen = None
        if not self.rival_ind_cfg.get('on', True):
            return
        tv = _radio.tv_slot(pm) if pm is not None else None
        if tv is None:
            return
        by_idx = {c.idx: c for c in cars}
        me = by_idx.get(tv)
        if me is None:
            return
        st = self.intensity.state.get(tv)
        cands = []
        if st is not None and st.rival is not None and st.target is not None:
            cands.append((st.rival[1], st.rival[0]))
        for idx, o in self.intensity.state.items():          # someone close by going after the TV car
            c = by_idx.get(idx)
            if c is not None and o.rival is not None and o.target is not None and o.rival[1] == me.number:
                cands.append((c.number, o.rival[0]))
        hit = None
        for num, kind in cands:
            other = next((c for c in cars if c.number == num and c.valid), None)
            if other is not None and agg.close_enough_for_screen(me, other, cars):
                hit = (me.number, num, kind)             # (a rival a few cars away is not the picture on screen)
                break
        if hit is None:
            return
        f = self.rivals.feuds.get(agg.pair_key(hit[0], hit[1]))
        self._rival_onscreen = (CarNo(int(hit[0])), CarNo(int(hit[1])), hit[2], f.level if f else 0)

    def _player_car(self, snap):
        """The player's car as a behavior.Car (player rivals: for who is near whom; never written)."""
        from .behavior import Car
        pc = next((c for c in snap.cars if c.idx == mm.PLAYER_SLOT and c.valid), None)
        ps = self.engine.prog_state.get(mm.PLAYER_SLOT)
        if pc is None or ps is None or pc.number <= 0:
            return None
        return Car(mm.PLAYER_SLOT, pc.number, pc.name, lap=pc.laps_done + 1, progress=ps[0] + ps[2] + ps[1],
                   on_track=not pc.on_pit_road and not pc.reason_out)

    # for All In One NR2003's AIMOD window: the rivals list of the loaded mod, the cars to pick from, the rivals card
    def set_external_off(self, on):
        """RaceLab (SpinMod.dll) runs its own allies / rivals in the game: racing intensity off (every driver's own aggression back)"""
        on = bool(on)
        if on != self._agg_external_off:
            self._agg_external_off = on
            log.info('Racing intensity & rivals: %s', 'standing aside (RaceLab runs its own allies / rivals)' if on else 'back (RaceLab stopped)')
        return on

    def rivals_state(self):
        from .rivals_ui import normalize as normalize_rivals
        snap = self._last_snap
        cars = sorted({str(CarNo(c.number)) for c in (snap.cars if snap else []) if c.valid and c.number > 0}, key=lambda s: (len(s), s))
        pairs = normalize_rivals((self.settings.get('rivals_by_mod') or {}).get(self._series_key()) or [])
        feuds = []
        for key, f in self.rivals.feuds.items():
            feuds.append({'a': str(CarNo(int(key[0]))), 'b': str(CarNo(int(key[1]))), 'level': getattr(f, 'level', 0)})
        return {'mod': self._series_key(), 'pairs': [[str(a), str(b)] for a, b in pairs], 'cars': cars,
                'mode': self._agg_mode, 'feuds': feuds, 'log': list(self._rival_log), 'indicator': dict(self.rival_ind_cfg)}

    def set_rivals(self, pairs):
        from .rivals_ui import normalize as normalize_rivals
        clean = normalize_rivals(pairs or [])
        self.settings.setdefault('rivals_by_mod', {})[self._series_key()] = [[int(a), int(b)] for a, b in clean]
        self.save_settings()
        log.info('Rivals for %s: %s', self._series_key(), '; '.join('#%s vs #%s' % (CarNo(a), CarNo(b)) for a, b in clean) or 'none')
        return self.rivals_state()

    def set_rival_indicator(self, patch):
        for k in ('on', 'x', 'y', 'size', 'opacity'):
            if k in (patch or {}):
                self.rival_ind_cfg[k] = patch[k]
        self.save_settings()
        return dict(self.rival_ind_cfg)

    # ── season mode (All In One NR2003): rivalries that carry on from race to race ────────────────────────────────────────
    def set_season_rivals(self, rivals):
        """The season's rivalries ([{a, b, level, holder}], None = none) for a race that counts: they start the race at their level."""
        self._season_rivals = list(rivals) if rivals else None
        if self._agg_seed is not None:           # the race is already on: in now
            self._apply_season_rivals()
        return len(self._season_rivals or [])

    def _apply_season_rivals(self):
        for r in self._season_rivals or []:
            try:
                a, b = CarNo(int(r['a'])), CarNo(int(r['b']))
                lvl = max(0, min(agg.MAX_LEVEL, int(r.get('level') or 0)))
            except (TypeError, ValueError, KeyError):
                continue
            if a == b or lvl <= 0:
                continue
            k = agg.pair_key(a, b)
            f = self.rivals.feuds.get(k)
            if f is None:
                f = self.rivals.feuds[k] = agg.Feud(*k)
            f.runins = max(f.runins, lvl - (1 if f.listed else 0))
            h = r.get('holder')
            if lvl == 1 and h is not None and not f.listed:
                try:
                    f.holder = CarNo(int(h))
                except (TypeError, ValueError):
                    pass
        if self._season_rivals:
            log.info('Rivals: %d rivalr%s carried over from the season', len(self._season_rivals), 'y' if len(self._season_rivals) == 1 else 'ies')

    def race_rivals(self):
        """The feuds of the race that is ending, for the season: [{a, b, level, runins, settled, retaliate, holder, listed}]."""
        out = []
        for k, f in self.rivals.feuds.items():
            ps = self._race_pairs.get(k, {})
            if not (f.level > 0 or ps.get('runins') or ps.get('settled')):
                continue
            out.append({'a': int(k[0]), 'b': int(k[1]), 'level': int(f.level), 'runins': int(ps.get('runins', 0)),
                        'settled': int(ps.get('settled', 0)), 'retaliate': bool(ps.get('retaliate') or f.retaliate is not None),
                        'holder': int(f.holder) if f.holder is not None else None, 'listed': bool(f.listed)})
        return out

    def rival_onscreen(self):
        """The rivals card: the car on TV and his rival (or the car going after him), what it is, the feud level; None = no card."""
        r = self._rival_onscreen
        if not r:
            return None
        out = {'car': str(r[0]), 'rival': str(r[1]), 'kind': r[2], 'level': r[3], 'cfg': dict(self.rival_ind_cfg)}
        art = self._artdata() if self._art_roots else None
        for k, num in (('car', r[0]), ('rival', r[1])):
            try:
                out[k + '_color'] = art.color(num) if art else None
                out[k + '_img'] = art.rel_number(num) if art else None
            except Exception:  # noqa: BLE001 - plain cards
                out[k + '_color'] = out[k + '_img'] = None
        return out

    def _black_flags(self, now):
        if now - self._flag_check >= 1.0:
            self._flag_check = now
            self._mem_flags = self.game.black_flags()
        return set(self._mem_flags)

    def _sync_pit_crew(self, snap):
        if self.game.pm is None or not self.mod:
            return
        modern = self._crew_modern()
        want = (self.game.pm.process_id, modern)
        now = time.monotonic()
        if self._crew_applied == want and now - self._crew_check > 10.0:
            self._crew_check = now
            if self.pitcrew.is_modern(self.game.pm) != modern:
                log.info('Pit crew was changed outside AIMOD - setting it again')
                self._crew_applied = None
        if self._crew_applied == want or now - self._crew_try < 10.0:
            return
        self._crew_try = now
        on_road = any(c.valid and c.on_pit_road for c in snap.cars)
        if self.pitcrew.apply(self.game.pm, modern, on_road):
            self._crew_applied = want
            log.info('%s (%s)', self.pitcrew.status, self.mod)

    # ── the pit gate (AIMOD, Nov 2026): an AI car turns for pit road only on AIMOD's call, a rule stop or an empty tank ──
    def _gate_tick(self, snap, res):
        pm = self.game.pm
        if pm is None:
            return
        want = (bool(self.settings.get('pit_gate', True)) and self.game.write_enabled and snap.session == mm.SESSION_RACE
                and self.engine.race_started and res.laps_to_go > 0)
        if want:
            self.pitgate.install(pm)
            allow = set(self.engine.gate_allow(snap))
            # All In One NR2003's holds (pit lane staging, the superspeedway fuel hold) keep a car out unless a rule stop or an empty tank calls it
            for c in snap.cars:
                if c.idx in self._gate_hold and c.idx in allow and not (c.rule_pending or c.game_penalty or c.game_repair >= 1):
                    gauge = c.fuel / c.fuel_cap if c.fuel is not None and c.fuel_cap else None
                    if gauge is None or gauge >= 0.12:
                        allow.discard(c.idx)
            self.pitgate.set_allow(pm, allow)
            if self.pitgate.arm(pm):
                if not self._gate_armed:
                    self.pitgate.status = 'Pit gate: on (only AIMOD sends cars to pit road)'
                    log.info("Pit gate on (v2): AI cars turn for pit road only on AIMOD's call, a penalty / repair / tow stop or an empty tank"
                             " - the game's own pit request no longer opens it")
                self._gate_armed = True
        elif self._gate_armed or self.pitgate.cave is not None:
            self.pitgate.disarm(pm)
            if self._gate_armed:
                self.pitgate.status = 'Pit gate: ready (off outside a race)'
                log.info('Pit gate off (%s)', 'turned off' if not self.settings.get('pit_gate', True)
                         else ('race over' if snap.session == mm.SESSION_RACE else 'not a race'))
            self._gate_armed = False
        held = self.pitgate.held(pm)
        if not held:
            return
        now = self.engine.now
        by_slot = {c.idx: c for c in snap.cars if c.valid}
        for slot, n in held.items():
            self._gate_held_total += n
            c = by_slot.get(slot)
            last = self._gate_logged.get(slot)
            if c is None or (last is not None and 0 <= now - last < 60.0):
                continue
            self._gate_logged[slot] = now
            green = snap.flag == mm.FLAG_GREEN
            log.info("Pit gate: held #%s %s on track - the game turned it for pit road %s, AIMOD didn't call it",
                     c.number, c.name, 'under green' if green else 'under caution')
            self.engine.note_gate_hold(slot, green)

    # ── per-tick ──────────────────────────────────────────────────────────────────────────────────────────
    def tick(self):
        """One AIMOD pass. Never raises for ordinary game states; returns the status dict the UI shows."""
        now = time.monotonic()
        if now - self._last_track_check >= TRACK_CHECK_S:
            self._last_track_check = now
            self._check_track()
        st = self._status = {'attached': False, 'enabled': self.enabled, 'track': self.track, 'mod': self.mod,
                             'patch': self.game.patch_status, 'write': False, 'gate': self.pitgate.status}
        if not self.game.attached:
            if self._was_attached:
                self._was_attached = False
                try:
                    self.results.finish('game closed')
                except Exception:  # noqa: BLE001
                    log.exception('Race results failed')
            if now - self._last_attach_try >= ATTACH_RETRY_S:
                self._last_attach_try = now
                if self.game.attach():
                    self.engine.reset()
                    self.behavior.reset()
                    self.behavior_writer.reset()
                    self.intensity.reset()
                    self.agg_writer.reset()
                    if self.enabled:
                        self.game.apply_patches(self.settings['patches'])
                    if self.game.write_enabled:
                        # an AIMOD that closed without restoring left aggression values in this same game
                        try:
                            n = self.agg_writer.recover(self.game.pm, self.game.session_names())
                            if n:
                                log.info('Racing intensity: own aggression values put back on %d cars (left by an earlier AIMOD)', n)
                        except Exception as e:  # noqa: BLE001
                            log.warning('Racing intensity recover failed: %s', e)
            st['patch'] = self.game.patch_status
            return st
        st['attached'] = True
        self._was_attached = True
        st['write'] = bool(self.game.write_enabled)
        st['patch'] = self.game.patch_status
        if not self.enabled:
            return st
        snap = self.game.snapshot()
        self._last_snap = snap
        self._sync_pit_crew(snap)
        try:
            self._sync_gearbox()
        except Exception as e:  # noqa: BLE001 - a failed patch must not stop the strategy
            log.warning('Gearbox: %s', e)
            self._gear_want = (self.game.pm.process_id, -1) if self.game.pm is not None else None
        flagged = self._black_flags(now)
        for lap, nums in self.wavelog.poll():
            log.info('WAVE AROUND (lap %d): %s', lap, ' '.join('#%s' % n for n in nums))
        for lap, n in self.wavelog.new_free_pass:
            log.info('FREE PASS (lap %d): #%s gets its lap back', lap, n)
        self.wavelog.new_free_pass.clear()
        team_of = self._team_of()
        lap_now = int(snap.laps_done)
        pending = self.game.rules_pending() if snap.session == mm.SESSION_RACE else set()
        if (self.settings.get('clear_black_flags', False) and snap.session == mm.SESSION_RACE
                and self.game.write_enabled):
            # no black flags for the AI: wipe the penalty before the car turns for pit road
            ai = {c.idx for c in snap.cars if c.valid and c.idx not in (mm.PLAYER_SLOT, mm.PACE_SLOT)}
            todo = (self.game.black_flags() | pending) & ai
            if todo:
                for idx in sorted(todo - self._flagged):
                    c = next((c for c in snap.cars if c.idx == idx), None)
                    log.info('Black flag cleared: #%s %s', c.number if c else idx, c.name if c else '')
                self.game.clear_penalties(todo)
                flagged -= todo
                pending -= todo
                self._mem_flags = set(self._mem_flags) - todo
        for c in snap.cars:
            c.team = team_of.get(c.number, -1)
            c.black_flag = c.idx in flagged
            c.rule_pending = c.idx in pending
            if c.valid:
                c.waved = self.wavelog.is_waved(c.number, lap_now)
                c.free_pass = self.wavelog.is_free_pass(c.number, lap_now)
                c.going_around = self.wavelog.is_going_around(c.number, lap_now)
        for idx in flagged - self._flagged:
            c = next((x for x in snap.cars if x.idx == idx), None)
            if c is not None and c.valid:
                log.info('BLACK FLAG: #%s %s', c.number, c.name)
        self._flagged = flagged
        if self.stage_ends is not None:
            snap.stage_ends = self.stage_ends
        snap.drafting = self._is_drafting()
        st['drafting'] = bool(snap.drafting)
        why = self._new_session_reason(snap)
        if why:
            self.clear_session(why)
        self._last_session = snap.session
        self._last_laps = snap.laps_done
        # AIMOD can send a car that already pitted under this caution back in "to top off" (3-40% chance, drafting tracks, once per car
        # per caution). To anyone watching that is an AI car pitting twice under yellow for no reason, so it is off unless asked for.
        self.engine.second_topoff = self._orig_topoff if self.settings.get('second_stops', False) else self._no_topoff
        sp = self._strategy_params(snap.tank_laps)
        self._last_sp = sp
        ss_held = self._hold_early_superspeedway_calls(snap, sp)
        lane = self._pit_lane_state or {}
        blocked = set()
        if lane.get('active'):
            due = set(lane.get('due') or [])
            ready = set(lane.get('ready') or [])
            for c in snap.cars:
                if (c.valid and not c.on_pit_road and not c.black_flag and c.idx in due and c.idx not in ready):
                    # Keep StrategyEngine from latching a pit decision before AI Enhanced has moved the car to maxrace.lp.
                    c.pitting = True
                    blocked.add(c.idx)
            for idx in blocked - self._pit_lane_waiting:
                c = next((x for x in snap.cars if x.idx == idx), None)
                if c is not None:
                    log.info('PIT LANE: #%s pit request held until it reaches maxrace.lp (inside)', c.number)
            for idx in self._pit_lane_waiting - blocked:
                if idx in ready:
                    c = next((x for x in snap.cars if x.idx == idx), None)
                    if c is not None:
                        log.info('PIT LANE: #%s staged on maxrace.lp; pit request released', c.number)
        else:
            ready = set()
        self._pit_lane_waiting = blocked
        crew = bool(self.settings.get('crew_beta', False))
        if crew:
            self.desk.apply(self.engine, snap)
        else:
            self.engine.human_owner, self.engine.human_calls = {}, {}
            self.engine.human_plans, self.engine.human_adjusts = {}, {}
        self.engine.condition_off = 'no_game_condition_stops' in self.game.applied_patches
        self.engine.gate_on = self._gate_armed
        res = self.engine.tick(snap, sp)
        if crew:
            self.desk.sync(self.engine, snap)
        # StrategyEngine can create a planned pit request during this tick, after the
        # pre-tick game-request guard above. Catch those writes too, or its own plan
        # bypasses the fuel threshold on the lap the request is first generated.
        if ((sp.track_type == SUPERSPEEDWAY or self._is_drafting()) and
                snap.flag == mm.FLAG_GREEN and snap.session == mm.SESSION_RACE):
            fuel_over_limit = {}
            for car in snap.cars:
                if not (car.valid and not car.on_pit_road and not car.controlled):
                    continue
                if car.black_flag or car.game_penalty or self.engine.condition_call(car):
                    continue
                state = self.engine.cars.get(car.idx)
                if state is not None and (state.forced_damage or self._short_pit_free(state, sp)):
                    continue
                fuel_fraction = self._fuel_fraction(car)
                if fuel_fraction is not None and fuel_fraction > 0.15:
                    fuel_over_limit[car.idx] = fuel_fraction
            planned_calls = {w.idx for w in res.writes
                             if w.offset == mm.OFF_PITTING and w.value and w.idx in fuel_over_limit}
            for idx in planned_calls:
                if idx not in ss_held:
                    car = next((c for c in snap.cars if c.idx == idx), None)
                    if car is not None:
                        log.info('Superspeedway AIMOD pit call held: #%s at %.1f%% fuel; waiting for 15%% or less',
                                 car.number, fuel_over_limit[idx] * 100)
                ss_held[idx] = fuel_over_limit[idx]
        held_ids = blocked | set(ss_held)
        if held_ids:
            # Clear a request left by an earlier tick while the car was still changing lanes.
            res.writes = [w for w in res.writes if not (w.idx in held_ids and w.offset == mm.OFF_PITTING and w.value)]
            res.writes.extend(Write(idx, mm.OFF_PITTING, 0) for idx in held_ids)
        self._gate_hold = held_ids
        try:
            self._gate_tick(snap, res)
        except Exception:  # noqa: BLE001 - the gate must never stop the strategy
            if now - self._gate_error > 60:
                self._gate_error = now
                log.exception('Pit gate failed (repeats are logged once a minute)')
        self._behavior_tick(snap, res, sp)
        self._radio_tick(snap, res, sp)
        self._last_res = res
        if crew and now - self._crew_at >= 1.0:
            self._crew_at = now
            try:
                self._crew_json = self.crew_view.build(snap, res, self.engine, self.radio, self.desk)
            except Exception as e:  # noqa: BLE001 - the phone page must never stop the strategy
                log.debug('crew view: %s', e)
        self.game.apply_writes(res.writes)
        for ev in res.events:
            self._apply_adjust_effect(ev)
            self.pitlog.start(ev, self.track)
            self.pit_events.append(ev)
            log.info('#%s %s pits lap %d: %s (%s)%s, P%s', ev.number, ev.name, ev.lap, ev.code, ev.reason,
                     (' [' + ev.note + ']') if getattr(ev, 'note', '') else '', ev.pos_in)
        for ev in res.exits:
            if not ev.pos_pending:
                self.pitlog.finish(ev)
        for ev in res.resolved:
            self.pitlog.finish(ev)
        for ev in res.cancels:
            self.pitlog.pending.pop(id(ev), None)
            if ev in self.pit_events:
                self.pit_events.remove(ev)
            log.info('#%s %s: pit request withdrawn before pit road', ev.number, ev.name)
        self.pitlog.retry()
        if self.settings.get('save_results', True):
            try:                                 # read-only: the race results file, written when the race is over
                self.results.update(
                    snap, track=self.track, mod=self.mod, total=max(snap.laps_total, self.engine.ot_total or 0),
                    ot_pending=self.engine.ot_pending, stage_ends=self.engine.stage_list,
                    cautions=self.engine.cautions, caution_laps=sum(self.engine.caution_lens),
                    stops=self.pit_events)
            except Exception:                    # the results must never stop the strategy tick
                if now - self._results_error > 60:
                    self._results_error = now
                    log.exception('Race results failed (repeats are logged once a minute)')
        self._last_rows = res.rows
        got = self.engine.pace.learned()
        self._learned = (got[0], got[1]) if got else None
        if now - self._model_saved > 300:
            self._model_saved = now
            self.tire_model.save()
        self._save_learned_tank()
        st.update({
            'flag': snap.flag, 'session': snap.session, 'lap': int(snap.laps_done), 'laps_total': snap.laps_total,
            'laps_to_go': res.laps_to_go, 'tank_laps': snap.tank_laps, 'model': self.tire_model.summary(),
            'learned': list(got) if got else None, 'stops_logged': len(self.pit_events),
            'gate': self.pitgate.status, 'gate_held': self._gate_held_total})
        return st

    def status(self):
        return self._status

    def rows(self):
        return self._last_rows

    def recent_events(self, n=40):
        return self.pit_events[-n:]

    def pit_board(self, hold=12.0):
        """AIMOD's pit board (aimod.pitboard.payload, as the standalone app builds it): the cars on pit road and the stops just
        done, cars that asked to pit, and under caution the lead lap cars that stayed out. All In One NR2003 draws it over the game."""
        snap, res = self._last_snap, self._last_res
        if snap is None or res is None or not self.enabled:
            return None
        rows = res.rows
        positions = {r.idx: r.pos for r in rows if r.pos}
        stayed = sorted((r for r in rows if r.kind == 'stayout' and not r.laps_down and r.pos), key=lambda r: r.pos)
        art = self._artdata(snap)
        return board_payload(self.engine.pit_board(float(hold)), self.engine.now, snap.flag == mm.FLAG_GREEN, int(snap.laps_done),
                             res.laps_total or snap.laps_total, positions, artdata=art, stayed_out=stayed, track=self.track,
                             race=snap.session == mm.SESSION_RACE, logo=art is not None)

    def _artdata(self, snap=None):
        """AIMOD's art set (numbers, headshots, car colours, series logo) for the pit board, as the standalone app uses it: the series
        is matched to the car numbers on track (App._update_pitboard), the mod name breaking ties."""
        if not self._art_roots:
            return None
        try:
            if self._art is None:
                self._art = ArtData(roots=list(self._art_roots), companion=None)
                self._art_hint = None
            snap = snap if snap is not None else self._last_snap
            if snap is not None:
                self._art.set_field(c.number for c in snap.cars if c.valid)
            if self.mod != self._art_hint:
                self._art_hint = self.mod
                self._art.set_hint(self.mod)
                self._art.refresh(force=True)
            else:
                self._art.refresh()
            return self._art
        except Exception as e:  # noqa: BLE001 - no art = the plain board
            log.debug('pit board art: %s', e)
            self._art_roots = []
            self._art = None
            return None

    def car_art(self, number):
        """the subtitle box's number card: the painted number (relative to an art root) and the car's colour"""
        a = self._artdata()
        if a is None:
            return {'img': None, 'color': None}
        try:
            return {'img': a.rel_number(int(number)), 'color': a.color(int(number))}
        except Exception:  # noqa: BLE001
            return {'img': None, 'color': None}

    def results_dir(self):
        return self.results.dir

    def art_path(self, rel):
        a = self._art
        return a.abs_path(rel) if a is not None and rel else None

    # ── crew chief on phones (AIMOD 2.2 beta: humancalls.Desk + crewview), the same calls as AIMOD's /crew/ web API ───────────
    def crew_json(self):
        return self._crew_json

    def crew_call(self, what, q):
        q = dict(q or {})
        d = self.desk
        if what == 'claim':
            return d.claim(q.get('car', ''), q.get('name', ''))
        if what == 'ping':
            return d.ping(q.get('token', ''))
        if what == 'release':
            return d.release(q.get('token', ''))
        if what == 'plan':
            return d.plan(q.get('token', ''), q.get('lap', ''), q.get('service', ''), q.get('fuel', ''), q.get('clear', ''))
        if what == 'adjust':
            return d.adjust(q.get('token', ''), q.get('wedge', 0), q.get('bar', 0), q.get('air', 0), q.get('tape', 0), q.get('clear', ''))
        if what == 'call':
            return d.call(q.get('token', ''), q.get('caution'), q.get('pit'), q.get('service', ''), q.get('fuel', ''))
        return {'ok': False, 'error': 'unknown'}

    def shutdown(self):
        """Window closing / All In One NR2003 quitting: leave the game as it was found."""
        self._behavior_restore()
        try:
            if self.game.pm is not None and self._crew_applied is not None and self._crew_applied[1]:
                self.pitcrew.apply(self.game.pm, False, False)
        except Exception as e:  # noqa: BLE001 - best effort, never block exit
            log.warning('pit crew restore failed: %s', e)
        self._restore_chassis()
        try:
            if self.game.pm is not None:
                if self.settings.get('restore_on_exit', True):
                    self.pitgate.remove(self.game.pm)
                else:
                    self.pitgate.disarm(self.game.pm)
        except Exception as e:  # noqa: BLE001 - best effort, never block exit
            log.warning('pit gate restore failed: %s', e)
        try:
            self.results.finish('AIMOD closed')
        except Exception:  # noqa: BLE001
            log.exception('Race results failed')
        self.engine.reset()
        self.tire_model.save()
        self.game.detach(restore_patches=bool(self.settings.get('restore_on_exit', True)))
        self.pitlog.flush()
        self.save_settings()

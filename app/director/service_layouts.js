// DirectorService additions for RaceVision 2.0: overlay layouts (the editor's calls, the panels each overlay update draws from layouts,
// Race Control's boards from its overlay feed). Mixed into DirectorService.prototype by service.js.
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const { LayoutStore } = require('./layouts');
const { CarStats, snapshot } = require('./layoutdata');
const { ArtLibrary } = require('./art');
const RV = require('./layoutdraw');

const ext = {
  _layoutsInit() {
    const opts = this.opts;
    const pd = opts.programData || process.env.PROGRAMDATA || 'C:\\ProgramData';
    this.carStats = new CarStats();
    this.layouts = new LayoutStore({
      dir: opts.layoutsDir || path.join(pd, 'NR2003 Companions', 'racevision', 'layouts'),
      stockDir: path.join(__dirname, 'layouts_stock'), fontPackDir: path.join(__dirname, 'fontpack'),
      extraFontDirs: opts.fontDirs ? opts.fontDirs() : [],
      settings: () => this.cfg().settings || {},
      setSettings: (p) => this.setConfig({ settings: p }),
      log: (m) => this.log(m),
      screen: () => ({ w: 1920, h: 1080 }),                    // All In One NR2003's overlay positions are on a 1920 x 1080 screen
      live: () => !!(this.field && this.dir && this.dir.cur && this.dir.cur.slot >= 0),
      artSeries: () => this._layoutArt(),
      render: opts.layoutRender ? (L, o) => opts.layoutRender(L, this._layoutRenderData(L, o)) : null,
    });
  },
  // the art series the overlays use: its folder, and the art roots (the folder above the series, for art:images/...)
  _layoutArt() {
    const f = this.field, R = this.resolved(), ticker = String(this.opts.getConfig().series || '');
    const strict = ticker !== '' && ticker.toLowerCase() !== 'default';
    const s = this.art.pick(f ? f.order.map(c => c.num) : [], strict ? ticker : R.art_series, strict);
    const roots = [...new Set([...(this.opts.artRoots ? this.opts.artRoots() : []), ...(this.opts.seriesDirs ? this.opts.seriesDirs() : []).map(d => path.dirname(d))])];
    return { id: s ? s.id : '', dir: s ? s.dir : '', series: s, roots };
  },
  async layoutApi(sub, q, body) { return this.layouts.api(sub, q || {}, body); },

  // the pictures a set of layouts names, as file URLs (layoutdraw's picUrl reads this map)
  _layoutPics(docs) {
    const out = {};
    for (const L of docs) for (const e of (L && L.elements) || []) for (const k of ['file', 'fillFile', 'trackFile']) if (e[k] && !(e[k] in out)) out[e[k]] = this.layouts.picUrl(e[k]);
    return out;
  },
  _layoutFonts() { return this.layouts.fontFiles().map(f => ({ family: f.family, file: f.file, url: f.url })); },

  // what the hidden window needs to draw one layout for the editor: the sample (or live) data, its pictures and the fonts
  _layoutRenderData(L, o) {
    const art = this._layoutArt();
    let snap;
    if (o && o.live && this.lastLayoutSnap) snap = this.lastLayoutSnap;
    else {
      snap = { cars: {}, order: [], art: {}, colors: {}, dash: { accent: this.resolved().dash_accent, accent2: this.resolved().dash_accent2, artColors: !!Number(this.resolved().dash_art_colors) } };
      for (const s of RV.SMP) { const a = ArtLibrary.art(art.series, s[0]); snap.art[s[0]] = { number: a.number, head: a.head }; }
    }
    return { snap, pics: this._layoutPics([L]), fonts: this._layoutFonts(), sample: !(o && o.live), scale: (o && o.scale) || 1 };
  },

  // every overlay update: the panels drawn from layouts (on o.lay), and All In One NR2003's own look hidden where a layout replaces it
  _layoutOverlay(o, f, R, t, rp) {
    try { if (f) this.carStats.update(f, f.t || t); } catch (e) { /* stats are a nice-to-have */ }
    if (String(R.overlay_style || '').startsWith('preset:')) o.style = this.layouts.dashLook() ? 'dash' : 'classic';   // a preset builds on one of the two looks
    const keys = ['tag', 'battle', 'onboard', 'dash', 'custom1', 'custom2', 'custom3', 'custom4', 'rc_qual', 'rc_tele', 'rc_cone', 'rc_order'];
    if (!keys.some(k => this.layouts.layoutFor(k))) { o.lay = null; this.lastLayoutSnap = null; return; }
    const art = this._layoutArt();
    const ds = this.dir.state();
    const replay = !!(rp && rp.phase === 'playing');
    const cur = replay && rp.slot >= 0 ? { kind: 'replay', slot: rp.slot } : ds.cur;
    let lapsTotal = 0, session = '';
    try { const ri = this.opts.raceInfo ? this.opts.raceInfo() : null; if (ri) { lapsTotal = ri.lapsTotal || 0; session = ri.session || ''; } } catch (e) { /* none */ }
    let rc = null;
    try { rc = this.opts.rcFeed ? this.opts.rcFeed() : null; } catch (e) { rc = null; }
    const snap = snapshot(f, o, { cur }, R, {
      stats: this.carStats, rc, replay, lapsTotal, session,
      art: (num) => ArtLibrary.art(art.series, num),
    });
    this.lastLayoutSnap = snap;
    const onboard = R.onboard_cams.has(this.cam.current());
    const battleShot = !!(cur && (cur.kind === 'battle' || cur.kind === 'pass') && cur.other !== undefined);
    const panels = this.layouts.panels(o.on ? o : null, snap, { onboard, battleShot, replay, overlaysOn: !!R.overlays });
    if (!panels.length) { o.lay = null; return; }
    o.lay = { panels, snap, pics: this._layoutPics(panels.map(p => p.layout)), fonts: this._layoutFonts() };
    if (panels.some(p => p.on)) o.on = true;
  },
};

module.exports = { install(Cls) { Object.assign(Cls.prototype, ext); }, ext };

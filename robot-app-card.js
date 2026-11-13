/*!
 * Robot App Card v1.1.2
 * Saugroboter-Karte im Stil der Dreame- und Roborock-App für Home Assistant
 * - erkennt alle Entitäten des Roboters automatisch (über das Gerät)
 * - Karte mit Raumauswahl (Reihenfolge wie in der App), Zonen ziehen, ganzes Haus
 * - Saugstufe, Wassermenge, Modus, Route, Durchgänge, Wartung, Station
 * Unterstützt: Tasshack/dreame-vacuum, Roborock (Core) + Roborock Custom Map
 */
const RAC_VERSION = "1.1.2";

const RAC_THEMES = {
  dreame: {
    light: { bg: "#f2f3f5", surface: "#ffffff", text: "#15171c", sub: "#80868f", line: "#e7e9ed",
      chip: "#f2f4f7", accent: "#2b6cff", accentSoft: "rgba(43,108,255,.12)", primary: "#15171c",
      primaryText: "#ffffff", mapBg: "#eceef2", ok: "#1fb46a", warn: "#f29d38", err: "#e5484d" },
    dark: { bg: "#0f1115", surface: "#1a1d23", text: "#f3f4f6", sub: "#9097a3", line: "#2a2e36",
      chip: "#242830", accent: "#4f86ff", accentSoft: "rgba(79,134,255,.18)", primary: "#f3f4f6",
      primaryText: "#111317", mapBg: "#15181d", ok: "#2ecc7a", warn: "#f5a524", err: "#ff5c61" },
  },
  roborock: {
    light: { bg: "#eef1f5", surface: "#ffffff", text: "#121417", sub: "#7d8590", line: "#e4e7ec",
      chip: "#f0f2f5", accent: "#ff6a1a", accentSoft: "rgba(255,106,26,.13)", primary: "#ff6a1a",
      primaryText: "#ffffff", mapBg: "#e6eaf0", ok: "#22b573", warn: "#f29d38", err: "#e5484d" },
    dark: { bg: "#0d0f12", surface: "#181b20", text: "#f2f3f5", sub: "#8f96a1", line: "#262a31",
      chip: "#22262c", accent: "#ff7a30", accentSoft: "rgba(255,122,48,.18)", primary: "#ff7a30",
      primaryText: "#ffffff", mapBg: "#121519", ok: "#2ecc7a", warn: "#f5a524", err: "#ff5c61" },
  },
};

const RAC_MODE_ICONS = {
  sweeping: "mdi:robot-vacuum", vacuum: "mdi:robot-vacuum", mopping: "mdi:water",
  mop: "mdi:water", sweeping_and_mopping: "mdi:robot-vacuum-variant", vac_and_mop: "mdi:robot-vacuum-variant",
  mopping_after_sweeping: "mdi:swap-horizontal", vac_then_mop: "mdi:swap-horizontal",
};

const racEsc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- Kalibrierung: Roboter-Koordinaten <-> Kartenpixel ---------- */
function racAffine(points) {
  if (!Array.isArray(points) || points.length < 3) return null;
  const p = points.slice(0, 3).map((c) => ({ vx: +c.vacuum.x, vy: +c.vacuum.y, mx: +c.map.x, my: +c.map.y }));
  const [a, b, c] = p;
  const det = a.vx * (b.vy - c.vy) - a.vy * (b.vx - c.vx) + (b.vx * c.vy - c.vx * b.vy);
  if (!det) return null;
  const solve = (t1, t2, t3) => [
    (t1 * (b.vy - c.vy) - a.vy * (t2 - t3) + (t2 * c.vy - t3 * b.vy)) / det,
    (a.vx * (t2 - t3) - t1 * (b.vx - c.vx) + (b.vx * t3 - c.vx * t2)) / det,
    (a.vx * (b.vy * t3 - c.vy * t2) - a.vy * (b.vx * t3 - c.vx * t2) + t1 * (b.vx * c.vy - c.vx * b.vy)) / det,
  ];
  const X = solve(a.mx, b.mx, c.mx), Y = solve(a.my, b.my, c.my);
  const idet = X[0] * Y[1] - X[1] * Y[0];
  return {
    toMap: (x, y) => [X[0] * x + X[1] * y + X[2], Y[0] * x + Y[1] * y + Y[2]],
    toVac: (mx, my) => {
      const dx = mx - X[2], dy = my - Y[2];
      return [(Y[1] * dx - X[1] * dy) / idet, (-Y[0] * dx + X[0] * dy) / idet];
    },
  };
}

/* ---------- Räume aus Attributen lesen (Tasshack / Roborock Custom Map / Map Extractor) ---------- */
function racRooms(raw, mapName) {
  if (!raw || typeof raw !== "object") return [];
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else {
    const entries = Object.entries(raw);
    const looksRoom = (v) => v && typeof v === "object" && !Array.isArray(v) &&
      ("x0" in v || "name" in v || "x" in v || "id" in v || "outline" in v);
    if (entries.length && entries.every(([, v]) => Array.isArray(v))) {
      // { "Kartenname": [ {id, name, ...} ] }
      const hit = entries.find(([k]) => k === mapName) || entries[0];
      list = hit[1];
    } else if (entries.length && entries.every(([, v]) => v && typeof v === "object" && !looksRoom(v))) {
      // { "Kartenname": { id: {...} } }
      const hit = entries.find(([k]) => k === mapName) || entries[0];
      list = Object.entries(hit[1]).map(([k, v]) => ({ id: k, ...v }));
    } else {
      list = entries.map(([k, v]) => (typeof v === "object" ? { id: v.id ?? k, ...v } : { id: k, name: String(v) }));
    }
  }
  return list
    .filter((r) => r && r.id !== undefined && r.id !== null)
    .map((r) => {
      let cx = null, cy = null;
      if (Number.isFinite(+r.x) && Number.isFinite(+r.y) && r.x !== null && r.y !== null) { cx = +r.x; cy = +r.y; }
      else if ([r.x0, r.y0, r.x1, r.y1].every((n) => Number.isFinite(+n) && n !== null)) { cx = (+r.x0 + +r.x1) / 2; cy = (+r.y0 + +r.y1) / 2; }
      const id = /^\d+$/.test(String(r.id)) ? Number(r.id) : r.id;
      return { id, name: r.name || r.room_name || null, icon: r.icon || null, cx, cy };
    });
}

class RobotAppCard extends HTMLElement {
  static async getConfigElement() {
    await racLoadHaForm();
    return document.createElement("robot-app-card-editor");
  }

  static getStubConfig(hass) {
    const v = Object.keys(hass?.states || {}).find((e) => e.startsWith("vacuum."));
    return { entity: v || "vacuum.robot", style: "dreame" };
  }

  setConfig(config) {
    if (!config || !config.entity || !String(config.entity).startsWith("vacuum.")) {
      throw new Error("Bitte 'entity: vacuum.xyz' angeben");
    }
    this._config = { style: "auto", dark: "auto", ...config };
    this._ui = { mode: "all", selected: [], zones: [], repeats: 1, sheet: null };
    this._sig = null;
    this._disc = null;
    if (this._root) this._update(true);
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._root) this._build();
    this._discover();
    this._update();
  }

  getCardSize() { return 12; }
  getGridOptions() { return { columns: 12, min_columns: 6, rows: "auto" }; }

  /* ------------------------------------------------------------------ */
  /* Entitäten des Geräts automatisch finden                            */
  /* ------------------------------------------------------------------ */
  _discover() {
    const h = this._hass, cfg = this._config;
    const key = h.entities;
    if (this._disc && this._disc._key === key && this._disc._cfg === cfg) return;
    const reg = h.entities || {};
    const vac = cfg.entity;
    const vreg = reg[vac] || {};
    const devId = vreg.device_id;
    const platform = cfg.platform || vreg.platform || "";
    const dev = devId && h.devices ? h.devices[devId] : null;
    const devName = dev ? (dev.name_by_user || dev.name || "") : "";
    const objId = vac.split(".")[1];

    const own = Object.keys(h.states).filter((id) =>
      id !== vac && (devId ? reg[id]?.device_id === devId : id.split(".")[1].startsWith(objId)));
    // Entitäts-IDs sind je nach HA-Sprache übersetzt (z. B. select.roby_wischintensitat).
    // Der translation_key ist sprachunabhängig -> daraus eine "englische" Ersatz-ID bauen und beide prüfen.
    const alias = {};
    own.forEach((id) => {
      const tk = reg[id]?.translation_key;
      alias[id] = tk ? [id, `${id.split(".")[0]}.${objId}_${tk}`] : [id];
    });
    const al = (id) => alias[id] || [id];
    const hit = (id, re, not) => al(id).some((x) => re.test(x)) && !(not && al(id).some((x) => not.test(x)));
    const dom = (d) => own.filter((id) => id.startsWith(d + "."));
    const find = (d, re, not) => dom(d).find((id) => hit(id, re, not)) || null;

    // Karte
    let map = cfg.map_entity || null;
    if (!map) {
      const cands = [...dom("camera"), ...dom("image")];
      // Roborock Custom Map hängt evtl. an keinem Gerät -> per Name suchen
      Object.keys(h.states).forEach((id) => {
        if (id.startsWith("image.") && id.includes(objId) && id.endsWith("_custom") && !cands.includes(id)) cands.push(id);
      });
      const score = (id) => {
        const a = h.states[id]?.attributes || {};
        let s = 0;
        if (a.calibration_points) s += 10;
        if (a.rooms) s += 5;
        if (id.endsWith("_custom")) s += 3;
        if (/saved|gespeichert|_map_\d+$|_\d+$/.test(id)) s -= 4;
        if (/map_data|_data$/.test(id)) s -= 8;
        return s - id.length / 1000;
      };
      map = cands.sort((a, b) => score(b) - score(a))[0] || null;
    }

    const consumableRe = /(main_brush|side_brush|filter|sensor_dirty|sensor_time|dirty_sensor|mop_pad|mop_left|mop_time|strainer|dust_bag|detergent|silver_ion|squeegee|cleaning_brush|scale_inhibitor)/;
    const consumables = dom("sensor").filter((id) => hit(id, consumableRe, /total|reset|history/));
    const resetBtns = dom("button").filter((id) => hit(id, /reset|zurucksetzen/));
    const dockBtns = dom("button").filter((id) => !hit(id, /reset|zurucksetzen|restart|reboot|neustart|identify|update/));
    // Verbrauchsteil -> passender Reset-Button
    const kind = (id) => {
      for (const x of al(id)) {
        const m = x.match(consumableRe);
        if (m) return m[1].replace(/^(sensor_dirty|dirty_sensor|sensor_time)$/, "sensor").replace(/^(mop_left|mop_time)$/, "mop");
      }
      return null;
    };
    const resetFor = {};
    consumables.forEach((id) => {
      const k = kind(id);
      let b = k && resetBtns.find((r) => al(r).some((x) => x.includes(k)));
      if (!b) {
        const key = id.split(".")[1].replace(/_(left|time_left|remaining)$/, "").split("_").slice(-2).join("_");
        b = resetBtns.find((r) => r.includes(key));
      }
      if (b) resetFor[id] = b;
    });

    this._disc = {
      _key: key, _cfg: cfg, platform, devName, map,
      battery: cfg.battery_entity || dom("sensor").find((id) => h.states[id]?.attributes?.device_class === "battery") || find("sensor", /battery/),
      status: cfg.status_entity || find("sensor", /_status$/) || find("sensor", /_state$/, /charging_state|dock/),
      area: find("sensor", /(cleaned_area|cleaning_area|clean_area|reinigungsflache)$/, /total|gesamt/),
      time: find("sensor", /(cleaning_time|clean_time|cleaning_duration|reinigungszeit|reinigungsdauer)$/, /total|gesamt/),
      suction: find("select", /(suction_level|suction|fan_speed|fan_power|saugleistung|saugstarke)/),
      water: find("select", /(water_volume|mop_intensity|mop_pad_humidity|water_level|water_flow|scrub_intensity|mop_humidity|wischintensitat|wassermenge)/),
      cmode: find("select", /(cleaning_mode|clean_mode|reinigungsmodus)$/),
      route: find("select", /(mop_mode|mop_route|cleaning_route|route|wischmodus|wischroute)$/),
      mapSel: find("select", /(selected_map|current_map|map_select|ausgewahlte_karte|aktuelle_karte)/),
      consumables, resetBtns, dockBtns, resetFor,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Grundgerüst (Karte bleibt bestehen, damit nichts flackert)         */
  /* ------------------------------------------------------------------ */
  _build() {
    this._root = this.attachShadow({ mode: "open" });
    this._root.innerHTML = `
      <style>${this._css()}</style>
      <ha-card class="rac" lang="de">
        <div class="top"></div>
        <div class="mapwrap">
          <div class="mapbox">
            <img class="mapimg" alt="" draggable="false"/>
            <svg class="ov" xmlns="http://www.w3.org/2000/svg"></svg>
            <div class="nomap">Keine Karte gefunden</div>
          </div>
          <div class="mapover"></div>
        </div>
        <div class="controls"></div>
        <div class="sheetlayer"></div>
        <div class="toast"></div>
      </ha-card>`;
    this.$ = (s) => this._root.querySelector(s);
    this._img = this.$(".mapimg");
    this._svg = this.$(".ov");
    this._img.addEventListener("load", () => {
      this._iw = this._img.naturalWidth; this._ih = this._img.naturalHeight;
      this._sig = null; this._update(true);
    });
    this._root.addEventListener("click", (e) => this._onClick(e));
    if (window.ResizeObserver) {
      let lw = 0;
      new ResizeObserver(() => { const w = this._svg.clientWidth; if (w && Math.abs(w - lw) > 4) { lw = w; this._update(true); } }).observe(this.$(".mapbox"));
    }
    this._svg.addEventListener("pointerdown", (e) => this._zoneStart(e));
    this._svg.addEventListener("pointermove", (e) => this._zoneMove(e));
    this._svg.addEventListener("pointerup", (e) => this._zoneEnd(e));
    this._svg.addEventListener("pointercancel", () => { this._drag = null; this._update(true); });
  }

  /* ------------------------------------------------------------------ */
  /* Hilfen                                                              */
  /* ------------------------------------------------------------------ */
  _st(id) { return id ? this._hass.states[id] : undefined; }
  _fmt(id) {
    const s = this._st(id); if (!s) return "–";
    try { return this._hass.formatEntityState ? this._hass.formatEntityState(s) : s.state; } catch (_) { return s.state; }
  }
  _fmtOpt(id, opt) {
    const s = this._st(id);
    try { return this._hass.formatEntityState ? this._hass.formatEntityState(s, opt) : opt; } catch (_) { return opt; }
  }
  _fmtFan(v) {
    const s = this._st(this._config.entity);
    try { return this._hass.formatEntityAttributeValue ? this._hass.formatEntityAttributeValue(s, "fan_speed", v) : v; } catch (_) { return v; }
  }
  _num(id) { const v = parseFloat(this._st(id)?.state); return Number.isFinite(v) ? v : null; }
  /* Zahl mit der Anzeige-Genauigkeit aus HA (sonst maxDigits Nachkommastellen) formatieren */
  _numFmt(id, maxDigits) {
    const v = this._num(id);
    if (v === null) return "–";
    const p = this._hass.entities?.[id]?.display_precision;
    const lang = this._hass.locale?.language || this._hass.language || "de";
    const o = Number.isInteger(p) ? { minimumFractionDigits: p, maximumFractionDigits: p } : { maximumFractionDigits: maxDigits };
    try { return v.toLocaleString(lang, o); } catch (_) { return String(+v.toFixed(o.maximumFractionDigits)); }
  }
  _short(id) {
    const s = this._st(id); if (!s) return id;
    let n = s.attributes.friendly_name || id;
    const d = this._disc.devName;
    if (d && n.startsWith(d)) n = n.slice(d.length).trim();
    return n.replace(/^[-–:·\s]+/, "") || n;
  }
  _isDark() {
    const d = this._config.dark;
    if (d === true || d === "true") return true;
    if (d === false || d === "false") return false;
    return !!this._hass?.themes?.darkMode;
  }
  _style() {
    const s = this._config.style;
    if (s === "dreame" || s === "roborock") return s;
    return /roborock|xiaomi_miio/.test(this._disc?.platform || "") ? "roborock" : "dreame";
  }
  _vacState() { return this._st(this._config.entity)?.state || "unavailable"; }
  _active() { return ["cleaning", "returning"].includes(this._vacState()); }
  _mapName() { return this._st(this._disc.mapSel)?.state; }

  _rooms() {
    const mapAttr = this._st(this._disc.map)?.attributes || {};
    const vacAttr = this._st(this._config.entity)?.attributes || {};
    let rooms = racRooms(mapAttr.rooms, this._mapName());
    if (!rooms.length) rooms = racRooms(vacAttr.rooms, this._mapName());
    const names = this._config.room_names || {};
    const hide = (this._config.hide_rooms || []).map(String);
    return rooms
      .filter((r) => !hide.includes(String(r.id)))
      .map((r) => ({ ...r, name: names[r.id] || names[String(r.id)] || r.name || `Raum ${r.id}` }));
  }

  _cal() {
    const a = this._st(this._disc.map)?.attributes;
    const key = JSON.stringify(a?.calibration_points || null);
    if (this._calKey !== key) { this._calKey = key; this._calObj = racAffine(a?.calibration_points); }
    return this._calObj;
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */
  _update(force) {
    if (!this._hass || !this._root || !this._disc) return;
    const d = this._disc;
    const ids = [this._config.entity, d.map, d.battery, d.status, d.area, d.time, d.suction, d.water, d.cmode,
      d.route, d.mapSel, ...d.consumables, ...d.dockBtns];
    const sig = JSON.stringify([ids.map((i) => { const s = this._st(i); return s ? [s.state, s.last_updated] : 0; }),
      this._ui, this._isDark(), this._iw, this._ih]);
    if (!force && sig === this._sig) return;
    this._sig = sig;
    if (this._drag) return;

    const style = this._style();
    const theme = { ...RAC_THEMES[style][this._isDark() ? "dark" : "light"] };
    if (this._config.accent) { theme.accent = this._config.accent; if (style === "roborock") theme.primary = this._config.accent; }
    const card = this.$(".rac");
    card.className = `rac ${style}`;
    Object.entries(theme).forEach(([k, v]) => card.style.setProperty(`--${k}`, v));

    this._renderMap();
    this.$(".top").innerHTML = style === "dreame" ? this._headerDreame() : "";
    this.$(".mapover").innerHTML = style === "roborock" ? this._headerRoborock() : this._mapChips();
    this.$(".controls").innerHTML = style === "dreame" ? this._controlsDreame() : this._controlsRoborock();
    this.$(".sheetlayer").innerHTML = this._sheet();
  }

  _statusInfo() {
    const st = this._vacState();
    const txt = this._disc.status ? this._fmt(this._disc.status) : this._fmt(this._config.entity);
    let cls = "idle";
    if (["cleaning", "returning"].includes(st)) cls = "run";
    else if (st === "error") cls = "err";
    else if (st === "docked") cls = "ok";
    else if (st === "paused") cls = "warn";
    return { txt, cls };
  }

  _battery() {
    const b = this._num(this._disc.battery) ?? this._st(this._config.entity)?.attributes?.battery_level ?? null;
    if (b === null) return "";
    const lvl = Math.max(0, Math.min(100, Math.round(b / 10) * 10));
    const charging = ["docked"].includes(this._vacState()) && b < 100;
    const icon = charging ? `mdi:battery-charging${lvl ? "-" + lvl : "-outline"}` : (lvl === 100 ? "mdi:battery" : lvl === 0 ? "mdi:battery-outline" : `mdi:battery-${lvl}`);
    return `<span class="batt"><ha-icon icon="${icon}"></ha-icon>${Math.round(b)} %</span>`;
  }

  _stats() {
    const d = this._disc, out = [];
    if (d.area) out.push([this._numFmt(d.area, 1), this._st(d.area)?.attributes?.unit_of_measurement || "m²", "Fläche"]);
    if (d.time) out.push([this._numFmt(d.time, 0), this._st(d.time)?.attributes?.unit_of_measurement || "min", "Dauer"]);
    const b = this._num(d.battery);
    if (b !== null) out.push([Math.round(b), "%", "Akku"]);
    return out.map(([v, u, l]) => `<div class="stat"><div class="sv">${racEsc(v)}<small>${racEsc(u)}</small></div><div class="sl">${l}</div></div>`).join("");
  }

  _name() { return this._config.name || this._disc.devName || this._st(this._config.entity)?.attributes?.friendly_name || "Roboter"; }

  _headerDreame() {
    const s = this._statusInfo();
    return `
      <div class="hdr">
        <div class="hl">
          <div class="nm">${racEsc(this._name())}</div>
          <div class="stt"><span class="dot ${s.cls}"></span>${racEsc(s.txt)}</div>
        </div>
        ${this._battery()}
      </div>
      <div class="stats">${this._stats()}</div>`;
  }

  _headerRoborock() {
    const s = this._statusInfo();
    return `
      <div class="rr-hdr">
        <div class="glass">
          <div class="nm">${racEsc(this._name())}</div>
          <div class="stt"><span class="dot ${s.cls}"></span>${racEsc(s.txt)}</div>
        </div>
        <div class="glass b">${this._battery()}</div>
      </div>
      ${this._mapChips()}
      <div class="rr-stats glass">${this._stats()}</div>`;
  }

  _mapChips() {
    const d = this._disc, sel = this._st(d.mapSel);
    if (!sel || !(sel.attributes.options || []).length || sel.attributes.options.length < 2) return "";
    return `<button class="mapsel" data-action="sheet" data-sheet="maps"><ha-icon icon="mdi:layers-outline"></ha-icon>${racEsc(this._fmt(d.mapSel))}</button>`;
  }

  _renderMap() {
    const d = this._disc, st = this._st(d.map);
    const box = this.$(".mapbox");
    const pic = st?.attributes?.entity_picture;
    if (!pic) {
      box.classList.add("empty"); this._img.removeAttribute("src"); this._svg.innerHTML = ""; return;
    }
    box.classList.remove("empty");
    const url = this._hass.hassUrl(`${pic}${pic.includes("?") ? "&" : "?"}_=${encodeURIComponent(st.last_updated || st.state)}`);
    if (this._img.getAttribute("src") !== url) this._img.setAttribute("src", url);
    if (this._iw && this._ih) {
      box.style.aspectRatio = `${this._iw} / ${this._ih}`;
      this._svg.setAttribute("viewBox", `0 0 ${this._iw} ${this._ih}`);
      this._svg.innerHTML = this._overlay();
    }
    this._svg.classList.toggle("zone", this._ui.mode === "zone");
  }

  _overlay() {
    const W = this._iw, cal = this._cal();
    const u = W / 100; // 1 % der Kartenbreite
    const px = W / (this._svg.clientWidth || W); // Kartenpixel pro Bildschirmpixel
    const fs = 12.5 * px;
    let out = "";
    if (cal && this._ui.mode !== "zone") {
      const h = fs * 1.9, gap = fs * 0.3, H = this._ih;
      const labels = this._rooms().filter((r) => r.cx !== null).map((r) => {
        const [x, y] = cal.toMap(r.cx, r.cy);
        const idx = this._ui.selected.indexOf(r.id);
        const w = Math.max(this._textW(r.name, fs) + fs * (idx >= 0 ? 2.6 : 1.4), fs * 3);
        return { r, x, y, w, idx };
      });
      // Beschriftungen, die sich überdecken, vertikal auseinanderschieben
      for (let pass = 0; pass < 6; pass++) {
        let moved = false;
        labels.forEach((a, i) => labels.slice(0, i).forEach((b) => {
          if (Math.abs(a.x - b.x) >= (a.w + b.w) / 2 + gap || Math.abs(a.y - b.y) >= h + gap) return;
          const dir = a.y >= b.y ? 1 : -1, need = (h + gap - Math.abs(a.y - b.y)) / 2;
          a.y += dir * need; b.y -= dir * need; moved = true;
        }));
        labels.forEach((l) => {
          l.x = Math.min(Math.max(l.x, l.w / 2), W - l.w / 2);
          l.y = Math.min(Math.max(l.y, h / 2), H - h / 2);
        });
        if (!moved) break;
      }
      labels.forEach(({ r, x, y, w, idx }) => {
        const on = idx >= 0;
        const label = r.name;
        const roomMode = this._ui.mode === "rooms";
        out += `<g class="room ${on ? "on" : ""} ${roomMode ? "click" : "ghost"}" ${roomMode ? `data-action="room" data-id="${racEsc(r.id)}"` : ""} transform="translate(${x},${y})">
          <rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="${h / 2}"/>
          ${on ? `<circle cx="${-w / 2 + h / 2}" cy="0" r="${h / 2 - fs * 0.22}" class="num"/><text x="${-w / 2 + h / 2}" y="${fs * 0.36}" class="numt" font-size="${fs * 0.9}">${idx + 1}</text>` : ""}
          <text x="${on ? fs * 0.6 : 0}" y="${fs * 0.36}" font-size="${fs}">${racEsc(label)}</text>
        </g>`;
      });
    }
    if (this._ui.mode === "zone") {
      this._ui.zones.forEach((z, i) => {
        const x = Math.min(z[0], z[2]), y = Math.min(z[1], z[3]), w = Math.abs(z[2] - z[0]), h = Math.abs(z[3] - z[1]);
        const r = fs * 0.85;
        out += `<g class="zonebox"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${u * 0.6}"/>
          <g class="zdel" data-action="zdel" data-i="${i}" transform="translate(${x + w},${y})"><circle r="${r}"/>
          <path d="M${-r * 0.4},${-r * 0.4}L${r * 0.4},${r * 0.4}M${r * 0.4},${-r * 0.4}L${-r * 0.4},${r * 0.4}"/></g></g>`;
      });
      out += `<rect class="ztemp" x="0" y="0" width="0" height="0"/>`;
    }
    return out;
  }

  _textW(t, fs) {
    if (!this._canvas) {
      this._canvas = document.createElement("canvas").getContext("2d");
      this._font = getComputedStyle(this.$(".rac")).fontFamily || "sans-serif";
    }
    this._canvas.font = `600 ${fs}px ${this._font}`;
    return this._canvas.measureText(String(t)).width * 1.04;
  }

  /* ---------- Dreame-Layout ---------- */
  _segmented() {
    const m = this._ui.mode;
    const it = [["all", "Ganzes Haus", "mdi:home-outline"], ["rooms", "Räume", "mdi:floor-plan"], ["zone", "Zone", "mdi:selection-drag"]];
    return `<div class="seg">${it.map(([k, l, i]) => `<button class="${m === k ? "on" : ""}" data-action="mode" data-mode="${k}"><ha-icon icon="${i}"></ha-icon><span>${l}</span></button>`).join("")}</div>`;
  }

  _hint() {
    const m = this._ui.mode;
    if (m === "rooms") {
      const n = this._ui.selected.length;
      const rooms = this._rooms();
      if (!rooms.length) return `<div class="hint">Keine Räume in den Kartendaten gefunden.</div>`;
      const noPos = !this._cal() || rooms.some((r) => r.cx === null);
      const list = noPos ? `<div class="roomlist">${rooms.map((r) => {
        const i = this._ui.selected.indexOf(r.id);
        return `<button class="${i >= 0 ? "on" : ""}" data-action="room" data-id="${racEsc(r.id)}">${i >= 0 ? `<b>${i + 1}</b>` : r.icon ? `<ha-icon icon="${racEsc(r.icon)}"></ha-icon>` : ""}${racEsc(r.name)}</button>`;
      }).join("")}</div>` : "";
      return `${list}<div class="hint">${n ? `${n} ${n === 1 ? "Raum" : "Räume"} gewählt · Reihenfolge = Antippreihenfolge` : "Räume auf der Karte antippen"}${n ? ` <a data-action="clearsel">Auswahl löschen</a>` : ""}</div>`;
    }
    if (m === "zone") {
      const n = this._ui.zones.length;
      if (!this._cal()) return `<div class="hint">Karte hat keine Kalibrierdaten – Zonen nicht möglich.</div>`;
      return `<div class="hint">${n ? `${n} ${n === 1 ? "Zone" : "Zonen"} · max. 5` : "Rechteck auf der Karte aufziehen"}</div>`;
    }
    return "";
  }

  _modeTiles() {
    const id = this._disc.cmode, s = this._st(id);
    if (!this._ok(id)) return "";
    const opts = s.attributes.options || [];
    return `<div class="modes">${opts.map((o) => `<button class="${s.state === o ? "on" : ""}" data-action="select" data-entity="${id}" data-option="${racEsc(o)}">
      <ha-icon icon="${RAC_MODE_ICONS[o] || "mdi:robot-vacuum"}"></ha-icon><span>${racEsc(this._fmtOpt(id, o))}</span></button>`).join("")}</div>`;
  }

  _ok(id) { const s = this._st(id); return !!s && !["unavailable", "unknown"].includes(s.state); }
  _waterLabel() { return this._style() === "roborock" ? "Wischintensität" : "Wassermenge"; }

  _settingItems() {
    const d = this._disc, out = [];
    const vac = this._st(this._config.entity);
    if (this._ok(d.suction)) out.push(["mdi:fan", "Saugleistung", this._fmt(d.suction)]);
    else if (vac?.attributes?.fan_speed_list) out.push(["mdi:fan", "Saugleistung", this._fmtFan(vac.attributes.fan_speed)]);
    if (this._ok(d.water)) out.push(["mdi:water-outline", this._waterLabel(), this._fmt(d.water)]);
    if (this._ok(d.route)) out.push(["mdi:vector-polyline", "Route", this._fmt(d.route)]);
    out.push(["mdi:repeat", "Durchgänge", `${this._ui.repeats}×`]);
    return out;
  }

  _primaryLabel() {
    const st = this._vacState();
    if (st === "cleaning") return ["mdi:pause", "Pausieren"];
    if (st === "returning") return ["mdi:pause", "Rückkehr stoppen"];
    if (st === "paused") return ["mdi:play", "Fortsetzen"];
    const m = this._ui.mode;
    if (m === "rooms") { const n = this._ui.selected.length; return ["mdi:play", n ? `${n} ${n === 1 ? "Raum" : "Räume"} reinigen` : "Räume wählen"]; }
    if (m === "zone") { const n = this._ui.zones.length; return ["mdi:play", n ? `${n > 1 ? n + " Zonen" : "Zone"} reinigen` : "Zone aufziehen"]; }
    return ["mdi:play", "Reinigen"];
  }

  _primaryDisabled() {
    if (["cleaning", "returning", "paused"].includes(this._vacState())) return false;
    if (this._vacState() === "unavailable") return true;
    if (this._ui.mode === "rooms") return !this._ui.selected.length;
    if (this._ui.mode === "zone") return !this._ui.zones.length;
    return false;
  }

  _controlsDreame() {
    const [pi, pl] = this._primaryLabel();
    const set = this._settingItems();
    return `
      ${this._segmented()}
      ${this._hint()}
      ${this._modeTiles()}
      <button class="setrow" data-action="sheet" data-sheet="settings">
        ${set.map(([i, l, v]) => `<div class="si"><ha-icon icon="${i}"></ha-icon><div><div class="sil">${l}</div><div class="siv">${racEsc(v)}</div></div></div>`).join("")}
        <ha-icon class="chev" icon="mdi:chevron-right"></ha-icon>
      </button>
      <div class="actions">
        <button class="round" data-action="dock" title="Zur Station"><span class="ri"><ha-icon icon="mdi:home-import-outline"></ha-icon></span><span>Station</span></button>
        <button class="primary" data-action="primary" ${this._primaryDisabled() ? "disabled" : ""}><ha-icon icon="${pi}"></ha-icon>${racEsc(pl)}</button>
        <button class="round" data-action="sheet" data-sheet="more" title="Mehr"><span class="ri"><ha-icon icon="mdi:dots-horizontal"></ha-icon></span><span>Mehr</span></button>
      </div>
      ${this._active() || this._vacState() === "paused" ? `<button class="stopline" data-action="stop"><ha-icon icon="mdi:stop"></ha-icon>Reinigung beenden</button>` : ""}`;
  }

  /* ---------- Roborock-Layout ---------- */
  _controlsRoborock() {
    const [pi, pl] = this._primaryLabel();
    const set = this._settingItems();
    const modeTiles = this._modeTiles();
    return `
      ${this._segmented()}
      ${this._hint()}
      ${modeTiles ? `<div class="sect">Reinigungsmodus</div>${modeTiles}` : ""}
      <div class="cards" style="grid-template-columns:repeat(${set.length === 4 ? 2 : Math.min(set.length, 3)},minmax(0,1fr))">
        ${set.map(([i, l, v]) => `<button class="mc" data-action="sheet" data-sheet="settings"><ha-icon icon="${i}"></ha-icon><div class="mcv">${racEsc(v)}</div><div class="mcl">${l}</div></button>`).join("")}
      </div>
      <div class="rr-bar">
        <button class="rb" data-action="dock"><span class="ri"><ha-icon icon="mdi:home-import-outline"></ha-icon></span><span>Station</span></button>
        <button class="rb big" data-action="primary" ${this._primaryDisabled() ? "disabled" : ""}><span class="ri"><ha-icon icon="${pi}"></ha-icon></span><span>${racEsc(pl)}</span></button>
        <button class="rb" data-action="sheet" data-sheet="more"><span class="ri"><ha-icon icon="mdi:dots-horizontal"></ha-icon></span><span>Mehr</span></button>
      </div>
      ${this._active() || this._vacState() === "paused" ? `<button class="stopline" data-action="stop"><ha-icon icon="mdi:stop"></ha-icon>Reinigung beenden</button>` : ""}`;
  }

  /* ---------- Bottom-Sheets ---------- */
  _pills(entity, opts, cur, action, fmt) {
    return `<div class="pills">${opts.map((o) => `<button class="${o === cur ? "on" : ""}" data-action="${action}" data-entity="${entity}" data-option="${racEsc(o)}">${racEsc(fmt(o))}</button>`).join("")}</div>`;
  }

  _sheet() {
    const s = this._ui.sheet;
    if (!s) return "";
    const d = this._disc;
    let title = "", body = "";
    if (s === "settings") {
      title = "Reinigungseinstellungen";
      const vac = this._st(this._config.entity);
      if (this._ok(d.suction)) { const x = this._st(d.suction); body += `<div class="grp"><div class="gl"><ha-icon icon="mdi:fan"></ha-icon>Saugleistung</div>${this._pills(d.suction, x.attributes.options || [], x.state, "select", (o) => this._fmtOpt(d.suction, o))}</div>`; }
      else if (vac?.attributes?.fan_speed_list) body += `<div class="grp"><div class="gl"><ha-icon icon="mdi:fan"></ha-icon>Saugleistung</div>${this._pills(this._config.entity, vac.attributes.fan_speed_list, vac.attributes.fan_speed, "fan", (o) => this._fmtFan(o))}</div>`;
      if (this._ok(d.water)) { const x = this._st(d.water); body += `<div class="grp"><div class="gl"><ha-icon icon="mdi:water-outline"></ha-icon>${this._waterLabel()}</div>${this._pills(d.water, x.attributes.options || [], x.state, "select", (o) => this._fmtOpt(d.water, o))}</div>`; }
      if (this._ok(d.cmode)) { const x = this._st(d.cmode); body += `<div class="grp"><div class="gl"><ha-icon icon="mdi:broom"></ha-icon>Reinigungsmodus</div>${this._pills(d.cmode, x.attributes.options || [], x.state, "select", (o) => this._fmtOpt(d.cmode, o))}</div>`; }
      if (this._ok(d.route)) { const x = this._st(d.route); body += `<div class="grp"><div class="gl"><ha-icon icon="mdi:vector-polyline"></ha-icon>Route</div>${this._pills(d.route, x.attributes.options || [], x.state, "select", (o) => this._fmtOpt(d.route, o))}</div>`; }
      body += `<div class="grp"><div class="gl"><ha-icon icon="mdi:repeat"></ha-icon>Durchgänge (Räume & Zonen)</div>${this._pills("", ["1", "2", "3"], String(this._ui.repeats), "repeats", (o) => o + "×")}</div>`;
    } else if (s === "maps") {
      title = "Karte wählen";
      const x = this._st(d.mapSel);
      body = `<div class="grp">${this._pills(d.mapSel, x?.attributes?.options || [], x?.state, "select", (o) => this._fmtOpt(d.mapSel, o))}</div>`;
    } else if (s === "more") {
      title = "Mehr";
      const tiles = [
        ["locate", "mdi:map-marker-radius-outline", "Roboter finden"],
        ["sheet:maint", "mdi:wrench-outline", "Wartung"],
      ];
      if (d.dockBtns.length) tiles.push(["sheet:station", "mdi:home-variant-outline", "Station"]);
      if (d.mapSel) tiles.push(["sheet:maps", "mdi:layers-outline", "Karten"]);
      tiles.push(["moreinfo", "mdi:cog-outline", "Geräte­details"]);
      body = `<div class="tiles">${tiles.map(([a, i, l]) => {
        const [act, arg] = a.split(":");
        return `<button data-action="${act}" ${arg ? `data-sheet="${arg}"` : ""}><ha-icon icon="${i}"></ha-icon><span>${l}</span></button>`;
      }).join("")}</div>`;
    } else if (s === "maint") {
      title = "Wartung";
      body = d.consumables.length ? `<div class="maint">${d.consumables.map((id) => {
        const st = this._st(id), unit = st.attributes.unit_of_measurement || "";
        const v = parseFloat(st.state);
        const pct = unit === "%" && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null;
        const low = pct !== null ? pct < 15 : false;
        const reset = d.resetFor[id];
        return `<div class="mrow">
          <div class="mi"><ha-icon icon="${st.attributes.icon || "mdi:cog-outline"}"></ha-icon></div>
          <div class="mm"><div class="mn">${racEsc(this._short(id))}</div>
            ${pct !== null ? `<div class="bar ${low ? "low" : ""}"><i style="width:${pct}%"></i></div>` : ""}</div>
          <div class="mv ${low ? "low" : ""}">${racEsc(this._fmt(id))}</div>
          ${reset ? `<button class="mini" data-action="press" data-entity="${reset}" data-confirm="1">Zurücksetzen</button>` : ""}
        </div>`;
      }).join("")}</div>` : `<div class="hint">Keine Verbrauchsteile gefunden.</div>`;
    } else if (s === "station") {
      title = "Station";
      body = `<div class="tiles">${d.dockBtns.map((id) => `<button data-action="press" data-entity="${id}"><ha-icon icon="${this._st(id)?.attributes?.icon || "mdi:gesture-tap-button"}"></ha-icon><span>${racEsc(this._short(id))}</span></button>`).join("")}</div>`;
    } else if (s === "confirm") {
      const c = this._ui.confirm || {};
      title = "Zurücksetzen?";
      body = `<div class="hint">${racEsc(this._short(c.entity))} wirklich zurücksetzen?</div>
        <div class="cbtns"><button data-action="sheet" data-sheet="maint">Abbrechen</button><button class="on" data-action="press" data-entity="${c.entity}">Zurücksetzen</button></div>`;
    }
    return `<div class="backdrop" data-action="close"></div>
      <div class="sheet"><div class="grab"></div><div class="sh"><div class="st">${title}</div><button class="x" data-action="close"><ha-icon icon="mdi:close"></ha-icon></button></div>${body}</div>`;
  }

  /* ------------------------------------------------------------------ */
  /* Interaktion                                                         */
  /* ------------------------------------------------------------------ */
  _set(p) { this._ui = { ...this._ui, ...p }; this._update(true); }

  _onClick(e) {
    const el = e.composedPath().find((n) => n instanceof Element && n.dataset && n.dataset.action);
    if (!el || el.hasAttribute("disabled")) return;
    const a = el.dataset.action, h = this._hass, vac = this._config.entity;
    switch (a) {
      case "mode": this._set({ mode: el.dataset.mode }); break;
      case "room": {
        const raw = el.dataset.id, id = /^\d+$/.test(raw) ? Number(raw) : raw;
        const sel = [...this._ui.selected];
        const i = sel.indexOf(id);
        if (i >= 0) sel.splice(i, 1); else sel.push(id);
        this._set({ selected: sel });
        break;
      }
      case "clearsel": this._set({ selected: [] }); break;
      case "zdel": { e.stopPropagation(); const z = [...this._ui.zones]; z.splice(+el.dataset.i, 1); this._set({ zones: z }); break; }
      case "sheet": this._set({ sheet: el.dataset.sheet }); break;
      case "close": this._set({ sheet: null }); break;
      case "repeats": this._set({ repeats: +el.dataset.option }); break;
      case "select":
        h.callService("select", "select_option", { entity_id: el.dataset.entity, option: el.dataset.option });
        if (this._ui.sheet === "maps") this._set({ sheet: null, selected: [] });
        break;
      case "fan": h.callService("vacuum", "set_fan_speed", { entity_id: vac, fan_speed: el.dataset.option }); break;
      case "press":
        if (el.dataset.confirm) { this._set({ sheet: "confirm", confirm: { entity: el.dataset.entity } }); break; }
        h.callService("button", "press", { entity_id: el.dataset.entity });
        this._toast("Ausgeführt");
        if (this._ui.sheet === "confirm") this._set({ sheet: "maint" });
        break;
      case "dock": h.callService("vacuum", "return_to_base", { entity_id: vac }); this._toast("Fährt zur Station"); break;
      case "stop": h.callService("vacuum", "stop", { entity_id: vac }); this._toast("Gestoppt"); break;
      case "locate": h.callService("vacuum", "locate", { entity_id: vac }); this._toast("Roboter meldet sich"); this._set({ sheet: null }); break;
      case "moreinfo":
        this._set({ sheet: null });
        this.dispatchEvent(new CustomEvent("hass-more-info", { bubbles: true, composed: true, detail: { entityId: vac } }));
        break;
      case "primary": this._primary(); break;
    }
  }

  _primary() {
    const h = this._hass, vac = this._config.entity, st = this._vacState();
    const plat = this._disc.platform, n = this._ui.repeats;
    if (st === "cleaning" || st === "returning") { h.callService("vacuum", "pause", { entity_id: vac }); this._toast("Pausiert"); return; }
    if (st === "paused") { h.callService("vacuum", "start", { entity_id: vac }); this._toast("Wird fortgesetzt"); return; }
    const isDreame = /dreame/.test(plat);
    if (this._ui.mode === "rooms") {
      const seg = this._ui.selected;
      if (isDreame) h.callService("dreame_vacuum", "vacuum_clean_segment", { entity_id: vac, segments: seg, repeats: n });
      else h.callService("vacuum", "send_command", { entity_id: vac, command: "app_segment_clean", params: [{ segments: seg, repeat: n }] });
      this._toast(`${seg.length} ${seg.length === 1 ? "Raum" : "Räume"} gestartet`);
      return;
    }
    if (this._ui.mode === "zone") {
      const cal = this._cal(); if (!cal) return;
      const zones = this._ui.zones.map((z) => {
        const [ax, ay] = cal.toVac(z[0], z[1]), [bx, by] = cal.toVac(z[2], z[3]);
        return [Math.round(Math.min(ax, bx)), Math.round(Math.min(ay, by)), Math.round(Math.max(ax, bx)), Math.round(Math.max(ay, by))];
      });
      if (isDreame) h.callService("dreame_vacuum", "vacuum_clean_zone", { entity_id: vac, zone: zones, repeats: n });
      else h.callService("vacuum", "send_command", { entity_id: vac, command: "app_zoned_clean", params: zones.map((z) => [...z, n]) });
      this._toast("Zonenreinigung gestartet");
      return;
    }
    h.callService("vacuum", "start", { entity_id: vac });
    this._toast("Reinigung gestartet");
  }

  _svgPt(e) {
    const m = this._svg.getScreenCTM(); if (!m) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [Math.max(0, Math.min(this._iw, p.x)), Math.max(0, Math.min(this._ih, p.y))];
  }
  _zoneStart(e) {
    if (this._ui.mode !== "zone" || !this._cal() || this._ui.zones.length >= 5) return;
    if (e.composedPath().some((n) => n instanceof Element && n.dataset && n.dataset.action === "zdel")) return;
    const p = this._svgPt(e); if (!p) return;
    this._drag = { a: p, b: p };
    this._svg.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  _zoneMove(e) {
    if (!this._drag) return;
    const p = this._svgPt(e); if (!p) return;
    this._drag.b = p;
    const r = this._svg.querySelector(".ztemp");
    if (r) {
      const [a, b] = [this._drag.a, p];
      r.setAttribute("x", Math.min(a[0], b[0])); r.setAttribute("y", Math.min(a[1], b[1]));
      r.setAttribute("width", Math.abs(b[0] - a[0])); r.setAttribute("height", Math.abs(b[1] - a[1]));
    }
  }
  _zoneEnd() {
    if (!this._drag) return;
    const { a, b } = this._drag; this._drag = null;
    const min = this._iw * 0.03;
    if (Math.abs(b[0] - a[0]) > min && Math.abs(b[1] - a[1]) > min) this._set({ zones: [...this._ui.zones, [a[0], a[1], b[0], b[1]]] });
    else this._update(true);
  }

  _toast(msg) {
    const t = this.$(".toast"); if (!t) return;
    t.textContent = msg; t.classList.add("show");
    clearTimeout(this._tt); this._tt = setTimeout(() => t.classList.remove("show"), 1800);
  }

  /* ------------------------------------------------------------------ */
  /* Styles                                                              */
  /* ------------------------------------------------------------------ */
  _css() {
    return `
    :host { display:block; }
    .rac { display:block; position:relative; overflow:hidden; background:var(--bg); color:var(--text); border-radius:24px; border:none;
      font-family:-apple-system,"SF Pro Text","Inter","Segoe UI",Roboto,sans-serif; -webkit-font-smoothing:antialiased;
      padding:16px; box-shadow:none; }
    button { font:inherit; color:inherit; border:none; background:none; cursor:pointer; -webkit-tap-highlight-color:transparent; }
    button[disabled] { opacity:.45; cursor:default; }
    ha-icon { --mdc-icon-size:20px; display:inline-flex; }

    /* Kopf (Dreame) */
    .hdr { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; padding:4px 4px 12px; }
    .hl { min-width:0; } .batt { flex:none; }
    .nm { font-size:20px; font-weight:700; letter-spacing:-.2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .stt { display:flex; align-items:center; gap:7px; color:var(--sub); font-size:14px; margin-top:3px; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .dot { flex:none; }
    .dot { width:8px; height:8px; border-radius:50%; background:var(--sub); }
    .dot.ok { background:var(--ok); } .dot.run { background:var(--accent); box-shadow:0 0 0 4px var(--accentSoft); }
    .dot.err { background:var(--err); } .dot.warn { background:var(--warn); }
    .batt { display:inline-flex; align-items:center; gap:4px; font-weight:600; font-size:14px; }
    .batt ha-icon { --mdc-icon-size:20px; color:var(--ok); }
    .stats { display:flex; gap:8px; margin-bottom:12px; }
    .stat { flex:1; min-width:0; background:var(--surface); border-radius:16px; padding:10px 12px; }
    .sv { font-size:20px; font-weight:700; letter-spacing:-.3px; }
    .sv small { font-size:12px; font-weight:500; color:var(--sub); margin-left:3px; }
    .sl { font-size:12px; color:var(--sub); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .sv { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

    /* Karte */
    .mapwrap { position:relative; background:var(--mapBg); border-radius:20px; overflow:hidden; }
    .mapbox { position:relative; width:100%; aspect-ratio:1/1; max-height:62vh; margin:0 auto; }
    .mapimg { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; user-select:none; -webkit-user-drag:none; }
    .ov { position:absolute; inset:0; width:100%; height:100%; touch-action:manipulation; }
    .ov.zone { touch-action:none; cursor:crosshair; }
    .nomap { display:none; position:absolute; inset:0; align-items:center; justify-content:center; color:var(--sub); font-size:14px; }
    .mapbox.empty .nomap { display:flex; } .mapbox.empty { aspect-ratio:16/10; }
    .room rect { fill:var(--surface); fill-opacity:.94; stroke:rgba(0,0,0,.06); }
    .room text { fill:var(--text); text-anchor:middle; font-weight:600; pointer-events:none; }
    .room.click { cursor:pointer; }
    .room.ghost { opacity:.82; pointer-events:none; }
    .room.on rect { fill:var(--accent); fill-opacity:1; stroke:none; }
    .room.on text { fill:#fff; }
    .room .num { fill:#fff; } .room.on .numt { fill:var(--accent); text-anchor:middle; font-weight:800; }
    .zonebox rect { fill:var(--accent); fill-opacity:.16; stroke:var(--accent); stroke-width:2; stroke-dasharray:8 5; vector-effect:non-scaling-stroke; }
    .zdel circle { fill:var(--accent); } .zdel path { stroke:#fff; stroke-width:2.2; stroke-linecap:round; vector-effect:non-scaling-stroke; }
    .zdel { cursor:pointer; }
    .ztemp { fill:var(--accent); fill-opacity:.12; stroke:var(--accent); stroke-width:2; vector-effect:non-scaling-stroke; }
    .mapsel { position:absolute; right:10px; top:10px; display:flex; align-items:center; gap:6px; padding:7px 12px;
      border-radius:999px; background:var(--surface); font-size:13px; font-weight:600; box-shadow:0 2px 10px rgba(0,0,0,.08); }
    .mapsel ha-icon { --mdc-icon-size:16px; }

    /* Steuerung */
    .seg { display:flex; background:var(--surface); border-radius:16px; padding:4px; margin-top:12px; gap:4px; }
    .seg button { flex:1; min-width:0; white-space:nowrap; display:flex; align-items:center; justify-content:center; gap:6px; padding:10px 6px; border-radius:12px;
      font-size:14px; font-weight:600; color:var(--sub); transition:all .15s; overflow:hidden; text-overflow:ellipsis; }
    .seg button ha-icon { display:none; }
    .seg button span { min-width:0; overflow:hidden; text-overflow:ellipsis; }
    .seg button.on { background:var(--primary); color:var(--primaryText); }
    .hint { font-size:13px; color:var(--sub); padding:10px 6px 0; text-align:center; }
    .hint a { color:var(--accent); font-weight:600; cursor:pointer; margin-left:6px; }
    .roomlist { display:flex; flex-wrap:wrap; gap:8px; padding-top:12px; }
    .roomlist button { display:flex; align-items:center; gap:6px; padding:8px 12px; border-radius:999px; background:var(--surface); font-size:14px; font-weight:500; }
    .roomlist button b { display:inline-grid; place-items:center; width:20px; height:20px; border-radius:50%; background:#fff; color:var(--accent); font-size:12px; }
    .roomlist button.on { background:var(--accent); color:#fff; }
    .roomlist ha-icon { --mdc-icon-size:16px; }
    .modes { display:flex; gap:8px; margin-top:12px; }
    .modes button { flex:1; min-width:0; hyphens:auto; -webkit-hyphens:auto; display:flex; flex-direction:column; align-items:center; gap:6px; padding:12px 6px; background:var(--surface);
      border-radius:16px; font-size:12.5px; font-weight:600; color:var(--sub); border:2px solid transparent; text-align:center; line-height:1.2; }
    .modes button ha-icon { --mdc-icon-size:24px; }
    .modes button.on { color:var(--accent); border-color:var(--accent); background:var(--accentSoft); }
    .setrow { display:flex; align-items:center; width:100%; gap:4px; background:var(--surface); border-radius:16px; padding:12px; margin-top:12px; text-align:left; }
    .si { flex:1; display:flex; align-items:center; gap:8px; min-width:0; }
    .si ha-icon { color:var(--sub); --mdc-icon-size:18px; flex:none; }
    .si > div { min-width:0; flex:1; }
    .sil { font-size:11.5px; color:var(--sub); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; } .siv { font-size:14px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .chev { color:var(--sub); flex:none; }
    .actions { display:flex; align-items:center; gap:12px; margin-top:16px; }
    .round { display:flex; flex-direction:column; align-items:center; gap:4px; font-size:11.5px; color:var(--sub); width:56px; }
    .round .ri { width:48px; height:48px; border-radius:50%; background:var(--surface); display:grid; place-items:center; color:var(--text); }
    .round .ri ha-icon { --mdc-icon-size:22px; }
    .primary { flex:1; min-width:0; white-space:nowrap; overflow:hidden; height:54px; border-radius:27px; background:var(--primary); color:var(--primaryText); font-size:16px; font-weight:700;
      display:flex; align-items:center; justify-content:center; gap:8px; }
    .stopline { display:flex; align-items:center; justify-content:center; gap:6px; width:100%; margin-top:10px; padding:8px; color:var(--err); font-size:14px; font-weight:600; }

    /* Roborock */
    .roborock { padding:0; }
    .roborock .mapwrap { border-radius:0; padding:74px 12px 84px; }
    .roborock .mapbox { max-height:66vh; }
    .roborock .controls { padding:0 16px 16px; }
    .rr-hdr { position:absolute; left:12px; right:12px; top:12px; display:flex; justify-content:space-between; align-items:flex-start; gap:10px; pointer-events:none; }
    .rr-hdr .glass { min-width:0; } .rr-hdr .glass.b { flex:none; }
    .glass { background:color-mix(in srgb, var(--surface) 86%, transparent); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
      border-radius:16px; padding:9px 12px; box-shadow:0 4px 16px rgba(0,0,0,.08); }
    .rr-hdr .nm { font-size:17px; } .rr-hdr .stt { font-size:13px; }
    .rr-hdr .glass.b { padding:9px 10px; }
    .roborock .mapsel { top:auto; bottom:64px; right:12px; }
    .rr-stats { position:absolute; left:12px; right:12px; bottom:12px; display:flex; padding:6px 4px; }
    .rr-stats .stat { background:none; padding:2px 10px; text-align:center; }
    .rr-stats .sv { font-size:16px; } .rr-stats .sl { font-size:11px; }
    .roborock .seg { margin-top:14px; }
        .roborock .seg button.on { background:var(--accentSoft); color:var(--accent); }
    .sect { font-size:13px; font-weight:600; color:var(--sub); margin:14px 4px 0; }
    .cards { display:grid; gap:8px; margin-top:12px; }
    .mc { background:var(--surface); border-radius:16px; padding:12px 10px; min-width:0; text-align:left; display:flex; flex-direction:column; gap:2px; }
    .mc ha-icon { color:var(--accent); --mdc-icon-size:22px; margin-bottom:6px; }
    .mcv { font-size:14px; font-weight:700; line-height:1.2; overflow-wrap:anywhere; hyphens:auto; -webkit-hyphens:auto; }
    .mcl { font-size:11.5px; color:var(--sub); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .rr-bar { display:flex; justify-content:space-around; align-items:flex-end; margin-top:18px; }
    .rb { display:flex; flex-direction:column; align-items:center; gap:6px; font-size:12px; color:var(--sub); font-weight:600; max-width:40%; text-align:center; }
    .rb .ri { width:52px; height:52px; border-radius:50%; background:var(--surface); display:grid; place-items:center; color:var(--text); }
    .rb .ri ha-icon { --mdc-icon-size:24px; }
    .rb.big .ri { width:72px; height:72px; background:var(--primary); color:var(--primaryText); box-shadow:0 8px 22px var(--accentSoft); }
    .rb.big .ri ha-icon { --mdc-icon-size:34px; }
    .rb.big { color:var(--text); }

    /* Sheet */
    .backdrop { position:absolute; inset:0; background:rgba(0,0,0,.35); z-index:5; animation:fade .2s; }
    .sheet { position:absolute; left:0; right:0; bottom:0; z-index:6; background:var(--surface); border-radius:24px 24px 0 0;
      padding:8px 16px 20px; max-height:80%; overflow:auto; animation:up .22s cubic-bezier(.2,.8,.2,1); }
    @keyframes up { from { transform:translateY(100%); } } @keyframes fade { from { opacity:0; } }
    .grab { width:40px; height:5px; border-radius:3px; background:var(--line); margin:4px auto 10px; }
    .sh { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }
    .st { font-size:17px; font-weight:700; }
    .x { width:34px; height:34px; border-radius:50%; background:var(--chip); display:grid; place-items:center; }
    .grp { padding:10px 0; border-bottom:1px solid var(--line); } .grp:last-child { border:none; }
    .gl { display:flex; align-items:center; gap:8px; font-size:14px; font-weight:600; margin-bottom:10px; }
    .gl ha-icon { color:var(--sub); --mdc-icon-size:18px; }
    .pills { display:flex; flex-wrap:wrap; gap:8px; }
    .pills button { padding:9px 14px; border-radius:999px; background:var(--chip); font-size:14px; font-weight:500; }
    .pills button.on { background:var(--accent); color:#fff; font-weight:600; }
    .tiles { display:grid; grid-template-columns:repeat(auto-fill,minmax(96px,1fr)); gap:10px; padding:6px 0; }
    .tiles button { display:flex; flex-direction:column; align-items:center; gap:8px; padding:14px 6px; border-radius:16px; background:var(--chip); font-size:12.5px; font-weight:600; text-align:center; min-width:0; overflow-wrap:anywhere; hyphens:auto; -webkit-hyphens:auto; }
    .tiles ha-icon { --mdc-icon-size:26px; color:var(--accent); }
    .maint { display:flex; flex-direction:column; }
    .mrow { display:flex; align-items:center; gap:12px; padding:10px 0; border-bottom:1px solid var(--line); }
    .mrow:last-child { border:none; }
    .mi { width:38px; height:38px; border-radius:12px; background:var(--chip); display:grid; place-items:center; color:var(--sub); flex:none; }
    .mm { flex:1; min-width:0; } .mn { font-size:14px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .bar { height:5px; border-radius:3px; background:var(--chip); margin-top:6px; overflow:hidden; }
    .bar i { display:block; height:100%; background:var(--ok); border-radius:3px; } .bar.low i { background:var(--err); }
    .mv { font-size:14px; font-weight:600; white-space:nowrap; } .mv.low { color:var(--err); }
    .mini { padding:6px 10px; border-radius:999px; background:var(--chip); font-size:12px; font-weight:600; }
    .cbtns { display:flex; gap:10px; margin-top:14px; }
    .cbtns button { flex:1; padding:12px; border-radius:14px; background:var(--chip); font-weight:600; }
    .cbtns button.on { background:var(--err); color:#fff; }

    .toast { position:absolute; left:50%; bottom:20px; transform:translate(-50%,20px); background:rgba(20,22,26,.92); color:#fff;
      padding:9px 16px; border-radius:999px; font-size:13.5px; font-weight:600; opacity:0; transition:all .25s; pointer-events:none; z-index:9; white-space:nowrap; }
    .toast.show { opacity:1; transform:translate(-50%,0); }
    `;
  }
}

if (!customElements.get("robot-app-card")) customElements.define("robot-app-card", RobotAppCard);

/* ---------- Visueller Editor (Standard-HA-Einstellungsmenü via ha-form) ---------- */
async function racLoadHaForm() {
  if (customElements.get("ha-form") && customElements.get("ha-entity-picker")) return;
  try {
    // ha-form + Selektoren werden von HA erst bei Bedarf geladen -> über den Editor einer Standardkarte nachladen
    const helpers = await window.loadCardHelpers?.();
    const card = await helpers?.createCardElement({ type: "entities", entities: [] });
    await card?.constructor?.getConfigElement?.();
  } catch (_) { /* ältere/neuere HA-Versionen: ha-form ist meist schon geladen */ }
}

const RAC_LABELS = {
  entity: "Saugroboter", name: "Titel", style: "Layout", dark: "Dunkelmodus", accent: "Akzentfarbe",
  map_entity: "Karten-Entität", battery_entity: "Akku-Sensor", status_entity: "Status-Sensor",
  hide_rooms: "Ausgeblendete Räume", room_names: "Raumnamen",
};
const RAC_HELPERS = {
  name: "Leer lassen für den Gerätenamen",
  style: "Automatisch = nach Integration (Roborock oder Dreame)",
  accent: "Hex-Farbe, z. B. #2b6cff – leer lassen für die Layout-Farbe",
  map_entity: "Leer lassen für automatische Erkennung (Kamera/Bild mit Kalibrierung)",
  battery_entity: "Leer lassen für automatische Erkennung",
  status_entity: "Leer lassen für automatische Erkennung",
  hide_rooms: "Diese Räume erscheinen nicht auf der Karte",
};

class RobotAppCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  /* Räume über die Erkennungslogik der Karte ermitteln (ohne Umbenennung/Ausblendung) */
  _detectRooms() {
    const cfg = this._config, h = this._hass;
    if (!cfg.entity || !String(cfg.entity).startsWith("vacuum.") || !h?.states?.[cfg.entity]) return [];
    try {
      const probe = document.createElement("robot-app-card");
      probe._hass = h;
      probe._config = { ...cfg, room_names: {}, hide_rooms: [] };
      probe._discover();
      return probe._rooms().map((r) => ({ id: String(r.id), name: r.name }));
    } catch (_) { return []; }
  }

  _schema(rooms) {
    const opts = (o) => ({ select: { mode: "dropdown", options: o.map(([value, label]) => ({ value, label })) } });
    const roomSchema = rooms.length
      ? [
          { name: "hide_rooms", selector: { select: { multiple: true, mode: "list",
            options: rooms.map((r) => ({ value: r.id, label: `${r.name} (${r.id})` })) } } },
          { type: "expandable", name: "room_names", title: "Raumnamen", icon: "mdi:rename",
            schema: rooms.map((r) => ({ name: r.id, label: `Raum ${r.id}`, helper: `Erkannt: ${r.name}`, selector: { text: {} } })) },
        ]
      : [
          { name: "hide_rooms", selector: { select: { multiple: true, custom_value: true, options: [] } } },
          { name: "room_names", selector: { object: {} } },
        ];
    return [
      { name: "entity", required: true, selector: { entity: { domain: "vacuum" } } },
      { name: "name", selector: { text: {} } },
      { type: "expandable", name: "", flatten: true, title: "Darstellung", icon: "mdi:palette", schema: [
        { type: "grid", name: "", schema: [
          { name: "style", selector: opts([["auto", "Automatisch"], ["dreame", "Dreame"], ["roborock", "Roborock"]]) },
          { name: "dark", selector: opts([["auto", "Wie HA-Theme"], ["false", "Hell"], ["true", "Dunkel"]]) },
        ] },
        { name: "accent", selector: { text: {} } },
      ] },
      { type: "expandable", name: "", flatten: true, title: "Räume", icon: "mdi:floor-plan", schema: roomSchema },
      { type: "expandable", name: "", flatten: true, title: "Entitäten (optional)", icon: "mdi:tune-variant", schema: [
        { name: "map_entity", selector: { entity: { domain: ["camera", "image"] } } },
        { name: "battery_entity", selector: { entity: { domain: "sensor", device_class: "battery" } } },
        { name: "status_entity", selector: { entity: { domain: "sensor" } } },
      ] },
    ];
  }

  _render() {
    if (!this._hass || !this._config) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => s.label || RAC_LABELS[s.name] || s.name;
      this._form.computeHelper = (s) => s.helper || RAC_HELPERS[s.name];
      this._form.addEventListener("value-changed", (e) => this._changed(e));
      this.appendChild(this._form);
    }
    const rooms = this._detectRooms();
    const key = JSON.stringify(rooms);
    if (key !== this._roomKey) { this._roomKey = key; this._form.schema = this._schema(rooms); }

    const c = this._config;
    this._form.hass = this._hass;
    this._form.data = {
      ...c,
      style: c.style || "auto",
      dark: c.dark === undefined || c.dark === null ? "auto" : String(c.dark),
      hide_rooms: (c.hide_rooms || []).map(String),
      room_names: rooms.length ? Object.fromEntries(Object.entries(c.room_names || {}).map(([k, v]) => [String(k), v])) : c.room_names,
    };
  }

  _changed(ev) {
    ev.stopPropagation();
    const v = { ...ev.detail.value };
    const num = (x) => (/^\d+$/.test(String(x)) ? Number(x) : x);

    if (v.style === "auto") delete v.style;
    if (v.dark === "auto") delete v.dark;
    else if (v.dark === "true" || v.dark === "false") v.dark = v.dark === "true";
    if (Array.isArray(v.hide_rooms)) v.hide_rooms = v.hide_rooms.map(num);
    if (v.room_names && typeof v.room_names === "object") {
      const rn = {};
      Object.entries(v.room_names).forEach(([k, n]) => { if (n !== undefined && n !== null && String(n).trim() !== "") rn[num(k)] = n; });
      v.room_names = rn;
    }
    Object.keys(v).forEach((k) => {
      const x = v[k];
      if (x === undefined || x === null || x === "" || (Array.isArray(x) && !x.length) ||
        (x && typeof x === "object" && !Array.isArray(x) && !Object.keys(x).length)) delete v[k];
    });

    const config = { type: this._config.type || "custom:robot-app-card", ...v };
    this._config = config;
    this.dispatchEvent(new CustomEvent("config-changed", { bubbles: true, composed: true, detail: { config } }));
  }
}

if (!customElements.get("robot-app-card-editor")) customElements.define("robot-app-card-editor", RobotAppCardEditor);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "robot-app-card")) {
  window.customCards.push({ type: "robot-app-card", name: "Robot App Card", description: "Saugroboter im Dreame-/Roborock-App-Stil", preview: true });
}
console.info(`%c ROBOT-APP-CARD %c v${RAC_VERSION} `, "background:#2b6cff;color:#fff;border-radius:4px 0 0 4px;padding:2px 6px", "background:#15171c;color:#fff;border-radius:0 4px 4px 0;padding:2px 6px");

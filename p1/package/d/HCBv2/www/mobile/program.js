/* ============================================================
   program.js - Programma (weekschema van de thermostaat): bekijken en wijzigen
   Lezen:   /hcb_config?action=getObjectConfigTree&package=happ_thermstat&internalAddress=thermostatProgram
            schedule[0].entry[] met startDayOfWeek (0 = zondag), startHour, startMin, endDayOfWeek, endHour, endMin,
            targetState (0 comfort, 1 thuis, 2 slapen, 3 weg). Een blok loopt door tot het eindtijdstip, ook over
            middernacht en over het weekeinde heen.
   Schrijven: het hele schema (inclusief de back-up in de telefoon) wordt als device-xml naar /hcb_config gezet; de app
            controleert dat het teruggelezen wordt en dat de thermostaat het in gebruik neemt.
   Model:   het hele weekschema als 1008 vakjes van 10 minuten (zondag 00:00 = vakje 0). Alle bewerkingen werken op
            die vakjes; bij opslaan wordt er weer een lijst blokken van gemaakt.
   ============================================================ */
(function(){
"use strict";

var URL_PROGRAM = "/hcb_config?action=getObjectConfigTree&package=happ_thermstat&internalAddress=thermostatProgram";
var URL_SET = "/hcb_config?action=setObjectConfig&config=";
var DAY = 1440, WEEK = 10080;
var SLOTMIN = 10, DAYSLOTS = 144, WEEKSLOTS = 1008;
var MINSLOTS = 3;               // een blok duurt minstens 30 minuten (zoals in de originele app)
var MAXPERDAY = 6;              // maximaal 6 blokken per dag (zoals op de Toon)
var NAMES = ["Comfort", "Thuis", "Slapen", "Weg"];
var COLORS = ["#DD2C00", "#FFCC33", "#512DA8", "#0097A7"];   // comfort, thuis, slapen, weg (zoals de originele app)
var DAYS = ["M", "D", "W", "D", "V", "Z", "Z"];                // eerste letter van de dag, maandag-gebaseerd (zoals de originele app)
var DAYS2 = ["Ma", "Di", "Wo", "Do", "Vr", "Za", "Zo"];
var DAYFULL = ["Maandag", "Dinsdag", "Woensdag", "Donderdag", "Vrijdag", "Zaterdag", "Zondag"];
var LEGEND_ORDER = [3, 1, 2, 0];                             // weg, thuis, slapen, comfort
var PICK_ORDER = [3, 1, 2, 0];

var S = { entries: null, model: null, other: 0, sel: -1, at: 0, err: "", timer: null, loading: false,
          http: null, edit: null, copy: null, force: false, busy: false };

function first(v){ return Array.isArray(v) ? v[0] : v; }
function int(v){ var n = parseInt(first(v), 10); return isNaN(n) ? null : n; }
function pad(n){ return (n < 10 ? "0" : "") + n; }
function hm(min){ min = ((min % DAY) + DAY) % DAY; return pad(Math.floor(min / 60)) + ":" + pad(min % 60); }
function slotHM(i){ return i >= DAYSLOTS ? "24:00" : hm(i * SLOTMIN); }
function monIdx(sunIdx){ return (sunIdx + 6) % 7; }          // zondag-gebaseerd -> maandag-gebaseerd
function sunIdx(monIndex){ return (monIndex + 1) % 7; }
function esc(s){ return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

/* ============================================================
   MODEL (zuiver, zonder DOM): vakjes van 10 minuten
   ============================================================ */
function parse(d){
  var out = [], other = 0;
  var sch = d && first(d.schedule);
  var list = (sch && sch.entry) || [];
  if(!Array.isArray(list)) list = [list];
  list.forEach(function(e){
    var type = String(first(e.type) || "weekly_recurring");
    var sd = int(e.startDayOfWeek), sh = int(e.startHour), sm = int(e.startMin);
    var ed = int(e.endDayOfWeek), eh = int(e.endHour), em = int(e.endMin), st = int(e.targetState);
    if(sd === null || sh === null || sm === null || ed === null || eh === null || em === null || st === null) return;
    if(type !== "weekly_recurring"){ other++; return; }      // vakantie e.d. niet in het weekschema
    var s = sd * DAY + sh * 60 + sm, en = ed * DAY + eh * 60 + em;
    if(en <= s) en += WEEK;
    out.push({ s: s, e: en, state: st });
  });
  out.sort(function(a, b){ return a.s - b.s; });
  return { entries: out, other: other };
}

/* entries -> { ok, slots, reason } ; bewerken kan alleen als alles op 10 minuten valt en de week sluitend is */
function slotsFromEntries(entries){
  var slots = [], i;
  for(i = 0; i < WEEKSLOTS; i++) slots.push(-1);
  if(!entries || entries.length < 2) return { ok: false, reason: "weinig" };
  for(i = 0; i < entries.length; i++){
    var e = entries[i];
    if(e.s % SLOTMIN || e.e % SLOTMIN) return { ok: false, reason: "tijden" };
    for(var m = e.s; m < e.e; m += SLOTMIN){
      var k = (m / SLOTMIN) % WEEKSLOTS;
      if(slots[k] !== -1) return { ok: false, reason: "overlap" };
      slots[k] = e.state;
    }
  }
  for(i = 0; i < WEEKSLOTS; i++) if(slots[i] === -1) return { ok: false, reason: "gat" };
  return { ok: true, slots: slots };
}

/* opeenvolgende gelijke vakjes (rond het weekeinde heen) -> blokken, gesorteerd op start */
function runsOf(slots){
  var n = slots.length, b = -1, i;
  for(i = 0; i < n; i++) if(slots[i] !== slots[(i + n - 1) % n]){ b = i; break; }
  if(b < 0) return [{ a: 0, n: n, state: slots[0] }];
  var runs = [], cur = null;
  for(var j = 0; j < n; j++){
    var idx = (b + j) % n;
    if(!cur || slots[idx] !== cur.state){ cur = { a: idx, n: 1, state: slots[idx] }; runs.push(cur); }
    else cur.n++;
  }
  runs.sort(function(x, y){ return x.a - y.a; });
  return runs;
}

/* vakjes -> lijst [startDag, uur, min, eindDag, uur, min, stand] (zondag = dag 0), of null als er minder dan 2 blokken zijn */
function entriesFromSlots(slots){
  var runs = runsOf(slots);
  if(runs.length < 2) return null;
  var out = [];
  for(var i = 0; i < runs.length; i++){
    var s = runs[i].a * SLOTMIN, e = runs[(i + 1) % runs.length].a * SLOTMIN;
    out.push([Math.floor(s / DAY), Math.floor((s % DAY) / 60), s % 60, Math.floor(e / DAY), Math.floor((e % DAY) / 60), e % 60, runs[i].state]);
  }
  return out;
}
function payloadOf(entries){ return entries.map(function(e){ return e.join(","); }).join(";"); }

/* blokken van één dag (dayIdx zondag-gebaseerd) in vakjes binnen de dag: [{a, b, state}] met b exclusief */
function dayBlocksOf(slots, dayIdx){
  var base = dayIdx * DAYSLOTS, out = [], cur = null;
  for(var i = 0; i < DAYSLOTS; i++){
    var st = slots[base + i];
    if(!cur || cur.state !== st){ cur = { a: i, b: i + 1, state: st }; out.push(cur); }
    else cur.b = i + 1;
  }
  return out;
}

/* Het eerste blok van een dag loopt vaak al door vanaf de vorige dag (bijv. slapen vanaf 22:00). Geeft het echte begin:
   {back: aantal vakjes vóór 00:00, hm: "22:00", day: "dinsdag"} of null als het blok om 00:00 begint. */
function carryStart(slots, dayIdx, state){
  var base = dayIdx * DAYSLOTS, n = 0;
  while(n < WEEKSLOTS - 1 && slots[(base - 1 - n + 2 * WEEKSLOTS) % WEEKSLOTS] === state) n++;
  if(!n) return null;
  var abs = base - n, d = ((Math.floor(abs / DAYSLOTS) % 7) + 7) % 7, i = ((abs % DAYSLOTS) + DAYSLOTS) % DAYSLOTS;
  return { back: n, hm: slotHM(i), day: DAYFULL[monIdx(d)].toLowerCase() };
}

function setRange(slots, dayIdx, a, b, state){
  var base = dayIdx * DAYSLOTS;
  for(var i = a; i < b; i++) slots[base + i] = state;
}
/* Net als op de Toon: blok 0 (loopt al vanaf de vorige dag) kan niet gewijzigd worden; een blok heeft minstens 30 minuten;
   er mogen maximaal 6 blokken bij (naast blok 0); buren schuiven mee (met waarschuwing) als ze te dichtbij komen. */
function blockLists(blocks){ return { starts: blocks.map(function(b){ return b.a; }), states: blocks.map(function(b){ return b.state; }) }; }
function limitsFor(n, k){ return { min: k * MINSLOTS, max: DAYSLOTS - (n - k) * MINSLOTS }; }
/* zet het begin van blok k op s en schuift de buren indien nodig. Geeft {starts, shifted:{j,from,to}|null} */
function placeStart(starts, k, s){
  var n = starts.length, lim = limitsFor(n, k), out = starts.slice(), j;
  out[k] = Math.max(lim.min, Math.min(lim.max, s));
  for(j = k - 1; j >= 1; j--) if(out[j] > out[j + 1] - MINSLOTS) out[j] = out[j + 1] - MINSLOTS;
  for(j = k + 1; j < n; j++) if(out[j] < out[j - 1] + MINSLOTS) out[j] = out[j - 1] + MINSLOTS;
  var sh = null;
  for(j = k - 1; j >= 1 && !sh; j--) if(out[j] !== starts[j]) sh = { j: j, from: starts[j], to: out[j], dir: "vorige" };
  for(j = k + 1; j < n && !sh; j++) if(out[j] !== starts[j]) sh = { j: j, from: starts[j], to: out[j], dir: "volgende" };
  return { starts: out, shifted: sh };
}
function writeDay(slots, dayIdx, starts, states){
  var out = slots.slice();
  for(var j = 0; j < starts.length; j++) setRange(out, dayIdx, j === 0 ? 0 : starts[j], j + 1 < starts.length ? starts[j + 1] : DAYSLOTS, states[j]);
  return out;
}
/* welke "+"-knoppen staan er: lijst met invoegposities (zelfde regels als op de Toon) */
function plusPositions(blocks){
  var n = blocks.length, res = [];
  if(n - 1 >= MAXPERDAY) return res;
  if(n === 1) return [1];
  for(var k = 1; k < n; k++) if(blocks[k].a - blocks[k - 1].a >= 2 * MINSLOTS) res.push(k);
  if(blocks[n - 1].a <= DAYSLOTS - 6) res.push(n);
  return res;
}
function canAdd(blocks){ return plusPositions(blocks).length > 0; }
/* beginwaarden voor een nieuw blok op positie idx: 30 min na het vorige blok, zelfde stand als het vorige blok */
function addDefaults(blocks, idx){
  var l = blockLists(blocks), start = idx > 1 ? blocks[idx - 1].a + MINSLOTS : 0;
  l.starts.splice(idx, 0, start); l.states.splice(idx, 0, blocks[idx - 1].state);
  return { starts: l.starts, states: l.states, start: placeStart(l.starts, idx, start).starts[idx], state: blocks[idx - 1].state };
}
function applyEdit(slots, dayIdx, k, newStart, newState){
  var blocks = dayBlocksOf(slots, dayIdx); if(k <= 0) return slots.slice();
  var l = blockLists(blocks); l.states[k] = newState;
  return writeDay(slots, dayIdx, placeStart(l.starts, k, newStart).starts, l.states);
}
/* nieuw blok op positie idx (voor het huidige blok idx) */
function applyAdd(slots, dayIdx, idx, start, state){
  var blocks = dayBlocksOf(slots, dayIdx), l = blockLists(blocks);
  l.starts.splice(idx, 0, start); l.states.splice(idx, 0, state);
  return writeDay(slots, dayIdx, placeStart(l.starts, idx, start).starts, l.states);
}
/* blok k (niet het eerste) verwijderen: het vorige blok loopt door */
function applyDelete(slots, dayIdx, k){
  var out = slots.slice(), blocks = dayBlocksOf(slots, dayIdx);
  if(k <= 0) return out;
  setRange(out, dayIdx, blocks[k].a, blocks[k].b, blocks[k - 1].state);
  return out;
}
function applyCopy(slots, fromDay, toDays){
  var out = slots.slice();
  toDays.forEach(function(t){
    if(t === fromDay) return;
    for(var i = 0; i < DAYSLOTS; i++) out[t * DAYSLOTS + i] = slots[fromDay * DAYSLOTS + i];
  });
  return out;
}
function sameSlots(a, b){
  if(!a || !b || a.length !== b.length) return false;
  for(var i = 0; i < a.length; i++) if(a[i] !== b[i]) return false;
  return true;
}

/* ---------- overzicht: blokken van één dag in minuten (bestaande schermopbouw) ---------- */
function dayBlocks(dayIdx){
  var a = dayIdx * DAY, b = a + DAY, res = [];
  (S.entries || []).forEach(function(e){
    [-WEEK, 0, WEEK].forEach(function(off){
      var s = e.s + off, en = e.e + off;
      var from = Math.max(s, a), to = Math.min(en, b);
      if(to > from) res.push({ from: from - a, to: to - a, state: e.state, startsToday: s >= a, endsToday: en <= b, s: s, e: en });
    });
  });
  res.sort(function(x, y){ return x.from - y.from; });
  return res;
}

function stateTemp(id){
  var t = (window.STATE_TEMPS || {})[id];
  return (t === undefined || t === null) ? "" : fmtTemp(t);
}

/* ============================================================
   OVERZICHT (opbouw en stijl van "Weekprogramma" in de originele app)
   ============================================================ */
var ICON_EDIT = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
var ICON_COPY = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
var ICON_DEL = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
var ICON_ADD = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';

function canEditNow(){ return !!(S.model && S.model.ok && S.http !== false); }

function render(){
  var host = $("prg-body"); if(!host) return;
  if(!hasToon()){ host.innerHTML = '<div class="empty">Geen Toon-adres ingesteld (Meer › Instellingen).</div>'; return; }
  if(S.entries === null){
    host.innerHTML = '<div class="empty">' + (S.err ? ("Programma niet te laden: " + S.err) : "Programma laden…") + '</div>';
    return;
  }
  if(!S.entries.length){ host.innerHTML = '<div class="empty">De Toon heeft geen weekprogramma.</div>'; return; }

  if(S.sel < 0) S.sel = monIdx(new Date().getDay());
  var editable = canEditNow();

  var h = '<div class="prg-blocks' + (editable ? " has-opts" : "") + '">';
  for(var d = 0; d < 7; d++){
    var blocks = dayBlocks(sunIdx(d)), isSel = (d === S.sel);
    h += '<div class="prg-day' + (d >= 5 ? " weekend" : "") + '"><div class="prg-name">' + DAYS[d] + '</div>' +
         '<button class="prg-line' + (isSel ? " sel" : "") + '" data-d="' + d + '" aria-label="' + DAYFULL[d] + '"><span class="prg-block">';
    blocks.forEach(function(b){
      var dur = b.to - b.from;
      h += '<span class="prg-seg' + (isSel ? " on" : "") + (dur < 60 ? " hide" : "") + '" style="flex:' + Math.round(dur / DAY * 100) + ';background:' + COLORS[b.state] + '" data-time="' + hm(b.from) + '"></span>';
    });
    h += '</span></button>';
    if(editable){
      h += '<div class="prg-opts">' + (isSel ?
        '<button class="rbtn" data-act="edit" aria-label="Dag wijzigen">' + ICON_EDIT + '</button>' +
        '<button class="rbtn" data-act="copy" aria-label="Dag kopiëren">' + ICON_COPY + '</button>' : '') + '</div>';
    }
    h += '</div>';
  }
  h += '</div><ul class="prg-legend">';
  LEGEND_ORDER.forEach(function(i){
    h += '<li style="color:' + COLORS[i] + '"><div class="prg-ltxt"><div>' + NAMES[i] + '</div><div>' + stateTemp(i) + '</div></div></li>';
  });
  h += '</ul>';
  if(editable && localBackup()) h += '<div class="prg-foot"><button class="prg-link" id="prg-restore">Vorig programma terugzetten</button></div>';
  if(S.other) h += '<div class="prg-note">De Toon heeft ook ' + S.other + ' vakantie-blok in het programma; dat staat niet in dit overzicht en blijft bij wijzigen behouden.</div>';
  if(S.model && !S.model.ok)
    h += '<div class="prg-note">Dit programma heeft tijden die niet op 10 minuten vallen. Wijzigen kan daarom alleen op de Toon zelf.</div>';
  if(S.http === false)
    h += '<div class="prg-note">Deze Toon neemt wijzigingen niet rechtstreeks aan, dus dit scherm is alleen om te bekijken. Het programma wijzigen kan op de Toon zelf.</div>';
  host.innerHTML = h;
  host.querySelectorAll(".prg-line").forEach(function(b){
    b.addEventListener("click", function(){ S.sel = parseInt(b.getAttribute("data-d"), 10); render(); });
  });
  host.querySelectorAll(".rbtn").forEach(function(b){
    b.addEventListener("click", function(){
      if(b.getAttribute("data-act") === "edit") openEdit(S.sel); else openCopy(S.sel);
    });
  });
  var rs = $("prg-restore"); if(rs) rs.addEventListener("click", askRestore);
}

/* ============================================================
   HULP: meldingen, bevestigen, bezig-scherm
   ============================================================ */
var toastTimer = null;
function toast(text){
  var t = $("prg-toast"); if(!t) return;
  t.textContent = text; t.classList.add("show");
  if(toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ t.classList.remove("show"); }, 2800);
}
function modal(html, wire){
  var m = $("prg-modal"), c = $("prg-modal-card"); if(!m || !c) return;
  c.innerHTML = html; m.classList.add("open");
  if(wire) wire(c);
}
function closeModal(){ var m = $("prg-modal"); if(m) m.classList.remove("open"); }
function ask(text, yes, no, cb){
  modal('<div class="pm-text">' + esc(text) + '</div><div class="pm-btns"><button class="primary-btn ghost" id="pm-no">' + esc(no) + '</button><button class="primary-btn" id="pm-yes">' + esc(yes) + '</button></div>', function(){
    $("pm-no").addEventListener("click", closeModal);
    $("pm-yes").addEventListener("click", function(){ closeModal(); cb(); });
  });
}
function tell(text, cb){
  modal('<div class="pm-text">' + esc(text) + '</div><div class="pm-btns"><button class="primary-btn" id="pm-ok">OK</button></div>', function(){
    $("pm-ok").addEventListener("click", function(){ closeModal(); if(cb) cb(); });
  });
}
function busy(text){
  S.busy = true;
  modal('<div class="pm-text pm-busy"><span class="pm-spin"></span>' + esc(text) + '</div>');
}
function unbusy(){ S.busy = false; closeModal(); }

/* ============================================================
   WIJZIGEN: dag bewerken
   ============================================================ */
function dirtyEdit(){ return !!(S.edit && S.model && !sameSlots(S.edit.slots, S.model.slots)); }

function openEdit(d){
  if(!canEditNow()) return;
  S.edit = { d: d, slots: S.model.slots.slice(), sel: -1 };
  openPage("programedit");
  renderEdit();
}

function renderEdit(){
  var host = $("pe-body"); if(!host || !S.edit) return;
  var e = S.edit, sd = sunIdx(e.d), blocks = dayBlocksOf(e.slots, sd), plus = plusPositions(blocks);
  var h = '<div class="pe-tabs">';
  for(var t = 0; t < 7; t++) h += '<button class="pe-tab' + (t === e.d ? " on" : "") + (t >= 5 ? " we" : "") + '" data-day="' + t + '" aria-label="' + DAYFULL[t] + '">' + DAYS[t] + '</button>';
  h += '</div><div class="pe-title">' + DAYFULL[e.d] + '</div><ul class="pe-list">';
  blocks.forEach(function(b, k){
    var cs = (k === 0) ? carryStart(e.slots, sd, b.state) : null;
    h += '<li class="pe-item">' + (k > 0 && plus.indexOf(k) >= 0 ? '<button class="pe-plus" data-act="add" data-k="' + k + '" aria-label="Blok toevoegen">' + ICON_ADD + '</button>' : '') +
         '<div class="pe-row' + (k === 0 ? " carry" : "") + '">' +
         '<span class="pe-bar-c" style="background:' + COLORS[b.state] + '"></span>' +
         '<span class="pe-name">' + NAMES[b.state] + '<small>' + stateTemp(b.state) + '</small></span>' +
         '<span class="pe-time">' + (k === 0 ? (cs ? cs.hm : '00:00') + '<small>' + (cs ? cs.day : DAYFULL[e.d].toLowerCase()) + '</small>' : slotHM(b.a)) + '</span>' +
         (k > 0 ? '<button class="pe-ic" data-act="edit" data-k="' + k + '" aria-label="Blok wijzigen">' + ICON_EDIT + '</button>' +
                  '<button class="pe-ic" data-act="del" data-k="' + k + '" aria-label="Blok verwijderen">' + ICON_DEL + '</button>'
                : '<span class="pe-ic ph"></span><span class="pe-ic ph"></span>') +
         '</div>' + (k === blocks.length - 1 && plus.indexOf(blocks.length) >= 0 ? '<button class="pe-plus end" data-act="add" data-k="' + blocks.length + '" aria-label="Blok toevoegen">' + ICON_ADD + '</button>' : '') + '</li>';
  });
  h += '</ul>';
  if(blocks.length - 1 >= MAXPERDAY) h += '<div class="prg-note">Een dag kan maximaal ' + MAXPERDAY + ' blokken hebben.</div>';
  host.innerHTML = h;
  host.querySelectorAll(".pe-tab").forEach(function(b){
    b.addEventListener("click", function(){ e.d = parseInt(b.getAttribute("data-day"), 10); renderEdit(); });
  });
  host.querySelectorAll("[data-act]").forEach(function(b){
    b.addEventListener("click", function(ev){
      ev.stopPropagation();
      var k = parseInt(b.getAttribute("data-k"), 10), act = b.getAttribute("data-act");
      if(act === "edit") openBlockModal("edit", k);
      else if(act === "add") openBlockModal("add", k);
      else if(act === "del") ask("Weet je zeker dat je dit blok wilt verwijderen?", "Ja", "Nee", function(){
        e.slots = applyDelete(e.slots, sd, k); renderEdit();
      });
    });
  });
  var sv = $("pe-save"); if(sv){ var dirty = dirtyEdit(); sv.disabled = !dirty; sv.classList.toggle("off", !dirty); }
}

/* mode "edit": blok k wijzigen; mode "add": nieuw blok op positie k (zoals op de Toon: begin = 30 min na het vorige blok, zelfde stand) */
function openBlockModal(mode, k){
  var e = S.edit, sd = sunIdx(e.d), blocks = dayBlocksOf(e.slots, sd), base, startVal, state;
  if(mode === "edit"){ base = blockLists(blocks); startVal = blocks[k].a; state = blocks[k].state; }
  else { var df = addDefaults(blocks, k); base = { starts: df.starts, states: df.states }; startVal = df.start; state = df.state; }
  var lim = limitsFor(base.starts.length, k);
  var h = '<div class="pm-title">' + (mode === "edit" ? "Blok wijzigen" : "Blok toevoegen") + ' ' + DAYFULL[e.d].toLowerCase() + '</div>';
  h += '<label class="pm-lab">Begintijd</label><select id="pm-time">';
  for(var i = lim.min; i <= lim.max; i++) h += '<option value="' + i + '"' + (i === startVal ? " selected" : "") + '>' + slotHM(i) + '</option>';
  h += '</select><div class="pm-hint" id="pm-warn"></div>';
  h += '<label class="pm-lab">Programma</label><div class="pm-states">';
  PICK_ORDER.forEach(function(s){
    h += '<button class="radio-row' + (s === state ? " sel" : "") + '" data-s="' + s + '"><span class="radio"></span>' +
         '<span class="pm-dot" style="background:' + COLORS[s] + '"></span><span>' + NAMES[s] + '</span><span class="pm-t">' + stateTemp(s) + '</span></button>';
  });
  h += '</div><div class="pm-btns"><button class="primary-btn ghost" id="pm-cancel">Annuleren</button><button class="primary-btn" id="pm-ok">OK</button></div>';
  modal(h, function(c){
    var chosen = state;
    function warn(){
      var r = placeStart(base.starts, k, parseInt($("pm-time").value, 10)), w = $("pm-warn");
      w.textContent = r.shifted ? 'Er moet minimaal 30 minuten verschil zijn met de ' + r.shifted.dir + ' periode. Met deze instelling wordt de periode van ' +
        slotHM(r.shifted.from) + ' (' + NAMES[base.states[r.shifted.j]] + ') verschoven naar ' + slotHM(r.shifted.to) + ' uur.' : '';
    }
    $("pm-time").addEventListener("change", warn); warn();
    c.querySelectorAll(".radio-row").forEach(function(b){
      b.addEventListener("click", function(){
        c.querySelectorAll(".radio-row").forEach(function(x){ x.classList.remove("sel"); });
        b.classList.add("sel"); chosen = parseInt(b.getAttribute("data-s"), 10);
      });
    });
    $("pm-cancel").addEventListener("click", closeModal);
    $("pm-ok").addEventListener("click", function(){
      var tv = parseInt($("pm-time").value, 10);
      e.slots = (mode === "edit") ? applyEdit(e.slots, sd, k, tv, chosen) : applyAdd(e.slots, sd, k, tv, chosen);
      closeModal(); renderEdit();
    });
  });
}

/* sluiten van het wijzigscherm met een waarschuwing bij niet-opgeslagen wijzigingen (aangeroepen vanuit closePage) */
function guardClose(fromPop){
  if(S.force || !dirtyEdit()) { S.force = false; return false; }
  if(fromPop){ try{ history.pushState({ pg: "programedit" }, ""); }catch(e){} }
  ask("Je wijzigingen zijn nog niet opgeslagen. Weggooien?", "Weggooien", "Terug", function(){ S.force = true; closePage(); });
  return true;
}
function forceClosePage(){ S.force = true; closePage(); }
function editClosed(){ S.edit = null; S.copy = null; S.force = false; }

/* ============================================================
   RECHTSTREEKS VIA HTTP
   Op nieuwere Toon-software neemt de Toon een schema dat via /hcb_config wordt gezet gewoon over. We controleren dat altijd:
   het schema moet teruggelezen worden én de thermostaat moet het in gebruik nemen (randomConfigId verandert).
   Lukt dat niet, dan blijft het scherm alleen-lezen en wordt het programma op de Toon zelf gewijzigd.
   ============================================================ */
var URL_STATES = "/hcb_config?action=getObjectConfigTree&package=happ_thermstat&internalAddress=thermostatStates";
var URL_TINFO = "/happ_thermstat?action=getThermostatInfo";
var BKEY = "tscPrgBackups";

function xmlEsc(v){ return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function toXml(k, v){
  if(Array.isArray(v)){ var o = ""; v.forEach(function(i){ o += toXml(k, i); }); return o; }
  if(v !== null && typeof v === "object"){ var p = ""; Object.keys(v).forEach(function(a){ p += toXml(a, v[a]); }); return "<" + k + ">" + p + "</" + k + ">"; }
  return "<" + k + ">" + xmlEsc(v) + "</" + k + ">";
}
function deviceXml(d){ var p = ""; Object.keys(d).forEach(function(k){ p += toXml(k, d[k]); }); return "<Config><device>" + p + "</device></Config>"; }
function httpPut(d, cb){
  getJSON(URL_SET + encodeURIComponent(deviceXml(d)), function(r){ cb(!!(r && r.result === "ok")); }, function(){ cb(false); });
}
function newId(){
  var h = "0123456789abcdef", o = "";
  for(var i = 0; i < 36; i++) o += (i === 8 || i === 13 || i === 18 || i === 23) ? "-" : (i === 14 ? "4" : h.charAt(Math.floor(Math.random() * 16)));
  return o;
}
function rid(cb){
  getJSON(URL_TINFO, function(d){ cb(d && d.result === "ok" ? String(d.randomConfigId) : null, d); }, function(){ cb(null, null); });
}
function eType(e){ var t = e && e.type; t = Array.isArray(t) ? t[0] : t; return String(t || "weekly_recurring"); }
function entryObj(a){
  return { type: ["weekly_recurring"], startMin: [String(a[2])], startHour: [String(a[1])], startDayOfWeek: [String(a[0])],
           targetState: [String(a[6])], endMin: [String(a[5])], endHour: [String(a[4])], endDayOfWeek: [String(a[3])] };
}

/* back-ups van het weekschema in de telefoon */
function backupsGet(){ try { var l = JSON.parse(localStorage.getItem(BKEY) || "[]"); return Array.isArray(l) ? l : []; } catch(e){ return []; } }
function backupsAdd(slots){
  try {
    var l = backupsGet(), str = slots.join("");
    if(l.length && l[0].s === str) return;
    l.unshift({ t: Date.now(), s: str }); localStorage.setItem(BKEY, JSON.stringify(l.slice(0, 10)));
  } catch(e){}
}
function backupSlots(b){ var a = []; for(var i = 0; i < b.s.length; i++) a.push(parseInt(b.s.charAt(i), 10)); return a.length === WEEKSLOTS ? a : null; }

function waitFor(test, tries, cb){            // test(cb2) roept cb2(true/false); elke seconde opnieuw
  var n = 0;
  (function go(){ n++; test(function(ok){ if(ok) cb(true); else if(n >= tries) cb(false); else setTimeout(go, 1000); }); })();
}

/* weekschema: slots -> Toon, gecontroleerd. cb(true) of cb(false, reden) met reden "http" (niet aangenomen) of "actief" (opgeslagen, maar niet in gebruik) */
function writeSlotsHttp(slots, cb){
  var ents = entriesFromSlots(slots); if(!ents){ cb(false, "http"); return; }
  getJSON(URL_PROGRAM, function(raw){
    if(!raw || !raw.schedule || !raw.uuid){ cb(false, "http"); return; }
    var before = slotsFromEntries(parse(raw).entries);
    if(before.ok) backupsAdd(before.slots);
    var cur = raw.schedule[0].entry || [];
    var other = cur.filter(function(e){ return eType(e) !== "weekly_recurring"; });
    var d = JSON.parse(JSON.stringify(raw));
    d.schedule = [{ entry: ents.map(entryObj).concat(other) }];
    var unchanged = before.ok && sameSlots(before.slots, slots);
    rid(function(r0){
      httpPut(d, function(ok){
        if(!ok){ cb(false, "http"); return; }
        waitFor(function(c2){
          getJSON(URL_PROGRAM, function(x){ var m = slotsFromEntries(parse(x).entries); c2(m.ok && sameSlots(m.slots, slots)); }, function(){ c2(false); });
        }, 8, function(stored){
          if(!stored){ cb(false, "http"); return; }
          if(unchanged || r0 === null){ cb(true); return; }
          waitFor(function(c3){ rid(function(r1){ c3(r1 !== null && r1 !== r0); }); }, 6, function(applied){ cb(applied, applied ? "" : "actief"); });
        });
      });
    });
  }, function(){ cb(false, "http"); });
}

/* vakantiestand */
function setStateTemp(id, temp, cb){
  getJSON(URL_STATES, function(st){
    var list = st && st.states && st.states[0] && st.states[0].state; if(!list){ cb(false); return; }
    var changed = false;
    list.forEach(function(s){ if(String(first(s.id)) === String(id) && String(first(s.tempValue)) !== String(temp)){ s.tempValue = [String(temp)]; changed = true; } });
    if(!changed){ cb(true); return; }
    httpPut(st, cb);
  }, function(){ cb(false); });
}
function holidayEntries(raw){ return ((raw.schedule && raw.schedule[0] && raw.schedule[0].entry) || []).filter(function(e){ return eType(e) === "holiday"; }); }
function putHoliday(start, end, temp, cb){           // end = 0: vakantie weghalen
  getJSON(URL_PROGRAM, function(raw){
    if(!raw || !raw.schedule || !raw.uuid){ cb(false); return; }
    var d = JSON.parse(JSON.stringify(raw));
    var keep = (d.schedule[0].entry || []).filter(function(e){ return eType(e) !== "holiday"; });
    if(end) keep.push({ type: ["holiday"], startTimeT: [String(start)], endTimeT: [String(end)], targetState: ["4"], entryId: [newId()] });
    d.schedule = [{ entry: keep }];
    httpPut(d, cb);
  }, function(){ cb(false); });
}
function holVerifyOn(start, end, temp, now, cb){
  waitFor(function(c){
    rid(function(r, d){
      if(!d){ c(false); return; }
      if(start <= now) c(parseInt(d.programState, 10) === PROG_HOLIDAY && parseInt(d.currentSetpoint, 10) === temp);
      else getJSON(URL_PROGRAM, function(x){ c(holidayEntries(x).some(function(e){ return parseInt(first(e.endTimeT), 10) === end; })); }, function(){ c(false); });
    });
  }, 10, cb);
}
function holOnCfg(start, end, temp, cb){              // terugvaloptie: vakantie als blok in het programma zetten
  var now = Math.floor(Date.now() / 1000);
  setStateTemp(4, temp, function(ok){
    if(!ok){ cb(false); return; }
    putHoliday(start, end, temp, function(ok2){
      if(!ok2){ cb(false); return; }
      holVerifyOn(start, end, temp, now, cb);
    });
  });
}
function holOffCfg(cb){
  putHoliday(0, 0, 0, function(ok){
    if(!ok){ cb(false); return; }
    waitFor(function(c){
      rid(function(r, d){
        if(!d || parseInt(d.programState, 10) === PROG_HOLIDAY){ c(false); return; }
        getJSON(URL_PROGRAM, function(x){ c(holidayEntries(x).length === 0); }, function(){ c(false); });
      });
    }, 10, cb);
  });
}
/* Vakantie via de eigen acties van de thermostaat (zoals het Toon-scherm): SetHoliday en GetHolidays/RemoveHoliday.
   De Toon onthoudt dan de stand van vóór de vakantie en zet die er na afloop weer terug (ook "programma uit"). */
function thermAct(name, q, cb){
  getJSON("/happ_thermstat?action=" + name + q, function(r){ cb(!!(r && r.result === "ok")); }, function(){ cb(false); });
}
function holOnHttp(start, end, temp, cb){
  var now = Math.floor(Date.now() / 1000);
  thermAct("SetHoliday", "&startTimeT=" + start + "&endTimeT=" + end + "&setpoint=" + temp, function(ok){
    if(!ok){ holOnCfg(start, end, temp, cb); return; }
    holVerifyOn(start, end, temp, now, function(ok2){ if(ok2) cb(true); else holOnCfg(start, end, temp, cb); });
  });
}
function holOffHttp(cb){
  getJSON("/happ_thermstat?action=GetHolidays", function(r){
    var list = (r && r.result === "ok" && Array.isArray(r.entry)) ? r.entry : null;
    if(!list || !list.length){ holOffCfg(cb); return; }
    var now = Math.floor(Date.now() / 1000), sp = currentSetpoint;
    var fail = function(){ holOffCfg(cb); };
    (function next(i){
      if(i >= list.length){
        waitFor(function(c){ rid(function(x, d){ c(!!d && parseInt(d.programState, 10) !== PROG_HOLIDAY); }); }, 25, function(ok){ if(ok) cb(true); else fail(); });
        return;
      }
      var e = list[i], id = String(first(e.entryId)), st = parseInt(first(e.startTimeT), 10), en = parseInt(first(e.endTimeT), 10);
      if(en <= now) next(i + 1);
      else if(st <= now) thermAct("SetHoliday", "&entryId=" + encodeURIComponent(id) + "&startTimeT=" + st + "&endTimeT=" + (now + 3) + "&setpoint=" + sp, function(ok){ if(ok) next(i + 1); else fail(); });
      else thermAct("RemoveHoliday", "&entryId=" + encodeURIComponent(id), function(ok){ if(ok) next(i + 1); else fail(); });
    })(0);
  }, function(){ holOffCfg(cb); });
}

/* ============================================================
   OPSLAAN / TERUGZETTEN
   ============================================================ */
function saveSlots(slots, done){
  var ents = entriesFromSlots(slots);
  if(!ents){ tell("Een weekprogramma heeft minstens twee blokken nodig. Pas het programma aan en probeer het opnieuw."); return; }
  busy("Programma opslaan op de Toon…");
  var finish = function(ok, msg){
    unbusy();
    if(ok){ toast("Programma opgeslagen"); if(done) done(); S.at = 0; load(true); }
    else tell("Opslaan mislukt: " + msg);
  };
  writeSlotsHttp(slots, function(ok, why){
    if(ok){ S.http = true; finish(true); return; }
    S.http = false; render();
    finish(false, why === "actief"
      ? "De Toon heeft het programma wel bewaard, maar nog niet in gebruik genomen. Herstart de Toon en probeer het opnieuw."
      : "Deze Toon neemt wijzigingen niet rechtstreeks aan. Wijzig het programma op de Toon zelf.");
  });
}
function localBackup(){                       // laatste back-up uit de telefoon die afwijkt van het huidige programma
  var l = backupsGet();
  for(var i = 0; i < l.length; i++){ var a = backupSlots(l[i]); if(a && !(S.model && S.model.ok && sameSlots(a, S.model.slots))) return a; }
  return null;
}
function askRestore(){
  ask("Het vorige programma terugzetten? Het huidige programma wordt eerst bewaard.", "Terugzetten", "Annuleren", function(){
    var done = function(ok, msg){
      unbusy();
      if(ok){ toast("Vorig programma teruggezet"); S.at = 0; load(true); }
      else tell("Terugzetten mislukt: " + msg);
    };
    var loc = localBackup();
    busy("Vorig programma terugzetten…");
    if(loc && S.http !== false){
      writeSlotsHttp(loc, function(ok){
        if(ok){ S.http = true; done(true); }
        else done(false, "De Toon nam het programma niet aan.");
      });
    } else done(false, "Er is geen eerder programma om terug te zetten.");
  });
}

/* ============================================================
   DAG KOPIËREN
   ============================================================ */
function openCopy(d){
  if(!canEditNow()) return;
  S.copy = { from: d, to: [] };
  openPage("programcopy");
  renderCopy();
}
function renderCopy(){
  var host = $("pc-body"); if(!host || !S.copy) return;
  var c = S.copy;
  var h = '<div class="pe-title">Kopieer ' + DAYFULL[c.from].toLowerCase() + ' naar…</div><div class="pc-days">';
  for(var d = 0; d < 7; d++){
    var cls = "pc-day" + (d === c.from ? " src" : (c.to.indexOf(d) >= 0 ? " on" : ""));
    h += '<button class="' + cls + '" data-d="' + d + '"' + (d === c.from ? " disabled" : "") + '>' + DAYS2[d] + '</button>';
  }
  h += '</div><div class="prg-note pc-hint">Kies de dagen die hetzelfde programma als ' + DAYFULL[c.from].toLowerCase() + ' moeten krijgen.</div>';
  host.innerHTML = h;
  host.querySelectorAll(".pc-day").forEach(function(b){
    b.addEventListener("click", function(){
      var d = parseInt(b.getAttribute("data-d"), 10), i = c.to.indexOf(d);
      if(i >= 0) c.to.splice(i, 1); else c.to.push(d);
      renderCopy();
    });
  });
  var sv = $("pc-save"); if(sv){ sv.disabled = !c.to.length; sv.classList.toggle("off", !c.to.length); }
}
function doCopy(){
  var c = S.copy; if(!c || !c.to.length) return;
  var slots = applyCopy(S.model.slots, sunIdx(c.from), c.to.map(sunIdx));
  saveSlots(slots, forceClosePage);
}

/* ============================================================
   LADEN
   ============================================================ */
function load(force){
  if(S.loading) return;
  if(!hasToon()){ render(); return; }
  S.loading = true;
  getJSON(URL_PROGRAM, function(d){
    S.loading = false;
    var r = parse(d);
    if(!r.entries.length && !(d && d.schedule)){ S.err = "onverwacht antwoord"; if(S.entries === null) render(); return; }
    S.entries = r.entries; S.other = r.other; S.err = ""; S.at = Date.now();
    S.model = slotsFromEntries(r.entries);
    render();
  }, function(err){
    S.loading = false; S.err = String(err);
    if(S.entries === null) render();
  });
}
function open(){
  S.sel = -1; load();
  if(S.timer) clearInterval(S.timer);
  S.timer = setInterval(function(){ if(!S.edit && !S.busy && Date.now() - S.at > 60000) load(); }, 30000);
  syncSwitch();
}
function close(){ if(S.timer){ clearInterval(S.timer); S.timer = null; } }
function syncSwitch(){
  var sw = $("prg-toggle"); if(!sw) return;
  var on = programState !== PROG_MANUAL;
  sw.classList.toggle("on", on);
  var l = $("prg-label"); if(l) l.textContent = on ? "Programma aan" : "Programma uit";
}

/* ============================================================
   VAKANTIESTAND (zoals in de originele app): de app gebruikt de eigen vakantie-acties van de thermostaat (SetHoliday, RemoveHoliday).
   Status komt uit getThermostatInfo: programState 4 = vakantie, currentSetpoint = vakantietemperatuur,
   nextTime = einde van de vakantie.
   ============================================================ */
var HOL = { start: 0, end: 0, temp: 1500, active: false, sel: false };
var MONTHS = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
var WDAYS = ["zo", "ma", "di", "wo", "do", "vr", "za"];
function fmtWhen(sec){
  var d = new Date(sec * 1000);
  return WDAYS[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()] + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}
function fmtT(v){ return (v / 100).toFixed(1).replace(".", ",") + "°"; }
function inputVal(sec){
  var d = new Date(sec * 1000);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
}
function holActive(){ return programState === PROG_HOLIDAY; }
function holEnd(){ var t = window.lastTherm; return t ? parseInt(t.nextTime, 10) || 0 : 0; }

function holSync(){
  var b = $("hol-banner");
  if(b){
    var on = holActive();
    b.classList.toggle("show", on);
    if(on){ var e = holEnd(); $("hol-banner-txt").textContent = "Vakantiestand" + (e ? " tot " + fmtWhen(e) : "") + " · " + fmtT(currentSetpoint); }
  }
  if($("page-holiday") && $("page-holiday").classList.contains("open") && !S.busy) holRender();
}

function holRender(){
  var h = $("hol-body"); if(!h) return;
  if(!hasToon()){ h.innerHTML = '<div class="empty">Geen Toon-adres ingesteld (Meer › Instellingen).</div>'; return; }
  var can = S.http !== false;
  var warn = !can ? '<div class="hol-note warn">Deze Toon neemt de vakantiestand niet rechtstreeks aan. Stel hem in op de Toon zelf.</div>' : "";
  if(holActive()){
    var e = holEnd();
    h.innerHTML = '<div class="hol-card"><div class="hol-big">Vakantiestand aan</div>' +
      '<div class="hol-line">Temperatuur <b>' + fmtT(currentSetpoint) + '</b></div>' +
      (e ? '<div class="hol-line">Tot <b>' + esc(fmtWhen(e)) + '</b></div>' : "") +
      '<div class="hol-note">Daarna gaat de Toon weer verder met het weekprogramma.</div></div>' + warn +
      '<button class="primary-btn" id="hol-off"' + (can ? "" : " disabled") + '>Vakantiestand uitzetten</button>';
    $("hol-off").addEventListener("click", holOff);
    return;
  }
  var now = Math.floor(Date.now() / 1000);
  if(!HOL.sel){ HOL.start = now; HOL.end = now + 7 * 86400; HOL.temp = 1500; HOL.sel = true; }
  h.innerHTML = '<div class="hol-card">' +
    '<label class="hol-lbl">Van</label><input type="datetime-local" id="hol-start" value="' + inputVal(HOL.start) + '">' +
    '<label class="hol-lbl">Tot</label><input type="datetime-local" id="hol-end" value="' + inputVal(HOL.end) + '">' +
    '<label class="hol-lbl">Temperatuur</label>' +
    '<div class="hol-temp"><button class="rbtn" id="hol-min" aria-label="Kouder">−</button><span id="hol-t">' + fmtT(HOL.temp) + '</span><button class="rbtn" id="hol-plus" aria-label="Warmer">+</button></div>' +
    '<div class="hol-note">Tijdens de vakantiestand houdt de Toon deze temperatuur aan en negeert het weekprogramma.</div></div>' + warn +
    '<button class="primary-btn" id="hol-on"' + (can ? "" : " disabled") + '>Vakantiestand aanzetten</button>';
  $("hol-start").addEventListener("change", function(){ var t = Date.parse(this.value); if(!isNaN(t)) HOL.start = Math.floor(t / 1000); });
  $("hol-end").addEventListener("change", function(){ var t = Date.parse(this.value); if(!isNaN(t)) HOL.end = Math.floor(t / 1000); });
  $("hol-min").addEventListener("click", function(){ HOL.temp = Math.max(600, HOL.temp - 50); $("hol-t").textContent = fmtT(HOL.temp); });
  $("hol-plus").addEventListener("click", function(){ HOL.temp = Math.min(3000, HOL.temp + 50); $("hol-t").textContent = fmtT(HOL.temp); });
  $("hol-on").addEventListener("click", holOn);
}

function holRefresh(){ if(typeof getThermostatInfo === "function") getThermostatInfo(); }
function holAfter(ok, msg){
  unbusy();
  if(!ok){ tell(msg || "Dat is niet gelukt."); return; }
  var tries = 0;
  (function wait(){                        // wacht tot de thermostaat de nieuwe stand meldt
    holRefresh();
    setTimeout(function(){ holSync(); }, 900);
    if(++tries < 4) setTimeout(wait, 1200);
  })();
  toast(msg || "Gelukt");
}
function holVia(httpFn, okMsg, after){
  httpFn(function(ok){
    if(ok){ S.http = true; after(true, okMsg); }
    else { S.http = false; after(false, "Deze Toon neemt dit niet rechtstreeks aan. Stel de vakantiestand in op de Toon zelf."); }
  });
}
function holOn(){
  var now = Math.floor(Date.now() / 1000);
  var st = HOL.start <= now ? now - 5 : HOL.start, en = HOL.end, tp = HOL.temp;
  if(en <= now + 60 || en <= st){ tell("De einddatum moet in de toekomst liggen, na de begindatum."); return; }
  var run = function(){
    busy("Vakantiestand instellen…");
    holVia(function(cb){ holOnHttp(st, en, tp, cb); }, "Vakantiestand ingesteld", function(ok, msg){ HOL.sel = false; holAfter(ok, msg); });
  };
  if(st > now + 60) run();
  else ask("Vakantiestand aanzetten tot " + fmtWhen(en) + " op " + fmtT(tp) + "?", "Aanzetten", "Annuleren", run);
}
function holOff(){
  busy("Vakantiestand uitzetten…");
  holVia(holOffHttp, "Vakantiestand uitgezet", holAfter);
}
function holOpen(){ HOL.sel = false; holRender(); setTimeout(holRender, 1200); }
window.HOL = { open: holOpen, sync: holSync, render: holRender };

window.PRG = { open: open, close: close, load: load, render: render, parse: parse, sync: syncSwitch, state: S,
               guardClose: guardClose, editClosed: editClosed,
               model: { slotsFromEntries: slotsFromEntries, runsOf: runsOf, entriesFromSlots: entriesFromSlots, payloadOf: payloadOf,
                        dayBlocksOf: dayBlocksOf, carryStart: carryStart, plusPositions: plusPositions, addDefaults: addDefaults, placeStart: placeStart, canAdd: canAdd, applyEdit: applyEdit,
                        applyAdd: applyAdd, applyDelete: applyDelete, applyCopy: applyCopy, MAXPERDAY: MAXPERDAY, MINSLOTS: MINSLOTS } };
document.addEventListener("DOMContentLoaded", function(){
  var bo = $("hol-banner-off"); if(bo) bo.addEventListener("click", function(){ ask("Vakantiestand uitzetten?", "Uitzetten", "Annuleren", holOff); });
  var sw = $("prg-toggle");
  if(sw) sw.addEventListener("click", function(){ toggleProgram(); setTimeout(syncSwitch, 50); });
  var sv = $("pe-save"); if(sv) sv.addEventListener("click", function(){ if(S.edit && dirtyEdit()) saveSlots(S.edit.slots, forceClosePage); });
  var ca = $("pe-cancel"); if(ca) ca.addEventListener("click", function(){ closePage(); });
  var cs = $("pc-save"); if(cs) cs.addEventListener("click", doCopy);
  var cc = $("pc-cancel"); if(cc) cc.addEventListener("click", function(){ closePage(); });
});
})();

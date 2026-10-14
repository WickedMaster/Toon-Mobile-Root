/* ============================================================
   p1.js - gegevens rechtstreeks van de Toon (P1-module), zonder Home Assistant
   Bronnen (zoals in de originele Toon-app en ToonSoftwareCollective/mobile):
   - /happ_pwrusage?action=GetCurrentUsage
       powerUsage.value (W nu), avgValue, dayUsage + dayLowUsage (Wh vandaag), avgDayValue,
       valueSolar (W zon nu), solarProducedToday (Wh zon vandaag), powerProduction.value
   - /hcb_rrd?action=getRrdData&loggerName=...   (historie)
       elec_flow / elec_solar_flow / elec_produ_flow      (5min, Watt)
       elec_quantity_nt + _lt, elec_solar_quantity,
       elec_quantity_nt_produ + _lt_produ                 (5yrhours / 10yrdays, tellerstand in Wh)
   - gasUsage.dayUsage / avgDayValue (liters)             (gas, alleen als er gas is)
   - /hcb_rrd: gas_quantity (5yrhours / 10yrdays, tellerstand in liters), gas_flow (5min)
   - /hdrv_zwave?action=getDevices.json                  (slimme stekkers)
   ============================================================ */
(function(){
"use strict";

var URL_USAGE = "/happ_pwrusage?action=GetCurrentUsage";
var URL_PLUGS = "/hdrv_zwave?action=getDevices.json";
var DAY = 86400000;

function num(v){
  if(v === null || v === undefined || v === "") return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}
function startOfDay(ts){ var d = new Date(ts); d.setHours(0,0,0,0); return d.getTime(); }

var P = {
  cur: { power:null, avgPower:null, solar:null, dayCons:null, dayLow:null, avgDay:null, solarToday:null, prodNow:null,
         gasDay:null, gasAvg:null, gasNow:null, hasGasObj:false, ok:false, at:0 },
  hasSolar: null,          // null = nog niet bepaald
  solarWhy: "",
  hasGas: null, gasWhy: "", gasDetectAt: 0,
  solarLogger: null,       // true: elec_solar_* bestaat; false: terugval op teruglevering (produ)
  raw: null,
  fb: { cons:null, solar:null, solarNow:null, gas:null, at:0, nowAt:0 },
  onUpdate: null, onSolar: null, onGas: null,
  timer: null, detectAt: 0, lastErr: ""
};

/* ---------- hcb_rrd ---------- */
var rrdCache = {};
function rrd(logger, rra, from, to, cb, ttl){
  var key = logger + "|" + rra + "|" + Math.floor(from/60000) + "|" + Math.floor(to/60000);
  var c = rrdCache[key];
  if(ttl && c && Date.now() - c.at < ttl) return cb(null, c.pts);
  var path = "/hcb_rrd?action=getRrdData&loggerName=" + logger + "&rra=" + rra +
             "&readableTime=0&nullForNaN=1&from=" + Math.floor(from/1000) + "&to=" + Math.floor(to/1000);
  getText(path, function(status, text){
    if(status !== 200) return cb(status || "net");
    var d;
    try{ d = JSON.parse(text); }catch(e){ return cb("json"); }
    var pts = [];
    if(d && typeof d === "object"){
      for(var k in d){
        var v = d[k];
        if(v === null || v === undefined || v === -1 || v === "null") continue;
        v = Number(v); if(!isFinite(v)) continue;
        var t = Number(k);
        if(!isFinite(t)){ t = Date.parse(k); if(isNaN(t)) continue; }
        else if(t < 1e11) t *= 1000;
        pts.push({ t:t, v:v });
      }
    }
    pts.sort(function(a,b){ return a.t - b.t; });
    if(ttl) rrdCache[key] = { at:Date.now(), pts:pts };
    cb(null, pts);
  });
}

/* ---------- actuele waarden ---------- */
function parseUsage(d){
  var pu = (d && d.powerUsage) || {}, pp = (d && d.powerProduction) || {}, c = P.cur;
  c.power = num(pu.value);
  c.avgPower = num(pu.avgValue);
  c.dayCons = num(pu.dayUsage);
  c.dayLow = num(pu.dayLowUsage);
  c.avgDay = num(pu.avgDayValue);
  c.solarToday = num(pu.solarProducedToday);
  var vs = num(pu.valueSolar), pv = num(pp.value);
  c.prodNow = (vs !== null) ? vs : pv;
  c.solar = c.prodNow;
  var gu = d && d.gasUsage;
  c.hasGasObj = !!(gu && typeof gu === "object");
  c.gasDay = gu ? num(gu.dayUsage) : null;
  c.gasAvg = gu ? num(gu.avgDayValue) : null;
  c.gasNow = gu ? num(gu.value) : null;
  c.ok = (c.power !== null);
  c.at = Date.now();
}
function poll(){
  if(P.timer) clearTimeout(P.timer);
  if(!hasToon()){ P.timer = setTimeout(poll, REFRESH_MS); return; }
  getJSON(URL_USAGE, function(d){
    P.raw = d;
    if(d && (d.result === "ok" || d.powerUsage)){ parseUsage(d); P.lastErr = ""; }
    else { P.cur.ok = false; P.lastErr = "onverwacht antwoord"; }
    afterPoll();
  }, function(err){
    P.cur.ok = false; P.lastErr = String(err);
    afterPoll();
  });
  P.timer = setTimeout(poll, REFRESH_MS);
}
function afterPoll(){
  if(P.hasSolar === null || Date.now() - P.detectAt > 30*60000) detectSolar();
  else if(P.hasSolar === false && P.cur.solar !== null && P.cur.solar > 0 && (CFG.solarMode || "auto") === "auto") setSolar(true, "meterwaarde groter dan 0");
  if(P.hasGas === null || Date.now() - P.gasDetectAt > 30*60000) detectGas();
  else if(P.hasGas === false && (CFG.gasMode || "auto") === "auto" && (P.cur.gasDay !== null || (P.cur.gasNow !== null && P.cur.gasNow > 0))) setGas(true, "waarde in GetCurrentUsage (gasUsage)");
  fallbackToday();
  if(P.onUpdate) P.onUpdate();
}

/* ---------- zonnepanelen aanwezig? ---------- */
function setSolar(v, why){
  var changed = (P.hasSolar !== v);
  P.hasSolar = v; P.solarWhy = why; P.fb.at = 0; P.fb.nowAt = 0;
  try{ prefSet("p1solar", JSON.stringify({ v:v, why:why })); }catch(e){}
  if(v) setTimeout(fallbackToday, 0);
  if(changed && P.onSolar) P.onSolar();
}
function detectSolar(){
  P.detectAt = Date.now();
  var mode = CFG.solarMode || "auto";
  if(mode === "ja"){ P.solarLogger = true; return setSolar(true, "handmatig ingesteld"); }
  if(mode === "nee"){ return setSolar(false, "handmatig uitgezet"); }
  if(!hasToon()) return;
  var now = Date.now();
  // 1. solar-teller in de Toon (meest betrouwbaar, ook 's nachts)
  rrd("elec_solar_quantity", "5yrhours", now - 3*DAY, now, function(err, pts){
    if(!err && pts.length){ P.solarLogger = true; return setSolar(true, "zonnemeter in de Toon (elec_solar_quantity)"); }
    // 2. solar-flow
    rrd("elec_solar_flow", "5min", now - 2*DAY, now, function(err2, pts2){
      if(!err2 && pts2.length){ P.solarLogger = true; return setSolar(true, "zonnemeter in de Toon (elec_solar_flow)"); }
      P.solarLogger = false;
      var c = P.cur;
      if(c.solar !== null && (c.solar > 0 || (c.solarToday !== null && c.solarToday > 0)))
        return setSolar(true, "waarde in GetCurrentUsage (" + (P.raw && P.raw.powerUsage && num(P.raw.powerUsage.valueSolar) !== null ? "valueSolar" : "powerProduction") + ")");
      // 3. bekende eerdere detectie niet overschrijven door een nacht met 0 W
      if(P.hasSolar === true && P.solarWhy.indexOf("handmatig") < 0) return;
      setSolar(false, "geen zonnemeter gevonden");
    }, 0);
  }, 0);
}

/* ---------- gas aanwezig? ----------
   Drie onafhankelijke aanwijzingen, van sterk naar zwak:
   1. GetCurrentUsage bevat gasUsage met een getal (bij geen gasmeter is het null)
   2. de teller gas_quantity in de Toon heeft recente, niet-lege waarden
   3. gas_flow (5 minuten) heeft recente, niet-lege waarden
   Een gevonden 'ja' wordt onthouden en niet teruggedraaid door een tijdelijke storing. */
function setGas(v, why){
  var changed = (P.hasGas !== v);
  P.hasGas = v; P.gasWhy = why; P.fb.at = 0;
  try{ prefSet("p1gas", JSON.stringify({ v:v, why:why })); }catch(e){}
  if(v) setTimeout(fallbackToday, 0);
  if(changed && P.onGas) P.onGas();
}
function detectGas(){
  P.gasDetectAt = Date.now();
  var mode = CFG.gasMode || "auto";
  if(mode === "ja") return setGas(true, "handmatig ingesteld");
  if(mode === "nee") return setGas(false, "handmatig uitgezet");
  if(!hasToon()) return;
  var c = P.cur;
  if(c.ok && c.hasGasObj && (c.gasDay !== null || (c.gasNow !== null && c.gasNow > 0)))
    return setGas(true, "gasmeter in GetCurrentUsage");
  var now = Date.now();
  rrd("gas_quantity", "5yrhours", now - 4*DAY, now, function(err, pts){
    var max = 0; if(!err) pts.forEach(function(p){ if(p.v > max) max = p.v; });
    if(!err && pts.length && max > 0) return setGas(true, "gasteller in de Toon (gas_quantity)");
    rrd("gas_flow", "5min", now - 2*DAY, now, function(err2, pts2){
      if(!err2 && pts2.length) return setGas(true, "gasmeter in de Toon (gas_flow)");
      if(P.hasGas === true && P.gasWhy.indexOf("handmatig") < 0) return;   // eerder gevonden: niet terugdraaien
      if(err && err2) return;                                                  // Toon niet bereikbaar: niets concluderen
      setGas(false, "geen gasmeter gevonden");
    }, 0);
  }, 0);
}

/* ---------- 'vandaag' uit de tellers als GetCurrentUsage het niet geeft ---------- */
/* Net als tsctoonmobile: teller op dit moment min teller van gisteren 23:00 (5yrhours, nieuwste punt) */
function yesterday23(){ var d = new Date(); d.setDate(d.getDate()-1); d.setHours(23,0,0,0); return d.getTime(); }
/* een dagtotaal is nooit negatief: vlak na het koppelen van de meetmodule bestaan de tellers nog niet (beginwaarde 0) en komt er onzin uit */
function sane(v){ return (typeof v === "number" && isFinite(v) && v >= 0) ? v : null; }
function todayDelta(logger, cb){
  rrd(logger, "5yrhours", yesterday23(), Date.now(), function(err, pts){
    if(err || !pts.length) return cb(null);
    cb(sane(pts[pts.length-1].v - pts[0].v));
  }, 4000);
}
/* zon vandaag: nieuwste teller min teller om 00:00 vandaag (uurwaarden; 's nachts is er geen opwek, dus de uurgrens maakt niet uit).
   De eindstand van gisteren uit 10yrdays is onbetrouwbaar: soms bevat die reeks nog geen punt voor vandaag, waardoor gisteren meetelt. */
function solarTodayCounter(logger, cb){
  var now = Date.now(), mid = new Date(now); mid.setHours(0,0,0,0); mid = mid.getTime();
  rrd(logger, "5yrhours", mid - 6*3600000, now, function(err, h){
    if(err || !h.length) return cb(null);
    var base = null;
    for(var i=0;i<h.length;i++){ if(h[i].t <= mid) base = h[i]; }
    if(!base) base = h[0];
    cb(Math.max(0, h[h.length-1].v - base.v));
  }, 4000);
}
function fallbackSolarNow(){
  var c = P.cur, now = Date.now();
  if(!P.hasSolar || c.solar !== null){ P.fb.solarNow = null; return; }
  if(now - P.fb.nowAt < 20000) return;
  P.fb.nowAt = now;
  var logger = P.solarLogger === false ? "elec_produ_flow" : "elec_solar_flow";
  rrd(logger, "5min", now - 30*60000, now, function(err, pts){
    if(err || !pts.length) return;
    P.fb.solarNow = Math.max(0, pts[pts.length-1].v);
    if(P.onUpdate) P.onUpdate();
  }, 15000);
}
function fallbackToday(){
  fallbackSolarNow();
  var c = P.cur, now = Date.now();
  if(now - P.fb.at < 8000) return;
  var needCons = true, needSolar = !!P.hasSolar, needGas = !!P.hasGas;
  if(!needCons && !needSolar && !needGas) return;
  P.fb.at = now;
  if(needCons) todayDelta("elec_quantity_nt", function(a){
    todayDelta("elec_quantity_lt", function(b){
      P.fb.cons = (a === null && b === null) ? null : (a || 0) + (b || 0);
      if(P.onUpdate) P.onUpdate();
    });
  });
  if(needGas) todayDelta("gas_quantity", function(a){ P.fb.gas = a; if(P.onUpdate) P.onUpdate(); });
  if(needSolar){
    var lg = P.solarLogger === false ? ["elec_quantity_nt_produ","elec_quantity_lt_produ"] : ["elec_solar_quantity"];
    (lg.length === 1 ? solarTodayCounter : todayDelta)(lg[0], function(a){
      if(lg.length === 1){ P.fb.solar = a; if(P.onUpdate) P.onUpdate(); return; }
      todayDelta(lg[1], function(b){ P.fb.solar = (a === null && b === null) ? null : (a || 0) + (b || 0); if(P.onUpdate) P.onUpdate(); });
    });
  }
}
/* Wh vandaag (bron: GetCurrentUsage, anders de tellers) */
function consTodayWh(){
  var c = P.cur;
  if(sane(P.fb.cons) !== null) return P.fb.cons;
  return c.dayCons !== null ? sane(c.dayCons + (c.dayLow || 0)) : null;
}
/* gas vandaag in liters */
function gasTodayL(){
  var c = P.cur;
  return sane(P.fb.gas) !== null ? P.fb.gas : sane(c.gasDay);
}
function solarNowW(){
  var c = P.cur;
  return c.solar !== null ? c.solar : P.fb.solarNow;
}
function solarTodayWh(){
  var c = P.cur;
  if(sane(P.fb.solar) !== null) return P.fb.solar;
  return sane(c.solarToday);
}

/* ---------- grafiekdata ---------- */
function flowLogger(series){
  if(series === "consumption") return "elec_flow";
  return (P.solarLogger === false) ? "elec_produ_flow" : "elec_solar_flow";
}
function flow(series, from, to, cb){
  rrd(flowLogger(series), "5min", from, to, function(err, pts){
    if(err) return cb(err);
    cb(null, pts.map(function(p){ return { timestamp:p.t, value:Math.max(0, p.v), unit:"W" }; }));
  }, 25000);
}
function gasHours(from, to, cb){
  rrd("gas_quantity", "5yrhours", from - 3600000, to, function(err, pts){
    if(err) return cb(err);
    var rows = [];
    for(var i=1;i<pts.length;i++){
      var d = pts[i].v - pts[i-1].v;
      if(!(d >= 0) || d > 1e7) continue;
      var h0 = Math.floor(pts[i-1].t / 3600000) * 3600000;
      var gap = Math.max(1, Math.round((pts[i].t - pts[i-1].t) / 3600000));
      for(var g=0; g<gap; g++){
        var ts = h0 + g*3600000;
        if(ts >= from && ts <= to) rows.push({ timestamp:ts, value:d/gap, unit:"l" });
      }
    }
    cb(null, rows);
  }, 25000);
}
function sumCounters(a, b){
  if(!b.length) return a;
  if(!a.length) return b;
  var ev = [], i;
  for(i=0;i<a.length;i++) ev.push({ t:a[i].t, v:a[i].v, w:0 });
  for(i=0;i<b.length;i++) ev.push({ t:b[i].t, v:b[i].v, w:1 });
  ev.sort(function(x,y){ return x.t - y.t; });
  var last = [null,null], out = [];
  ev.forEach(function(e){
    last[e.w] = e.v;
    if(last[0] !== null && last[1] !== null){
      var s = last[0] + last[1];
      if(out.length && out[out.length-1].t === e.t) out[out.length-1].v = s; else out.push({ t:e.t, v:s });
    }
  });
  return out;
}
function counters(series, cb){
  var now = Date.now(), from = now - 10*365*DAY + DAY, to = now + DAY;
  var names = (series === "gas") ? ["gas_quantity"]
            : (series === "consumption") ? ["elec_quantity_nt","elec_quantity_lt"]
            : (P.solarLogger === false ? ["elec_quantity_nt_produ","elec_quantity_lt_produ"] : ["elec_solar_quantity"]);
  rrd(names[0], "10yrdays", from, to, function(e1, a){
    if(names.length === 1) return cb(e1, a || []);
    rrd(names[1], "10yrdays", from, to, function(e2, b){
      if(e1 && e2) return cb(e1);
      cb(null, sumCounters(a || [], b || []));
    }, 600000);
  }, 600000);
}
/* dagwaarden in Wh: verschil tussen opeenvolgende tellerstanden, toegewezen aan de dag van de eerdere stand */
function daily(series, cb){
  counters(series, function(err, pts){
    if(err) return cb(err);
    var shift = parseInt(CFG.dayShift) || 0, days = {}, i;
    for(i=1;i<pts.length;i++){
      var d = pts[i].v - pts[i-1].v;
      if(!(d >= 0) || d > 1e9) continue;                 // reset of onzin
      var gap = Math.max(1, Math.round((pts[i].t - pts[i-1].t) / DAY));
      var d0 = startOfDay(pts[i-1].t);
      for(var g=0; g<gap; g++){                           // gaten gelijk verdelen
        var ts = startOfDay(d0 + g*DAY + 12*3600000) + shift*DAY;
        days[ts] = (days[ts] || 0) + d / gap;
      }
    }
    var nat = (series === "gas") ? gasTodayL() : (series === "consumption") ? consTodayWh() : solarTodayWh();
    var today = startOfDay(Date.now());
    if(nat !== null && nat !== undefined) days[today] = nat;   // vandaag = de live waarde van de Toon
    var unitName = (series === "gas") ? "l" : "Wh";
    var rows = Object.keys(days).map(function(k){ return { timestamp:Number(k), value:days[k], unit:unitName }; })
                     .sort(function(a,b){ return a.timestamp - b.timestamp; });
    cb(null, rows);
  });
}

/* ---------- slimme stekkers ---------- */
var PLUG_TYPES = ["FGWPF102","ZMNHYD1","FGWP011","NAS_WR01Z","NAS_WR01ZE","NAS_WR02ZE","EMPOWER","EM6550_v1"];
function plugs(cb){
  getJSON(URL_PLUGS, function(d){
    var list = [];
    for(var k in d){
      if(k === "dev_settings_device") continue;
      var x = d[k];
      if(!x || typeof x !== "object" || !x.uuid) continue;
      // Echte schakelaar? De Toon meldt per apparaat de ondersteunde Z-Wave-commandoklassen (supportedCC):
      // 25 = schakelaar (aan/uit), 26 = dimmer. Meters (HAE_METER_*, slimme meters) hebben die niet en vallen af.
      var cc = String(x.supportedCC || x.ccList || "").toLowerCase().split(/\s+/).filter(Boolean);
      var isPlug;
      if(/^HAE_METER/i.test(String(x.type || "")) || /^HAE_METER/i.test(String(x.name || ""))) isPlug = false;
      else if(cc.length) isPlug = (cc.indexOf("25") >= 0 || cc.indexOf("26") >= 0);
      else isPlug = PLUG_TYPES.indexOf(x.type) >= 0 || (x.CurrentElectricityFlow !== undefined && (x.TargetStatus !== undefined || x.CurrentState !== undefined));
      if(!isPlug) continue;
      // TargetStatus -1 zonder CurrentState/vermogen = de Toon heeft nog nooit een antwoord van de stekker gekregen (stekker uit/buiten bereik)
      var watt = num(x.CurrentElectricityFlow);
      var unknown = String(x.TargetStatus) === "-1" && (x.CurrentState === undefined || String(x.CurrentState) === "-1") && !(typeof watt === "number" && isFinite(watt));
      list.push({ uuid:x.uuid, name:x.name || x.type || "Stekker", connected:String(x.IsConnected) === "1" && !unknown, unknown:unknown,
                  on:(String(x.TargetStatus) === "1" || String(x.CurrentState) === "1"),
                  watt:watt, type:x.type });
    }
    cb(null, list);
  }, function(err){ cb(err || "net"); });
}
/* eenmalig de stand van een stekker opvragen (stekkers zonder bekende stand); daarna leest de gewone verversing het antwoord */
function plugProbe(uuid){
  getJSON("/hdrv_zwave?action=GetBasic&waitForReponse=0&timeout=120&&uuid=" + encodeURIComponent(uuid), function(){}, function(){});
}
function plugSet(uuid, on, cb){
  getJSON("/hdrv_zwave?action=basicCommand&uuid=" + encodeURIComponent(uuid) + "&state=" + (on ? 1 : 0), function(){
    setTimeout(function(){
      getJSON("/hdrv_zwave?action=GetBasic&waitForReponse=0&timeout=120&&uuid=" + encodeURIComponent(uuid), function(){ if(cb) cb(); }, function(){ if(cb) cb(); });
    }, 1000);
  }, function(){ if(cb) cb(); });
}

/* ---------- gegevenscontrole (voor als getallen niet kloppen) ---------- */
function fmtT(t){ var d = new Date(t); function z(n){ return ("0"+n).slice(-2); } return d.getFullYear()+"-"+z(d.getMonth()+1)+"-"+z(d.getDate())+" "+z(d.getHours())+":"+z(d.getMinutes()); }
function diagnose(cb){
  var out = [], now = Date.now();
  out.push("Toon gegevenscontrole  " + fmtT(now));
  out.push("Toon: " + (CFG.proto||"http") + "://" + CFG.host + (CFG.port ? ":" + CFG.port : ""));
  out.push("");
  out.push("GetCurrentUsage: " + (P.cur.ok ? "ok" : "geen geldig antwoord (" + P.lastErr + ")"));
  try{
    var r = P.raw || {}, pu = r.powerUsage || {};
    out.push("  powerUsage-sleutels: " + Object.keys(pu).join(", "));
    ["value","avgValue","dayUsage","dayLowUsage","avgDayValue","valueSolar","solarProducedToday","valueProduced"].forEach(function(k){ if(pu[k] !== undefined) out.push("  " + k + " = " + pu[k]); });
    if(r.powerProduction) out.push("  powerProduction = " + JSON.stringify(r.powerProduction));
    if(r.gasUsage !== undefined) out.push("  gasUsage = " + JSON.stringify(r.gasUsage));
    out.push("  andere onderdelen: " + Object.keys(r).filter(function(k){ return k !== "powerUsage" && k !== "powerProduction" && k !== "gasUsage"; }).join(", "));
  }catch(e){}
  out.push("");
  out.push("Zonnepanelen: " + (P.hasSolar === null ? "onbekend" : (P.hasSolar ? "ja" : "nee")) + " (" + P.solarWhy + ")");
  out.push("Gas: " + (P.hasGas === null ? "onbekend" : (P.hasGas ? "ja" : "nee")) + " (" + P.gasWhy + ")");
  out.push("Vandaag verbruik: " + (consTodayWh() === null ? "–" : Math.round(consTodayWh()) + " Wh") + "   opwek: " + (solarTodayWh() === null ? "–" : Math.round(solarTodayWh()) + " Wh") + "   gas: " + (gasTodayL() === null ? "–" : Math.round(gasTodayL()) + " l"));
  out.push("");
  var probes = [
    ["elec_flow","5min", 3*3600000], ["elec_quantity_nt","5yrhours", 26*3600000], ["elec_quantity_lt","5yrhours", 26*3600000],
    ["elec_quantity_nt","10yrdays", 10*DAY], ["elec_quantity_lt","10yrdays", 10*DAY],
    ["elec_solar_flow","5min", 3*3600000], ["elec_solar_quantity","5yrhours", 26*3600000], ["elec_solar_quantity","10yrdays", 10*DAY],
    ["elec_produ_flow","5min", 3*3600000], ["elec_quantity_nt_produ","10yrdays", 10*DAY], ["elec_quantity_lt_produ","10yrdays", 10*DAY],
    ["gas_flow","5min", 3*3600000], ["gas_quantity","5yrhours", 26*3600000], ["gas_quantity","10yrdays", 10*DAY]
  ];
  var i = 0;
  (function next(){
    if(i >= probes.length){ out.push(""); out.push("Sla deze tekst op of stuur hem door als de getallen niet kloppen."); return cb(out.join("\n")); }
    var p = probes[i++];
    rrd(p[0], p[1], now - p[2], now, function(err, pts){
      if(err) out.push(p[0] + " (" + p[1] + "): fout " + err);
      else if(!pts.length) out.push(p[0] + " (" + p[1] + "): geen gegevens");
      else out.push(p[0] + " (" + p[1] + "): " + pts.length + " punten, " + fmtT(pts[0].t) + " = " + Math.round(pts[0].v) + "  ...  " + fmtT(pts[pts.length-1].t) + " = " + Math.round(pts[pts.length-1].v));
      next();
    });
  })();
}

function start(){
  try{
    var s = JSON.parse(prefGet("p1solar") || "null");
    if(s && typeof s.v === "boolean" && P.hasSolar === null){ P.hasSolar = s.v; P.solarWhy = (s.why || "") + " (eerder vastgesteld)"; if(P.onSolar) P.onSolar(); }
  }catch(e){}
  try{
    var g = JSON.parse(prefGet("p1gas") || "null");
    if(g && typeof g.v === "boolean" && P.hasGas === null){ P.hasGas = g.v; P.gasWhy = (g.why || "") + " (eerder vastgesteld)"; if(P.onGas) P.onGas(); }
  }catch(e){}
  poll();
}
function restart(){
  P.hasSolar = null; P.detectAt = 0; P.hasGas = null; P.gasDetectAt = 0; rrdCache = {};
  P.fb = { cons:null, solar:null, solarNow:null, gas:null, at:0, nowAt:0 };
  if(CFG.solarMode === "ja" || CFG.solarMode === "nee"){ detectSolar(); }
  if(CFG.gasMode === "ja" || CFG.gasMode === "nee"){ detectGas(); }
  poll();
}

window.P1 = {
  state: P, start: start, restart: restart, poll: poll,
  consTodayWh: consTodayWh, solarTodayWh: solarTodayWh, solarNowW: solarNowW, gasTodayL: gasTodayL, gasHours: gasHours,
  clear: function(){ rrdCache = {}; P.fb.at = 0; }, flow: flow, daily: daily, plugs: plugs, plugSet: plugSet, plugProbe: plugProbe, diagnose: diagnose, rrd: rrd
};
})();

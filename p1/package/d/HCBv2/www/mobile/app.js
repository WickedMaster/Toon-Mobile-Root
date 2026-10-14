/* ============================================================
   Toon P1 - mobiele interface (rechtstreeks met de Toon, zonder Home Assistant)
   - Thermostaat: /happ_thermstat
   - Energie nu/vandaag: /happ_pwrusage (GetCurrentUsage), historie: /hcb_rrd
   - Slimme stekkers: /hdrv_zwave
   ============================================================ */

'use strict';

/* ---------- Local Toon service endpoints ---------- */
var THERMOSTAT_INFO_URL   = "/happ_thermstat?action=getThermostatInfo";
var THERMOSTAT_STATES_URL = "/hcb_config?action=getObjectConfigTree&package=happ_thermstat&internalAddress=thermostatStates";
var THERMOSTAT_CHANGE_SS  = "/happ_thermstat?action=changeSchemeState";
var SET_TARGET_TEMP = function(sp){ return "/happ_thermstat?action=roomSetpoint&Setpoint=" + sp; };

var REFRESH_MS = 5000;
var NATIVE = (typeof Android !== "undefined" && Android && Android.http) ? true : false;
var _cbs = {}, _cbId = 0;
window.__nativeCb = function(id, status, text){
  var cb = _cbs[id]; delete _cbs[id];
  if(cb) cb(status, text);
};

/* generic request: cb(status, text). status 0 = network error/timeout */
function req(method, url, headers, body, cb){
  headers = headers || {};
  if(NATIVE){
    var id = ++_cbId; _cbs[id] = cb;
    Android.http(id, method, url, JSON.stringify(headers), body || "");
    return;
  }
  var x = new XMLHttpRequest();
  x.open(method, url, true);
  x.timeout = 20000;
  for(var k in headers) x.setRequestHeader(k, headers[k]);
  x.onreadystatechange = function(){ if(x.readyState===4) cb(x.status, x.responseText); };
  x.ontimeout = function(){ cb(0, "timeout"); };
  x.send(body || null);
}

/* ---------- Settings (opgeslagen in de app, te wijzigen onder Meer > Instellingen) ---------- */
var CFG = { proto:"http", host:"", port:"", hdrKey:"Api-Key", hdrVal:"", cfId:"", theme:"auto",
            solarMode:"auto", gasMode:"auto", dayShift:"0",
            scaleW:"2500", scaleDayCons:"18", scaleGas:"5", priceCons:"", priceProd:"", priceGas:"" };
function prefGet(k){
  try{ return NATIVE ? Android.getPref(k) : (localStorage.getItem(k)||""); }catch(e){ return ""; }
}
function prefSet(k, v){
  try{ if(NATIVE) Android.setPref(k, v); else localStorage.setItem(k, v); }catch(e){}
}
function loadCfg(){
  try{
    var s = prefGet("cfg");
    if(s){ var o = JSON.parse(s); for(var k in o) CFG[k] = o[k]; }
  }catch(e){}
  loadSecret();
}
function saveCfg(){ prefSet("cfg", JSON.stringify(CFG)); }

/* ---------- Thema: Automatisch (volgt de telefoon) / Licht / Donker ---------- */
function systemDark(){
  try{ if(NATIVE && Android.isSystemDark) return !!Android.isSystemDark(); }catch(e){}
  return !!(window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
}
function applyTheme(){
  var t = CFG.theme || "auto", dark = (t === "dark") || (t === "auto" && systemDark());
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  var m = document.querySelector('meta[name="theme-color"]'); if(m) m.setAttribute("content", dark ? "#16191d" : "#ffffff");
  try{ if(NATIVE && Android.setChrome) Android.setChrome(dark ? "#000000" : "#0a0e1a"); }catch(e){}
}
window.onSystemTheme = function(){ if((CFG.theme || "auto") === "auto") applyTheme(); };
try{
  if(window.matchMedia){
    var _mq = matchMedia("(prefers-color-scheme: dark)");
    if(_mq.addEventListener) _mq.addEventListener("change", function(){ window.onSystemTheme(); });
    else if(_mq.addListener) _mq.addListener(function(){ window.onSystemTheme(); });
  }
}catch(e){}

/* Toon base URL. When served from the Toon itself (no app) relative URLs are used. */
function hasToon(){ return NATIVE ? !!CFG.host : true; }
function toonBase(){
  if(!NATIVE && !CFG.host) return "";
  var p = CFG.port ? (":" + CFG.port) : "";
  return (CFG.proto || "http") + "://" + CFG.host + p;
}
/* ---------- Cloudflare Access (service token) ----------
   Client ID staat in de gewone instellingen; het Client Secret staat alleen versleuteld in de
   Android Keystore (AES-256-GCM) en wordt nooit in de instellingen of in de code bewaard. */
var cfSecret = "", cfSecretStored = false;
function loadSecret(){
  try{
    if(NATIVE && Android.getSecret){ cfSecret = Android.getSecret("cfSecret") || ""; cfSecretStored = cfSecret.length > 0; }
  }catch(e){}
}
function storeSecret(v){
  cfSecret = v || "";
  try{
    if(NATIVE && Android.setSecret){ cfSecretStored = Android.setSecret("cfSecret", cfSecret) && cfSecret.length > 0; return true; }
  }catch(e){}
  cfSecretStored = false;
  return !NATIVE;              // in een gewone browser: alleen in het geheugen van deze sessie
}
function toonHeaders(){
  var h = {};
  if(CFG.hdrVal) h[CFG.hdrKey || "Api-Key"] = CFG.hdrVal;
  if(CFG.cfId && cfSecret){ h["CF-Access-Client-Id"] = CFG.cfId; h["CF-Access-Client-Secret"] = cfSecret; }
  return h;
}
var lastToonErr = "";
function toonErrText(err){
  if(err === 401 || err === 403)
    return "toegang geweigerd (" + err + "). Controleer het Client ID en Secret van de Cloudflare Access service token en of er een Service Auth-policy voor dit token is.";
  if(!NATIVE && (err === 0 || err === "timeout")) return "geen verbinding, of je Cloudflare-sessie is verlopen. Herlaad de pagina; log zo nodig opnieuw in.";
  if(err === 0 || err === "timeout") return "geen verbinding. Controleer het adres, de poort en of https/http klopt.";
  if(err === 502 || err === 504 || err === 530) return "de tunnel bereikt de Toon niet (" + err + "). Draait cloudflared?";
  return String(err);
}
function getText(path, cb){ req("GET", toonBase()+path, toonHeaders(), null, cb); }

/* ---------- Program state constants ---------- */
var PROG_MANUAL=0, PROG_BASE=1, PROG_TEMPOVERRIDE=2, PROG_PROGOVERRIDE=3,
    PROG_HOLIDAY=4, PROG_MANUALHOLIDAY=5, PROG_AWAYNOW=6, PROG_DAYOFF=7, PROG_LOCKEDBASE=8;

/* ---------- State ---------- */
var currentSetpoint = 0, activeState = -1, programState = 0;
var userActive = false, setTempTimer = null;
var thermTimer = null;
var p1Started = false;

function $(id){ return document.getElementById(id); }
function el(tag, cls){ var e=document.createElement(tag); if(cls) e.className=cls; return e; }
function fmtTemp(t){ // t in hundredths of a degree (e.g. 2391 -> 23,9°)
  if(t===undefined||t===null||isNaN(t)) return "–,–°";
  var v = parseInt(t);
  var whole = Math.floor(v/100);
  var dec = Math.round((v - whole*100)/10);
  if(dec===10){ dec=0; whole++; }
  return whole + "," + dec + "°";
}
function getJSON(path, cb, errcb){
  req("GET", toonBase()+path, toonHeaders(), null, function(status, text){
    if(status===200){
      try { cb(JSON.parse(text)); }
      catch(e){ if(errcb) errcb(e); }
    } else if(errcb) errcb(status);
  });
}

/* ============================================================
   TABS / NAVIGATION
   ============================================================ */
function initTabs(){
  var tabs = document.querySelectorAll(".tab");
  tabs.forEach(function(tab){
    tab.addEventListener("click", function(){
      var view = tab.getAttribute("data-view");
      tabs.forEach(function(t){ t.classList.remove("active"); });
      tab.classList.add("active");
      document.querySelectorAll(".view").forEach(function(v){ v.classList.remove("active"); });
      $("view-"+view).classList.add("active");
      if(view==="plugs") loadPlugs();
      if(view==="status") renderStatus();
    });
  });
}

/* ============================================================
   THERMOSTAT
   ============================================================ */
function getStateName(id){
  switch(parseInt(id)){
    case 0: return "Comfort";
    case 1: return "Thuis";
    case 2: return "Slapen";
    case 3: return "Weg";
    case 4: return "Vakantie";
    default: return "";
  }
}

function setToonDot(online){
  var d = $("toon-dot"); if(d) d.className = "dot " + (online ? "online" : "offline");
}
function setCurText(t){ $("thermo-current").innerHTML = t; }
function setSetText(t){ $("thermo-set").innerHTML = t; }
var ECO_TEMP = { 0:1900, 1:1900, 2:1500, 3:1500 };
function renderProgram(){
  var on = programState !== PROG_MANUAL, t = lastTherm, main, next = "";
  var ns = t ? parseInt(t.nextSetpoint) : 0, nt = t ? parseInt(t.nextTime) : 0;
  if(programState === PROG_HOLIDAY){ main = "Vakantiestand"; }
  else if(on && ns > 0 && nt > 0){
    var dt = new Date(nt*1000);
    main = "Om " + ("0"+dt.getHours()).slice(-2) + ":" + ("0"+dt.getMinutes()).slice(-2) + " uur op";
    next = getStateName(parseInt(t.nextState));
  } else main = on ? "Programma aan" : "Programma uit";
  $("prog-main").textContent = main;
  $("prog-next").textContent = next;
  $("prog-toggle").classList.toggle("on", on);
}
function handleThermostatInfo(data){
  thermTimer = null;
  if(data && data.result==="ok"){
    setToonDot(true);
    lastTherm = data;
    programState = parseInt(data.programState);
    activeState  = parseInt(data.activeState);
    setCurText(fmtTemp(data.currentTemp));

    if(!userActive){
      currentSetpoint = parseInt(data.currentSetpoint);
      setSetText(fmtTemp(currentSetpoint));
    }

    // handmatig ingesteld: setpoint groot en gekleurd (groen = zuinig, oranje = niet), zoals de originele app
    var manual = programState === PROG_MANUAL;
    $("thermo-card").classList.toggle("manual", manual);
    var sp = $("th-set-wrap");
    var eco = (activeState === -1 || manual) ? currentSetpoint <= 1900 : (ECO_TEMP[activeState] !== undefined && ECO_TEMP[activeState] >= currentSetpoint);
    sp.classList.toggle("eco", manual && eco);
    sp.classList.toggle("ineco", manual && !eco);

    if(window.Flame) Flame.set(data);

    // info line (onder het programma)
    var info = "";
    if(programState===PROG_MANUAL) info = "Handmatig ingesteld";
    else if(programState===PROG_LOCKEDBASE) info = "Vast op " + getStateName(activeState);
    else if(programState===PROG_TEMPOVERRIDE) info = "Tijdelijk " + getStateName(activeState);
    else if(programState===PROG_HOLIDAY) info = "Vakantiestand";
    else info = "Programma: " + getStateName(activeState);
    $("thermo-info").textContent = info;
    renderProgram();
    if(window.HOL) HOL.sync();

    // highlight active mode
    document.querySelectorAll(".mode-btn").forEach(function(b){
      b.classList.toggle("active", parseInt(b.getAttribute("data-state"))===activeState);
    });

    thermTimer = setTimeout(getThermostatInfo, REFRESH_MS);
  } else {
    thermTimer = setTimeout(getThermostatInfo, REFRESH_MS);
  }
}
function getThermostatInfo(){
  if(thermTimer) clearTimeout(thermTimer);
  getJSON(THERMOSTAT_INFO_URL, handleThermostatInfo, function(err){
    lastToonErr = err;
    setToonDot(false); lastTherm = null;
    thermTimer = setTimeout(getThermostatInfo, REFRESH_MS);
  });
}
function handleThermostatStates(data){
  if(data && data.result!=="error" && data.states){
    try{
      var sts = data.states[0].state;
      for(var k in sts){
        var s = sts[k];
        var e = $("mode-"+s.id);
        if(e) e.innerHTML = fmtTemp(s.tempValue);
        (window.STATE_TEMPS = window.STATE_TEMPS || {})[s.id] = s.tempValue;
      }
    }catch(e){}
  }
}
function getThermostatStates(){
  getJSON(THERMOSTAT_STATES_URL, handleThermostatStates);
}
function changeSchemeState(newState, tempState){
  getJSON(THERMOSTAT_CHANGE_SS + "&state="+newState+"&temperatureState="+tempState, getThermostatInfo);
}
function setProgramState(pState){
  if(programState===PROG_LOCKEDBASE) changeSchemeState(PROG_TEMPOVERRIDE, pState);
  else if(programState===PROG_MANUAL) changeSchemeState(PROG_MANUAL, pState);
  else {
    if(activeState===pState) changeSchemeState(PROG_LOCKEDBASE, pState);
    else changeSchemeState(PROG_TEMPOVERRIDE, pState);
  }
  activeState = pState;
  document.querySelectorAll(".mode-btn").forEach(function(b){
    b.classList.toggle("active", parseInt(b.getAttribute("data-state"))===pState);
  });
}
function changeTemp(delta){
  userActive = true;
  clearTimeout(setTempTimer);
  setTempTimer = setTimeout(function(){
    userActive = false;
    getJSON(SET_TARGET_TEMP(currentSetpoint), getThermostatInfo);
  }, 1500);
  currentSetpoint += delta;
  if(currentSetpoint < 600) currentSetpoint = 600;
  if(currentSetpoint > 3000) currentSetpoint = 3000;
  setSetText(fmtTemp(currentSetpoint));
}
function toggleProgram(){
  var on = programState !== PROG_MANUAL;
  programState = on ? PROG_MANUAL : PROG_BASE;           // optimistic
  renderProgram();
  getJSON(THERMOSTAT_CHANGE_SS + "&state=" + (on ? 0 : 1), getThermostatInfo);
}
function initThermostat(){
  $("prog-toggle").addEventListener("click", toggleProgram);
  $("temp-plus").addEventListener("click", function(){ changeTemp(50); });
  $("temp-minus").addEventListener("click", function(){ changeTemp(-50); });
  document.querySelectorAll(".mode-btn").forEach(function(b){
    b.addEventListener("click", function(){
      setProgramState(parseInt(b.getAttribute("data-state")));
    });
  });
}
function startThermostat(){
  if(thermTimer) clearTimeout(thermTimer);
  if(!hasToon()) return;
  getThermostatStates();
  getThermostatInfo();
}

var POWER_LEVELS = ["#00695C","#388E3C","#689F38","#C0CA33","#FDD835","#FBC02D","#FFA000","#EF6C00","#E64A19","#DD2C00"];
var lastVals = { power:null, solar:null, grid:null };
function numCfg(k, def){ var n = parseFloat(CFG[k]); return (n>0) ? n : def; }
function isNum(v){ return !(v===null||v===undefined||isNaN(v)); }
function buildStripes(){
  var host = $("stripes-power"); if(!host) return;
  host.innerHTML = "";
  for(var lvl=10; lvl>=1; lvl--){                        // bovenste streepje = niveau 10
    var d = el("div","pline"); d.setAttribute("data-lvl", lvl); host.appendChild(d);
  }
}
/* "Stroom nu": niveau 1..10 zoals calculatePowerLevel in de originele app (gebruik / (gemiddelde * 10/3) * 10) */
function powerLevel(usage, avg){
  if(!isNum(usage) || usage <= 0) return 0;
  var lvl;
  if(isNum(avg) && avg > 0) lvl = usage / (avg * (10/3)) * 10;
  else lvl = usage / numCfg("scaleW", 2500) * 10;
  if(!isFinite(lvl)) return 0;
  return lvl > 10 ? 10 : Math.max(1, Math.round(lvl));
}
function setStripes(val, avg){
  var host = $("stripes-power"); if(!host) return;
  var level = powerLevel(val, avg);
  var kids = host.children;
  for(var i=0;i<kids.length;i++){
    var l = parseInt(kids[i].getAttribute("data-lvl"));
    kids[i].style.backgroundColor = (l <= level) ? POWER_LEVELS[l-1] : "";
  }
}
/* "Stroom vandaag": twee vlakken (getIconFills / calculatePercentages uit de originele app) */
function setSquares(kwh, avg){
  var topFill = 0, bottomFill = 0;
  if(isNum(kwh) && kwh > 0 && isNum(avg) && avg > 0){
    var up = Math.min(100, Math.round(kwh / (avg * 2) * 100));
    var bottomEmpty = Math.max(0, 100 - up*2), topEmpty = Math.min(100, 200 - up*2);
    topFill = 100 - topEmpty; bottomFill = 100 - bottomEmpty;
  }
  $("sq-cons-bottom").style.height = bottomFill + "%";
  $("sq-cons-top").style.height = topFill + "%";
}
function fmtWatt(v){ return isNum(v) ? Math.round(v).toLocaleString("nl-NL",{useGrouping:false}) : "–"; }
function updateSelf(){
  var p = lastVals.power, s = lastVals.solar, pct = null;
  if(isNum(s) && isNum(p)){
    if(p === 0) pct = s > 0 ? 100 : 0;
    else pct = Math.min(100, Math.round(s / p * 100));
  }
  $("val-self").textContent = (pct===null) ? "–" : pct + "%";
  var w = pct===null ? 0 : Math.round(pct/100 * 54);
  $("house-fill").setAttribute("width", w);
  $("self-dots").style.display = (isNum(s) && s > 0) ? "inline" : "none";
}
function setTileValue(which, val){
  lastVals[which] = isNum(val) ? val : null;
  if(which==="grid"){
    var returning = isNum(val) && val < 0;
    $("title-grid").textContent = returning ? "Levering aan net" : "Afname van net";
    var dots = $("grid-dots");
    dots.style.fill = returning ? "#ff9900" : "#8e24aa";
    dots.style.display = (isNum(val) && val !== 0) ? "inline" : "none";
    if(returning) dots.setAttribute("transform","matrix(-1 0 0 1 150 0)"); else dots.removeAttribute("transform");
    $("val-grid").textContent = fmtWatt(isNum(val) ? Math.abs(val) : val);
    return;
  }
  $("val-"+which).textContent = fmtWatt(val);
  if(which==="power") setStripes(val);
  if(which==="solar") $("solar-dots").style.display = (isNum(val) && val > 0) ? "inline" : "none";
  updateSelf();
}

function fmtKwh(v){ var d = v >= 10 ? 1 : 2; return v.toLocaleString("nl-NL", {minimumFractionDigits:d, maximumFractionDigits:d, useGrouping:false}); }
function setDay(kind, kwh, note){
  $("val-day-"+kind).textContent = isNum(kwh) ? fmtKwh(kwh) : "–";
  $("note-day-"+kind).textContent = note || "";
}

/* ============================================================
   ENERGIE-TEGELS  (waarden van de Toon zelf)
   ============================================================ */
function setP1Dot(ok){
  var d = $("p1-dot"); if(d) d.className = "dot " + (ok ? "online" : "offline");
}
function applySolarVisibility(){
  var has = P1.state.hasSolar === true;
  document.body.classList.toggle("has-solar", has);
  applyEnergy();
  if(window.G && G.isOpen()) G.solarChanged();
}
function applyGasVisibility(){
  var has = P1.state.hasGas === true;
  document.body.classList.toggle("has-gas", has);
  applyEnergy();
  if(window.G && G.isOpen()) G.gasChanged();
}
/* "Gas vandaag": twee vlakken in de gaskleuren, gevuld volgens dezelfde regel als Stroom vandaag */
function setGasSquares(m3, avgM3){
  var topFill = 0, bottomFill = 0;
  if(isNum(m3) && m3 > 0 && isNum(avgM3) && avgM3 > 0){
    var up = Math.min(100, Math.round(m3 / (avgM3 * 2) * 100));
    topFill = 100 - Math.min(100, 200 - up*2); bottomFill = 100 - Math.max(0, 100 - up*2);
  }
  $("sq-gas-bottom").style.height = bottomFill + "%";
  $("sq-gas-top").style.height = topFill + "%";
}
function applyEnergy(){
  var st = P1.state, c = st.cur;
  setP1Dot(c.ok);
  var power = c.ok ? c.power : null;
  lastVals.power = power;
  $("val-power").textContent = fmtWatt(power);
  setStripes(power, c.avgPower);

  var solar = (st.hasSolar === true && c.ok) ? P1.solarNowW() : null;
  setTileValue("solar", solar);
  var grid = (isNum(power) && isNum(solar)) ? power - solar : null;   // zoals GridExchangeCard: verbruik min opwek
  setTileValue("grid", grid);

  var cons = P1.consTodayWh();
  var nativeCons = (c.dayCons !== null);
  var avgKwh = (c.avgDay !== null && c.avgDay > 0) ? c.avgDay / 1000 : numCfg("scaleDayCons", 18) / 2;
  setDay("cons", isNum(cons) ? cons/1000 : null, "");
  if(isNum(cons)) setSquares(cons/1000, avgKwh); else setSquares(null, avgKwh);
  if(st.hasGas === true){
    var gl = P1.gasTodayL();
    var gavg = (c.gasAvg !== null && c.gasAvg > 0) ? c.gasAvg/1000 : numCfg("scaleGas", 5) / 2;
    $("val-day-gas").textContent = isNum(gl) ? (gl/1000).toLocaleString("nl-NL",{minimumFractionDigits:2,maximumFractionDigits:2,useGrouping:false}) : "–";
    $("note-day-gas").textContent = "";
    setGasSquares(isNum(gl) ? gl/1000 : null, gavg);
  }
  var sol = P1.solarTodayWh();
  setDay("solar", (st.hasSolar === true && isNum(sol)) ? sol/1000 : null, "");
}

/* ============================================================
   SLIMME STEKKERS (tab Aan · Uit)
   ============================================================ */
var plugTimer = null, plugBusy = {}, plugProbed = {};
function loadPlugs(){
  if(plugTimer) clearTimeout(plugTimer);
  var active = document.querySelector(".tab.active");
  if(!active || active.getAttribute("data-view") !== "plugs") return;
  if(!hasToon()){ $("plug-list").innerHTML = '<div class="empty">Vul eerst het adres van je Toon in (Meer › Instellingen).</div>'; return; }
  P1.plugs(function(err, list){
    if(err){ $("plug-list").innerHTML = '<div class="empty">Toon niet bereikbaar (' + err + ').</div>'; }
    else { renderPlugs(list); list.forEach(function(p){ if(p.unknown && !plugProbed[p.uuid]){ plugProbed[p.uuid] = 1; P1.plugProbe(p.uuid); } }); }
    plugTimer = setTimeout(loadPlugs, 10000);
  });
}
var SOCKET = '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 9v3M15 9v3M9.500 16h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
function renderPlugs(list){
  var host = $("plug-list");
  if(!list.length){ host.innerHTML = '<div class="empty">Geen slimme stekkers gevonden op je Toon.</div>'; return; }
  host.innerHTML = "";
  list.forEach(function(p){
    var row = el("div","mi static plug" + (p.connected ? "" : " off"));
    var sub = !p.connected ? "Niet verbonden" : ((isNum(p.watt) ? Math.round(p.watt) + " Watt · " : "") + (p.on ? "Aan" : "Uit"));
    row.innerHTML = '<span class="mi-ico mi-glyph">' + SOCKET + '</span><span class="mi-txt"><span class="mi-title"></span><span class="mi-sub">' + sub + '</span></span>';
    row.querySelector(".mi-title").textContent = p.name;
    var sw = el("button","switch" + (p.on ? " on" : "")); sw.innerHTML = '<span class="knob"></span>';
    if(!p.connected) sw.disabled = true;
    sw.addEventListener("click", function(){
      var on = !sw.classList.contains("on");
      sw.classList.toggle("on", on);
      row.querySelector(".mi-sub").textContent = (isNum(p.watt) ? Math.round(p.watt) + " Watt · " : "") + (on ? "Aan" : "Uit");
      P1.plugSet(p.uuid, on, function(){ loadPlugs(); });
    });
    row.appendChild(sw);
    host.appendChild(row);
  });
}

/* ============================================================
   INSTELLINGEN
   ============================================================ */
function fillSettings(){
  $("set-theme").value = CFG.theme || "auto";
  $("set-proto").value = CFG.proto || "http";
  $("set-host").value = CFG.host || "";
  $("set-port").value = CFG.port || "";
  $("set-hdrkey").value = CFG.hdrKey || "Api-Key";
  $("set-hdrval").value = CFG.hdrVal || "";
  $("set-cfid").value = CFG.cfId || "";
  $("set-cfsecret").value = "";
  $("set-cfsecret").placeholder = cfSecretStored ? "opgeslagen (leeg laten om te behouden)" : (cfSecret ? "alleen voor deze sessie" : "plak hier het Client Secret");
  $("cf-clear").style.display = (cfSecretStored || cfSecret) ? "block" : "none";
  $("set-solar").value = CFG.solarMode || "auto";
  $("set-scalew").value = CFG.scaleW || "";
  $("set-scaledaycons").value = CFG.scaleDayCons || "";
  $("set-gas").value = CFG.gasMode || "auto";
  $("set-scalegas").value = CFG.scaleGas || "";
  $("set-pricegas").value = CFG.priceGas || "";
  $("set-pricecons").value = CFG.priceCons || "";
  $("set-priceprod").value = CFG.priceProd || "";
  $("set-dayshift").value = CFG.dayShift || "0";
  var st = P1.state;
  $("set-gasinfo").textContent = st.hasGas === null ? "Nog niet bepaald." :
      (st.hasGas ? "Gas gevonden: " : "Geen gas: ") + st.gasWhy;
  $("set-solarinfo").textContent = st.hasSolar === null ? "Nog niet bepaald." :
      (st.hasSolar ? "Zonnepanelen gevonden: " : "Geen zonnepanelen: ") + st.solarWhy;
}
function readSettings(){
  CFG.theme = $("set-theme").value || "auto";
  CFG.proto = $("set-proto").value;
  CFG.host = $("set-host").value.trim().replace(/^https?:\/\//,"").replace(/\/+$/,"");
  CFG.port = $("set-port").value.trim();
  CFG.hdrKey = $("set-hdrkey").value.trim() || "Api-Key";
  CFG.hdrVal = $("set-hdrval").value.trim();
  CFG.cfId = $("set-cfid").value.trim();
  var sec = $("set-cfsecret").value.trim();
  if(sec){ if(!storeSecret(sec) && NATIVE) alert("Het secret kon niet veilig worden opgeslagen."); }
  CFG.solarMode = $("set-solar").value || "auto";
  CFG.scaleW = $("set-scalew").value.trim() || "2500";
  CFG.scaleDayCons = $("set-scaledaycons").value.trim() || "18";
  CFG.gasMode = $("set-gas").value || "auto";
  CFG.scaleGas = $("set-scalegas").value.trim() || "5";
  CFG.priceGas = $("set-pricegas").value.trim();
  CFG.priceCons = $("set-pricecons").value.trim();
  CFG.priceProd = $("set-priceprod").value.trim();
  CFG.dayShift = String(parseInt($("set-dayshift").value) || 0);
}
function line(ok, txt){ return '<div class="'+(ok?"ok":"bad")+'">'+(ok?"✓ ":"✗ ")+txt+'</div>'; }
function saveAndTest(){
  readSettings(); saveCfg();
  var out = $("set-status");
  out.innerHTML = "Testen…";
  var res = "";
  function fin(){ out.innerHTML = res; P1.restart(); startAll(); setTimeout(fillSettings, 1500); }
  if(!hasToon()){ res += line(false, "Vul het adres van je Toon in"); return fin(); }
  getJSON(THERMOSTAT_INFO_URL, function(d){
    var ok = d && d.result==="ok";
    res += line(ok, "Thermostaat " + (ok ? "bereikbaar" : "gaf een onverwacht antwoord"));
    setToonDot(ok);
    testUsage();
  }, function(err){
    setToonDot(false);
    res += line(false, "Toon niet bereikbaar: " + toonErrText(err));
    fin();
  });
  function testUsage(){
    getJSON("/happ_pwrusage?action=GetCurrentUsage", function(d){
      var pu = d && d.powerUsage, ok = pu && isNum(pu.value);
      res += line(!!ok, ok ? "P1-meter gelezen: " + Math.round(pu.value) + " Watt" : "P1-meter: geen waarde ontvangen (is de P1-module gekoppeld?)");
      fin();
    }, function(err){ res += line(false, "P1-meter niet gelezen (" + err + ")"); fin(); });
  }
}

/* ============================================================
   OVERLAY-PAGINA'S (oranje kop + terugknop) en STATUS
   ============================================================ */
var pageStack = [];
var ignorePop = 0;
function openPage(id){
  var p = $("page-"+id); if(!p) return;
  if(pageStack.indexOf(id) < 0){
    pageStack.push(id);
    if(!NATIVE){ try{ history.pushState({ pg:id }, ""); }catch(e){} }
  }
  p.classList.add("open");
  if(id === "settings") fillSettings();
  if(id === "about") $("about-ver").textContent = APP_VERSION;
  if(id === "program" && window.PRG) PRG.open();
  if(id === "holiday" && window.HOL) HOL.open();
}
function closePage(fromPop){
  var top = pageStack[pageStack.length - 1]; if(!top) return false;
  if(top === "programedit" && window.PRG && PRG.guardClose(fromPop === true)) return true;   // niet-opgeslagen wijzigingen: eerst vragen
  var id = pageStack.pop();
  $("page-"+id).classList.remove("open");
  if(id === "graph" && window.G) G.close();
  if(id === "program" && window.PRG) PRG.close();
  if((id === "programedit" || id === "programcopy") && window.PRG) PRG.editClosed();
  if(!NATIVE && fromPop !== true){ ignorePop++; try{ history.back(); }catch(e){ ignorePop--; } }
  return true;
}
window.addEventListener("popstate", function(){
  if(NATIVE) return;
  if(ignorePop > 0){ ignorePop--; return; }
  if(pageStack.length) closePage(true);
});
var APP_VERSION = "2.0.0";
var lastTherm = null;

function statusRow(state, title, sub){
  return '<div class="mi static"><span class="mi-dot ' + state + '"></span><span class="mi-txt"><span class="mi-title">' + title +
         '</span><span class="mi-sub">' + sub + '</span></span></div>';
}
function renderStatus(){
  var h = "", t = lastTherm, st = P1.state, c = st.cur;
  if(!hasToon()) h += statusRow("warn", "Thermostaat", "Geen Toon-adres ingesteld (Meer › Instellingen)");
  else if(!t) h += statusRow("bad", "Thermostaat", "Niet bereikbaar" + ((lastToonErr === 401 || lastToonErr === 403 || (!NATIVE && lastToonErr === 0)) ? " – " + toonErrText(lastToonErr) : ""));
  else {
    h += statusRow("ok", "Thermostaat", "Verbonden" + (CFG.host ? " met " + CFG.host : ""));
    var burner = t.burnerInfo === "1" ? "Ketel brandt (verwarming)" : t.burnerInfo === "2" ? "Ketel brandt (warm water)" : "Ketel uit";
    var mod = (t.currentModulationLevel !== undefined && t.currentModulationLevel !== null && t.currentModulationLevel !== "") ? " · modulatie " + t.currentModulationLevel + "%" : "";
    var err = (t.hasBoilerFault === undefined || t.hasBoilerFault === null) ? parseInt(t.errorFound) !== 255 && t.errorFound !== undefined
                                                                          : parseInt(t.hasBoilerFault) !== 0;
    if(t.otCommError !== undefined && String(t.otCommError) !== "0") err = true;
    h += statusRow(err ? "bad" : "ok", "Ketel", err ? "Storing gemeld door de ketel" : burner + mod);
    if(t.boilerModuleConnected !== undefined) h += statusRow(parseInt(t.boilerModuleConnected) ? "ok" : "warn", "Ketelmodule", parseInt(t.boilerModuleConnected) ? "Verbonden" : "Niet verbonden");
  }
  h += statusRow(c.ok ? "ok" : (hasToon() ? "bad" : "warn"), "P1-meter",
                 c.ok ? "Verbonden · nu " + Math.round(c.power) + " Watt" : (hasToon() ? "Geen waarde ontvangen" + (st.lastErr ? " (" + st.lastErr + ")" : "") : "Geen Toon-adres ingesteld"));
  h += statusRow(st.hasSolar === true ? "ok" : "warn", "Zonnepanelen",
                 st.hasSolar === null ? "Nog niet bepaald" : (st.hasSolar ? "Aanwezig · " : "Niet gevonden · ") + st.solarWhy);
  h += statusRow(st.hasGas === true ? "ok" : "warn", "Gas",
                 st.hasGas === null ? "Nog niet bepaald" : (st.hasGas ? "Aanwezig · " : "Niet gevonden · ") + st.gasWhy);
  $("status-list").innerHTML = h;
}
function runDiag(){
  var out = $("diag-out"), btn = $("diag-btn");
  btn.disabled = true; out.textContent = "Bezig met controleren…"; out.style.display = "block";
  P1.diagnose(function(text){
    out.textContent = text; btn.disabled = false; $("diag-copy").style.display = "block";
  });
}
function copyDiag(){
  var out = $("diag-out"), text = out.textContent;
  try{
    if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(text); $("diag-copy").textContent = "Gekopieerd"; return; }
  }catch(e){}
  var r = document.createRange(); r.selectNodeContents(out);
  var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  $("diag-copy").textContent = "Tekst geselecteerd - kopieer via het menu";
}

function switchTab(view){
  var t = document.querySelector('.tab[data-view="'+view+'"]');
  if(t) t.click();
}
window.handleBack = function(){
  if(pageStack.length){ closePage(); return true; }
  var active = document.querySelector(".tab.active");
  if(active && active.getAttribute("data-view") !== "dash"){ switchTab("dash"); return true; }
  return false;
};

/* manual refresh button: reload everything right now */
function manualRefresh(){
  var b = $("refresh-btn");
  if(b){ b.classList.add("spin"); setTimeout(function(){ b.classList.remove("spin"); }, 900); }
  P1.clear();
  startAll();
  var active = document.querySelector(".tab.active");
  var v = active && active.getAttribute("data-view");
  if(v === "plugs") loadPlugs();
  if(v === "status") renderStatus();
  if(window.G && G.isOpen()) G.refresh();
}

/* (re)start all data loops, e.g. after saving settings or resuming */
function startAll(){
  startThermostat();
  if(!p1Started){ p1Started = true; P1.start(); } else P1.poll();
}
window.onAppResume = function(){ if(hasToon()) startAll(); };
// in de browser: bij terugkeren naar het tabblad alles direct verversen
document.addEventListener("visibilitychange", function(){ if(!NATIVE && !document.hidden) startAll(); });

function init(){
  if(!NATIVE) document.body.classList.add("web");
  loadCfg();
  applyTheme();
  buildStripes();
  initTabs();
  initThermostat();
  P1.state.onUpdate = applyEnergy;
  P1.state.onSolar = applySolarVisibility;
  P1.state.onGas = applyGasVisibility;

  $("set-save").addEventListener("click", saveAndTest);
  $("set-theme").addEventListener("change", function(){ CFG.theme = $("set-theme").value || "auto"; saveCfg(); applyTheme(); });
  $("cf-clear").addEventListener("click", function(){ storeSecret(""); $("set-cfsecret").value = ""; fillSettings(); });
  $("refresh-btn").addEventListener("click", manualRefresh);
  $("diag-btn").addEventListener("click", runDiag);
  $("diag-copy").addEventListener("click", copyDiag);

  // lijst-items (Inzichten / Meer) en terugknoppen
  document.querySelectorAll("[data-open]").forEach(function(b){
    b.addEventListener("click", function(){
      var id = b.getAttribute("data-open");
      if(id === "graph" && window.G) G.open({ interval:"days", series:["consumption","production"] });
      else openPage(id);
    });
  });
  document.querySelectorAll("[data-close]").forEach(function(b){ b.addEventListener("click", closePage); });

  // tegels: tikken opent de grafiek met dezelfde instelling als de originele app
  document.querySelectorAll(".tile[data-go]").forEach(function(t){
    var go = function(){
      var p = t.getAttribute("data-go").split(":");
      if(window.G) G.open({ interval:p[0], series:p[1].split(","), resource:p[2] || "electricity" });
    };
    t.addEventListener("click", go);
    t.addEventListener("keydown", function(e){ if(e.key === "Enter" || e.key === " "){ e.preventDefault(); go(); } });
  });
  if(window.G) G.init();

  if(NATIVE && !CFG.host){
    openPage("settings");
    $("set-status").textContent = "Vul het adres van je Toon in en tik op Opslaan & testen.";
    return;
  }
  startAll();
}

document.addEventListener("DOMContentLoaded", init);

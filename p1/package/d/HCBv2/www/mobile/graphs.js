/* ============================================================
   graphs.js  -  grafieken in de stijl van de Toon-app (P1-versie)
   - U (uur, vlak, Watt) / D (dag) / M (maand) / J (jaar), staven in kWh of euro
   - data komt rechtstreeks uit de Toon (hcb_rrd): 5-minutenwaarden en dagtellers
   - logica (7 staven in beeld, 4 rasterlijnen, afronding van de y-as, zoom,
     schuiven door de tijd, tikken op een staaf) volgt de originele app
   ============================================================ */
(function(){
"use strict";

var SVGNS = "http://www.w3.org/2000/svg";
var COLORS = { consumption: "#9B29B9", production: "#FF9900", gas: "#00AFBF" };
var NAMES  = { consumption: "Verbruik", production: "Productie" };
var TICKS_ON_SCREEN = 7, Y_MARGIN = 54;
var STEP5 = 5 * 60 * 1000;

var FETCH = {
  hours:  { chunk: [2,  "day"],   startOf: "hour",  step: "hour",  total: [1,  "month"] },
  days:   { chunk: [1,  "month"], startOf: "day",   step: "day",   total: [2,  "year"]  },
  months: { chunk: [20, "month"], startOf: "month", step: "month", total: [5,  "year"]  },
  years:  { chunk: [13, "year"],  startOf: "year",  step: "year",  total: [13, "year"]  }
};

/* ---------- tijd-hulpjes (lokale tijd) ---------- */
function startOf(u, ts){
  var d = new Date(ts);
  if(u==="hour") d.setMinutes(0,0,0);
  else if(u==="day") d.setHours(0,0,0,0);
  else if(u==="month"){ d.setDate(1); d.setHours(0,0,0,0); }
  else if(u==="year"){ d.setMonth(0,1); d.setHours(0,0,0,0); }
  return d.getTime();
}
function add(u, ts, n){
  if(u==="hour") return ts + n*3600000;
  var d = new Date(ts);
  if(u==="day") d.setDate(d.getDate()+n);
  else if(u==="month") d.setMonth(d.getMonth()+n);
  else d.setFullYear(d.getFullYear()+n);
  return d.getTime();
}
function cap(s){ s = String(s).replace(/\./g,""); return s.charAt(0).toUpperCase()+s.slice(1); }
function nl(ts, opts){ return new Date(ts).toLocaleDateString("nl-NL", opts); }

/* ---------- toestand ---------- */
var S = {
  open:false, interval:"days", measurement:"volume", zoomed:false, zoomEnabled:false,
  active:{ consumption:true, production:true }, selected:null,
  resource:"electricity", cache:{}, ticks:[], L:null, yMax:0, unit:"kWh",
  scrollTimer:null, refreshTimer:null
};
function $g(id){ return document.getElementById(id); }
function sv(tag, attrs, parent){
  var e = document.createElementNS(SVGNS, tag);
  for(var k in attrs) e.setAttribute(k, attrs[k]);
  if(parent) parent.appendChild(e);
  return e;
}
function solarOn(){ return (typeof P1 !== "undefined") && P1.state.hasSolar === true; }
function gasOn(){ return (typeof P1 !== "undefined") && P1.state.hasGas === true; }
function isGas(){ return S.resource === "gas"; }
function isAvail(series, interval){
  if(!hasToon()) return false;
  if(isGas()) return series === "consumption" && gasOn();
  return series === "production" ? solarOn() : true;
}
function price(series){
  var raw = isGas() ? CFG.priceGas : (series === "production" ? CFG.priceProd : CFG.priceCons);
  var v = parseFloat(String(raw || "").replace(",","."));
  return v > 0 ? v : 0;
}
function hasPrices(){ return isGas() ? price("consumption") > 0 : (price("consumption") > 0 || price("production") > 0); }
function cacheFor(series){
  var key = S.interval + "|" + S.resource;
  var c = S.cache[key] || (S.cache[key] = {});
  return c[series] || (c[series] = { items:[], from:0, loading:false, error:false, done:false, unavail:false, loaded:false });
}
function seriesKeys(){ return isGas() ? ["consumption"] : ["consumption","production"]; }
function activeKeys(){ return seriesKeys().filter(function(k){ return S.active[k] && isAvail(k, S.interval); }); }
function nameOf(k){ return NAMES[k]; }
function colorOf(k){ return isGas() ? COLORS.gas : COLORS[k]; }
function ticksFor(interval){
  var f = FETCH[interval];
  var start = add(f.step, startOf(f.startOf, Date.now()), 1);
  var from  = add(f.total[1], start, -f.total[0]);
  var t = [], cur = start;
  while(cur > from){
    t.unshift(cur);
    cur = add(f.step, cur, -1);
    if(f.startOf !== "hour") cur = startOf(f.startOf, cur);
  }
  return t;
}

/* ============================================================
   DATA (Toon)
   ============================================================ */
function aggregate(rows){
  var t0 = S.ticks[0], t1 = S.ticks[S.ticks.length-1];
  if(S.interval === "days") return rows.filter(function(r){ return r.timestamp >= t0 && r.timestamp <= t1; });
  var unit = S.interval === "months" ? "month" : "year", m = {}, order = [];
  rows.forEach(function(r){
    var k = startOf(unit, r.timestamp);
    if(m[k] === undefined){ m[k] = 0; order.push(k); }
    m[k] += r.value;
  });
  return order.sort(function(a,b){ return a-b; })
              .filter(function(k){ return k >= t0 && k <= t1; })
              .map(function(k){ return { timestamp:k, value:m[k], unit:isGas() ? "l" : "Wh" }; });
}
function applyCosts(items, series){
  var p = price(series);
  items.forEach(function(it){
    it.volume = it.value;
    it.costs = (it.unit === "Wh" || it.unit === "l") ? it.value / 1000 * p : 0;
  });
  return items;
}
function fetchDaily(series, cb){
  P1.daily(isGas() ? "gas" : series, function(err, rows){
    if(err) return cb(err);
    cb(null, aggregate(rows));
  });
}
function fetchRange(series, from, to, cb){
  if(isGas()) return P1.gasHours(from, Math.min(to, Date.now()), cb);
  P1.flow(series, from, Math.min(to, Date.now()), cb);
}
function merge(ds, items){
  var m = {};
  ds.items.forEach(function(i){ m[i.timestamp] = i; });
  items.forEach(function(i){ m[i.timestamp] = i; });
  ds.items = Object.keys(m).map(function(k){ return m[k]; }).sort(function(a,b){ return a.timestamp - b.timestamp; });
}
function firstRange(){
  var f = FETCH[S.interval];
  var to = add(f.step, startOf(f.startOf, Date.now()), 2);
  var from = add(f.chunk[1], startOf(f.startOf, to), -f.chunk[0]);
  return { from: Math.max(from, S.ticks[0]), to: to };
}
function loadMore(series){
  var ds = cacheFor(series), interval = S.interval;
  if(ds.loading || ds.done) return;
  if(!isAvail(series, interval)){ ds.unavail = true; ds.error = true; ds.done = true; ds.loaded = true; return; }
  ds.loading = true; uiLoading();
  if(interval !== "hours"){            // dag/maand/jaar: één keer de hele dagreeks uit de tellers
    fetchDaily(series, function(err, items){
      if(S.interval !== interval){ ds.loading = false; return; }
      ds.loading = false; ds.loaded = true; ds.done = true;
      if(err){ ds.error = true; ds.items = []; }
      else { ds.error = false; ds.items = applyCosts(items, series); }
      ds.from = S.ticks[0];
      afterData();
    });
    return;
  }
  var f = FETCH[interval], r;
  if(!ds.from) r = firstRange();
  else {
    var to = ds.from;
    r = { from: Math.max(add(f.chunk[1], startOf(f.startOf, to), -f.chunk[0]), S.ticks[0]), to: to };
  }
  fetchRange(series, r.from, r.to, function(err, items){
    if(S.interval !== interval){ ds.loading = false; return; }
    ds.loading = false; ds.loaded = true;
    if(err){ ds.error = true; }
    else { ds.error = false; merge(ds, applyCosts(items, series)); }
    ds.from = r.from;
    if(r.from <= S.ticks[0]) ds.done = true;
    afterData();
  });
}
function refreshLatest(){
  if(!S.open) return;
  seriesKeys().forEach(function(series){
    var ds = cacheFor(series);
    if(ds.loading || !ds.loaded || !isAvail(series, S.interval)) return;
    var interval = S.interval;
    if(interval !== "hours"){
      fetchDaily(series, function(err, items){
        if(err || S.interval !== interval) return;
        ds.items = applyCosts(items, series); afterData();
      });
      return;
    }
    var r = firstRange();
    fetchRange(series, r.from, r.to, function(err, items){
      if(err || S.interval !== interval) return;
      merge(ds, applyCosts(items, series));
      afterData();
    });
  });
}

/* ============================================================
   SCHAAL / AFRONDING (zoals Unit.js in de originele app)
   ============================================================ */
function firstDivisible(v, d){ var m = v % d; return m === 0 ? v : v + d - m; }
function roundMax(unit, value){
  if(unit === "EUR"){ value = Math.ceil(value); return firstDivisible(value > 0 ? value : 1, 4); }
  var div = 1, rf = 4;
  if(value === 0) value = (unit === "kWh" || unit === "m3") ? 1000 : 1;
  if(unit === "kWh" || unit === "m3") div = 1000;
  value /= div;
  if(value > 5000) rf = 1000; else if(value > 500) rf = 100; else if(value > 50) rf = 20;
  value = Math.ceil(value / rf) * div * rf;
  return firstDivisible(value, 4);
}
function stdDev3(arr){
  if(arr.length < 2) return Math.max.apply(null, arr);
  var n = arr.length - 1, mean = arr.reduce(function(a,b){ return a+b; }) / n;
  var sd = Math.sqrt(arr.map(function(x){ return Math.pow(x-mean, 2); }).reduce(function(a,b){ return a+b; }) / n);
  return mean + sd*3;
}
function measure(){ return S.interval === "hours" ? "volume" : S.measurement; }
function valueOf(it){ return measure() === "costs" ? it.costs : it.value; }
function computeScale(force){
  var keys = activeKeys().filter(function(k){ return cacheFor(k).items.length; });
  if(!keys.length){ S.zoomEnabled = false; return; }
  var meta = null;
  keys.forEach(function(k){
    var vals = cacheFor(k).items.map(valueOf);
    var m = { max: Math.max.apply(null, vals), sd: stdDev3(vals) };
    if(!meta || m.max > meta.max) meta = m;
  });
  var unit = measure() === "costs" ? "EUR" : (S.interval === "hours" ? (isGas() ? "l" : "W") : (isGas() ? "m3" : "kWh"));
  var stdY = roundMax(unit, meta.sd), maxY = roundMax(unit, meta.max), y;
  if(stdY >= maxY){ S.zoomEnabled = false; y = maxY; }
  else { S.zoomEnabled = true; y = S.zoomed ? stdY : maxY; }
  S.unit = unit;
  if(y > S.yMax || force) S.yMax = y;
}
function yLabel(v){
  if(S.unit === "EUR") return "€ " + Math.round(v).toLocaleString("nl-NL", { maximumFractionDigits:0, useGrouping:false });
  if(S.unit === "kWh" || S.unit === "m3") return (v/1000).toLocaleString("nl-NL", { maximumFractionDigits:2, useGrouping:false });
  return Math.round(v).toLocaleString("nl-NL", { useGrouping:false });
}
function displayValue(v, unit){
  var d = 2, cur = v;
  if(unit === "EUR"){
    if(v >= 100000) d = 0; else if(v >= 10000) d = 1;
    return "€ " + v.toLocaleString("nl-NL", { minimumFractionDigits:d, maximumFractionDigits:d, useGrouping:false });
  }
  if(unit === "kWh" || unit === "m3"){ cur = v/1000; d = cur < 1 ? 2 : (cur < 10 ? 1 : 0); }
  else d = 0;
  var label = unit === "m3" ? "m³" : (unit === "EUR" ? "" : unit);
  return cur.toLocaleString("nl-NL", { minimumFractionDigits:d, maximumFractionDigits:d, useGrouping:false }) + " " + label;
}

/* ============================================================
   TEKENEN
   ============================================================ */
function layout(){
  var chart = $g("g-chart");
  var W = chart.clientWidth || 360, H = chart.clientHeight || 260;
  var between = Math.max(10, Math.round(W * 0.035));
  var inner = H - 8 - 20;                       // marge boven + onder
  var viewW = W - Y_MARGIN;
  return {
    W:W, H:H, top:8, bottom:20, between:between, height:inner, viewW:viewW,
    step: viewW / TICKS_ON_SCREEN,
    width: viewW * (S.ticks.length / TICKS_ON_SCREEN)
  };
}
function xOf(ts){
  var t0 = S.ticks[0], t1 = S.ticks[S.ticks.length-1];
  return (ts - t0) / (t1 - t0) * S.L.width;
}
function invertX(x){
  var t0 = S.ticks[0], t1 = S.ticks[S.ticks.length-1];
  return t0 + x / S.L.width * (t1 - t0);
}
function yOf(v){ return S.L.height - Math.min(1, Math.max(0, v / S.yMax)) * S.L.height; }

function drawYAxis(){
  var L = S.L, svg = $g("g-yaxis");
  while(svg.firstChild) svg.removeChild(svg.firstChild);
  svg.setAttribute("width", L.W); svg.setAttribute("height", L.height + L.top + L.bottom);
  var g = sv("g", { transform:"translate(" + (L.W - Y_MARGIN) + "," + L.top + ")" }, svg);
  var fr = [0, .25, .5, .75, 1];
  fr.forEach(function(f, i){
    var y = L.height - f * L.height;
    sv("line", { x1:0, x2:-L.W, y1:y, y2:y, stroke: i===0 ? "#565656" : "rgba(86,86,86,.25)", "shape-rendering":"crispEdges" }, g);
    var t = sv("text", { x:38, y:y + 4, "text-anchor":"end", fill:"#565656", "font-size":"11.5" }, g);
    t.textContent = S.yMax ? yLabel(S.yMax * f) : "";
  });
}
function hatch(defs, id, color){
  var p = sv("pattern", { id:id, width:6, height:6, patternTransform:"rotate(-45 0 0)", patternUnits:"userSpaceOnUse" }, defs);
  sv("line", { x1:0, y1:0, x2:0, y2:6, stroke:color, "stroke-width":6 }, p);
}
function xLabel(ts){
  var d = new Date(ts);
  if(S.interval === "hours") return ("0" + d.getHours()).slice(-2);
  if(S.interval === "days") return nl(ts, { weekday:"short" }).replace(".","");
  if(S.interval === "months") return cap(nl(ts, { month:"short" }));
  return String(d.getFullYear());
}
function drawContent(){
  var L = S.L, scroll = $g("g-scroll"), sl = scroll.scrollLeft;
  var old = scroll.firstChild; if(old) scroll.removeChild(old);
  var svg = sv("svg", { width:L.width, height:L.height + L.top + L.bottom, "class":"g-svg g-" + S.interval }, null);
  var defs = sv("defs", {}, svg);
  hatch(defs, "hatch-consumption", colorOf("consumption")); hatch(defs, "hatch-production", COLORS.production);
  var root = sv("g", { transform:"translate(0," + L.top + ")" }, svg);

  var keys = activeKeys();
  var isHours = S.interval === "hours";
  var isArea = isHours && !isGas();
  var n = keys.length || 1;
  var barW = Math.max(6, L.step - 2*L.between);

  // series
  keys.forEach(function(series, si){
    var items = cacheFor(series).items;
    var g = sv("g", { "class":"g-series g-" + series }, root);
    if(isArea){
      if(!items.length) return;
      g.setAttribute("opacity", si > 0 ? "0.8" : "1");
      var d = "M" + xOf(items[0].timestamp).toFixed(1) + "," + L.height;
      items.forEach(function(it){
        var v = valueOf(it);
        d += " L" + xOf(it.timestamp).toFixed(1) + "," + (v > 0 ? yOf(v) : L.height).toFixed(1);
      });
      d += " L" + xOf(items[items.length-1].timestamp).toFixed(1) + "," + L.height + " Z";
      sv("path", { d:d, fill:colorOf(series) }, g);
      return;
    }
    var calcW = Math.max(4, (L.step - 2*L.between) / n);
    var curStart = startOf(FETCH[S.interval].startOf, Date.now());
    items.forEach(function(it, idx){
      var v = valueOf(it);
      var x = xOf(it.timestamp) + L.between/2 + (si * calcW);
      var h = v > 0 ? L.height - yOf(v) : 0;
      var bar = sv("g", { "class":"bar", "data-ts":it.timestamp, transform:"translate(" + x.toFixed(1) + ",0)" }, g);
      var isCur = it.timestamp >= curStart;
      sv("rect", { x:0, y:(L.height - h).toFixed(1), width:calcW, height:h.toFixed(1), fill: isCur ? "url(#hatch-" + series + ")" : colorOf(series) }, bar);
      // onzichtbare, bredere tikzone
      sv("rect", { x:-L.between/2, y:0, width:calcW + L.between, height:L.height, fill:"transparent" }, bar);
    });
  });

  // x-as
  var ax = sv("g", { "class":"g-xaxis", transform:"translate(" + (isArea ? 0 : (L.step - L.between) / 2) + "," + L.height + ")" }, root);
  S.ticks.forEach(function(ts, i){
    if(i === 0) return;
    if(isHours){
      var d = new Date(ts);
      if(d.getHours() % 2 !== 0 || d.getMinutes() !== 0) return;
    }
    var t = sv("text", { x:xOf(ts), y:16, "text-anchor":"middle", fill:"#565656", "font-size":"11.5", "font-weight":"600" }, ax);
    t.textContent = xLabel(ts);
    if(isHours){ var s = sv("tspan", { dy:-4, "font-size":"8", "font-weight":"400" }, t); s.textContent = "00"; }
  });

  scroll.appendChild(svg);
  scroll.scrollLeft = sl;
  applySelection();
}
function applySelection(){
  var scroll = $g("g-scroll");
  var bars = scroll.querySelectorAll(".bar");
  for(var i=0;i<bars.length;i++){
    var on = S.selected === null || Number(bars[i].getAttribute("data-ts")) === S.selected;
    bars[i].classList.toggle("bar-inactive", !on);
  }
}

/* ---------- teksten, legenda, knoppen ---------- */
function spanLabel(ts, last){
  if(S.interval === "days") return last ? nl(ts, { day:"numeric", month:"short" }).replace(".","") : String(new Date(ts).getDate());
  if(S.interval === "months") return last ? cap(nl(ts, { month:"short" })) + " " + new Date(ts).getFullYear() : cap(nl(ts, { month:"short" }));
  if(S.interval === "years") return String(new Date(ts).getFullYear());
  var d = new Date(ts), today = startOf("day", Date.now()), dd = startOf("day", ts);
  if(dd === today) return "Vandaag";
  if(dd === add("day", today, -1)) return "Gisteren";
  return nl(ts, { weekday:"short", day:"numeric", month:"short" }).replace(/\./g,"");
}
function subtitle(){
  var scroll = $g("g-scroll");
  if(!S.L || !S.ticks.length) return "";
  if(S.selected !== null){
    var ts = S.selected;
    if(S.interval === "months") return cap(nl(ts, { month:"long", year:"numeric" }));
    if(S.interval === "days") return nl(ts, { day:"numeric", month:"long" });
    if(S.interval === "years") return String(new Date(ts).getFullYear());
    return spanLabel(ts, true);
  }
  var a = invertX(scroll.scrollLeft + (S.L.step - S.L.between));
  var b = invertX(scroll.scrollLeft + scroll.clientWidth - S.L.between);
  var fa = spanLabel(a, false), fb = spanLabel(b, true);
  if(S.interval === "days"){
    var sameMonth = new Date(a).getMonth() === new Date(b).getMonth();
    fa = spanLabel(a, !sameMonth);
  }
  if(S.interval === "months" && new Date(a).getFullYear() !== new Date(b).getFullYear()) fa = cap(nl(a, { month:"short" })) + " " + new Date(a).getFullYear();
  if(S.interval === "hours") return fb;
  return (fa !== fb) ? fa + " - " + fb : fb;
}
function uiSubtitle(){ $g("g-date").textContent = subtitle(); }
function check(on, color){
  return '<span class="g-check' + (on ? " on" : "") + '" style="' + (on ? "background:" + color : "") + '">' +
         (on ? '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.500" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>' : "") + "</span>";
}
function uiLegend(){
  var host = $g("g-legend"), html = "";
  seriesKeys().forEach(function(k){
    if(k === "production" && (isGas() || !solarOn())) return;
    var val = "";
    if(S.selected !== null && S.active[k]){
      var it = cacheFor(k).items.filter(function(i){ return i.timestamp === S.selected; })[0];
      if(it) val = displayValue(valueOf(it), S.unit);
    }
    html += '<div class="g-legend-row" data-series="' + k + '">' +
            '<div class="g-legend-label">' + check(S.active[k], colorOf(k)) + '<span>' + nameOf(k) + '</span></div>' +
            '<div class="g-legend-val">' + val + '</div></div>';
  });
  host.innerHTML = html;
}
function uiControls(){
  var isHours = S.interval === "hours";
  $g("g-meas").style.display = isHours ? "none" : "flex";
  $g("g-unitdisk").style.display = isHours ? "flex" : "none";
  $g("g-unitdisk").textContent = isGas() ? "l" : "W";
  var b = $g("g-meas").querySelectorAll("button");
  b[0].textContent = isGas() ? "m³" : "kWh";
  var ttl = $g("g-title"), multi = gasOn();
  ttl.classList.toggle("multi", multi);
  $g("g-title-text").textContent = isGas() ? "Gas" : "Stroom";
  var ico = $g("g-title-ico");
  ico.classList.toggle("gas", isGas());
  ico.innerHTML = isGas()
    ? '<path fill="#00AFBF" d="M12 2c.5 4.500-5.500 7-5.500 12.500a5.500 5.500 0 0 0 11 0c0-2.800-1.400-4.600-2.700-6.200.1 2.300-1.100 3.500-2.200 3.500C11.500 9.300 12.700 5.600 12 2z"/>'
    : '<path fill="#8E24AA" d="M13.2 2 5 13.500h5.300L9.300 22 18 10h-5.200z"/>';
  b[0].classList.toggle("sel", S.measurement === "volume");
  b[1].classList.toggle("sel", S.measurement === "costs");
  b[1].disabled = !hasPrices();
  var z = $g("g-zoom");
  z.style.display = S.zoomEnabled ? "block" : "none";
  z.firstChild.src = S.zoomed ? "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMCIgaGVpZ2h0PSIyMCIgdmlld0JveD0iMCAwIDIwIDIwIj4KICAgIDxnIGZpbGw9Im5vbmUiIGZpbGwtcnVsZT0iZXZlbm9kZCI+CiAgICAgICAgPHBhdGggZmlsbD0iIzU2NTY1NiIgZD0iTTE5LjQxNCAxNi41ODZsLTIuODAxLTIuODAxQTguOTQyIDguOTQyIDAgMCAwIDE4IDlhOSA5IDAgMCAwLTktOSA5IDkgMCAwIDAtOSA5IDkgOSAwIDAgMCA5IDkgOC45NDIgOC45NDIgMCAwIDAgNC43ODUtMS4zODdsMi44MDEgMi44MDFjLjM5LjM5MS45MDIuNTg2IDEuNDE0LjU4NmEyIDIgMCAwIDAgMS40MTQtMy40MTQiLz4KICAgICAgICA8cGF0aCBmaWxsPSIjRkZGIiBkPSJNNSA4YTEgMSAwIDAgMCAwIDJoOGExIDEgMCAwIDAgMC0ySDV6Ii8+CiAgICA8L2c+Cjwvc3ZnPgo=" : "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMCIgaGVpZ2h0PSIyMCIgdmlld0JveD0iMCAwIDIwIDIwIj4KICAgIDxnIGZpbGw9Im5vbmUiIGZpbGwtcnVsZT0iZXZlbm9kZCI+CiAgICAgICAgPHBhdGggZmlsbD0iIzU2NTY1NiIgZD0iTTE5LjQxNCAxNi41ODZsLTIuODAxLTIuODAxQTguOTQyIDguOTQyIDAgMCAwIDE4IDlhOSA5IDAgMCAwLTktOSA5IDkgMCAwIDAtOSA5IDkgOSAwIDAgMCA5IDkgOC45NDIgOC45NDIgMCAwIDAgNC43ODUtMS4zODdsMi44MDEgMi44MDFjLjM5LjM5MS45MDIuNTg2IDEuNDE0LjU4NmEyIDIgMCAwIDAgMS40MTQtMy40MTQiLz4KICAgICAgICA8cGF0aCBmaWxsPSIjRkZGIiBkPSJNMTMgOGgtM1Y1YTEgMSAwIDAgMC0yIDB2M0g1YTEgMSAwIDAgMCAwIDJoM3YzYTEgMSAwIDAgMCAyIDB2LTNoM2ExIDEgMCAwIDAgMC0yIi8+CiAgICA8L2c+Cjwvc3ZnPgo=";
  var ps = $g("g-periods").querySelectorAll("button");
  for(var i=0;i<ps.length;i++) ps[i].classList.toggle("sel", ps[i].getAttribute("data-p") === S.interval);
}
function uiLoading(){
  var anyLoading = seriesKeys().some(function(k){ return cacheFor(k).loading; });
  $g("g-spin").style.display = (anyLoading && !seriesKeys().some(function(k){ return cacheFor(k).items.length; })) ? "block" : "none";
}
function uiError(){
  var keys = activeKeys(), box = $g("g-nodata"), msg = $g("g-msg");
  var any = keys.some(function(k){ return cacheFor(k).items.length; });
  var loading = keys.some(function(k){ return cacheFor(k).loading; });
  var showErr = !any && !loading && (keys.length === 0 || keys.every(function(k){ return cacheFor(k).loaded; }));
  box.style.display = showErr ? "flex" : "none";
  if(showErr){
    msg.textContent = !hasToon() ? "Geen Toon-adres ingesteld (zie Meer › Instellingen)."
                    : isGas() ? "Geen gasgegevens ontvangen van de Toon."
                    : (S.interval === "hours" ? "Geen 5-minutenwaarden ontvangen van de Toon." : "Geen dagtellers ontvangen van de Toon.")
                      + " Controleer dit onder Status › Gegevenscontrole.";
    var img = box.querySelector("img");
    img.style.transform = "translate(0,-" + Math.max(0, (S.L.height / 2 - 2)) + "px)";
  }
}
function uiAll(){ uiControls(); uiSubtitle(); uiLegend(); uiError(); uiLoading(); }

function afterData(){
  if(!S.open) return;
  computeScale(false);
  drawYAxis(); drawContent(); uiAll();
  checkMore();
}
function redrawForced(){
  computeScale(true);
  drawYAxis(); drawContent(); uiAll();
}
function checkMore(){
  if(!S.open) return;
  var scroll = $g("g-scroll");
  seriesKeys().forEach(function(series){
    var ds = cacheFor(series);
    if(ds.loading || ds.done) return;
    if(!ds.from){ loadMore(series); return; }
    var tLeft = invertX(scroll.scrollLeft - scroll.clientWidth);
    if(tLeft < ds.from) loadMore(series);
  });
}

/* ============================================================
   ACTIES
   ============================================================ */
function setInterval_(p){
  if(p === S.interval) return;
  S.interval = p; S.selected = null; S.zoomed = false; S.yMax = 0;
  build(true);
}
function build(toEnd){
  S.ticks = ticksFor(S.interval);
  S.L = layout();
  var scroll = $g("g-scroll");
  scroll.style.marginRight = Y_MARGIN + "px";
  var old = scroll.firstChild; if(old) scroll.removeChild(old);
  computeScale(true);
  drawYAxis(); drawContent();
  if(toEnd) scroll.scrollLeft = scroll.scrollWidth;
  uiAll();
  seriesKeys().forEach(function(k){ loadMore(k); });
}

function onScroll(){
  if(S.scrollTimer) clearTimeout(S.scrollTimer);
  S.scrollTimer = setTimeout(function(){ uiSubtitle(); checkMore(); }, 50);
}
function onTap(ev){
  if(S.interval === "hours") return;
  var t = ev.target, bar = null;
  while(t && t !== ev.currentTarget){ if(t.getAttribute && t.classList && t.classList.contains("bar")){ bar = t; break; } t = t.parentNode; }
  var ts = bar ? Number(bar.getAttribute("data-ts")) : null;
  S.selected = (ts === null || ts === S.selected) ? null : ts;
  applySelection(); uiSubtitle(); uiLegend();
}

var G = {
  isOpen: function(){ return S.open; },
  open: function(opts){
    opts = opts || {};
    S.open = true;
    S.interval = opts.interval || "days";
    S.measurement = "volume"; S.zoomed = false; S.selected = null; S.yMax = 0; S.cache = {};
    S.resource = (opts.resource === "gas" && gasOn()) ? "gas" : "electricity";
    var want = opts.series || ["consumption","production"];
    S.active = { consumption: want.indexOf("consumption") >= 0, production: want.indexOf("production") >= 0 && solarOn() && !isGas() };
    if(!S.active.consumption && !S.active.production) S.active.consumption = true;
    openPage("graph");
    if(S.refreshTimer) clearInterval(S.refreshTimer);
    S.refreshTimer = setInterval(refreshLatest, 60000);
    build(true);
  },
  close: function(){
    S.open = false;
    if(S.refreshTimer){ clearInterval(S.refreshTimer); S.refreshTimer = null; }
  },
  refresh: function(){
    S.cache = {}; build(false);
  },
  gasChanged: function(){
    if(!gasOn() && isGas()){ S.resource = "electricity"; S.active.consumption = true; S.cache = {}; S.selected = null; S.yMax = 0; build(true); return; }
    uiControls();
  },
  solarChanged: function(){
    if(!solarOn()){ S.active.production = false; S.active.consumption = true; }
    S.yMax = 0; redrawForced(); checkMore();
  },
  init: function(){
    $g("g-periods").addEventListener("click", function(e){
      var b = e.target.closest ? e.target.closest("button") : null;
      if(b) setInterval_(b.getAttribute("data-p"));
    });
    $g("g-meas").addEventListener("click", function(e){
      var b = e.target.closest ? e.target.closest("button") : null;
      if(!b || b.disabled) return;
      var m = b.getAttribute("data-m");
      if(m === S.measurement) return;
      S.measurement = m; S.zoomed = false; S.selected = null; redrawForced();
    });
    $g("g-zoom").addEventListener("click", function(){ S.zoomed = !S.zoomed; redrawForced(); });
    $g("g-legend").addEventListener("click", function(e){
      var row = e.target.closest ? e.target.closest(".g-legend-row") : null;
      if(!row) return;
      var k = row.getAttribute("data-series");
      S.active[k] = !S.active[k];
      if(!seriesKeys().some(function(x){ return S.active[x]; })) S.active[k] = true;   // minimaal één serie
      S.selected = null;
      redrawForced();
      checkMore();
    });
    // Stroom / Gas kiezen (alleen als er gas is)
    var dlg = $g("g-dialog"), pick = S.resource;
    function markPick(){
      var rows = dlg.querySelectorAll(".radio-row");
      for(var i=0;i<rows.length;i++) rows[i].classList.toggle("sel", rows[i].getAttribute("data-res") === pick);
    }
    $g("g-title").addEventListener("click", function(){
      if(!gasOn()) return;
      pick = S.resource; markPick(); dlg.classList.add("open");
    });
    dlg.addEventListener("click", function(e){
      var row = e.target.closest ? e.target.closest(".radio-row") : null;
      if(row){ pick = row.getAttribute("data-res"); markPick(); return; }
      if(e.target === dlg) dlg.classList.remove("open");
    });
    $g("g-dialog-ok").addEventListener("click", function(){
      dlg.classList.remove("open");
      if(pick === S.resource) return;
      S.resource = pick; S.selected = null; S.zoomed = false; S.yMax = 0; S.measurement = "volume";
      S.active = { consumption:true, production: pick === "electricity" && solarOn() };
      build(true);
    });
    var scroll = $g("g-scroll");
    scroll.addEventListener("scroll", onScroll, { passive:true });
    scroll.addEventListener("click", onTap);
    $g("graph-back").addEventListener("click", function(){ closePage(); });
    window.addEventListener("resize", function(){ if(S.open) build(true); });
  }
};
window.G = G;
})();

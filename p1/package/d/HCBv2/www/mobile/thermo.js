/* thermo.js - vlam-icoon van de ketel, zoals in de originele Toon-app
   (uit / klein / middel / groot naar de modulatie, kraantje bij warm water, rood bij storing) */
(function(){
"use strict";
var FLAME_PATH = "M10.617 2.076c.375-.155.804-.07 1.09.217 1.555 1.555 2.547 3.245 3.18 4.772.308-.879.722-1.782 1.281-2.62.245-.366.7-.53 1.122-.402.421.127.71.517.71.957 0 1.827.458 2.987.943 4.215C19.462 10.532 20 11.893 20 14c0 4.411-3.589 8-8 8s-8-3.589-8-8c0-4.11 2.069-7.4 2.157-7.538.239-.375.697-.545 1.123-.422.427.125.72.516.72.96 0 1.592.301 2.87.553 3.66C9.41 9.584 10 6.138 10 3c0-.404.244-.769.617-.924zM12 14c-.406 0-.772.246-.926.622C10.584 15.822 10 17.382 10 18c0 1.103.897 2 2 2s2-.897 2-2c0-.619-.584-2.179-1.074-3.378-.154-.376-.52-.622-.926-.622z";
var FLAME_SMALL = "M12 19c-1.103 0-2-.896-2-2 0-.618.584-2.178 1.074-3.377.154-.376.52-.622.926-.622s.772.246.926.622C13.416 14.822 14 16.382 14 17c0 1.103-.897 2-2 2m-.293-15.707c-.287-.287-.716-.373-1.09-.217-.373.155-.617.52-.617.924 0 .827-.744 3.28-1.401 5.447C7.777 12.16 7 14.72 7 16c0 2.757 2.243 5 5 5s5-2.243 5-5c0-2.553-3.164-10.578-5.293-12.707";
var FLAME_MEDIUM = "M12 20c-1.103 0-2-.897-2-2 0-.619.584-2.179 1.074-3.378.154-.376.52-.622.926-.622s.772.246.926.622C13.416 15.822 14 17.382 14 18c0 1.103-.897 2-2 2m5.4-9.235C16.275 8.937 15 6.865 15 3c0-.412-.252-.782-.636-.932-.384-.15-.821-.049-1.099.255-.551.598-1.98 2.182-3.496 4.087-.353-.763-.662-1.413-.867-1.842-.202-.422-.669-.648-1.124-.543C7.323 4.128 7 4.533 7 5c0 1.591-.658 4.082-1.187 6.083C5.359 12.804 5 14.164 5 15c0 3.86 3.14 7 7 7s7-3.14 7-7c0-1.633-.777-2.897-1.6-4.235";
var TAP_TAP = "M8 10v1h1c3.86 0 7 3.14 7 7v1c0 .552-.448 1-1 1h-2c-.552 0-1-.448-1-1v-1c0-1.654-1.346-3-3-3H8c0 1.104-.896 2-2 2s-2-.896-2-2H1c-.552 0-1-.448-1-1v-2c0-.552.448-1 1-1h3v-1h4zM6 4c.738 0 1.376.405 1.723 1H10c.552 0 1 .448 1 1s-.448 1-1 1H7.723C7.376 7.595 6.738 8 6 8c-.738 0-1.376-.405-1.723-1H2c-.552 0-1-.448-1-1s.448-1 1-1h2.277c.347-.595.985-1 1.723-1z";
var TAP_FLAME = "M16.5 9c-.552 0-1-.448-1-1 0-.309.292-1.089.537-1.689.077-.188.26-.31.463-.31s.386.122.463.31c.245.6.537 1.38.537 1.69 0 .551-.448 1-1 1m2.7-4.618C18.638 3.468 18 2.433 18 .5c0-.206-.126-.39-.318-.466-.192-.075-.411-.024-.55.128-.275.298-.989 1.09-1.748 2.043-.176-.38-.33-.706-.433-.92-.101-.212-.335-.325-.562-.272-.227.051-.389.254-.389.487 0 .796-.329 2.041-.593 3.042C13.18 5.402 13 6.082 13 6.5c0 1.93 1.57 3.5 3.5 3.5S20 8.43 20 6.5c0-.816-.389-1.448-.8-2.117";

function flameKind(d){
  if(!d) return "off";
  var burner = String(d.burnerInfo), ot = !!parseInt(d.haveOTBoiler), mod = parseFloat(d.currentModulationLevel);
  if(!ot) return burner === "0" ? "off" : "medium";
  var err = (d.hasBoilerFault === null || d.hasBoilerFault === undefined) ? (d.errorFound !== undefined && parseInt(d.errorFound) !== 255)
                                                                          : parseInt(d.hasBoilerFault) !== 0;
  if(d.otCommError !== undefined && String(d.otCommError) !== "0") err = true;
  if(err) return "err";
  if(burner === "0") return "off";
  if(burner === "2") return "tap";
  if(burner === "1" || burner === "3"){
    if(mod > 70) return "large";
    if(mod > 35) return "medium";
    if(mod >= 0) return "small";
  }
  return "err";
}
function flameSvg(kind){
  if(kind === "tap") return '<svg viewBox="0 0 24 24"><g transform="translate(2 2)"><path fill="#565656" d="' + TAP_TAP + '"/><path fill="#E64F0A" d="' + TAP_FLAME + '"/></g></svg>';
  var p = kind === "small" ? FLAME_SMALL : kind === "medium" ? FLAME_MEDIUM : FLAME_PATH;
  return '<svg viewBox="0 0 24 24"><path d="' + p + '"/></svg>';
}
function setFlame(d){
  var k = flameKind(d);
  var cls = (k === "off") ? "off" : (k === "err" ? "err" : "on");
  var e = document.getElementById("thermo-flame"); if(!e) return;
  if(e.getAttribute("data-k") !== k){ e.innerHTML = flameSvg(k); e.setAttribute("data-k", k); }
  e.className = "thermo-flame " + cls;
}


window.Flame = { set: setFlame };
})();

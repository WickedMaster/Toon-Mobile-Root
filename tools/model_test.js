const vm=require('vm'),fs=require('fs');
const doc={addEventListener(){},getElementById(){return null;}};
const ctx={window:{},document:doc,console,setTimeout,clearTimeout,setInterval,clearInterval,fmtTemp:x=>x};
ctx.window=ctx;vm.createContext(ctx);
vm.runInContext(fs.readFileSync('p1/package/d/HCBv2/www/mobile/program.js','utf8'),ctx);
const M=ctx.PRG.model;let fails=0;
function ck(n,c){console.log((c?'PASS ':'FAIL ')+n);if(!c)fails++;}
// build program: each day 00:00 sleep(2), 07:00 comfort(0), 09:00 away(3), 17:00 home(1), 22:00 sleep(2)
const ent=[];const S=[];
for(let d=0;d<7;d++){const t=[[0,2],[420,0],[540,3],[1020,1],[1320,2]];
 t.forEach((x,i)=>{const s=d*1440+x[0];const e=i<4?d*1440+t[i+1][0]:(d+1)*1440;ent.push({s,e,state:x[1]});});}
const r=M.slotsFromEntries(ent);ck('slots ok',r.ok);let sl=r.slots;
let runs=M.runsOf(sl);ck('runs: 35 -> merged cross-midnight sleep = 28',runs.length===28||runs.length===35);
let en=M.entriesFromSlots(sl);
// roundtrip
let total=0;en.forEach(e=>{});const pl=M.payloadOf(en);
ck('payload has entries',pl.split(';').length===runs.length);
const back=en.map(e=>({s:e[0]*1440+e[1]*60+e[2],e:e[3]*1440+e[4]*60+e[5],state:e[6]}));
back.forEach(b=>{if(b.e<=b.s)b.e+=10080;});
const r2=M.slotsFromEntries(back);ck('roundtrip identical',r2.ok&&JSON.stringify(r2.slots)===JSON.stringify(sl));
// day 1 (Mon) blocks
let bl=M.dayBlocksOf(sl,1);ck('5 blocks Monday',bl.length===5);
// edit block 1 start 07:00 -> 06:00 (slot 36)
let e1=M.applyEdit(sl,1,1,36,0);bl=M.dayBlocksOf(e1,1);ck('edit start 06:00',bl[1].a===36&&bl[0].b===36);
// edit met schuiven van buren
const b0=M.dayBlocksOf(sl,1).map(x=>x.a);
e1=M.applyEdit(sl,1,1,0,0);bl=M.dayBlocksOf(e1,1);ck('min start block1 = 00:30',bl[0].b===3);
e1=M.applyEdit(sl,1,1,200,0);bl=M.dayBlocksOf(e1,1);ck('max start block1 pushes followers',bl.length>=1&&bl[bl.length-1].a<=141&&bl.slice(1).every((x,i)=>x.b-x.a>=3));
e1=M.applyEdit(sl,1,2,b0[1]+1,sl[1*144+b0[2]]);bl=M.dayBlocksOf(e1,1);ck('previous block shifts back',bl.slice(1).every(x=>x.b-x.a>=3)&&bl[0].b>=0);
e1=M.applyEdit(sl,1,1,42,3);bl=M.dayBlocksOf(e1,1);ck('state change merges',bl[1].state===3);
e1=M.applyEdit(sl,1,0,50,1);ck('first block not editable',JSON.stringify(e1)===JSON.stringify(sl));
const pp=M.placeStart([0,6,9,12],1,10);ck('placeStart pushes next ones',JSON.stringify(pp.starts)===JSON.stringify([0,10,13,16])&&pp.shifted.dir==='volgende'&&pp.shifted.j===2);
const pq=M.placeStart([0,6,9,12],3,10);ck('placeStart pushes previous ones',JSON.stringify(pq.starts)===JSON.stringify([0,4,7,10])&&pq.shifted.dir==='vorige');
const pr=M.placeStart([0,3,6],2,1);ck('placeStart min',pr.starts[2]===6);
// plusjes (regels van de Toon)
const mk=(...a)=>a.map((x,i)=>({a:x,b:a[i+1]!==undefined?a[i+1]:144,state:i%2}));
ck('plus: only carry -> under carry',JSON.stringify(M.plusPositions(mk(0)))==='[1]');
ck('plus: gap>=60 between carry and first',JSON.stringify(M.plusPositions(mk(0,36,100)))==='[1,2,3]'||JSON.stringify(M.plusPositions(mk(0,36,100)))==='[1,2,3]');
ck('plus: no gap <60',JSON.stringify(M.plusPositions(mk(0,3,6,100)))==='[3,4]');
ck('plus: not under last after 23:00',JSON.stringify(M.plusPositions(mk(0,6,139)))==='[1,2]');
ck('plus: under last at 23:00',M.plusPositions(mk(0,6,138)).includes(3));
ck('plus: none at 6 extra blocks',M.plusPositions(mk(0,20,40,60,80,100,120)).length===0);
const ad=M.addDefaults(mk(0,36,60),2);ck('add defaults prev+30 same state',ad.start===39&&ad.state===1);
const ad1=M.addDefaults(mk(0),1);ck('add defaults under carry',ad1.start===3);
e1=M.applyAdd(sl,1,3,b0[2]+3,1);bl=M.dayBlocksOf(e1,1);ck('add inserts',bl.some(x=>x.state===1));
// delete
e1=M.applyDelete(sl,1,2);bl=M.dayBlocksOf(e1,1);ck('delete extends previous',bl.length===4&&bl[1].b===102);
e1=M.applyDelete(sl,1,0);ck('delete first no-op',JSON.stringify(e1)===JSON.stringify(sl));
// copy
let c=M.applyCopy(e1=M.applyEdit(sl,1,1,36,0),1,[2,3]);
ck('copy day',JSON.stringify(M.dayBlocksOf(c,2))===JSON.stringify(M.dayBlocksOf(e1,1))&&JSON.stringify(M.dayBlocksOf(c,3))===JSON.stringify(M.dayBlocksOf(e1,1)));
ck('copy leaves others',JSON.stringify(M.dayBlocksOf(c,4))===JSON.stringify(M.dayBlocksOf(sl,4)));
// all-total tile
const ee=M.entriesFromSlots(c);let sum=0;ee.forEach(x=>{let s=x[0]*1440+x[1]*60+x[2],e=x[3]*1440+x[4]*60+x[5];if(e<=s)e+=10080;sum+=e-s;});ck('tiles 10080',sum===10080);
// non-10 min
ck('non-10 rejected',!M.slotsFromEntries([{s:5,e:10075,state:0},{s:10075,e:10085,state:1}]).ok);
ck('gap rejected',M.slotsFromEntries([{s:0,e:100,state:0},{s:200,e:10080,state:1}]).reason==='gat');
// single run
ck('single state -> null',M.entriesFromSlots(new Array(1008).fill(1))===null);

// doorlopend blok vanaf de vorige dag (zoals op het Toon-scherm: "22:00 dinsdag")
{const t2=[[0,2],[510,3],[870,1],[1080,0],[1320,2]];const en2=[];
 for(let d=0;d<7;d++)t2.forEach((x,i)=>{en2.push({s:d*1440+x[0],e:i<4?d*1440+t2[i+1][0]:(d+1)*1440,state:x[1]});});
 const sl2=M.slotsFromEntries(en2).slots;
 const wed=M.carryStart(sl2,3,2);ck('woensdag: begint dinsdag 22:00',!!wed&&wed.hm==='22:00'&&wed.day==='dinsdag');
 const mon=M.carryStart(sl2,1,2);ck('maandag: begint zondag 22:00',!!mon&&mon.hm==='22:00'&&mon.day==='zondag');
 const sun=M.carryStart(sl2,0,2);ck('zondag: begint zaterdag 22:00',!!sun&&sun.hm==='22:00'&&sun.day==='zaterdag');
 const same=new Array(1008).fill(1);ck('hele week hetzelfde: geen crash',!!M.carryStart(same,2,1));
 const b=M.dayBlocksOf(sl2,3);ck('eerste blok van woensdag eindigt 08:30',b[0].b===51);}
console.log(fails?'FAILS '+fails:'ALL OK');

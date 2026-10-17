/* ================= ADMIN =================
   Tabbed console: Deck / Content / Flights / Catalogues / System.
   Each tab's editors build ONCE, the first time the tab is opened —
   an admin page load no longer builds ~200 catalogue entries.
   Saves are unchanged: validate → write the section into CONTENT →
   saveContent (the whole-object PUT) → re-render the public sections
   live → show "Saved". Food and Buds are searchable grids whose rows
   expand into the same full editors the old <details> cards carried;
   the harvest reads the same field classes from the expanded rows. */
(function(){
function $(id){return document.getElementById(id)}
function val(el){return el?el.value.trim():''}
function isHttp(u){return /^https?:\/\//i.test(u||'')}
function isNumStr(x){return x!==''&&!isNaN(Number(String(x).replace(/[$,\s]/g,'')))}
function showErr(key,msg){
 var e=document.querySelector('[data-err="'+key+'"]');
 if(e){e.textContent=msg||'';e.hidden=!msg;}
 return !msg;
}
function showSaved(key){
 var sEl=document.querySelector('[data-saved="'+key+'"]');
 if(!sEl)return;
 sEl.hidden=false;
 setTimeout(function(){sEl.hidden=true},2200);
}
function F(label,inner){return '<div class="adm-f"><label>'+label+'</label>'+inner+'</div>'}
function inp(cls,value,extra){return '<input class="adm-inp '+cls+'" type="text" value="'+cEsc(value==null?'':value)+'" '+(extra||'')+'>'}
/* Copy fields whose values can outgrow one line are TEXTAREAS, not
   inputs: iOS paints only the slice of an <input> value that fits
   its width, so long lines (next-up, stay intro, names, URLs) were
   silently clipped regardless of the box armour. txa() builds the
   single-line-intent variant — class hooks identical to the inputs
   they replace, so harvest/validation paths are untouched; Enter is
   suppressed on .adm-one (below) so the saved value stays one line,
   exactly as it did in an <input>. admGrowTa sizes the box to its
   content: the whole value shows at rest, no inner scrollbar. */
function txa(cls,value,extra){return '<textarea class="adm-ta adm-tauto adm-one '+cls+'" rows="1" '+(extra||'')+'>'+cEsc(value==null?'':value)+'</textarea>'}
function admGrowTa(el){
 if(!el||el.tagName!=='TEXTAREA')return;
 el.style.height='auto';
 el.style.height=(el.scrollHeight+2)+'px';
}
function admGrowAll(scope){
 (scope||document).querySelectorAll('textarea.adm-tauto').forEach(function(el){
   if(el.getClientRects().length)admGrowTa(el);
 });
}
document.addEventListener('input',function(ev){
 var t=ev.target;
 if(t&&t.classList&&t.classList.contains('adm-tauto'))admGrowTa(t);
});
document.addEventListener('keydown',function(ev){
 var t=ev.target;
 if(ev.key==='Enter'&&t&&t.classList&&t.classList.contains('adm-one'))ev.preventDefault();
});
document.addEventListener('toggle',function(ev){
 var d=ev.target;
 if(d&&d.open)admGrowAll(d);
},true);
window.addEventListener('resize',function(){admGrowAll(document);});
function fmtTime(t){
 if(!t)return '';
 var m=/^(\d{1,2}):(\d{2})/.exec(t); if(!m)return t;
 var h=Number(m[1]),ap=h>=12?'PM':'AM'; h=h%12; if(h===0)h=12;
 return h+':'+m[2]+' '+ap;
}
function fmtDay(iso){
 if(!iso)return '';
 var d=new Date(iso+'T12:00:00');
 if(isNaN(d.getTime()))return iso;
 return d.toLocaleDateString('en-CA',{weekday:'short',month:'short',day:'numeric'});
}
function fmtMoney(cents){
 return '$'+(cents/100).toLocaleString('en-CA',{minimumFractionDigits:2,maximumFractionDigits:2});
}

/* ---------- Tabs ---------- */
var builtTabs={};
function buildTab(name){
 if(builtTabs[name])return;
 builtTabs[name]=true;
 if(name==='content')buildContent();
 else if(name==='flights')loadAdminFlights();
 else if(name==='catalogues')buildCatalogues();
}
function switchTab(name){
 document.querySelectorAll('.adm-tab').forEach(function(t){
   var on=t.getAttribute('data-atab')===name;
   t.classList.toggle('on',on); t.setAttribute('aria-selected',on?'true':'false');
 });
 document.querySelectorAll('.adm-panel').forEach(function(p){
   p.hidden=p.getAttribute('data-apanel')!==name;
 });
 buildTab(name);
 if(name==='deck'||name==='system')loadAdminState();
 requestAnimationFrame(function(){admGrowAll(document);});
 var sec=$('admin'); if(sec)sec.scrollIntoView({block:'start'});
}
document.querySelectorAll('.adm-tab').forEach(function(t){
 t.addEventListener('click',function(){switchTab(t.getAttribute('data-atab'));});
});
document.querySelectorAll('.adm-irow').forEach(function(r){
 r.addEventListener('click',function(){switchTab(r.getAttribute('data-goto'));});
});

/* ---------- Deck + system state ---------- */
var ADM_STATE=null;
function setTxt(id,txt){var el=$(id); if(el)el.textContent=txt;}
function setPill(id,txt,cls){var el=$(id); if(!el)return; el.textContent=txt; el.className='adm-pill'+(cls?' '+cls:'');}
function renderState(s){
 ADM_STATE=s;
 setTxt('admWhoTxt','SIGNED IN AS '+(s.you.name||'').toUpperCase()+' · ADMIN · MOIZ IS THE ONLY OTHER ADMIN');
 // Content source
 if(s.content.source==='saved'){
   setTxt('tileContentV','Saved copy');
   setTxt('tileContentD','A saved server copy is live'+(s.content.savedAt?(' · saved '+new Date(s.content.savedAt).toLocaleString('en-CA',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})):'')+'. Edits outrank the shipped defaults.');
   setPill('tileContentPill','LIVE','g');
 }else{
   setTxt('tileContentV','Built-in');
   setTxt('tileContentD','No saved server copy. The site runs the shipped defaults.');
   setPill('tileContentPill','LIVE','g');
 }
 // Flights
 setPill('tileFlightsPill',String(s.flights.count),'g');
 if(s.flights.next){
   var n=s.flights.next;
   setTxt('tileFlightsV',n.flightNumber||'—');
   setTxt('tileFlightsD',(n.upcoming?'Next movement: ':'Last movement: ')+(n.person||'')+' · '+(n.originCode||'')+' → '+(n.destinationCode||'')+' · '+fmtDay(n.departureDate)+(n.departureTime?(' · dep '+fmtTime(n.departureTime)):'')+(n.arrivalTime?(' · lands '+fmtTime(n.arrivalTime)):''));
 }else{
   setTxt('tileFlightsV','—');
   setTxt('tileFlightsD','No flights in the store yet.');
 }
 // Ledger
 setTxt('tileLedgerV',fmtMoney(s.ledger.totalCentsCAD));
 setTxt('tileLedgerD',s.ledger.expenseCount+' expense'+(s.ledger.expenseCount===1?'':'s')+' · '+s.ledger.settlementCount+' settlement'+(s.ledger.settlementCount===1?'':'s')+' recorded.');
 // Photos
 setTxt('tilePhotosV',String(s.photos.count));
 setTxt('tilePhotosD',s.photos.count===1?'Photo on the wall.':'Photos on the wall.');
 // Keys (presence only)
 if(s.keys.googlePlaces){ setTxt('tilePlacesV','Photos on'); setTxt('tilePlacesD','Restaurant photos resolve live through Google Places.'); setPill('tilePlacesPill','SET','g'); }
 else{ setTxt('tilePlacesV','Photos off'); setTxt('tilePlacesD','No Places key on the server — food cards fall back to their stills.'); setPill('tilePlacesPill','MISSING','r'); }
 if(s.keys.aeroapi){ setTxt('tileAeroV','Status on'); setTxt('tileAeroD','Live flight status can poll AeroAPI.'); setPill('tileAeroPill','SET','g'); }
 else{ setTxt('tileAeroV','Status off'); setTxt('tileAeroD','Flight status waits on the AeroAPI key.'); setPill('tileAeroPill','MISSING',''); }
 // Editors index counts (content counts read the local CONTENT copy)
 setTxt('idxDays',CONTENT.days.length+' days');
 setTxt('idxStay',CONTENT.trip.heroDates||'');
 setTxt('idxFood',CONTENT.food.length+' spots · '+CONTENT.foodCats.length+' cats');
 setTxt('idxBuds',CONTENT.buds.length+' products');
 setTxt('idxFlights',s.flights.count+' records');
 setTxt('idxFifa',CONTENT.fifaTeams.length+' teams');
 setTxt('idxSplit',CONTENT.splitPeople.length+' people');
 // System detail
 var rows=[
  ['Content source',s.content.source==='saved'?('Saved copy live'+(s.content.savedAt?(' · saved '+new Date(s.content.savedAt).toLocaleString('en-CA')):'')):'Built-in defaults (no saved copy)'],
  ['Flights store',s.flights.count+' records'+(s.flights.next?(' · '+(s.flights.next.upcoming?'next':'last')+': '+s.flights.next.flightNumber+' '+s.flights.next.departureDate):'')],
  ['Split ledger',s.ledger.expenseCount+' expense'+(s.ledger.expenseCount===1?'':'s')+' · '+s.ledger.settlementCount+' settlement'+(s.ledger.settlementCount===1?'':'s')+' · '+fmtMoney(s.ledger.totalCentsCAD)+' total'],
  ['Photo wall',s.photos.count+' photos'],
  ['Google Places key',s.keys.googlePlaces?'Set':'Missing'],
  ['AeroAPI key',s.keys.aeroapi?'Set':'Missing'],
  ['Signed in as',(s.you.name||'')+(s.you.person?(' ('+s.you.person+')'):'')],
 ];
 var sys=$('admSysList');
 if(sys)sys.innerHTML=rows.map(function(r){
   return '<div class="adm-sys-row"><span class="adm-sys-k">'+cEsc(r[0])+'</span><span class="adm-sys-v">'+cEsc(r[1])+'</span></div>';
 }).join('');
}
function loadAdminState(){
 fetch('/api/admin/state').then(function(r){return r.ok?r.json():null}).then(function(s){
   if(s)renderState(s);
 }).catch(function(){});
}
var refreshBtn=$('admStateRefresh');
if(refreshBtn)refreshBtn.addEventListener('click',loadAdminState);

/* ---------- Console activation (first time the view is shown) ---------- */
var viewEl=$('view-admin');
function consoleShown(){return !!(viewEl&&!viewEl.hidden);}
function activateConsole(){buildTab('deck');loadAdminState();}
if(viewEl){
 new MutationObserver(function(){if(consoleShown())activateConsole();})
   .observe(viewEl,{attributes:true,attributeFilter:['hidden']});
 if(consoleShown())activateConsole();
}

/* ---------- Content tab builders ---------- */
function buildContent(){
 /* Trip */
 $('admTarget').value=CONTENT.trip.targetISO||'';
 $('admHeroDates').value=CONTENT.trip.heroDates||'';
 $('admNextUp').value=CONTENT.trip.nextUpDefault||'';
 /* Days */
 $('admDaysList').innerHTML=CONTENT.days.map(dayBlock).join('');
 /* Stay */
 var s=CONTENT.stay;
 $('admStayUrl').value=s.airbnbUrl||''; $('admStayIntro').value=s.intro||'';
 $('admStayRating').value=s.rating||''; $('admStayHost').value=s.hostLine||'';
 $('admStaySleeps').value=s.sleeps||''; $('admStayBedrooms').value=s.bedrooms||'';
 $('admStayBeds').value=s.beds||''; $('admStayBaths').value=s.baths||'';
 $('admStayCheckIn').value=s.checkIn||''; $('admStayCheckOut').value=s.checkOut||'';
 $('admPriceNight').value=s.pricePerNight||''; $('admPriceNights').value=s.priceNights||'';
 $('admPriceDiscount').value=s.priceDiscount||''; $('admPriceTaxes').value=s.priceTaxes||'';
 $('admPriceTotal').value=s.priceTotal||'';
 $('admStayRules').value=(s.rules||[]).join('\n');
 $('admStayAmen').value=(s.amenities||[]).join('\n');
 $('admStayNote').value=s.detailsNote||'';
 /* FIFA */
 $('admFifaList').innerHTML=CONTENT.fifaTeams.map(fifaBlock).join('');
 /* Split people */
 $('admSplitList').innerHTML=CONTENT.splitPeople.map(function(p){
  return '<div class="adm-grid"><div class="adm-f"><label>Name</label>'+inp('p-name',p.name)+'</div>'
   +'<div class="adm-f"><label>Home currency</label><select class="adm-sel p-home"><option value="CAD"'+(p.home==='CAD'?' selected':'')+'>CAD</option><option value="USD"'+(p.home==='USD'?' selected':'')+'>USD</option></select></div></div>';
 }).join('');
 admGrowAll(document);
}
function dayBlock(d,i){
 var cin='';
 if(d.cinema&&d.cinema.length){
   cin='<div class="adm-f"><label>Cinema links (Saturday)</label>'+d.cinema.map(function(m){
     return '<div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap"><textarea class="adm-ta adm-tauto adm-one d-cin-label" rows="1" placeholder="Label" style="flex:1;min-width:130px">'+cEsc(m.label)+'</textarea><textarea class="adm-ta adm-tauto adm-one d-cin-url" rows="1" placeholder="https://…" style="flex:2;min-width:180px">'+cEsc(m.url)+'</textarea></div>';
   }).join('')+'</div>';
 }
 return '<details class="adm-entry" '+(i===0?'open':'')+'><summary>Day '+(i+1)+' — '+cEsc(d.title||'')+' <span class="adm-sum-sub">'+cEsc(d.dow||'')+' '+cEsc(d.dnum||'')+'</span></summary><div class="adm-entry-body">'
  +'<div class="adm-grid">'
  +F('Weekday label',inp('d-dow',d.dow))
  +F('Day number',inp('d-dnum',d.dnum))
  +F('Month label',inp('d-dmon',d.dmon))
  +F('Date', '<input class="adm-inp d-date" type="date" value="'+cEsc(d.dateISO||'')+'">')
  +'</div>'
  +F('Chip',txa('d-chip',d.chip))
  +F('Title',txa('d-title',d.title))
  +F('Bullets (one per line)','<textarea class="adm-ta adm-tauto d-bullets">'+cEsc((d.bullets||[]).join('\n'))+'</textarea>')
  +cin
  +'</div></details>';
}
var LOGO_OPTS=[['samad','Samad'],['kaptaan','Kaptaan'],['moiz','Moiz'],['moose','Moose'],['killer','Killer'],['deception','Deception']];
function fifaBlock(t,ti){
 var members=t.members.map(function(m,mi){
   var opts=LOGO_OPTS.map(function(o){return '<option value="'+o[0]+'"'+(m.logo===o[0]?' selected':'')+'>'+o[1]+'</option>'}).join('');
   return '<div class="adm-grid">'+F('Member '+(mi+1)+' name',inp('t-mname',m.name))+F('Member '+(mi+1)+' logo','<select class="adm-sel t-mlogo">'+opts+'</select>')+'</div>';
 }).join('');
 return '<div class="adm-entry" style="padding:14px 15px 4px"><div class="adm-f"><label>Team '+(ti+1)+' name</label>'+inp('t-def',t.def)+'</div>'+members+'</div>';
}

/* ---------- Catalogues: Food grid ---------- */
function halalBadge(note){
 var n=(note||'').toLowerCase();
 if(/partial|⚠|ask staff|ask about/.test(n))return {txt:'PARTIAL',cls:'p'};
 if(/zabihah|hand[- ]slaughter/.test(n))return {txt:'ZABIHAH',cls:'g'};
 if(/certif/.test(n))return {txt:'CERTIFIED',cls:'g'};
 if(/fully halal|entire menu is halal|whole menu is halal|100% halal|all halal/.test(n))return {txt:'FULLY',cls:'g'};
 if(/halal/.test(n))return {txt:'HALAL',cls:'g'};
 return {txt:'—',cls:''};
}
function foodEditorHtml(f){
 var checks=CONTENT.foodCats.map(function(c){
   return '<label class="adm-check"><input type="checkbox" class="f-cat" value="'+c.id+'"'+((f.cats||[]).indexOf(c.id)>=0?' checked':'')+'>'+cEsc(c.label)+'</label>';
 }).join('');
 return F('Name',txa('f-name',f.name))
  +F('Area',txa('f-area',f.area))
  +'<div class="adm-grid">'+F('Stars (e.g. 4.7)',inp('f-stars',f.stars,'inputmode="decimal"'))+F('Review count (e.g. 3,221)',inp('f-reviews',f.reviews))+'</div>'
  +F('Halal note','<textarea class="adm-ta adm-tauto f-note" style="min-height:72px">'+cEsc(f.note||'')+'</textarea>')
  +F('Maps URL',txa('f-url',f.url))
  +'<div class="adm-f"><label>Categories</label><div class="adm-checks">'+checks+'</div></div>'
  +'<button type="button" class="adm-del f-del">Delete this spot</button>';
}
function foodRowHtml(f){
 var badge=halalBadge(f.note);
 return '<div class="adm-grow" data-frow>'
  +'<div class="adm-grow-main adm-gcols-food">'
  +'<label class="adm-gcheck"><input type="checkbox" class="f-sel" aria-label="Select spot"></label>'
  +'<span class="adm-gc adm-gc-name">'+cEsc(f.name||'New spot')+'</span>'
  +'<span class="adm-gc adm-gc-area">'+cEsc(f.area||'')+'</span>'
  +'<span class="adm-gc"><span class="adm-tag '+badge.cls+'">'+badge.txt+'</span></span>'
  +'<span class="adm-gc adm-gc-num adm-gc-cats">'+((f.cats||[]).length)+'</span>'
  +'</div>'
  +'<div class="adm-gexpand adm-entry-body" hidden>'+foodEditorHtml(f)+'</div>'
  +'</div>';
}
function foodRowSync(row){
 var name=val(row.querySelector('.f-name'))||'New spot';
 row.querySelector('.adm-gc-name').textContent=name;
 row.querySelector('.adm-gc-area').textContent=val(row.querySelector('.f-area'));
 row.querySelector('.adm-gc-cats').textContent=row.querySelectorAll('.f-cat:checked').length;
 var badge=halalBadge(val(row.querySelector('.f-note')));
 var tag=row.querySelector('.adm-tag');
 tag.textContent=badge.txt; tag.className='adm-tag '+badge.cls;
}
function foodSelSync(){
 var n=0;
 document.querySelectorAll('#admFoodGrid [data-frow]:not([hidden]) .f-sel:checked').forEach(function(){n++;});
 $('admFoodSelN').textContent=n;
 $('admFoodSelBar').hidden=n===0;
 var all=$('admFoodAll');
 var vis=document.querySelectorAll('#admFoodGrid [data-frow]:not([hidden]) .f-sel');
 all.checked=vis.length>0&&n===vis.length;
}
function foodFilter(){
 var q=val($('admFoodSearch')).toLowerCase();
 var cat=$('admFoodCat').value;
 var rows=document.querySelectorAll('#admFoodGrid [data-frow]'),shown=0;
 rows.forEach(function(r){
   var name=val(r.querySelector('.f-name')).toLowerCase();
   var okQ=!q||name.indexOf(q)>=0;
   var okC=!cat||cat==='all'||!!r.querySelector('.f-cat[value="'+cat+'"]:checked');
   r.hidden=!(okQ&&okC);
   if(r.hidden){var sel=r.querySelector('.f-sel'); if(sel)sel.checked=false;}
   else shown++;
 });
 $('admFoodCount').textContent='Showing '+shown+' of '+rows.length+' spots';
 foodSelSync();
}
function foodCountsOnly(){
 var rows=document.querySelectorAll('#admFoodGrid [data-frow]');
 var shown=0; rows.forEach(function(r){if(!r.hidden)shown++;});
 $('admFoodCount').textContent='Showing '+shown+' of '+rows.length+' spots';
 foodSelSync();
}
function bindFoodGrid(){
 var grid=$('admFoodGrid');
 grid.addEventListener('click',function(ev){
   var del=ev.target.closest?ev.target.closest('.f-del'):null;
   if(del){var row=del.closest('[data-frow]'); if(row){row.remove(); foodCountsOnly();} return;}
   if(ev.target.closest&&ev.target.closest('.adm-gexpand'))return;
   if(ev.target.closest&&ev.target.closest('.adm-gcheck'))return;
   var main=ev.target.closest?ev.target.closest('.adm-grow-main'):null;
   if(!main)return;
   var row=main.closest('[data-frow]');
   var exp=row.querySelector('.adm-gexpand');
   var open=exp.hidden;
   exp.hidden=!open;
   row.classList.toggle('open',open);
   if(open)admGrowAll(row);
   if(!open)foodRowSync(row);
 });
 grid.addEventListener('change',function(ev){
   if(ev.target.classList&&ev.target.classList.contains('f-sel'))foodSelSync();
   var row=ev.target.closest?ev.target.closest('[data-frow]'):null;
   if(row&&(ev.target.classList.contains('f-cat')))foodRowSync(row);
 });
 grid.addEventListener('input',function(ev){
   var row=ev.target.closest?ev.target.closest('[data-frow]'):null;
   if(!row)return;
   if(ev.target.classList.contains('f-name')||ev.target.classList.contains('f-area')||ev.target.classList.contains('f-note'))foodRowSync(row);
 });
 $('admFoodSearch').addEventListener('input',foodFilter);
 $('admFoodCat').addEventListener('change',foodFilter);
 $('admFoodAll').addEventListener('change',function(){
   var on=$('admFoodAll').checked;
   document.querySelectorAll('#admFoodGrid [data-frow]:not([hidden]) .f-sel').forEach(function(c){c.checked=on;});
   foodSelSync();
 });
 $('admFoodBulkDel').addEventListener('click',function(){
   document.querySelectorAll('#admFoodGrid [data-frow] .f-sel:checked').forEach(function(c){
     var row=c.closest('[data-frow]'); if(row)row.remove();
   });
   foodFilter();
 });
 $('admFoodAdd').addEventListener('click',function(){
   var wrap=document.createElement('div');
   wrap.innerHTML=foodRowHtml({name:'',area:'',stars:'',reviews:'',note:'',cats:['breakfast'],url:''});
   var node=wrap.firstChild;
   grid.appendChild(node);
   var exp=node.querySelector('.adm-gexpand'); exp.hidden=false; node.classList.add('open');
   foodFilter(); admGrowAll(node);
   var nm=node.querySelector('.f-name'); if(nm){nm.focus(); nm.scrollIntoView({block:'center'});}
 });
}

/* ---------- Catalogues: Buds grid ---------- */
function budEditorHtml(p){
 function rng(v){return v?(v.join(' – ')):''}
 return F('Name',txa('b-name',p.n))
  +F('Brand',inp('b-brand',p.b))
  +'<div class="adm-grid">'
  +F('Category','<select class="adm-sel b-cat"><option value="flower"'+(p.c==='flower'?' selected':'')+'>Flower</option><option value="preroll"'+(p.c==='preroll'?' selected':'')+'>Pre-Rolls</option><option value="edible"'+(p.c==='edible'?' selected':'')+'>Edibles</option></select>')
  +F('Sizes (comma separated)',inp('b-sizes',(p.s||[]).join(', ')))
  +F('THC min',inp('b-thcmin',p.t?p.t[0]:'','inputmode="decimal"'))
  +F('THC max',inp('b-thcmax',p.t?p.t[1]:'','inputmode="decimal"'))
  +F('CBD min',inp('b-cbdmin',p.cb?p.cb[0]:'','inputmode="decimal"'))
  +F('CBD max',inp('b-cbdmax',p.cb?p.cb[1]:'','inputmode="decimal"'))
  +F('Price from ($)',inp('b-price',p.p==null?'':p.p,'inputmode="decimal"'))
  +F('Stores',inp('b-stores',p.st==null?'':p.st,'inputmode="numeric"'))
  +F('Rating (e.g. 4.5)',inp('b-rating',p.r==null?'':p.r,'inputmode="decimal"'))
  +'</div>'
  +'<div class="adm-f"><label class="adm-toggle"><input type="checkbox" class="b-inf"'+(p.i?' checked':'')+'> Infused</label></div>'
  +F('HiBuddy URL',txa('b-url',p.u))
  /* Photo slot stays a BOUNDED textarea (not adm-tauto): an attached
     photo stores a data URI here — machine data, not copy — so the
     box wraps URLs fully but caps at two rows instead of growing to
     fit a ~50 KB base64 string down the page. */
  +F('Photo (image URL, or attach below)','<textarea class="adm-ta b-img" rows="2" style="min-height:64px;resize:none">'+cEsc(p.img||'')+'</textarea>')
  +'<div class="adm-f"><label>Attach a photo</label><input class="adm-inp b-file" type="file" accept="image/*"></div>'
  +'<button type="button" class="adm-del b-del">Delete this product</button>';
}
function budThcText(p){
 if(!p.t)return '—';
 var unit=p.c==='edible'?' mg':'%';
 return (p.t[0]===p.t[1]?String(p.t[0]):(p.t[0]+'–'+p.t[1]))+unit;
}
function budRowHtml(p){
 return '<div class="adm-grow" data-brow>'
  +'<div class="adm-grow-main adm-gcols-buds">'
  +'<label class="adm-gcheck"><input type="checkbox" class="b-sel" aria-label="Select product"></label>'
  +'<span class="adm-gc adm-gc-name">'+cEsc(p.n||'New product')+'</span>'
  +'<span class="adm-gc adm-gc-brand">'+cEsc(p.b||'')+'</span>'
  +'<span class="adm-gc adm-gc-thc">'+budThcText(p)+'</span>'
  +'<span class="adm-gc adm-gc-num adm-gc-price">'+(p.p==null?'—':('$'+Number(p.p).toFixed(2)))+'</span>'
  +'</div>'
  +'<div class="adm-gexpand adm-entry-body" hidden>'+budEditorHtml(p)+'</div>'
  +'</div>';
}
function budRowSync(row){
 row.querySelector('.adm-gc-name').textContent=val(row.querySelector('.b-name'))||'New product';
 row.querySelector('.adm-gc-brand').textContent=val(row.querySelector('.b-brand'));
 var c=row.querySelector('.b-cat').value,unit=c==='edible'?' mg':'%';
 var lo=val(row.querySelector('.b-thcmin')),hi=val(row.querySelector('.b-thcmax')),txt='—';
 if(lo!==''||hi!==''){ if(lo==='')lo=hi; if(hi==='')hi=lo; txt=(String(lo)===String(hi)?String(lo):(lo+'–'+hi))+unit; }
 row.querySelector('.adm-gc-thc').textContent=txt;
 var pr=val(row.querySelector('.b-price'));
 row.querySelector('.adm-gc-price').textContent=(pr===''||isNaN(Number(pr)))?'—':('$'+Number(pr).toFixed(2));
}
function budSelSync(){
 var n=0;
 document.querySelectorAll('#admBudsGrid [data-brow]:not([hidden]) .b-sel:checked').forEach(function(){n++;});
 $('admBudsSelN').textContent=n;
 $('admBudsSelBar').hidden=n===0;
 var all=$('admBudsAll');
 var vis=document.querySelectorAll('#admBudsGrid [data-brow]:not([hidden]) .b-sel');
 all.checked=vis.length>0&&n===vis.length;
}
function budFilter(){
 var q=val($('admBudsSearch')).toLowerCase();
 var rows=document.querySelectorAll('#admBudsGrid [data-brow]'),shown=0;
 rows.forEach(function(r){
   var name=val(r.querySelector('.b-name')).toLowerCase();
   r.hidden=!(!q||name.indexOf(q)>=0);
   if(r.hidden){var sel=r.querySelector('.b-sel'); if(sel)sel.checked=false;}
   else shown++;
 });
 $('admBudsCount').textContent='Showing '+shown+' of '+rows.length+' products';
 budSelSync();
}
function bindBudFile(row){
 var inpEl=row.querySelector('.b-file');
 if(!inpEl||inpEl._bound)return; inpEl._bound=true;
 inpEl.addEventListener('change',function(){
   var f=inpEl.files&&inpEl.files[0]; if(!f)return;
   var target=row.querySelector('.b-img');
   var rd=new FileReader();
   rd.onload=function(){
     var img=new Image();
     img.onload=function(){
       var scale=Math.min(1,800/Math.max(img.width,img.height));
       var cv=document.createElement('canvas');
       cv.width=Math.round(img.width*scale); cv.height=Math.round(img.height*scale);
       cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);
       try{target.value=cv.toDataURL('image/jpeg',0.82);}catch(e){}
     };
     img.src=rd.result;
   };
   rd.readAsDataURL(f);
 });
}
function bindBudGrid(){
 var grid=$('admBudsGrid');
 grid.addEventListener('click',function(ev){
   var del=ev.target.closest?ev.target.closest('.b-del'):null;
   if(del){var row=del.closest('[data-brow]'); if(row){row.remove(); budFilter();} return;}
   if(ev.target.closest&&ev.target.closest('.adm-gexpand'))return;
   if(ev.target.closest&&ev.target.closest('.adm-gcheck'))return;
   var main=ev.target.closest?ev.target.closest('.adm-grow-main'):null;
   if(!main)return;
   var row=main.closest('[data-brow]');
   var exp=row.querySelector('.adm-gexpand');
   var open=exp.hidden;
   exp.hidden=!open;
   row.classList.toggle('open',open);
   if(open)admGrowAll(row);
   if(!open)budRowSync(row);
 });
 grid.addEventListener('change',function(ev){
   if(ev.target.classList&&ev.target.classList.contains('b-sel'))budSelSync();
 });
 grid.addEventListener('input',function(ev){
   var row=ev.target.closest?ev.target.closest('[data-brow]'):null;
   if(!row)return;
   var cl=ev.target.classList;
   if(cl.contains('b-name')||cl.contains('b-brand')||cl.contains('b-thcmin')||cl.contains('b-thcmax')||cl.contains('b-price'))budRowSync(row);
 });
 grid.addEventListener('change',function(ev){
   var row=ev.target.closest?ev.target.closest('[data-brow]'):null;
   if(row&&ev.target.classList.contains('b-cat'))budRowSync(row);
 });
 $('admBudsSearch').addEventListener('input',budFilter);
 $('admBudsAll').addEventListener('change',function(){
   var on=$('admBudsAll').checked;
   document.querySelectorAll('#admBudsGrid [data-brow]:not([hidden]) .b-sel').forEach(function(c){c.checked=on;});
   budSelSync();
 });
 $('admBudsBulkDel').addEventListener('click',function(){
   document.querySelectorAll('#admBudsGrid [data-brow] .b-sel:checked').forEach(function(c){
     var row=c.closest('[data-brow]'); if(row)row.remove();
   });
   budFilter();
 });
 $('admBudsAdd').addEventListener('click',function(){
   var wrap=document.createElement('div');
   wrap.innerHTML=budRowHtml({n:'',b:'',c:'flower',s:[],t:null,cb:null,p:null,st:null,r:null,i:false,u:'',img:''});
   var node=wrap.firstChild;
   grid.appendChild(node); bindBudFile(node);
   var exp=node.querySelector('.adm-gexpand'); exp.hidden=false; node.classList.add('open');
   budFilter(); admGrowAll(node);
   var nm=node.querySelector('.b-name'); if(nm){nm.focus(); nm.scrollIntoView({block:'center'});}
 });
}
function buildCatalogues(){
 $('admFoodCat').innerHTML='<option value="all">All cats</option>'+CONTENT.foodCats.map(function(c){
   return '<option value="'+c.id+'">'+cEsc(c.label)+'</option>';
 }).join('');
 $('admFoodGrid').innerHTML=CONTENT.food.map(foodRowHtml).join('');
 bindFoodGrid(); foodFilter();
 $('admBudsGrid').innerHTML=CONTENT.buds.map(budRowHtml).join('');
 document.querySelectorAll('#admBudsGrid [data-brow]').forEach(bindBudFile);
 bindBudGrid(); budFilter();
}

/* ---------- Saves ---------- */
document.querySelectorAll('[data-save]').forEach(function(btn){
 btn.addEventListener('click',function(){
  var key=btn.getAttribute('data-save');
  showErr(key,'');
  if(key==='trip'){
    var t=val($('admTarget')),hd=val($('admHeroDates')),nu=val($('admNextUp'));
    if(!t||isNaN(new Date(t).getTime()))return showErr('trip','Pick a valid countdown date and time.');
    if(!hd)return showErr('trip','The hero dates line cannot be empty.');
    if(!nu)return showErr('trip','The next-up line cannot be empty.');
    CONTENT.trip={targetISO:t,heroDates:hd,nextUpDefault:nu};
    saveContent(CONTENT); renderHeroText();
    if(window.__tripRefresh)window.__tripRefresh();
    showSaved('trip');
  }
  if(key==='days'){
    var days=[],err='';
    document.querySelectorAll('#admDaysList .adm-entry').forEach(function(b,i){
      var cin=[];
      b.querySelectorAll('.d-cin-label').forEach(function(lab,j){
        var url=b.querySelectorAll('.d-cin-url')[j];
        var L=val(lab),U=val(url);
        if(L||U){ if(U&&!isHttp(U))err='Day '+(i+1)+': cinema link '+(j+1)+' must start with http.'; cin.push({label:L,url:U}); }
      });
      var date=val(b.querySelector('.d-date'));
      if(!date||isNaN(new Date(date+'T12:00:00').getTime()))err='Day '+(i+1)+': pick a valid date.';
      if(!val(b.querySelector('.d-title')))err='Day '+(i+1)+': the title cannot be empty.';
      days.push({dow:val(b.querySelector('.d-dow')),dnum:val(b.querySelector('.d-dnum')),dmon:val(b.querySelector('.d-dmon')),dateISO:date,chip:val(b.querySelector('.d-chip')),title:val(b.querySelector('.d-title')),bullets:val(b.querySelector('.d-bullets')).split('\n').map(function(x){return x.trim()}).filter(Boolean),cinema:cin});
    });
    if(err)return showErr('days',err);
    CONTENT.days=days; saveContent(CONTENT);
    renderDays(); renderHeroText();
    if(window.__tripRefresh)window.__tripRefresh();
    showSaved('days');
  }
  if(key==='stay'){
    var s=CONTENT.stay,err='';
    var url=val($('admStayUrl'));
    if(!isHttp(url))return showErr('stay','The Airbnb URL must start with http.');
    ['admStaySleeps','admStayBedrooms','admStayBeds','admStayBaths'].forEach(function(id){
      if(val($(id))&&!isNumStr(val($(id))))err='Guests / bedrooms / beds / baths must be numbers.';
    });
    ['admPriceNight','admPriceDiscount','admPriceTaxes','admPriceTotal'].forEach(function(id){
      if(val($(id))&&!isNumStr(val($(id))))err='Price fields must be numbers (or blank to hide).';
    });
    if(val($('admPriceNights'))&&!/^\d+$/.test(val($('admPriceNights'))))err='Nights must be a whole number (or blank).';
    if(err)return showErr('stay',err);
    s.airbnbUrl=url; s.intro=val($('admStayIntro')); s.rating=val($('admStayRating')); s.hostLine=val($('admStayHost'));
    s.sleeps=val($('admStaySleeps')); s.bedrooms=val($('admStayBedrooms')); s.beds=val($('admStayBeds')); s.baths=val($('admStayBaths'));
    s.checkIn=val($('admStayCheckIn')); s.checkOut=val($('admStayCheckOut'));
    s.pricePerNight=val($('admPriceNight')); s.priceNights=val($('admPriceNights')); s.priceDiscount=val($('admPriceDiscount')); s.priceTaxes=val($('admPriceTaxes')); s.priceTotal=val($('admPriceTotal'));
    s.rules=val($('admStayRules')).split('\n').map(function(x){return x.trim()}).filter(Boolean);
    s.amenities=val($('admStayAmen')).split('\n').map(function(x){return x.trim()}).filter(Boolean);
    s.detailsNote=val($('admStayNote'));
    saveContent(CONTENT); renderStay(); showSaved('stay');
  }
  if(key==='food'){
    var food=[],err='';
    document.querySelectorAll('#admFoodGrid [data-frow]').forEach(function(b,i){
      var name=val(b.querySelector('.f-name'));
      if(!name){err='Spot '+(i+1)+': the name cannot be empty.';return;}
      var url=val(b.querySelector('.f-url'));
      if(!url)url='https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(name+' Calgary');
      if(!isHttp(url)){err=name+': the maps URL must start with http.';return;}
      var stars=val(b.querySelector('.f-stars'));
      if(stars&&!/^~?\d+(\.\d+)?$/.test(stars)){err=name+': stars must be a number like 4.7.';return;}
      var reviews=val(b.querySelector('.f-reviews'));
      if(reviews&&!/^[\d,]+$/.test(reviews)){err=name+': review count must be digits like 3,221.';return;}
      var cats=[];
      b.querySelectorAll('.f-cat:checked').forEach(function(c){cats.push(c.value)});
      food.push({name:name,area:val(b.querySelector('.f-area')),stars:stars,reviews:reviews,note:val(b.querySelector('.f-note')),cats:cats,url:url});
    });
    if(err)return showErr('food',err);
    CONTENT.food=food; saveContent(CONTENT);
    if(window.__foodRefresh)window.__foodRefresh();
    showSaved('food');
  }
  if(key==='buds'){
    var buds=[],err='';
    function numOrNull(b,cls){var x=val(b.querySelector(cls)); if(x==='')return null; var n=Number(x); return isNaN(n)?undefined:n;}
    document.querySelectorAll('#admBudsGrid [data-brow]').forEach(function(b,i){
      if(err)return;
      var name=val(b.querySelector('.b-name'));
      if(!name){err='Product '+(i+1)+': the name cannot be empty.';return;}
      var tmin=numOrNull(b,'.b-thcmin'),tmax=numOrNull(b,'.b-thcmax'),cmin=numOrNull(b,'.b-cbdmin'),cmax=numOrNull(b,'.b-cbdmax');
      var price=numOrNull(b,'.b-price'),stores=numOrNull(b,'.b-stores'),rating=numOrNull(b,'.b-rating');
      [tmin,tmax,cmin,cmax,price,stores,rating].forEach(function(n){if(n===undefined)err=name+': every number field must be a number (or blank).';});
      if(err)return;
      function range(a,bb){ if(a===null&&bb===null)return null; var lo=a===null?bb:a, hi=bb===null?a:bb; return [Math.min(lo,hi),Math.max(lo,hi)]; }
      var url=val(b.querySelector('.b-url'));
      if(!url)url='https://hibuddy.ca';
      if(!isHttp(url)){err=name+': the HiBuddy URL must start with http.';return;}
      var img=val(b.querySelector('.b-img'));
      if(img&&!(isHttp(img)||img.indexOf('data:image/')===0||img.indexOf('assets/')===0)){err=name+': the photo must be an http URL or an attached photo.';return;}
      buds.push({n:name,b:val(b.querySelector('.b-brand')),c:b.querySelector('.b-cat').value,s:val(b.querySelector('.b-sizes')).split(',').map(function(x){return x.trim()}).filter(Boolean),t:range(tmin,tmax),cb:range(cmin,cmax),p:price,st:stores,r:rating,i:b.querySelector('.b-inf').checked,u:url,img:img});
    });
    if(err)return showErr('buds',err);
    CONTENT.buds=buds; saveContent(CONTENT);
    if(window.__budsRefresh)window.__budsRefresh();
    showSaved('buds');
  }
  if(key==='fifa'){
    var oldDefs=CONTENT.fifaTeams.map(function(t){return t.def});
    var teams=[],err='';
    document.querySelectorAll('#admFifaList .adm-entry').forEach(function(b,i){
      var def=val(b.querySelector('.t-def'));
      if(!def)err='Team '+(i+1)+': the team name cannot be empty.';
      var names=b.querySelectorAll('.t-mname'),logos=b.querySelectorAll('.t-mlogo'),members=[];
      names.forEach(function(nm,j){
        if(!val(nm))err='Team '+(i+1)+': member names cannot be empty.';
        members.push({name:val(nm),logo:logos[j].value});
      });
      teams.push({def:def,members:members});
    });
    if(err)return showErr('fifa',err);
    CONTENT.fifaTeams=teams; saveContent(CONTENT);
    if(window.__fifaTeamsRefresh)window.__fifaTeamsRefresh(oldDefs);
    showSaved('fifa');
  }
  if(key==='split'){
    var people=[],err='',seen={};
    document.querySelectorAll('#admSplitList .p-name').forEach(function(nm,i){
      var name=val(nm),home=document.querySelectorAll('#admSplitList .p-home')[i].value;
      if(!name)err='Person '+(i+1)+': the name cannot be empty.';
      if(name&&seen[name])err='Names must be unique — '+name+' appears twice.';
      seen[name]=1;
      people.push({name:name,home:home});
    });
    if(err)return showErr('split',err);
    CONTENT.splitPeople=people; saveContent(CONTENT);
    if(window.__splitRosterRefresh)window.__splitRosterRefresh();
    showSaved('split');
  }
  if(key==='flights'){
    var entries=[],ferr='';
    document.querySelectorAll('#admFlightsList .adm-entry').forEach(function(b,i){
      if(ferr)return;
      var num=val(b.querySelector('.fl-num'));
      var ocode=val(b.querySelector('.fl-ocode'));
      var dcode=val(b.querySelector('.fl-dcode'));
      var date=val(b.querySelector('.fl-date'));
      if(!num){ferr='Flight '+(i+1)+': flight number required.';return;}
      if(!ocode||!dcode){ferr='Flight '+(i+1)+': origin and destination codes required.';return;}
      if(!date){ferr='Flight '+(i+1)+': date required.';return;}
      entries.push({
        id:val(b.querySelector('.fl-id')),
        person:b.querySelector('.fl-person').value,
        flightNumber:num,airline:val(b.querySelector('.fl-airline')),
        origin:val(b.querySelector('.fl-origin')),originCode:ocode.toUpperCase(),
        destination:val(b.querySelector('.fl-dest')),destinationCode:dcode.toUpperCase(),
        departureDate:date,departureTime:val(b.querySelector('.fl-dep')),
        arrivalTime:val(b.querySelector('.fl-arr')),duration:val(b.querySelector('.fl-dur')),
        aircraft:val(b.querySelector('.fl-aircraft')),cabin:val(b.querySelector('.fl-cabin')),
        hasWifi:b.querySelector('.fl-wifi').checked,
        status:b.querySelector('.fl-status').value,
        gate:val(b.querySelector('.fl-gate')),terminal:val(b.querySelector('.fl-term')),
        notes:val(b.querySelector('.fl-notes'))
      });
    });
    if(ferr)return showErr('flights',ferr);
    if(!entries.length){showSaved('flights');return;}
    var pending=entries.length,saved=0,serr='';
    entries.forEach(function(e){
      fetch('/api/flights',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(e)})
        .then(function(r){return r.json();})
        .then(function(){saved++;if(saved===pending){loadAdminFlights();showSaved('flights');}})
        .catch(function(){serr='Save failed.';saved++;if(saved===pending)showErr('flights',serr);});
    });
  }
  // Any successful save can change the Deck's state (a content save
  // flips the source tile to "Saved copy"); refresh it quietly.
  setTimeout(loadAdminState,900);
 });
});

/* ---------- Flights ---------- */
var PEOPLE_LIST=['Mutasif','Moiz','Noor','Samad','Brendan','Zubi'];
var FLIGHT_STATUSES=['scheduled','on-time','delayed','boarding','departed','landed','cancelled'];
var _adminFlights=[];
function flightBlock(f,i){
  var personOpts=PEOPLE_LIST.map(function(p){return '<option value="'+p+'"'+(f.person===p?' selected':'')+'>'+p+'</option>';}).join('');
  var statusOpts=FLIGHT_STATUSES.map(function(s){return '<option value="'+s+'"'+(f.status===s?' selected':'')+'>'+s.charAt(0).toUpperCase()+s.slice(1)+'</option>';}).join('');
  return '<details class="adm-entry" '+(i===0?'open':'')+'>'
    +'<summary>'+cEsc((f.person||'')+(f.flightNumber?' · '+f.flightNumber:'')+(f.departureDate?' · '+f.departureDate:''))+' <span class="adm-sum-sub">'+cEsc(f.originCode||'')+'→'+cEsc(f.destinationCode||'')+'</span></summary>'
    +'<div class="adm-entry-body">'
    +'<div style="margin-bottom:14px;padding:10px 12px;background:rgba(242,179,61,.08);border:1px solid rgba(242,179,61,.2);border-radius:10px">'
    +'<div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#a9a5c6;margin-bottom:6px">Paste booking text — AI fills the fields</div>'
    +'<textarea class="adm-inp fl-parse-txt" rows="3" style="width:100%;resize:vertical;font-size:13px" placeholder="Paste email, itinerary or booking confirmation text here…"></textarea>'
    +'<div style="display:flex;gap:10px;align-items:center;margin-top:6px">'
    +'<button type="button" class="adm-save fl-parse-btn" style="padding:6px 14px;font-size:13px">Parse with AI</button>'
    +'<span class="fl-parse-status" style="font-size:13px;color:#a9a5c6"></span>'
    +'</div></div>'
    +'<div class="adm-grid">'+F('Person','<select class="adm-sel fl-person">'+personOpts+'</select>')+F('Flight number',inp('fl-num',f.flightNumber))+'</div>'
    +'<div class="adm-grid">'+F('Airline',inp('fl-airline',f.airline))+F('Aircraft',inp('fl-aircraft',f.aircraft))+'</div>'
    +'<div class="adm-grid">'+F('Origin city',inp('fl-origin',f.origin))+F('Origin code (e.g. YVR)',inp('fl-ocode',f.originCode))+'</div>'
    +'<div class="adm-grid">'+F('Destination city',inp('fl-dest',f.destination))+F('Destination code (e.g. YYC)',inp('fl-dcode',f.destinationCode))+'</div>'
    +'<div class="adm-grid">'+F('Date','<input class="adm-inp fl-date" type="date" value="'+cEsc(f.departureDate||'')+'">')+F('Duration',inp('fl-dur',f.duration))+'</div>'
    +'<div class="adm-grid">'+F('Departure time (HH:MM)',inp('fl-dep',f.departureTime))+F('Arrival time (HH:MM)',inp('fl-arr',f.arrivalTime))+'</div>'
    +'<div class="adm-grid">'+F('Cabin',inp('fl-cabin',f.cabin))+F('Terminal',inp('fl-term',f.terminal))+'</div>'
    +'<div class="adm-grid">'+F('Gate (if known)',inp('fl-gate',f.gate))+F('Status','<select class="adm-sel fl-status">'+statusOpts+'</select>')+'</div>'
    +'<div class="adm-f"><label class="adm-toggle"><input type="checkbox" class="fl-wifi"'+(f.hasWifi?' checked':'')+'> Wi-Fi on board</label></div>'
    +F('Notes (shown on card)',txa('fl-notes',f.notes))
    +'<input type="hidden" class="fl-id" value="'+cEsc(f.id||'')+'">'
    +'<button type="button" class="adm-del fl-del">Delete this flight</button>'
    +'</div></details>';
}
function bindFlightDeletes(){
  document.querySelectorAll('#admFlightsList .fl-del').forEach(function(b){
    b.onclick=function(){
      var entry=b.closest('.adm-entry');
      var idInp=entry&&entry.querySelector('.fl-id');
      var fid=idInp&&idInp.value;
      if(fid)fetch('/api/flights/'+encodeURIComponent(fid),{method:'DELETE'}).catch(function(){});
      if(entry)entry.remove();
    };
  });
}
function bindFlightParses(){
  document.querySelectorAll('#admFlightsList .fl-parse-btn').forEach(function(b){
    if(b._parseBound)return; b._parseBound=true;
    b.addEventListener('click',function(){
      var entry=b.closest('.adm-entry');
      var txt=entry&&entry.querySelector('.fl-parse-txt');
      var status=entry&&entry.querySelector('.fl-parse-status');
      if(!txt||!txt.value.trim())return;
      b.disabled=true; if(status)status.textContent='Parsing… (10–25s)';
      fetch('/api/flights/parse',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:txt.value})})
        .then(function(r){return r.json();})
        .then(function(d){
          b.disabled=false;
          if(d.error){if(status)status.textContent='Error: '+d.error;return;}
          var f=d.flight||{};
          function set(sel,val){var el=entry.querySelector(sel);if(el&&val!=null&&val!=='')el.value=val;}
          set('.fl-num',f.flightNumber); set('.fl-airline',f.airline);
          set('.fl-origin',f.origin); set('.fl-ocode',f.originCode);
          set('.fl-dest',f.destination); set('.fl-dcode',f.destinationCode);
          set('.fl-date',f.departureDate); set('.fl-dep',f.departureTime);
          set('.fl-arr',f.arrivalTime); set('.fl-dur',f.duration);
          set('.fl-aircraft',f.aircraft); set('.fl-cabin',f.cabin);
          set('.fl-term',f.terminal); set('.fl-gate',f.gate);
          set('.fl-notes',f.notes);
          admGrowAll(entry);
          var wifi=entry.querySelector('.fl-wifi');if(wifi&&f.hasWifi!=null)wifi.checked=!!f.hasWifi;
          if(status)status.textContent='✓ Done — check fields then save';
          txt.value='';
        })
        .catch(function(e){b.disabled=false;if(status)status.textContent='Failed: '+(e.message||'error');});
    });
  });
}
function loadAdminFlights(){
  fetch('/api/flights').then(function(r){return r.json();}).then(function(j){
    _adminFlights=j.flights||[];
    var list=$('admFlightsList');
    if(list)list.innerHTML=_adminFlights.map(flightBlock).join('');
    bindFlightDeletes(); bindFlightParses(); admGrowAll(list);
  }).catch(function(){});
}
$('admFlightsAdd').addEventListener('click',function(){
  var wrap=document.createElement('div');
  wrap.innerHTML=flightBlock({id:'',person:'Moiz',flightNumber:'',airline:'',origin:'',originCode:'',
    destination:'Calgary',destinationCode:'YYC',departureDate:'',departureTime:'',arrivalTime:'',
    duration:'',aircraft:'',cabin:'Economy',hasWifi:true,status:'scheduled',gate:'',terminal:'',notes:''},0);
  var node=wrap.firstChild; node.open=true;
  $('admFlightsList').appendChild(node); bindFlightDeletes(); bindFlightParses(); admGrowAll(node);
  var fn=node.querySelector('.fl-parse-txt'); if(fn)fn.focus();
});

/* ---------- Danger zone ---------- */
var resetBtn=$('admReset'),armed=false,armTimer=null;
resetBtn.addEventListener('click',function(){
 if(!armed){
   armed=true; resetBtn.classList.add('arm'); resetBtn.textContent='Tap again to confirm reset';
   armTimer=setTimeout(function(){armed=false;resetBtn.classList.remove('arm');resetBtn.textContent='Reset all content to the built-in version';},4000);
   return;
 }
 clearTimeout(armTimer);
 clearContent();
 location.reload();
});
})();

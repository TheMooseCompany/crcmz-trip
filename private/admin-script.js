
/* ================= ADMIN =================
   Forms are built once from CONTENT. Each card saves independently:
   validate → write the section into CONTENT → saveContent → re-render
   the affected public sections live → show "Saved". */
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

/* ---------- Trip ---------- */
$('admTarget').value=CONTENT.trip.targetISO||'';
$('admHeroDates').value=CONTENT.trip.heroDates||'';
$('admNextUp').value=CONTENT.trip.nextUpDefault||'';

/* ---------- Days ---------- */
function dayBlock(d,i){
 var cin='';
 if(d.cinema&&d.cinema.length){
   cin='<div class="adm-f"><label>Cinema links (Saturday)</label>'+d.cinema.map(function(m){
     return '<div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap"><input class="adm-inp d-cin-label" type="text" value="'+cEsc(m.label)+'" placeholder="Label" style="flex:1;min-width:130px"><input class="adm-inp d-cin-url" type="url" value="'+cEsc(m.url)+'" placeholder="https://…" style="flex:2;min-width:180px"></div>';
   }).join('')+'</div>';
 }
 return '<details class="adm-entry" '+(i===0?'open':'')+'><summary>Day '+(i+1)+' — '+cEsc(d.title||'')+' <span class="adm-sum-sub">'+cEsc(d.dow||'')+' '+cEsc(d.dnum||'')+'</span></summary><div class="adm-entry-body">'
  +'<div class="adm-grid">'
  +F('Weekday label',inp('d-dow',d.dow))
  +F('Day number',inp('d-dnum',d.dnum))
  +F('Month label',inp('d-dmon',d.dmon))
  +F('Date', '<input class="adm-inp d-date" type="date" value="'+cEsc(d.dateISO||'')+'">')
  +'</div>'
  +F('Chip',inp('d-chip',d.chip))
  +F('Title',inp('d-title',d.title))
  +F('Bullets (one per line)','<textarea class="adm-ta d-bullets">'+cEsc((d.bullets||[]).join('\n'))+'</textarea>')
  +cin
  +'</div></details>';
}
$('admDaysList').innerHTML=CONTENT.days.map(dayBlock).join('');

/* ---------- Stay ---------- */
(function(){var s=CONTENT.stay;
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
})();

/* ---------- Food ---------- */
function foodBlock(f){
 var checks=CONTENT.foodCats.map(function(c){
   return '<label class="adm-check"><input type="checkbox" class="f-cat" value="'+c.id+'"'+((f.cats||[]).indexOf(c.id)>=0?' checked':'')+'>'+cEsc(c.label)+'</label>';
 }).join('');
 return '<details class="adm-entry"><summary>'+cEsc(f.name||'New spot')+' <span class="adm-sum-sub">'+cEsc(f.area||'')+'</span></summary><div class="adm-entry-body">'
  +F('Name',inp('f-name',f.name))
  +F('Area',inp('f-area',f.area))
  +'<div class="adm-grid">'+F('Stars (e.g. 4.7)',inp('f-stars',f.stars,'inputmode="decimal"'))+F('Review count (e.g. 3,221)',inp('f-reviews',f.reviews))+ '</div>'
  +F('Halal note','<textarea class="adm-ta f-note" style="min-height:72px">'+cEsc(f.note||'')+'</textarea>')
  +F('Maps URL',inp('f-url',f.url,'type="url"'))
  +'<div class="adm-f"><label>Categories</label><div class="adm-checks">'+checks+'</div></div>'
  +'<button type="button" class="adm-del f-del">Delete this spot</button>'
  +'</div></details>';
}
$('admFoodList').innerHTML=CONTENT.food.map(foodBlock).join('');
function bindFoodDeletes(){
 document.querySelectorAll('#admFoodList .f-del').forEach(function(b){
   b.onclick=function(){var d=b.closest('.adm-entry'); if(d)d.remove();};
 });
}
bindFoodDeletes();
$('admFoodAdd').addEventListener('click',function(){
 var wrap=document.createElement('div');
 wrap.innerHTML=foodBlock({name:'',area:'',stars:'',reviews:'',note:'',cats:['breakfast'],url:''});
 var node=wrap.firstChild; node.open=true;
 $('admFoodList').appendChild(node); bindFoodDeletes();
 var nm=node.querySelector('.f-name'); if(nm)nm.focus();
});

/* ---------- Buds ---------- */
var LOGO_OPTS=[['samad','Samad'],['kaptaan','Kaptaan'],['moiz','Moiz'],['moose','Moose'],['killer','Killer'],['deception','Deception']];
function budBlock(p){
 function rng(v){return v?(v.join(' – ')):''}
 return '<details class="adm-entry"><summary>'+cEsc(p.n||'New product')+' <span class="adm-sum-sub">'+cEsc(p.b||'')+'</span></summary><div class="adm-entry-body">'
  +F('Name',inp('b-name',p.n))
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
  +F('HiBuddy URL',inp('b-url',p.u,'type="url"'))
  +F('Photo (image URL, or attach below)',inp('b-img',p.img||''))
  +'<div class="adm-f"><label>Attach a photo</label><input class="adm-inp b-file" type="file" accept="image/*"></div>'
  +'<button type="button" class="adm-del b-del">Delete this product</button>'
  +'</div></details>';
}
$('admBudsList').innerHTML=CONTENT.buds.map(budBlock).join('');
function bindBudExtras(){
 document.querySelectorAll('#admBudsList .b-del').forEach(function(b){
   b.onclick=function(){var d=b.closest('.adm-entry'); if(d)d.remove();};
 });
 document.querySelectorAll('#admBudsList .b-file').forEach(function(inpEl){
   inpEl.onchange=function(){
     var f=inpEl.files&&inpEl.files[0]; if(!f)return;
     var block=inpEl.closest('.adm-entry-body'); if(!block)return;
     var target=block.querySelector('.b-img');
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
   };
 });
}
bindBudExtras();
$('admBudsAdd').addEventListener('click',function(){
 var wrap=document.createElement('div');
 wrap.innerHTML=budBlock({n:'',b:'',c:'flower',s:[],t:null,cb:null,p:null,st:null,r:null,i:false,u:'',img:''});
 var node=wrap.firstChild; node.open=true;
 $('admBudsList').appendChild(node); bindBudExtras();
 var nm=node.querySelector('.b-name'); if(nm)nm.focus();
});

/* ---------- FIFA ---------- */
function fifaBlock(t,ti){
 var members=t.members.map(function(m,mi){
   var opts=LOGO_OPTS.map(function(o){return '<option value="'+o[0]+'"'+(m.logo===o[0]?' selected':'')+'>'+o[1]+'</option>'}).join('');
   return '<div class="adm-grid">'+F('Member '+(mi+1)+' name',inp('t-mname',m.name))+F('Member '+(mi+1)+' logo','<select class="adm-sel t-mlogo">'+opts+'</select>')+'</div>';
 }).join('');
 return '<div class="adm-entry" style="padding:14px 15px 4px"><div class="adm-f"><label>Team '+(ti+1)+' name</label>'+inp('t-def',t.def)+'</div>'+members+'</div>';
}
$('admFifaList').innerHTML=CONTENT.fifaTeams.map(fifaBlock).join('');

/* ---------- Split people ---------- */
$('admSplitList').innerHTML=CONTENT.splitPeople.map(function(p){
 return '<div class="adm-grid"><div class="adm-f"><label>Name</label>'+inp('p-name',p.name)+'</div>'
  +'<div class="adm-f"><label>Home currency</label><select class="adm-sel p-home"><option value="CAD"'+(p.home==='CAD'?' selected':'')+'>CAD</option><option value="USD"'+(p.home==='USD'?' selected':'')+'>USD</option></select></div></div>';
}).join('');

/* ---------- Saves ---------- */
function blockErr(msg){return msg}
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
    document.querySelectorAll('#admFoodList .adm-entry').forEach(function(b,i){
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
    document.querySelectorAll('#admBudsList .adm-entry').forEach(function(b,i){
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
 });
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

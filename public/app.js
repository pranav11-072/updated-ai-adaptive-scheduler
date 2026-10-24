(function(){
const RISK={low:'#43a047',medium:'#ffb300',high:'#fb8c00',critical:'#e53935'};
const NS='http://www.w3.org/2000/svg';
const dataEl=document.getElementById('cycle-data');
const D=dataEl?JSON.parse(dataEl.textContent):null;
const page=document.body.dataset.page;
function s(tag,a,p){const e=document.createElementNS(NS,tag);for(const k in a||{})e.setAttribute(k,a[k]);if(p)p.appendChild(e);return e}
function lineChart(host,o){
  const W=o.w||640,H=o.h||300,m={l:46,r:14,t:14,b:36};host.innerHTML='';
  const svg=s('svg',{viewBox:`0 0 ${W} ${H}`,width:'100%'},host);
  const xmax=Math.max(...o.xs),ymax=o.ymax||100;
  const X=x=>m.l+x/xmax*(W-m.l-m.r),Y=y=>H-m.b-y/ymax*(H-m.t-m.b);
  for(let g=0;g<=4;g++){const y=ymax*g/4;s('line',{x1:m.l,x2:W-m.r,y1:Y(y),y2:Y(y),stroke:'#e2dccb'},svg);const t=s('text',{x:m.l-6,y:Y(y)+4,'text-anchor':'end','font-size':10,fill:'#5c6477'},svg);t.textContent=y.toFixed(0)}
  for(let g=0;g<=6;g++){const x=xmax*g/6;const t=s('text',{x:X(x),y:H-m.b+14,'text-anchor':'middle','font-size':10,fill:'#5c6477'},svg);t.textContent=Math.round(x)}
  const xl=s('text',{x:W/2,y:H-4,'text-anchor':'middle','font-size':10,fill:'#5c6477'},svg);xl.textContent=o.xlabel||'';
  o.series.forEach((se,i)=>{s('polyline',{points:o.xs.map((x,k)=>X(x)+','+Y(se.ys[k])).join(' '),fill:'none',stroke:se.color,'stroke-width':2,'stroke-dasharray':se.dash||''},svg);
    const t=s('text',{x:m.l+8,y:m.t+12+i*13,'font-size':11,fill:se.color},svg);t.textContent='— '+se.name});
  (o.points||[]).forEach(p=>{s('circle',{cx:X(p.x),cy:Y(p.y),r:5,fill:p.color},svg);const t=s('text',{x:X(p.x)+8,y:Y(p.y)-6,'font-size':10,fill:p.color},svg);t.textContent=p.label});
  if(o.vline)s('line',{x1:X(o.vline),x2:X(o.vline),y1:m.t,y2:H-m.b,stroke:'#888','stroke-dasharray':'3 3'},svg);
}
function bars(host,items){host.innerHTML='';const mx=Math.max(1,...items.map(i=>i.value));
  items.forEach(i=>{const r=document.createElement('div');r.style.cssText='display:flex;align-items:center;gap:8px;margin:5px 0';
    r.innerHTML=`<span style="width:70px;font-size:12px">${i.label}</span><div style="flex:1;background:#eee7d6"><div style="height:16px;width:${i.value/mx*100}%;background:${i.color}"></div></div><b class="mono">${i.value}</b>`;host.appendChild(r)})}
function demand(host,vals,avail,title){host.innerHTML='';const W=420,H=120,m={l:30,r:6,t:16,b:14};
  const svg=s('svg',{viewBox:`0 0 ${W} ${H}`,width:'100%'},host);const ymax=Math.max(avail,...vals)*1.1||1;
  const bw=(W-m.l-m.r)/vals.length,Y=y=>H-m.b-y/ymax*(H-m.t-m.b);
  vals.forEach((v,i)=>{if(v>0)s('rect',{x:m.l+i*bw,y:Y(v),width:Math.max(bw-.2,.6),height:H-m.b-Y(v),fill:v>avail?'#e53935':'#1d4e89'},svg)});
  s('line',{x1:m.l,x2:W-m.r,y1:Y(avail),y2:Y(avail),stroke:'#000','stroke-dasharray':'4 3'},svg);
  const t=s('text',{x:m.l,y:11,'font-size':11,fill:'#14213d'},svg);t.textContent=title+' (available '+avail+', dashed)'}
if(D&&page==='dashboard'){
  const c={low:0,medium:0,high:0,critical:0};D.activities.forEach(a=>{if(a.risk_band)c[a.risk_band]++});
  bars(document.getElementById('risk-dist'),Object.keys(c).map(k=>({label:k,value:c[k],color:RISK[k]})));
}
if(D&&page==='progress'){
  const sc=D.progress.s_curve;lineChart(document.getElementById('scurve'),{xs:sc.map(r=>r.day),xlabel:'Working-day offset',
    series:[{name:'Planned (baseline)',color:'#1d4e89',ys:sc.map(r=>r.planned)},{name:'Forecast (adapted)',color:'#fb8c00',dash:'6 4',ys:sc.map(r=>r.forecast)}],
    points:[{x:D.progress.elapsed_working_days,y:D.progress.actual_pct,color:'#d50000',label:'Actual '+D.progress.actual_pct.toFixed(1)+'%'}],vline:D.progress.elapsed_working_days})
}
if(D&&page==='resources'){
  const host=document.getElementById('demand');
  D.resources.summary.forEach(r=>{if(r.peak_demand>0){const d=document.createElement('div');d.className='card';host.appendChild(d);demand(d,D.resources.demand[r.resource],r.available,r.resource)}})
}
if(page==='gantt'){
  const q=location.search;fetch('/api/gantt'+q).then(r=>r.json()).then(G=>{
    const wrap=document.getElementById('gantt'),tip=document.getElementById('tip');
    const st={ppd:4,filter:'all',floor:'all',base:true,text:''};
    const zoomEl = document.getElementById('zoom');
    if (zoomEl) zoomEl.oninput=e=>{st.ppd=+e.target.value;draw()};
    const filterEl = document.getElementById('filter');
    if (filterEl) filterEl.onchange=e=>{st.filter=e.target.value;draw()};
    const floorEl = document.getElementById('floor-select');
    if (floorEl) floorEl.onchange=e=>{st.floor=e.target.value;draw()};
    const baseEl = document.getElementById('base');
    if (baseEl) baseEl.onchange=e=>{st.base=e.target.checked;draw()};
    const findEl = document.getElementById('find');
    if (findEl) findEl.oninput=e=>{st.text=e.target.value.toLowerCase();draw()};
    function ok(a){
      if(st.text&&!(a.name+a.activity_id).toLowerCase().includes(st.text))return false;
      if(st.floor!=='all'&&(a.floor||'')!==st.floor)return false;
      const f=st.filter;return f==='all'||(f==='critical'&&a.critical)||(f==='near'&&a.near_critical)||(f==='atrisk'&&(a.risk_band==='high'||a.risk_band==='critical'))||(f==='delayed'&&a.injected_days>0)}
    function draw(){
      const acts=G.activities.filter(ok).sort((a,b)=>a.current_es-b.current_es||a.activity_id.localeCompare(b.activity_id));
      const ppd=st.ppd,W=(G.horizon+4)*ppd,RH=22,top=36,H=top+acts.length*RH;
      wrap.innerHTML='<div class="gantt-inner"><div class="gantt-labels"></div></div>';
      const L=wrap.querySelector('.gantt-labels');
      L.innerHTML='<div class="hd">Activity</div>'+acts.map(a=>`<div title="${a.name}">${a.critical?'<b style="color:#d50000">▌</b>':'&nbsp;'} ${a.floor?`<span style="font-size:9.5px;color:#475569;background:#e2e8f0;padding:1px 4px;border-radius:2px;margin-right:2px">${a.floor}</span> `:''}${a.activity_id} ${a.name}</div>`).join('');
      const svg=s('svg',{width:W,height:H});wrap.querySelector('.gantt-inner').appendChild(svg);
      let lastM='';G.offset_dates.forEach((d,k)=>{const m=d.slice(0,7);if(m!==lastM){lastM=m;s('line',{x1:k*ppd,x2:k*ppd,y1:0,y2:H,stroke:'#e6dfcc'},svg);const t=s('text',{x:k*ppd+3,y:14,'font-size':10,fill:'#14213d'},svg);t.textContent=new Date(d).toLocaleString('en',{month:'short',year:'2-digit'});}
        if(k%10===0){const t=s('text',{x:k*ppd+3,y:30,'font-size':9,fill:'#7a8194'},svg);t.textContent=k}});
      acts.forEach((a,i)=>{const y=top+i*RH;
        if(st.base)s('rect',{x:a.baseline_es*ppd,y:y+3,width:Math.max((a.baseline_ef-a.baseline_es)*ppd,2),height:16,fill:'#cfd8dc'},svg);
        const col=a.risk_band?RISK[a.risk_band]:'#90a4ae';
        const r=s('rect',{x:a.current_es*ppd,y:y+6,width:Math.max((a.current_ef-a.current_es)*ppd,2),height:10,fill:col,stroke:a.critical?'#d50000':'none','stroke-width':a.critical?2:0},svg);
        r.onmousemove=e=>{tip.style.display='block';tip.style.left=(e.clientX+14)+'px';tip.style.top=(e.clientY+14)+'px';
          tip.innerHTML=`<b>${a.activity_id} ${a.name}</b> ${a.floor?`[${a.floor}]`:''}<br>Current: ${a.current_start} → ${a.current_finish} (${a.current_ef-a.current_es} wd)<br>Baseline: ${a.baseline_start} → ${a.baseline_finish}<br>Total float: ${a.total_float} wd ${a.critical?'(CRITICAL)':a.near_critical?'(near-critical)':''}<br>`+
          (a.p_delay!==null?`P(delay) ${(a.p_delay*100).toFixed(0)}% · ${a.risk_band} · predicted ${a.predicted_delay_days} d<br>Injected: ${a.injected_days} d<br>${a.drivers||''}`:'No risk model')+`<br>Complete: ${a.percent_complete}%`};
        r.onmouseleave=()=>tip.style.display='none'});
      s('line',{x1:G.data_date_offset*ppd,x2:G.data_date_offset*ppd,y1:0,y2:H,stroke:'#1d4e89','stroke-dasharray':'4 3','stroke-width':1.5},svg);
      const countEl = document.getElementById('count');
      if (countEl) countEl.textContent=acts.length+' of '+G.activities.length+' activities';}
    draw();});
}
})();

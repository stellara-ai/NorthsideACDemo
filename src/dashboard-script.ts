// @ts-nocheck
/* Verbatim dashboard script from the source page. Only refresh() was changed: it now
   reads the same JSON from the app's own backend function instead of dashboard-live.json.
   Everything below runs after the login gate mounts the markup. */
import { backend } from "./lib/backend/index.js";

export function startDashboard() {
const $=s=>document.querySelector(s);
const NS="http://www.w3.org/2000/svg";
const el=(t,a,p)=>{const e=document.createElementNS(NS,t);for(const k in a)e.setAttribute(k,a[k]);if(p)p.appendChild(e);return e};
const css=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const pd=s=>new Date(s.replace(" ","T"));
let NOW=new Date(),ON=new Date();
const DAY=864e5;
const fmtT=d=>d.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"});
const fmtD=d=>d.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"});
const fmtDT=d=>fmtD(d)+", "+fmtT(d);
const money=n=>"$"+n.toLocaleString("en-US");
const dur=s=>s<60?s+" sec":Math.floor(s/60)+" min "+(s%60)+" sec";
const phone=p=>p.replace(/^\+1(\d{3})(\d{3})(\d{4})$/,"($1) $2-$3");
let C=[],calls=[],jobs=[],tasks=[],quotes=[],HASH=null;
const QSTAGE=s=>s==="Needs owner"?"Needs you":/^Follow-up (\d)/.test(s)?"Follow-up "+s.match(/^Follow-up (\d)/)[1]+" of 3":s;
function load(J){
  NOW=new Date();ON=new Date(NOW);if(NOW.getHours()<18)ON.setDate(ON.getDate()-1);ON.setHours(18,0,0,0);
  C=J.contacts.map((c,i)=>({i,name:c[0],phone:c[1]||"",town:c[2]||"",source:c[3],status:c[4]||"",street:c[5]||"",pipe:c[6],stage:c[7]}));
  jobs=J.jobs.map((j,i)=>({i,ci:j[0],svc:j[1],start:new Date(j[2]),booked:new Date(j[3]),status:new Date(j[2])<NOW?"Completed":"Scheduled",price:j[5],via:j[6]}));
  calls=J.calls.map((c,i)=>({i,t:new Date(c[0]),ci:c[1],outcome:c[2],sec:c[3],sum:c[4]||"No summary recorded for this call.",job:c[5],num:c[6]}));
  tasks=J.tasks.map((t,i)=>({i,title:t[0],done:!!t[1],t:new Date(t[2])}));
  quotes=J.contacts.map((c,i)=>[i,c]).filter(([i,c])=>c[6]==="Open quotes"&&c[7]!=="Lost").map(([i,c],k)=>({i:k,ci:i,job:c[8]||"Quote",amt:+c[9]||0,stage:QSTAGE(c[7]),note:c[10]||""}));
}
const addr=c=>[c.street,c.town].filter(Boolean).map(esc).join(", ")+(c.town?", NY":"");
const after=d=>d.getHours()>=18||d.getHours()<7||d.getDay()===0||d.getDay()===6;
const OUT={"Booked":"green","Question answered":"blue","Existing customer":"teal","Emergency routed":"red","Hang-up, texted back":"amber","Message for owner":"amber","Spam / wrong number":"grey"};
const STAT={"Active":"green","New":"blue","Booked":"teal","Needs you":"red"};
const SRC={"Phone":"blue","Web form":"teal","Google ad":"green","Referral":"amber"};
let RANGE=30;
const from=()=>new Date(NOW-RANGE*DAY);
const inR=d=>d>=from()&&d<=NOW;
const over=d=>d>=ON&&d<=NOW;
const IC={phone:'<path d="M20 11.5a7.5 7.5 0 0 1-11 6.6L4 19.5l1.4-4.6A7.5 7.5 0 1 1 20 11.5Z"/>',cal:'<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',check:'<rect x="4.5" y="4.5" width="15" height="15" rx="2.5"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',alert:'<circle cx="12" cy="12" r="8"/><path d="M12 8v4.5M12 16h.01"/>'};

/* ---------- KPIs ---------- */
function renderKPIs(){
  const cR=calls.filter(c=>inR(c.t)),jR=jobs.filter(j=>inR(j.start)),tR=tasks.filter(t=>t.done&&inR(t.t)),open=tasks.filter(t=>!t.done);
  const k=[
    ["blue","Calls handled",cR.length,calls.filter(c=>over(c.t)).length,"phone",()=>listCalls()],
    ["green","Jobs booked",jR.length,jobs.filter(j=>over(j.booked)).length,"cal",()=>listJobs()],
    ["teal","Follow-ups completed",tR.length,tasks.filter(t=>t.done&&over(t.t)).length,"check",()=>listTasks(true)],
    ["amber","Needs you",open.length,null,"alert",()=>listTasks(false)]];
  const box=$("#kpis");box.innerHTML="";
  k.forEach(([cl,l,v,o,ic,fn])=>{const b=document.createElement("button");b.className="card kpi "+cl;
    b.innerHTML=`<div class="row">${l}<span class="ic"><svg viewBox="0 0 24 24">${IC[ic]}</svg></span></div><div class="big"><strong>${v}</strong>${o?`<span class="chip">+${o} overnight</span>`:""}</div><span class="hint">${RANGE===30||ic==="alert"?(ic==="alert"?"Open now":"Last 30 days"):"Last 7 days"} · view all</span>`;
    b.onclick=fn;box.appendChild(b)});
}
/* ---------- Bars ---------- */
function renderBars(){
  const s=$("#bars");s.innerHTML="";const order=["Phone","Web form","Google ad","Referral"];
  const cnt=order.map(o=>C.filter(c=>c.source===o).length);
  const max=Math.max(10,Math.ceil(Math.max(...cnt)/10)*10),top=30,base=208,bw=78,step=136,x0=46;
  order.forEach((o,i)=>{const v=cnt[i],h=(base-top)*v/max,x=x0+i*step,col=css("--"+SRC[o]);
    const g=el("g",{class:"hit",tabindex:0,role:"button","aria-label":`${o}: ${v} leads`},s);
    el("rect",{x:x-14,y:top-20,width:bw+28,height:base-top+50,fill:"transparent"},g);
    el("rect",{class:"bar",x,y:base-h,width:bw,height:h,rx:9,fill:col},g);
    el("rect",{class:"bar",x,y:base-10,width:bw,height:10,fill:col},g);
    const t=el("text",{x:x+bw/2,y:base-h-10,"text-anchor":"middle","font-weight":700,style:"fill:"+col},g);t.textContent=v;
    const l=el("text",{x:x+bw/2,y:base+26,"text-anchor":"middle"},g);l.textContent=o;
    const go=()=>listContacts("source",o);g.addEventListener("click",go);g.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();go()}});
  });
}
/* ---------- Donut ---------- */
function renderDonut(){
  const s=$("#donut");s.innerHTML="";const order=["Active","New","Booked","Needs you"];
  const cnt=order.map(o=>C.filter(c=>c.status===o).length),tot=cnt.reduce((a,b)=>a+b,0),r=56,Cc=2*Math.PI*r;let off=0;
  order.forEach((o,i)=>{const len=tot?Cc*cnt[i]/tot:0;if(!len)return;
    const c=el("circle",{class:"seg2",cx:74,cy:74,r,fill:"none",stroke:css("--"+STAT[o]),"stroke-width":17,"stroke-dasharray":`${len-2} ${Cc-len+2}`,"stroke-dashoffset":-off,transform:"rotate(-90 74 74)",tabindex:0,role:"button","aria-label":`${o}: ${cnt[i]}`},s);
    c.addEventListener("click",()=>listContacts("status",o));c.addEventListener("keydown",e=>{if(e.key==="Enter")listContacts("status",o)});off+=len});
  const a=el("text",{x:74,y:76,"text-anchor":"middle",style:"font:750 28px var(--sans);fill:"+css("--ink")},s);a.textContent=tot;
  const b=el("text",{x:74,y:96,"text-anchor":"middle",style:"font:13px var(--sans)"},s);b.textContent="contacts";
  const L=$("#legend");L.innerHTML="";order.forEach((o,i)=>{const li=document.createElement("li");li.className=STAT[o];
    li.innerHTML=`<button><i></i>${o}<b>${cnt[i]}</b></button>`;li.firstChild.onclick=()=>listContacts("status",o);L.appendChild(li)});
}
/* ---------- Trend ---------- */
function renderTrend(){
  const s=$("#trend");s.innerHTML="";const n=Math.min(RANGE,14);$("#trendlbl").textContent="Last "+n+" days";
  const days=[...Array(n)].map((_,i)=>{const d=new Date(NOW);d.setHours(0,0,0,0);d.setDate(d.getDate()-(n-1)+i);return d});
  const cc=days.map(d=>calls.filter(c=>c.t>=d&&c.t<new Date(+d+DAY)).length);
  const jc=days.map(d=>jobs.filter(j=>j.start>=d&&j.start<new Date(+d+DAY)).length);
  const L=40,R=585,T=16,B=200,max=Math.max(4,Math.ceil(Math.max(...cc,...jc)/4)*4);
  const X=i=>L+(n===1?0:i*(R-L)/(n-1)),Y=v=>B-(B-T)*v/max;
  for(let g=0;g<=max;g+=max/4){el("line",{x1:L,x2:R,y1:Y(g),y2:Y(g),stroke:css("--line"),"stroke-dasharray":g?"4 4":"0"},s);const t=el("text",{x:L-10,y:Y(g)+4,"text-anchor":"end"},s);t.textContent=g}
  const pc=cc.map((v,i)=>X(i)+","+Y(v)).join(" "),pj=jc.map((v,i)=>X(i)+","+Y(v)).join(" ");
  el("polygon",{points:`${X(0)},${B} ${pc} ${X(n-1)},${B}`,fill:css("--bs")},s);
  el("polyline",{points:pc,fill:"none",stroke:css("--blue"),"stroke-width":2.5,"stroke-linejoin":"round"},s);
  el("polyline",{points:pj,fill:"none",stroke:css("--green"),"stroke-width":2.5,"stroke-linejoin":"round"},s);
  const lab=n===14?[0,4,9,13]:[0,1,2,3,4,5,6];
  lab.forEach(i=>{const t=el("text",{x:X(i),y:B+22,"text-anchor":i===0?"start":i===n-1?"end":"middle"},s);t.textContent=days[i].toLocaleDateString("en-US",{month:"short",day:"numeric"})});
  const tip=$("#tip"),w=(R-L)/(n-1||1);
  const cur=el("line",{x1:0,x2:0,y1:T,y2:B,stroke:css("--muted"),"stroke-dasharray":"3 3",opacity:0},s);
  const dc=el("circle",{r:5,fill:css("--blue"),opacity:0},s),dj=el("circle",{r:5,fill:css("--green"),opacity:0},s);
  days.forEach((d,i)=>{const r=el("rect",{x:X(i)-w/2,y:T,width:w,height:B-T+8,fill:"transparent",class:"hit",tabindex:0,role:"button","aria-label":`${fmtD(d)}: ${cc[i]} calls, ${jc[i]} jobs booked`},s);
    const show=()=>{cur.setAttribute("x1",X(i));cur.setAttribute("x2",X(i));cur.setAttribute("opacity",1);dc.setAttribute("cx",X(i));dc.setAttribute("cy",Y(cc[i]));dc.setAttribute("opacity",1);dj.setAttribute("cx",X(i));dj.setAttribute("cy",Y(jc[i]));dj.setAttribute("opacity",1);
      const box=s.getBoundingClientRect(),sc=box.width/600;tip.style.left=X(i)*sc+"px";tip.style.top=Y(Math.max(cc[i],jc[i]))*sc+"px";tip.innerHTML=`<b>${fmtD(d)}</b> · ${cc[i]} calls · ${jc[i]} booked<br>Click for details`;tip.style.opacity=1};
    const hide=()=>{tip.style.opacity=0;cur.setAttribute("opacity",0);dc.setAttribute("opacity",0);dj.setAttribute("opacity",0)};
    r.addEventListener("mouseenter",show);r.addEventListener("mouseleave",hide);r.addEventListener("focus",show);r.addEventListener("blur",hide);
    const go=()=>{hide();dayView(d)};r.addEventListener("click",go);r.addEventListener("keydown",e=>{if(e.key==="Enter")go()})});
  const last=n-1;el("circle",{cx:X(last),cy:Y(cc[last]),r:4.5,fill:css("--blue")},s);
}
/* ---------- Lists on page ---------- */
function li(html,fn,cls=""){const l=document.createElement("li");const b=document.createElement("button");b.className=cls;b.innerHTML=html;b.onclick=fn;l.appendChild(b);return l}
function renderLists(){
  const oc=calls.filter(c=>over(c.t)),oj=jobs.filter(j=>over(j.booked)),ot=tasks.filter(t=>t.done&&over(t.t));
  const cb=oc.filter(c=>c.outcome!=="Booked"&&c.outcome!=="Spam / wrong number");
  $("#ovtext").textContent=oj.length?`Stellara booked a ${oj.at(-1).svc.toLowerCase()} for ${fmtD(oj.at(-1).start).split(",")[0]} ${fmtT(oj.at(-1).start)}`:"Quiet night";
  const A=$("#acts");A.innerHTML="";
  A.append(li(`<span class="num">${oc.length}</span><span><b>Calls captured overnight</b><span class="do">→ ${cb.length} need a reply or callback</span></span>`,()=>listCalls(oc,"Overnight calls"),"amber"));
  A.append(li(`<span class="num">${oj.length}</span><span><b>Jobs booked</b><span class="do">✓ Nothing needed</span></span>`,()=>listJobs(oj,"Booked overnight"),"green"));
  const nq=quotes.filter(q=>q.stage==="Needs you");
  if(nq.length)A.append(li(`<span class="num">${nq.length}</span><span><b>Quote reply needing you</b><span class="do">→ Call ${C[nq[0].ci].name.split(" ")[0]} about the ${money(nq[0].amt)} ${nq[0].job.toLowerCase()}</span></span>`,()=>contactView(nq[0].ci),"amber"));
  else A.append(li(`<span class="num">0</span><span><b>Quote replies needing you</b><span class="do">✓ Nothing needed</span></span>`,()=>{},"green"));
  A.append(li(`<span class="num">${ot.length}</span><span><b>Review requests sent</b><span class="do">✓ Nothing needed</span></span>`,()=>listTasks(true,ot,"Sent overnight"),"green"));
  const U=$("#coming");U.innerHTML="";
  jobs.filter(j=>j.start>NOW).sort((a,b)=>a.start-b.start).forEach(j=>{const tag=over(j.booked)?["green","Overnight"]:after(j.booked)?["teal","After hours"]:["blue","Business hours"];
    U.append(li(`<time>${fmtD(j.start).split(",")[0]} ${fmtT(j.start)}</time><span>${esc(j.svc)}<small>${esc(C[j.ci].name)} · ${esc(C[j.ci].town)}</small></span><span class="pill ${tag[0]}">${tag[1]}</span>`,()=>jobView(j.i)))});
  const Q=$("#quotes");Q.innerHTML="";const oq=quotes.filter(q=>q.stage!=="Won");
  $("#qtotal").textContent=money(oq.reduce((a,q)=>a+q.amt,0))+" open";
  oq.forEach(q=>Q.append(li(`<span>${esc(q.job)}<small>${esc(C[q.ci].name)} · ${esc(q.stage==="Needs you"||q.stage==="Quote sent"?q.note:q.stage+" sent")}</small></span><span><span class="amt">${money(q.amt)}</span><br><span class="pill ${q.stage==="Needs you"?"amber":q.stage==="Quote sent"?"blue":"teal"}">${q.stage==="Needs you"?"Needs you":q.stage==="Quote sent"?"Quote sent":"Following up"}</span></span>`,()=>contactView(q.ci))));
}
/* ---------- Drawer ---------- */
const stack=[];
function open(title,html,bind,push=true){if(push)stack.push([title,html,bind]);$("#dtitle").textContent=title;$("#dbody").innerHTML=html;$("#dbody").scrollTop=0;bind&&bind($("#dbody"));
  $("#back").hidden=stack.length<2;$("#drawer").classList.add("on");$("#scrim").classList.add("on");$("#drawer").setAttribute("aria-hidden","false");setTimeout(()=>$("#close").focus(),50)}
function closeD(){stack.length=0;$("#drawer").classList.remove("on");$("#scrim").classList.remove("on");$("#drawer").setAttribute("aria-hidden","true")}
$("#close").onclick=closeD;$("#scrim").onclick=closeD;document.addEventListener("keydown",e=>{if(e.key==="Escape")closeD()});
$("#back").onclick=()=>{stack.pop();const p=stack.at(-1);if(p)open(p[0],p[1],p[2],false)};
function recList(items,row,onClick,empty="Nothing here yet."){return items.length?`<ul class="lst rec">${items.map((x,i)=>`<li><button data-i="${i}">${row(x)}</button></li>`).join("")}</ul>`:`<p class="empty">${empty}</p>`}
function bindRec(root,items,onClick){root.querySelectorAll(".rec button").forEach(b=>b.onclick=()=>onClick(items[+b.dataset.i]))}
const callRow=c=>`<span>${c.ci!=null?esc(C[c.ci].name):"Unknown caller"}<small>${fmtDT(c.t)}${after(c.t)?" · after hours":""} · ${dur(c.sec)}</small></span><span class="pill ${OUT[c.outcome]}">${c.outcome}</span>`;
function listCalls(set,title){
  const base=set||calls.filter(c=>inR(c.t)),label=title||`Calls handled · last ${RANGE} days`;let f="All";
  const outs=["All",...Object.keys(OUT).filter(o=>base.some(c=>c.outcome===o))];
  const draw=()=>{const items=base.filter(c=>f==="All"||c.outcome===f).sort((a,b)=>b.t-a.t);
    const ah=items.filter(c=>after(c.t)).length;
    return `<p class="dsub">${items.length} calls · ${ah} after hours · every one answered</p><div class="chips">${outs.map(o=>`<button data-o="${o}" aria-pressed="${o===f}">${o}${o!=="All"?" · "+base.filter(c=>c.outcome===o).length:""}</button>`).join("")}</div>`+recList(items,callRow)};
  const bind=root=>{root.querySelectorAll(".chips button").forEach(b=>b.onclick=()=>{f=b.dataset.o;root.innerHTML=draw();bind(root)});
    const items=base.filter(c=>f==="All"||c.outcome===f).sort((a,b)=>b.t-a.t);bindRec(root,items,c=>callView(c.i))};
  open(label,draw(),bind)}
function callView(i){const c=calls[i];const ct=c.ci!=null?C[c.ci]:null;
  const html=`<span class="pill ${OUT[c.outcome]}">${c.outcome}</span><dl class="meta"><dt>Caller</dt><dd>${ct?`<button class="link" id="toC">${esc(ct.name)}</button>`:"Unknown caller"}</dd><dt>Number</dt><dd>${ct?phone(ct.phone):phone(c.num||"")||"Unknown"}</dd><dt>When</dt><dd>${fmtDT(c.t)}${after(c.t)?" · after hours":""}</dd><dt>Length</dt><dd>${dur(c.sec)}</dd><dt>Answered by</dt><dd>Stellara receptionist</dd></dl>
  <div class="secth">Call summary</div><p>${esc(c.sum)}</p>${c.job!=null?`<p><button class="link" id="toJ">Open the booked job →</button></p>`:""}`;
  open("Call · "+fmtT(c.t),html,root=>{const a=root.querySelector("#toC");if(a)a.onclick=()=>contactView(c.ci);const b=root.querySelector("#toJ");if(b)b.onclick=()=>jobView(c.job)})}
const jobRow=j=>`<span>${esc(j.svc)} · ${esc(C[j.ci].name)}<small>${fmtDT(j.start)} · ${esc(C[j.ci].town)}</small></span><span class="pill ${j.status==="Completed"?"teal":"green"}">${j.status}</span>`;
function listJobs(set,title){const items=(set||jobs.filter(j=>inR(j.start))).slice().sort((a,b)=>b.start-a.start);
  const rev=items.reduce((a,j)=>a+j.price,0);
  open(title||`Jobs booked · last ${RANGE} days`,`<p class="dsub">${items.length} jobs · ${items.filter(j=>after(j.booked)).length} booked after hours · ${money(rev)} in visit fees</p>`+recList(items,jobRow),root=>bindRec(root,items,j=>jobView(j.i)))}
function jobView(i){const j=jobs[i],ct=C[j.ci];const call=calls.find(c=>c.job===i);
  const html=`<span class="pill ${j.status==="Completed"?"teal":"green"}">${j.status}</span><dl class="meta"><dt>Customer</dt><dd><button class="link" id="toC">${esc(ct.name)}</button></dd><dt>When</dt><dd>${fmtDT(j.start)}</dd><dt>Where</dt><dd>${addr(ct)}</dd><dt>Visit fee</dt><dd>${j.price?money(j.price):"Free estimate"}</dd><dt>Booked</dt><dd>${fmtDT(j.booked)} · by ${j.via==="Call"?"phone call":j.via.toLowerCase()}${after(j.booked)?" · after hours":""}</dd></dl>
  ${call?`<div class="secth">From the call</div><p>${esc(call.sum)}</p><p><button class="link" id="toCall">Open the call →</button></p>`:""}`;
  open(j.svc,html,root=>{root.querySelector("#toC").onclick=()=>contactView(j.ci);const b=root.querySelector("#toCall");if(b)b.onclick=()=>callView(call.i)})}
function listTasks(done,set,title){const items=(set||(done?tasks.filter(t=>t.done&&inR(t.t)):tasks.filter(t=>!t.done))).slice().sort((a,b)=>b.t-a.t);
  const kinds={};items.forEach(t=>{const k=t.title.split(":")[0];kinds[k]=(kinds[k]||0)+1});
  open(title||(done?`Follow-ups completed · last ${RANGE} days`:"Needs you"),`<p class="dsub">${done?Object.entries(kinds).map(([k,v])=>v+" "+k.toLowerCase()).join(" · "):"Things Stellara handed to you. Everything else is handled."}</p>`+
    recList(items,t=>`<span>${esc(t.title)}<small>${t.done?"Done "+fmtDT(t.t):"Due "+fmtD(t.t)}</small></span><span class="pill ${t.done?"teal":"amber"}">${t.done?"Done":"Open"}</span>`),
    root=>bindRec(root,items,t=>{const n=t.title.split(": ")[1];const ci=n&&C.findIndex(c=>c.name===n);if(ci>=0)contactView(ci);else if(/Hector/.test(t.title))contactView(C.findIndex(c=>c.name==="Hector Alvarez"));else if(/overnight callers/.test(t.title))listCalls(calls.filter(c=>over(c.t)&&c.outcome!=="Booked"),"Overnight callers to call back")}))}
const cRow=c=>`<span>${esc(c.name)}<small>${esc(c.town)} · ${phone(c.phone)}</small></span><span class="pill ${STAT[c.status]||"grey"}">${c.status}</span>`;
function listContacts(k,v){const items=C.filter(c=>c[k]===v&&(k==="source"||c.status!=="Newsletter only")).sort((a,b)=>a.name.localeCompare(b.name));
  const sub=k==="source"?`${items.length} leads from ${v.toLowerCase()} · ${items.filter(c=>c.status==="Active").length} now active customers`:`${items.length} contacts`;
  open(k==="source"?`Leads from ${v}`:`${v} contacts`,`<p class="dsub">${sub}</p>`+recList(items,cRow),root=>bindRec(root,items,c=>contactView(c.i)))}
function contactView(ci){const c=C[ci];const cc=calls.filter(x=>x.ci===ci),jj=jobs.filter(x=>x.ci===ci),qq=quotes.filter(x=>x.ci===ci);
  const ev=[...cc.map(x=>({t:x.t,cls:OUT[x.outcome],h:`Call · ${x.outcome}`,s:x.sum,go:()=>callView(x.i)})),...jj.map(x=>({t:x.start,cls:"green",h:`${x.svc} · ${x.status}`,s:fmtDT(x.start),go:()=>jobView(x.i)})),...qq.map(x=>({t:NOW,cls:x.stage==="Needs you"?"amber":"teal",h:`Quote · ${x.job} · ${money(x.amt)}`,s:`${x.stage}. ${x.note}.`}))].sort((a,b)=>b.t-a.t);
  const html=`<span class="pill ${STAT[c.status]||"grey"}">${c.status}</span><dl class="meta"><dt>Phone</dt><dd>${phone(c.phone)}</dd><dt>Address</dt><dd>${addr(c)}</dd><dt>Lead source</dt><dd>${c.source}</dd><dt>Calls</dt><dd>${cc.length}</dd><dt>Jobs</dt><dd>${jj.length}</dd></dl>
   <div class="secth">Timeline</div>${ev.length?`<ul class="tl">${ev.map((e,i)=>`<li class="${e.cls}"><b>${e.go?`<button class="link" data-e="${i}">${esc(e.h)}</button>`:esc(e.h)}</b><small>${fmtDT(e.t)}</small>${esc(e.s)}</li>`).join("")}</ul>`:`<p class="empty">No calls or jobs yet. Added from ${c.source.toLowerCase()}.</p>`}`;
  open(c.name,html,root=>root.querySelectorAll("[data-e]").forEach(b=>b.onclick=ev[+b.dataset.e].go))}
function dayView(d){const e=new Date(+d+DAY),cc=calls.filter(c=>c.t>=d&&c.t<e).sort((a,b)=>a.t-b.t),jj=jobs.filter(j=>j.start>=d&&j.start<e);
  open(fmtD(d),`<p class="dsub">${cc.length} call${cc.length===1?"":"s"} · ${jj.length} job${jj.length===1?"":"s"} booked</p><div class="secth">Jobs booked</div>`+recList(jj,jobRow,null,"No jobs booked this day.")+`<div class="secth">Calls</div><div id="dc">`+recList(cc,callRow)+`</div>`,
    root=>{const lists=root.querySelectorAll(".rec");if(jj.length&&lists[0])lists[0].querySelectorAll("button").forEach(b=>b.onclick=()=>jobView(jj[+b.dataset.i].i));const l2=root.querySelector("#dc .rec");if(l2)l2.querySelectorAll("button").forEach(b=>b.onclick=()=>callView(cc[+b.dataset.i].i))})}
$("#ovpill").onclick=()=>listCalls(calls.filter(c=>over(c.t)),"Overnight calls");
function setRange(r){RANGE=r;$("#r7").setAttribute("aria-pressed",r===7);$("#r30").setAttribute("aria-pressed",r===30);renderKPIs();renderTrend()}
$("#r7").onclick=()=>setRange(7);$("#r30").onclick=()=>setRange(30);
function renderAll(){renderKPIs();renderBars();renderDonut();renderTrend();renderLists();}
function tick(){NOW=new Date();$("#clock").textContent=NOW.toLocaleDateString("en-US",{weekday:"long"})+" · "+fmtT(NOW);}
async function refresh(){
  try{
    const r=await backend.functions.call("dashboard-da");
    if(r.responseStatusCode!==200||!r.body||r.body.error)throw new Error((r.body&&r.body.error)||"function_call_failed_"+r.responseStatusCode);
    const J=r.body;
    if(J.hash!==HASH){HASH=J.hash;load(J);if(!$("#drawer").classList.contains("on"))renderAll();}
    const g=new Date(J.generated),mins=Math.max(0,Math.round((Date.now()-g)/60000));
    $("#sync").textContent="Live · updated "+(mins<1?"just now":mins<60?mins+" min ago":fmtDT(g));
  }catch(e){$("#sync").textContent="Live data unavailable";}
}
tick();setInterval(tick,30000);refresh();setInterval(refresh,60000);
$("#close").addEventListener("click",()=>renderAll());
addEventListener("resize",()=>{$("#tip").style.opacity=0});
}

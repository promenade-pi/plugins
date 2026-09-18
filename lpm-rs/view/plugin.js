"use strict";(()=>{var M=document.getElementById("root")??(()=>{let n=document.createElement("div");return n.id="root",document.body.appendChild(n),n})(),T=document.createElement("style");T.textContent=`
  :root, body { margin: 0; padding: 0; }
  body {
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: var(--text, #1a1a1a);
    background: var(--bg, #fff);
  }
  #root { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
  .lpm-header {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 8px 12px; border-bottom: 1px solid var(--border, #e2e2e2);
    background: var(--bg-soft, #f7f7f7);
  }
  .lpm-stat { color: var(--text-dim, #666); font-variant-numeric: tabular-nums; }
  .lpm-warn {
    color: var(--warn, #9a6700); background: var(--bg-sunken, #fff3cd);
    border-radius: 4px; padding: 2px 6px;
  }
  .lpm-filter {
    margin-left: auto; padding: 4px 8px; border: 1px solid var(--border, #ccc);
    border-radius: 4px; font: inherit; background: var(--bg, #fff); color: inherit;
    min-width: 160px;
  }
  .lpm-table-wrap { flex: 1; overflow: auto; }
  table.lpm-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  .lpm-table th, .lpm-table td { padding: 6px 10px; text-align: left; white-space: nowrap; }
  .lpm-table th {
    position: sticky; top: 0; background: var(--bg-soft, #f7f7f7);
    border-bottom: 1px solid var(--border, #e2e2e2); cursor: pointer; user-select: none;
    color: var(--text-dim, #666); font-weight: 600;
  }
  .lpm-table th.sorted { color: var(--accent, #2563eb); }
  .lpm-table tbody tr { border-bottom: 1px solid var(--border, #eee); cursor: pointer; }
  .lpm-table tbody tr:hover { background: var(--bg-soft, #f7f7f7); }
  .lpm-rank { color: var(--text-dim, #666); }
  .lpm-tree { font-family: ui-monospace, monospace; white-space: normal; }
  .lpm-chip {
    display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 11px;
    margin: 1px 3px 1px 0; color: #fff;
  }
  .lpm-bar-wrap {
    display: inline-flex; align-items: center; gap: 6px; min-width: 70px;
  }
  .lpm-bar { width: 44px; height: 6px; border-radius: 3px; background: var(--bg-sunken, #eee); overflow: hidden; }
  .lpm-bar > span { display: block; height: 100%; background: var(--accent, #2563eb); }
  .lpm-empty { padding: 24px; text-align: center; color: var(--text-dim, #666); }
`;document.head.appendChild(T);M.innerHTML="";var k=document.createElement("div");k.className="lpm-header";var w=document.createElement("span");w.className="lpm-stat";var u=document.createElement("span");u.className="lpm-warn";u.hidden=!0;u.textContent="search stopped early (time budget) \u2014 results may be incomplete";var p=document.createElement("input");p.type="search";p.placeholder="filter by activity\u2026";p.className="lpm-filter";k.append(w,u,p);var d=document.createElement("div");d.className="lpm-table-wrap";M.append(k,d);var m="rank",b=!0,H="",x=null,S=[{key:"weightedScore",label:"score",title:"Weighted combination of every metric below."},{key:"support",label:"support",title:"How often this fragment occurs (squashed occurrence count)."},{key:"confidence",label:"confidence",title:"How much of each activity's own occurrences this fragment accounts for."},{key:"determinism",label:"determinism",title:"How little ambiguity there is about what happens next while replaying it."},{key:"languageFit",label:"lang. fit",title:"How much of the fragment\u2019s own possible behaviour was actually observed."},{key:"coverage",label:"coverage",title:"Fraction of the whole log's events in this fragment's own activity set."},{key:"avgNumFirings",label:"avg. firings",title:"Average number of activities fired per occurrence."}];function v(n,a){return a==="rank"?n.rank:n.scores[a]}function R(n){let a=document.createElement("span");a.className="lpm-bar-wrap";let l=document.createElement("span");l.className="lpm-bar";let i=document.createElement("span");i.style.width=`${Math.max(0,Math.min(1,n))*100}%`,l.appendChild(i);let r=document.createElement("span");return r.textContent=n.toFixed(2),a.append(l,r),a}function E(){if(!x){d.innerHTML='<div class="lpm-empty">no local process models yet</div>';return}let{entries:n,stats:a}=x;w.textContent=`${n.length} shown \xB7 ${a.candidatesScored.toLocaleString()} candidates scored \xB7 ${a.totalCases.toLocaleString()} cases \xB7 ${a.distinctActivities} activities considered`,u.hidden=!a.truncatedBySearchBudget;let l=H.trim().toLowerCase(),i=l?n.filter(e=>e.activities.some(t=>t.toLowerCase().includes(l))):n.slice();i.sort((e,t)=>{let c=v(e,m)-v(t,m);return b?c:-c});let r=document.createElement("table");r.className="lpm-table";let C=document.createElement("thead"),f=document.createElement("tr"),g=document.createElement("th");g.textContent="#",g.title='Pass this as the "Fragment rank" (index) parameter of "Local Process Model \u2192 Petri Net" to view it as a diagram.',f.appendChild(g);let L=document.createElement("th");L.textContent="fragment",f.appendChild(L);for(let e of S){let t=document.createElement("th");t.textContent=e.label,t.title=e.title,m===e.key&&t.classList.add("sorted"),t.addEventListener("click",()=>{m===e.key?b=!b:(m=e.key,b=!1),E()}),f.appendChild(t)}C.appendChild(f),r.appendChild(C);let N=document.createElement("tbody");for(let e of i){let t=document.createElement("tr");t.addEventListener("click",()=>{promenade.select(e.activities.map(s=>({kind:"activity",id:s})))});let c=document.createElement("td");c.className="lpm-rank",c.textContent=String(e.rank),t.appendChild(c);let h=document.createElement("td");h.className="lpm-tree";for(let s of e.activities){let o=document.createElement("span");o.className="lpm-chip",o.textContent=s;try{o.style.background=promenade.color("activity",s)}catch{}h.appendChild(o)}let y=document.createElement("div");y.textContent=e.pretty,y.style.opacity="0.75",h.appendChild(y),t.appendChild(h);for(let s of S){let o=document.createElement("td");o.appendChild(R(v(e,s.key))),t.appendChild(o)}N.appendChild(t)}r.appendChild(N),d.innerHTML="",i.length?d.appendChild(r):d.innerHTML='<div class="lpm-empty">no fragments match this filter</div>'}p.addEventListener("input",()=>{H=p.value,E()});promenade.on("theme",()=>{});var F=promenade.artifact();x=F.value??null;E();promenade.ready();})();

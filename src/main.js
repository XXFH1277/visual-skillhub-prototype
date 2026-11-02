const API=import.meta.env.VITE_API||'http://localhost:8787';
const S=[
{id:'product',ico:'📦',name:'电商产品图',desc:'上传产品主图，生成白底图或场景图，适合主图/橱窗。',cost:10,main:'产品主图'},
{id:'detail',ico:'📜',name:'详情页长图',desc:'根据产品图与卖点，生成适配淘宝/京东的详情页长图。',cost:30,main:'产品图（可多张）'},
{id:'poster',ico:'🎨',name:'海报 / 菜单',desc:'活动海报、门店菜单一键排版出图。',cost:15,main:'主视觉图或菜单图'},
{id:'interior',ico:'🛋️',name:'装修效果图',desc:'上传空间照片或平面图，生成指定风格的效果图。',cost:25,main:'空间照片或平面图'}];
let st=JSON.parse(localStorage.vsh||'null')||{bal:500,ledger:[{t:'2026-10-30',d:'月费套餐赠送',v:500}],tasks:[
{id:'T1003',s:'product',t:'2026-10-31 14:20',st:'成功'},{id:'T1002',s:'interior',t:'2026-10-29 10:02',st:'失败·已退回'},{id:'T1001',s:'poster',t:'2026-10-28 09:15',st:'成功'}],failShown:false};
const save=()=>{localStorage.vsh=JSON.stringify(st);document.getElementById('bal').textContent='积分 '+st.bal};
const sk=id=>S.find(s=>s.id===id);const app=document.getElementById('app');let job=null;
const now=()=>new Date().toLocaleString('zh-CN',{hour12:false}).slice(0,16);
function charge(v,d){st.bal+=v;st.ledger.unshift({t:now(),d,v});save()}
const R={
'':()=>`<h1>视觉出图</h1><p class="muted">选择一个技能，上传素材，一键出图。</p><div class="grid">${S.map(s=>`<a class="card" href="#/skill/${s.id}"><div class="ico">${s.ico}</div><h2>${s.name}</h2><div class="muted">${s.desc}</div><span class="tag">${s.cost} 积分/张（占位）</span></a>`).join('')}</div>`,
skill:id=>{const s=sk(id);return`<a href="#/" class="muted">← 返回</a><h1>${s.ico} ${s.name}</h1><p>${s.desc}</p><div class="two"><div class="ph">示例 · 原图</div><div class="ph">示例 · 生成后</div></div><p>消耗：<b>${s.cost}</b> 积分/张（占位）</p><a class="btn" href="#/upload/${s.id}">开始使用</a>`},
upload:id=>{const s=sk(id);setTimeout(()=>bindUpload(s));return`<a href="#/skill/${id}" class="muted">← 返回</a><h1>${s.name} · 上传素材</h1>
<label>${s.main}（必填）</label><input type="file" accept="image/*" id="main"><div class="three" id="mainp" style="margin-top:8px"></div>
<label>参考图（选填，最多 3 张，只影响风格）</label><input type="file" accept="image/*" multiple id="ref"><div class="three" id="refp" style="margin-top:8px"></div>
<label>风格说明（一句话）</label><div class="noterow"><textarea id="note" rows="3" placeholder="例如：极简白底、暖色调、新中式"></textarea><button type="button" class="btn ghost sm" id="polish">✨ 一键润色</button></div>
<div class="two"><div><label>尺寸</label><select id="size"><option>1:1 (800×800)</option><option>3:4</option><option>16:9</option></select></div><div><label>张数</label><select id="cnt"><option>1</option><option selected>2</option><option>3</option></select></div></div>
<label><input type="checkbox" id="fail" style="width:auto"> 演示失败流程（失败会退回积分）</label>
<p>预计消耗：<b id="est"></b> 积分 · 当前余额 ${st.bal}</p><div id="warn"></div><button class="btn" id="go">提交任务（先扣积分）</button>`},
progress:()=>{if(!job)return location.hash='#/','';setTimeout(runProgress);return`<h1>生成中…</h1><p class="muted">${sk(job.s).name} · 任务 ${job.id} · 已扣 ${job.cost} 积分</p><div class="bar"><div id="pb" style="width:0"></div></div><p id="ps" class="muted">识图与分类…</p>`},
result:()=>{if(!job)return location.hash='#/','';const s=sk(job.s);
if(job.failed)return`<h1>生成失败</h1><div class="note">任务 ${job.id} 生成失败，<b>${job.cost} 积分已原路退回</b>。</div><a class="btn" href="#/upload/${s.id}">重新提交</a> <a class="btn ghost" href="#/">返回首页</a>`;
return`<h1>生成结果</h1><p class="muted">${s.name} · 任务 ${job.id}</p><div class="note ok">已成功生成，本次 ${job.cost} 积分已消耗，不予退回。</div>
<div class="three">${job.images?job.images.map(u=>`<a class="ph" href="${u}" target="_blank"><img src="${u}"></a>`).join(''):Array.from({length:job.n},(_,i)=>`<div class="ph">结果 ${i+1}（占位）</div>`).join('')}</div>${job.images?'<p class="muted">真实生成（Codex 后端）</p>':'<p class="muted">后端未连接，显示占位结果</p>'}<div></div>
<div class="row"><button class="btn ghost" disabled title="原型暂不支持">下载（原型禁用）</button><button class="btn" id="regen">再生成（扣 ${job.cost} 积分）</button><button class="btn ghost" onclick="alert('人工修图工单（占位）')">人工修图</button></div>`},
credits:()=>`<h1>积分中心</h1><div class="card"><div class="muted">当前余额</div><div style="font-size:32px;font-weight:700;color:#5b4cf0">${st.bal}</div></div>
<h2>月费套餐（占位）</h2><div class="grid">${[['基础版','¥XX/月','XXX 积分'],['专业版','¥XX/月','XXXX 积分'],['企业版','联系我们','定制']].map(p=>`<div class="card"><h2>${p[0]}</h2><div>${p[1]}</div><div class="muted">${p[2]}</div><button class="btn" style="margin-top:10px" onclick="alert('支付接入中（占位）')">订阅</button></div>`).join('')}</div>
<h2>积分明细</h2><table><tr><th>时间</th><th>说明</th><th>变动</th></tr>${st.ledger.map(l=>`<tr><td>${l.t}</td><td>${l.d}</td><td style="color:${l.v<0?'#d33':'#2a8'}">${l.v>0?'+':''}${l.v}</td></tr>`).join('')}</table>
<p><button class="btn ghost" onclick="localStorage.removeItem('vsh');location.reload()">重置演示数据</button></p>`,
tasks:()=>`<h1>我的任务</h1><table><tr><th>任务</th><th>技能</th><th>时间</th><th>状态</th></tr>${st.tasks.map(t=>`<tr><td>${t.id}</td><td>${sk(t.s).name}</td><td>${t.t}</td><td>${t.st}</td></tr>`).join('')}</table>`};
function preview(inp,box,max){inp.onchange=()=>{const f=[...inp.files].slice(0,max);if(inp.files.length>max)alert('最多 '+max+' 张');box.innerHTML=f.map(x=>`<div class="ph"><img src="${URL.createObjectURL(x)}"></div>`).join('')}}
function toast(m){let d=document.createElement('div');d.className='toast';d.textContent=m;document.body.appendChild(d);setTimeout(()=>d.remove(),2000)}
function bindUpload(s){const m=document.getElementById('main'),c=document.getElementById('cnt'),e=document.getElementById('est');
preview(m,document.getElementById('mainp'),1);preview(document.getElementById('ref'),document.getElementById('refp'),3);
const P={product:t=>`电商产品摄影，${t}，主体居中清晰，柔和棚拍光，细节锐利，干净背景，高级质感，8K 商业级画质`,
detail:t=>`电商详情页长图设计，${t}，版式分区清晰，卖点图文排版，统一品牌配色，留白得当，适配手机浏览`,
poster:t=>`商业海报/菜单设计，${t}，标题醒目，层次分明，色彩协调，字体排版精致，适合印刷与线上发布`,
interior:t=>`室内设计效果图，${t}，真实材质与自然光照，空间透视准确，软装搭配协调，照片级渲染，高清细节`};
document.getElementById('polish').onclick=()=>{const n=document.getElementById('note'),t=n.value.trim();if(!t)return toast('请先写一句风格说明，再点润色');n.value=P[s.id](t.replace(/[。，,.]+$/,''));n.focus();toast('已润色，可继续修改')};
const up=()=>e.textContent=s.cost*c.value;c.onchange=up;up();
document.getElementById('go').onclick=()=>{const cost=s.cost*c.value;if(!m.files.length)return alert('请先上传'+s.main);
if(st.bal<cost){document.getElementById('warn').innerHTML='<div class="note">积分不足，请 <a href="#/credits"><b>充值/升级月费</b></a></div>';return}
job={id:'T'+Date.now().toString().slice(-5),s:s.id,n:+c.value,cost,fail:document.getElementById('fail').checked};
charge(-cost,`${s.name} 任务 ${job.id} 扣除`);
if(!job.fail){const fd=new FormData();fd.append('skillId',s.id);fd.append('styleNote',document.getElementById('note').value);fd.append('size',document.getElementById('size').value);fd.append('count',c.value);
if(m.files[0])fd.append('main',m.files[0]);[...document.getElementById('ref').files].slice(0,3).forEach(f=>fd.append('reference',f));
const j=job;j.pending=fetch(API+'/api/generate',{method:'POST',body:fd}).then(r=>r.ok?r.json():Promise.reject()).then(d=>{j.images=d.images.map(u=>API+u)}).catch(()=>{j.mock=true})}
location.hash='#/progress'}}
function runProgress(){const pb=document.getElementById('pb'),ps=document.getElementById('ps');const steps=['识图与分类…','匹配工作流…','多模态生成中…','质量自检…'];let p=0;
const iv=setInterval(()=>{p+=5;if(!pb){clearInterval(iv);return}pb.style.width=p+'%';ps.textContent=steps[Math.min(3,p/25|0)];
if(job.fail&&p>=60){clearInterval(iv);job.failed=true;charge(job.cost,`任务 ${job.id} 失败退回`);st.tasks.unshift({id:job.id,s:job.s,t:now(),st:'失败·已退回'});save();location.hash='#/result'}
if(p>=95&&job.pending&&!job.images&&!job.mock){p=95;ps.textContent='Codex 正在生成图片，约需 1–3 分钟…';job.pending.finally(()=>{});return}
if(p>=100){clearInterval(iv);st.tasks.unshift({id:job.id,s:job.s,t:now(),st:'成功'});save();location.hash='#/result'}},150)}
function render(){const [r,a]=location.hash.replace(/^#\/?/,'').split('/');app.innerHTML=(R[r]||R[''])(a);window.scrollTo(0,0);
const rg=document.getElementById('regen');if(rg)rg.onclick=()=>{if(st.bal<job.cost)return alert('积分不足');job={...job,images:null,pending:null,mock:true,id:'T'+Date.now().toString().slice(-5),fail:false,failed:false};charge(-job.cost,`再生成 任务 ${job.id} 扣除`);location.hash='#/progress'}}
addEventListener('hashchange',render);save();render();

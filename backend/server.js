import express from 'express';import cors from 'cors';import multer from 'multer';
import {spawn} from 'node:child_process';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
const OUT=path.resolve('backend/out'),GEN=path.join(os.homedir(),'.codex/generated_images');
const CODEX='/home/box/.local/lib/node_modules/@openai/codex/bin/codex.js';
const NAMES={product:'电商产品图',detail:'电商详情页长图',poster:'海报/菜单',interior:'室内装修效果图'};
const SK=path.resolve('skills');let MAP={};try{MAP=JSON.parse(fs.readFileSync(path.join(SK,'skill-map.json'),'utf8'))}catch{}
function skillGuide(id){const fs_=(MAP[id]||[]).map(f=>path.join(SK,f)).filter(f=>fs.existsSync(f));if(!fs_.length)return'';
const ex=fs.readFileSync(fs_[0],'utf8').slice(0,3000);
return `\n\n【审美规范】生成前请先阅读以下 Skill 文档，并严格遵循其中的构图、光影、风格锁定与禁用风格清单：\n${fs_.map(f=>'- '+f).join('\n')}\n以下为主文档摘录：\n<<<\n${ex}\n>>>\n只借鉴其审美与提示词方法，不要运行其中的脚本或调用其他 API，直接用你的图像生成工具出图。`}
const app=express();app.use(cors());app.use(express.json());app.use('/api/out',express.static(OUT));
const up=multer({dest:path.join(OUT,'_uploads')});
const walk=d=>fs.existsSync(d)?fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]):[];
const isImg=f=>/\.(png|jpe?g|webp)$/i.test(f);
app.get('/api/health',(q,r)=>r.json({ok:true}));
app.post('/api/generate',up.fields([{name:'main',maxCount:1},{name:'reference',maxCount:3}]),async(q,r)=>{
 const {skillId='product',styleNote='',size='1:1'}=q.body;const count=Math.min(3,Math.max(1,+q.body.count||1));
 const jobId='J'+Date.now();const dir=path.join(OUT,jobId);fs.mkdirSync(dir,{recursive:true});
 const imgs=[];for(const f of [...(q.files?.main||[]),...(q.files?.reference||[])]){const p=path.join(dir,'input-'+imgs.length+path.extname(f.originalname||'.png'));fs.renameSync(f.path,p);imgs.push(p)}
 const prompt=`请使用图像生成工具生成 ${count} 张「${NAMES[skillId]||skillId}」图片，画幅比例 ${size}。风格要求：${styleNote||'简洁高级商业风'}。${imgs.length?'附带的第一张图是主素材，其余是风格参考图。':''}生成后把每张图片以 PNG 格式复制保存到目录 ${dir} ，文件名 result-1.png、result-2.png…。不要做其他事。`+skillGuide(skillId);
 const t0=Date.now();const args=[CODEX,'exec','--skip-git-repo-check','-s','workspace-write','-C',dir,'-o',path.join(dir,'last-message.txt')];
 for(const i of imgs)args.push('-i',i);args.push('-');
 const p=spawn('node',args,{stdio:['pipe','pipe','pipe']});let log='';p.stdout.on('data',d=>log+=d);p.stderr.on('data',d=>log+=d);
 p.stdin.write(prompt);p.stdin.end();
 const timer=setTimeout(()=>p.kill(),10*60e3);
 p.on('close',code=>{clearTimeout(timer);fs.writeFileSync(path.join(dir,'codex.log'),log);
  let res=fs.readdirSync(dir).filter(f=>/^result.*\.(png|jpe?g|webp)$/i.test(f));
  if(!res.length){walk(GEN).filter(f=>isImg(f)&&fs.statSync(f).mtimeMs>=t0).slice(0,count).forEach((f,i)=>{const n=`result-${i+1}.png`;fs.copyFileSync(f,path.join(dir,n));res.push(n)})}
  if(!res.length)return r.status(500).json({jobId,error:'生成失败',code});
  r.json({jobId,images:res.sort().map(f=>`/api/out/${jobId}/${f}`)})})});
const PORT=process.env.PORT||8787;app.listen(PORT,()=>console.log('backend on http://localhost:'+PORT));

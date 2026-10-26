import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const root='/tmp/pgx-issue10-runtime';
const source=path.join(root,'evidence',process.env.PGX_RECOVERY_SOURCE??'red-failed');
const evidence=path.join(root,'evidence',process.env.PGX_RECOVERY_TAG??'recovery-final');fs.mkdirSync(evidence,{recursive:true});
const work=fs.readFileSync(path.join(source,'workdir.txt'),'utf8').trim();
const session=path.join(source,'sessions',fs.readdirSync(path.join(source,'sessions')).find(n=>n.endsWith('.jsonl')));
const out=fs.createWriteStream(path.join(evidence,'rpc-transcript.jsonl'));const recs=[];let buf='';let finish;const done=new Promise(r=>finish=r);
const child=spawn('pi',['--mode','rpc','--session-dir',path.join(source,'sessions'),'-ne','-ns','-np','--no-mcp','-e','/Users/admin/project/pi-goal-x/extensions/goal.ts','-e','/tmp/pgx-issue10-runtime/observe-context.ts'],{cwd:work});
function send(r){out.write(JSON.stringify({at:new Date().toISOString(),sent:r})+'\n');child.stdin.write(JSON.stringify(r)+'\n');}
child.stderr.on('data',d=>out.write(JSON.stringify({stderr:d.toString()})+'\n'));
child.stdout.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);if(!l)continue;let r;try{r=JSON.parse(l)}catch{continue}recs.push(r);out.write(JSON.stringify({at:new Date().toISOString(),record:r})+'\n');if(r.type==='extension_ui_request'&&r.method==='confirm')send({type:'extension_ui_response',id:r.id,confirmed:true});if(r.type==='response'&&r.id==='recovery')finish(r);}});
fs.cpSync(path.join(work,'.pi','goals'),path.join(evidence,'before'),{recursive:true});
setTimeout(()=>send({id:'context',type:'prompt',message:'/verify-context'}),1500);
setTimeout(()=>send({id:'focus',type:'prompt',message:'/goal-focus'}),1800);
setTimeout(()=>send({id:'recovery',type:'prompt',message:'/goal-recovery tasks'}),2800);
const timeout=setTimeout(()=>finish({timeout:true}),20000);
try{const response=await done;await new Promise(r=>setTimeout(r,500));fs.cpSync(path.join(work,'.pi','goals'),path.join(evidence,'after'),{recursive:true});fs.writeFileSync(path.join(evidence,'response.json'),JSON.stringify(response,null,2));console.log(JSON.stringify({work,session,evidence,response}));}finally{clearTimeout(timeout);child.kill('SIGTERM');await new Promise(r=>setTimeout(r,500));if(child.exitCode===null)child.kill('SIGKILL');out.end();}

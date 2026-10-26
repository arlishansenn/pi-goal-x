import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const [,,goalExt,tag]=process.argv;
const root='/tmp/pgx-issue10-runtime';
const evidence=path.join(root,'evidence',tag);
fs.mkdirSync(evidence,{recursive:true});
const work=fs.mkdtempSync('/tmp/pgx-issue10-work-');
fs.writeFileSync(path.join(evidence,'workdir.txt'),work);
fs.mkdirSync(path.join(work,'.pi'),{recursive:true});
fs.writeFileSync(path.join(work,'.pi','pi-goal-x-settings.json'),JSON.stringify({maxAutonomousRuns:3,disabled:true}));
const out=fs.createWriteStream(path.join(evidence,'rpc-transcript.jsonl'));
const child=spawn('pi',['--mode','rpc','--session-dir',path.join(evidence,'sessions'),'-ne','-ns','-np','--no-mcp','-e',goalExt,'-e',process.env.PGX_PRODUCER_EXT??path.join(root,'producer.ts')],{cwd:work});
let buf='';let finish;const done=new Promise(r=>finish=r);let firstAgentEnd=false;const records=[];
function send(r){out.write(JSON.stringify({at:new Date().toISOString(),sent:r})+'\n');child.stdin.write(JSON.stringify(r)+'\n');}
child.stderr.on('data',d=>out.write(JSON.stringify({at:new Date().toISOString(),stderr:d.toString()})+'\n'));
child.stdout.on('data',d=>{buf+=d;let n;while((n=buf.indexOf('\n'))>=0){const l=buf.slice(0,n);buf=buf.slice(n+1);if(!l)continue;let r;try{r=JSON.parse(l)}catch{continue}records.push(r);out.write(JSON.stringify({at:new Date().toISOString(),record:r})+'\n');
 if(r.type==='extension_ui_request'&&['confirm','select','input'].includes(r.method))send({type:'extension_ui_response',id:r.id,cancelled:true});
 if(r.type==='message_end'&&r.message?.customType==='pstack-agent'){fs.writeFileSync(path.join(evidence,'native-notice.json'),JSON.stringify(r.message,null,2));console.log('NATIVE_NOTICE',r.message.details?.status);}
 if(r.type==='agent_end'){firstAgentEnd=true;capture('agent-end');}
}});
function capture(label){const goals=path.join(work,'.pi','goals');if(fs.existsSync(goals))fs.cpSync(goals,path.join(evidence,'snaps',label),{recursive:true});}
const deadline=setTimeout(()=>finish('bounded-timeout'),180000);
setTimeout(()=>{send({id:'doctor',type:'get_state'});send({id:'create',type:'prompt',message:process.env.PGX_OBJECTIVE??'/goal-direct Launch exactly one pstack agent in background using agent with run_in_background true, description "wait10 proof", prompt "Use bash to run sleep 12, then reply CHILD_DONE. Do not edit files or launch agents." After launching, reply "Waiting for child" and end this turn immediately. Do not poll and do not do other work. On receipt of the pstack-agent completed notification write its agentId and status into result.txt using the write tool, then call update_goal with status paused and reason "Verification complete". Never create another agent.'});},1800);
const check=setInterval(()=>{if(fs.existsSync(path.join(work,'result.txt'))&&records.some(r=>r.type==='tool_execution_end'&&r.toolName==='update_goal')){capture('result');finish('result-written-and-paused')}else if(firstAgentEnd&&records.some(r=>r.type==='message_end'&&r.message?.customType==='pstack-agent')){capture('notice-observed')}},1000);
try{const reason=await done;capture('final');fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({reason,work,evidence,result:fs.existsSync(path.join(work,'result.txt'))?fs.readFileSync(path.join(work,'result.txt'),'utf8'):null},null,2));console.log(JSON.stringify({reason,work,evidence}));}finally{clearTimeout(deadline);clearInterval(check);child.kill('SIGTERM');await new Promise(r=>setTimeout(r,800));if(child.exitCode===null)child.kill('SIGKILL');out.end();}

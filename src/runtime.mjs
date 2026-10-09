import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
export class GatewayRuntime extends EventEmitter {
  constructor(script,configPath) { super();Object.assign(this,{script,configPath,state:'stopped',recent:[],requests:new Map(),active:new Map(),total:0,failed:0}); }
  record(event) {
    this.recent.push(event);if(this.recent.length>150)this.recent.shift();
    if(event.event==='listening')this.state='running';
    if(event.event==='upstream.request') {
      this.total++;const r={...event,started:Date.now(),status:'进行中'};
      this.requests.set(event.id,r);this.active.set(event.id,r);
      if(this.requests.size>50)this.requests.delete(this.requests.keys().next().value);
    }
    const r=this.requests.get(event.id);
    if(r && (event.status>=400 || /error|timeout/.test(event.event))) {
      if(!r.failed){r.failed=true;this.failed++;}r.status='失败';
    }
    if(r && event.event==='request.end'){r.elapsedMs=event.elapsedMs;r.status=r.failed?'失败':'完成';this.active.delete(event.id);}
    this.emit('change');
  }
  start(modes) {
    if(this.child || !modes.length)throw new Error('请选择至少一种入口，并先停止已运行的代理');
    this.state='starting';this.total=0;this.failed=0;this.requests.clear();this.active.clear();
    const child=spawn(process.execPath,[this.script,this.configPath],{env:{...process.env,GATEWAY_MODES:modes.join(','),GATEWAY_UI:'1'},stdio:['ignore','pipe','pipe']});
    this.child=child;let pending='';child.stdout.setEncoding('utf8');
    child.stdout.on('data',text=>{pending+=text;let i;while((i=pending.indexOf('\n'))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);try{this.record(JSON.parse(line));}catch{this.record({event:'output',message:line.slice(0,500)});}}});
    child.stderr.setEncoding('utf8');child.stderr.on('data',text=>this.record({event:'error',message:text.slice(0,1000)}));
    child.on('error',error=>this.record({event:'error',message:error.message}));
    this.exited=new Promise(resolve=>child.once('close',code=>{this.child=null;this.state='stopped';for(const r of this.active.values())r.status='已停止';this.active.clear();this.record({event:'stopped',message:`代理已停止 (${code??'signal'})`});resolve();}));
    this.emit('change');
  }
  async stop(){if(!this.child)return;this.state='stopping';this.emit('change');this.child.kill();await this.exited;}
}

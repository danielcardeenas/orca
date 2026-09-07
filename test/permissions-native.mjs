// Manual native verification harness. Only disposable sessions on this fixed test socket.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promptOn } from '../src/collector/screen.ts';
import { answerPermission } from '../src/collector/permissions.ts';
import { TmuxHost } from '../src/collector/tmux.ts';
const root = '/tmp/orca-native-permissions-task07';
const socket = 'orca-native-permissions-task07';
const host = new TmuxHost(socket);
const runtime = process.argv[3] ?? 'codex';
if (!['codex','codex-mcp','claude'].includes(runtime)) throw Error('test runtime only');
const name = `orca-native-permission-${runtime}`;
const action = process.argv[2];
if (action === 'start') {
  const cwd = path.join(root, runtime, 'workspace');
  const config = path.join(root, runtime, 'config');
  fs.mkdirSync(cwd, {recursive:true}); fs.mkdirSync(config,{recursive:true,mode:0o700});
  let prompt = 'This is an authorized isolated terminal permission UI test. Do not inspect files or use other tools. Request explicit manual approval to execute exactly: printf ORCA_NATIVE_PERMISSION_OK . Use require_escalated with a short justification if available, even though this command is harmless. Run it once only after approval, then report the output and stop. If denied, do not retry.';
  let argv, env;
  if(runtime.startsWith('codex')) {
    if(runtime==='codex-mcp'){
      prompt='Call only the playwright MCP tool browser_tabs with action new, url https://example.invalid/native-permission-test, local true. This is a harmless isolated fixture. Wait for its manual permission approval; never change the approval configuration. Report the tool result and stop. If denied, stop without retrying.';
      fs.writeFileSync(path.join(config,'config.toml'),`[mcp_servers.playwright]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(path.resolve('test/permissions-mcp-fixture.mjs'))}]\n[mcp_servers.playwright.tools.browser_tabs]\napproval_mode = "prompt"\n`);
    }
    fs.copyFileSync(path.join(os.homedir(),'.codex/auth.json'),path.join(config,'auth.json')); fs.chmodSync(path.join(config,'auth.json'),0o600);
    argv=['/Users/danielcardenas/.nvm/versions/node/v22.17.0/bin/codex','--no-alt-screen','-C',cwd,'-s','read-only','-a','on-request',prompt]; env={CODEX_HOME:config};
  } else {
    argv=['/Users/danielcardenas/.local/bin/claude','--bare','--settings',JSON.stringify({permissions:{ask:['Bash']}}),'--setting-sources','','--permission-mode','default','--strict-mcp-config','--tools','Bash','--',prompt]; env={CLAUDE_CONFIG_DIR:config,ANTHROPIC_BASE_URL:'http://127.0.0.1:45981',ANTHROPIC_API_KEY:'isolated-fixture-key'};
    fs.writeFileSync(path.join(config,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,theme:'dark'}));
  }
  env.PATH=process.env.PATH;
  const childArgs=argv; argv=[process.execPath,'-e',`const cp=require('node:child_process');const a=${JSON.stringify(childArgs)};const r=cp.spawnSync(a[0],a.slice(1),{stdio:'inherit'});console.log('NATIVE_EXIT',r.status,r.error?.message??'');process.stdin.resume();`];
  console.log(await host.spawn({name,cwd,env,argv,cols:160,rows:45}));
} else if(action==='cleanup') {
  console.log(await host.killServer());
  for(const runtime of ['codex','codex-mcp']) fs.rmSync(path.join(root,runtime,'config','auth.json'),{force:true});
  console.log('Disposable native server closed; copied authentication removed');
} else if(action==='view') {
  const view=await host.permissionView(name); if(view){fs.writeFileSync(path.join(root,`${runtime}-screen.txt`),view.screen);console.log(view.screen);} else console.log('no view');
} else if(action==='answer') {
  const view=await host.permissionView(name); const p=view&&promptOn(view.screen); if(!p)throw Error('Native dialog not recognized; no key sent');
  const request={agentId:name,sessionId:runtime,pane:name,identity:view.identity,fingerprint:p.fingerprint,claimed:false};
  console.log(await answerPermission(request,process.argv[4]??'allow',{current:()=>true,view:()=>host.permissionView(name),key:(id,key)=>host.permissionKey(id,key,p.fingerprint),retire:reason=>console.log(reason),pending:()=>console.log('PENDING')}));
} else if(action==='key') {
  const key=process.argv[4];if(!['1','2','3','4','Up','Down','Enter','Escape'].includes(key))throw Error('test key only');
  console.log(await host.keys(name,[key]));
} else if(action==='close') console.log(await host.kill(name));
else throw Error('start/view/key/close');

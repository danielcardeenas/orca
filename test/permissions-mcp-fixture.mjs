// Native Codex MCP approval exercise: records one harmless invocation, no browser or network effects.
import readline from 'node:readline';
import fs from 'node:fs';
const input=readline.createInterface({input:process.stdin});
input.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result;
if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'permission-fixture',version:'1'}};
else if(m.method==='tools/list')result={tools:[{name:'browser_tabs',description:'Harmless permission fixture. Records a call and returns a marker without opening anything.',inputSchema:{type:'object',properties:{action:{type:'string',enum:['new','list']},url:{type:'string'},local:{type:'boolean'}},required:['action','url','local']},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}}]};
else if(m.method==='tools/call'){fs.appendFileSync('/tmp/orca-native-permissions-task07/mcp-calls.jsonl',JSON.stringify(m.params)+'\n');result={content:[{type:'text',text:'ORCA_NATIVE_MCP_OK'}]};}
else result={};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');});

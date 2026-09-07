// Deterministic model transport; the installed Claude CLI still renders and enforces approval and executes Bash.
import http from 'node:http';
import fs from 'node:fs';
const root='/tmp/orca-native-permissions-task07';
const server=http.createServer(async(req,res)=>{
 let raw='';for await(const c of req)raw+=c;
 if(!req.url?.startsWith('/v1/messages')){res.writeHead(200,{'content-type':'application/json'});res.end('{}');return;}
 const input=JSON.parse(raw);const results=(input.messages??[]).flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(c=>c.type==='tool_result');
 if(results.length)fs.writeFileSync(root+'/claude-native-tool-results.json',JSON.stringify(results,null,2));
 const done=results.length>0;
 const content=done?{type:'text',text:'Native permission fixture completed; inspect tool_result for execution or denial.'}:{type:'tool_use',id:'toolu_native_permission',name:'Bash',input:{command:'printf ORCA_NATIVE_PERMISSION_OK',description:'Print the isolated permission test marker'}};
 const msg={id:'msg_native_fixture',type:'message',role:'assistant',model:input.model,content:[content],stop_reason:done?'end_turn':'tool_use',stop_sequence:null,usage:{input_tokens:10,output_tokens:10}};
 if(!input.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(msg));return;}
 res.writeHead(200,{'content-type':'text/event-stream'});
 const emit=e=>res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
 emit({type:'message_start',message:{...msg,content:[],stop_reason:null}});
 emit({type:'content_block_start',index:0,content_block:done?{type:'text',text:''}:{...content,input:{}}});
 emit({type:'content_block_delta',index:0,delta:done?{type:'text_delta',text:content.text}:{type:'input_json_delta',partial_json:JSON.stringify(content.input)}});
 emit({type:'content_block_stop',index:0});emit({type:'message_delta',delta:{stop_reason:msg.stop_reason,stop_sequence:null},usage:{output_tokens:10}});emit({type:'message_stop'});res.end();
});server.listen(45981,'127.0.0.1',()=>console.log('isolated Anthropic fixture 45981'));

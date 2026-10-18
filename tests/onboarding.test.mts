import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createHmac } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Store } from '../src/store.mts'
import { createWorker } from '../src/worker.mts'
import { secondsNow, type Env, type Job } from '../src/domain.mts'

test('fresh database, MCP setup, signed webhook and queue deliver one DM per post with independent public receipts', async () => {
  const db = new PGlite(), account = '10000001', schema = 'ig_test_onboarding'
  const store = new Store('postgresql://test@localhost/test',account,schema)
  interface Query {text:string;values:unknown[]}
  Object.defineProperty(store,'sql',{value:{
    query(text:string,values:unknown[]=[]){return {text,values,then(resolve:(r:unknown)=>unknown,reject:(e:unknown)=>unknown){return db.query(text,values).then(r=>({rows:r.rows,rowCount:r.affectedRows})).then(resolve,reject)}}},
    transaction(queries:Query[]){return db.transaction(async tx=>{const results=[];for(const q of queries){const r=await tx.query(q.text,q.values);results.push({rows:r.rows,rowCount:r.affectedRows})}return results})},
  }})
  const jobs:Job[]=[],deferred:Promise<unknown>[]=[],writes:string[]=[]
  const env={DATABASE_URL:'postgresql://test@localhost/test',IG_ACCOUNT_ID:account,META_API_VERSION:'v26.0',META_APP_SECRET:'test-only-signing',META_ACCESS_TOKEN:'test-only-access',MCP_ADMIN_TOKEN:'admin-test-'+ 'a'.repeat(40),LIVE_SENDS:'false',RETENTION_DAYS:'30',DLQ_NAME:'instagram-comment-replies-dlq',REPLIES:{send:async(job:Job)=>{jobs.push(job)}}} as unknown as Env
  const worker=createWorker(()=>store,(async(input,init)=>{
    const url=new URL(String(input))
    assert.equal(url.hostname,'graph.instagram.com')
    if(init?.method==='POST'){
      writes.push(url.pathname)
      if(url.pathname.endsWith('/messages'))return Response.json({message_id:'test-message-'+writes.length,recipient_id:'test-recipient'})
      assert(url.pathname.endsWith('/replies'));return Response.json({id:String(90000000+writes.length)})
    }
    if(url.pathname.endsWith('/subscribed_apps'))return Response.json({data:[{id:'test-app',subscribed_fields:['comments']}]})
    return Response.json({id:'test-scoped-account',user_id:account,username:'test-owner',account_type:'BUSINESS'})
  }) as typeof fetch)
  const ctx={waitUntil(p:Promise<unknown>){deferred.push(p)}}
  async function settle(){while(deferred.length)await Promise.all(deferred.splice(0))}
  const client=new Client({name:'onboarding-test',version:'1.0.0'})
  async function call(name:string,args:Record<string,unknown>={}){
    const result=await client.callTool({name,arguments:args});assert(!result.isError);return (result.structuredContent as {data:any}).data
  }
  async function comment(id:string,mediaId:string){
    const body=JSON.stringify({object:'instagram',entry:[{id:account,time:secondsNow(),changes:[{field:'comments',value:{id,from:{id:'40000001'},media:{id:mediaId,media_product_type:'FEED'},text:'Queroooooo'}}]}]})
    const signature='sha256='+createHmac('sha256',env.META_APP_SECRET!).update(body).digest('hex')
    const response=await worker.fetch(new Request('https://template.test/webhooks/instagram',{method:'POST',body,headers:{'x-hub-signature-256':signature}}),env,ctx)
    assert.equal(response.status,200);await settle();return account+':'+id
  }
  async function drain(){while(jobs.length){const body=jobs.shift()!;await worker.queue({queue:'instagram-comment-replies',messages:[{body,attempts:1,ack(){},retry(){throw new Error('Unexpected infrastructure retry')}}]} as unknown as MessageBatch<Job>,env)}}
  try {
    for(const file of ['0001_initial.sql','0002_reliability.sql','0003_public_replies.sql','0004_post_cooldowns.sql'])await db.exec((await readFile(new URL('../migrations/'+file,import.meta.url),'utf8')).replaceAll('instagram_automation',schema))
    assert.equal((await store.settings()).paused,true)
    await client.connect(new StreamableHTTPClientTransport(new URL('https://template.test/mcp'),{fetch:async(input,init)=>worker.fetch(new Request(input as string,init),env,ctx),requestInit:{headers:{Authorization:'Bearer '+env.MCP_ADMIN_TOKEN}}}))
    assert.equal((await client.listTools()).tools.length,24)
    const created=await call('create_rule',{definition:{name:'Test campaign',keywords:['QUERO'],allowTrailingLetterRepeat:true,scope:{kind:'selected',mediaIds:['20000001','20000002']},replyText:'Test approved link https://example.invalid/guide',publicReplyText:'Enviei na DM!',cooldownSeconds:86400}})
    assert.equal(created.enabled,false)
    const before=await comment('30000001','20000001')
    assert.equal((await store.getEvent(before)).state,'skipped')
    await call('enable_rule',{ruleId:created.id,expectedRevision:created.revision})
    const first=await comment('30000002','20000001')
    assert.equal((await store.getEvent(first)).state,'pending');assert.equal(jobs.length,0)
    const refused=await client.callTool({name:'resume_account',arguments:{expectedRevision:1}});assert.equal(refused.isError,true);assert.equal(writes.length,0)
    env.LIVE_SENDS='true'
    await call('resume_account',{expectedRevision:1});await settle();await drain()
    assert.equal((await store.getEvent(first)).state,'provider_accepted')
    assert.equal((await store.getPublicReply(first)).reply?.state,'provider_accepted')
    assert.equal(writes.length,2)
    await comment('30000002','20000001');await drain();assert.equal(writes.length,2)
    const repeat=await comment('30000003','20000001');await drain()
    assert.equal((await store.getEvent(repeat)).reason,'contact_cooldown');assert.equal(writes.length,2)
    const secondPost=await comment('30000004','20000002');await drain()
    assert.equal((await store.getEvent(secondPost)).state,'provider_accepted')
    assert.equal((await store.getPublicReply(secondPost)).reply?.state,'provider_accepted')
    assert.equal(writes.length,4)
    const health=await call('get_health');assert.equal(health.cooldownScope,'post');assert.equal(health.providerConnection,'verified')
  } finally {await client.close();await settle();await db.close()}
})

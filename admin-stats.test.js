const {test} = require('node:test')
const assert = require('node:assert/strict')
const {collectStats,handleStats} = require('./admin-stats')
test('public page works without credentials and exposes only counts', async () => {
 const stripe={subscriptions:{list:()=> (async function*(){yield {status:'active',customer:'private_customer_id'}})()}}
 const res={headers:{},setHeader(k,v){this.headers[k]=v},writeHead(s){this.status=s},end(body){this.body=body}}
 await handleStats({headers:{},method:'GET'},res,stripe,'price')
 assert.equal(res.status,200)
 assert.equal(res.headers['WWW-Authenticate'],undefined)
 assert.match(res.body,/Clients avec abonnement actif/)
 assert.ok(!res.body.includes('private_customer_id'))
})
test('counts distinct active customers, separates trials and overdue across iterable',async()=>{
 const stripe={subscriptions:{list: args=>{
 assert.equal(args.price,'our-price'); assert.equal(args.status,'all')
 return (async function*(){
 for(const s of [
 {status:'active',customer:'a'}, {status:'active',customer:'a',cancel_at_period_end:true},
 {status:'active',customer:{id:'b'}}, {status:'trialing',customer:'c'},
 {status:'past_due',customer:'d'},{status:'unpaid',customer:'e'},{status:'canceled',customer:'f'}]) yield s
 })()
 }}}
 assert.deepEqual(await collectStats(stripe,'our-price'),{active:3,trialing:1,past_due:1,unpaid:1,ending:1,customers:2})
})
test('Stripe failure is propagated rather than displayed as zero',async()=>{
 await assert.rejects(collectStats({subscriptions:{list(){throw new Error('offline')}}},'price'))
})


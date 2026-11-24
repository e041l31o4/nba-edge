const tz='Asia/Taipei'
const day=(d)=>new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(d)
const shift=(value,n)=>{const d=new Date(value+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)}
const date=day(new Date())
const uclRange=shift(date,-120).replaceAll('-','')+'-'+shift(date,1).replaceAll('-','')
const domesticRange=shift(date,-45).replaceAll('-','')+'-'+date.replaceAll('-','')
const leagues=['eng.1','esp.1','ger.1','ita.1','fra.1','ned.1','por.1','tur.1','nor.1','bel.1','aut.1','ukr.1']
async function get(league,range){
 const url='https://site.api.espn.com/apis/site/v2/sports/soccer/'+league+'/scoreboard?dates='+range+'&limit=500'
 const response=await fetch(url,{headers:{'User-Agent':'NBA-EDGE-UCL-Data-Check/1.0','Accept':'application/json'}})
 if(!response.ok)throw new Error(league+' HTTP '+response.status)
 const data=await response.json()
 return {league,count:Array.isArray(data.events)?data.events.length:0,events:data.events??[]}
}
const results=await Promise.allSettled([get('uefa.champions-league',uclRange),...leagues.map(x=>get(x,domesticRange))])
const ucl=results[0]
if(ucl.status!=='fulfilled'||ucl.value.count===0)throw new Error('UEFA Champions League date-range endpoint returned no events')
const domestic=results.slice(1).filter(x=>x.status==='fulfilled').map(x=>x.value)
const domesticEvents=domestic.reduce((sum,x)=>sum+x.count,0)
if(domesticEvents===0)throw new Error('No domestic league history returned by ESPN endpoints')
const targetUcl=ucl.value.events.filter(e=>day(new Date(e.date))===date||day(new Date(e.date))===shift(date,1))
console.log(JSON.stringify({
 checkedAt:new Date().toISOString(),taiwanDate:date,uclRange,
 uclEvents120d:ucl.value.count,nearbyTaiwanDateUclEvents:targetUcl.length,
 domesticLeagues:domestic.map(x=>({league:x.league,events:x.count})),
 domesticEvents45d:domesticEvents,
 unavailableLeagues:results.slice(1).map((x,i)=>x.status==='rejected'?leagues[i]:null).filter(Boolean)
},null,2))

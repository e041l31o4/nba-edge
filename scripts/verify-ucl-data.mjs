const tz='Asia/Taipei'
const day=(d)=>new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(d)
const shift=(value,n)=>{const d=new Date(value+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)}
const date=day(new Date())
const competitions=[
 ['ucl','uefa.champions'],
 ['premier','eng.1'],
 ['championship','eng.2'],
 ['leagueOne','eng.3'],
 ['europa','uefa.europa']
]
async function get(url){
 const response=await fetch(url,{headers:{'User-Agent':'SPORT-EDGE-Football-Data-Check/1.0','Accept':'application/json'}})
 const body=await response.text()
 let data={}
 try{data=JSON.parse(body)}catch{}
 return {status:response.status,events:Array.isArray(data.events)?data.events:[],body:body.slice(0,500)}
}
const days=[shift(date,-1),date,shift(date,1)]
const results=await Promise.all(competitions.map(async([key,league])=>{
 const checks=await Promise.all(days.map(d=>get(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard?dates=${d.replaceAll('-','')}&limit=500`)))
 return {key,league,checks:checks.map((x,i)=>({date:days[i],status:x.status,count:x.events.length,events:x.events.slice(0,2).map(e=>e.name)}))}
}))
console.log(JSON.stringify({taiwanDate:date,competitions:results},null,2))
const failed=results.filter(row=>row.checks.every(check=>check.status!==200))
if(failed.length)throw new Error('Competition scoreboards unavailable: '+failed.map(x=>x.key).join(', '))

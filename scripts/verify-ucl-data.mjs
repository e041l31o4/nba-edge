const tz='Asia/Taipei'
const day=(d)=>new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(d)
const shift=(value,n)=>{const d=new Date(value+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)}
const date=day(new Date())
async function get(url){
 const r=await fetch(url,{headers:{'User-Agent':'NBA-EDGE-UCL-Data-Check/1.0','Accept':'application/json'}})
 const body=await r.text()
 let data={}
 try{data=JSON.parse(body)}catch{}
 return {status:r.status,count:Array.isArray(data.events)?data.events.length:0,events:data.events??[],body:body.slice(0,8000)}
}
const days=[shift(date,-1),date,shift(date,1)]
const uclResults=await Promise.all(days.map(d=>get('https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard?dates='+d.replaceAll('-',''))))
const uclEvents=uclResults.flatMap(x=>x.events)
const teamIds=[...new Set(uclEvents.flatMap(e=>(e.competitions?.[0]?.competitors??[]).map(c=>String(c.team?.id??''))).filter(Boolean))].slice(0,2)
const leagues=['eng.1','esp.1','ger.1','ita.1','fra.1']
const correctClubSchedules=await Promise.all([
 get('https://site.api.espn.com/apis/site/v2/sports/soccer/nor.1/teams/2980/schedule'),
 get('https://site.api.espn.com/apis/site/v2/sports/soccer/aut.1/teams/4411/schedule')
])
const uclRange=await get('https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard?dates='+shift(date,-120).replaceAll('-','')+'-'+shift(date,1).replaceAll('-','')+'&limit=500')
const domesticRange=await get('https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard?dates='+shift(date,-45).replaceAll('-','')+'-'+date.replaceAll('-','')+'&limit=500')
const domesticSingle=await get('https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard?dates='+shift(date,-3).replaceAll('-',''))
const scheduleTests=await Promise.all(teamIds.flatMap(id=>leagues.map(async league=>{
 const result=await get('https://site.api.espn.com/apis/site/v2/sports/soccer/'+league+'/teams/'+id+'/schedule')
 return {id,league,status:result.status,count:result.count,body:result.body}
})))
console.log(JSON.stringify({date,days:days.map((d,i)=>({date:d,status:uclResults[i].status,count:uclResults[i].count,events:uclResults[i].events.slice(0,2).map(e=>e.name)})),teamIds,scheduleTests,uclRange:{status:uclRange.status,count:uclRange.count,body:uclRange.body},domesticRange:{status:domesticRange.status,count:domesticRange.count,body:domesticRange.body},domesticSingle:{status:domesticSingle.status,count:domesticSingle.count,body:domesticSingle.body},correctClubSchedules:correctClubSchedules.map(x=>({status:x.status,count:x.count,body:x.body}))},null,2))
if(uclEvents.length===0)throw new Error('Single-day ESPN UCL scoreboard returned no events')

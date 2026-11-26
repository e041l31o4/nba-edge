const tz='Asia/Taipei'
const day=(d)=>new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(d)
const shift=(value,n)=>{const d=new Date(value+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)}
const compact=(value)=>value.replaceAll('-','')
const date=day(new Date())
const competitions=[
 ['ucl','uefa.champions'],
 ['premier','eng.1'],
 ['championship','eng.2'],
 ['leagueOne','eng.3'],
 ['europa','uefa.europa']
]
async function get(url){
 const response=await fetch(url,{headers:{'User-Agent':'SPORT-EDGE-Football-Data-Check/2.0','Accept':'application/json'}})
 if(!response.ok)throw new Error(`HTTP ${response.status} for ${url}`)
 const data=await response.json()
 return Array.isArray(data.events)?data.events:[]
}
const years=[...new Set([shift(date,-120).slice(0,4),date.slice(0,4),shift(date,1).slice(0,4)])]
const results=await Promise.all(competitions.map(async([key,league])=>{
 const batches=await Promise.all(years.map(year=>get(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard?dates=${year}&limit=1000`)))
 const unique=new Map(batches.flat().map(event=>[String(event.id),event]))
 const events=[...unique.values()]
 const completed=events.filter(event=>event.status?.type?.completed===true||/FINAL|FULL_TIME|STATUS_FINAL/i.test(event.status?.type?.name??''))
 const sample=events.slice(0,3).map(event=>event.name)
 return {key,league,events:events.length,completed:completed.length,years,sample}
}))
console.log(JSON.stringify({taiwanDate:date,historyWindowDays:120,calendarYears:years,competitions:results},null,2))
const failed=results.filter(row=>row.events===0||row.completed===0)
if(failed.length)throw new Error('Missing completed league history: '+failed.map(x=>x.key).join(', '))

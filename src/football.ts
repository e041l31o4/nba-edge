export type FootballTeam = { id: string; name: string; abbreviation: string; logo?: string }
export type FootballMatch = {
  id: string; date: string; status: string; detail: string; venue?: string;
  home: FootballTeam & { score?: number }; away: FootballTeam & { score?: number };
}
export type TeamGoalForm = { played: number; scored: number; conceded: number; lastFive: string[] }
export type FootballModel = {
  homeXg: number; awayXg: number; homeWin: number; draw: number; awayWin: number;
  over: number; under: number; topScores: Array<{score:string; probability:number}>;
  sampleHome: number; sampleAway: number; confidence: '低'|'中'|'高';
  homeRecent: string[]; awayRecent: string[];
}
const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n))
const factorial=(n:number)=>{let v=1;for(let i=2;i<=n;i++)v*=i;return v}
export function poisson(lambda:number,k:number){return Math.exp(-lambda)*Math.pow(lambda,k)/factorial(k)}
const normalizeName=(value:string)=>value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g,'')
function sameTeam(a:FootballTeam,b:FootballTeam){return (!!a.id&&!!b.id&&a.id===b.id)||normalizeName(a.name)===normalizeName(b.name)}
function weightedForm(team:FootballTeam,history:FootballMatch[]):TeamGoalForm{
  const rows=history.filter(g=>g.status.toLowerCase().includes('final')&&(sameTeam(g.home,team)||sameTeam(g.away,team))).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,6)
  let scored=0,conceded=0,totalWeight=0
  for(let i=0;i<rows.length;i++){
    const g=rows[i],isHome=sameTeam(g.home,team),gf=Number((isHome?g.home.score:g.away.score)??0),ga=Number((isHome?g.away.score:g.home.score)??0)
    const weight=Math.pow(0.86,i);scored+=gf*weight;conceded+=ga*weight;totalWeight+=weight
  }
  return {played:rows.length,scored:totalWeight?scored/totalWeight:0,conceded:totalWeight?conceded/totalWeight:0,lastFive:rows.slice(0,5).map(g=>`${g.home.name} ${g.home.score}-${g.away.score} ${g.away.name}`)}
}
export function buildFootballModel(match:FootballMatch,history:FootballMatch[],totalLine=2.5):FootballModel{
  const h=weightedForm(match.home,history),a=weightedForm(match.away,history)
  const leagueGoalBaseline=1.42
  const shrink=(value:number,n:number)=>n?((value*n+leagueGoalBaseline*2)/(n+2)):leagueGoalBaseline
  const hGF=shrink(h.scored,h.played),hGA=shrink(h.conceded,h.played),aGF=shrink(a.scored,a.played),aGA=shrink(a.conceded,a.played)
  const homeXg=clamp(leagueGoalBaseline*(hGF/leagueGoalBaseline)*(aGA/leagueGoalBaseline)*1.08,0.2,4.2)
  const awayXg=clamp(leagueGoalBaseline*(aGF/leagueGoalBaseline)*(hGA/leagueGoalBaseline),0.2,4.0)
  const maxGoals=10,hp=Array.from({length:maxGoals+1},(_,i)=>poisson(homeXg,i)),ap=Array.from({length:maxGoals+1},(_,i)=>poisson(awayXg,i))
  const raw:Array<{home:number;away:number;p:number}>=[]
  for(let i=0;i<=maxGoals;i++)for(let j=0;j<=maxGoals;j++)raw.push({home:i,away:j,p:hp[i]*ap[j]})
  const mass=raw.reduce((sum,x)=>sum+x.p,0)||1
  let homeWin=0,draw=0,awayWin=0,over=0
  const scores:Array<{score:string;probability:number}>=[]
  for(const x of raw){const p=x.p/mass;if(x.home>x.away)homeWin+=p;else if(x.home===x.away)draw+=p;else awayWin+=p;if(x.home+x.away>totalLine)over+=p;scores.push({score:`${x.home}:${x.away}`,probability:p})}
  const confidence:FootballModel['confidence']=h.played>=5&&a.played>=5?'高':h.played>=3&&a.played>=3?'中':'低'
  return {homeXg,awayXg,homeWin,draw,awayWin,over,under:1-over,topScores:scores.sort((x,y)=>y.probability-x.probability).slice(0,3),sampleHome:h.played,sampleAway:a.played,confidence,homeRecent:h.lastFive,awayRecent:a.lastFive}
}
function espnDate(date:string){return date.replace(/-/g,'')}
function dateShift(date:string,days:number){const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10)}
function parseEvents(json:any):FootballMatch[]{return (json.events??[]).map((e:any)=>{const c=e.competitions?.[0],teams=c?.competitors??[],h=teams.find((x:any)=>x.homeAway==='home'),a=teams.find((x:any)=>x.homeAway==='away');const team=(x:any)=>({id:String(x?.team?.id??''),name:x?.team?.displayName??x?.team?.name??'待確認',abbreviation:x?.team?.abbreviation??'—',logo:x?.team?.logo,score:x?.score!==undefined&&x?.score!==null?Number(x.score):undefined});return {id:String(e.id),date:e.date,status:e.status?.type?.name??'',detail:e.status?.type?.shortDetail??'',venue:c?.venue?.fullName,home:team(h),away:team(a)}}).filter((g:FootballMatch)=>g.id&&g.home.id&&g.away.id)}
async function scoreboard(dates:string,league='uefa.champions-league'){const url=`https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard?dates=${dates}&limit=500`;const r=await fetch(url);if(!r.ok)throw new Error('UEFA Champions League 賽程來源暫時無法連線');return r.json()}
function taiwanDay(value:string){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value))}
export async function getUclMatches(taiwanDate:string):Promise<{matches:FootballMatch[];history:FootballMatch[]}>{
  const domesticLeagues=['eng.1','esp.1','ger.1','ita.1','fra.1','ned.1','por.1','tur.1','nor.1','bel.1','aut.1','ukr.1']
  const uclRange=`${espnDate(dateShift(taiwanDate,-120))}-${espnDate(dateShift(taiwanDate,1))}`
  const domesticRange=`${espnDate(dateShift(taiwanDate,-45))}-${espnDate(taiwanDate)}`
  const [uclResult,...domesticResults]=await Promise.allSettled([
    scoreboard(uclRange,'uefa.champions-league'),
    ...domesticLeagues.map(league=>scoreboard(domesticRange,league))
  ])
  if(uclResult.status==='rejected')throw new Error('歐冠賽程來源暫時無法連線')
  const uclGames=parseEvents(uclResult.value)
  const domesticGames=domesticResults.flatMap(result=>result.status==='fulfilled'?parseEvents(result.value):[])
  const matches=Array.from(new Map(uclGames.filter(game=>taiwanDay(game.date)===taiwanDate).map(game=>[game.id,game])).values())
  const history=Array.from(new Map([...uclGames,...domesticGames]
    .filter(game=>taiwanDay(game.date)<=taiwanDate&&taiwanDay(game.date)>=dateShift(taiwanDate,-120)&&game.status.toLowerCase().includes('final'))
    .map(game=>[game.id,game])).values())
  return {matches,history}
}

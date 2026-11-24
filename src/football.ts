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
}
const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n))
const factorial=(n:number)=>{let v=1;for(let i=2;i<=n;i++)v*=i;return v}
export function poisson(lambda:number,k:number){return Math.exp(-lambda)*Math.pow(lambda,k)/factorial(k)}
export function buildFootballModel(match:FootballMatch, history:FootballMatch[], totalLine=2.5):FootballModel {
  const form=(id:string):TeamGoalForm=>{
    const rows=history.filter(g=>g.status.toLowerCase().includes('final')&&(g.home.id===id||g.away.id===id)).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5)
    let scored=0,conceded=0
    for(const g of rows){const home=g.home.id===id;scored+=Number(home?g.home.score:g.away.score??0);conceded+=Number(home?g.away.score:g.home.score??0)}
    return {played:rows.length,scored,conceded,lastFive:rows.map(g=>`${g.home.name} ${g.home.score}-${g.away.score} ${g.away.name}`)}
  }
  const h=form(match.home.id),a=form(match.away.id)
  const hGF=h.played?h.scored/h.played:1.35,hGA=h.played?h.conceded/h.played:1.2
  const aGF=a.played?a.scored/a.played:1.15,aGA=a.played?a.conceded/a.played:1.25
  const homeXg=clamp(((hGF+aGA)/2)*1.08,0.25,3.8)
  const awayXg=clamp((aGF+hGA)/2,0.2,3.5)
  const hp=Array.from({length:9},(_,i)=>poisson(homeXg,i)),ap=Array.from({length:9},(_,i)=>poisson(awayXg,i))
  let homeWin=0,draw=0,awayWin=0,over=0
  const scores:Array<{score:string;probability:number}>=[]
  for(let i=0;i<9;i++)for(let j=0;j<9;j++){const p=hp[i]*ap[j];if(i>j)homeWin+=p;else if(i===j)draw+=p;else awayWin+=p;if(i+j>totalLine)over+=p;scores.push({score:`${i}:${j}`,probability:p})}
  const confidence=h.played>=5&&a.played>=5?'中':h.played>=3&&a.played>=3?'中':'低'
  return {homeXg,awayXg,homeWin,draw,awayWin,over,under:1-over,topScores:scores.sort((x,y)=>y.probability-x.probability).slice(0,3),sampleHome:h.played,sampleAway:a.played,confidence}
}
function espnDate(date:string){return date.replace(/-/g,'')}
function dateShift(date:string,days:number){const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10)}
function parseEvents(json:any):FootballMatch[]{return (json.events??[]).map((e:any)=>{const c=e.competitions?.[0],teams=c?.competitors??[],h=teams.find((x:any)=>x.homeAway==='home'),a=teams.find((x:any)=>x.homeAway==='away');const team=(x:any)=>({id:String(x?.team?.id??''),name:x?.team?.displayName??x?.team?.name??'待確認',abbreviation:x?.team?.abbreviation??'—',logo:x?.team?.logo,score:x?.score!==undefined&&x?.score!==null?Number(x.score):undefined});return {id:String(e.id),date:e.date,status:e.status?.type?.name??'',detail:e.status?.type?.shortDetail??'',venue:c?.venue?.fullName,home:team(h),away:team(a)}}).filter((g:FootballMatch)=>g.id&&g.home.id&&g.away.id)}
async function scoreboard(dates:string){const url=`https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions-league/scoreboard?dates=${dates}`;const r=await fetch(url);if(!r.ok)throw new Error('UEFA Champions League 賽程來源暫時無法連線');return r.json()}
export async function getUclMatches(taiwanDate:string):Promise<{matches:FootballMatch[];history:FootballMatch[]}>{
  const from=espnDate(dateShift(taiwanDate,-120)),to=espnDate(dateShift(taiwanDate,1)),target=espnDate(taiwanDate)
  const [current,history]=await Promise.all([scoreboard(target),scoreboard(`${from}-${to}`)])
  return {matches:parseEvents(current),history:parseEvents(history)}
}

export type FootballTeam = { id: string; name: string; abbreviation: string; logo?: string; score?: number }
export type FootballMatch = {
  id: string; date: string; status: string; detail: string; venue?: string;
  home: FootballTeam; away: FootballTeam;
}
export type TeamGoalForm = { played: number; scored: number; conceded: number; homePlayed:number; awayPlayed:number; homeScored:number; homeConceded:number; awayScored:number; awayConceded:number; lastFive: string[] }
export type FootballModel = {
  homeXg: number; awayXg: number; homeWin: number; draw: number; awayWin: number;
  over: number; under: number; topScores: Array<{score:string; probability:number}>;
  sampleHome: number; sampleAway: number; confidence: '低'|'中'|'高'; dataReady:boolean; dataWarnings:string[];
  homeRecent: string[]; awayRecent: string[];
}
const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n))
const factorial=(n:number)=>{let v=1;for(let i=2;i<=n;i++)v*=i;return v}
export function poisson(lambda:number,k:number){return Math.exp(-lambda)*Math.pow(lambda,k)/factorial(k)}
const normalizeName=(value:string)=>value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g,'')
export function isFinalStatus(status:string){const value=status.trim().toUpperCase();return value.includes('FINAL')||value.includes('FULL_TIME')||value==='FT'||value==='AET'||value==='PEN'}
function sameTeam(a:FootballTeam,b:FootballTeam){return (!!a.id&&!!b.id&&a.id===b.id)||normalizeName(a.name)===normalizeName(b.name)}
function weightedForm(team:FootballTeam,history:FootballMatch[]):TeamGoalForm{
  const rows=history.filter(g=>isFinalStatus(g.status)&&(sameTeam(g.home,team)||sameTeam(g.away,team))&&Number.isFinite(g.home.score)&&Number.isFinite(g.away.score)).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,8)
  let scored=0,conceded=0,totalWeight=0,validPlayed=0,homePlayed=0,awayPlayed=0,homeScored=0,homeConceded=0,awayScored=0,awayConceded=0,homeWeight=0,awayWeight=0
  for(let i=0;i<rows.length;i++){
    const g=rows[i],isHome=sameTeam(g.home,team),gf=Number((isHome?g.home.score:g.away.score)??NaN),ga=Number((isHome?g.away.score:g.home.score)??NaN)
    if(!Number.isFinite(gf)||!Number.isFinite(ga))continue
    validPlayed++
    const weight=Math.pow(0.88,i)
    scored+=gf*weight;conceded+=ga*weight;totalWeight+=weight
    if(isHome){homePlayed++;homeScored+=gf*weight;homeConceded+=ga*weight;homeWeight+=weight}
    else{awayPlayed++;awayScored+=gf*weight;awayConceded+=ga*weight;awayWeight+=weight}
  }
  return {played:validPlayed,scored:totalWeight?scored/totalWeight:0,conceded:totalWeight?conceded/totalWeight:0,homePlayed,awayPlayed,homeScored:homeWeight?homeScored/homeWeight:0,homeConceded:homeWeight?homeConceded/homeWeight:0,awayScored:awayWeight?awayScored/awayWeight:0,awayConceded:awayWeight?awayConceded/awayWeight:0,lastFive:rows.filter(g=>g.home.score!==undefined&&g.away.score!==undefined).slice(0,5).map(g=>`${g.home.name} ${g.home.score}-${g.away.score} ${g.away.name}`)}
}
export function buildFootballModel(match:FootballMatch,history:FootballMatch[],totalLine=2.5):FootballModel{
  const h=weightedForm(match.home,history),a=weightedForm(match.away,history)
  const leagueGoalBaseline=1.42
  const shrink=(value:number,n:number)=>n?((value*n+leagueGoalBaseline*2)/(n+2)):leagueGoalBaseline
  // Overall recent form is blended with venue-specific form only when the venue sample is usable.
  const blendVenue=(overall:number,venue:number,n:number)=>n>=2?overall*0.65+venue*0.35:overall
  const homeAttack=blendVenue(shrink(h.scored,h.played),shrink(h.homeScored,h.homePlayed),h.homePlayed)
  const homeDefence=blendVenue(shrink(h.conceded,h.played),shrink(h.homeConceded,h.homePlayed),h.homePlayed)
  const awayAttack=blendVenue(shrink(a.scored,a.played),shrink(a.awayScored,a.awayPlayed),a.awayPlayed)
  const awayDefence=blendVenue(shrink(a.conceded,a.played),shrink(a.awayConceded,a.awayPlayed),a.awayPlayed)
  const homeXg=clamp(leagueGoalBaseline*(homeAttack/leagueGoalBaseline)*(awayDefence/leagueGoalBaseline)*1.08,0.2,4.2)
  const awayXg=clamp(leagueGoalBaseline*(awayAttack/leagueGoalBaseline)*(homeDefence/leagueGoalBaseline),0.2,4.0)
  const maxGoals=10,hp=Array.from({length:maxGoals+1},(_,i)=>poisson(homeXg,i)),ap=Array.from({length:maxGoals+1},(_,i)=>poisson(awayXg,i))
  const raw:Array<{home:number;away:number;p:number}>=[]
  for(let i=0;i<=maxGoals;i++)for(let j=0;j<=maxGoals;j++)raw.push({home:i,away:j,p:hp[i]*ap[j]})
  const mass=raw.reduce((sum,x)=>sum+x.p,0)||1
  let homeWin=0,draw=0,awayWin=0,over=0
  const scores:Array<{score:string;probability:number}>=[]
  for(const x of raw){const p=x.p/mass;if(x.home>x.away)homeWin+=p;else if(x.home===x.away)draw+=p;else awayWin+=p;if(x.home+x.away>totalLine)over+=p;scores.push({score:`${x.home}:${x.away}`,probability:p})}
  const warnings:string[]=[]
  if(h.played<5)warnings.push(`${match.home.name} 近況樣本僅 ${h.played} 場，至少需要 5 場`)
  if(a.played<5)warnings.push(`${match.away.name} 近況樣本僅 ${a.played} 場，至少需要 5 場`)
  if(h.homePlayed<2)warnings.push(`${match.home.name} 主場樣本不足（${h.homePlayed} 場）`)
  if(a.awayPlayed<2)warnings.push(`${match.away.name} 客場樣本不足（${a.awayPlayed} 場）`)
  const confidence:FootballModel['confidence']=h.played>=6&&a.played>=6&&h.homePlayed>=2&&a.awayPlayed>=2?'高':h.played>=5&&a.played>=5?'中':'低'
  return {homeXg,awayXg,homeWin,draw,awayWin,over,under:1-over,topScores:scores.sort((x,y)=>y.probability-x.probability).slice(0,3),sampleHome:h.played,sampleAway:a.played,confidence,dataReady:warnings.length===0,dataWarnings:warnings,homeRecent:h.lastFive,awayRecent:a.lastFive}
}
function espnDate(date:string){return date.replace(/-/g,'')}
function dateShift(date:string,days:number){const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10)}
function parseEvents(json:any):FootballMatch[]{return (json.events??[]).map((e:any)=>{const c=e.competitions?.[0],teams=c?.competitors??[],h=teams.find((x:any)=>x.homeAway==='home'),a=teams.find((x:any)=>x.homeAway==='away');const scoreValue=(x:any)=>{const raw=x?.score?.value??x?.score?.displayValue??x?.score;if(raw===undefined||raw===null||raw==='')return undefined;const parsed=Number(raw);return Number.isFinite(parsed)?parsed:undefined};const home=teamFor(h,scoreValue),away=teamFor(a,scoreValue);const explicitStatus=e.status?.type?.name??c?.status?.type?.name??'';const completed=e.status?.type?.completed===true||c?.status?.type?.completed===true;const normalizedStatus=isFinalStatus(explicitStatus)||completed?'STATUS_FINAL':explicitStatus;const fallbackFinal=!explicitStatus&&home.score!==undefined&&away.score!==undefined&&new Date(e.date).getTime()<Date.now()-3*60*60*1000;return {id:String(e.id),date:e.date,status:normalizedStatus||(fallbackFinal?'STATUS_FINAL':''),detail:e.status?.type?.shortDetail??(fallbackFinal?'完賽':''),venue:c?.venue?.fullName,home,away}}).filter((g:FootballMatch)=>g.id&&g.home.id&&g.away.id)}
const TEAM_ZH:Record<string,string>={
 arsenal:'阿森納',astonvilla:'阿斯頓維拉',liverpool:'利物浦',mancity:'曼城',manchestercity:'曼城',manutd:'曼聯',manunited:'曼聯',manchesterunited:'曼聯',chelsea:'切爾西',tottenham:'托特納姆熱刺',tottenhamhotspur:'托特納姆熱刺',newcastle:'紐卡索聯',newcastleunited:'紐卡索聯',
 realmadrid:'皇家馬德里',realmadird:'皇家馬德里',barcelona:'巴塞隆納',atleticodemadrid:'馬德里競技',atleticomadrid:'馬德里競技',girona:'赫羅納',sevilla:'塞維亞',villarreal:'比利亞雷亞爾',athleticclub:'畢爾包',
 bayernmunchen:'拜仁慕尼黑',bayernmunich:'拜仁慕尼黑',borussiadortmund:'多特蒙德',dortmund:'多特蒙德',leipzig:'RB 萊比錫',rbleipzig:'RB 萊比錫',leverkusen:'勒沃庫森',bayerleverkusen:'勒沃庫森',stuttgart:'斯圖加特',vfbstuttgart:'斯圖加特',eintrachtfrankfurt:'法蘭克福',
 inter:'國際米蘭',internazionale:'國際米蘭',acmilan:'AC 米蘭',milan:'AC 米蘭',juventus:'尤文圖斯',napoli:'拿坡里',roma:'羅馬',asroma:'羅馬',atalanta:'亞特蘭大',lazio:'拉齊奧',
 psg:'巴黎聖日耳曼',parissaintgermain:'巴黎聖日耳曼',marseille:'馬賽',monaco:'摩納哥',lille:'里爾',lyon:'里昂',
 ajax:'阿賈克斯',psv:'PSV 燕豪芬',psveindhoven:'PSV 燕豪芬',feyenoord:'飛燕諾',benfica:'本菲卡',sportingcp:'里斯本競技',sporting:'里斯本競技',porto:'波圖',fcporto:'波圖',
 celtic:'塞爾提克',rangers:'格拉斯哥流浪者',galatasaray:'加拉塔薩雷',fenerbahce:'費內巴切',besiktas:'貝西克塔斯',
 shakhtardonetsk:'頓內次克礦工',shakhtar:'頓內次克礦工',clubbrugge:'布魯日',brugge:'布魯日',slaviapraha:'布拉格斯拉維亞',slaviaprague:'布拉格斯拉維亞',spartaPrague:'布拉格斯巴達',
 redbullsalzburg:'薩爾斯堡紅牛',salzburg:'薩爾斯堡紅牛',youngboys:'伯恩年輕人',basel:'巴塞爾',olympiacos:'奧林匹亞科斯',dinamozagreb:'薩格勒布迪納摩',crvenazvezda:'貝爾格勒紅星',
 bodoGlimt:'波杜基林特',bodoglimt:'波杜基林特',kobenhavn:'哥本哈根',copenhagen:'哥本哈根',unionsg:'聖吉羅聯',unionsaintgilloise:'聖吉羅聯',qarabag:'卡拉巴克',monterrey:'蒙特雷',intermiami:'邁阿密國際'
};
function teamFor(x:any,scoreValue:(x:any)=>number|undefined):FootballTeam{
 const raw=x?.team?.displayName??x?.team?.name??'待確認';
 const key=normalizeName(raw);
 return {id:String(x?.team?.id??''),name:TEAM_ZH[key]??raw,abbreviation:x?.team?.abbreviation??'—',logo:x?.team?.logo??x?.team?.logos?.[0]?.href,score:scoreValue(x)}
}
const TEAM_DOMESTIC_LEAGUE:Record<string,string>={
 'arsenal':'eng.1','astonvilla':'eng.1','liverpool':'eng.1','mancity':'eng.1','manchestercity':'eng.1','manutd':'eng.1','manunited':'eng.1','manchesterutd':'eng.1','manchesterunited':'eng.1',
 'atleticodemadrid':'esp.1','atleticomadrid':'esp.1','barcelona':'esp.1','realbetis':'esp.1','realmadrid':'esp.1','villarreal':'esp.1',
 'bayernmunchen':'ger.1','bayernmunich':'ger.1','borussiadortmund':'ger.1','leipzig':'ger.1','rbleipzig':'ger.1','stuttgart':'ger.1','vfbstuttgart':'ger.1',
 'como':'ita.1','inter':'ita.1','internazionale':'ita.1','napoli':'ita.1','roma':'ita.1','asroma':'ita.1',
 'lens':'fra.1','lille':'fra.1','paris':'fra.1','parissaintgermain':'fra.1','psg':'fra.1',
 'feyenoord':'ned.1','psv':'ned.1','psveindhoven':'ned.1',
 'porto':'por.1','fcporto':'por.1','sportingcp':'por.1',
 'fenerbahce':'tur.1','galatasaray':'tur.1',
 'bodoglimt':'nor.1','viking':'nor.1','vikingfk':'nor.1',
 'lask':'aut.1','lasklinz':'aut.1',
 'aekathens':'gre.1',
 'slovanbratislava':'svk.1',
 'sabah':'aze.1','sabahfk':'aze.1',
 'shakhtar':'ukr.1','shakhtardonetsk':'ukr.1',
 'clubbrugge':'bel.1','brugge':'bel.1',
 'slaviapraha':'cze.1','slaviaprague':'cze.1'
}
async function teamSchedule(team:FootballTeam):Promise<FootballMatch[]>{
 const league=TEAM_DOMESTIC_LEAGUE[normalizeName(team.name)]
 if(!league)return []
 const url=`https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/teams/${team.id}/schedule`
 const response=await fetch(url)
 if(!response.ok)throw new Error(`Team schedule unavailable: ${team.name}`)
 return parseEvents(await response.json())
}
async function scoreboard(dates:string,league='uefa.champions'){const url=`https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard?dates=${dates}&limit=500`;const r=await fetch(url);if(!r.ok)throw new Error('UEFA Champions League 賽程來源暫時無法連線');return r.json()}
export const UCL_MATCH_DAYS=['2026-09-08','2026-09-09','2026-09-10','2026-10-13','2026-10-14','2026-10-20','2026-10-21','2026-11-03','2026-11-04','2026-11-24','2026-11-25','2026-12-08','2026-12-09','2027-01-19','2027-01-20','2027-01-27','2027-02-16','2027-02-17','2027-02-23','2027-02-24','2027-03-09','2027-03-10','2027-03-16','2027-03-17','2027-04-06','2027-04-07','2027-04-13','2027-04-14','2027-04-27','2027-04-28','2027-05-04','2027-05-05','2027-06-05']
function taiwanDay(value:string){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value))}
export async function getUclMatches(taiwanDate:string):Promise<{matches:FootballMatch[];history:FootballMatch[]}>{
  const days=UCL_MATCH_DAYS.filter(day=>day<=dateShift(taiwanDate,1)&&day>=dateShift(taiwanDate,-120))
  const results=await Promise.allSettled(days.map(day=>scoreboard(espnDate(day),'uefa.champions')))
  const fulfilled=results.filter((x):x is PromiseFulfilledResult<any>=>x.status==='fulfilled').map(x=>x.value)
  if(!fulfilled.length)throw new Error('歐冠賽程來源暫時無法連線')
  const uclGames=Array.from(new Map(fulfilled.flatMap(parseEvents).map(game=>[game.id,game])).values())
  const matches=uclGames.filter(game=>taiwanDay(game.date)===taiwanDate)
  const teams=Array.from(new Map(matches.flatMap(game=>[game.home,game.away]).map(team=>[team.id,team])).values())
  const schedules=await Promise.allSettled(teams.map(team=>teamSchedule(team)))
  const domesticGames=schedules.flatMap(result=>result.status==='fulfilled'?result.value:[])
  const history=Array.from(new Map([...uclGames,...domesticGames]
    .filter(game=>taiwanDay(game.date)<=taiwanDate&&taiwanDay(game.date)>=dateShift(taiwanDate,-120)&&game.status.toLowerCase().includes('final'))
    .map(game=>[game.id,game])).values())
  return {matches,history}
}

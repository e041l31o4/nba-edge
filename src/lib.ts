import { loadDataset } from './lib/memberData'
export type Team = { id: string; name: string; abbreviation: string; displayName: string; logo?: string; score?: string }
export type Game = { id: string; date: string; name: string; shortName: string; status: string; detail: string; home: Team; away: Team; venue?: string }
export type OddsGame = { id?: string; commence_time: string; home_team: string; away_team: string; bookmakers?: { title: string; markets: { key: string; outcomes: { name: string; price: number; point?: number }[] }[] }[] }
export type OddsRecord = { updatedAt: string; games: OddsGame[]; source: string }
export type OddsSnapshot = { capturedAt: string; phase: string; source: string; gameId: string; home_team: string; away_team: string; commence_time: string; bookmakers: NonNullable<OddsGame['bookmakers']>; sourcePageUpdatedAt?: string }
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba'
export function taiwanDate(d = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).replace(/-/g, '') }
export function dateLabel(d: string) { return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short' }).format(new Date(d)) }
export async function getScoreboard(date: string): Promise<Game[]> {
  // ESPN scoreboard dates are keyed to the US game date; Taiwan is normally one calendar day ahead.
  const taiwanDay = new Date(date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8)+'T12:00:00+08:00')
  taiwanDay.setDate(taiwanDay.getDate() - 1)
  const usDate = taiwanDay.toISOString().slice(0,10).replace(/-/g, '')
  const res = await fetch(`${ESPN}/scoreboard?dates=${usDate}`)
  if (!res.ok) throw new Error('賽程來源暫時無法連線')
  const json = await res.json()
  return (json.events ?? []).map((e: any) => {
    const comp = e.competitions?.[0], competitors = comp?.competitors ?? []
    const home = competitors.find((x: any) => x.homeAway === 'home'), away = competitors.find((x: any) => x.homeAway === 'away')
    const team = (x: any): Team => ({ id: x?.team?.id ?? '', name: x?.team?.name ?? '資料待更新', displayName: x?.team?.displayName ?? x?.team?.name ?? '—', abbreviation: x?.team?.abbreviation ?? '—', logo: x?.team?.logo, score: x?.score })
    return { id: e.id, date: e.date, name: e.name, shortName: e.shortName, status: e.status?.type?.name ?? '', detail: e.status?.type?.shortDetail ?? '', home: team(home), away: team(away), venue: comp?.venue?.fullName }
  })
}
export async function getOdds(): Promise<OddsRecord | null> {
  try { const data = await loadDataset<OddsRecord>('odds', 'odds.json'); return data && Array.isArray(data.games) && data.games.length > 0 ? data : null } catch { return null }
}
export function marketFor(game: Game, odds: OddsRecord | null) {
  const found = odds?.games.find(g => g.home_team.toLowerCase() === game.home.name.toLowerCase() && g.away_team.toLowerCase() === game.away.name.toLowerCase())
  if (!found) return null
  const books = found.bookmakers ?? []
  const spread = books.flatMap(b => b.markets.filter(m => m.key === 'spreads').flatMap(m => m.outcomes.map(o => ({ book: b.title, name: o.name, point: o.point, price: o.price }))))
  const total = books.flatMap(b => b.markets.filter(m => m.key === 'totals').flatMap(m => m.outcomes.map(o => ({ book: b.title, name: o.name, point: o.point, price: o.price }))))
  return { spread, total, bookCount: books.length }
}
export function teamInitials(abbr: string) { return abbr.slice(0, 3).toUpperCase() }
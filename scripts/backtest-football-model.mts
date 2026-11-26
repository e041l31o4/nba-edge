import {
  FOOTBALL_COMPETITIONS,
  buildFootballModel,
  getFootballMatches,
  getFootballTeamSchedule,
  isFinalStatus,
  type FootballCompetition,
  type FootballMatch,
  type FootballTeam
} from '../src/football'

const taiwanDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date())

const uniqueMatches = (items: FootballMatch[]) =>
  [...new Map(items.map(item => [item.id, item])).values()]

const mean = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null

const brier = (values: number[]) =>
  values.length ? mean(values) : null

const reports: Record<string, unknown>[] = []

for (const competition of Object.keys(FOOTBALL_COMPETITIONS) as FootballCompetition[]) {
  const data = await getFootballMatches(taiwanDate, competition)
  const leagueHistory = uniqueMatches(data.leagueHistory).filter(game =>
    isFinalStatus(game.status) &&
    Number.isFinite(game.home.score) &&
    Number.isFinite(game.away.score)
  )

  let domesticHistory: FootballMatch[] = []
  let mappedTeams = 0
  let unmappedTeams = 0

  if (FOOTBALL_COMPETITIONS[competition].kind === 'cup') {
    const teams = [...new Map(
      leagueHistory.flatMap(game => [game.home, game.away]).map(team => [team.id, team])
    ).values()]
    const schedules: FootballMatch[] = []
    for (let i = 0; i < teams.length; i += 8) {
      const batch = teams.slice(i, i + 8)
      const results = await Promise.allSettled(batch.map(team => getFootballTeamSchedule(team)))
      for (let j = 0; j < results.length; j++) {
        const result = results[j]
        if (result.status === 'fulfilled' && result.value.length) {
          mappedTeams++
          schedules.push(...result.value)
        } else {
          unmappedTeams++
        }
      }
    }
    domesticHistory = schedules.filter(game =>
      isFinalStatus(game.status) &&
      Number.isFinite(game.home.score) &&
      Number.isFinite(game.away.score)
    )
  }

  const allHistory = uniqueMatches([...leagueHistory, ...domesticHistory])
  const orderedGames = [...leagueHistory].sort((a, b) =>
    new Date(a.date).getTime() - new Date(b.date).getTime()
  )

  const predictions: Array<{
    homeWin: number; draw: number; awayWin: number; over: number;
    actualHome: number; actualAway: number; top3Hit: boolean;
    confidence: string; sampleHome: number; sampleAway: number;
    homeExpectedGoals: number; awayExpectedGoals: number;
  }> = []
  let notReady = 0
  let insufficientHome = 0
  let insufficientAway = 0

  for (const game of orderedGames) {
    const kickoff = new Date(game.date).getTime()
    const priorHistory = allHistory.filter(row =>
      new Date(row.date).getTime() < kickoff &&
      isFinalStatus(row.status) &&
      Number.isFinite(row.home.score) &&
      Number.isFinite(row.away.score)
    )
    const priorLeague = leagueHistory.filter(row =>
      new Date(row.date).getTime() < kickoff
    )
    const model = buildFootballModel(game, priorHistory, 2.5, priorLeague)
    if (!model.dataReady) {
      notReady++
      if (model.sampleHome < 5) insufficientHome++
      if (model.sampleAway < 5) insufficientAway++
      continue
    }

    const actualHome = Number(game.home.score)
    const actualAway = Number(game.away.score)
    const actualScore = `${actualHome}:${actualAway}`
    predictions.push({
      homeWin: model.homeWin,
      draw: model.draw,
      awayWin: model.awayWin,
      over: model.over,
      actualHome,
      actualAway,
      top3Hit: model.topScores.some(score => score.score === actualScore),
      confidence: model.confidence,
      sampleHome: model.sampleHome,
      sampleAway: model.sampleAway,
      homeExpectedGoals: model.homeXg,
      awayExpectedGoals: model.awayXg
    })
  }

  const oneX2Brier = predictions.map(row =>
    (row.homeWin - (row.actualHome > row.actualAway ? 1 : 0)) ** 2 +
    (row.draw - (row.actualHome === row.actualAway ? 1 : 0)) ** 2 +
    (row.awayWin - (row.actualHome < row.actualAway ? 1 : 0)) ** 2
  )
  const oneX2LogLoss = predictions.map(row => {
    const probability = row.actualHome > row.actualAway ? row.homeWin :
      row.actualHome === row.actualAway ? row.draw : row.awayWin
    return -Math.log(Math.max(1e-9, probability))
  })
  const totalBrier = predictions.map(row =>
    (row.over - (row.actualHome + row.actualAway > 2.5 ? 1 : 0)) ** 2
  )
  const homeGoalErrors = predictions.map(row => Math.abs(row.homeExpectedGoals - row.actualHome))
  const awayGoalErrors = predictions.map(row => Math.abs(row.awayExpectedGoals - row.actualAway))
  const totalGoalErrors = predictions.map(row =>
    Math.abs(row.homeExpectedGoals + row.awayExpectedGoals - row.actualHome - row.actualAway)
  )

  const confidenceCounts = predictions.reduce((acc, row) => {
    acc[row.confidence] = (acc[row.confidence] ?? 0) + 1
    return acc
  }, {} as Record<string, number>)

  const probabilities = predictions.map(row => row.homeWin)
  const uniqueProbabilityCount = new Set(probabilities.map(value => value.toFixed(3))).size

  reports.push({
    competition,
    label: FOOTBALL_COMPETITIONS[competition].short,
    scoreboardMatches: leagueHistory.length,
    domesticHistoryMatches: domesticHistory.length,
    mappedTeams,
    unmappedTeams,
    readyPredictions: predictions.length,
    skippedForDataQuality: notReady,
    skippedHomeSample: insufficientHome,
    skippedAwaySample: insufficientAway,
    readyCoverage: leagueHistory.length
      ? Number((predictions.length / leagueHistory.length).toFixed(3))
      : null,
    oneX2Brier: brier(oneX2Brier),
    oneX2LogLoss: brier(oneX2LogLoss),
    over25Brier: brier(totalBrier),
    correctScoreTop3HitRate: predictions.length
      ? Number((predictions.filter(row => row.top3Hit).length / predictions.length).toFixed(4))
      : null,
    homeExpectedGoalsMAE: mean(homeGoalErrors),
    awayExpectedGoalsMAE: mean(awayGoalErrors),
    totalExpectedGoalsMAE: mean(totalGoalErrors),
    averageTeamSamples: {
      home: mean(predictions.map(row => row.sampleHome)),
      away: mean(predictions.map(row => row.sampleAway))
    },
    confidenceCounts,
    distinctHomeWinProbabilities3dp: uniqueProbabilityCount
  })
}

console.log('SPORT_EDGE_FOOTBALL_WALK_FORWARD_AUDIT:', JSON.stringify({
  taiwanDate,
  historyWindowDays: 120,
  model: 'Current Poisson recent-goals model; strictly chronological per-match history; cup matches augmented with mapped domestic team schedules',
  metrics: '1X2 multiclass Brier / log loss; Over 2.5 Brier; expected-goal MAE; exact-score top-3 hit rate',
  limitations: [
    'ESPN score history only; this audit does not include true shot-quality xG, confirmed starting lineups, suspensions, injuries, or betting-market odds.',
    'This is a rolling 120-day audit, not a multi-season proof of profitability.',
    'Predictions with dataReady=false are excluded from accuracy metrics and counted separately.'
  ],
  competitions: reports
}, null, 2))

if (reports.filter(row => Number(row.readyPredictions) >= 20).length < 3) {
  throw new Error('Insufficient walk-forward samples in at least three competitions; review data coverage before publishing model claims.')
}

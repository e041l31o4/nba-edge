// Supabase Edge Function: settle-nba-games
// Deploy with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set by Supabase.
// This function reads ESPN's public scoreboard for the requested date and only
// settles predictions that already exist. It never creates or edits predictions.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });
  try {
    const { date } = await req.json();
    if (typeof date !== "string" || !/^\d{8}$/.test(date)) {
      return Response.json({ error: "date must be YYYYMMDD" }, { status: 400, headers: cors });
    }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );
    const scoreUrl = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${date}`;
    const response = await fetch(scoreUrl, { headers: { "User-Agent": "NBA-EDGE/1.0" } });
    if (!response.ok) throw new Error(`ESPN scoreboard returned ${response.status}`);
    const scoreboard = await response.json();
    const events = Array.isArray(scoreboard.events) ? scoreboard.events : [];
    let settled = 0;
    for (const event of events) {
      const competition = event.competitions?.[0];
      const status = competition?.status?.type?.name;
      if (status !== "STATUS_FINAL" && status !== "STATUS_FINAL_OT") continue;
      const competitors = competition?.competitors ?? [];
      const home = competitors.find((team: any) => team.homeAway === "home");
      const away = competitors.find((team: any) => team.homeAway === "away");
      if (!home || !away || home.score == null || away.score == null) continue;
      const { data: prediction } = await supabase
        .from("nba_predictions").select("game_id").eq("game_id", String(event.id)).maybeSingle();
      if (!prediction) continue;
      const { error } = await supabase.from("nba_settlements").upsert({
        game_id: String(event.id),
        actual_home: Number(home.score),
        actual_away: Number(away.score),
        settled_at: new Date().toISOString(),
        source: "ESPN scoreboard",
      }, { onConflict: "game_id", ignoreDuplicates: true });
      if (!error) settled++;
    }
    return Response.json({ date, events: events.length, settled }, { headers: cors });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500, headers: cors });
  }
});

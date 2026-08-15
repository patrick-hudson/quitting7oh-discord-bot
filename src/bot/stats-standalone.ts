// Standalone entrypoint for the stats worker — no Discord gateway, just
// Postgres + Discord REST. Only used when the stats computation is split into
// its own container (see the commented stats-worker service in
// docker-compose.prod.yml); normally runStatsWorker runs inside the bot
// process. When using this, set STATS_REFRESH_MINUTES=0 on the bot service so
// the two don't double-compute.

process.env.STATS_REFRESH_MINUTES ||= "60";

import { runStatsWorker } from "./stats-worker";

console.log("[stats-standalone] starting");
runStatsWorker();

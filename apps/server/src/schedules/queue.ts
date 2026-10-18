import PgBoss from "pg-boss";

/** Postgres-backed delivery; run state in schedule_runs is the final duplicate guard. */
export class ScheduleQueue {
  private boss: PgBoss;
  constructor(url: string, schema = "pgboss") {
    this.boss = new PgBoss({
      connectionString: url,
      schema,
      application_name: "northbot-schedules",
    });
  }
  async start(handle: (id: string) => Promise<void>, onError: (error: Error) => void) {
    this.boss.on("error", onError);
    await this.boss.start();
    await this.boss.createQueue("northbot-schedule-runs", {
      name: "northbot-schedule-runs",
      retryLimit: 2,
      retryDelay: 10,
    });
    await this.boss.work<{ runId: string }>(
      "northbot-schedule-runs",
      { pollingIntervalSeconds: 1 },
      async (jobs) => {
        for (const job of jobs) await handle(job.data.runId);
      },
    );
  }
  async send(runId: string) {
    await this.boss.send(
      "northbot-schedule-runs",
      { runId },
      { singletonKey: runId, singletonSeconds: 30, expireInSeconds: 86399 },
    );
  }
  async stop() {
    await this.boss.stop({ graceful: true, timeout: 2000 });
  }
}

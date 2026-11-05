// Tiny in-process scheduler for periodic maintenance jobs (backups, inactivity cleanup).

export interface Job {
  name: string;
  everyMs: number;
  firstDelayMs: number;
  run: () => unknown | Promise<unknown>;
}

/** Starts the jobs. A run never overlaps the previous one. Returns a stop function. */
export function startJobs(jobs: Job[], onError: (job: string, err: unknown) => void): () => void {
  const timers: Timer[] = [];
  for (const job of jobs) {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await job.run();
      } catch (err) {
        onError(job.name, err);
      } finally {
        running = false;
      }
    };
    timers.push(setTimeout(tick, job.firstDelayMs), setInterval(tick, job.everyMs));
  }
  return () => timers.forEach((t) => clearTimeout(t));
}

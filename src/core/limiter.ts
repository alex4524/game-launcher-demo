/** Run at most `max` async tasks at a time; extra tasks wait in FIFO order. */
export function createLimiter(max: number) {
  if (!Number.isInteger(max) || max < 1) throw new Error('max must be >= 1');
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (active >= max) return;
    const start = queue.shift();
    if (start) start();
  };

  function run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
  }

  return { run, get active() { return active; }, get pending() { return queue.length; } };
}

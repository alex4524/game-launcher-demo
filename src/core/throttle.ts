/**
 * Call `fn` at most once per `ms`. The latest call is never lost: if calls arrive during
 * the quiet period, one trailing call runs at the end of it. `flush()` runs it right away.
 */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;

  const fire = () => {
    timer = null;
    if (!pending) return;
    const args = pending;
    pending = null;
    last = Date.now();
    fn(...args);
  };

  const call = (...args: A) => {
    pending = args;
    const wait = last + ms - Date.now();
    if (wait <= 0) {
      if (timer) clearTimeout(timer);
      fire();
    } else if (!timer) {
      timer = setTimeout(fire, wait);
    }
  };

  call.flush = () => {
    if (timer) clearTimeout(timer);
    fire();
  };
  call.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  return call;
}

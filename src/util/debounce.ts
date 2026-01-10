export function debounce<T extends (...args: any[]) => void>(fn: T, delayMs: number): T {
  let timer: NodeJS.Timeout | undefined;
  return ((...args: any[]) => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      fn(...args);
    }, delayMs);
  }) as T;
}

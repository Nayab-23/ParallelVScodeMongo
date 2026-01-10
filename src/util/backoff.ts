export function computeBackoff(
  attempt: number,
  baseMs = 1000,
  capMs = 30000,
  rand: () => number = Math.random
): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  const jitter = 0.5 + rand() * 0.5;
  return Math.floor(exp * jitter);
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

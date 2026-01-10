export function nowIso(): string {
  return new Date().toISOString();
}

export function isNewer(first: string, second: string): boolean {
  return new Date(first).getTime() > new Date(second).getTime();
}

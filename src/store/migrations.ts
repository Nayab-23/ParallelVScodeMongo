// JSON-backed store does not require migrations, but this module can host future upgrades.
export function ensureMigrations(): void {
  // No-op for JSON storage.
}

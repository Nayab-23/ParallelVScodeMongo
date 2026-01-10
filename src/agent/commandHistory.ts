export interface AgentCommand {
  command: string;
  cwd?: string;
  purpose?: string;
  when?: string;
}

export interface AgentCommandResult {
  command: string;
  cwd?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
}

export class CommandHistory {
  private results: AgentCommandResult[] = [];

  constructor(private limit = 10) {}

  add(result: AgentCommandResult): void {
    this.results.unshift(result);
    if (this.results.length > this.limit) {
      this.results = this.results.slice(0, this.limit);
    }
  }

  clear(): void {
    this.results = [];
  }

  list(): AgentCommandResult[] {
    return [...this.results];
  }
}

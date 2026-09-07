export interface ProviderModel { runtime: 'claude' | 'codex'; id: string; label: string; installed: boolean }
export interface ProviderHandoffPlan {
  /** Fresh context keeps archive on disk and transfers only a bounded checkpoint. */
  contextMode?: 'continuity' | 'clean';
  cwd?: string;
  id: string; fromId: string; fromRuntime: string; fromModel: string | null;
  runtime: 'claude' | 'codex'; model: string; at: number;
  archive: string; historyPath: string; checkpointPath: string;
  bytes: number; sha256: string;
  phase: 'review' | 'preparing' | 'complete' | 'failed';
  detail: string; toId?: string;
}
export interface HistoryPage { text: string; next: number | null; total: number }

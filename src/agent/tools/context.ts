// Per-turn context, closed over by the tool `execute` closures built fresh for every
// generateText() call. Unlike the Claude Agent SDK's CLI-subprocess model (where tool calls run
// on a task tree disconnected from the calling turn), a single generateText() call and its tool
// executions all run in the same call stack — so plain closures are sufficient and unambiguous,
// no contextvar/background-task tricks needed.

export interface ChatContext {
  chatId: number;
  userId: number;
  updateId: number | null;
}

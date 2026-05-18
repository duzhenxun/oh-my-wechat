import type { Agent, AgentEvent, AgentState, OmwMode } from "./types.js";
type ClaudePrintAgentOptions = {
    mode: OmwMode;
    command?: string;
    cwd: string;
    args?: string[];
};
export declare class ClaudePrintAgent implements Agent {
    private readonly options;
    private sink;
    private child;
    private sessionId;
    private pendingApprovalState;
    private readonly stateValue;
    constructor(options: ClaudePrintAgentOptions);
    onEvent(sink: (event: AgentEvent) => void): void;
    start(): Promise<void>;
    send(text: string): Promise<void>;
    stop(): Promise<boolean>;
    approve(yes: boolean): Promise<boolean>;
    reset(): Promise<void>;
    state(): AgentState;
    close(): Promise<void>;
    private continueAfterApproval;
    private runClaude;
    private handleClaudeResult;
    private setStatus;
}
export {};

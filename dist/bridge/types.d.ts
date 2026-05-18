export type OmwMode = "codex" | "claude" | "opencode" | "shell";
export type AgentStatus = "starting" | "idle" | "busy" | "awaiting_approval" | "stopped" | "error";
export type ApprovalTicket = {
    id: string;
    summary: string;
    preview: string;
    createdAt: string;
};
export type AgentState = {
    mode: OmwMode;
    command: string;
    cwd: string;
    status: AgentStatus;
    pid?: number;
    startedAt?: string;
    lastInputAt?: string;
    lastOutputAt?: string;
    pendingApproval?: ApprovalTicket | null;
};
export type AgentEvent = {
    type: "output";
    stream: "stdout" | "stderr";
    text: string;
    at: string;
} | {
    type: "final";
    text: string;
    at: string;
} | {
    type: "status";
    status: AgentStatus;
    message?: string;
    at: string;
} | {
    type: "approval";
    ticket: ApprovalTicket;
    at: string;
} | {
    type: "failed";
    message: string;
    at: string;
};
export type Agent = {
    onEvent(sink: (event: AgentEvent) => void): void;
    start(): Promise<void>;
    send(text: string): Promise<void>;
    stop(): Promise<boolean>;
    approve(yes: boolean): Promise<boolean>;
    reset(): Promise<void>;
    state(): AgentState;
    close(): Promise<void>;
};

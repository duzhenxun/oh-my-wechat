import type { Agent, AgentEvent, AgentState, OmwMode } from "./types.js";
type TerminalAgentOptions = {
    mode: OmwMode;
    command?: string;
    cwd: string;
    args?: string[];
};
export declare class TerminalAgent implements Agent {
    private readonly options;
    private pty;
    private child;
    private sink;
    private readonly stateValue;
    private outputBuffer;
    private flushTimer;
    private pendingCommand;
    private closing;
    constructor(options: TerminalAgentOptions);
    onEvent(sink: (event: AgentEvent) => void): void;
    start(): Promise<void>;
    send(text: string): Promise<void>;
    stop(): Promise<boolean>;
    approve(yes: boolean): Promise<boolean>;
    reset(): Promise<void>;
    state(): AgentState;
    close(): Promise<void>;
    private writePayload;
    private handleData;
    private scheduleFlush;
    private flushOutput;
    private clearFlushTimer;
    private setStatus;
    private primeShell;
    private writeRaw;
    private handleExit;
}
export {};

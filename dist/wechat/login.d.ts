#!/usr/bin/env node
export type OmwAccount = {
    token: string;
    baseUrl: string;
    botId: string;
    userId?: string;
    savedAt: string;
};
export type LoginOptions = {
    baseUrl?: string;
    timeoutMs?: number;
    pollEveryMs?: number;
    force?: boolean;
    log?: (line: string) => void;
};
export declare function loadAccount(): OmwAccount | null;
export declare function saveAccount(account: OmwAccount): void;
export declare function validateAccount(account: OmwAccount, timeoutMs?: number): Promise<string | null>;
export declare function ensureLogin(options?: LoginOptions): Promise<OmwAccount>;
export declare function runLoginCli(): Promise<void>;

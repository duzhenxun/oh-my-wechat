#!/usr/bin/env node
import type { OmwMode } from "./types.ts";
type BridgeOptions = {
    mode: OmwMode;
    command?: string;
    cwd: string;
    args: string[];
    wechatHttpLog: boolean;
};
export declare function parseArgs(argv: string[]): BridgeOptions;
export declare function runBridge(options: BridgeOptions): Promise<void>;
export declare function runBridgeCli(): Promise<void>;
export {};

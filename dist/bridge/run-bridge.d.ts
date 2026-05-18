#!/usr/bin/env node
import type { OmwMode } from "./types.js";
type BridgeOptions = {
    mode: OmwMode;
    command?: string;
    cwd: string;
    args: string[];
};
export declare function parseArgs(argv: string[]): BridgeOptions;
export declare function runBridge(options: BridgeOptions): Promise<void>;
export declare function runBridgeCli(): Promise<void>;
export {};

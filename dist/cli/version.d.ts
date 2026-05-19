type LocalPackageInfo = {
    name: string;
    version: string;
};
type LatestVersionResult = {
    status: "ok";
    latestVersion: string;
} | {
    status: "not_published";
} | {
    status: "error";
    errorMessage: string;
};
type UpgradeCommandOptions = {
    argv?: string[];
    env?: NodeJS.ProcessEnv;
};
export declare function packageRoot(): string;
export declare function readLocalPackageInfo(): LocalPackageInfo;
export declare function fetchLatestVersion(name: string, options?: {
    timeoutMs?: number;
}): Promise<LatestVersionResult>;
export declare function compareVersions(local: string, latest: string): -1 | 0 | 1 | null;
export declare function buildUpgradeCommand(name: string, options?: UpgradeCommandOptions): string;
export declare function buildUpgradeHint(name: string, local: string, latest: string, options?: UpgradeCommandOptions): string | null;
export {};

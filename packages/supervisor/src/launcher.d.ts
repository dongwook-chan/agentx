export interface LauncherOptions {
  product: "agyx" | "cdxx";
  executable: string;
  args: string[];
  restartable?: boolean;
  socketPath?: string;
  policyCommand?: string;
  buildArgs(options: {
    originalArgs: string[];
    currentArgs: string[];
    record: any;
    logPath?: string;
  }): Promise<string[]> | string[];
}

export function runLauncher(options: LauncherOptions): Promise<number>;

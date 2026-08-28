export interface LauncherOptions {
  product: "agyx" | "cdxx";
  executable: string;
  args: string[];
  restartable?: boolean;
  socketPath?: string;
  policyCommand?: string;
  identityMode?: string;
  createTransport?(options: {
    product: "agyx" | "cdxx";
    launcherId: string;
    cwd: string;
    args: string[];
    profileName?: string;
    request(payload: Record<string, any>): Promise<any>;
  }): Promise<any> | any;
  buildArgs(options: {
    originalArgs: string[];
    currentArgs: string[];
    record: any;
    logPath?: string;
    transport?: any;
  }): Promise<string[]> | string[];
}

export function shouldHandleResumeSignal(paused: boolean, resumeRequested: boolean): boolean;

export function runLauncher(options: LauncherOptions): Promise<number>;

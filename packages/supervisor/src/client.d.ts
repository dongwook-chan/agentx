export interface SupervisorReply {
  ok: boolean;
  error?: string;
  pid?: number;
  record?: any;
  records?: any[];
  [key: string]: any;
}

export function sendSupervisor(request: Record<string, any>, options?: Record<string, any>): Promise<SupervisorReply>;
export function ensureSupervisor(options?: Record<string, any>): Promise<SupervisorReply>;
export function supervisorRequest(request: Record<string, any>, options?: Record<string, any>): Promise<SupervisorReply>;

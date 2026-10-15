type PhoneEnvironment = Record<string, string | undefined>;
type PhoneOpsNotice = Record<string, string>;
type PhoneOpsRunner = (
  command: string, args: string[], env: PhoneEnvironment,
) => Promise<{ code: number; stdout: string }>;
type NoticeInvoker = (
  command: string, args: string[], options: { timeout: number; maxBuffer: number },
) => Promise<unknown>;

export function deliverPhoneOpsNotice(input: Record<string, unknown>, invoke?: NoticeInvoker): Promise<void>;
export function runPhoneOpsAlert(options?: {
  env?: PhoneEnvironment;
  now?: Date;
  run?: PhoneOpsRunner;
  notify?: (notice: PhoneOpsNotice) => Promise<void>;
  statePath?: string;
}): Promise<{
  ok: boolean;
  conditions: string[];
  notificationsSent: number;
  scope: 'local-source-operations-only';
  publicPhoneVerified: false;
  liveProviderSpendVerified: false;
}>;

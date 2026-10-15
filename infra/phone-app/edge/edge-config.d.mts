// Type declarations for edge-config.mjs (consumed by the operator's vitest suite).
export interface EdgeCoordinates {
  publicIp: string;
  voiceHost: string;
  turnHost: string;
  boxIface: string;
  wanIface: string;
  turnPort: number;
  admissionPort?: number;
  sip: boolean;
}
export interface ForwardedPort { proto: 'udp' | 'tcp'; ports: string; what: string }
export declare const TUNNEL: Readonly<{ edge: string; box: string; prefix: number; port: number; table: number }>;
export declare const NON_PUBLIC_V4: readonly string[];
export declare const VM_TUNNEL_IFACE: string;
export declare function forwardedPorts(options?: { sip?: boolean }): ForwardedPort[];
export declare function edgeCoordinates(env: Record<string, string | undefined>): EdgeCoordinates;
export declare function vmWireguard(c: EdgeCoordinates, boxPublicKey: string): string;
export declare function boxWireguard(c: EdgeCoordinates, vmPublicKey: string): string;
export declare function vmNftables(c: EdgeCoordinates): string;
export declare function nginxStream(c: EdgeCoordinates): string;
export declare function nginxSite(c: EdgeCoordinates, options: { withTls: boolean }): string;
export declare const BOX_LOCAL_TABLE: string;
export declare const TURN_RELAY_RANGE: Readonly<{ start: number; end: number }>;
export declare function boxLocalDnat(c: EdgeCoordinates): string;
export declare function livekitInterfaces(env: Record<string, string | undefined>): string;

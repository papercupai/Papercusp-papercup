/** Public wire contract; importing it never pulls server-store types into the UI. */
export type DaoRead<T> = { status: 'ready'; value: T } | { status: 'error'; message: string };
export interface DaoCapTable {
  chainId: number; blockNumber: string; contractVersion: '1' | '2';
  issuedShares: string; reservedShares: string; fullyDilutedShares: string;
  nonBinding: boolean;
  positions: Array<import('./equity/cap-table').EquityPosition & { personId: string | null; displayName: string; isSelf: boolean }>;
}
export interface DaoPersonEquity {
  wallet: string;
  chainId: number;
  shares: string;
  issuedShares: string;
  ownershipPercent: string;
}
export interface DaoPerson {
  memberId: number;
  personId: string | null;
  username: string;
  displayName: string;
  bindingStatus: string;
  devices: number;
  profile: null | {
    title: string; team: string | null; managerPersonId: string | null; level: string | null;
    startDate: string | null; engagementType: 'employee' | 'contractor'; jurisdiction: string; status: string;
  };
  equity: DaoRead<DaoPersonEquity>;
  /** Omitted on the server unless the reader is this member or a DAO HR admin. */
  pay?: null | { amount: string; currency: string; cadence: string };
}
export interface DaoWorkspaceView {
  directoryId: string;
  localHomeSlug: string | null;
  status: 'connected' | 'not-joined';
  /** Lookup scope for separately authenticated contract signers; grants no work access. */
  contractHomeSlug?: string;
  members?: DaoRead<Array<{ id: number; username: string; displayName: string | null; bindingStatus: string; devices: number }>>;
  people?: DaoRead<DaoPerson[]>;
  capTable?: DaoRead<DaoCapTable>;
  policy?: DaoRead<{ version: number; membership: string | null; admission: unknown; delegations: unknown }>;
  governance?: DaoRead<{ events: Array<{ eventId: string; roundId: string; kind: string; body: unknown }>; integrityErrors: readonly string[]; conflictedRoundIds: string[] }>;
  projects?: DaoRead<Array<{ slug: string; title: string; plans: Array<{ slug: string; title: string; status: string; owner: string | null; itemCount: number }> }>>;
}

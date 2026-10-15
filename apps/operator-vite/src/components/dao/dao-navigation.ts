export const DAO_SECTIONS = [
  { id: 'directory', label: 'Discover workspaces', group: 'Community', description: 'Browse workspaces and DAOs. A workspace does not need to belong to a DAO.' },
  { id: 'overview', label: 'Overview', group: 'Community', description: 'Your organization, its purpose and what needs attention.' },
  { id: 'join', label: 'Membership', group: 'Community', description: 'Review admission and join a discovered organization.' },
  { id: 'members', label: 'Members', group: 'Community', description: 'People, roles and membership permissions.' },
  { id: 'proposals', label: 'Proposals', group: 'Governance', description: 'Create, discuss and review decisions.' },
  { id: 'vote', label: 'Voting', group: 'Governance', description: 'Review proposals and member ballots.' },
  { id: 'delegation', label: 'Delegation', group: 'Governance', description: 'Who represents your vote and when authority expires.' },
  { id: 'work', label: 'Projects', group: 'Execution', description: 'Plans, work, acceptance evidence and project progress.' },
  { id: 'jobs', label: 'Jobs & agents', group: 'Execution', description: 'Execution, contributors and active agents.' },
  { id: 'treasury', label: 'Treasury', group: 'Finance', description: 'Accounts, approved spending and signer requirements.' },
  { id: 'funding', label: 'Funding', group: 'Finance', description: 'Budgets, funding commitments and contribution agreements.' },
  { id: 'billing', label: 'Billing', group: 'Finance', description: 'Purchases, usage, invoices and refunds.' },
  { id: 'ownership', label: 'Ownership', group: 'Finance', description: 'Equity grants, vesting and ownership governance.' },
  { id: 'returns', label: 'Returns', group: 'Finance', description: 'Additional-share returns and holder records.' },
  { id: 'reputation', label: 'Contributions', group: 'Community', description: 'Accepted work, contribution history and reputation.' },
  { id: 'marketplace', label: 'Marketplace', group: 'Execution', description: 'Capabilities and products available to your organization.' },
  { id: 'records', label: 'Records', group: 'Organization', description: 'Decision history, documents and audit evidence.' },
  { id: 'settings', label: 'Settings', group: 'Organization', description: 'Organization information, policy and access.' },
  { id: 'inbox', label: 'Inbox', group: 'Organization', description: 'Decisions and requests requiring attention.' },
] as const;

export type DaoSection = typeof DAO_SECTIONS[number]['id'];
export function daoSection(value: string | null): DaoSection {
  return DAO_SECTIONS.find(section => section.id === value)?.id ?? 'directory';
}

export interface DaoDirectoryEntry {
  potId: string;
  title: string;
  description: string;
  owner: string;
  visibility: 'public' | 'invite';
  memberLinks: string[];
  memberTopics: string[];
  memberCount: number;
  source?: 'local';
  workspaceId?: string;
  workspaceHostId?: string;
}

/** Discovery's count is linked projects, not people, votes, assets or equity. */
export function filterDaos(rows: DaoDirectoryEntry[], query: string): DaoDirectoryEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter(row => [row.title, row.description, row.owner].some(value => value.toLocaleLowerCase().includes(needle)));
}

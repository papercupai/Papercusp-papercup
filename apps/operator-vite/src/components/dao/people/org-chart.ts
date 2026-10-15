import type { DaoPerson } from '@papercusp/operator-core/lib/dao-workspace-types';

export interface OrgNode {
  person: DaoPerson;
  reports: OrgNode[];
  issue: string | null;
}

/** Membership defines the population; reporting lines come only from work profiles. */
export function reportingForest(people: DaoPerson[]): OrgNode[] {
  const byPerson = new Map(people.filter(p => p.personId).map(p => [p.personId!, p]));
  const parent = new Map<number, number>();
  const nodes = new Map(people.map(person => [person.memberId, { person, reports: [], issue: null } as OrgNode]));
  for (const person of people) {
    const managerId = person.profile?.managerPersonId;
    if (!managerId) continue;
    const manager = byPerson.get(managerId);
    if (manager) parent.set(person.memberId, manager.memberId);
    else nodes.get(person.memberId)!.issue = 'Manager is not a current member.';
  }
  // Break only cyclic edges. Keep genuine reports attached to the named person,
  // and surface inconsistent data instead of inventing a root manager.
  const cyclic = new Set<number>();
  for (const person of people) {
    const path: number[] = [];
    const positions = new Map<number, number>();
    let id: number | undefined = person.memberId;
    while (id !== undefined && !positions.has(id)) {
      positions.set(id, path.length);
      path.push(id);
      id = parent.get(id);
    }
    if (id !== undefined) for (const member of path.slice(positions.get(id)!)) cyclic.add(member);
  }
  const roots: OrgNode[] = [];
  for (const person of people) {
    const node = nodes.get(person.memberId)!;
    const manager = parent.get(person.memberId);
    if (cyclic.has(person.memberId)) {
      node.issue = 'Reporting cycle: review this work profile.';
      roots.push(node);
    } else if (manager !== undefined) nodes.get(manager)!.reports.push(node);
    else roots.push(node);
  }
  return roots;
}

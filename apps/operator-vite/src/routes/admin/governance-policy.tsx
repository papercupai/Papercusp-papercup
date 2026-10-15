import { createFileRoute } from '@tanstack/react-router';
import AdminShell from '../../components/admin/AdminShell';
import GovernancePolicyAdmin from '@/app/admin/governance-policy/GovernancePolicyAdmin';

/**
 * /admin/governance-policy — the desktop door to the inherited organization → department →
 * workspace governance policy pane (plan papercusp-enterprise-readiness-roadmap-2026-10-09
 * P-005, WI-6554700010011434). The pane reads `governancePolicy.state` and writes through
 * /api/governance-policy/*, the same operations as the `governance:policy` MCP tool.
 */
export const Route = createFileRoute('/admin/governance-policy')({
  component: GovernancePolicyPage,
});

function GovernancePolicyPage() {
  return (
    <AdminShell title="Governance policy">
      <GovernancePolicyAdmin />
    </AdminShell>
  );
}

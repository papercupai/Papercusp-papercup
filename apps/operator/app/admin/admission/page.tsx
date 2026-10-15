import AdminShell from "../_components/AdminShell";
import AdmissionRunsClient from "./AdmissionRunsClient";
import TicketSourcesHealth from "./TicketSourcesHealth";

/** Owner-facing work-item admission run ledger, queue-health rollups and ticket-source health. */
export default function AdminAdmissionPage() {
  return (
    <AdminShell title="Admission">
      <AdmissionRunsClient />
      <TicketSourcesHealth />
    </AdminShell>
  );
}

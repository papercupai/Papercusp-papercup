import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/integrations/page';

/** Ticket-tracker integrations: connect, choose what syncs, map columns, admission rules (D-014). */
export const Route = createFileRoute('/settings/integrations')({
  component: Page,
});

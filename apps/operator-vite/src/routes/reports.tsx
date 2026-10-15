import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

export const Route = createFileRoute('/reports')({
  component: lazyRouteComponent(() => import('../components/reports/ReportsRoute')),
});

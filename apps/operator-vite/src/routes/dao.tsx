import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
export const Route = createFileRoute('/dao')({
  component: lazyRouteComponent(() => import('@/app/dao/page')),
});

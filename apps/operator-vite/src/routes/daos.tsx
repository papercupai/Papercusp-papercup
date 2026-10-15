import { createFileRoute } from '@tanstack/react-router';
import DaoWorkspace from '../components/dao/DaoWorkspace';

export const Route = createFileRoute('/daos')({ component: DaoWorkspace });

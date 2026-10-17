/**
 * capability:read tool registration.
 *
 * The implementation lives in `read-handler.ts` so fresh-process recovery
 * probes can exercise the reader without importing the full agent-mcp catalog.
 */
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { capabilityReadDefinition } from './read-handler';

export {
  capabilityReadSeeAlso,
  DEFAULT_LIMIT,
  MAX_BYTE_PAGE,
  MAX_FILE_BYTES,
  MIN_PAGE_BYTES,
  doorSafePageBytes,
} from './read-handler';

export default defineTool({
  ...capabilityReadDefinition,
  // Evidence-only acceptance judges may read cited files, but remain outside
  // every fs-write/bash allowlist and capability grant.
  agentRoles: [...AGENT_ROLES, 'judge'],
});

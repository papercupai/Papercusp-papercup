import { defineTool } from '@papercusp/agent-mcp';
import { ZodError } from 'zod';
import { getSessionUserOrDefault } from '../../../auth';
import { createDaoLaunch, updateDaoLaunch, reviewDaoLaunch, listDaoLaunches, DaoLaunchError } from '../../../dao-launch-store';

function failure(error: unknown) {
  if (error instanceof ZodError) return Response.json({ error: 'invalid-input', message: error.issues.map(i => i.path.join('.') + ': ' + i.message).join('; ') }, { status: 400 });
  if (error instanceof DaoLaunchError) return Response.json({ error: error.code, message: error.message }, { status: error.code === 'not-found' ? 404 : 409 });
  throw error;
}
const list = defineTool({
  method: 'GET', path: '/desktop/dao-launch', auth: {},
  async handler() { return Response.json({ organizations: await listDaoLaunches() }); },
});
const create = defineTool({
  method: 'POST', path: '/desktop/dao-launch', auth: {},
  async handler(req) {
    try {
      const user = await getSessionUserOrDefault(req.headers);
      const record = await createDaoLaunch(await req.json().catch(() => null), { id: user.id, name: user.display_name || user.username || user.id });
      return Response.json({ organization: record }, { status: 201 });
    } catch (error) { return failure(error); }
  },
});
const update = defineTool({
  method: 'PATCH', path: '/desktop/dao-launch/:id', auth: {},
  async handler(req, ctx) {
    try { return Response.json({ organization: await updateDaoLaunch(ctx.params.id as string, await req.json().catch(() => null)) }); }
    catch (error) { return failure(error); }
  },
});
const review = defineTool({
  method: 'POST', path: '/desktop/dao-launch/:id/review', auth: {},
  async handler(req, ctx) {
    try { return Response.json({ organization: await reviewDaoLaunch(ctx.params.id as string, await req.json().catch(() => null)) }); }
    catch (error) { return failure(error); }
  },
});
export default [list, create, update, review];

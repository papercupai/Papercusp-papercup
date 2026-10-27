import { DockviewReact, type DockviewReadyEvent, type IDockviewHeaderActionsProps, type IDockviewPanelProps } from 'dockview';
import 'dockview-react/dist/styles/dockview.css';

// Keep the real dock engine and HarnessDock lifecycle; replace app services only.
const panes = ['Work items', 'Dependency graph', 'Detail'];
function Draft({ api }: IDockviewPanelProps) {
  return <input aria-label={`${api.title} draft`} defaultValue="Keep this draft" />;
}
const components = { draft: Draft };
export function DockWorkspace({ onApiReady, rightHeaderActionsComponent }: {
  onApiReady: (api: DockviewReadyEvent['api']) => void;
  rightHeaderActionsComponent: React.FunctionComponent<IDockviewHeaderActionsProps>;
}) {
  return <DockviewReact className="dockview-theme-dark" components={components}
    rightHeaderActionsComponent={rightHeaderActionsComponent}
    onReady={({ api }) => {
      api.addPanel({ id: 'work', component: 'draft', title: panes[0] });
      api.addPanel({ id: 'detail', component: 'draft', title: panes[2],
        position: { referencePanel: 'work', direction: 'below' } });
      api.addPanel({ id: 'graph', component: 'draft', title: panes[1],
        position: { referencePanel: 'work', direction: 'right' } });
      onApiReady(api);
    }} />;
}
export const createFetchDockLayoutStore = () => ({});
export const fetchSyncQuery = async () => [];
export const useWorkspaceId = () => 'fixture';
export const MissingPanel = () => null;
export const bindDockApi = () => {};
export const canClosePanel = () => true;
export const configureCloseGuard = () => {};
export const useNavShortcuts = () => {};
export const useLayoutResetShortcut = () => {};
export const useRegisterPluginPanels = () => {};
export const useFocusedPanelTracker = () => {};
export const destroy = () => {};
export const useConfirmDialog = () => ({ confirm: async () => true, element: null });
export const beginInteraction = () => {};
export const endInteraction = () => {};
export const PERF_INTERACTIONS = { harnessDockOpen: 'fixture' };

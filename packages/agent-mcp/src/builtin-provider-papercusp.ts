import { setBuiltinToolProvider } from '@papercusp/tooldef';
import packageMetadata from '../package.json' with { type: 'json' };

// Static import is bundled with this exact loaded provider. Do not read a newer
// checkout's package.json during conformance or invent a plugin installation.
setBuiltinToolProvider({
  pluginName: 'agent-mcp',
  packageName: packageMetadata.name,
  version: packageMetadata.version,
});

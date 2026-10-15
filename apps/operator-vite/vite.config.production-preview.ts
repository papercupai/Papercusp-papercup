import { mergeConfig, type Plugin } from 'vite';
import base from './vite.config';

let armed = false;

const firstCssFailurePlugin: Plugin = {
  name: 'e2e-production-preview-first-css-failure',
  configurePreviewServer(server) {
    server.middlewares.use((request, response, next) => {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;

      if (request.method === 'POST' && pathname === '/__e2e/arm-first-css-failure') {
        armed = true;
        response.statusCode = 204;
        response.end();
        return;
      }

      if (armed && request.method === 'GET' && pathname.endsWith('.css')) {
        armed = false;
        response.statusCode = 503;
        response.setHeader('Content-Type', 'text/css; charset=utf-8');
        response.end('/* first lazy HUD stylesheet failure */');
        return;
      }

      next();
    });
  },
};

export default mergeConfig(base, { plugins: [firstCssFailurePlugin] });

import { defineVitestConfig } from '@papercusp/test-config';

const config = defineVitestConfig({ layer: 'integration', include: ['src/**/*.integration.test.tsx'] });
export default { ...config, test: { ...config.test, environment: 'jsdom' } };

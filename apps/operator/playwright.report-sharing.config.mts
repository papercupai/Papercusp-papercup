/** Public viewer proof runs independently of the desktop content server. */
import {defineConfig} from '@playwright/test';
import base from './playwright.config.mts';
export default defineConfig({...base,globalSetup:undefined,webServer:undefined,
  testMatch:/report-sharing\.spec\.ts$/,fullyParallel:false,workers:1,timeout:240000,
  use:{...base.use,baseURL:undefined},outputDir:'test-results/report-sharing'});

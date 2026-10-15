import { describe, expect, it } from 'vitest';
import { renderLlamaServerUnit } from './backend-config';

describe('renderLlamaServerUnit', () => {
  it('renders a unit matching the shape of the real llama-ornith.service unit', () => {
    const unit = renderLlamaServerUnit({
      alias: 'maxwell1500/ornith-35b:IQ3_M',
      weightsPath: '/usr/share/ollama/.ollama/models/blobs/sha256-18f775956e1ee0',
      host: '127.0.0.1',
      port: 11436,
      parallelSlots: 2,
      ctxTotal: 180224,
      kvCacheType: 'q8_0',
      flashAttn: true,
      logPath: '/home/dev/.papercusp/provisioner-ornith.log',
    });
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('ExecStart=llama-server');
    expect(unit).toContain('-m /usr/share/ollama/.ollama/models/blobs/sha256-18f775956e1ee0');
    expect(unit).toContain('--host 127.0.0.1 --port 11436');
    expect(unit).toContain('--flash-attn on');
    expect(unit).toContain('-np 2 -c 180224');
    expect(unit).toContain('--cache-type-k q8_0 --cache-type-v q8_0');
    expect(unit).toContain('--alias maxwell1500/ornith-35b:IQ3_M');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('honors flashAttn:false and a custom binPath', () => {
    const unit = renderLlamaServerUnit({
      alias: 'x',
      weightsPath: '/w',
      host: '0.0.0.0',
      port: 8080,
      parallelSlots: 1,
      ctxTotal: 4096,
      kvCacheType: 'f16',
      flashAttn: false,
      logPath: '/log',
      binPath: '/opt/llama.cpp/bin/llama-server',
    });
    expect(unit).toContain('--flash-attn off');
    expect(unit).toContain('ExecStart=/opt/llama.cpp/bin/llama-server');
    // No jinja/reasoningBudget passed → the flags must NOT appear (back-compat with entry #1).
    expect(unit).not.toContain('--jinja');
    expect(unit).not.toContain('--reasoning-budget');
  });

  it('renders --jinja and --reasoning-budget for the certified qwen3 config (WI-1596)', () => {
    const unit = renderLlamaServerUnit({
      alias: 'qwen3:8b',
      weightsPath: '/home/u/.papercusp/models/Qwen3-8B-Q4_K_M.gguf',
      host: '127.0.0.1',
      port: 11437,
      parallelSlots: 2,
      ctxTotal: 16384,
      kvCacheType: 'f16',
      flashAttn: false,
      jinja: true,
      reasoningBudget: 0,
      logPath: '/log',
    });
    expect(unit).toContain('--jinja --reasoning-budget 0 \\');
    expect(unit).toContain('--alias qwen3:8b');
    // The extra-flags line sits INSIDE the ExecStart continuation, before --alias.
    expect(unit.indexOf('--jinja')).toBeLessThan(unit.indexOf('--alias'));
  });

  it('renders start-time GPU fit as its own continuation line after -ngl (WI-10006354)', () => {
    const unit = renderLlamaServerUnit({
      alias: 'maxwell1500/ornith-35b:IQ3_M',
      weightsPath: '/blobs/sha256-x',
      host: '127.0.0.1',
      port: 11436,
      parallelSlots: 2,
      ctxTotal: 180224,
      kvCacheType: 'q8_0',
      flashAttn: true,
      gpuLayers: 'auto',
      fit: 'on',
      fitTargetMiB: 1024,
      logPath: '/log',
    });
    expect(unit).toContain('  -ngl auto \\\n  --fit on --fit-target 1024 \\\n  -np 2 -c 180224 \\\n');
  });

  it('writes no fit flags when fit is undeclared, and no --fit-target without --fit', () => {
    const base = {
      alias: 'a', weightsPath: '/w', host: '127.0.0.1', port: 1, parallelSlots: 1, ctxTotal: 4096,
      kvCacheType: 'f16', flashAttn: false, logPath: '/log',
    };
    expect(renderLlamaServerUnit({ ...base, gpuLayers: 999 })).not.toContain('--fit');
    expect(renderLlamaServerUnit({ ...base, fitTargetMiB: 512 })).not.toContain('--fit');
    expect(renderLlamaServerUnit({ ...base, fit: 'off' })).toContain('  --fit off \\\n');
  });
});

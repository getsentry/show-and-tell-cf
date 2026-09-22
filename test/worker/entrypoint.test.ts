import {ContainerProxy} from '@cloudflare/containers';
import {describe, expect, it} from 'vitest';

import * as worker from '../../src/worker';

// The Containers SDK resolves this exact entrypoint through ctx.exports when
// starting a container with outbound interception, before FFmpeg can run.
describe('Worker container entrypoints', () => {
  it('exports the SDK proxy required by scoped video R2 interception', () => {
    expect(worker).toHaveProperty('ContainerProxy', ContainerProxy);
  });
});

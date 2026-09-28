import { describe, expect, it } from 'vitest';
import { JOB_NAMES, JobPayloadSchemas, parseJobPayload } from './definitions.ts';

describe('job definitions', () => {
  it('has a payload schema for every job name', () => {
    expect(Object.keys(JobPayloadSchemas).sort()).toEqual([...JOB_NAMES].sort());
  });

  it('validates payloads', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(parseJobPayload('classify-cluster', { clusterId: id })).toEqual({ clusterId: id });
    expect(() => parseJobPayload('classify-cluster', { clusterId: 'nope' })).toThrow();
    expect(() => parseJobPayload('refresh-metrics', { videoIds: [] })).toThrow();
  });
});

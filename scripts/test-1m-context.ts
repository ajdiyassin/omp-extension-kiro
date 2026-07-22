#!/usr/bin/env npx tsx
/**
 * Retired diagnostic.
 *
 * Model availability and context/output limits are now discovered dynamically from
 * Kiro's ListAvailableModels response. Use OMP's `/model` refresh and the sanitized
 * discovery fixture tests instead of sending requests to the retired q.* endpoint.
 */

throw new Error(
  "This diagnostic was retired after native Kiro model discovery; refresh the kiro provider from OMP /model instead.",
);

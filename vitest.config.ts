import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Eval files drive a real LLM via LiveKit Inference. Running them in
    // parallel multiplies concurrent inference load (empty/degraded
    // completions under throttling), so files run serially. The
    // deterministic unit tests lose nothing measurable from this.
    fileParallelism: false,
  },
});

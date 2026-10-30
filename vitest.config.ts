import { defineConfig } from 'vitest/config';

// Tests run against an explicitly simulated payment provider (no Razorpay keys, no money).
// Sandbox auth and demo routes stay off unless a test switches them on for itself.
export default defineConfig({
  test: {
    env: {
      BOUND_SIMULATED_PAYMENTS: 'true',
      BOUND_SANDBOX_AUTH: 'false',
      BOUND_DEMO_ROUTES: 'false'
    }
  }
});

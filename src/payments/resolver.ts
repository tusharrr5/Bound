export type PaymentRailCapabilityType = 'AUTO_EXECUTABLE' | 'INTERACTIVE' | 'UNSUPPORTED';

export interface PaymentRailCapability {
  provider: 'RAZORPAY_CHECKOUT' | 'RAZORPAY_UPI_RESERVE_PAY' | 'MOCK_SIMULATED_RAIL';
  paymentMethod: string;
  capabilityType: PaymentRailCapabilityType;
  supportsOffSessionExecution: boolean;
  requiresInteractiveAuthentication: boolean;
  accessTier: 'DEFAULT_TEST_MODE' | 'BETA_SIGNUP_REQUIRED' | 'SIMULATED';
  description: string;
}

/**
 * Question 2: Can this payment rail execute autonomously, or does it require interactive human authentication?
 * 
 * - AUTO_EXECUTABLE: Rail supports off-session autonomous server-to-server debit (e.g. simulated autonomous rail or future pre-authorized UPI ReservePay rail).
 * - INTERACTIVE: Rail requires interactive OTP/UPI approval on consumer device (e.g. Standard Razorpay Checkout).
 * - UNSUPPORTED: Requested rail is disabled, incompatible with currency/merchant, or unavailable.
 */
export function resolvePaymentRailCapability(
  requestedRail?: string,
  isDemoSimulated?: boolean
): PaymentRailCapability {
  // If demo simulation mode is explicitly requested
  if (isDemoSimulated || requestedRail === 'MOCK_SIMULATED_RAIL') {
    return {
      provider: 'MOCK_SIMULATED_RAIL',
      paymentMethod: 'UPI_RESERVE_SIMULATED',
      capabilityType: 'AUTO_EXECUTABLE',
      supportsOffSessionExecution: true,
      requiresInteractiveAuthentication: false,
      accessTier: 'SIMULATED',
      description: 'Simulated Autonomous Payment Rail supporting zero-click off-session settlement under verified mandate.'
    };
  }

  // Real Standard Razorpay Test Mode Checkout (Default)
  return {
    provider: 'RAZORPAY_CHECKOUT',
    paymentMethod: 'RAZORPAY_HOSTED_CHECKOUT',
    capabilityType: 'INTERACTIVE',
    supportsOffSessionExecution: false,
    requiresInteractiveAuthentication: true,
    accessTier: 'DEFAULT_TEST_MODE',
    description: 'Standard Razorpay Checkout requires interactive customer authentication (OTP/UPI intent) on consumer device.'
  };
}

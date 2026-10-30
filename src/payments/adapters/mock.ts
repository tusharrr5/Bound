export interface MockPaymentInput {
  orderId: string;
  checkoutId?: string;
  amountMinor: number;
  currency: string;
  correlationId: string;
}

export interface MockPaymentResult {
  provider: 'MOCK_SIMULATED_RAIL';
  rail: 'SIMULATED_PAYMENT_RAIL';
  status: 'CAPTURED';
  paymentId: string;
  simulatedPaymentId: string;
  amountMinor: number;
  currency: string;
  simulatedAt: string;
  note: string;
}

export async function createSimulatedPayment(input: MockPaymentInput): Promise<MockPaymentResult> {
  const simulatedPaymentId = `pay_sim_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  return {
    provider: 'MOCK_SIMULATED_RAIL',
    rail: 'SIMULATED_PAYMENT_RAIL',
    status: 'CAPTURED',
    paymentId: simulatedPaymentId,
    simulatedPaymentId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    simulatedAt: new Date().toISOString(),
    note: 'This payment was processed via SIMULATED_PAYMENT_RAIL under verified Ed25519 mandate. It demonstrates the zero-human-intervention choreography of UPI Reserve Pay / AP2.'
  };
}

export async function executeMockAutonomousPayment(input: MockPaymentInput): Promise<MockPaymentResult> {
  return createSimulatedPayment(input);
}

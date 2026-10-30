/**
 * Legal State-Transition Machines for Autonomous Commerce (P0.4 & Separate Lifecycles)
 * Explicitly separates:
 * 1. CheckoutStatus (Interactive / autonomous initiation lifecycle)
 * 2. PaymentStatus (Financial ledger & PSP capture state)
 * 3. OrderStatus (Commercial agreement, fulfilment, and resolution)
 * 4. RefundStatus (Independent refund lifecycle with PSP processing / confirmation)
 */

export type CheckoutStatus =
  | 'PENDING'
  | 'AWAITING_AUTH'
  | 'PAYMENT_UNCERTAIN'
  | 'PAYMENT_ATTEMPT_FAILED'
  | 'PAID'
  | 'PAYMENT_FAILED'
  | 'EXPIRED'
  | 'CANCELLED';

export type PaymentStatus =
  | 'CREATED'
  | 'PENDING'
  | 'AUTHORIZED'
  | 'PAYMENT_UNCERTAIN'
  | 'CAPTURED'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED'
  | 'FAILED'
  | 'CANCELLED';

export type OrderStatus =
  | 'PENDING_CONFIRMATION'
  | 'CONFIRMED'
  | 'PAID' // Alias for CONFIRMED
  | 'PROCESSING'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'PAYMENT_UNCERTAIN'
  | 'PAYMENT_ATTEMPT_FAILED'
  | 'PAYMENT_FAILED'
  | 'FULFILMENT_EXCEPTION'
  | 'REFUND_REQUIRED'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'MANUAL_RESOLUTION_REQUIRED'
  | 'RETURN_REQUESTED'
  | 'RETURNED'
  | 'CANCELLED';

export type RefundStatus =
  | 'CREATED'
  | 'SUBMITTED'
  | 'REFUND_UNCERTAIN'
  | 'PROCESSING'
  | 'PROCESSED'
  | 'FAILED'
  | 'MANUAL_RESOLUTION_REQUIRED';

export const LEGAL_CHECKOUT_TRANSITIONS: Record<CheckoutStatus, CheckoutStatus[]> = {
  PENDING: ['AWAITING_AUTH', 'PAID', 'CANCELLED', 'EXPIRED'],
  AWAITING_AUTH: ['PAID', 'PAYMENT_UNCERTAIN', 'PAYMENT_ATTEMPT_FAILED', 'CANCELLED', 'EXPIRED'],
  PAYMENT_UNCERTAIN: ['PAID', 'PAYMENT_ATTEMPT_FAILED', 'CANCELLED'],
  PAYMENT_ATTEMPT_FAILED: ['AWAITING_AUTH', 'PAID', 'CANCELLED', 'EXPIRED'],
  PAID: [],
  PAYMENT_FAILED: ['AWAITING_AUTH', 'CANCELLED'],
  EXPIRED: [],
  CANCELLED: []
};

export const LEGAL_PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  CREATED: ['PENDING', 'CANCELLED'],
  PENDING: ['AUTHORIZED', 'CAPTURED', 'FAILED', 'PAYMENT_UNCERTAIN', 'CANCELLED'],
  AUTHORIZED: ['CAPTURED', 'CANCELLED'],
  PAYMENT_UNCERTAIN: ['AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED'],
  CAPTURED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
  PARTIALLY_REFUNDED: ['REFUNDED'],
  REFUNDED: [],
  FAILED: ['PENDING'], // Allowed only on retry
  CANCELLED: []
};

export const LEGAL_ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING_CONFIRMATION: [
    'CONFIRMED',
    'PAID',
    'CANCELLED',
    'PAYMENT_UNCERTAIN',
    'PAYMENT_ATTEMPT_FAILED',
    'PAYMENT_FAILED',
    'FULFILMENT_EXCEPTION'
  ],
  CONFIRMED: ['PROCESSING', 'CANCELLED', 'FULFILMENT_EXCEPTION'],
  PAID: ['PROCESSING', 'CANCELLED', 'FULFILMENT_EXCEPTION'],
  PROCESSING: ['SHIPPED', 'CANCELLED', 'FULFILMENT_EXCEPTION'],
  SHIPPED: ['DELIVERED', 'RETURN_REQUESTED', 'FULFILMENT_EXCEPTION'],
  DELIVERED: ['RETURN_REQUESTED'],
  RETURN_REQUESTED: ['RETURNED', 'DELIVERED'],
  RETURNED: ['REFUND_REQUIRED', 'REFUNDED'],
  PAYMENT_UNCERTAIN: ['CONFIRMED', 'PAID', 'PAYMENT_ATTEMPT_FAILED', 'PAYMENT_FAILED', 'CANCELLED'],
  PAYMENT_ATTEMPT_FAILED: ['PENDING_CONFIRMATION', 'CONFIRMED', 'CANCELLED'],
  PAYMENT_FAILED: ['PENDING_CONFIRMATION', 'CANCELLED'],
  FULFILMENT_EXCEPTION: ['REFUND_REQUIRED', 'REFUNDED', 'MANUAL_RESOLUTION_REQUIRED', 'CONFIRMED'],
  REFUND_REQUIRED: ['REFUND_PENDING', 'REFUNDED', 'MANUAL_RESOLUTION_REQUIRED'],
  REFUND_PENDING: ['REFUNDED', 'MANUAL_RESOLUTION_REQUIRED'],
  REFUNDED: [],
  MANUAL_RESOLUTION_REQUIRED: ['CONFIRMED', 'REFUND_REQUIRED', 'REFUNDED', 'CANCELLED'],
  CANCELLED: []
};

export const LEGAL_REFUND_TRANSITIONS: Record<RefundStatus, RefundStatus[]> = {
  CREATED: ['SUBMITTED', 'REFUND_UNCERTAIN', 'FAILED'],
  SUBMITTED: ['PROCESSING', 'PROCESSED', 'REFUND_UNCERTAIN', 'FAILED'],
  REFUND_UNCERTAIN: ['PROCESSING', 'PROCESSED', 'FAILED', 'MANUAL_RESOLUTION_REQUIRED', 'SUBMITTED'],
  PROCESSING: ['PROCESSED', 'FAILED', 'REFUND_UNCERTAIN'],
  PROCESSED: [],
  FAILED: ['SUBMITTED', 'CREATED', 'MANUAL_RESOLUTION_REQUIRED'],
  MANUAL_RESOLUTION_REQUIRED: ['SUBMITTED', 'PROCESSED', 'FAILED']
};

// ─── VALIDATION HELPERS ─────────────────────────────────────────────────────

export function canTransitionCheckout(current: CheckoutStatus, target: CheckoutStatus): boolean {
  if (current === target) return true;
  return (LEGAL_CHECKOUT_TRANSITIONS[current] || []).includes(target);
}

export function validateCheckoutTransition(current: CheckoutStatus, target: CheckoutStatus): void {
  if (!canTransitionCheckout(current, target)) {
    throw new Error(
      `ILLEGAL_CHECKOUT_STATE_TRANSITION: Cannot transition checkout from '${current}' to '${target}'. Allowed: [${(LEGAL_CHECKOUT_TRANSITIONS[current] || []).join(', ')}]`
    );
  }
}

export function canTransitionPayment(current: PaymentStatus, target: PaymentStatus): boolean {
  if (current === target) return true;
  return (LEGAL_PAYMENT_TRANSITIONS[current] || []).includes(target);
}

export function validatePaymentTransition(current: PaymentStatus, target: PaymentStatus): void {
  if (!canTransitionPayment(current, target)) {
    throw new Error(
      `ILLEGAL_PAYMENT_STATE_TRANSITION: Cannot transition payment from '${current}' to '${target}'. Allowed: [${(LEGAL_PAYMENT_TRANSITIONS[current] || []).join(', ')}]`
    );
  }
}

export function canTransitionOrder(current: OrderStatus, target: OrderStatus): boolean {
  if (current === target) return true;
  return (LEGAL_ORDER_TRANSITIONS[current] || []).includes(target);
}

export function validateOrderTransition(current: OrderStatus, target: OrderStatus): void {
  if (!canTransitionOrder(current, target)) {
    throw new Error(
      `ILLEGAL_ORDER_STATE_TRANSITION: Cannot transition order from '${current}' to '${target}'. Allowed: [${(LEGAL_ORDER_TRANSITIONS[current] || []).join(', ')}]`
    );
  }
}

export function canTransitionRefund(current: RefundStatus, target: RefundStatus): boolean {
  if (current === target) return true;
  return (LEGAL_REFUND_TRANSITIONS[current] || []).includes(target);
}

export function validateRefundTransition(current: RefundStatus, target: RefundStatus): void {
  if (!canTransitionRefund(current, target)) {
    throw new Error(
      `ILLEGAL_REFUND_STATE_TRANSITION: Cannot transition refund from '${current}' to '${target}'. Allowed: [${(LEGAL_REFUND_TRANSITIONS[current] || []).join(', ')}]`
    );
  }
}

// ─── RESERVATION STATE MACHINE (P0.4 & Invariant Guards) ──────────────────────

export type ReservationStatus =
  | 'ACTIVE'
  | 'COMMITTED'
  | 'RELEASED'
  | 'EXPIRED';

export const LEGAL_RESERVATION_TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  ACTIVE: ['COMMITTED', 'RELEASED', 'EXPIRED'],
  COMMITTED: [], // Terminal
  RELEASED: [],  // Terminal
  EXPIRED: []    // Terminal
};

export function canTransitionReservation(current: ReservationStatus, target: ReservationStatus): boolean {
  if (current === target) return true;
  return (LEGAL_RESERVATION_TRANSITIONS[current] || []).includes(target);
}

export function validateReservationTransition(current: ReservationStatus, target: ReservationStatus): void {
  if (!canTransitionReservation(current, target)) {
    throw new Error(
      `ILLEGAL_RESERVATION_STATE_TRANSITION: Cannot transition reservation from '${current}' to '${target}'. Allowed: [${(LEGAL_RESERVATION_TRANSITIONS[current] || []).join(', ')}]`
    );
  }
}

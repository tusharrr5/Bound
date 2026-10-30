import { executeToolCall } from './tools.js';
import { PrincipalContext } from '../middleware/auth.js';
import { getMerchantCapabilities } from './capabilities.js';

export type BuyerIntentType = 
  | 'DISCOVER_CAPABILITIES'
  | 'SEARCH_PRODUCTS'
  | 'GET_PRODUCT_DETAIL'
  | 'INITIALIZE_CART'
  | 'RESERVE_ITEM'
  | 'NEGOTIATE_PRICE'
  | 'SUBMIT_CHECKOUT'
  | 'CHECK_ORDER_STATUS';

export interface BuyerMessage {
  intent: BuyerIntentType;
  parameters: Record<string, any>;
  correlationId: string;
  principalContext: PrincipalContext;
}

export interface SellerAgentResponse {
  sellerAgentId: string;
  merchantId: string;
  intentProcessed: BuyerIntentType;
  dialogue: string;
  result: any;
  policyExplanation?: string;
  provenanceProof?: {
    quoteHash?: string;
    merkleRoot?: string;
    auditStatus?: string;
  };
}

/**
 * Seller Agent Façade.
 * 
 * ARCHITECTURE INVARIANT:
 * - The Seller Agent handles protocol interpretation, negotiation dialogue, capability discovery, and explanation.
 * - The Seller Agent DOES NOT decide prices, inventory reservations, policy rules, or payment capture authorizations.
 * - All state mutations, pricing evaluations, and cryptographic verifications are delegated to deterministic engines.
 */
export class SellerAgent {
  public readonly sellerAgentId: string;
  public readonly merchantId: string;
  public readonly merchantName: string;

  constructor(
    sellerAgentId = 'seller_agent_apex_v1',
    merchantId = '11111111-1111-1111-1111-111111111111',
    merchantName = 'Apex Global Retail'
  ) {
    this.sellerAgentId = sellerAgentId;
    this.merchantId = merchantId;
    this.merchantName = merchantName;
  }

  /**
   * Processes inbound Buyer Agent messages, executes deterministic engines, and formats seller dialogue.
   */
  public async handleBuyerMessage(message: BuyerMessage): Promise<SellerAgentResponse> {
    const { intent, parameters, correlationId, principalContext } = message;

    switch (intent) {
      case 'DISCOVER_CAPABILITIES': {
        const capabilities = getMerchantCapabilities();
        const dialogue = `${this.merchantName} agent capability profile: search=${capabilities.search}, negotiation=${capabilities.negotiation}, autonomous_mandates=${capabilities.mandates.manifest_signed}, razorpay_standard=${capabilities.payment_rails.razorpay_standard}.`;
        const explanation = `Signed Purchase Mandates are supported. An AP2 compatibility adapter is experimental. Razorpay standard interactive rails are supported for step-up checkout.`;

        return {
          sellerAgentId: this.sellerAgentId,
          merchantId: this.merchantId,
          intentProcessed: intent,
          dialogue,
          result: capabilities,
          policyExplanation: explanation
        };
      }

      case 'SEARCH_PRODUCTS': {
        const toolResult = await executeToolCall(
          'search_products',
          parameters,
          correlationId,
          principalContext
        );

        const itemsCount = toolResult.results?.length || toolResult.items?.length || 0;
        const dialogue = itemsCount > 0
          ? `Welcome! ${this.merchantName} catalog search for "${parameters.query}" returned ${itemsCount} verified item(s) within budget constraint.`
          : `No matching items found in ${this.merchantName} catalog for query "${parameters.query}".`;

        return {
          sellerAgentId: this.sellerAgentId,
          merchantId: this.merchantId,
          intentProcessed: intent,
          dialogue,
          result: toolResult
        };
      }

      case 'GET_PRODUCT_DETAIL': {
        const toolResult = await executeToolCall(
          'get_product_detail',
          parameters,
          correlationId,
          principalContext
        );

        return {
          sellerAgentId: this.sellerAgentId,
          merchantId: this.merchantId,
          intentProcessed: intent,
          dialogue: toolResult.ok
            ? `Specifications for SKU ${toolResult.variant?.sku} ("${toolResult.variant?.title}"): ₹${((toolResult.variant?.price_minor || 0) / 100).toFixed(2)}.`
            : `Product variant not found.`,
          result: toolResult
        };
      }

      case 'INITIALIZE_CART': {
        const toolResult = await executeToolCall(
          'create_cart',
          parameters,
          correlationId,
          principalContext
        );

        return {
          sellerAgentId: this.sellerAgentId,
          merchantId: this.merchantId,
          intentProcessed: intent,
          dialogue: `Initialized secure shopping cart ${toolResult.cartId} for buyer principal ${principalContext.principalName}.`,
          result: toolResult
        };
      }

      case 'NEGOTIATE_PRICE': {
        const toolResult = await executeToolCall(
          'request_negotiation',
          parameters,
          correlationId,
          principalContext
        );

        const offeredMinor = toolResult.offeredPriceMinor || parameters.proposed_price_minor || 0;
        const listMinor = toolResult.listPriceMinor || 0;
        const discountPct = listMinor > 0 ? Math.round(((listMinor - offeredMinor) / listMinor) * 100) : 5;

        let dialogue: string;
        let explanation: string;

        if (toolResult.status === 'ACCEPTED') {
          dialogue = `Negotiation Accepted: We have accepted your proposed price of ₹${(offeredMinor / 100).toFixed(2)} (${discountPct}% discount) within merchant margin policy.`;
          explanation = `Offer satisfies the merchant's private pricing and promotion policies. Internal margin thresholds are confidential.`;
        } else if (toolResult.status === 'COUNTER_OFFER' || toolResult.status === 'COUNTER_OFFERED') {
          dialogue = `Counter-Offer: Proposed price breaches policy thresholds. Merchant counter-offer is ₹${(offeredMinor / 100).toFixed(2)}.`;
          explanation = `Offer revised to satisfy internal pricing policies. Thresholds are confidential.`;
        } else {
          dialogue = `Negotiation Rejected: ${toolResult.message || 'Proposed price rejected by policy.'}`;
          explanation = `Proposal violates merchant purchase policy constraints.`;
        }

        return {
          sellerAgentId: this.sellerAgentId,
          merchantId: this.merchantId,
          intentProcessed: intent,
          dialogue,
          result: toolResult,
          policyExplanation: explanation
        };
      }

      case 'RESERVE_ITEM': {
        const toolResult = await executeToolCall(
          'add_to_cart',
          parameters,
          correlationId,
          principalContext
        );

        const dialogue = toolResult.ok
          ? `Stock Reserved: Atomically reserved ${parameters.quantity} unit(s) with 10-minute hold TTL. Cart updated.`
          : `Stock Reservation Failed: ${toolResult.message || 'Inventory unavailable or Sybil anti-hoarding limit reached.'}`;

        return {
          sellerAgentId: this.sellerAgentId,
          merchantId: this.merchantId,
          intentProcessed: intent,
          dialogue,
          result: toolResult
        };
      }

      case 'SUBMIT_CHECKOUT': {
        const toolResult = await executeToolCall(
          'start_checkout',
          parameters,
          correlationId,
          principalContext
        );

        let dialogue: string;
        let explanation: string;

        if (toolResult.executionMode === 'AUTO_EXECUTABLE') {
          dialogue = `Autonomous Checkout Confirmed: Order ${toolResult.orderId} successfully captured under a Signed Purchase Mandate.`;
          explanation = `Autonomous checkout authorized under a Signed Purchase Mandate (AP2-inspired authorization model). Intent quote hash matched. Ed25519 signature validated against registered buyer agent key. Merkle provenance receipt generated.`;
        } else if (toolResult.executionMode === 'REQUIRES_USER_ACTION') {
          dialogue = `Interactive Authentication Required: Razorpay order ${toolResult.razorpayOrderId} generated. Awaiting human OTP/UPI authorization.`;
          explanation = `Standard payment rail requires human step-up authentication at ${toolResult.checkoutSessionUrl}.`;
        } else {
          dialogue = `Checkout Rejected: ${toolResult.message || 'Policy evaluation denied checkout.'}`;
          explanation = `Policy engine decision: ${toolResult.executionMode}.`;
        }

        return {
          sellerAgentId: this.sellerAgentId,
          merchantId: this.merchantId,
          intentProcessed: intent,
          dialogue,
          result: toolResult,
          policyExplanation: explanation,
          provenanceProof: toolResult.provenanceReceipt ? {
            quoteHash: toolResult.provenanceReceipt.quoteHash,
            merkleRoot: toolResult.provenanceReceipt.auditRootHash,
            auditStatus: 'VERIFIED_HASH_CHAINED'
          } : undefined
        };
      }

      case 'CHECK_ORDER_STATUS': {
        const toolResult = await executeToolCall(
          'get_order_status',
          parameters,
          correlationId,
          principalContext
        );

        return {
          sellerAgentId: this.sellerAgentId,
          merchantId: this.merchantId,
          intentProcessed: intent,
          dialogue: `Order ${parameters.order_id} is in status "${toolResult.status}". Total: ₹${((toolResult.totalMinor || 0) / 100).toFixed(2)}.`,
          result: toolResult,
          provenanceProof: toolResult.provenanceReceipt ? {
            quoteHash: toolResult.provenanceReceipt.quoteHash,
            merkleRoot: toolResult.provenanceReceipt.auditRootHash,
            auditStatus: 'VERIFIED_HASH_CHAINED'
          } : undefined
        };
      }

      default: {
        return {
          sellerAgentId: this.sellerAgentId,
          merchantId: this.merchantId,
          intentProcessed: intent,
          dialogue: `Unknown intent "${intent}".`,
          result: { ok: false, error: 'UNKNOWN_INTENT' }
        };
      }
    }
  }
}

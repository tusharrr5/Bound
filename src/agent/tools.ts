import { searchCatalog, getProductDetail } from '../catalog/service.js';
import { createCart, addToCart, getCart } from '../cart/service.js';
import { negotiatePrice } from '../negotiation/engine.js';
import { startCheckout, getOrderStatus } from '../checkout/service.js';
import { PrincipalContext } from '../middleware/auth.js';
import { getMerchantCapabilities } from './capabilities.js';

export const agentToolDefinitions = [
  {
    name: 'discover_capabilities',
    description: 'Discover merchant commerce capabilities, payment rails (Razorpay vs Autonomous simulated), mandate types (signed mandates, AP2-inspired), and negotiation policies.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: []
    }
  },
  {
    name: 'search_products',
    description: 'Search merchant catalog with keywords, category, and maximum budget (in paise). Returns structured facts and constraint proofs.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Product search query, e.g. "coffee machine" or "basmati rice"' },
        category: { type: 'string', description: 'Optional category filter, e.g. "Appliances" or "Groceries"' },
        max_price_minor: { type: 'integer', description: 'Optional maximum price ceiling in paise (e.g. 500000 for ₹5,000)' },
        in_stock_only: { type: 'boolean', description: 'Filter only items with positive available stock' }
      },
      required: ['query']
    }
  },
  {
    name: 'get_product_detail',
    description: 'Retrieve detailed technical specifications, warranty, and real-time availability for a variant.',
    input_schema: {
      type: 'object' as const,
      properties: {
        variant_id: { type: 'string', description: 'UUID of the product variant' }
      },
      required: ['variant_id']
    }
  },
  {
    name: 'create_cart',
    description: 'Initialize a new stateful shopping cart for the authenticated shopping session.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: []
    }
  },
  {
    name: 'add_to_cart',
    description: 'Atomically reserve stock and add item to cart with a short-lived row-lock and 10-minute hold TTL.',
    input_schema: {
      type: 'object' as const,
      properties: {
        cart_id: { type: 'string', description: 'UUID of the active cart' },
        variant_id: { type: 'string', description: 'UUID of the variant' },
        quantity: { type: 'integer', description: 'Quantity to reserve and add', minimum: 1 }
      },
      required: ['cart_id', 'variant_id', 'quantity']
    }
  },
  {
    name: 'request_negotiation',
    description: 'Propose a discounted price for a product variant inside policy boundaries.',
    input_schema: {
      type: 'object' as const,
      properties: {
        variant_id: { type: 'string', description: 'UUID of the variant' },
        proposed_price_minor: { type: 'integer', description: 'Proposed purchase price in paise' }
      },
      required: ['variant_id', 'proposed_price_minor']
    }
  },
  {
    name: 'start_checkout',
    description: 'Initiate order checkout. Passes through deterministic Policy Engine for capability resolution.',
    input_schema: {
      type: 'object' as const,
      properties: {
        cart_id: { type: 'string', description: 'UUID of the cart to checkout' },
        mandate_token_id: { type: 'string', description: 'Optional active AP2-inspired purchase mandate token' },
        shipping_address: {
          type: 'object',
          description: 'Optional. Omit to use the principal\'s address on file.',
          properties: {
            line1: { type: 'string' },
            city: { type: 'string' },
            state: { type: 'string' },
            postal_code: { type: 'string' },
            country: { type: 'string' }
          }
        }
      },
      required: ['cart_id']
    }
  },
  {
    name: 'get_order_status',
    description: 'Fetch real-time order status, payment capture confirmation, and Merkle provenance receipt.',
    input_schema: {
      type: 'object' as const,
      properties: {
        order_id: { type: 'string', description: 'UUID of the order' }
      },
      required: ['order_id']
    }
  }
];

export const buyerAgentTools = agentToolDefinitions.map(t => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema
}));

/**
 * Server-side context for a run. Never filled from model output: the model cannot choose or
 * change the purchase task its cart is bound to.
 */
export interface ToolRunContext {
  purchaseTaskId?: string;
}

export async function executeToolCall(
  toolName: string,
  args: any,
  correlationId: string,
  principal?: PrincipalContext,
  context: ToolRunContext = {}
) {
  const agentId = principal?.agentId || args.buyer_agent_id || '22222222-2222-2222-2222-222222222222';
  const merchantId = principal?.merchantId || args.merchant_id;

  switch (toolName) {
    case 'discover_capabilities':
      return getMerchantCapabilities();

    case 'search_products':
      return searchCatalog({
        query: args.query,
        category: args.category,
        maxPriceMinor: args.max_price_minor,
        inStockOnly: args.in_stock_only,
        limit: 5
      });

    case 'get_product_detail':
      return getProductDetail(args.variant_id);

    case 'create_cart':
      return createCart(agentId, correlationId, merchantId, { purchaseTaskId: context.purchaseTaskId });

    case 'add_to_cart':
      return addToCart(args.cart_id, args.variant_id, args.quantity, correlationId);

    case 'request_negotiation':
      return negotiatePrice(agentId, args.variant_id, args.proposed_price_minor, correlationId);

    case 'start_checkout':
      return startCheckout(
        args.cart_id,
        args.shipping_address || {
          line1: '100 Silicon Valley, Indiranagar',
          city: 'Bengaluru',
          state: 'Karnataka',
          postal_code: '560038',
          country: 'IN'
        },
        correlationId,
        args.mandate_token_id
      );

    case 'get_order_status':
      return getOrderStatus(args.order_id);

    default:
      throw new Error(`Unknown buyer agent tool: ${toolName}`);
  }
}

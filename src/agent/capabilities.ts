export interface MerchantCapabilities {
  schema_version: string;
  server: string;
  environment: string;
  search: boolean;
  constraint_proofs: boolean;
  negotiation: boolean;
  payment_rails: {
    razorpay_standard: 'INTERACTIVE';
    simulated_rail: 'TEST_ONLY';
    supported_methods: string[];
  };
  mandates: {
    manifest_signed: 'SUPPORTED';
    ap2: 'EXPERIMENTAL';
    intent_binding: string[];
    supported_algorithms: string[];
  };
  audit: {
    canonicalization: 'RFC8785';
    hash_algorithm: 'SHA-256';
    kms_worm_storage: 'SIMULATED';
    tamper_detection: 'TRANSACTIONAL_OUTBOX';
  };
}

export function getMerchantCapabilities(): MerchantCapabilities {
  return {
    schema_version: '2.0',
    server: 'Bound Agentic Commerce Engine',
    environment: process.env.NODE_ENV || 'development',
    search: true,
    constraint_proofs: true,
    negotiation: true,
    payment_rails: {
      razorpay_standard: 'INTERACTIVE',
      simulated_rail: 'TEST_ONLY',
      supported_methods: ['UPI_INTENT', 'UPI_COLLECT', 'NETBANKING', 'CARD']
    },
    mandates: {
      manifest_signed: 'SUPPORTED',
      ap2: 'EXPERIMENTAL',
      intent_binding: ['cart_hash', 'quote_hash', 'amount_ceiling', 'agent_binding'],
      supported_algorithms: ['Ed25519', 'ES256']
    },
    audit: {
      canonicalization: 'RFC8785',
      hash_algorithm: 'SHA-256',
      kms_worm_storage: 'SIMULATED',
      tamper_detection: 'TRANSACTIONAL_OUTBOX'
    }
  };
}

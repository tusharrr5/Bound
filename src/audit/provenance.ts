import crypto from 'crypto';

export interface MerkleLeaf {
  key: string;
  hash: string;
  data: Record<string, any>;
}

export interface MerkleProofStep {
  siblingHash: string;
  position: 'left' | 'right';
}

export interface MerkleTreeResult {
  rootHash: string;
  leaves: MerkleLeaf[];
  treeLayers: string[][];
  inclusionProofs: Record<string, MerkleProofStep[]>;
}

export function hashLeafData(data: Record<string, any>): string {
  const canonicalStr = JSON.stringify(data, Object.keys(data).sort());
  return crypto.createHash('sha256').update(canonicalStr).digest('hex');
}

export function hashPair(left: string, right: string): string {
  return crypto.createHash('sha256').update(`${left}:${right}`).digest('hex');
}

export function buildMerkleTree(leafInputs: { key: string; data: Record<string, any> }[]): MerkleTreeResult {
  const leaves: MerkleLeaf[] = leafInputs.map(item => ({
    key: item.key,
    hash: hashLeafData(item.data),
    data: item.data
  }));

  const layers: string[][] = [leaves.map(l => l.hash)];
  let currentLayer = layers[0];

  while (currentLayer.length > 1) {
    const nextLayer: string[] = [];
    for (let i = 0; i < currentLayer.length; i += 2) {
      if (i + 1 < currentLayer.length) {
        nextLayer.push(hashPair(currentLayer[i], currentLayer[i + 1]));
      } else {
        // Odd node duplicated to balance the tree
        nextLayer.push(hashPair(currentLayer[i], currentLayer[i]));
      }
    }
    layers.push(nextLayer);
    currentLayer = nextLayer;
  }

  const rootHash = currentLayer[0] || '0000000000000000000000000000000000000000000000000000000000000000';

  // Generate inclusion proofs for each leaf
  const inclusionProofs: Record<string, MerkleProofStep[]> = {};

  leaves.forEach((leaf, leafIndex) => {
    const proof: MerkleProofStep[] = [];
    let idx = leafIndex;

    for (let layerIdx = 0; layerIdx < layers.length - 1; layerIdx++) {
      const layer = layers[layerIdx];
      const isRight = idx % 2 === 1;
      const siblingIdx = isRight ? idx - 1 : (idx + 1 < layer.length ? idx + 1 : idx);

      proof.push({
        siblingHash: layer[siblingIdx],
        position: isRight ? 'left' : 'right'
      });

      idx = Math.floor(idx / 2);
    }

    inclusionProofs[leaf.key] = proof;
  });

  return {
    rootHash,
    leaves,
    treeLayers: layers,
    inclusionProofs
  };
}

export function verifyMerkleInclusionProof(
  leafHash: string,
  proof: MerkleProofStep[],
  expectedRootHash: string
): boolean {
  let computedHash = leafHash;

  for (const step of proof) {
    if (step.position === 'left') {
      computedHash = hashPair(step.siblingHash, computedHash);
    } else {
      computedHash = hashPair(computedHash, step.siblingHash);
    }
  }

  return computedHash === expectedRootHash;
}

export interface ProvenanceReceiptContext {
  orderId: string;
  buyerAgentId: string;
  merchantId: string;
  items: Array<{ variantId: string; title: string; priceMinor: number; quantity: number }>;
  pricing: { grossAmountMinor: number; discountAmountMinor: number; netAmountMinor: number };
  policyDecision: { decision: string; policyRuleId?: string; reasonCode: string };
  mandateBinding?: { mandateTokenId: string; nonce: string; maxTotalAmountMinor: number };
  payment: { provider: string; paymentId: string; status: string };
  catalogVersion?: string;
  policyVersion?: number;
}

export function generateMerkleProvenanceReceipt(ctx: ProvenanceReceiptContext) {
  const leafInputs = [
    {
      key: 'product_snapshot',
      data: {
        orderId: ctx.orderId,
        merchantId: ctx.merchantId,
        items: ctx.items
      }
    },
    {
      key: 'price_snapshot',
      data: {
        grossAmountMinor: ctx.pricing.grossAmountMinor,
        discountAmountMinor: ctx.pricing.discountAmountMinor,
        netAmountMinor: ctx.pricing.netAmountMinor
      }
    },
    {
      key: 'policy_decision',
      data: {
        decision: ctx.policyDecision.decision,
        policyRuleId: ctx.policyDecision.policyRuleId || 'NONE',
        reasonCode: ctx.policyDecision.reasonCode
      }
    },
    {
      key: 'mandate_binding',
      data: ctx.mandateBinding || { status: 'NO_MANDATE_INTERACTIVE' }
    },
    {
      key: 'payment_reference',
      data: {
        provider: ctx.payment.provider,
        paymentId: ctx.payment.paymentId,
        status: ctx.payment.status
      }
    }
  ];

  const merkle = buildMerkleTree(leafInputs);

  return {
    receiptVersion: '2.0',
    orderId: ctx.orderId,
    auditRootHash: merkle.rootHash,
    merkleTree: merkle,
    mandateTokenId: ctx.mandateBinding?.mandateTokenId || null,
    quoteHash: hashLeafData(ctx.pricing),
    catalogVersion: ctx.catalogVersion || 'v1',
    policyVersion: ctx.policyVersion || 1,
    sellerModelId: 'manifest-core-v2',
    timestamp: new Date().toISOString()
  };
}

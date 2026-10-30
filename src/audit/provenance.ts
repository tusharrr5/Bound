import crypto from 'crypto';
import { domainHash } from '../crypto/canonical.js';

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

/**
 * Leaf hash: SHA-256 over a leaf domain tag and the canonical JSON of the leaf's key and full data,
 * nested objects and arrays included. (The previous version passed a top-level key list to
 * JSON.stringify as a replacer, which silently dropped every nested field.)
 */
export function hashLeafData(data: Record<string, any>, key = ''): string {
  return domainHash('bound.merkle.leaf.v1', { key, data });
}

/** Internal node hash, domain-separated from leaves so a leaf can never pose as a node. */
export function hashPair(left: string, right: string): string {
  return crypto.createHash('sha256').update(`bound.merkle.node.v1\u0000${left}${right}`).digest('hex');
}

const EMPTY_ROOT = domainHash('bound.merkle.empty.v1', null);

/**
 * Builds a Merkle tree. On a level with an odd count the last node is promoted unchanged rather
 * than paired with itself, so trees [a,b,c] and [a,b,c,c] cannot share a root. Leaf keys must
 * be unique: the key is part of the leaf hash and identifies its proof.
 */
export function buildMerkleTree(leafInputs: { key: string; data: Record<string, any> }[]): MerkleTreeResult {
  const keys = new Set<string>();
  for (const { key } of leafInputs) {
    if (keys.has(key)) throw new Error(`Duplicate Merkle leaf key: ${key}`);
    keys.add(key);
  }
  const leaves: MerkleLeaf[] = leafInputs.map(item => ({
    key: item.key,
    hash: hashLeafData(item.data, item.key),
    data: item.data
  }));

  const layers: string[][] = [leaves.map(l => l.hash)];
  let currentLayer = layers[0];

  while (currentLayer.length > 1) {
    const nextLayer: string[] = [];
    for (let i = 0; i < currentLayer.length; i += 2) {
      nextLayer.push(i + 1 < currentLayer.length ? hashPair(currentLayer[i], currentLayer[i + 1]) : currentLayer[i]);
    }
    layers.push(nextLayer);
    currentLayer = nextLayer;
  }

  const rootHash = currentLayer[0] || EMPTY_ROOT;

  // Inclusion proofs: one step per level where the node had a sibling
  const inclusionProofs: Record<string, MerkleProofStep[]> = {};
  leaves.forEach((leaf, leafIndex) => {
    const proof: MerkleProofStep[] = [];
    let idx = leafIndex;
    for (let layerIdx = 0; layerIdx < layers.length - 1; layerIdx++) {
      const layer = layers[layerIdx];
      const isRight = idx % 2 === 1;
      const siblingIdx = isRight ? idx - 1 : idx + 1;
      if (siblingIdx < layer.length) {
        proof.push({ siblingHash: layer[siblingIdx], position: isRight ? 'left' : 'right' });
      }
      idx = Math.floor(idx / 2);
    }
    inclusionProofs[leaf.key] = proof;
  });

  return { rootHash, leaves, treeLayers: layers, inclusionProofs };
}

export function verifyMerkleInclusionProof(
  leafHash: string,
  proof: MerkleProofStep[],
  expectedRootHash: string
): boolean {
  let computedHash = leafHash;
  for (const step of proof) {
    computedHash = step.position === 'left' ? hashPair(step.siblingHash, computedHash) : hashPair(computedHash, step.siblingHash);
  }
  return computedHash === expectedRootHash;
}

/** Recomputes a leaf from its data and checks it is included under the root. */
export function verifyLeafInclusion(key: string, data: Record<string, any>, proof: MerkleProofStep[], expectedRootHash: string): boolean {
  return verifyMerkleInclusionProof(hashLeafData(data, key), proof, expectedRootHash);
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
        buyerAgentId: ctx.buyerAgentId,
        currency: 'INR',
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
    receiptVersion: '3.0',
    orderId: ctx.orderId,
    auditRootHash: merkle.rootHash,
    merkleTree: merkle,
    mandateTokenId: ctx.mandateBinding?.mandateTokenId || null,
    quoteHash: hashLeafData(ctx.pricing, 'quote'),
    catalogVersion: ctx.catalogVersion || 'v1',
    policyVersion: ctx.policyVersion || 1,
    sellerModelId: 'manifest-core-v2',
    timestamp: new Date().toISOString()
  };
}

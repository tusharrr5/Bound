/**
 * Purchase-intent taxonomy. Maps what a human can ask for to the merchant-verified product types
 * that satisfy it. Authorization reads only this table and `products.product_type` /
 * `products.verified_attributes`; seller-written titles and descriptions are never consulted.
 *
 * Extend by adding an intent here and tagging products with the matching product_type.
 */

export interface IntentDefinition {
  label: string;
  /** Merchant-verified product types that satisfy the intent. */
  productTypes: string[];
  /** Lower-case phrases that identify this intent in a request, matched on word boundaries. */
  phrases: string[];
}

export const INTENTS: Record<string, IntentDefinition> = {
  keep_beverage_hot: {
    label: 'Keep a drink hot',
    productTypes: ['vacuum_flask', 'insulated_mug', 'mug_warmer'],
    phrases: [
      'keep my chai hot', 'keep chai hot', 'keep my tea hot', 'keep tea hot', 'keep my coffee hot', 'keep coffee hot',
      'keep my drink hot', 'keep drinks hot', 'chai warmer', 'tea warmer', 'mug warmer', 'cup warmer', 'flask',
      'vacuum flask', 'thermos', 'insulated mug', 'travel mug'
    ]
  },
  brew_espresso: {
    label: 'Make espresso or coffee at home',
    productTypes: ['espresso_machine'],
    phrases: ['espresso machine', 'espresso maker', 'coffee machine', 'coffee maker']
  },
  buy_coffee_beans: {
    label: 'Coffee beans',
    productTypes: ['coffee_beans'],
    phrases: ['coffee beans', 'ground coffee', 'coffee roast', 'whole bean']
  },
  buy_tea: { label: 'Tea', productTypes: ['tea_leaves'], phrases: ['green tea', 'darjeeling', 'tea leaves', 'loose leaf tea'] },
  buy_rice: { label: 'Rice', productTypes: ['rice'], phrases: ['rice', 'basmati'] },
  buy_cooking_oil: { label: 'Cooking oil', productTypes: ['cooking_oil'], phrases: ['olive oil', 'cooking oil'] },
  buy_headphones: { label: 'Headphones', productTypes: ['headphones'], phrases: ['headphones', 'earbuds', 'headset'] },
  buy_charger: { label: 'Phone or laptop charger', productTypes: ['phone_charger'], phrases: ['charger', 'gan charger'] },
  buy_fitness_band: { label: 'Fitness band', productTypes: ['fitness_band'], phrases: ['fitness band', 'fitness tracker', 'smart band'] },
  buy_air_fryer: { label: 'Air fryer', productTypes: ['air_fryer'], phrases: ['air fryer'] },
  buy_robot_vacuum: { label: 'Robot vacuum', productTypes: ['robot_vacuum'], phrases: ['robot vacuum', 'robot cleaner'] },
  buy_keyboard: { label: 'Keyboard', productTypes: ['keyboard'], phrases: ['keyboard', 'mechanical keyboard'] },
  buy_honey: { label: 'Honey', productTypes: ['honey'], phrases: ['honey'] }
};

/** Constraint phrases that become verified-attribute requirements. */
export const ATTRIBUTE_PHRASES: Array<{ pattern: RegExp; attribute: string; value: boolean }> = [
  {
    pattern: /\b(no plastic|avoid plastic|without plastic|plastic[- ]free|(don'?t|do not) (like|want) plastic|hate plastic)\b/,
    attribute: 'plastic_contact',
    value: false
  }
];

export const DEFAULT_MAX_QUANTITY_PER_ITEM = 2;
export const DEFAULT_MAX_TOTAL_QUANTITY = 3;

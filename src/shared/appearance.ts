export interface Appearance {
  shape: 'pebble' | 'mochi' | 'puff';
  palette: 'lavender' | 'peach' | 'mint' | 'sky';
  head: 'none' | 'sprout' | 'cat-ears' | 'bunny-ears' | 'horns';
  eyewear: 'none' | 'glasses' | 'round-glasses' | 'sunglasses' | 'monocle';
  eyes: 'bright' | 'sleepy' | 'round' | 'sparkle' | 'happy';
  eyeColor: 'dark' | 'accent' | 'blue' | 'green' | 'warm';
  face: 'blush' | 'none' | 'freckles' | 'stars' | 'hearts';
  mouth: 'smile' | 'tiny' | 'cat' | 'grin';
  outfit: 'none' | 'work' | 'cozy' | 'fitness' | 'rainy-day' | 'explorer' | 'wizard' | 'artist' | 'formal';
  motion: 'still' | 'subtle' | 'expressive';
}

export const INITIAL_APPEARANCE: Appearance = {
  shape: 'pebble', palette: 'lavender', head: 'none', eyewear: 'none', eyes: 'bright', eyeColor: 'dark',
  face: 'blush', mouth: 'smile', outfit: 'none', motion: 'subtle',
};

const choices: { [K in keyof Appearance]: readonly Appearance[K][] } = {
  shape: ['pebble', 'mochi', 'puff'], palette: ['lavender', 'peach', 'mint', 'sky'],
  head: ['none', 'sprout', 'cat-ears', 'bunny-ears', 'horns'],
  eyewear: ['none', 'glasses', 'round-glasses', 'sunglasses', 'monocle'],
  eyes: ['bright', 'sleepy', 'round', 'sparkle', 'happy'], eyeColor: ['dark', 'accent', 'blue', 'green', 'warm'],
  face: ['blush', 'none', 'freckles', 'stars', 'hearts'], mouth: ['smile', 'tiny', 'cat', 'grin'],
  outfit: ['none', 'work', 'cozy', 'fitness', 'rainy-day', 'explorer', 'wizard', 'artist', 'formal'],
  motion: ['still', 'subtle', 'expressive'],
};

type OriginalOutfit = 'none' | 'suit' | 'fitness' | 'sweater';
interface OriginalAppearance {
  shape: Appearance['shape']; palette: Appearance['palette']; accessory: 'none' | 'glasses' | 'scarf' | 'sprout';
  outfit: OriginalOutfit; face: 'bright' | 'sleepy'; motion: Appearance['motion'];
}
interface ExpandedAppearance {
  shape: Appearance['shape']; palette: Appearance['palette']; head: Appearance['head']; eyewear: Appearance['eyewear'];
  eyes: Appearance['eyes']; eyeColor: Appearance['eyeColor']; face: Appearance['face']; mouth: Appearance['mouth'];
  neckwear: 'none' | 'scarf' | 'bow' | 'collar'; outfit: OriginalOutfit; motion: Appearance['motion'];
}
interface LayeredAppearance extends Omit<Appearance, 'outfit'> {
  top: 'none' | 't-shirt' | 'hoodie' | 'cardigan' | 'turtleneck' | 'vest' | 'lab-coat' | 'overalls';
  outerwear: 'none' | 'blazer' | 'raincoat' | 'cape' | 'puffer' | 'apron';
  headwear: 'none' | 'beanie' | 'baseball-cap' | 'bucket-hat' | 'cowboy-hat' | 'crown' | 'wizard-hat' | 'party-hat' | 'headphones';
  neckwear: 'none' | 'scarf' | 'bow' | 'collar' | 'tie' | 'bandana' | 'necklace' | 'lanyard';
  clothingColor: 'automatic' | 'neutral' | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'black' | 'white';
  clothingPattern: 'solid' | 'stripes' | 'dots' | 'stars' | 'hearts' | 'plaid';
  clothingDetail: 'none' | 'badge' | 'pocket' | 'flower-pin' | 'pride-pin' | 'pencil' | 'suspenders';
  heldItem: 'none' | 'mug' | 'book' | 'laptop' | 'pencil' | 'paintbrush' | 'wrench' | 'wand' | 'flower';
}

const originalChoices = {
  shape: choices.shape, palette: choices.palette, accessory: ['none', 'glasses', 'scarf', 'sprout'] as const,
  outfit: ['none', 'suit', 'fitness', 'sweater'] as const, face: ['bright', 'sleepy'] as const, motion: choices.motion,
} satisfies { [K in keyof OriginalAppearance]: readonly OriginalAppearance[K][] };
const expandedChoices = {
  shape: choices.shape, palette: choices.palette, head: choices.head, eyewear: choices.eyewear, eyes: choices.eyes,
  eyeColor: choices.eyeColor, face: choices.face, mouth: choices.mouth, neckwear: ['none', 'scarf', 'bow', 'collar'] as const,
  outfit: ['none', 'suit', 'fitness', 'sweater'] as const, motion: choices.motion,
} satisfies { [K in keyof ExpandedAppearance]: readonly ExpandedAppearance[K][] };
const layeredChoices = {
  shape: choices.shape, palette: choices.palette, head: choices.head, eyewear: choices.eyewear, eyes: choices.eyes,
  eyeColor: choices.eyeColor, face: choices.face, mouth: choices.mouth,
  top: ['none', 't-shirt', 'hoodie', 'cardigan', 'turtleneck', 'vest', 'lab-coat', 'overalls'] as const,
  outerwear: ['none', 'blazer', 'raincoat', 'cape', 'puffer', 'apron'] as const,
  headwear: ['none', 'beanie', 'baseball-cap', 'bucket-hat', 'cowboy-hat', 'crown', 'wizard-hat', 'party-hat', 'headphones'] as const,
  neckwear: ['none', 'scarf', 'bow', 'collar', 'tie', 'bandana', 'necklace', 'lanyard'] as const,
  clothingColor: ['automatic', 'neutral', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'black', 'white'] as const,
  clothingPattern: ['solid', 'stripes', 'dots', 'stars', 'hearts', 'plaid'] as const,
  clothingDetail: ['none', 'badge', 'pocket', 'flower-pin', 'pride-pin', 'pencil', 'suspenders'] as const,
  heldItem: ['none', 'mug', 'book', 'laptop', 'pencil', 'paintbrush', 'wrench', 'wand', 'flower'] as const,
  motion: choices.motion,
} satisfies { [K in keyof LayeredAppearance]: readonly LayeredAppearance[K][] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function validateEnums<T extends object>(record: Record<string, unknown>, allowed: { [K in keyof T]: readonly T[K][] }): T {
  if (Object.keys(record).some((key) => !Object.hasOwn(allowed, key))) throw new Error('Unknown avatar setting.');
  const result: Partial<T> = {};
  for (const key of Object.keys(allowed) as (keyof T)[]) {
    const value = record[key as string];
    if (typeof value !== 'string' || !(allowed[key] as readonly unknown[]).includes(value)) throw new Error(`Invalid avatar ${String(key)}.`);
    Object.assign(result, { [key]: value });
  }
  return result as T;
}
function oldOutfit(outfit: OriginalOutfit): Appearance['outfit'] {
  return { none: 'none', suit: 'work', fitness: 'fitness', sweater: 'cozy' }[outfit] as Appearance['outfit'];
}
function upgradeOriginal(value: OriginalAppearance): Appearance {
  return {
    ...INITIAL_APPEARANCE, shape: value.shape, palette: value.palette, eyes: value.face, outfit: oldOutfit(value.outfit), motion: value.motion,
    head: value.accessory === 'sprout' ? 'sprout' : 'none', eyewear: value.accessory === 'glasses' ? 'glasses' : 'none',
  };
}
function upgradeExpanded(value: ExpandedAppearance): Appearance {
  const { neckwear, outfit, ...appearance } = value;
  const neckwearOutfit = neckwear === 'scarf' ? 'cozy' : neckwear === 'bow' || neckwear === 'collar' ? 'formal' : oldOutfit(outfit);
  return { ...INITIAL_APPEARANCE, ...appearance, outfit: neckwearOutfit };
}
function layeredOutfit(value: LayeredAppearance): Appearance['outfit'] {
  if (value.headwear === 'wizard-hat' || value.heldItem === 'wand' || value.outerwear === 'cape') return 'wizard';
  if (value.top === 'lab-coat' || value.outerwear === 'blazer') return 'work';
  if (value.outerwear === 'raincoat' || value.outerwear === 'puffer') return 'rainy-day';
  if (value.outerwear === 'apron' || value.heldItem === 'paintbrush') return 'artist';
  if (value.top === 'overalls' || value.headwear === 'cowboy-hat' || value.heldItem === 'book') return 'explorer';
  if (value.headwear === 'headphones' || value.top === 't-shirt') return 'fitness';
  if (value.neckwear === 'tie' || value.neckwear === 'bow' || value.headwear === 'crown') return 'formal';
  if (value.top !== 'none' || value.neckwear === 'scarf') return 'cozy';
  return 'none';
}
function upgradeLayered(value: LayeredAppearance): Appearance {
  const { top: _top, outerwear: _outerwear, headwear: _headwear, neckwear: _neckwear, clothingColor: _clothingColor,
    clothingPattern: _clothingPattern, clothingDetail: _clothingDetail, heldItem: _heldItem, ...appearance } = value;
  return { ...appearance, outfit: layeredOutfit(value) };
}

export function validateAppearance(value: unknown): Appearance {
  if (!isRecord(value)) throw new Error('Invalid avatar settings.');
  if (Object.hasOwn(value, 'accessory')) return upgradeOriginal(validateEnums<OriginalAppearance>(value, originalChoices));
  if (Object.hasOwn(value, 'top')) return upgradeLayered(validateEnums<LayeredAppearance>(value, layeredChoices));
  if (Object.hasOwn(value, 'neckwear')) return upgradeExpanded(validateEnums<ExpandedAppearance>(value, expandedChoices));
  return validateEnums<Appearance>(value, choices);
}

// Legacy NULL rows get defaults. Invalid stored values are not silently replaced.
export function storedAppearance(value: string | null): Appearance {
  return value === null ? { ...INITIAL_APPEARANCE } : validateAppearance(JSON.parse(value));
}

export interface Appearance {
  shape: 'pebble' | 'mochi' | 'puff';
  palette: 'lavender' | 'peach' | 'mint' | 'sky';
  accessory: 'none' | 'glasses' | 'scarf' | 'sprout';
  outfit: 'none' | 'suit' | 'fitness' | 'sweater';
  face: 'bright' | 'sleepy';
  motion: 'still' | 'subtle' | 'expressive';
}
export const INITIAL_APPEARANCE: Appearance = { shape: 'pebble', palette: 'lavender', accessory: 'none', outfit: 'none', face: 'bright', motion: 'subtle' };
const choices: Record<keyof Appearance, readonly string[]> = {
  shape: ['pebble', 'mochi', 'puff'], palette: ['lavender', 'peach', 'mint', 'sky'],
  accessory: ['none', 'glasses', 'scarf', 'sprout'], outfit: ['none', 'suit', 'fitness', 'sweater'],
  face: ['bright', 'sleepy'], motion: ['still', 'subtle', 'expressive'],
};
export function validateAppearance(value: unknown): Appearance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid avatar settings.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !Object.hasOwn(choices, key))) throw new Error('Unknown avatar setting.');
  const result = { ...INITIAL_APPEARANCE };
  for (const key of Object.keys(choices) as (keyof Appearance)[]) {
    if (typeof record[key] !== 'string' || !choices[key].includes(record[key] as string)) throw new Error(`Invalid avatar ${key}.`);
    Object.assign(result, { [key]: record[key] });
  }
  return result;
}
// Legacy NULL rows get defaults. Invalid stored values are not silently replaced.
export function storedAppearance(value: string | null): Appearance {
  return value === null ? { ...INITIAL_APPEARANCE } : validateAppearance(JSON.parse(value));
}

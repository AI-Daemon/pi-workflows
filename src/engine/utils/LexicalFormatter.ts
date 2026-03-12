/**
 * Smart Lexical Formatter — converts node IDs and tool names into
 * human-readable present-participle action phrases.
 *
 * Part of the Zero-Config Dynamic UX architecture (PRD v2.2).
 *
 * @example
 * ```ts
 * LexicalFormatter.toActionPhrase('gather_requirements'); // "Gathering requirements"
 * LexicalFormatter.toActionPhrase('run-security-scan');   // "Running security scan"
 * LexicalFormatter.toActionPhrase('bash');                // "Executing command"
 * ```
 *
 * @module
 */

/**
 * Dictionary of irregular verbs / non-standard tool names that cannot
 * be converted via standard gerund rules.
 *
 * Keys are **lowercase**. Lookup is always case-insensitive on the
 * first word of the input.
 *
 * This dictionary is intentionally **not frozen** so consumers can
 * extend it at runtime.
 */
export const IRREGULAR_VERBS: Record<string, string> = {
  bash: 'Executing command',
  gh: 'Accessing GitHub',
};

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Set of common single-syllable verbs (CVC pattern) whose final
 * consonant must be doubled before adding "-ing".
 *
 * We intentionally keep this small and targeted at verbs likely to
 * appear as workflow node IDs / tool names.
 */
const DOUBLE_CONSONANT_VERBS = new Set([
  'ban',
  'bar',
  'bat',
  'bed',
  'beg',
  'bet',
  'bid',
  'bin',
  'bit',
  'bob',
  'bop',
  'bud',
  'bug',
  'bum',
  'bun',
  'bus',
  'but',
  'cab',
  'cap',
  'chat',
  'chip',
  'chop',
  'clap',
  'clip',
  'clog',
  'cop',
  'crop',
  'cup',
  'cut',
  'dab',
  'dam',
  'dig',
  'dim',
  'dip',
  'dot',
  'drag',
  'drip',
  'drop',
  'drum',
  'dub',
  'dug',
  'dump',
  'fan',
  'fit',
  'flag',
  'flap',
  'flip',
  'flop',
  'fog',
  'fun',
  'gab',
  'gag',
  'gap',
  'get',
  'grab',
  'grin',
  'grip',
  'gun',
  'gut',
  'hem',
  'hit',
  'hop',
  'hot',
  'hug',
  'hum',
  'jam',
  'jog',
  'jot',
  'kid',
  'kit',
  'knit',
  'knob',
  'lap',
  'let',
  'lid',
  'log',
  'lop',
  'lot',
  'map',
  'mat',
  'mob',
  'mop',
  'mud',
  'mug',
  'nab',
  'nag',
  'nap',
  'net',
  'nod',
  'nub',
  'nut',
  'pad',
  'pan',
  'pat',
  'peg',
  'pen',
  'pet',
  'pig',
  'pin',
  'pit',
  'plan',
  'plod',
  'plot',
  'plug',
  'plop',
  'plop',
  'pop',
  'pot',
  'prod',
  'prop',
  'pub',
  'pug',
  'pun',
  'put',
  'quiz',
  'rag',
  'ram',
  'ran',
  'rap',
  'rat',
  'red',
  'ref',
  'rig',
  'rim',
  'rip',
  'rob',
  'rot',
  'rub',
  'rug',
  'run',
  'rut',
  'sag',
  'sap',
  'sat',
  'scan',
  'set',
  'ship',
  'shop',
  'shut',
  'sin',
  'sip',
  'sit',
  'skip',
  'slam',
  'slap',
  'slim',
  'slip',
  'slit',
  'slob',
  'slog',
  'slop',
  'slot',
  'slug',
  'snap',
  'snip',
  'snub',
  'sob',
  'sop',
  'span',
  'spin',
  'spit',
  'spot',
  'star',
  'step',
  'stir',
  'stop',
  'strap',
  'strip',
  'strop',
  'strum',
  'stun',
  'sub',
  'sum',
  'sun',
  'sup',
  'swap',
  'swim',
  'tab',
  'tag',
  'tan',
  'tap',
  'thin',
  'tip',
  'top',
  'tot',
  'trap',
  'trek',
  'trim',
  'trip',
  'trot',
  'tub',
  'tug',
  'vat',
  'vet',
  'wag',
  'web',
  'wed',
  'wet',
  'whip',
  'win',
  'wit',
  'wrap',
  'zap',
  'zip',
]);

/**
 * Convert a bare verb to its present-participle (gerund) form.
 *
 * Handles:
 * - Silent-e dropping: "analyze" → "analyzing"
 * - Consonant doubling: "run" → "running"
 * - -ie → -ying: "die" → "dying"
 * - -ee / -ye / -oe endings (no drop): "see" → "seeing"
 * - Already ends in "-ing": returned as-is
 *
 * @param verb - A lowercase English verb.
 * @returns The gerund form (lowercase).
 */
function toGerund(verb: string): string {
  if (verb.length === 0) return verb;

  // Already a gerund
  if (verb.endsWith('ing') && verb.length > 4) {
    return verb;
  }

  // -ie → -ying  (die → dying, lie → lying, tie → tying)
  if (verb.endsWith('ie')) {
    return verb.slice(0, -2) + 'ying';
  }

  // -ee, -ye, -oe: just add -ing (see → seeing, dye → dyeing, hoe → hoeing)
  if (verb.endsWith('ee') || verb.endsWith('ye') || verb.endsWith('oe')) {
    return verb + 'ing';
  }

  // Silent-e: drop the final 'e' and add -ing (make → making, analyze → analyzing)
  if (verb.endsWith('e') && verb.length >= 2) {
    return verb.slice(0, -1) + 'ing';
  }

  // Consonant doubling for CVC words
  if (DOUBLE_CONSONANT_VERBS.has(verb)) {
    return verb + verb[verb.length - 1] + 'ing';
  }

  // Default: just add -ing (build → building, push → pushing)
  return verb + 'ing';
}

/**
 * Split a string on `_` and `-` delimiters, filtering out empty segments
 * produced by leading, trailing, or consecutive delimiters.
 */
function splitWords(input: string): string[] {
  return input.split(/[_-]/).filter((w) => w.length > 0);
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Converts snake_case / kebab-case node IDs and tool names into
 * human-readable present-participle action phrases.
 *
 * @example
 * ```ts
 * LexicalFormatter.toActionPhrase('gather_requirements');
 * // → "Gathering requirements"
 *
 * LexicalFormatter.toActionPhrase('bash');
 * // → "Executing command"
 * ```
 */
export class LexicalFormatter {
  /**
   * Reference to the irregular-verb dictionary so consumers can extend
   * it without a separate import.
   */
  static readonly IRREGULAR_VERBS = IRREGULAR_VERBS;

  /**
   * Convert a node ID or tool name into a present-participle action phrase.
   *
   * @param input - A snake_case or kebab-case identifier
   *                (e.g. `"gather_requirements"`, `"run-security-scan"`).
   * @returns A human-readable phrase starting with a capitalized gerund
   *          (e.g. `"Gathering requirements"`). Returns `""` for empty input.
   */
  static toActionPhrase(input: string): string {
    if (input.length === 0) return '';

    const words = splitWords(input);
    if (words.length === 0) return '';

    const firstWord = words[0]!.toLowerCase();

    // Check irregular verb dictionary (case-insensitive on first word)
    const irregular = IRREGULAR_VERBS[firstWord];
    if (irregular !== undefined) {
      // If there are additional words beyond the irregular match, append them
      if (words.length > 1) {
        const rest = words
          .slice(1)
          .map((w) => w.toLowerCase())
          .join(' ');
        return irregular + ' ' + rest;
      }
      return irregular;
    }

    // Standard gerund conversion
    const gerund = toGerund(firstWord);
    const capitalized = gerund.charAt(0).toUpperCase() + gerund.slice(1);

    if (words.length === 1) {
      return capitalized;
    }

    const rest = words
      .slice(1)
      .map((w) => w.toLowerCase())
      .join(' ');
    return capitalized + ' ' + rest;
  }
}

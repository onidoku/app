/**
 * A small schema validator for the few shapes onidoku checks (site configs, backups, servers), in the
 * style of zod but a fraction of its size. Schemas infer their TypeScript types (Infer<typeof S>),
 * report every problem with its path (`series.chapters: Unrecognized key(s) in object: 'nxt'`),
 * and never run anything from the input.
 */

export type Path = (string | number)[];

export interface Issue {
  path: Path;
  message: string;
}

export type ParseResult<T> = { success: true; data: T } | { success: false; error: { issues: Issue[] } };

/** Thrown by Schema.parse. */
export class ValidationError extends Error {
  override name = 'ValidationError';
  constructor(readonly issues: Issue[]) {
    super(issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
  }
}

/** Lets custom checks add issues anywhere in the object being checked. */
export interface RefineContext {
  addIssue(issue: { message: string; path?: Path }): void;
}

const FAIL = Symbol('invalid');
type Out<T> = T | typeof FAIL;

/** The JSON type a schema wants, so unions can explain the branch that matches the input's type. */
type Kind = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'any';

export class Schema<T> {
  constructor(
    /** Validates `value`, pushing issues; returns the (possibly transformed) value or FAIL. */
    readonly run: (value: unknown, path: Path, issues: Issue[]) => Out<T>,
    readonly kind: Kind = 'any',
    /** Allowed to be absent from an object. */
    readonly isOptional = false,
  ) {}

  safeParse(value: unknown): ParseResult<T> {
    const issues: Issue[] = [];
    const data = this.run(value, [], issues);
    return data === FAIL || issues.length ? { success: false, error: { issues } } : { success: true, data };
  }

  parse(value: unknown): T {
    const result = this.safeParse(value);
    if (!result.success) throw new ValidationError(result.error.issues);
    return result.data;
  }

  optional(): Schema<T | undefined> {
    return new Schema<T | undefined>((v, path, issues) => (v === undefined ? undefined : this.run(v, path, issues)), this.kind, true);
  }

  /** Fills in `value` when absent; the key is then optional in the input but always set in the output. */
  default(value: T): Schema<T> {
    return new Schema<T>((v, path, issues) => (v === undefined ? value : this.run(v, path, issues)), this.kind, true);
  }

  transform<U>(fn: (value: T) => U): Schema<U> {
    return new Schema<U>((v, path, issues) => {
      const out = this.run(v, path, issues);
      return out === FAIL ? FAIL : fn(out);
    }, this.kind, this.isOptional);
  }

  /** A custom check; runs only once the value has the right shape. */
  refine(test: (value: T) => boolean, message: string | { message: string; path?: Path }): Schema<T> {
    const { message: text, path: at = [] } = typeof message === 'string' ? { message } : message;
    return this.superRefine((value, ctx) => {
      if (!test(value)) ctx.addIssue({ message: text, path: at });
    });
  }

  superRefine(check: (value: T, ctx: RefineContext) => void): Schema<T> {
    return new Schema<T>((v, path, issues) => {
      const before = issues.length;
      const out = this.run(v, path, issues);
      if (out === FAIL || issues.length > before) return out;
      check(out, { addIssue: (issue) => issues.push({ path: [...path, ...(issue.path ?? [])], message: issue.message }) });
      return issues.length > before ? FAIL : out;
    }, this.kind, this.isOptional);
  }
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function typed<T>(kind: Exclude<Kind, 'any'>, check: (value: T, path: Path, issues: Issue[]) => Out<T>): Schema<T> {
  return new Schema<T>((v, path, issues) => {
    if (v === undefined) return issues.push({ path, message: 'required' }), FAIL;
    if (typeOf(v) !== kind) return issues.push({ path, message: `expected ${kind}, received ${typeOf(v)}` }), FAIL;
    return check(v as T, path, issues);
  }, kind);
}

// ---- Strings and numbers -----------------------------------------------------------------

type StringRule = (value: string) => string | undefined;

export class StringSchema extends Schema<string> {
  constructor(private readonly rules: StringRule[] = [], private readonly trimmed = false) {
    super((v, path, issues) => {
      if (v === undefined) return issues.push({ path, message: 'required' }), FAIL;
      if (typeof v !== 'string') return issues.push({ path, message: `expected string, received ${typeOf(v)}` }), FAIL;
      const value = this.trimmed ? v.trim() : v;
      const failed = this.rules.map((rule) => rule(value)).filter((m): m is string => Boolean(m));
      for (const message of failed) issues.push({ path, message });
      return failed.length ? FAIL : value;
    }, 'string');
  }

  private with(rule: StringRule): StringSchema {
    return new StringSchema([...this.rules, rule], this.trimmed);
  }

  trim(): StringSchema {
    return new StringSchema(this.rules, true);
  }

  min(length: number, message?: string): StringSchema {
    return this.with((v) => (v.length < length ? message ?? `string must contain at least ${length} character(s)` : undefined));
  }

  max(length: number, message?: string): StringSchema {
    return this.with((v) => (v.length > length ? message ?? `string must contain at most ${length} character(s)` : undefined));
  }

  regex(pattern: RegExp, message = 'invalid'): StringSchema {
    return this.with((v) => (pattern.test(v) ? undefined : message));
  }

  includes(text: string, options?: { message?: string }): StringSchema {
    return this.with((v) => (v.includes(text) ? undefined : options?.message ?? `invalid input: must include "${text}"`));
  }

  url(message = 'invalid url'): StringSchema {
    return this.with((v) => {
      try {
        new URL(v);
        return undefined;
      } catch {
        return message;
      }
    });
  }
}

export class NumberSchema extends Schema<number> {
  constructor(private readonly rules: ((value: number) => string | undefined)[] = []) {
    super((v, path, issues) => {
      if (v === undefined) return issues.push({ path, message: 'required' }), FAIL;
      if (typeof v !== 'number' || Number.isNaN(v)) return issues.push({ path, message: `expected number, received ${typeOf(v)}` }), FAIL;
      const failed = this.rules.map((rule) => rule(v)).filter((m): m is string => Boolean(m));
      for (const message of failed) issues.push({ path, message });
      return failed.length ? FAIL : v;
    }, 'number');
  }

  int(): NumberSchema {
    return new NumberSchema([...this.rules, (v) => (Number.isInteger(v) ? undefined : 'expected integer, received float')]);
  }

  min(value: number): NumberSchema {
    return new NumberSchema([...this.rules, (v) => (v < value ? `number must be greater than or equal to ${value}` : undefined)]);
  }
}

// ---- Compound schemas --------------------------------------------------------------------

type Shape = Record<string, Schema<unknown>>;
type Pretty<T> = { [K in keyof T]: T[K] } & {};
type OptionalKeys<S extends Shape> = { [K in keyof S]: undefined extends Infer<S[K]> ? K : never }[keyof S];
type ObjectOut<S extends Shape> = Pretty<
  { [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> }
>;

export class ObjectSchema<S extends Shape> extends Schema<ObjectOut<S>> {
  constructor(
    readonly shape: S,
    private readonly strictKeys = false,
  ) {
    super((v, path, issues) => {
      if (v === undefined) return issues.push({ path, message: 'required' }), FAIL;
      if (typeOf(v) !== 'object') return issues.push({ path, message: `expected object, received ${typeOf(v)}` }), FAIL;
      const input = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      let ok = true;
      for (const [key, schema] of Object.entries(this.shape)) {
        const value = schema.run(input[key], [...path, key], issues);
        if (value === FAIL) ok = false;
        else if (value !== undefined) out[key] = value;
      }
      // Unknown keys are mistakes (a typo like "titel"), not extensions: report them.
      const extra = Object.keys(input).filter((key) => !(key in this.shape));
      if (this.strictKeys && extra.length) {
        issues.push({ path, message: `unrecognized key(s) in object: ${extra.map((k) => `'${k}'`).join(', ')}` });
        ok = false;
      }
      return ok ? (out as ObjectOut<S>) : FAIL;
    }, 'object');
  }

  /** Rejects keys the shape doesn't list. */
  strict(): ObjectSchema<S> {
    return new ObjectSchema(this.shape, true);
  }
}

export const v = {
  string: () => new StringSchema(),
  number: () => new NumberSchema(),
  boolean: () => typed<boolean>('boolean', (b) => b),

  literal<const T extends string | number | boolean>(value: T): Schema<T> {
    return new Schema<T>((input, path, issues) => {
      if (input === value) return value;
      issues.push({ path, message: input === undefined ? 'required' : `invalid literal value, expected ${JSON.stringify(value)}` });
      return FAIL;
    }, typeof value as Kind);
  },

  enum<const T extends readonly [string, ...string[]]>(values: T): Schema<T[number]> {
    return typed<string>('string', (s, path, issues) => {
      if ((values as readonly string[]).includes(s)) return s;
      issues.push({ path, message: `invalid enum value. expected ${values.map((x) => `'${x}'`).join(' | ')}, received '${s}'` });
      return FAIL;
    }) as Schema<T[number]>;
  },

  object: <S extends Shape>(shape: S) => new ObjectSchema(shape),

  array<T>(item: Schema<T>, limits: { min?: number; max?: number } = {}): Schema<T[]> {
    return typed<T[]>('array', (list, path, issues) => {
      let ok = true;
      if (limits.min !== undefined && list.length < limits.min) ok = !issues.push({ path, message: `array must contain at least ${limits.min} element(s)` });
      if (limits.max !== undefined && list.length > limits.max) ok = !issues.push({ path, message: `array must contain at most ${limits.max} element(s)` });
      const out = list.map((x, i) => item.run(x, [...path, i], issues));
      return ok && !out.includes(FAIL) ? (out as T[]) : FAIL;
    });
  },

  record<T>(value: Schema<T>): Schema<Record<string, T>> {
    return typed<Record<string, T>>('object', (input, path, issues) => {
      const out: Record<string, T> = {};
      let ok = true;
      for (const [key, x] of Object.entries(input)) {
        const parsed = value.run(x, [...path, key], issues);
        if (parsed === FAIL) ok = false;
        else out[key] = parsed;
      }
      return ok ? out : FAIL;
    });
  },

  /**
   * The first option that accepts the value. When all fail, explains the option of the same JSON
   * type as the input (e.g. the object form of a field), which is the one the author meant.
   */
  union<const O extends readonly Schema<unknown>[]>(options: O): Schema<Infer<O[number]>> {
    return new Schema<Infer<O[number]>>((input, path, issues) => {
      const attempts = options.map((option) => {
        const found: Issue[] = [];
        return { option, found, out: option.run(input, path, found) };
      });
      const passed = attempts.find((a) => a.out !== FAIL && !a.found.length);
      if (passed) return passed.out as Infer<O[number]>;
      const sameType = attempts.filter((a) => a.option.kind === typeOf(input));
      if (sameType.length === 1) issues.push(...sameType[0]!.found);
      else issues.push({ path, message: input === undefined ? 'required' : 'invalid input' });
      return FAIL;
    });
  },
};
